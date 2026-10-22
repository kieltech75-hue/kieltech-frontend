import asyncio
import html
import json
import logging
import math
import os
import re
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, RedirectResponse

base_dir = Path(__file__).resolve().parents[2]
_test_mode = (os.getenv('KIELTECH_TEST_MODE') or '').strip().lower() in {'1', 'true', 'yes', 'on'}
for env_file in [
    base_dir / 'Backend' / '.env',
    base_dir / '.env',
    Path.cwd() / '.env',
]:
    if env_file.exists():
        load_dotenv(env_file, override=not _test_mode)

ENVIRONMENT = (os.getenv('ENVIRONMENT') or 'development').strip().lower()
IS_PRODUCTION = ENVIRONMENT in {'production', 'prod'}
if IS_PRODUCTION:
    required_production_settings = (
        'OPENROUTER_API_KEY',
        'ENTERPRISE_PASSKEY_SECRET',
        'CORS_ORIGINS',
        'FRONTEND_URL',
        'PUBLIC_BASE_URL',
        'PAYSTACK_SECRET_KEY',
        'SENTRY_DSN',
    )
    missing_settings = [name for name in required_production_settings if not (os.getenv(name) or '').strip()]
    if missing_settings:
        raise RuntimeError(f'Missing required production configuration: {", ".join(missing_settings)}')
    if (os.getenv('KIELTECH_USE_MOCK') or '').strip().lower() in {'1', 'true', 'yes', 'on'}:
        raise RuntimeError('KIELTECH_USE_MOCK cannot be enabled in production')
    for setting_name in ('FRONTEND_URL', 'PUBLIC_BASE_URL'):
        if not (os.getenv(setting_name) or '').strip().lower().startswith('https://'):
            raise RuntimeError(f'{setting_name} must use HTTPS in production')
    production_origins = [origin.strip() for origin in (os.getenv('CORS_ORIGINS') or '').split(',') if origin.strip()]
    if not production_origins or any(not origin.lower().startswith('https://') for origin in production_origins):
        raise RuntimeError('CORS_ORIGINS must contain only HTTPS origins in production')

try:
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
except ImportError:
    sentry_sdk = None
    FastApiIntegration = None

try:
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
except ImportError:
    CONTENT_TYPE_LATEST = None
    generate_latest = None

from app.routers.api import auth_service, billing_service, token_service, router as api_router, _get_public_model_catalog_data, _WEB_DEVELOPMENT_CONNECTION
from app.services.firebase_roles import (
    FirebaseRoleResolutionError,
    is_firebase_admin_uid,
    is_firebase_owner_uid,
    list_firebase_admin_uids,
    list_firebase_roles,
    set_firebase_admin_role,
)

log_level = os.getenv('LOG_LEVEL', 'INFO').upper()
logging.basicConfig(
    level=log_level,
    format='[%(asctime)s] %(levelname)s %(name)s: %(message)s',
)
logger = logging.getLogger('kieltech')

if sentry_sdk is not None:
    sentry_dsn = os.getenv('SENTRY_DSN', '').strip()
    if sentry_dsn:
        sentry_sdk.init(
            dsn=sentry_dsn,
            environment=os.getenv('ENVIRONMENT', 'development'),
            traces_sample_rate=float(os.getenv('SENTRY_TRACES_SAMPLE_RATE', '0.1')),
            integrations=[FastApiIntegration()] if FastApiIntegration is not None else [],
        )
        logger.info('Sentry initialized for KielTech')
    else:
        logger.info('Sentry not configured; set SENTRY_DSN to enable error monitoring')
else:
    logger.info('sentry-sdk not installed; Sentry integration disabled')

if IS_PRODUCTION and sentry_sdk is None:
    raise RuntimeError('sentry-sdk is required in production for error monitoring')

app = FastAPI(
    title='KielTech AI API',
    version='0.1.0',
    description='Production-ready mock API platform for KielTech developer services.',
)

_uptime_monitor_task: asyncio.Task | None = None
_uptime_monitor_failures: dict[str, int] = defaultdict(int)


def _ensure_uptime_schema() -> None:
    billing_service.connection.executescript(
        '''
        CREATE TABLE IF NOT EXISTS uptime_check_runs (
            id BIGSERIAL PRIMARY KEY,
            checked_at TEXT NOT NULL,
            overall_status TEXT NOT NULL,
            checks_json TEXT NOT NULL,
            duration_ms REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS uptime_incidents (
            id BIGSERIAL PRIMARY KEY,
            service TEXT NOT NULL,
            severity TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            failure_count INTEGER NOT NULL DEFAULT 0,
            detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_uptime_runs_checked_at ON uptime_check_runs(checked_at);
        CREATE INDEX IF NOT EXISTS idx_uptime_incidents_started_at ON uptime_incidents(started_at);
        '''
    )
    billing_service.connection.commit()


def _record_uptime_run(result: dict, duration_ms: float) -> None:
    _ensure_uptime_schema()
    checked_at = result.get('checked_at') or datetime.now(timezone.utc).isoformat()
    billing_service.connection.execute(
        'INSERT INTO uptime_check_runs (checked_at, overall_status, checks_json, duration_ms) VALUES (?, ?, ?, ?)',
        (checked_at, result.get('status', 'unknown'), json.dumps(result.get('checks', {})), round(duration_ms, 2)),
    )
    for service, check in (result.get('checks') or {}).items():
        healthy = check.get('status') in {'operational', 'ready'}
        if healthy:
            if _uptime_monitor_failures.get(service, 0) >= 2:
                billing_service.connection.execute(
                    'UPDATE uptime_incidents SET ended_at = ? WHERE service = ? AND ended_at IS NULL',
                    (checked_at, service),
                )
            _uptime_monitor_failures[service] = 0
            continue
        _uptime_monitor_failures[service] = _uptime_monitor_failures.get(service, 0) + 1
        if _uptime_monitor_failures[service] == 2:
            billing_service.connection.execute(
                'INSERT INTO uptime_incidents (service, severity, started_at, failure_count, detail) VALUES (?, ?, ?, ?, ?)',
                (service, 'critical' if check.get('status') == 'outage' else 'degraded', checked_at, 2, check.get('detail', 'Service check failed.')),
            )
        elif _uptime_monitor_failures[service] > 2:
            billing_service.connection.execute(
                'UPDATE uptime_incidents SET failure_count = ?, detail = ? WHERE service = ? AND ended_at IS NULL',
                (_uptime_monitor_failures[service], check.get('detail', 'Service check failed.'), service),
            )
    billing_service.connection.commit()


async def _uptime_monitor_loop() -> None:
    await asyncio.sleep(2)
    while True:
        started = time()
        try:
            result = await detailed_health()
            _record_uptime_run(result, (time() - started) * 1000)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('Uptime monitor check failed')
        await asyncio.sleep(60)


@app.on_event('startup')
async def start_uptime_monitor() -> None:
    global _uptime_monitor_task
    _ensure_uptime_schema()
    if _uptime_monitor_task is None or _uptime_monitor_task.done():
        _uptime_monitor_task = asyncio.create_task(_uptime_monitor_loop())


@app.on_event('shutdown')
async def stop_uptime_monitor() -> None:
    global _uptime_monitor_task
    if _uptime_monitor_task is not None:
        _uptime_monitor_task.cancel()
        try:
            await _uptime_monitor_task
        except asyncio.CancelledError:
            pass
        _uptime_monitor_task = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in (os.getenv('CORS_ORIGINS') or ('' if IS_PRODUCTION else ','.join([
        'http://localhost:8001',
        'http://127.0.0.1:8001',
        'http://localhost:8000',
        'http://127.0.0.1:8000',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://[::1]:8001',
        'http://[::1]:8000',
        'http://[::1]:3000',
    ]))).split(',') if origin.strip()],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.middleware('http')
async def add_security_headers(request: Request, call_next):
    forwarded_scheme = request.headers.get('x-forwarded-proto', request.url.scheme).split(',')[0].strip().lower()
    if IS_PRODUCTION and forwarded_scheme != 'https':
        return RedirectResponse(url=str(request.url.replace(scheme='https')), status_code=307)
    response = await call_next(request)
    if response.status_code >= 400 and (request.url.path.startswith('/admin') or request.url.path.startswith('/v1')):
        billing_service.record_security_event('request_rejected', endpoint=request.url.path, status_code=response.status_code, ip_address=request.client.host if request.client else None, user_agent=request.headers.get('user-agent'))
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(self)')
    if IS_PRODUCTION:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response

free_tier_request_history: dict[str, list[float]] = defaultdict(list)
request_history: dict[str, list[float]] = defaultdict(list)
FRONTEND_ROOT = Path(__file__).resolve().parents[2] / 'Frontend'


def _frontend_file_response(path: Path, media_type: str, status_code: int = 200) -> FileResponse:
    response = FileResponse(path, media_type=media_type, status_code=status_code)
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


def seed_demo_users() -> None:
    demo_users = [
        {
            'name': 'KielTech Admin',
            'email': 'kieltech75@gmail.com',
            'password': 'demo-password',
            'is_admin': True,
            'is_enterprise': True,
            'account_status': 'active_paid',
            'free_credit_balance': 0.0,
            'paid_balance': 0.0,
            'usage': 128,
        },
        {
            'name': 'Demo Client',
            'email': 'demo-user@example.com',
            'password': 'demo-password',
            'is_admin': False,
            'is_enterprise': False,
            'account_status': 'free_tier',
            'free_credit_balance': 0.0,
            'paid_balance': 0.0,
            'usage': 24,
        },
    ]

    for payload in demo_users:
        try:
            auth_service.register_user(payload['name'], payload['email'], payload['password'])
        except ValueError:
            pass

        user = auth_service.get_user_by_email(payload['email'])
        if not user:
            continue

        if payload['is_admin']:
            auth_service.set_user_admin(payload['email'], True)
        if payload['is_enterprise']:
            user['is_enterprise_dedicated'] = True
            user['enterprise_rpm_limit'] = 'unlimited'
            user['enterprise_expires_at'] = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat()
            user['gpu_model'] = 'NVIDIA H100'

        billing_service.set_wallet_balances(
            payload['email'],
            free_credit_balance=payload['free_credit_balance'],
            paid_balance=payload['paid_balance'],
            account_status=payload['account_status'],
            is_enterprise_dedicated=payload['is_enterprise'],
        )
        billing_service.record_usage(payload['email'], payload['usage'])


if not IS_PRODUCTION and os.getenv('ENABLE_DEMO_USERS', '').strip().lower() in {'1', 'true', 'yes', 'on'}:
    seed_demo_users()


def get_rate_limit_config(balance: float, account_status: str) -> tuple[int, str]:
    if account_status != 'active_paid':
        return 15, 'free_tier'

    if balance >= 1501:
        return 5000, 'ultra'
    if balance >= 501:
        return 1000, 'elite'
    if balance >= 101:
        return 300, 'pro'
    if balance >= 1:
        return 60, 'standard'
    return 60, 'standard'


def should_bypass_rate_limit(user: dict | None, wallet: dict | None) -> bool:
    if not user and not wallet:
        return False
    if user and bool(user.get('is_enterprise_dedicated')):
        return True
    if wallet and bool(wallet.get('is_enterprise_dedicated')):
        return True
    return False


def _get_authenticated_request_user(request: Request) -> dict | None:
    auth_header = request.headers.get('authorization') or request.headers.get('Authorization') or ''
    token = auth_header.split(' ', 1)[1].strip() if auth_header.lower().startswith('bearer ') else request.cookies.get('kieltech_session', '').strip()
    if not token:
        return None
    return auth_service.get_user_from_token(token)


def is_admin_authenticated(request: Request) -> bool:
    user = _get_authenticated_request_user(request)
    if not user:
        return False
    try:
        return is_firebase_admin_uid(user.get('firebase_uid'))
    except FirebaseRoleResolutionError:
        request.state.admin_role_unavailable = True
        return False


def is_owner_authenticated(request: Request) -> bool:
    user = _get_authenticated_request_user(request)
    if not user:
        return False
    try:
        return is_firebase_owner_uid(user.get('firebase_uid'))
    except FirebaseRoleResolutionError:
        request.state.admin_role_unavailable = True
        return False


def admin_denied(request: Request) -> JSONResponse:
    role_unavailable = bool(getattr(request.state, 'admin_role_unavailable', False))
    status_code = 503 if role_unavailable else 401
    event = 'admin_role_verification_unavailable' if role_unavailable else 'admin_authorization_failed'
    billing_service.record_security_event(event, endpoint=request.url.path, status_code=status_code, ip_address=request.client.host if request.client else None, user_agent=request.headers.get('user-agent'))
    detail = (
        'Administrator access could not be verified with Firebase. Please try again.'
        if role_unavailable
        else 'Administrator authentication is required.'
    )
    return JSONResponse(status_code=status_code, content={'error': 'admin_role_unavailable' if role_unavailable else 'unauthorized', 'detail': detail})


def owner_denied(request: Request) -> JSONResponse:
    role_unavailable = bool(getattr(request.state, 'admin_role_unavailable', False))
    status_code = 503 if role_unavailable else 403
    event = 'owner_role_verification_unavailable' if role_unavailable else 'owner_authorization_failed'
    billing_service.record_security_event(
        event,
        endpoint=request.url.path,
        status_code=status_code,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get('user-agent'),
    )
    detail = (
        'Owner access could not be verified with Firebase. Please try again.'
        if role_unavailable
        else 'Owner access is required.'
    )
    return JSONResponse(
        status_code=status_code,
        content={'error': 'owner_role_unavailable' if role_unavailable else 'owner_required', 'detail': detail},
    )


@app.middleware('http')
async def enforce_rate_limits(request: Request, call_next):
    if request.method.upper() in {'GET', 'OPTIONS', 'HEAD'}:
        response = await call_next(request)
        if hasattr(response, 'headers'):
            response.headers.setdefault('X-RateLimit-Limit', '60')
            response.headers.setdefault('X-RateLimit-Remaining', '60')
            response.headers.setdefault('X-RateLimit-Reset', str(int(time()) + 60))
        return response

    email = request.headers.get('x-user-email') or request.headers.get('X-User-Email')
    if not email:
        auth_header = request.headers.get('authorization') or request.headers.get('Authorization') or ''
        token = auth_header.split(' ', 1)[1] if auth_header.lower().startswith('bearer ') else ''
        if token:
            user = auth_service.get_user_from_token(token)
            email = user.get('email') if user else None

    limit = 60
    remaining = 60
    reset = int(time()) + 60

    if email:
        user = auth_service.get_user_by_email(email)
        if user and bool(user.get('is_blocked')):
            response = JSONResponse(status_code=403, content={'error': 'account_blocked', 'detail': 'This account has been blocked by an administrator.'})
            response.headers['X-RateLimit-Limit'] = '0'
            response.headers['X-RateLimit-Remaining'] = '0'
            response.headers['X-RateLimit-Reset'] = str(int(time()) + 60)
            return response
        wallet = billing_service.get_wallet(email)
        account_status = (wallet.get('account_status') or 'free_tier').lower()
        balance = float(wallet.get('balance') or 0.0)
        enterprise_grant = billing_service.get_enterprise_user_grant(email)
        enterprise_grant_active = False
        if enterprise_grant:
            try:
                enterprise_grant_active = datetime.fromisoformat(enterprise_grant['expires_at']) > datetime.now(timezone.utc)
            except (KeyError, TypeError, ValueError):
                enterprise_grant_active = False

        if enterprise_grant_active:
            raw_limit = enterprise_grant.get('rpm_limit') or 'unlimited'
            if str(raw_limit).lower() == 'unlimited':
                limit = 100000
                remaining = 100000
                reset = int(time()) + 60
            else:
                limit = max(1, int(raw_limit))
                now = time()
                history = request_history[email]
                history[:] = [stamp for stamp in history if now - stamp < 60]
                if len(history) >= limit:
                    response = JSONResponse(status_code=429, content={'error': 'rate_limited', 'detail': f'Enterprise requests are limited to {limit} requests per minute.'})
                    response.headers['X-RateLimit-Limit'] = str(limit)
                    response.headers['X-RateLimit-Remaining'] = '0'
                    response.headers['X-RateLimit-Reset'] = str(int(now) + 60)
                    return response
                history.append(now)
                remaining = max(0, limit - len(history))
                reset = int(now) + 60
        elif enterprise_grant is None and should_bypass_rate_limit(user, wallet):
            limit = 100000
            remaining = 100000
            reset = int(time()) + 60
        else:
            limit, _ = get_rate_limit_config(balance, account_status)
            now = time()
            history = request_history[email]
            history[:] = [stamp for stamp in history if now - stamp < 60]

            if account_status == 'free_tier':
                is_free_tier_user = bool(user and user.get('phone_verified') and user.get('free_tier_claimed'))
                if is_free_tier_user:
                    if len(history) >= 5:
                        response = JSONResponse(status_code=429, content={'error': 'rate_limited', 'detail': 'Free-tier requests are limited to 5 requests per minute.'})
                        response.headers['X-RateLimit-Limit'] = '5'
                        response.headers['X-RateLimit-Remaining'] = '0'
                        response.headers['X-RateLimit-Reset'] = str(int(time()) + 60)
                        return response
                    history.append(now)
                    remaining = max(0, 5 - len(history))
                else:
                    remaining = limit
            else:
                if limit >= 5000:
                    response = JSONResponse(status_code=429, content={'error': 'rate_limited', 'detail': 'Your application has reached the maximum shared infrastructure limit (5,000 RPM). Please contact kieltech75@gmail.com to provision a dedicated RunPod cluster.'})
                    response.headers['X-RateLimit-Limit'] = '5000'
                    response.headers['X-RateLimit-Remaining'] = '0'
                    response.headers['X-RateLimit-Reset'] = str(int(time()) + 60)
                    return response
                if len(history) >= limit:
                    response = JSONResponse(status_code=429, content={'error': 'rate_limited', 'detail': f'Rate limit exceeded for {account_status} tier.'})
                    response.headers['X-RateLimit-Limit'] = str(limit)
                    response.headers['X-RateLimit-Remaining'] = '0'
                    response.headers['X-RateLimit-Reset'] = str(int(time()) + 60)
                    return response
                history.append(now)
                remaining = max(0, limit - len(history))

            reset = int(time()) + 60

    response = await call_next(request)
    if isinstance(response, Response):
        response.headers.setdefault('X-RateLimit-Limit', str(limit))
        response.headers['X-RateLimit-Remaining'] = str(remaining)
        response.headers['X-RateLimit-Reset'] = str(reset)
    return response


@app.middleware('http')
async def enforce_account_blocks(request: Request, call_next):
    allowed_blocked_paths = {
        '/v1/auth/login',
        '/v1/auth/email/verify',
        '/v1/auth/email/resend',
        '/v1/auth/signup',
    }
    if request.url.path.startswith('/v1/') and request.url.path not in allowed_blocked_paths:
        auth_header = request.headers.get('authorization') or request.headers.get('Authorization') or ''
        token = auth_header.split(' ', 1)[1].strip() if auth_header.lower().startswith('bearer ') else request.cookies.get('kieltech_session', '').strip()
        if token:
            user = auth_service.get_user_from_token(token)
            if user and user.get('is_blocked'):
                return JSONResponse(status_code=403, content={
                    'error': 'account_blocked',
                    'detail': user.get('blocked_reason') or 'Your account has been blocked.',
                    'reason': user.get('blocked_reason') or 'Your account has been blocked.',
                })
    return await call_next(request)


app.include_router(api_router)


@app.get('/metrics')
async def metrics() -> Response:
    if generate_latest is None or CONTENT_TYPE_LATEST is None:
        return Response('Prometheus client not installed', status_code=503)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def _serialize_admin_user(
    user: dict | None,
    include_wallet: bool = True,
    admin_uids: set[str] | None = None,
) -> dict | None:
    if not user:
        return None
    email = (user.get('email') or '').strip().lower()
    wallet = billing_service.get_wallet(email) if include_wallet and email else {}
    usage = billing_service.get_usage_summary(email) if email else {'current_usage': 0, 'included_limit': 1000}
    latest_payment = billing_service.get_latest_payment() if email else None
    if latest_payment and latest_payment.get('email') != email:
        latest_payment = None
    payload = {
        'id': user.get('id'),
        'name': user.get('name'),
        'email': email,
        'phone_verified': bool(user.get('phone_verified')),
        'free_tier_claimed': bool(user.get('free_tier_claimed')),
        'free_tier_eligible': bool(user.get('free_tier_eligible')),
        'is_admin': (
            user.get('firebase_uid') in admin_uids
            if admin_uids is not None
            else is_firebase_admin_uid(user.get('firebase_uid'))
        ),
        'is_enterprise_dedicated': bool(user.get('is_enterprise_dedicated')),
        'is_blocked': bool(user.get('is_blocked')),
        'blocked_reason': user.get('blocked_reason'),
        'created_at': user.get('created_at'),
        'enterprise_rpm_limit': user.get('enterprise_rpm_limit'),
        'enterprise_expires_at': user.get('enterprise_expires_at'),
        'gpu_model': user.get('gpu_model'),
        'usage_current': usage.current_usage if hasattr(usage, 'current_usage') else usage.get('current_usage', 0),
        'usage_limit': usage.included_limit if hasattr(usage, 'included_limit') else usage.get('included_limit', 1000),
        'latest_payment': latest_payment,
    }
    if include_wallet:
        payload.update({
            'wallet_balance': wallet.get('balance', 0),
            'wallet_currency': wallet.get('currency', 'USD'),
            'rate_limit': wallet.get('rate_limit', 5),
            'tier': wallet.get('tier', {}),
        })
    return payload


def _wallet_transaction_source_label(transaction: dict) -> str:
    kind = str(transaction.get('kind') or '').lower()
    provider = str(transaction.get('provider') or '').lower()
    metadata = transaction.get('metadata') or {}
    if 'overage' in kind or 'overage' in provider or 'overage' in str(metadata).lower():
        return 'Overage'
    if str(metadata.get('balance_type') or '').lower() == 'free_credit':
        return 'Free credit'
    if provider in {'paystack', 'stripe', 'card', 'bank', 'bank_transfer'} or 'manual' in kind or 'topup' in kind or 'credit' in kind:
        return 'Paid'
    return 'System credit'


@app.get('/admin/users')
async def admin_list_users(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    admin_uids = list_firebase_admin_uids()
    users = [
        payload for payload in (
            _serialize_admin_user(user, admin_uids=admin_uids)
            for user in auth_service.list_users()
        ) if payload
    ]
    return JSONResponse(status_code=200, content={'users': users})


@app.get('/admin/sessions')
async def admin_list_sessions(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    now_datetime = datetime.now(timezone.utc)
    now = now_datetime.isoformat()
    live_cutoff = now_datetime - timedelta(minutes=5)
    rows = auth_service.connection.execute(
        '''
         SELECT s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked_at,
             u.name, u.username, u.email, u.firebase_uid, u.is_blocked
        FROM auth_sessions s
        JOIN auth_users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        '''
    ).fetchall()
    admin_uids = list_firebase_admin_uids()
    sessions = []
    for row in rows:
        session = dict(row)
        revoked = bool(session.get('revoked_at'))
        expired = str(session.get('expires_at') or '') <= now
        try:
            last_seen = datetime.fromisoformat(str(session.get('last_seen_at') or ''))
        except ValueError:
            last_seen = None
        blocked = bool(session.get('is_blocked'))
        live = bool(last_seen and last_seen >= live_cutoff and not revoked and not expired and not blocked)
        sessions.append({
            'user_id': session.get('user_id'),
            'name': session.get('name'),
            'username': session.get('username'),
            'email': session.get('email'),
            'is_admin': session.get('firebase_uid') in admin_uids,
            'created_at': session.get('created_at'),
            'expires_at': session.get('expires_at'),
            'last_seen_at': session.get('last_seen_at'),
            'revoked_at': session.get('revoked_at'),
            'status': 'blocked' if blocked else 'live' if live else 'revoked' if revoked else 'expired' if expired else 'inactive',
        })
    account_count = auth_service.connection.execute('SELECT COUNT(*) AS count FROM auth_users').fetchone()['count']
    live_account_count = len({session['user_id'] for session in sessions if session['status'] == 'live'})
    return JSONResponse(status_code=200, content={
        'sessions': sessions,
        'count': len(sessions),
        'account_count': len({session['user_id'] for session in sessions}),
        'accounts_created': int(account_count or 0),
        'live_session_count': sum(1 for session in sessions if session['status'] == 'live'),
        'live_account_count': live_account_count,
    })


@app.get('/admin/dashboard-data')
async def admin_dashboard_data(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    admin_uids = list_firebase_admin_uids()
    users = [
        payload for payload in (
            _serialize_admin_user(user, include_wallet=False, admin_uids=admin_uids)
            for user in auth_service.list_users()
        ) if payload
    ]
    usage_tracked = billing_service.get_total_api_request_count()
    active_users = sum(1 for user in users if not bool(user.get('is_blocked')))
    enterprise_users = sum(1 for user in users if bool(user.get('is_enterprise_dedicated')))

    admin_user = next((user for user in users if user.get('is_admin')), None)
    admin_profile = {
        'name': admin_user.get('name'),
        'email': admin_user.get('email'),
    } if admin_user else {}

    # allow callers to request different day ranges (7, 30, 90, 180, 365)
    try:
        days_param = int(request.query_params.get('days', '7'))
    except Exception:
        days_param = 7
    if days_param not in (7, 30, 90, 180, 365):
        days_param = 7
    traffic = billing_service.get_traffic_trend(days=days_param)

    return JSONResponse(status_code=200, content={
        'metrics': {
            'customers': len(users),
            'active': active_users,
            'enterprise': enterprise_users,
            'usage_tracked': usage_tracked,
        },
        'customers': users,
        'admin': admin_profile,
        'traffic': traffic,
    })


@app.get('/admin/model-request-counts')
async def admin_model_request_counts(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    request_counts = billing_service.get_model_request_counts()
    models = [
        {
            'model_id': model['model_id'],
            'display_name': model['display_name'],
            'category': model['category'],
            'status': model.get('status', 'Ready'),
            'request_count': request_counts.get(model['model_id'].lower(), 0),
        }
        for model in _get_public_model_catalog_data()
    ]
    models.sort(key=lambda model: model['display_name'].casefold())
    return JSONResponse(status_code=200, content={'models': models})


@app.get('/admin/dashboard-matrix')
async def admin_dashboard_matrix(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    usage_totals = {
        '7': sum(item.get('value', 0) for item in billing_service.get_traffic_trend(days=7)),
        '30': sum(item.get('value', 0) for item in billing_service.get_traffic_trend(days=30)),
        '90': sum(item.get('value', 0) for item in billing_service.get_traffic_trend(days=90)),
        '180': sum(item.get('value', 0) for item in billing_service.get_traffic_trend(days=180)),
        '365': sum(item.get('value', 0) for item in billing_service.get_traffic_trend(days=365)),
    }

    matrix = {
        'timeframes': ['7 Days', '30 Days', '90 Days', '180 Days', '12 Months'],
        'rows': [
            {
                'label': 'Live usage',
                'values': [
                    f"{usage_totals['7']:,}",
                    f"{usage_totals['30']:,}",
                    f"{usage_totals['90']:,}",
                    f"{usage_totals['180']:,}",
                    f"{usage_totals['365']:,}",
                ],
            },
            {
                'label': 'Usage status',
                'values': [
                    'Low',
                    'Medium',
                    'High',
                    'High',
                    'High',
                ],
            },
        ],
    }
    return JSONResponse(status_code=200, content=matrix)


@app.get('/admin/users/{email}')
async def admin_get_user(request: Request, email: str) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    user = auth_service.get_user_by_email(email)
    payload = _serialize_admin_user(user)
    if not payload:
        return JSONResponse(status_code=404, content={'error': 'user_not_found', 'detail': 'User not found'})
    return JSONResponse(status_code=200, content={'user': payload})


@app.get('/admin/customer-account/{email:path}')
async def admin_customer_account(request: Request, email: str) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    normalized_email = email.strip().lower()
    user = auth_service.get_user_by_email(normalized_email)
    if not user:
        return JSONResponse(status_code=404, content={'error': 'user_not_found', 'detail': 'User not found'})

    now = datetime.now(timezone.utc)
    live_cutoff = now - timedelta(minutes=5)
    session_rows = auth_service.connection.execute(
        'SELECT created_at, expires_at, revoked_at, last_seen_at FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC NULLS LAST',
        (user['id'],),
    ).fetchall()
    last_active = None
    currently_active = False
    for row in session_rows:
        row_data = dict(row)
        if not last_active and row_data.get('last_seen_at'):
            last_active = row_data['last_seen_at']
        try:
            seen_at = datetime.fromisoformat(str(row_data.get('last_seen_at') or ''))
            expires_at = datetime.fromisoformat(str(row_data.get('expires_at') or ''))
        except ValueError:
            continue
        if not user.get('is_blocked') and not row_data.get('revoked_at') and expires_at > now and seen_at >= live_cutoff:
            currently_active = True

    wallet = billing_service.get_wallet(normalized_email)
    funds = billing_service.get_wallet_transactions(normalized_email, limit=500)
    for item in funds:
        item['source_label'] = _wallet_transaction_source_label(item)

    model_rows = billing_service.connection.execute(
        '''SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost, MAX(COALESCE(completed_at, requested_at)) AS last_used_at
           FROM api_usage_logs WHERE lower(owner_email) = lower(?)
           GROUP BY model ORDER BY requests DESC, model''',
        (normalized_email,),
    ).fetchall()
    models = [
        {
            'model': row['model'],
            'request_count': int(row['requests'] or 0),
            'total_tokens': int(row['tokens'] or 0),
            'total_cost_usd': round(float(row['cost'] or 0), 6),
            'last_used_at': row['last_used_at'],
        }
        for row in model_rows
    ]

    keys = token_service.list_tokens(owner_email=normalized_email)
    api_keys = []
    for key in keys:
        summary = billing_service.get_api_usage_summary(normalized_email, api_key_id=key['id'])
        api_keys.append({**key, **summary})

    return JSONResponse(status_code=200, content={
        'user': _serialize_admin_user(user),
        'activity': {
            'currently_active': currently_active,
            'last_active_at': last_active,
        },
        'wallet': wallet,
        'funds': funds,
        'models': models,
        'api_keys': api_keys,
    })


@app.post('/admin/users/{email}/block')
async def admin_toggle_user_block(request: Request, email: str) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    blocked = payload.get('blocked')
    if blocked is None:
        user = auth_service.get_user_by_email(email)
        blocked = not bool(user and user.get('is_blocked'))

    reason = str(payload.get('reason') or '').strip()
    if blocked and not reason:
        return JSONResponse(status_code=400, content={'error': 'block_reason_required', 'detail': 'A reason is required when blocking an account.'})
    updated = auth_service.set_user_blocked(email, bool(blocked), reason)
    if not updated:
        return JSONResponse(status_code=404, content={'error': 'user_not_found', 'detail': 'User not found'})
    return JSONResponse(status_code=200, content={'user': _serialize_admin_user(updated)})


@app.post('/admin/send-email')
async def admin_send_email(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    scope = (payload or {}).get('scope', 'all')
    subject = (payload or {}).get('subject', 'KielTech update').strip() or 'KielTech update'
    message = (payload or {}).get('message', '').strip()
    html_message = str((payload or {}).get('html_message') or '').strip()
    recipient_email = str((payload or {}).get('recipient_email') or '').strip().lower()
    if not message:
        return JSONResponse(status_code=400, content={'error': 'message_required', 'detail': 'A message is required.'})
    users = auth_service.list_users()
    if recipient_email:
        recipients = [user.get('email') for user in users if user.get('email') == recipient_email and not user.get('is_blocked')]
    elif scope == 'enterprise':
        recipients = [user.get('email') for user in users if bool(user.get('is_enterprise_dedicated')) and not user.get('is_blocked')]
    elif scope == 'non_enterprise':
        recipients = [user.get('email') for user in users if not bool(user.get('is_enterprise_dedicated')) and not user.get('is_blocked')]
    else:
        recipients = [user.get('email') for user in users if not user.get('is_blocked')]
    recipients = [email for email in recipients if email]
    sent = []
    failed = []
    failure_reason = None
    for recipient in recipients:
        try:
            if billing_service._send_email_notification(recipient, subject, message, html_body=html_message or None):
                sent.append(recipient)
            else:
                failed.append(recipient)
                failure_reason = billing_service.last_email_error or 'SMTP delivery was rejected.'
        except Exception:
            failed.append(recipient)
            failure_reason = 'SMTP delivery raised an unexpected error.'
    return JSONResponse(status_code=200, content={
        'sent': bool(sent) and not failed,
        'scope': scope,
        'subject': subject,
        'message': message,
        'sent_count': len(sent),
        'failed_count': len(failed),
        'failure_reason': failure_reason,
        'recipient_count': len(recipients),
        'recipients': recipients,
    })


@app.post('/admin/mock/events')
async def admin_insert_mock_events(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    count = int(payload.get('count', 1) or 1)
    email = (payload.get('email') or 'test@example.com').strip()
    # clamp to reasonable maximum
    count = max(1, min(count, 500))

    inserted = 0
    for _ in range(count):
        try:
            billing_service.record_usage(email, 1)
            inserted += 1
        except Exception:
            # do not fail the whole batch on single error
            continue

    return JSONResponse(status_code=200, content={'inserted': inserted, 'email': email})


@app.get('/admin/mock/events')
async def admin_insert_mock_events_get(request: Request) -> JSONResponse:
    # Support GET for simple admin-triggered requests (useful to avoid preflight in local dev)
    provided = request.query_params
    try:
        count = int(provided.get('count', '1'))
    except Exception:
        count = 1
    email = provided.get('email', 'test@example.com')
    if not is_admin_authenticated(request):
        return admin_denied(request)

    count = max(1, min(count, 500))
    inserted = 0
    for _ in range(count):
        try:
            billing_service.record_usage(email, 1)
            inserted += 1
        except Exception:
            continue
    return JSONResponse(status_code=200, content={'inserted': inserted, 'email': email})


@app.get('/admin/portal')
async def admin_portal() -> RedirectResponse:
    # Redirect legacy portal route to the unified admin dashboard
    return RedirectResponse(url='/admin/dashboard', status_code=307)


@app.post('/admin/validate-secret')
async def validate_admin_secret(request: Request) -> JSONResponse:
    if is_admin_authenticated(request):
        return JSONResponse(status_code=200, content={'valid': True, 'message': 'Admin session authorized'})
    return admin_denied(request)


# Removed admin-passkeys page: consolidated admin UI to /admin/dashboard


@app.get('/admin/customers', response_model=None)
async def admin_customers_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-customers.html', 'text/html')


@app.get('/admin/ai-studio', response_model=None)
async def admin_ai_studio_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-ai-studio.html', 'text/html')


@app.get('/admin/uptime-policy', response_model=None)
async def admin_uptime_policy_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-uptime-policy.html', 'text/html')


@app.get('/admin/uptime-policy/history', response_model=None)
async def admin_uptime_policy_history_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-uptime-history.html', 'text/html')


@app.get('/admin/ai-studio-data')
async def admin_ai_studio_data(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    model_rows = billing_service.connection.execute(
        'SELECT model, COUNT(*) AS requests, COUNT(DISTINCT lower(owner_email)) AS users FROM api_usage_logs GROUP BY model'
    ).fetchall()
    model_stats = {str(row['model']).lower(): {'requests': int(row['requests'] or 0), 'users': int(row['users'] or 0)} for row in model_rows}
    models = [
        {
            'model': model['model_id'],
            'display_name': model['display_name'],
            'category': model['category'],
            'is_ready': model['is_ready'],
            'is_configured': model['is_configured'],
            'requests': model_stats.get(model['model_id'].lower(), {}).get('requests', 0),
            'users': model_stats.get(model['model_id'].lower(), {}).get('users', 0),
        }
        for model in _get_public_model_catalog_data()
    ]
    project_count = _WEB_DEVELOPMENT_CONNECTION.execute('SELECT COUNT(*) AS count FROM studio_projects').fetchone()['count']
    deployment_count = _WEB_DEVELOPMENT_CONNECTION.execute(
        "SELECT COUNT(*) AS count FROM studio_deployments WHERE lower(status) IN ('deployed', 'published', 'active', 'completed') OR lower(validation_status) = 'ready'"
    ).fetchone()['count']
    return JSONResponse(status_code=200, content={
        'models': models,
        'websites_built': int(project_count or 0),
        'websites_deployed': int(deployment_count or 0),
    })


@app.get('/admin/customers/{email:path}', response_model=None)
async def admin_customer_detail_page(email: str, request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-customer-account.html', 'text/html')


@app.get('/admin/email', response_model=None)
async def admin_email_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-email.html', 'text/html')


@app.get('/admin/chat-templates', response_model=None)
async def admin_chat_templates_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-chat-templates.html', 'text/html')


@app.get('/admin/model-reviews', response_model=None)
async def admin_model_reviews_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-model-reviews.html', 'text/html')


@app.get('/admin/dashboard', response_model=None)
async def admin_dashboard_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-dashboard.html', 'text/html')


@app.get('/owner/admins', response_model=None)
async def owner_admin_management_page(request: Request) -> FileResponse | JSONResponse:
    if not is_owner_authenticated(request):
        return owner_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-owner.html', 'text/html')


@app.get('/owner/admins/users')
async def owner_list_linked_users(request: Request) -> JSONResponse:
    if not is_owner_authenticated(request):
        return owner_denied(request)

    try:
        roles = list_firebase_roles()
        users = [
            {
                'firebase_uid': user['firebase_uid'],
                'name': user.get('name') or '',
                'username': user.get('username') or '',
                'email': user.get('email') or '',
                'role': roles.get(user['firebase_uid'], 'user'),
            }
            for user in auth_service.list_users()
            if user.get('firebase_uid')
        ]
        users.sort(key=lambda user: (user['role'] != 'owner', user['email'].lower()))
        return JSONResponse(status_code=200, content={'users': users})
    except FirebaseRoleResolutionError:
        request.state.admin_role_unavailable = True
        return owner_denied(request)
    except Exception:
        logger.exception('Unable to load Google-linked users for owner role management')
        return JSONResponse(
            status_code=500,
            content={'error': 'owner_user_list_failed', 'detail': 'Unable to load linked accounts. Please try again.'},
        )


@app.put('/owner/admins/users/{firebase_uid}/admin-role')
async def owner_set_admin_role(firebase_uid: str, request: Request) -> JSONResponse:
    if not is_owner_authenticated(request):
        return owner_denied(request)

    linked_user = next(
        (user for user in auth_service.list_users() if user.get('firebase_uid') == firebase_uid),
        None,
    )
    if not linked_user:
        return JSONResponse(
            status_code=404,
            content={'error': 'linked_user_not_found', 'detail': 'This Firebase account is not linked to a KielTech user.'},
        )

    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A valid JSON request body is required.'})
    if not isinstance(payload, dict) or not isinstance(payload.get('is_admin'), bool):
        return JSONResponse(
            status_code=400,
            content={'error': 'invalid_role_change', 'detail': 'is_admin must be true or false.'},
        )

    try:
        if list_firebase_roles().get(firebase_uid) == 'owner':
            return JSONResponse(
                status_code=409,
                content={'error': 'owner_role_unchangeable', 'detail': 'Owner roles cannot be changed from the owner management page.'},
            )
        role = set_firebase_admin_role(firebase_uid, payload['is_admin'])
        return JSONResponse(
            status_code=200,
            content={
                'message': 'Administrator role updated.',
                'user': {'email': linked_user.get('email'), 'role': role},
            },
        )
    except ValueError as exc:
        return JSONResponse(status_code=409, content={'error': 'role_change_rejected', 'detail': str(exc)})
    except FirebaseRoleResolutionError:
        request.state.admin_role_unavailable = True
        return owner_denied(request)


def _frontend_redirect(request: Request, path: str = '/') -> RedirectResponse:
    frontend_url = (os.getenv('FRONTEND_URL') or '').strip().rstrip('/')
    if not frontend_url:
        frontend_url = f'http://{request.url.hostname or "127.0.0.1"}:8001'
    redirect_url = f'{frontend_url}{path}'
    if request.url.query:
        redirect_url = f'{redirect_url}?{request.url.query}'
    return RedirectResponse(url=redirect_url, status_code=307)


@app.get('/')
@app.get('/index.html')
async def frontend_root(request: Request) -> RedirectResponse:
    return _frontend_redirect(request, request.url.path)


@app.get('/health')
async def health() -> dict:
    return {'status': 'ok', 'service': 'kieltech-ai-api'}


@app.get('/health/detailed')
async def detailed_health() -> dict:
    checks: dict[str, dict[str, str]] = {}

    def check_database(name: str, connection) -> None:
        try:
            connection.execute('SELECT 1').fetchone()
            checks[name] = {'status': 'operational', 'detail': 'Database connection is healthy.'}
        except Exception:
            checks[name] = {'status': 'outage', 'detail': 'Database connection is unavailable.'}

    check_database('postgresql', auth_service.connection)
    if billing_service.connection is not auth_service.connection:
        check_database('billing_database', billing_service.connection)
    check_database('studio_database', _WEB_DEVELOPMENT_CONNECTION)

    smtp_ready = all((os.getenv(key) or '').strip() for key in ('SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'))
    checks['email_delivery'] = {'status': 'ready' if smtp_ready else 'configuration_needed', 'detail': 'SMTP credentials are configured.' if smtp_ready else 'SMTP credentials are not fully configured.'}
    model_ready = bool((os.getenv('OPENROUTER_API_KEY') or '').strip())
    checks['ai_models'] = {'status': 'ready' if model_ready else 'configuration_needed', 'detail': 'Model provider configuration is present.' if model_ready else 'Model provider configuration is missing.'}
    try:
        billing_service.get_config()
        checks['billing'] = {'status': 'operational', 'detail': 'Billing configuration and wallet storage are available.'}
    except Exception:
        checks['billing'] = {'status': 'outage', 'detail': 'Billing storage is unavailable.'}

    statuses = [item['status'] for item in checks.values()]
    has_outage = 'outage' in statuses
    has_degraded = any(status in {'configuration_needed', 'degraded'} for status in statuses)
    overall = 'partial_outage' if has_outage else 'degraded' if has_degraded else 'operational'
    return {
        'status': overall,
        'checks': checks,
        'uptime': {'status': 'not_published', 'detail': 'No uptime SLA or guarantee has been published.'},
        'checked_at': datetime.now(timezone.utc).isoformat(),
    }


@app.get('/health/models')
async def model_status_health() -> dict:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=7)
    model_rows = billing_service.connection.execute(
        'SELECT model, status_code, requested_at, completed_at FROM api_usage_logs WHERE requested_at >= ? ORDER BY requested_at ASC',
        (start.isoformat(),),
    ).fetchall()
    providers = {
        'kielmind': 'KielMind',
        'kiellens': 'KielLens',
        'kielforge': 'KielForge',
    }
    provider_icons = {'KielMind': 'K', 'KielLens': 'L', 'KielForge': 'F', 'Managed': 'M'}
    configured = bool((os.getenv('OPENROUTER_API_KEY') or '').strip())
    models: list[dict] = []
    for catalog_model in _get_public_model_catalog_data():
        model = catalog_model['model_id']
        provider_key = next((key for key in providers if model.startswith(key)), None)
        provider = providers[provider_key] if provider_key else 'Managed'
        rows = [row for row in model_rows if str(row['model'] or '') == model]
        successful = sum(1 for row in rows if int(row['status_code'] or 500) < 400)
        failed = len(rows) - successful
        latencies = []
        for row in rows:
            try:
                requested = datetime.fromisoformat(str(row['requested_at']).replace('Z', '+00:00'))
                completed = datetime.fromisoformat(str(row['completed_at']).replace('Z', '+00:00')) if row['completed_at'] else None
                if completed and completed >= requested:
                    latencies.append(max(0, (completed - requested).total_seconds() * 1000))
            except (TypeError, ValueError):
                continue
        has_observations = bool(rows)
        current_status = 'unknown' if not has_observations else 'down' if not configured else 'degraded' if failed and failed >= successful else 'operational'
        availability = round((successful / len(rows)) * 100, 1) if has_observations else None
        buckets = []
        for bucket in range(42):
            bucket_start = start + timedelta(minutes=(7 * 24 * 60 / 42) * bucket)
            bucket_end = start + timedelta(minutes=(7 * 24 * 60 / 42) * (bucket + 1))
            bucket_rows = []
            for row in rows:
                try:
                    timestamp = datetime.fromisoformat(str(row['requested_at']).replace('Z', '+00:00'))
                    if bucket_start <= timestamp < bucket_end:
                        bucket_rows.append(row)
                except (TypeError, ValueError):
                    continue
            buckets.append('unknown' if not bucket_rows else 'down' if all(int(row['status_code'] or 500) >= 500 for row in bucket_rows) else 'degraded' if any(int(row['status_code'] or 500) >= 400 for row in bucket_rows) else 'operational')
        models.append({
            'id': model,
            'name': catalog_model['display_name'],
            'provider': provider,
            'icon': provider_icons[provider],
            'status': current_status,
            'latency_ms': round(sum(latencies) / len(latencies), 1) if latencies else None,
            'availability_7d': availability,
            'history': buckets,
            'requests_7d': len(rows),
            'is_ready': catalog_model['is_ready'],
            'is_configured': catalog_model['is_configured'],
        })
    counts = {status: sum(1 for model in models if model['status'] == status) for status in ('operational', 'degraded', 'down')}
    return {
        'checked_at': now.isoformat(),
        'provider_configured': configured,
        'models': models,
        'counts': counts,
        'total': len(models),
    }


@app.get('/admin/uptime-policy-data')
async def admin_uptime_policy_data(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    _ensure_uptime_schema()
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=30)).isoformat()
    runs = billing_service.connection.execute(
        'SELECT checked_at, overall_status, checks_json, duration_ms FROM uptime_check_runs WHERE checked_at >= ? ORDER BY checked_at DESC LIMIT 500',
        (since,),
    ).fetchall()
    incidents = billing_service.connection.execute(
        'SELECT service, severity, started_at, ended_at, failure_count, detail FROM uptime_incidents WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at DESC LIMIT 100',
        (since,),
    ).fetchall()
    total = len(runs)
    operational = sum(1 for row in runs if row['overall_status'] == 'operational')
    availability = round((operational / total) * 100, 3) if total else None
    return JSONResponse(status_code=200, content={
        'window_days': 30,
        'availability_percent': availability,
        'checks_recorded': total,
        'last_checked_at': runs[0]['checked_at'] if runs else None,
        'runs': [
            {'checked_at': row['checked_at'], 'status': row['overall_status'], 'duration_ms': row['duration_ms']}
            for row in runs[:50]
        ],
        'incidents': [dict(row) for row in incidents],
    })


@app.get('/styles.css')
async def frontend_styles() -> FileResponse:
    return _frontend_file_response(FRONTEND_ROOT / 'styles.css', 'text/css')


@app.get('/billing.html')
async def billing_page() -> FileResponse:
    return _frontend_file_response(FRONTEND_ROOT / 'billing.html', 'text/html')


@app.get('/script.js')
async def frontend_script() -> FileResponse:
    return _frontend_file_response(FRONTEND_ROOT / 'script.js', 'application/javascript')


@app.get('/KielTech-logo.png')
async def frontend_logo() -> FileResponse:
    return _frontend_file_response(FRONTEND_ROOT / 'KielTech-logo.png', 'image/png')


@app.get('/favicon.ico')
async def frontend_favicon() -> FileResponse:
    candidate = FRONTEND_ROOT / 'favicon.ico'
    if candidate.exists():
        return _frontend_file_response(candidate, 'image/x-icon')
    # fallback to logo if favicon missing
    return _frontend_file_response(FRONTEND_ROOT / 'KielTech-logo.png', 'image/png')


@app.get('/admin-enterprise-keys.html')
async def enterprise_keys_page(request: Request) -> FileResponse | JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return _frontend_file_response(FRONTEND_ROOT / 'admin-enterprise-keys.html', 'text/html')


@app.post('/admin/free-credit')
async def admin_grant_free_credit(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)

    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A valid JSON request body is required.'})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A JSON object is required.'})

    audience = str(payload.get('audience') or '').strip().lower()
    if audience not in {'single', 'enterprise', 'non_enterprise'}:
        return JSONResponse(status_code=400, content={'error': 'invalid_audience', 'detail': 'Choose one user, enterprise users, or non-enterprise users.'})
    try:
        amount = float(payload.get('amount'))
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={'error': 'invalid_amount', 'detail': 'Credit amount must be a number from $0.01 to $10,000.00.'})
    if not math.isfinite(amount) or amount < 0.01 or amount > 10_000:
        return JSONResponse(status_code=400, content={'error': 'invalid_amount', 'detail': 'Credit amount must be from $0.01 to $10,000.00 per user.'})
    amount = round(amount, 2)

    reason = str(payload.get('reason') or '').strip()
    if len(reason) > 160:
        return JSONResponse(status_code=400, content={'error': 'invalid_reason', 'detail': 'Reason must be 160 characters or fewer.'})

    eligible_users = [
        user for user in auth_service.list_users()
        if user.get('email') and not user.get('is_blocked')
    ]
    if audience == 'single':
        recipient_email = str(payload.get('email') or '').strip().lower()
        recipients = [
            user for user in eligible_users
            if str(user.get('email') or '').strip().lower() == recipient_email
        ]
        if not recipients:
            return JSONResponse(status_code=404, content={'error': 'user_not_found', 'detail': 'Select an existing, active account.'})
    elif audience == 'enterprise':
        admin_uids = list_firebase_admin_uids()
        recipients = [
            user for user in eligible_users
            if user.get('firebase_uid') not in admin_uids and bool(user.get('is_enterprise_dedicated'))
        ]
    else:
        admin_uids = list_firebase_admin_uids()
        recipients = [
            user for user in eligible_users
            if user.get('firebase_uid') not in admin_uids and not bool(user.get('is_enterprise_dedicated'))
        ]

    if not recipients:
        return JSONResponse(status_code=400, content={'error': 'no_recipients', 'detail': 'There are no eligible users in this audience.'})

    auth_header = request.headers.get('authorization') or ''
    admin_token = auth_header.split(' ', 1)[1].strip() if auth_header.lower().startswith('bearer ') else request.cookies.get('kieltech_session', '').strip()
    admin_user = auth_service.get_user_from_token(admin_token) if admin_token else None
    admin_email = str((admin_user or {}).get('email') or '').strip().lower() or None
    description = reason or 'Administrator free-credit grant'
    results = []
    failures = []
    notification_failed_count = 0

    for user in recipients:
        email = str(user['email']).strip().lower()
        reference = f'admin-free-credit-{secrets.token_hex(16)}'
        metadata = {
            'grant_type': 'admin_free_credit',
            'audience': audience,
            'reason': reason,
            'granted_by': admin_email,
        }
        try:
            wallet = billing_service.credit_wallet(
                email,
                amount,
                currency='USD',
                provider='admin',
                reference=reference,
                description=description,
                metadata=metadata,
                balance_type='free_credit',
            )
            user_name = str(user.get('name') or 'there').strip()
            greeting = f'Hello {user_name},'
            free_credit_balance = float(wallet.get('free_credit_balance') or 0)
            plain_body = (
                f'{greeting}\n\n'
                f'Your KielTech account has received {amount:.2f} USD in free credit.\n'
                f'Your updated free-credit balance is {free_credit_balance:.2f} USD.\n'
                + (f'Reason: {reason}\n' if reason else '')
                + '\nThe credit is available in your KielTech wallet. Sign in to your account to view your balance.\n\n'
                'Thank you,\nThe KielTech team'
            )
            html_body = (
                '<!doctype html><html><body style="margin:0;padding:32px;background:#071726;'
                'color:#eaf5ff;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;'
                'padding:28px;border:1px solid #24455e;border-radius:16px;background:#0b2033">'
                '<p style="color:#58d3f5;font-size:12px;font-weight:bold;letter-spacing:2px">KIELTECH WALLET</p>'
                '<h1 style="font-size:24px">Free credit added</h1>'
                f'<p>{html.escape(greeting)}</p>'
                f'<p>Your account has been granted <strong>{amount:.2f} USD</strong> in free credit.</p>'
                f'<p>Your updated free-credit balance is <strong>{free_credit_balance:.2f} USD</strong>.</p>'
                + (f'<p><strong>Reason:</strong> {html.escape(reason)}</p>' if reason else '')
                + '<p>The credit is available in your KielTech wallet. Sign in to your account to view your balance.</p>'
                '<p style="margin-top:28px;color:#9ab2c5">Thank you,<br>The KielTech team</p>'
                '</main></body></html>'
            )
            try:
                email_sent = bool(billing_service._send_email_notification(
                    email,
                    'Free credit added to your KielTech account',
                    plain_body,
                    html_body=html_body,
                ))
            except Exception:
                logger.exception('Free-credit notification failed for %s', email)
                email_sent = False
            notification_error = None
            if not email_sent:
                notification_failed_count += 1
                notification_error = billing_service.last_email_error or 'Email delivery is not configured or was rejected.'
                logger.error('Free-credit notification could not be delivered to %s: %s', email, notification_error)
            results.append({
                'email': email,
                'free_credit_balance': free_credit_balance,
                'wallet_balance': wallet.get('balance', 0),
                'email_sent': email_sent,
                'email_error': notification_error,
            })
        except Exception as exc:
            logger.exception('Administrator free-credit grant failed for %s', email)
            failures.append({'email': email, 'detail': str(exc) or 'Credit grant failed.'})

    return JSONResponse(status_code=200, content={
        'audience': audience,
        'amount': amount,
        'recipient_count': len(recipients),
        'granted_count': len(results),
        'failed_count': len(failures),
        'notification_failed_count': notification_failed_count,
        'results': results,
        'failures': failures,
    })


@app.get('/admin/enterprise/requests')
async def list_enterprise_requests(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    rows = auth_service.connection.execute(
        "SELECT request_id, contact_name, contact_email, company, estimated_usage, services, deployment_requirements, message, created_at "
        "FROM contact_submissions WHERE lower(request_type) = 'enterprise' ORDER BY created_at DESC LIMIT 100"
    ).fetchall()
    return JSONResponse(status_code=200, content={'requests': [dict(row) for row in rows]})


@app.get('/admin/enterprise/keys')
async def list_enterprise_keys(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    return JSONResponse(status_code=200, content={'keys': billing_service.list_enterprise_keys()})


@app.post('/admin/enterprise/keys')
async def create_enterprise_key(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A JSON request body is required.'})

    client_email = str(payload.get('client_email') or '').strip().lower()
    request_id = str(payload.get('request_id') or '').strip() or None
    model_ids = payload.get('model_ids')
    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', client_email):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'Enter a valid requester email address.'})
    if not isinstance(model_ids, list) or not model_ids or len(model_ids) > 100 or any(not isinstance(model_id, str) or not model_id.strip() for model_id in model_ids):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'Select at least one model.'})
    model_ids = list(dict.fromkeys(model_id.strip() for model_id in model_ids))
    if len(model_ids) != len(payload.get('model_ids', [])):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'Selected model IDs must be unique.'})
    try:
        duration_days = int(payload.get('duration_days', 30))
        rpm_limit = payload.get('rpm_limit', 'unlimited')
        if duration_days < 1 or duration_days > 3650:
            raise ValueError('Expiry must be between 1 and 3,650 days.')
        if str(rpm_limit).lower() != 'unlimited':
            rpm_limit = int(rpm_limit)
            if rpm_limit < 1 or rpm_limit > 1_000_000:
                raise ValueError('Requests per minute must be between 1 and 1,000,000.')
        ready_models = {
            str(model.get('model_id'))
            for model in _get_public_model_catalog_data()
            if model.get('is_ready') is True and model.get('is_configured') is True
        }
        unavailable = [model_id for model_id in model_ids if model_id not in ready_models]
        if unavailable:
            raise ValueError('Only ready and configured catalog models can be assigned.')
        if request_id:
            submission = auth_service.connection.execute(
                "SELECT contact_email FROM contact_submissions WHERE request_id = ? AND lower(request_type) = 'enterprise'",
                (request_id,),
            ).fetchone()
            if not submission or str(submission['contact_email']).strip().lower() != client_email:
                raise ValueError('The selected enterprise request does not match this email address.')
        generated = billing_service.generate_enterprise_passkey(
            client_email=client_email,
            duration_days=duration_days,
            rpm_limit=rpm_limit,
            model_ids=model_ids,
            request_id=request_id,
            opaque=True,
        )
    except (TypeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': str(exc)})

    return JSONResponse(status_code=201, content={'message': 'Enterprise key generated. Copy or send it now; it will not be shown again.', **generated})


@app.post('/admin/enterprise/keys/send')
async def send_enterprise_key(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return admin_denied(request)
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A JSON request body is required.'})

    passkey = str(payload.get('passkey') or '').strip()
    recipient_email = str(payload.get('client_email') or '').strip().lower()
    if not passkey or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', recipient_email):
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'A valid requester email and generated key are required.'})

    key_row = billing_service.connection.execute(
        'SELECT client_email, is_redeemed, expires_at, rpm_limit, metadata FROM enterprise_keys WHERE key = ?',
        (billing_service._hash_key(passkey),),
    ).fetchone()
    if not key_row or str(key_row['client_email'] or '').strip().lower() != recipient_email:
        return JSONResponse(status_code=404, content={'error': 'key_not_found', 'detail': 'The key was not found for this requester email.'})
    if bool(key_row['is_redeemed']):
        return JSONResponse(status_code=409, content={'error': 'key_already_redeemed', 'detail': 'This key has already been redeemed and cannot be sent again.'})
    try:
        activation_expires_at = datetime.fromisoformat(key_row['expires_at'])
    except (TypeError, ValueError):
        return JSONResponse(status_code=500, content={'error': 'key_expiry_invalid', 'detail': 'The key activation expiry could not be verified.'})
    if activation_expires_at <= datetime.now(timezone.utc):
        return JSONResponse(status_code=410, content={'error': 'key_expired', 'detail': 'This key has expired and cannot be sent.'})

    try:
        key_metadata = json.loads(key_row['metadata'] or '{}')
    except (TypeError, ValueError):
        return JSONResponse(status_code=500, content={'error': 'key_metadata_invalid', 'detail': 'Key details could not be loaded.'})
    duration_days = int(key_metadata.get('duration_days') or 30)
    rpm_limit = str(key_row['rpm_limit'] or 'unlimited')
    model_ids = key_metadata.get('model_ids') or []
    activation_label = activation_expires_at.astimezone(timezone.utc).strftime('%B %d, %Y at %H:%M UTC')
    subject = 'Your KielTech Enterprise access key'
    body = '\n'.join([
        'Your KielTech Enterprise access key is ready.',
        '',
        f'Key: {passkey}',
        f'Activation deadline: {activation_label} (30 days after creation)',
        f'Enterprise access duration after redemption: {duration_days} days',
        f'Request limit: {"Unlimited" if rpm_limit.lower() == "unlimited" else f"{rpm_limit} requests per minute"}',
        f'Assigned models: {", ".join(str(model_id) for model_id in model_ids) or "As approved"}',
        '',
        'Sign in to your KielTech account using this email address, then redeem the key on the Billing page before the activation deadline.',
        'This key is single-use and can only be redeemed by the account registered to this email address.',
    ])
    html_body = (
        '<html><body><h2>Your KielTech Enterprise access key is ready</h2>'
        f'<p><strong>Key:</strong> <code>{html.escape(passkey)}</code></p>'
        f'<p><strong>Activation deadline:</strong> {html.escape(activation_label)} (30 days after creation)<br>'
        f'<strong>Access duration after redemption:</strong> {duration_days} days<br>'
        f'<strong>Request limit:</strong> {html.escape("Unlimited" if rpm_limit.lower() == "unlimited" else f"{rpm_limit} requests per minute")}<br>'
        f'<strong>Assigned models:</strong> {html.escape(", ".join(str(model_id) for model_id in model_ids) or "As approved")}</p>'
        '<p>Sign in to your KielTech account using this email address, then redeem the key on the Billing page before the activation deadline.</p>'
        '<p>This key is single-use and can only be redeemed by the account registered to this email address.</p>'
        '</body></html>'
    )
    if not billing_service._send_email_notification(recipient_email, subject, body, html_body=html_body):
        logger.error('Enterprise key email delivery failed: %s', billing_service.last_email_error or 'SMTP delivery was rejected.')
        return JSONResponse(status_code=502, content={'error': 'email_delivery_failed', 'detail': 'The email could not be sent. Check SMTP configuration and try again.'})
    return JSONResponse(status_code=200, content={'message': f'Enterprise key sent to {recipient_email}.'})


@app.post('/admin/generate-key')
async def generate_admin_key(request: Request) -> JSONResponse:
    if not is_admin_authenticated(request):
        return JSONResponse(status_code=401, content={'error': 'unauthorized', 'detail': 'Invalid admin secret'})

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    client_email = (payload or {}).get('client_email') or ''
    duration_days = (payload or {}).get('duration_days', 30)
    rpm_limit = (payload or {}).get('rpm_limit', 'unlimited')
    gpu_model = (payload or {}).get('gpu_model')
    runpod_template_id = (payload or {}).get('runpod_template_id')
    if not client_email:
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': 'client_email is required'})

    try:
        generated = billing_service.generate_enterprise_passkey(
            client_email=client_email,
            duration_days=int(duration_days),
            rpm_limit=rpm_limit,
            admin_secret=os.getenv('ENTERPRISE_PASSKEY_SECRET', ''),
            gpu_model=gpu_model,
            runpod_template_id=runpod_template_id,
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={'error': 'invalid_request', 'detail': str(exc)})

    return JSONResponse(status_code=200, content={'message': 'Enterprise passkey generated', **generated})


@app.get('/{path:path}', response_model=None)
async def frontend_fallback(path: str, request: Request) -> FileResponse | RedirectResponse | JSONResponse:
    candidate = FRONTEND_ROOT / path
    resolved_candidate = candidate.resolve()
    frontend_root = FRONTEND_ROOT.resolve()

    if resolved_candidate != frontend_root and frontend_root not in resolved_candidate.parents:
        return _frontend_file_response(FRONTEND_ROOT / '404.html', 'text/html', status_code=404)

    if Path(path).suffix.lower() == '.html' and not Path(path).name.startswith('admin-'):
        return _frontend_redirect(request, f'/{path}')

    if candidate.exists() and candidate.is_file():
        suffix = candidate.suffix.lower()
        if suffix == '.html':
            if candidate.name.startswith('admin-') and not is_admin_authenticated(request):
                return admin_denied(request)
            media_type = 'text/html'
        elif suffix == '.css':
            media_type = 'text/css'
        elif suffix == '.js':
            media_type = 'application/javascript'
        elif suffix == '.png':
            media_type = 'image/png'
        elif suffix == '.ico':
            media_type = 'image/x-icon'
        else:
            media_type = 'application/octet-stream'
        return _frontend_file_response(candidate, media_type)

    fallback_html = FRONTEND_ROOT / f'{path}.html'
    if fallback_html.exists() and fallback_html.is_file():
        if not fallback_html.name.startswith('admin-'):
            return _frontend_redirect(request, f'/{fallback_html.name}')
        if not is_admin_authenticated(request):
            return admin_denied(request)
        return _frontend_file_response(fallback_html, 'text/html')

    return _frontend_file_response(FRONTEND_ROOT / '404.html', 'text/html', status_code=404)
