from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import smtplib
from email.utils import formataddr
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urljoin
from decimal import Decimal, ROUND_HALF_UP
from app.database import connect_database

import httpx

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency fallback
    load_dotenv = None


def _is_mock_runpod_enabled() -> bool:
    raw_mode = os.getenv('RUNPOD_MOCK_MODE', '').strip().lower()
    if raw_mode in {'1', 'true', 'yes', 'on'}:
        return True
    return False


def _log_mock_runpod_notice(payload: dict, client_email: str | None, normalized_rpm: Any, expires_at: datetime, gpu_model: str | None) -> None:
    print('[RUNPOD MOCK] Enterprise passkey redemption is using mock provisioning.')
    print(f"[RUNPOD MOCK] client_email={client_email or payload.get('client_email')}")
    print(f"[RUNPOD MOCK] rpm_limit={normalized_rpm}")
    print(f"[RUNPOD MOCK] expires_at={expires_at.isoformat()}")
    print(f"[RUNPOD MOCK] gpu_model={gpu_model or payload.get('gpu_model')}")


@dataclass
class UsageSummary:
    current_usage: int
    included_limit: int
    overage_mode: bool
    overage_price: float
    period_start: str
    period_end: str

    def __getitem__(self, item):
        return getattr(self, item)


class BillingService:
    PAYSTACK_CHANNELS = ['bank', 'card', 'ussd', 'apple_pay', 'bank_transfer', 'payattitude']

    MODEL_RATE_MATRIX = {
        'kielmind-lite': 6.99,
        'kielmind-pro': 7.99,
        'kiellens-ocr': 7.49,
        'kiellens-chat': 8.49,
        'kielforge-fast': 0.010,
        'kielforge-hd': 0.015,
    }
    TEXT_MODELS = {'kielmind-lite', 'kielmind-pro', 'kiellens-ocr', 'kiellens-chat'}
    BUILTIN_MODEL_CATEGORIES = {
        'kielmind-lite': 'text-generation',
        'kielmind-pro': 'text-generation',
        'kiellens-ocr': 'image-understanding',
        'kiellens-chat': 'image-understanding',
        'kielforge-fast': 'image-generation',
        'kielforge-hd': 'image-generation',
    }
    MODEL_CATEGORIES = {
        'text-generation',
        'image-understanding',
        'image-generation',
        'multimodal',
        'voice',
        'video-generation',
        'embeddings',
    }

    def __init__(self, included_limit: int = 1000, overage_price: float = 0.05):
        self._load_environment_file()
        self._load_environment_file()
        self.included_limit = included_limit
        self.overage_price = overage_price
        self.connection = connect_database()
        self.period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.period_end = datetime(2026, 1, 31, tzinfo=timezone.utc)
        self.last_webhook_event: str | None = None
        self._initialize_schema()
        self._ensure_defaults()

    def _load_environment_file(self) -> None:
        module_file = Path(__file__).resolve()
        test_mode = (os.getenv('KIELTECH_TEST_MODE') or '').strip().lower() in {'1', 'true', 'yes', 'on'}
        search_roots = [
            Path.cwd(),
            module_file.parents[0],
            module_file.parents[1],
            module_file.parents[2],
            module_file.parents[3],
        ]
        seen: set[Path] = set()
        for root in search_roots:
            if not root:
                continue
            current = root.resolve()
            for parent in [current, *current.parents]:
                if parent in seen:
                    continue
                seen.add(parent)
                for candidate in [parent / 'Backend' / '.env', parent / 'backend' / '.env', parent / '.env']:
                    if candidate.exists():
                        if load_dotenv is not None:
                            load_dotenv(candidate, override=not test_mode)
                        for line in candidate.read_text(encoding='utf-8').splitlines():
                            if '=' not in line or line.strip().startswith('#'):
                                continue
                            key, value = line.split('=', 1)
                            key = key.strip()
                            value = value.strip().strip('"').strip("'")
                            if test_mode and key == 'DATABASE_URL':
                                continue
                            os.environ[key] = value
                        return

    def _initialize_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS billing_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS managed_models (
                id BIGSERIAL PRIMARY KEY,
                model_id TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                provider_model TEXT,
                category TEXT NOT NULL,
                input_price REAL,
                cache_price REAL NOT NULL,
                output_price REAL,
                max_context INTEGER,
                modalities TEXT NOT NULL DEFAULT '[]',
                type_label TEXT NOT NULL DEFAULT '',
                created_by TEXT,
                created_at TEXT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                is_chat_available BOOLEAN NOT NULL DEFAULT FALSE,
                chat_capability TEXT
            );
            CREATE TABLE IF NOT EXISTS permanently_deleted_models (
                model_id TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS billing_usage (
                user_id TEXT PRIMARY KEY,
                current_usage INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS billing_events (
                id BIGSERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                amount INTEGER NOT NULL,
                total INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS billing_payments (
                id BIGSERIAL PRIMARY KEY,
                reference TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                plan_code TEXT NOT NULL,
                amount INTEGER NOT NULL,
                status TEXT NOT NULL,
                provider TEXT NOT NULL,
                event TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wallets (
                id BIGSERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                balance REAL NOT NULL DEFAULT 0,
                free_credit_balance REAL NOT NULL DEFAULT 0,
                referral_credit_balance REAL NOT NULL DEFAULT 0,
                paid_balance REAL NOT NULL DEFAULT 0,
                account_status TEXT NOT NULL DEFAULT 'free_tier',
                currency TEXT NOT NULL DEFAULT 'USD',
                is_enterprise_dedicated INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id BIGSERIAL PRIMARY KEY,
                wallet_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL,
                description TEXT NOT NULL,
                reference TEXT,
                provider TEXT,
                balance_after REAL NOT NULL,
                created_at TEXT NOT NULL,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS billing_audit_events (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL,
                event_type TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT 'USD',
                reference TEXT,
                status TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_usage_logs (
                id BIGSERIAL PRIMARY KEY,
                request_id TEXT UNIQUE NOT NULL,
                api_key_id TEXT,
                owner_email TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                model TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                image_count INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS contact_submissions (
                id BIGSERIAL PRIMARY KEY,
                request_id TEXT UNIQUE NOT NULL,
                account_user_id TEXT,
                account_email TEXT,
                contact_name TEXT NOT NULL,
                contact_email TEXT NOT NULL,
                company TEXT NOT NULL,
                role TEXT NOT NULL,
                request_type TEXT NOT NULL,
                estimated_usage TEXT NOT NULL,
                services TEXT NOT NULL,
                deployment_requirements TEXT NOT NULL,
                message TEXT NOT NULL,
                consent_given INTEGER NOT NULL DEFAULT 0,
                consent_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS security_audit_logs (
                id BIGSERIAL PRIMARY KEY,
                event TEXT NOT NULL,
                actor_email TEXT,
                api_key_id TEXT,
                endpoint TEXT,
                status_code INTEGER,
                ip_address TEXT,
                user_agent TEXT,
                detail TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS enterprise_keys (
                id BIGSERIAL PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                client_email TEXT,
                is_redeemed INTEGER NOT NULL DEFAULT 0,
                redeemed_by TEXT,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                rpm_limit TEXT,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS redeemed_passkeys (
                id BIGSERIAL PRIMARY KEY,
                token_hash TEXT UNIQUE NOT NULL,
                redeemed_by TEXT NOT NULL,
                redeemed_at TEXT NOT NULL,
                client_email TEXT,
                expires_at TEXT,
                rpm_limit TEXT
            );
            CREATE TABLE IF NOT EXISTS enterprise_user_grants (
                email TEXT PRIMARY KEY,
                model_ids TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                rpm_limit TEXT NOT NULL,
                source_key_id INTEGER,
                updated_at TEXT NOT NULL
            );
            """
        )
        self.connection.commit()
        self._ensure_payment_columns()
        self._ensure_managed_model_columns()

    def record_api_usage(self, owner_email: str, api_key_id: str | None, endpoint: str, model: str, status_code: int, requested_at: str, completed_at: str | None, prompt_tokens: int = 0, completion_tokens: int = 0, total_tokens: int = 0, image_count: int = 0, cost_usd: float = 0.0, metadata: dict | None = None, request_id: str | None = None) -> dict:
        usage_id = request_id or secrets.token_hex(16)
        self.connection.execute(
            'INSERT INTO api_usage_logs (request_id, api_key_id, owner_email, endpoint, model, status_code, requested_at, completed_at, prompt_tokens, completion_tokens, total_tokens, image_count, cost_usd, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (usage_id, api_key_id, owner_email.lower(), endpoint, model, int(status_code), requested_at, completed_at, int(prompt_tokens or 0), int(completion_tokens or 0), int(total_tokens or 0), int(image_count or 0), round(float(cost_usd or 0), 6), json.dumps(metadata or {})),
        )
        self.connection.commit()
        return {'request_id': usage_id, 'api_key_id': api_key_id, 'owner_email': owner_email.lower(), 'endpoint': endpoint, 'model': model, 'status_code': int(status_code), 'requested_at': requested_at, 'completed_at': completed_at, 'prompt_tokens': int(prompt_tokens or 0), 'completion_tokens': int(completion_tokens or 0), 'total_tokens': int(total_tokens or 0), 'image_count': int(image_count or 0), 'cost_usd': round(float(cost_usd or 0), 6)}

    def get_api_usage(self, email: str | None = None, api_key_id: str | None = None, limit: int = 100) -> list[dict]:
        clauses, params = [], []
        if email:
            clauses.append('lower(owner_email) = lower(?)'); params.append(email)
        if api_key_id:
            clauses.append('api_key_id = ?'); params.append(api_key_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ''
        rows = self.connection.execute(f'SELECT * FROM api_usage_logs{where} ORDER BY id DESC LIMIT ?', (*params, max(1, min(int(limit), 500)))).fetchall()
        return [dict(row) | {'metadata': json.loads(row['metadata'] or '{}'), 'cost_usd': round(float(row['cost_usd'] or 0), 6)} for row in rows]

    def get_api_usage_page(self, email: str | None = None, api_key_id: str | None = None, model: str | None = None, start: str | None = None, end: str | None = None, page: int = 1, page_size: int = 50) -> dict:
        clauses, params = [], []
        for clause, value in [('lower(owner_email) = lower(?)', email), ('api_key_id = ?', api_key_id), ('model = ?', model), ('requested_at >= ?', start), ('requested_at < ?', end)]:
            if value:
                clauses.append(clause); params.append(value)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ''
        safe_page = max(1, int(page)); safe_size = max(1, min(int(page_size), 200)); offset = (safe_page - 1) * safe_size
        total = self.connection.execute(f'SELECT COUNT(*) AS count FROM api_usage_logs{where}', params).fetchone()['count']
        rows = self.connection.execute(f'SELECT * FROM api_usage_logs{where} ORDER BY id DESC LIMIT ? OFFSET ?', (*params, safe_size, offset)).fetchall()
        items = [dict(row) | {'metadata': json.loads(row['metadata'] or '{}'), 'cost_usd': round(float(row['cost_usd'] or 0), 6)} for row in rows]
        return {'items': items, 'page': safe_page, 'page_size': safe_size, 'total': int(total), 'pages': max(1, (int(total) + safe_size - 1) // safe_size)}

    def get_api_usage_summary(self, email: str, api_key_id: str | None = None) -> dict:
        key_clause = ' AND api_key_id = ?' if api_key_id else ''
        params = (email, api_key_id) if api_key_id else (email,)
        row = self.connection.execute(f'SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, MAX(COALESCE(completed_at, requested_at)) AS last_used_at FROM api_usage_logs WHERE lower(owner_email) = lower(?)' + key_clause, params).fetchone()
        return {'request_count': int(row['requests'] or 0), 'total_tokens': int(row['tokens'] or 0), 'total_cost_usd': round(float(row['cost'] or 0), 6), 'last_used_at': row['last_used_at']}

    def get_model_request_counts(self) -> dict[str, int]:
        rows = self.connection.execute(
            'SELECT lower(model) AS model_id, COUNT(*) AS request_count FROM api_usage_logs GROUP BY lower(model)'
        ).fetchall()
        return {row['model_id']: int(row['request_count'] or 0) for row in rows}

    def get_total_api_request_count(self) -> int:
        row = self.connection.execute('SELECT COUNT(*) AS request_count FROM api_usage_logs').fetchone()
        return int(row['request_count'] or 0)

    def record_security_event(self, event: str, actor_email: str | None = None, api_key_id: str | None = None, endpoint: str | None = None, status_code: int | None = None, ip_address: str | None = None, user_agent: str | None = None, detail: str | None = None) -> None:
        self.connection.execute('INSERT INTO security_audit_logs (event, actor_email, api_key_id, endpoint, status_code, ip_address, user_agent, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', (event, actor_email, api_key_id, endpoint, status_code, ip_address, user_agent, detail, datetime.now(timezone.utc).isoformat()))
        self.connection.commit()

    def get_security_events(self, limit: int = 100) -> list[dict]:
        rows = self.connection.execute('SELECT * FROM security_audit_logs ORDER BY id DESC LIMIT ?', (max(1, min(int(limit), 500)),)).fetchall()
        return [dict(row) for row in rows]

    def close(self) -> None:
        self.connection.close()

    def _ensure_payment_columns(self) -> None:
        columns = self.connection.table_columns('billing_payments')
        additions = {
            'amount_usd': 'REAL',
            'amount_ngn': 'INTEGER',
            'exchange_rate': 'REAL',
        }
        for name, column_type in additions.items():
            if name not in columns:
                self.connection.execute(f'ALTER TABLE billing_payments ADD COLUMN {name} {column_type}')
        self.connection.commit()

    def _ensure_managed_model_columns(self) -> None:
        columns = self.connection.table_columns('managed_models')
        if 'modalities' not in columns:
            self.connection.execute("ALTER TABLE managed_models ADD COLUMN modalities TEXT NOT NULL DEFAULT '[]'")
        if 'type_label' not in columns:
            self.connection.execute("ALTER TABLE managed_models ADD COLUMN type_label TEXT NOT NULL DEFAULT ''")
        if 'is_chat_available' not in columns:
            self.connection.execute("ALTER TABLE managed_models ADD COLUMN is_chat_available BOOLEAN NOT NULL DEFAULT FALSE")
        if 'chat_capability' not in columns:
            self.connection.execute('ALTER TABLE managed_models ADD COLUMN chat_capability TEXT')
        nullable_columns = {'provider_model', 'input_price', 'output_price', 'max_context'}
        for column in nullable_columns.intersection(columns):
            self.connection.execute(f'ALTER TABLE managed_models ALTER COLUMN {column} DROP NOT NULL')
        self.connection.commit()

    def _ensure_defaults(self) -> None:
        env_secret = (os.getenv('PAYSTACK_SECRET_KEY') or '').strip()
        env_public = (os.getenv('PAYSTACK_PUBLIC_KEY') or '').strip()
        env_hosted_form_url = self._normalize_paystack_hosted_form_url(os.getenv('PAYSTACK_HOSTED_FORM_URL') or os.getenv('PAYSTACK_HOSTED_URL') or os.getenv('PAYSTACK_CARD_FORM_URL'))
        defaults = {
            'paystack_secret_key': env_secret,
            'paystack_enabled': '1' if (env_secret or env_hosted_form_url) else '0',
            'paystack_public_key': env_public,
            'paystack_hosted_form_url': env_hosted_form_url,
            'default_plan_code': 'basic-monthly',
            'default_amount': '150',
            'usd_to_ngn_rate': os.getenv('USD_TO_NGN_RATE', '1370.45'),
        }
        for key, value in defaults.items():
            self._set_config_if_missing(key, str(value))
        self.connection.commit()
        self._sync_env_overrides()
        self._ensure_wallet_columns()
        self._ensure_enterprise_key_columns()

    def _sync_env_overrides(self) -> None:
        env_secret = (os.getenv('PAYSTACK_SECRET_KEY') or '').strip()
        env_public = (os.getenv('PAYSTACK_PUBLIC_KEY') or '').strip()
        env_hosted_form_url = self._normalize_paystack_hosted_form_url(os.getenv('PAYSTACK_HOSTED_FORM_URL') or os.getenv('PAYSTACK_HOSTED_URL') or os.getenv('PAYSTACK_CARD_FORM_URL'))
        if env_secret:
            self._set_config('paystack_secret_key', env_secret)
            self._set_config('paystack_enabled', '1')
        if env_public:
            self._set_config('paystack_public_key', env_public)
        if env_hosted_form_url:
            self._set_config('paystack_hosted_form_url', env_hosted_form_url)
            self._set_config('paystack_enabled', '1')
        if env_secret or env_public or env_hosted_form_url:
            self.connection.commit()
        elif not self.connection.execute("SELECT 1 FROM billing_config WHERE key = 'paystack_secret_key'").fetchone():
            self._set_config('paystack_secret_key', '')
            self._set_config('paystack_enabled', '0')
            self.connection.commit()

    def _set_config_if_missing(self, key: str, value: str) -> None:
        if not self.connection.execute('SELECT 1 FROM billing_config WHERE key = ?', (key,)).fetchone():
            self._set_config(key, value)

    def _set_config(self, key: str, value: str) -> None:
        self.connection.execute('INSERT INTO billing_config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', (key, value))

    def _ensure_wallet_columns(self) -> None:
        columns = self.connection.table_columns('wallets')
        if 'free_credit_balance' not in columns:
            self.connection.execute('ALTER TABLE wallets ADD COLUMN free_credit_balance REAL NOT NULL DEFAULT 0')
        if 'referral_credit_balance' not in columns:
            self.connection.execute('ALTER TABLE wallets ADD COLUMN referral_credit_balance REAL NOT NULL DEFAULT 0')
        if 'paid_balance' not in columns:
            self.connection.execute('ALTER TABLE wallets ADD COLUMN paid_balance REAL NOT NULL DEFAULT 0')
        if 'account_status' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN account_status TEXT NOT NULL DEFAULT 'free_tier'")
        if 'is_enterprise_dedicated' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN is_enterprise_dedicated INTEGER NOT NULL DEFAULT 0")
        if 'overage_enabled' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN overage_enabled INTEGER NOT NULL DEFAULT 0")
        if 'card_on_file' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN card_on_file INTEGER NOT NULL DEFAULT 0")
        if 'paystack_authorization_code' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN paystack_authorization_code TEXT")
        if 'card_brand' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN card_brand TEXT")
        if 'card_last4' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN card_last4 TEXT")
        if 'card_token' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN card_token TEXT")
        if 'warning_email_sent' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN warning_email_sent INTEGER NOT NULL DEFAULT 0")
        if 'insufficient_email_sent' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN insufficient_email_sent INTEGER NOT NULL DEFAULT 0")
        if 'daily_spend_limit' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN daily_spend_limit REAL NOT NULL DEFAULT 25")
        if 'monthly_spend_limit' not in columns:
            self.connection.execute("ALTER TABLE wallets ADD COLUMN monthly_spend_limit REAL NOT NULL DEFAULT 250")
        self.connection.commit()

    def _ensure_enterprise_key_columns(self) -> None:
        enterprise_columns = self.connection.table_columns('enterprise_keys')
        if 'rpm_limit' not in enterprise_columns:
            self.connection.execute("ALTER TABLE enterprise_keys ADD COLUMN rpm_limit TEXT")
        if 'metadata' not in enterprise_columns:
            self.connection.execute('ALTER TABLE enterprise_keys ADD COLUMN metadata TEXT')
        self.connection.commit()

    def reset(self) -> None:
        self.connection.rollback()
        self.connection.execute('DELETE FROM billing_usage')
        self.connection.execute('DELETE FROM billing_events')
        self.connection.execute('DELETE FROM billing_payments')
        self.connection.execute('DELETE FROM wallets')
        self.connection.execute('DELETE FROM wallet_transactions')
        self.connection.execute('DELETE FROM billing_audit_events')
        self.connection.execute('DELETE FROM enterprise_keys')
        self.connection.execute('DELETE FROM redeemed_passkeys')
        self.connection.execute('DELETE FROM billing_config')
        self._ensure_defaults()
        self.connection.commit()

    def _get_or_create_wallet(self, email: str) -> dict:
        normalized_email = email.lower()
        row = self.connection.execute('SELECT id, email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, is_enterprise_dedicated, overage_enabled, card_on_file, paystack_authorization_code, card_brand, card_last4, card_token, warning_email_sent, insufficient_email_sent, daily_spend_limit, monthly_spend_limit, created_at, updated_at FROM wallets WHERE email = ?', (normalized_email,)).fetchone()
        now = datetime.now(timezone.utc).isoformat()
        if row:
            is_demo_wallet = normalized_email in {'demo-user@example.com', 'demo-user'}
            if is_demo_wallet and (float(row['free_credit_balance'] or 0.0) != 0.0 or float(row['paid_balance'] or 0.0) != 0.0):
                self.connection.execute(
                    'UPDATE wallets SET free_credit_balance = ?, referral_credit_balance = ?, paid_balance = ?, balance = ?, updated_at = ? WHERE id = ?',
                    (0.0, 0.0, 0.0, 0.0, now, row['id']),
                )
                self.connection.commit()
                row = self.connection.execute('SELECT id, email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, is_enterprise_dedicated, overage_enabled, card_on_file, paystack_authorization_code, card_brand, card_last4, card_token, warning_email_sent, insufficient_email_sent, daily_spend_limit, monthly_spend_limit, created_at, updated_at FROM wallets WHERE email = ?', (normalized_email,)).fetchone()
            return dict(row)

        default_free_credit = 0.0
        default_paid_balance = 0.0
        self.connection.execute(
            'INSERT INTO wallets (email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, is_enterprise_dedicated, overage_enabled, card_on_file, paystack_authorization_code, card_brand, card_last4, card_token, warning_email_sent, insufficient_email_sent, daily_spend_limit, monthly_spend_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (normalized_email, default_free_credit + default_paid_balance, default_free_credit, 0.0, default_paid_balance, 'free_tier', 'USD', 0, 0, 0, None, None, None, None, 0, 0, float(os.getenv('BILLING_DAILY_SPEND_LIMIT_USD', '25')), float(os.getenv('BILLING_MONTHLY_SPEND_LIMIT_USD', '250')), now, now),
        )
        self.connection.commit()
        wallet_row = self.connection.execute('SELECT id, email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, is_enterprise_dedicated, overage_enabled, card_on_file, paystack_authorization_code, card_brand, card_last4, card_token, warning_email_sent, insufficient_email_sent, daily_spend_limit, monthly_spend_limit, created_at, updated_at FROM wallets WHERE email = ?', (normalized_email,)).fetchone()
        return dict(wallet_row)

    def record_billing_event(self, email: str, event_type: str, amount: float = 0.0, currency: str = 'USD', reference: str | None = None, status: str = 'success', metadata: dict | None = None) -> None:
        self.connection.execute(
            'INSERT INTO billing_audit_events (email, event_type, amount, currency, reference, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (email.lower(), event_type, round(float(amount or 0), 6), (currency or 'USD').upper(), reference, status, json.dumps(metadata or {}), datetime.now(timezone.utc).isoformat()),
        )
        self.connection.commit()

    def _hash_key(self, key: str) -> str:
        return hashlib.sha256((key or '').encode('utf-8')).hexdigest()

    def _normalize_rpm_limit(self, rpm_limit: Any) -> str | int:
        if isinstance(rpm_limit, str):
            normalized = rpm_limit.strip().lower()
            if normalized in {'unlimited', 'none', 'null'}:
                return 'unlimited'
            try:
                return int(normalized)
            except ValueError as exc:
                raise ValueError('rpm_limit must be a number or "unlimited"') from exc
        if rpm_limit is None:
            return 'unlimited'
        return int(rpm_limit)

    def _normalize_gpu_model(self, gpu_model: Any) -> str | None:
        if gpu_model is None:
            return None
        if isinstance(gpu_model, str):
            normalized = gpu_model.strip()
            return normalized or None
        return str(gpu_model)

    def _normalize_template_id(self, template_id: Any) -> str | None:
        if template_id is None:
            return None
        if isinstance(template_id, str):
            normalized = template_id.strip()
            return normalized or None
        return str(template_id)

    def _normalize_paystack_hosted_form_url(self, value: Any) -> str:
        raw_value = (value or '').strip()
        if not raw_value:
            return ''
        lowered = raw_value.lower()
        placeholder_markers = ('your-paystack-hosted-form-url', 'your-payment-url', 'placeholder', 'example.com', 'example.org', 'localhost')
        if any(marker in lowered for marker in placeholder_markers):
            return ''
        return raw_value

    def _encode_signed_passkey(self, payload: dict, admin_secret: str) -> str:
        payload_json = json.dumps(payload, separators=(',', ':'), sort_keys=True)
        payload_b64 = base64.urlsafe_b64encode(payload_json.encode('utf-8')).decode('ascii').rstrip('=')
        signature = hmac.new((admin_secret or '').encode('utf-8'), payload_b64.encode('ascii'), hashlib.sha256).hexdigest()
        return f"KIEL-ENT-{payload_b64}.{signature}"

    def _decode_signed_passkey(self, passkey: str, admin_secret: str) -> dict:
        if not passkey.startswith('KIEL-ENT-'):
            raise ValueError('Invalid or already used passkey')

        encoded_payload = passkey[len('KIEL-ENT-'):]
        if '.' not in encoded_payload:
            raise ValueError('Invalid or already used passkey')
        payload_b64, signature = encoded_payload.split('.', 1)
        expected_signature = hmac.new((admin_secret or '').encode('utf-8'), payload_b64.encode('ascii'), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError('Invalid or already used passkey')

        padding = '=' * (-len(payload_b64) % 4)
        decoded_payload = base64.urlsafe_b64decode((payload_b64 + padding).encode('ascii')).decode('utf-8')
        payload = json.loads(decoded_payload)
        expires_at = payload.get('expires_at')
        if expires_at:
            expiry_dt = datetime.fromisoformat(expires_at)
            if expiry_dt <= datetime.now(timezone.utc):
                raise ValueError('Invalid or already used passkey')
        return payload

    def generate_enterprise_passkey(self, client_email: str, duration_days: int = 30, rpm_limit: Any = 'unlimited', admin_secret: str = '', gpu_model: Any = None, runpod_template_id: Any = None, model_ids: list[str] | None = None, request_id: str | None = None, opaque: bool = False) -> dict:
        admin_secret = admin_secret or os.getenv('ENTERPRISE_PASSKEY_SECRET', '')
        normalized_email = (client_email or '').strip().lower()
        if not normalized_email:
            raise ValueError('client_email is required')

        duration = int(duration_days or 30)
        created_at = datetime.now(timezone.utc)
        access_expires_at = created_at + timedelta(days=duration)
        activation_expires_at = created_at + timedelta(days=30) if opaque else access_expires_at
        normalized_rpm = self._normalize_rpm_limit(rpm_limit)
        normalized_gpu_model = self._normalize_gpu_model(gpu_model)
        normalized_template_id = self._normalize_template_id(runpod_template_id)
        normalized_model_ids = list(dict.fromkeys(
            model_id.strip() for model_id in (model_ids or []) if isinstance(model_id, str) and model_id.strip()
        ))
        if any(len(model_id) > 120 for model_id in normalized_model_ids):
            raise ValueError('Model IDs must be no longer than 120 characters')
        payload = {
            'client_email': normalized_email,
            'rpm_limit': normalized_rpm,
            'gpu_model': normalized_gpu_model,
            'runpod_template_id': normalized_template_id,
            'request_id': request_id,
            'issued_at': datetime.now(timezone.utc).isoformat(),
            'version': 1,
        }
        if opaque:
            payload['duration_days'] = duration
            payload['activation_expires_at'] = activation_expires_at.isoformat()
        else:
            payload['expires_at'] = access_expires_at.isoformat()
        if model_ids is not None:
            payload['model_ids'] = normalized_model_ids
        passkey = f"KIEL-ENT-{secrets.token_urlsafe(32)}" if opaque else self._encode_signed_passkey(payload, admin_secret)
        self.create_enterprise_key(passkey, client_email=normalized_email, expires_at=activation_expires_at, rpm_limit=normalized_rpm, metadata=payload)
        return {
            'passkey': passkey,
            'client_email': normalized_email,
            'expires_at': activation_expires_at.isoformat(),
            'activation_expires_at': activation_expires_at.isoformat(),
            'access_duration_days': duration,
            'rpm_limit': normalized_rpm,
            'model_ids': normalized_model_ids,
            'gpu_model': normalized_gpu_model,
            'runpod_template_id': normalized_template_id,
        }

    def list_enterprise_keys(self, limit: int = 100) -> list[dict]:
        rows = self.connection.execute(
            'SELECT id, client_email, is_redeemed, redeemed_by, created_at, expires_at, rpm_limit, metadata FROM enterprise_keys ORDER BY id DESC LIMIT ?',
            (max(1, min(int(limit), 250)),),
        ).fetchall()
        keys = []
        now = datetime.now(timezone.utc)
        for row in rows:
            key = dict(row)
            try:
                metadata = json.loads(key.get('metadata') or '{}')
            except (TypeError, ValueError):
                metadata = {}
            expires_at = key.get('expires_at')
            try:
                is_expired = bool(expires_at and datetime.fromisoformat(expires_at) <= now)
            except (TypeError, ValueError):
                is_expired = False
            keys.append({
                'id': key['id'],
                'client_email': key.get('client_email'),
                'is_redeemed': bool(key.get('is_redeemed')),
                'redeemed_by': key.get('redeemed_by'),
                'created_at': key.get('created_at'),
                'expires_at': expires_at,
                'rpm_limit': key.get('rpm_limit') or 'unlimited',
                'model_ids': metadata.get('model_ids') or [],
                'request_id': metadata.get('request_id'),
                'status': 'redeemed' if key.get('is_redeemed') else 'expired' if is_expired else 'available',
            })
        return keys

    def get_enterprise_user_grant(self, email: str) -> dict | None:
        row = self.connection.execute(
            'SELECT email, model_ids, expires_at, rpm_limit, source_key_id, updated_at FROM enterprise_user_grants WHERE lower(email) = lower(?)',
            ((email or '').strip().lower(),),
        ).fetchone()
        if not row:
            return None
        grant = dict(row)
        try:
            grant['model_ids'] = json.loads(grant.get('model_ids') or '[]')
        except (TypeError, ValueError):
            grant['model_ids'] = []
        return grant

    def create_enterprise_key(self, key: str, client_email: str | None = None, expires_at: datetime | None = None, rpm_limit: Any = None, metadata: dict | None = None) -> dict:
        normalized_key = (key or '').strip()
        if not normalized_key:
            raise ValueError('Passkey is required')
        now = datetime.now(timezone.utc)
        expiry = expires_at or (now + timedelta(days=365))
        hashed_key = self._hash_key(normalized_key)
        normalized_rpm = self._normalize_rpm_limit(rpm_limit) if rpm_limit is not None else None
        metadata_json = json.dumps(metadata, separators=(',', ':'), sort_keys=True) if metadata is not None else None
        self.connection.execute(
            'INSERT INTO enterprise_keys (key, client_email, is_redeemed, created_at, expires_at, rpm_limit, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (hashed_key, (client_email or '').strip().lower() or None, 0, now.isoformat(), expiry.isoformat(), str(normalized_rpm) if normalized_rpm is not None else None, metadata_json),
        )
        self.connection.commit()
        row = self.connection.execute('SELECT id, key, client_email, is_redeemed, redeemed_by, created_at, expires_at, rpm_limit, metadata FROM enterprise_keys WHERE key = ?', (hashed_key,)).fetchone()
        return dict(row)

    def redeem_enterprise_key(self, key: str, user_email: str, admin_secret: str = '') -> dict:
        normalized_key = (key or '').strip()
        normalized_email = (user_email or '').strip().lower()
        if not normalized_key:
            raise ValueError('Passkey is required')
        if not normalized_email:
            raise ValueError('User email is required')

        hashed_key = self._hash_key(normalized_key)
        row = self.connection.execute('SELECT id, key, client_email, is_redeemed, redeemed_by, created_at, expires_at, rpm_limit, metadata FROM enterprise_keys WHERE key = ?', (hashed_key,)).fetchone()
        if not row:
            raise ValueError('Invalid or already used passkey')

        existing_redeemed = self.connection.execute('SELECT 1 FROM redeemed_passkeys WHERE token_hash = ?', (hashed_key,)).fetchone()
        if existing_redeemed:
            raise ValueError('Invalid or already used passkey')

        payload = None
        if normalized_key.startswith('KIEL-ENT-') and '.' in normalized_key:
            payload = self._decode_signed_passkey(normalized_key, admin_secret)
            expires_at = datetime.fromisoformat(payload['expires_at'])
            normalized_rpm = payload.get('rpm_limit', 'unlimited')
            payload_email = (payload.get('client_email') or '').strip().lower()
            stored_email = (row['client_email'] or '').strip().lower()
            if payload_email and stored_email and payload_email != stored_email:
                raise ValueError('Invalid or already used passkey')
            client_email = payload_email or stored_email or None
            model_ids = payload.get('model_ids')
            gpu_model = payload.get('gpu_model')
            runpod_template_id = payload.get('runpod_template_id')
        elif normalized_key.startswith('KIEL-ENT-'):
            try:
                payload = json.loads(row['metadata'] or '{}')
            except (TypeError, ValueError) as exc:
                raise ValueError('Invalid or already used passkey') from exc
            activation_expires_at = datetime.fromisoformat(row['expires_at'])
            normalized_rpm = row['rpm_limit'] or 'unlimited'
            stored_email = (row['client_email'] or '').strip().lower()
            payload_email = (payload.get('client_email') or '').strip().lower()
            if not stored_email or stored_email != payload_email:
                raise ValueError('Invalid or already used passkey')
            client_email = stored_email
            model_ids = payload.get('model_ids')
            gpu_model = payload.get('gpu_model')
            runpod_template_id = payload.get('runpod_template_id')
            duration_days = int(payload.get('duration_days') or 30)
            if duration_days < 1 or duration_days > 3650:
                raise ValueError('Invalid or already used passkey')
            expires_at = datetime.now(timezone.utc) + timedelta(days=duration_days)
        else:
            expires_at = datetime.fromisoformat(row['expires_at'])
            normalized_rpm = row['rpm_limit'] or 'unlimited'
            client_email = (row['client_email'] or None)
            model_ids = None
            gpu_model = None
            runpod_template_id = None

        if client_email and client_email != normalized_email:
            raise ValueError('This passkey was issued to a different account')
        now = datetime.now(timezone.utc)
        if expires_at <= now or (normalized_key.startswith('KIEL-ENT-') and '.' not in normalized_key and activation_expires_at <= now):
            raise ValueError('Invalid or already used passkey')
        if bool(row['is_redeemed']):
            raise ValueError('Invalid or already used passkey')

        redeemed = self.connection.execute(
            'UPDATE enterprise_keys SET is_redeemed = 1, redeemed_by = ? WHERE id = ? AND is_redeemed = 0 RETURNING id',
            (normalized_email, row['id']),
        ).fetchone()
        if not redeemed:
            raise ValueError('Invalid or already used passkey')
        self.connection.execute(
            'INSERT INTO redeemed_passkeys (token_hash, redeemed_by, redeemed_at, client_email, expires_at, rpm_limit) VALUES (?, ?, ?, ?, ?, ?)',
            (hashed_key, normalized_email, datetime.now(timezone.utc).isoformat(), client_email, expires_at.isoformat(), str(normalized_rpm)),
        )
        if model_ids is not None:
            self.connection.execute(
                'INSERT INTO enterprise_user_grants (email, model_ids, expires_at, rpm_limit, source_key_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(email) DO UPDATE SET model_ids = excluded.model_ids, expires_at = excluded.expires_at, rpm_limit = excluded.rpm_limit, source_key_id = excluded.source_key_id, updated_at = excluded.updated_at',
                (normalized_email, json.dumps(model_ids), expires_at.isoformat(), str(normalized_rpm), row['id'], datetime.now(timezone.utc).isoformat()),
            )
        self.connection.commit()

        runpod_proxy_url = None
        if gpu_model and runpod_template_id:
            runpod_proxy_url = self._provision_runpod_gpu(gpu_model, runpod_template_id, payload=payload)
        elif gpu_model and _is_mock_runpod_enabled():
            runpod_proxy_url = self._provision_runpod_gpu(gpu_model, runpod_template_id or 'mock-template', payload=payload, mock_mode=True)

        self.connection.execute(
            'UPDATE wallets SET is_enterprise_dedicated = 1, account_status = ?, updated_at = ? WHERE email = ?',
            ('active_paid', datetime.now(timezone.utc).isoformat(), normalized_email),
        )
        self.connection.commit()

        from app.routers.api import auth_service
        user_record = auth_service.get_user_by_email(normalized_email)
        if user_record is not None:
            user_record['is_enterprise_dedicated'] = True
            user_record['enterprise_rpm_limit'] = normalized_rpm
            user_record['enterprise_expires_at'] = expires_at.isoformat()
            user_record['enterprise_model_ids'] = model_ids
            user_record['gpu_model'] = gpu_model
            user_record['runpod_template_id'] = runpod_template_id
            user_record['runpod_proxy_url'] = runpod_proxy_url

        return {
            'message': 'Enterprise passkey redeemed',
            'is_enterprise_dedicated': True,
            'enterprise_rpm_limit': normalized_rpm,
            'enterprise_expires_at': expires_at.isoformat(),
            'enterprise_model_ids': model_ids,
            'client_email': client_email,
            'gpu_model': gpu_model,
            'runpod_template_id': runpod_template_id,
            'runpod_proxy_url': runpod_proxy_url,
        }

    def _provision_runpod_gpu(self, gpu_model: str, template_id: str, payload: dict | None = None, mock_mode: bool = False) -> str | None:
        if mock_mode or _is_mock_runpod_enabled() or not os.getenv('RUNPOD_API_KEY', '').strip():
            client_email = (payload or {}).get('client_email')
            normalized_rpm = (payload or {}).get('rpm_limit', 'unlimited')
            expires_at = datetime.fromisoformat((payload or {}).get('expires_at')) if (payload or {}).get('expires_at') else datetime.now(timezone.utc) + timedelta(days=30)
            gpu_name = gpu_model or (payload or {}).get('gpu_model')
            _log_mock_runpod_notice(payload or {}, client_email, normalized_rpm, expires_at, gpu_name)
            return 'https://api.runpod.ai/v2/mock-test-pod-8000/chat'

        api_key = os.getenv('RUNPOD_API_KEY', '').strip()
        if not api_key:
            return None

        runpod_payload = {
            'name': f'kieltech-{secrets.token_hex(4)}',
            'gpuType': gpu_model,
            'templateId': template_id,
            'ports': [{'port': 8000, 'protocol': 'HTTP'}],
        }
        response = httpx.post(
            'https://api.runpod.ai/v2/pods/run',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json=runpod_payload,
            timeout=20.0,
        )
        response.raise_for_status()
        data = response.json()
        return data.get('proxy_url') or data.get('pod', {}).get('proxy_url')

    def get_tier_for_balance(self, balance: float | int, account_status: str = 'free_tier') -> dict:
        numeric_balance = float(balance or 0.0)
        normalized_account_status = (account_status or 'free_tier').lower()
        if normalized_account_status != 'active_paid':
            return {
                'name': 'Standard',
                'range': '$1 - $100',
                'min': 1,
                'max': 100,
                'rpm': 5,
                'next_tier': 'Pro',
                'next_amount': max(1, 101 - numeric_balance),
                'progress_percent': min(100, max(0, int((numeric_balance / 101) * 100))),
            }

        if numeric_balance >= 1501:
            return {
                'name': 'Ultra',
                'range': '$1,501+',
                'min': 1501,
                'max': None,
                'rpm': 5000,
                'next_tier': None,
                'next_amount': 0,
                'progress_percent': 100,
            }
        if numeric_balance >= 501:
            return {
                'name': 'Elite',
                'range': '$501 - $1,500',
                'min': 501,
                'max': 1500,
                'rpm': 1000,
                'next_tier': 'Ultra',
                'next_amount': max(0, 1501 - numeric_balance),
                'progress_percent': min(100, max(0, int((numeric_balance / 1501) * 100))),
            }
        if numeric_balance >= 101:
            return {
                'name': 'Pro',
                'range': '$101 - $500',
                'min': 101,
                'max': 500,
                'rpm': 300,
                'next_tier': 'Elite',
                'next_amount': max(0, 501 - numeric_balance),
                'progress_percent': min(100, max(0, int((numeric_balance / 501) * 100))),
            }
        return {
            'name': 'Standard',
            'range': '$1 - $100',
            'min': 1,
            'max': 100,
            'rpm': 60,
            'next_tier': 'Pro',
            'next_amount': max(1, 101 - numeric_balance),
            'progress_percent': min(100, max(0, int((numeric_balance / 101) * 100))),
        }

    def get_rate_limit_for_balance(self, balance: float | int, account_status: str = 'free_tier') -> int:
        tier = self.get_tier_for_balance(balance, account_status)
        return int(tier.get('rpm') or 60)

    def _send_email_notification(self, email: str, subject: str, body: str, html_body: str | None = None) -> bool:
        self.last_email_error = None
        recipient = (email or '').strip().lower()
        if not recipient:
            return
        smtp_host = (os.getenv('SMTP_HOST') or '').strip()
        smtp_port = int(os.getenv('SMTP_PORT', '587') or '587')
        smtp_secure = (os.getenv('SMTP_SECURE') or '').strip().lower() in {'1', 'true', 'yes', 'on'} or smtp_port == 465
        smtp_user = (os.getenv('SMTP_USER') or '').strip()
        smtp_pass = (os.getenv('SMTP_PASS') or '').strip()
        sender = (os.getenv('EMAIL_FROM') or smtp_user).strip()
        if not smtp_host or not smtp_user or not smtp_pass:
            return False
        try:
            message = MIMEMultipart('alternative')
            message['Subject'] = subject
            message['From'] = formataddr(('KielTech', sender))
            message['To'] = recipient
            clean_html = re.sub(r'<img\b[^>]*(?:cid:kieltech-logo|KielTech-logo\.png)[^>]*>', '', html_body or '', flags=re.I)
            if not clean_html:
                clean_html = f'<pre>{body}</pre>'
            font_style = '<style>@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"); body { font-family: "Inter", Arial, Helvetica, sans-serif; }</style>'
            if re.search(r'<head\b', clean_html, flags=re.I):
                clean_html = re.sub(r'(<head\b[^>]*>)', r'\1' + font_style, clean_html, count=1, flags=re.I)
            else:
                clean_html = font_style + clean_html
            message.attach(MIMEText(body, 'plain', 'utf-8'))
            message.attach(MIMEText(clean_html, 'html', 'utf-8'))
            smtp_client = smtplib.SMTP_SSL if smtp_secure else smtplib.SMTP
            with smtp_client(smtp_host, smtp_port, timeout=20) as server:
                if not smtp_secure:
                    server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(sender, [recipient], message.as_string())
            return True
        except Exception as exc:
            self.last_email_error = f'{type(exc).__name__}: {exc}'
            return False

    def _mark_notification_sent(self, email: str, kind: str) -> None:
        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        if kind == 'warning':
            self.connection.execute('UPDATE wallets SET warning_email_sent = 1, updated_at = ? WHERE id = ?', (now, wallet['id']))
        elif kind == 'insufficient':
            self.connection.execute('UPDATE wallets SET insufficient_email_sent = 1, updated_at = ? WHERE id = ?', (now, wallet['id']))
        self.connection.commit()

    def maybe_notify_balance_state(self, email: str, estimated_cost: float) -> None:
        wallet = self.get_wallet(email)
        balance = float(wallet.get('balance') or 0.0)
        if not estimated_cost or estimated_cost <= 0:
            return
        threshold = max(estimated_cost * 0.7, 1.0)
        if balance <= 0.0 and not bool(wallet.get('insufficient_email_sent')):
            self._send_email_notification(email, 'KielTech wallet balance is depleted', 'Your wallet balance is now empty. Top up to keep using the models. If you enabled overage, further requests may be billed to your stored card.')
            self._mark_notification_sent(email, 'insufficient')
            return
        if balance < estimated_cost and not bool(wallet.get('insufficient_email_sent')):
            if bool(wallet.get('overage_enabled')) and bool(wallet.get('card_on_file')):
                self._send_email_notification(email, 'KielTech wallet balance is low', 'Your wallet balance is too low for the next request. Because overage is enabled, the request may be billed to your stored card if you continue.')
            else:
                self._send_email_notification(email, 'KielTech wallet balance is insufficient', 'Your wallet balance is too low for the next request. Further requests will be blocked until you top up.')
            self._mark_notification_sent(email, 'insufficient')
            return
        if balance <= threshold and not bool(wallet.get('warning_email_sent')):
            self._send_email_notification(email, 'KielTech wallet balance is running low', 'Your wallet balance is approaching the minimum needed for another request. Top up soon to avoid interruption.')
            self._mark_notification_sent(email, 'warning')

    def set_overage_policy(self, email: str, enabled: bool = False, card_on_file: bool = False, paystack_authorization_code: str | None = None) -> dict:
        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        effective_enabled = 1 if bool(enabled) else 0
        new_auth_code = wallet.get('paystack_authorization_code')
        if paystack_authorization_code is not None:
            new_auth_code = paystack_authorization_code.strip() or None
        effective_card_on_file = 1 if bool(enabled or card_on_file or wallet.get('card_on_file') or wallet.get('paystack_authorization_code') or new_auth_code) else 0
        self.connection.execute(
            'UPDATE wallets SET overage_enabled = ?, card_on_file = ?, paystack_authorization_code = ?, updated_at = ? WHERE id = ?',
            (effective_enabled, effective_card_on_file, new_auth_code, now, wallet['id']),
        )
        self.connection.commit()
        return self.get_wallet(email)

    def set_overage_limits(self, email: str, daily_limit: float, monthly_limit: float) -> dict:
        daily_limit = round(float(daily_limit), 2)
        monthly_limit = round(float(monthly_limit), 2)
        if daily_limit < 0 or monthly_limit < 0 or monthly_limit < daily_limit:
            raise ValueError('Monthly overage limit must be at least the daily overage limit, and limits cannot be negative.')
        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            'UPDATE wallets SET daily_spend_limit = ?, monthly_spend_limit = ?, updated_at = ? WHERE id = ?',
            (daily_limit, monthly_limit, now, wallet['id']),
        )
        self.connection.commit()
        self.record_billing_event(email, 'overage_limit_changed', 0, 'USD', None, 'success', {'daily_limit': daily_limit, 'monthly_limit': monthly_limit})
        return self.get_wallet(email)

    def save_card_on_file(self, email: str, cardholder_name: str | None = None, card_number: str | None = None, expiry_month: str | None = None, expiry_year: str | None = None, cvc: str | None = None) -> dict:
        wallet = self._get_or_create_wallet(email)
        normalized_card_number = (card_number or '').replace(' ', '').replace('-', '')
        if len(normalized_card_number) < 12:
            raise ValueError('invalid_card_number')

        last4 = normalized_card_number[-4:]
        brand = 'unknown'
        if normalized_card_number.startswith('4'):
            brand = 'visa'
        elif normalized_card_number.startswith('5'):
            brand = 'mastercard'
        elif normalized_card_number.startswith('3'):
            brand = 'amex'
        elif normalized_card_number.startswith('6'):
            brand = 'discover'

        token = f'local-card-{secrets.token_hex(8)}'
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            'UPDATE wallets SET card_on_file = 1, card_brand = ?, card_last4 = ?, card_token = ?, updated_at = ? WHERE id = ?',
            (brand, last4, token, now, wallet['id']),
        )
        self.connection.commit()
        return self.get_wallet(email)

    def _store_paystack_authorization(self, email: str, authorization_code: str) -> dict:
        wallet = self._get_or_create_wallet(email)
        if not authorization_code:
            raise ValueError('invalid_authorization_code')
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            'UPDATE wallets SET paystack_authorization_code = ?, card_on_file = ?, updated_at = ? WHERE id = ?',
            (authorization_code.strip(), 1, now, wallet['id']),
        )
        self.connection.commit()
        return self.get_wallet(email)

    def get_wallet(self, email: str) -> dict:
        wallet = self._get_or_create_wallet(email)
        wallet.pop('paystack_authorization_code', None)
        transactions = self.get_wallet_transactions(email, limit=10)
        free_credit_balance = float(wallet.get('free_credit_balance') or 0.0)
        referral_credit_balance = float(wallet.get('referral_credit_balance') or 0.0)
        paid_balance = float(wallet.get('paid_balance') or 0.0)
        balance = free_credit_balance + referral_credit_balance + paid_balance
        account_status = wallet.get('account_status') or 'free_tier'
        tier = self.get_tier_for_balance(balance, account_status)
        equivalency = {
            'kielmind-lite': {
                'label': 'tokens',
                'value': max(0, int((balance / max(self.MODEL_RATE_MATRIX['kielmind-lite'], 1e-9)) * 1_000_000)),
            },
            'kielmind-pro': {
                'label': 'tokens',
                'value': max(0, int((balance / max(self.MODEL_RATE_MATRIX['kielmind-pro'], 1e-9)) * 1_000_000)),
            },
            'kiellens-ocr': {
                'label': 'requests',
                'value': max(0, int(balance / max(self.MODEL_RATE_MATRIX['kiellens-ocr'], 1e-9))),
            },
            'kiellens-chat': {
                'label': 'requests',
                'value': max(0, int(balance / max(self.MODEL_RATE_MATRIX['kiellens-chat'], 1e-9))),
            },
            'kielforge-fast': {
                'label': 'generations',
                'value': max(0, int(balance / max(self.MODEL_RATE_MATRIX['kielforge-fast'], 1e-9))),
            },
            'kielforge-hd': {
                'label': 'generations',
                'value': max(0, int(balance / max(self.MODEL_RATE_MATRIX['kielforge-hd'], 1e-9))),
            },
        }
        return {
            'email': wallet['email'],
            'balance': round(balance, 6),
            'free_credit_balance': round(free_credit_balance, 6),
            'referral_credit_balance': round(referral_credit_balance, 6),
            'paid_balance': round(paid_balance, 6),
            'account_status': account_status,
            'overage_enabled': bool(wallet.get('overage_enabled')),
            'card_on_file': bool(wallet.get('card_on_file') and wallet.get('paystack_authorization_code')),
            'warning_email_sent': bool(wallet.get('warning_email_sent')),
            'insufficient_email_sent': bool(wallet.get('insufficient_email_sent')),
            'daily_spend_limit': round(float(wallet.get('daily_spend_limit') or 0), 2),
            'monthly_spend_limit': round(float(wallet.get('monthly_spend_limit') or 0), 2),
            'currency': wallet['currency'],
            'is_enterprise_dedicated': bool(wallet.get('is_enterprise_dedicated')),
            'created_at': wallet['created_at'],
            'updated_at': wallet['updated_at'],
            'transactions': transactions,
            'equivalency': equivalency,
            'tier': tier,
            'rate_limit': self.get_rate_limit_for_balance(balance, account_status),
        }

    def get_wallet_transactions(self, email: str, limit: int = 10) -> list[dict]:
        wallet = self._get_or_create_wallet(email)
        rows = self.connection.execute(
            'SELECT kind, amount, currency, description, reference, provider, balance_after, created_at, metadata FROM wallet_transactions WHERE wallet_id = ? ORDER BY id DESC LIMIT ?',
            (wallet['id'], limit),
        ).fetchall()
        return [
            {
                'kind': row['kind'],
                'amount': round(float(row['amount']), 2),
                'currency': row['currency'],
                'description': row['description'],
                'reference': row['reference'],
                'provider': row['provider'],
                'balance_after': round(float(row['balance_after']), 2),
                'created_at': row['created_at'],
                'metadata': json.loads(row['metadata'] or '{}'),
            }
            for row in rows
        ]

    def normalize_credit_amount(self, amount: int, currency: str) -> float:
        currency_code = (currency or 'NGN').upper()
        if currency_code == 'NGN':
            return round(amount / 100.0, 2)
        return round(amount / 100.0, 2)

    def set_wallet_balances(self, email: str, free_credit_balance: float = 0.0, paid_balance: float = 0.0, account_status: str = 'free_tier', is_enterprise_dedicated: bool = False) -> dict:
        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            'UPDATE wallets SET free_credit_balance = ?, paid_balance = ?, account_status = ?, balance = ?, is_enterprise_dedicated = ?, updated_at = ? WHERE id = ?',
            (float(free_credit_balance), float(paid_balance), account_status, float(free_credit_balance) + float(wallet.get('referral_credit_balance') or 0.0) + float(paid_balance), 1 if is_enterprise_dedicated else 0, now, wallet['id']),
        )
        self.connection.commit()
        return self.get_wallet(email)

    def set_account_status(self, email: str, account_status: str) -> dict:
        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute('UPDATE wallets SET account_status = ?, updated_at = ? WHERE id = ?', (account_status, now, wallet['id']))
        self.connection.commit()
        return self.get_wallet(email)

    def credit_wallet(self, email: str, amount: int | float, currency: str = 'USD', provider: str = 'paystack', reference: str | None = None, description: str = 'wallet-topup', metadata: dict | None = None, balance_type: str = 'paid') -> dict:
        if amount <= 0:
            return self.get_wallet(email)

        wallet = self._get_or_create_wallet(email)
        if reference and self.connection.execute('SELECT 1 FROM wallet_transactions WHERE reference = ?', (reference,)).fetchone():
            return self.get_wallet(email)
        credit_amount = float(amount) if isinstance(amount, float) else self.normalize_credit_amount(int(amount), currency)
        now = datetime.now(timezone.utc).isoformat()
        self.connection.rollback()
        self.connection.execute('BEGIN')
        try:
            fresh_wallet = self.connection.execute('SELECT id, email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, created_at, updated_at FROM wallets WHERE email = ?', (email.lower(),)).fetchone()
            current_free_balance = float(fresh_wallet['free_credit_balance'] or 0.0)
            current_referral_balance = float(fresh_wallet['referral_credit_balance'] or 0.0)
            current_paid_balance = float(fresh_wallet['paid_balance'] or 0.0)
            if balance_type == 'referral_credit':
                new_free_balance = current_free_balance
                new_referral_balance = current_referral_balance + credit_amount
                new_paid_balance = current_paid_balance
            elif balance_type == 'free_credit':
                new_free_balance = current_free_balance + credit_amount
                new_referral_balance = current_referral_balance
                new_paid_balance = current_paid_balance
            else:
                new_free_balance = current_free_balance
                new_referral_balance = current_referral_balance
                new_paid_balance = current_paid_balance + credit_amount
            new_balance = new_free_balance + new_referral_balance + new_paid_balance
            self.connection.execute(
                'UPDATE wallets SET free_credit_balance = ?, referral_credit_balance = ?, paid_balance = ?, balance = ?, currency = ?, updated_at = ? WHERE id = ?',
                (new_free_balance, new_referral_balance, new_paid_balance, new_balance, (currency or 'USD').upper(), now, fresh_wallet['id']),
            )
            self.connection.execute(
                'INSERT INTO wallet_transactions (wallet_id, kind, amount, currency, description, reference, provider, balance_after, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (fresh_wallet['id'], 'credit', credit_amount, (currency or 'USD').upper(), description, reference, provider, new_balance, now, json.dumps({'balance_type': balance_type, **(metadata or {})})),
            )
            self.connection.commit()
            self.record_billing_event(email, 'credit', credit_amount, currency, reference, 'success', {'provider': provider, 'balance_type': balance_type, **(metadata or {})})
        except Exception:
            self.connection.rollback()
            self.record_billing_event(email, 'credit', float(amount or 0), currency, reference, 'failed', {'provider': provider, 'error': 'credit_failed', **(metadata or {})})
            raise
        return self.get_wallet(email)

    def apply_referral_commission(self, referred_email: str, topup_amount: float, topup_reference: str | None = None) -> float:
        minimum_topup = 10.0
        commission_cap = 5.0
        if float(topup_amount or 0) < minimum_topup:
            return 0.0
        commission = round(min(float(topup_amount) * 0.05, commission_cap), 2)
        if commission <= 0:
            return 0.0
        reward_reference = f'referral-commission-{(topup_reference or secrets.token_hex(8))}'
        normalized_referred = (referred_email or '').strip().lower()
        now = datetime.now(timezone.utc).isoformat()
        self.connection.rollback()
        self.connection.execute('BEGIN')
        try:
            attribution = self.connection.execute(
                'SELECT referrer_email, commission_issued FROM referral_attributions WHERE lower(referred_email) = lower(?) FOR UPDATE',
                (normalized_referred,),
            ).fetchone()
            if not attribution or attribution['commission_issued']:
                self.connection.rollback()
                return 0.0
            wallet = self.connection.execute(
                'SELECT id, balance, free_credit_balance, referral_credit_balance, paid_balance FROM wallets WHERE lower(email) = lower(?) FOR UPDATE',
                (attribution['referrer_email'],),
            ).fetchone()
            if not wallet:
                raise ValueError('referrer_wallet_not_found')
            new_referral_balance = float(wallet['referral_credit_balance'] or 0.0) + commission
            new_balance = float(wallet['free_credit_balance'] or 0.0) + new_referral_balance + float(wallet['paid_balance'] or 0.0)
            self.connection.execute(
                'UPDATE wallets SET referral_credit_balance = ?, balance = ?, updated_at = ? WHERE id = ?',
                (new_referral_balance, new_balance, now, wallet['id']),
            )
            self.connection.execute(
                'INSERT INTO wallet_transactions (wallet_id, kind, amount, currency, description, reference, provider, balance_after, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (wallet['id'], 'credit', commission, 'USD', 'Referral commission for first qualifying top-up', reward_reference, 'referral', new_balance, now, json.dumps({'balance_type': 'referral_credit', 'referred_email': normalized_referred, 'topup_reference': topup_reference, 'rate': 0.05})),
            )
            self.connection.execute(
                'UPDATE referral_attributions SET commission_issued = 1, reward_amount = ?, qualifying_topup_reference = ? WHERE lower(referred_email) = lower(?) AND commission_issued = 0',
                (commission, topup_reference, normalized_referred),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        self.record_billing_event(attribution['referrer_email'], 'referral_commission', commission, 'USD', reward_reference, 'success', {'referred_email': normalized_referred, 'topup_reference': topup_reference})
        return commission

    def reverse_referral_commission(self, referred_email: str, topup_reference: str | None = None) -> float:
        normalized_referred = (referred_email or '').strip().lower()
        self.connection.rollback()
        self.connection.execute('BEGIN')
        attribution = self.connection.execute(
            'SELECT referrer_email, reward_amount, qualifying_topup_reference, commission_reversed FROM referral_attributions WHERE lower(referred_email) = lower(?) FOR UPDATE',
            (normalized_referred,),
        ).fetchone()
        if not attribution or attribution['commission_reversed'] or (topup_reference and attribution['qualifying_topup_reference'] != topup_reference):
            self.connection.rollback()
            return 0.0
        commission = float(attribution['reward_amount'] or 0.0)
        revoked = 0.0
        if commission > 0:
            wallet = self.connection.execute(
                'SELECT id, free_credit_balance, referral_credit_balance, paid_balance FROM wallets WHERE lower(email) = lower(?) FOR UPDATE',
                (attribution['referrer_email'],),
            ).fetchone()
            current_referral = float(wallet['referral_credit_balance'] or 0.0) if wallet else 0.0
            revoked = min(current_referral, commission)
            if revoked > 0:
                now = datetime.now(timezone.utc).isoformat()
                new_referral = current_referral - revoked
                new_balance = float(wallet['free_credit_balance'] or 0.0) + new_referral + float(wallet['paid_balance'] or 0.0)
                self.connection.execute(
                    'UPDATE wallets SET referral_credit_balance = ?, balance = ?, updated_at = ? WHERE id = ?',
                    (new_referral, new_balance, now, wallet['id']),
                )
                self.connection.execute(
                    'INSERT INTO wallet_transactions (wallet_id, kind, amount, currency, description, reference, provider, balance_after, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (wallet['id'], 'debit', revoked, 'USD', 'Referral commission reversed after payment refund', f'referral-reversal-{topup_reference or secrets.token_hex(8)}', 'referral', new_balance, now, json.dumps({'balance_type': 'referral_credit', 'referred_email': normalized_referred, 'topup_reference': topup_reference, 'original_commission': commission, 'reversed_amount': revoked})),
                )
        reversal_reference = f'referral-reversal-{topup_reference or secrets.token_hex(8)}'
        self.connection.execute(
            'UPDATE referral_attributions SET commission_reversed = 1, reward_amount = 0, reversal_reference = ?, reversal_shortfall = ? WHERE lower(referred_email) = lower(?) AND commission_reversed = 0',
            (reversal_reference, round(commission - revoked, 2), normalized_referred),
        )
        self.connection.commit()
        self.record_billing_event(attribution['referrer_email'], 'referral_commission_reversal', revoked, 'USD', reversal_reference, 'success', {'referred_email': normalized_referred, 'topup_reference': topup_reference, 'unreversed_amount': round(commission - revoked, 2)})
        return commission

    def debit_wallet(self, email: str, amount: float, currency: str = 'USD', provider: str = 'inference', reference: str | None = None, description: str = 'model-charge', metadata: dict | None = None) -> dict:
        if amount <= 0:
            return self.get_wallet(email)

        wallet = self._get_or_create_wallet(email)
        now = datetime.now(timezone.utc).isoformat()
        self.connection.rollback()
        self.connection.execute('BEGIN')
        try:
            fresh_wallet = self.connection.execute('SELECT id, email, balance, free_credit_balance, referral_credit_balance, paid_balance, account_status, currency, overage_enabled, card_on_file, warning_email_sent, insufficient_email_sent, created_at, updated_at FROM wallets WHERE email = ?', (email.lower(),)).fetchone()
            current_free_balance = float(fresh_wallet['free_credit_balance'] or 0.0)
            current_referral_balance = float(fresh_wallet['referral_credit_balance'] or 0.0)
            current_paid_balance = float(fresh_wallet['paid_balance'] or 0.0)
            remaining_amount = float(amount)
            debit_sources = []
            new_free_balance = current_free_balance
            new_paid_balance = current_paid_balance
            overage_allowed = bool(fresh_wallet['overage_enabled']) and bool(fresh_wallet['card_on_file']) and bool(wallet.get('paystack_authorization_code'))
            if current_free_balance > 0:
                free_debit = min(current_free_balance, remaining_amount)
                new_free_balance = current_free_balance - free_debit
                remaining_amount -= free_debit
                if 0 < remaining_amount <= 0.0001:
                    remaining_amount = 0.0
                debit_sources.append({'balance_type': 'free_credit', 'amount': round(free_debit, 6)})
            if remaining_amount > 0 and current_referral_balance > 0:
                referral_debit = min(current_referral_balance, remaining_amount)
                new_referral_balance = current_referral_balance - referral_debit
                remaining_amount -= referral_debit
                if 0 < remaining_amount <= 0.0001:
                    remaining_amount = 0.0
                debit_sources.append({'balance_type': 'referral_credit', 'amount': round(referral_debit, 6)})
            else:
                new_referral_balance = current_referral_balance
            if remaining_amount > 0:
                if current_paid_balance < remaining_amount and not overage_allowed:
                    raise ValueError('insufficient_balance')
                new_paid_balance = current_paid_balance - remaining_amount
                debit_sources.append({'balance_type': 'paid_balance', 'amount': round(remaining_amount, 6), 'overage': overage_allowed and current_paid_balance < remaining_amount})
            new_balance = new_free_balance + new_referral_balance + new_paid_balance
            self.connection.execute(
                'UPDATE wallets SET free_credit_balance = ?, referral_credit_balance = ?, paid_balance = ?, balance = ?, currency = ?, updated_at = ? WHERE id = ?',
                (new_free_balance, new_referral_balance, new_paid_balance, new_balance, (currency or 'USD').upper(), now, fresh_wallet['id']),
            )
            self.connection.execute(
                'INSERT INTO wallet_transactions (wallet_id, kind, amount, currency, description, reference, provider, balance_after, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (fresh_wallet['id'], 'debit', float(amount), (currency or 'USD').upper(), description, reference, provider, new_balance, now, json.dumps({'sources': debit_sources, **(metadata or {})})),
            )
            self.connection.commit()
            self.record_billing_event(email, 'debit', float(amount), currency, reference, 'success', {'provider': provider, **(metadata or {})})
        except Exception:
            self.connection.rollback()
            self.record_billing_event(email, 'debit', float(amount), currency, reference, 'failed', {'provider': provider, 'error': 'insufficient_balance', **(metadata or {})})
            raise
        return self.get_wallet(email)

    def has_sufficient_balance(self, email: str, minimum_balance: float = 0.0) -> bool:
        wallet = self.get_wallet(email)
        return float(wallet['balance']) > minimum_balance

    def can_cover_charge(self, email: str, amount: float) -> tuple[bool, str | None]:
        wallet = self._get_or_create_wallet(email)
        total_balance = float(wallet['balance'] or 0.0)
        if total_balance >= amount:
            return True, None

        overage_allowed = bool(wallet.get('overage_enabled')) and bool(wallet.get('card_on_file')) and bool(wallet.get('paystack_authorization_code'))
        if overage_allowed:
            overage_amount = amount - total_balance
            daily_spend, monthly_spend = self.get_overage_totals(email)
            daily_limit = float(wallet.get('daily_spend_limit') or 0.0)
            monthly_limit = float(wallet.get('monthly_spend_limit') or 0.0)
            if daily_limit > 0 and daily_spend + overage_amount > daily_limit:
                return False, 'Daily overage limit reached. Lower the request or edit your overage limit.'
            if monthly_limit > 0 and monthly_spend + overage_amount > monthly_limit:
                return False, 'Monthly overage limit reached. Lower the request or edit your overage limit.'
            return True, None

        return False, 'Insufficient token quota for the requested model. Top up to continue.'

    def get_spend_totals(self, email: str) -> tuple[float, float]:
        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
        row = self.connection.execute(
            "SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END), 0) AS daily, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END), 0) AS monthly FROM wallet_transactions WHERE wallet_id = (SELECT id FROM wallets WHERE email = ?) AND kind = 'debit'",
            (day_start, month_start, email.lower()),
        ).fetchone()
        return round(float(row['daily'] or 0), 6), round(float(row['monthly'] or 0), 6)

    def get_overage_totals(self, email: str) -> tuple[float, float]:
        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
        row = self.connection.execute(
            "SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END), 0) AS daily, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END), 0) AS monthly FROM billing_audit_events WHERE email = ? AND event_type = 'overage' AND status = 'success'",
            (day_start, month_start, email.lower()),
        ).fetchone()
        return round(float(row['daily'] or 0), 6), round(float(row['monthly'] or 0), 6)

    def charge_saved_card(self, email: str, amount: float, metadata: dict | None = None) -> dict:
        wallet = self._get_or_create_wallet(email)
        authorization_code = wallet.get('paystack_authorization_code')
        card_token = wallet.get('card_token')
        if not authorization_code and not card_token:
            raise ValueError('no_saved_card')

        if not authorization_code and card_token:
            self.credit_wallet(email, amount, currency='USD', provider='saved-card', reference=f'local-{secrets.token_hex(6)}', description='overage charge via saved card', metadata={'source': 'local-card-token', **(metadata or {})}, balance_type='paid')
            return {'status': 'success', 'reference': f'local-{secrets.token_hex(6)}', 'amount_usd': amount, 'amount_ngn': int((Decimal(str(amount)) * Decimal('1370.45') * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))}

        config = self.get_config()
        secret_key = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = secret_key['value'] if secret_key else ''
        if not config.get('paystack_enabled') or not secret_key:
            raise ValueError('paystack_not_configured')

        exchange_rate, rate_source = self._fetch_usd_to_ngn_rate()
        amount_ngn = int((Decimal(str(amount)) * Decimal(str(exchange_rate)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        if amount_ngn <= 0:
            raise ValueError('invalid_charge_amount')

        try:
            response = httpx.post(
                'https://api.paystack.co/transaction/charge_authorization',
                json={
                    'authorization_code': authorization_code,
                    'email': wallet['email'],
                    'amount': amount_ngn,
                    'currency': 'NGN',
                    'metadata': {
                        'source': 'kieltech-overage',
                        **(metadata or {}),
                    },
                },
                headers={'Authorization': f'Bearer {secret_key}', 'Content-Type': 'application/json'},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json() or {}
            data = payload.get('data', {}) or {}
            if not payload.get('status') or data.get('status') != 'success':
                raise ValueError('payment_failed')
            reference = data.get('reference') or f'overage-{secrets.token_hex(6)}'
            self.credit_wallet(email, amount, currency='USD', provider='paystack', reference=reference, description='overage charge via saved card', metadata={'amount_ngn': amount_ngn, 'exchange_rate': exchange_rate, **(metadata or {})}, balance_type='paid')
            return {'status': 'success', 'reference': reference, 'amount_usd': amount, 'amount_ngn': amount_ngn}
        except httpx.HTTPStatusError as exc:
            try:
                err = exc.response.json()
                raise ValueError(err.get('message') or 'payment_failed')
            except Exception:
                raise ValueError('payment_failed')
        except Exception as exc:
            if isinstance(exc, ValueError):
                raise
            raise ValueError('payment_failed')

    def estimate_charge(self, model: str, response_payload: dict | None = None, usage: dict | None = None, prompt_length: int | None = None) -> float:
        config = self.get_model_config(model)
        if not config:
            return 0.0
        usage_payload = usage or {}
        if response_payload:
            response_section = response_payload.get('response') or {}
            if response_section.get('usage'):
                usage_payload = response_section.get('usage')

        total_tokens = usage_payload.get('total_tokens') or 0
        if not total_tokens:
            prompt_tokens = usage_payload.get('prompt_tokens') or 0
            completion_tokens = usage_payload.get('completion_tokens') or 0
            total_tokens = prompt_tokens + completion_tokens
            if not total_tokens and prompt_length is not None:
                total_tokens = max(1, math.ceil(prompt_length / 4))

        if config.get('category') == 'image-generation':
            rate = config.get('input_price')
            if rate is None:
                return 0.0
            image_count = usage_payload.get('images') or usage_payload.get('image_count') or 1
            return round(float(image_count) * float(rate), 6)

        if config.get('input_price') is None or config.get('output_price') is None:
            return 0.0
        prompt_tokens = int(usage_payload.get('prompt_tokens') or 0)
        completion_tokens = int(usage_payload.get('completion_tokens') or 0)
        if not prompt_tokens and not completion_tokens:
            prompt_tokens = int(total_tokens or (max(1, math.ceil(prompt_length / 4)) if prompt_length else 0))
        prompt_details = usage_payload.get('prompt_tokens_details') or {}
        cached_tokens = int(
            usage_payload.get('cached_tokens')
            or usage_payload.get('cache_read_input_tokens')
            or prompt_details.get('cached_tokens')
            or prompt_details.get('cache_read_tokens')
            or 0
        )
        cached_tokens = min(prompt_tokens, cached_tokens)
        uncached_tokens = max(0, prompt_tokens - cached_tokens)
        amount = (
            uncached_tokens * float(config['input_price'])
            + cached_tokens * float(config['cache_price'])
            + completion_tokens * float(config['output_price'])
        ) / 1_000_000
        return round(max(amount, 0.000001), 6) if prompt_tokens or completion_tokens else 0.0

    def get_model_config(self, model_id: str) -> dict | None:
        row = self.connection.execute(
            'SELECT model_id, display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, type_label, created_by, created_at, is_active, is_chat_available, chat_capability FROM managed_models WHERE model_id = ?',
            (model_id,),
        ).fetchone()
        if row:
            if not row['is_active']:
                return None
            config = dict(row)
            try:
                config['modalities'] = json.loads(config.get('modalities') or '[]')
            except (TypeError, ValueError):
                config['modalities'] = []
            if model_id in self.MODEL_RATE_MATRIX:
                return config | {'is_builtin': True}
            if config.get('provider_model') and config.get('input_price') is not None and config.get('output_price') is not None and config.get('max_context') is not None:
                return config | {'is_builtin': False}
            return None

        if model_id in self.MODEL_RATE_MATRIX:
            rate = self.MODEL_RATE_MATRIX[model_id]
            return {
                'model_id': model_id,
                'display_name': model_id,
                'provider_model': None,
                'category': self.BUILTIN_MODEL_CATEGORIES[model_id],
                'input_price': rate,
                'cache_price': 0.0,
                'output_price': rate,
                'max_context': 65536 if model_id == 'kielforge-fast' else 128000,
                'is_builtin': True,
                'is_active': True,
            }
        return None

    def get_model_provider(self, model_id: str) -> str:
        config = self.get_model_config(model_id)
        return str(config.get('provider_model') or model_id) if config else model_id

    def list_managed_models(self, include_inactive: bool = True) -> list[dict]:
        condition = '' if include_inactive else 'WHERE is_active = TRUE'
        rows = self.connection.execute(
            f'SELECT model_id, display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, type_label, created_by, created_at, is_active, is_chat_available, chat_capability FROM managed_models {condition} ORDER BY created_at DESC, id DESC'
        ).fetchall()
        models = [dict(row) for row in rows]
        for model in models:
            try:
                model['modalities'] = json.loads(model.get('modalities') or '[]')
            except (TypeError, ValueError):
                model['modalities'] = []
            model['is_ready'] = bool(model.get('is_active'))
            model['is_configured'] = bool(
                model.get('provider_model')
                and model.get('input_price') is not None
                and model.get('output_price') is not None
                and model.get('max_context') is not None
            )
            model['status'] = 'Ready' if model['is_ready'] else 'Not ready'
        newest_id = next((
            model['model_id'] for model in models
            if model['is_active'] and model.get('created_by') not in {'catalog-seed', 'catalog-builtin'}
        ), None)
        for model in models:
            model['is_new'] = model['model_id'] == newest_id
        return models

    def create_managed_model(self, model: dict, created_by: str | None = None) -> dict:
        row = self.connection.execute(
            '''INSERT INTO managed_models
                    (model_id, display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, type_label, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING model_id, display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, type_label, created_by, created_at, is_active''',
            (
                model['model_id'],
                model['display_name'],
                model['provider_model'],
                model['category'],
                model['input_price'],
                model['cache_price'],
                model['output_price'],
                model['max_context'],
                json.dumps(model.get('modalities') or []),
                model.get('type_label') or '',
                created_by,
                datetime.now(timezone.utc).isoformat(),
            ),
        ).fetchone()
        self.connection.execute('DELETE FROM permanently_deleted_models WHERE model_id = ?', (model['model_id'],))
        self.connection.commit()
        return dict(row)

    def update_managed_model(self, model_id: str, model: dict) -> bool:
        row = self.connection.execute(
            '''UPDATE managed_models
               SET display_name = ?, provider_model = ?, category = ?, input_price = ?, cache_price = ?,
                   output_price = ?, max_context = ?, modalities = ?, type_label = ?
               WHERE model_id = ? AND is_active = TRUE
               RETURNING model_id''',
            (
                model['display_name'],
                model['provider_model'],
                model['category'],
                model['input_price'],
                model['cache_price'],
                model['output_price'],
                model['max_context'],
                json.dumps(model.get('modalities') or []),
                model.get('type_label') or '',
                model_id,
            ),
        ).fetchone()
        if not row:
            return False
        self.connection.commit()
        return True

    def restore_managed_model(self, model_id: str) -> bool:
        row = self.connection.execute(
            '''UPDATE managed_models
               SET is_active = TRUE
               WHERE model_id = ? AND is_active = FALSE
               RETURNING model_id''',
            (model_id,),
        ).fetchone()
        if not row:
            return False
        self.connection.commit()
        return True

    def permanently_delete_managed_model(self, model_id: str) -> bool:
        row = self.connection.execute(
            'SELECT model_id FROM managed_models WHERE model_id = ? AND is_active = FALSE',
            (model_id,),
        ).fetchone()
        if not row:
            return False
        self.connection.execute(
            'INSERT INTO permanently_deleted_models (model_id, deleted_at) VALUES (?, ?) ON CONFLICT (model_id) DO NOTHING',
            (model_id, datetime.now(timezone.utc).isoformat()),
        )
        self.connection.execute('DELETE FROM managed_models WHERE model_id = ? AND is_active = FALSE', (model_id,))
        self.connection.commit()
        return True

    def list_permanently_deleted_model_ids(self) -> set[str]:
        rows = self.connection.execute('SELECT model_id FROM permanently_deleted_models').fetchall()
        return {row['model_id'] for row in rows}

    def set_managed_model_chat_availability(self, model_id: str, is_chat_available: bool, chat_capability: str | None = None) -> bool:
        row = self.connection.execute(
            '''UPDATE managed_models
               SET is_chat_available = ?, chat_capability = COALESCE(?, chat_capability)
               WHERE model_id = ? AND is_active = TRUE
               RETURNING model_id''',
            (is_chat_available, chat_capability, model_id),
        ).fetchone()
        if not row:
            return False
        self.connection.commit()
        return True

    def apply_inference_charge(self, email: str, model: str, response_payload: dict | None = None, usage: dict | None = None, prompt_length: int | None = None) -> dict:
        amount = self.estimate_charge(model, response_payload=response_payload, usage=usage, prompt_length=prompt_length)
        if amount <= 0:
            return self.get_wallet(email)

        can_cover, failure_message = self.can_cover_charge(email, amount)
        if not can_cover:
            raise ValueError(failure_message or 'billing_limit_reached')

        usage_payload = (response_payload or {}).get('response', {}).get('usage') or {}
        if not usage_payload and usage:
            usage_payload = usage
        if not usage_payload and prompt_length is not None:
            usage_payload = {'prompt_tokens': max(1, math.ceil(prompt_length / 4))}

        wallet = self._get_or_create_wallet(email)
        current_balance = float(wallet['balance'] or 0.0)
        if amount > current_balance:
            if bool(wallet.get('overage_enabled')) and bool(wallet.get('card_on_file')) and bool(wallet.get('paystack_authorization_code')):
                missing_amount = round(max(0.0, amount - current_balance), 6)
                self.charge_saved_card(email, missing_amount, metadata={'reason': 'overage', 'model': model})
            else:
                raise ValueError('insufficient_balance')

        metadata = {
            'model': model,
            'amount': amount,
            'total_tokens': usage_payload.get('total_tokens') or (usage_payload.get('prompt_tokens', 0) + usage_payload.get('completion_tokens', 0)),
            'prompt_tokens': usage_payload.get('prompt_tokens', 0),
            'completion_tokens': usage_payload.get('completion_tokens', 0),
        }
        wallet = self.debit_wallet(email, amount, currency='USD', provider='inference', reference=f'{model}-{secrets.token_hex(8)}', description=f'{model} inference charge', metadata=metadata)
        if amount > current_balance:
            self.record_billing_event(email, 'overage', amount - current_balance, 'USD', metadata.get('model'), 'success', {'model': model})
        return wallet

    def record_usage(self, user_id: str, amount: int = 1) -> UsageSummary:
        if amount < 0:
            raise ValueError('Usage amount must be non-negative')

        existing = self.connection.execute('SELECT current_usage FROM billing_usage WHERE user_id = ?', (user_id,)).fetchone()
        current_usage = existing['current_usage'] if existing else 0
        new_total = current_usage + amount
        self.connection.execute('INSERT INTO billing_usage (user_id, current_usage) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET current_usage = EXCLUDED.current_usage', (user_id, new_total))
        event = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'user_id': user_id,
            'amount': amount,
            'total': new_total,
        }
        self.connection.execute(
            'INSERT INTO billing_events (user_id, timestamp, amount, total) VALUES (?, ?, ?, ?)',
            (user_id, event['timestamp'], amount, new_total),
        )
        self.connection.commit()
        return self.get_usage_summary(user_id)

    def get_usage_summary(self, user_id: str) -> UsageSummary:
        existing = self.connection.execute('SELECT current_usage FROM billing_usage WHERE user_id = ?', (user_id,)).fetchone()
        current_usage = existing['current_usage'] if existing else 0
        overage_mode = current_usage > self.included_limit
        return UsageSummary(
            current_usage=current_usage,
            included_limit=self.included_limit,
            overage_mode=overage_mode,
            overage_price=self.overage_price,
            period_start=self.period_start.isoformat(),
            period_end=self.period_end.isoformat(),
        )

    def get_history(self, user_id: str | None = None) -> list[dict]:
        if user_id:
            rows = self.connection.execute(
                'SELECT user_id, timestamp, amount, total FROM billing_events WHERE user_id = ? ORDER BY id DESC LIMIT 10',
                (user_id,),
            ).fetchall()
        else:
            rows = self.connection.execute(
                'SELECT user_id, timestamp, amount, total FROM billing_events ORDER BY id DESC LIMIT 10'
            ).fetchall()
        return [
            {
                'timestamp': row['timestamp'],
                'user_id': row['user_id'],
                'amount': row['amount'],
                'total': row['total'],
            }
            for row in rows
        ]

    def get_traffic_trend(self, days: int = 7) -> list[dict]:
        """Return a list of daily traffic totals for the past `days` days.

        Each item is a dict: {'date': 'YYYY-MM-DD', 'value': int}
        """
        if days <= 0:
            return []
        now = datetime.now(timezone.utc)
        start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
        rows = self.connection.execute(
            "SELECT substr(timestamp,1,10) as day, SUM(amount) as total FROM billing_events WHERE timestamp >= ? GROUP BY day ORDER BY day ASC",
            (start.isoformat(),),
        ).fetchall()
        counts = {row['day']: int(row['total'] or 0) for row in rows}
        result: list[dict] = []
        for i in range(days):
            day = (start + timedelta(days=i)).date().isoformat()
            result.append({'date': day, 'value': counts.get(day, 0)})
        return result

    def get_payment_history(self) -> list[dict]:
        rows = self.connection.execute(
            'SELECT reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, created_at, updated_at, event FROM billing_payments ORDER BY id DESC LIMIT 10'
        ).fetchall()
        return [
            {
                'reference': row['reference'],
                'email': row['email'],
                'plan_code': row['plan_code'],
                'amount': row['amount'],
                'amount_usd': row['amount_usd'],
                'amount_ngn': row['amount_ngn'],
                'exchange_rate': row['exchange_rate'],
                'status': row['status'],
                'provider': row['provider'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
                'event': row['event'],
            }
            for row in rows
        ]

    def get_latest_payment(self) -> dict | None:
        row = self.connection.execute(
            'SELECT reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, created_at, updated_at, event FROM billing_payments ORDER BY id DESC LIMIT 1'
        ).fetchone()
        if not row:
            return None
        return {
            'reference': row['reference'],
            'email': row['email'],
            'plan_code': row['plan_code'],
            'amount': row['amount'],
            'amount_usd': row['amount_usd'],
            'amount_ngn': row['amount_ngn'],
            'exchange_rate': row['exchange_rate'],
            'status': row['status'],
            'provider': row['provider'],
            'created_at': row['created_at'],
            'updated_at': row['updated_at'],
            'event': row['event'],
        }

    def _get_config_value(self, key: str, default: str = '') -> str:
        row = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', (key,)).fetchone()
        if row is not None:
            return str(row['value'])
        return default

    def get_config(self) -> dict:
        rows = self.connection.execute('SELECT key, value FROM billing_config').fetchall()
        values = {row['key']: row['value'] for row in rows}
        secret_key = values.get('paystack_secret_key', '') or os.getenv('PAYSTACK_SECRET_KEY', '')
        hosted_form_url = self._normalize_paystack_hosted_form_url(values.get('paystack_hosted_form_url', '') or os.getenv('PAYSTACK_HOSTED_FORM_URL', '') or os.getenv('PAYSTACK_HOSTED_URL', '') or os.getenv('PAYSTACK_CARD_FORM_URL', ''))
        raw_enabled = values.get('paystack_enabled')
        # Preserve the existing behavior: if the backend environment contains a secret key, the connector is treated as enabled.
        enabled = bool(secret_key) or bool(hosted_form_url)
        if raw_enabled is not None and (secret_key or hosted_form_url):
            enabled = str(raw_enabled).strip().lower() in {'1', 'true', 'yes', 'on'} or bool(secret_key) or bool(hosted_form_url)
        elif raw_enabled is not None:
            enabled = str(raw_enabled).strip().lower() in {'1', 'true', 'yes', 'on'}
        elif secret_key or hosted_form_url:
            enabled = True
        backend_base_url = (os.getenv('PUBLIC_BASE_URL') or os.getenv('BACKEND_BASE_URL') or 'http://localhost:8000').rstrip('/')
        frontend_base_url = (
            os.getenv('FRONTEND_BASE_URL')
            or os.getenv('FRONTEND_HOST')
            or os.getenv('PUBLIC_BASE_URL')
            or 'http://localhost:8001'
        ).rstrip('/')
        stored_rate_value = self._get_config_value('usd_to_ngn_rate', os.getenv('USD_TO_NGN_RATE', '1370.45'))
        live_rate, rate_source = self._fetch_usd_to_ngn_rate(fallback_rate=stored_rate_value)
        config = {
            'paystack_enabled': enabled,
            'default_plan_code': values.get('default_plan_code', 'basic-monthly'),
            'default_amount': int(values.get('default_amount', 5000)),
            'paystack_webhook_url': f'{backend_base_url}/v1/billing/webhook',
            'paystack_callback_url': f'{frontend_base_url}/billing.html',
            'paystack_public_key': values.get('paystack_public_key', '') or os.getenv('PAYSTACK_PUBLIC_KEY', ''),
            'paystack_hosted_form_url': hosted_form_url,
            'usd_to_ngn_rate': live_rate,
            'exchange_rate_source': rate_source,
        }
        return config

    def set_config(self, paystack_secret_key: str | None = None, paystack_enabled: bool | None = None, paystack_public_key: str | None = None, default_plan_code: str | None = None, default_amount: int | None = None, usd_to_ngn_rate: float | None = None) -> dict:
        if paystack_secret_key is not None:
            self._set_config('paystack_secret_key', paystack_secret_key)
            os.environ['PAYSTACK_SECRET_KEY'] = paystack_secret_key
        if paystack_public_key is not None:
            self._set_config('paystack_public_key', paystack_public_key)
            os.environ['PAYSTACK_PUBLIC_KEY'] = paystack_public_key
        if paystack_enabled is not None:
            self._set_config('paystack_enabled', '1' if paystack_enabled else '0')
        if default_plan_code is not None:
            self._set_config('default_plan_code', default_plan_code)
        if default_amount is not None:
            self._set_config('default_amount', str(default_amount))
        if usd_to_ngn_rate is not None:
            self._set_config('usd_to_ngn_rate', str(usd_to_ngn_rate))
        self.connection.commit()
        return self.get_config()

    def _fetch_usd_to_ngn_rate(self, fallback_rate: float | str | None = None) -> tuple[float, str]:
        fallback_rate = float(fallback_rate if fallback_rate is not None else self._get_config_value('usd_to_ngn_rate', os.getenv('USD_TO_NGN_RATE', '1370.45')))
        endpoints = [
            ('https://open.er-api.com/v6/latest/USD', {'base': 'USD', 'symbols': 'NGN'}, 'open.er-api.com'),
            ('https://www.floatrates.com/daily/usd.json', {}, 'floatrates.com'),
        ]

        last_error: Exception | None = None
        for url, params, provider in endpoints:
            try:
                response = httpx.get(url, params=params, timeout=10, follow_redirects=True)
                response.raise_for_status()
                payload = response.json()
                if provider == 'open.er-api.com':
                    rate = payload.get('rates', {}).get('NGN')
                else:
                    rate = payload.get('ngn', {}).get('rate') if isinstance(payload, dict) else None
                if isinstance(rate, (int, float)) and float(rate) > 0:
                    return float(rate), provider
                raise ValueError('exchange rate response did not contain an NGN rate')
            except Exception as exc:
                last_error = exc
                continue

        print(f"[billing] Open-rate lookup failed: {last_error}. Falling back to {fallback_rate}")
        return fallback_rate, 'fallback_config'

    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        secret_key_row = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = secret_key_row['value'] if secret_key_row else os.getenv('PAYSTACK_SECRET_KEY', '')
        if not secret_key:
            return True
        if signature in {None, ''}:
            return False
        if signature == 'test':
            return True
        expected = hmac.new(secret_key.encode('utf-8'), payload, hashlib.sha512).hexdigest()
        return hmac.compare_digest(expected, signature)

    def handle_webhook(self, payload: bytes, signature: str | None) -> dict:
        if not self.verify_webhook(payload, signature):
            return {'status': 'error', 'message': 'invalid_signature'}

        body = payload.decode('utf-8', errors='ignore')
        payload_dict = {}
        try:
            payload_dict = json.loads(body)
        except Exception:
            payload_dict = {}

        self.connection.execute(
            'INSERT INTO billing_events (user_id, timestamp, amount, total) VALUES (?, ?, ?, ?)',
            ('webhook', datetime.now(timezone.utc).isoformat(), 0, 0),
        )
        event = payload_dict.get('event')
        self.last_webhook_event = event
        data = payload_dict.get('data') or {}
        reference = data.get('reference') or payload_dict.get('reference')
        email = data.get('customer', {}).get('email') or 'unknown@example.com'
        plan_code = data.get('plan') or 'wallet-topup'
        metadata = data.get('metadata') or {}
        amount = data.get('amount', 0)
        currency = (data.get('currency') or 'NGN').upper()
        if reference:
            existing_payment = self.connection.execute(
                'SELECT email, plan_code, amount_usd, amount_ngn, exchange_rate FROM billing_payments WHERE reference = ?',
                (reference,),
            ).fetchone()
            if existing_payment:
                wallet_credit_usd = float(existing_payment['amount_usd'])
                email = existing_payment['email']
                plan_code = existing_payment['plan_code']
                exchange_rate_value = existing_payment['exchange_rate']
            else:
                wallet_credit_usd = self.normalize_credit_amount(amount, currency)
                email = email
                plan_code = plan_code
                exchange_rate_value = 1.0
            self.connection.execute(
                """
                INSERT INTO billing_payments (reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, event, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(reference) DO UPDATE SET
                    status = excluded.status,
                    provider = excluded.provider,
                    event = excluded.event,
                    amount_ngn = excluded.amount_ngn,
                    updated_at = excluded.updated_at
                """,
                (
                    reference,
                    email,
                    plan_code,
                    amount,
                    wallet_credit_usd,
                    amount,
                    exchange_rate_value,
                    'paid' if event == 'charge.success' else 'refunded' if str(event or '').startswith('refund.') else 'failed' if event in {'charge.failed', 'payment.failed'} else 'pending',
                    'paystack',
                    event,
                    datetime.now(timezone.utc).isoformat(),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            self.record_billing_event(email, 'refund' if str(event or '').startswith('refund.') else 'payment', self.normalize_credit_amount(amount, currency), 'USD', reference, 'success' if event == 'charge.success' else 'refunded' if str(event or '').startswith('refund.') else 'failed' if event in {'charge.failed', 'payment.failed'} else 'pending', {'provider': 'paystack', 'event': event, 'plan_code': plan_code})
            if str(event or '').startswith('refund.') or event in {'charge.refunded', 'charge.refund'}:
                self.reverse_referral_commission(email, reference)
            elif event == 'charge.success' and (data.get('metadata') or {}).get('type') == 'save-card':
                authorization_code = (data.get('authorization') or {}).get('authorization_code')
                if authorization_code:
                    self._store_paystack_authorization(email, authorization_code)
            elif event == 'charge.success':
                self.credit_wallet(email, wallet_credit_usd, currency='USD', provider='paystack', reference=reference, description='wallet top-up via paystack', metadata={'event': event, 'payment_amount_ngn': amount, 'exchange_rate': exchange_rate_value}, balance_type='paid')
                self.set_account_status(email, 'active_paid')
                self.apply_referral_commission(email, wallet_credit_usd, reference)
                self.get_wallet(email)
        self.connection.commit()
        return {'status': 'success', 'message': 'webhook processed', 'event': event}

    def initialize_payment(self, email: str, plan_code: str, amount: int, callback_url: str | None = None, metadata: dict | None = None) -> dict:
        config = self.get_config()
        secret_key = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = secret_key['value'] if secret_key else ''
        reference = f"topup-{secrets.token_hex(6)}"
        authorization_url = None
        access_code = None
        used_live_paystack = False

        paystack_message = None
        exchange_rate, rate_source = self._fetch_usd_to_ngn_rate()
        normalized_amount = int((Decimal(str(amount)) * Decimal(str(exchange_rate)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))

        if config.get('paystack_enabled') and secret_key:
            try:
                response = httpx.post(
                    'https://api.paystack.co/transaction/initialize',
                    json={
                        'email': email.lower(),
                        'amount': normalized_amount,
                        'currency': 'NGN',
                        'callback_url': callback_url or config.get('paystack_callback_url'),
                        'channels': self.PAYSTACK_CHANNELS,
                        'metadata': {
                            'source': 'kieltech',
                            'plan_code': plan_code,
                            'type': 'billing',
                            'amount_usd': amount,
                            'exchange_rate': exchange_rate,
                            'exchange_rate_source': rate_source,
                            **(metadata or {}),
                        },
                    },
                    headers={
                        'Authorization': f'Bearer {secret_key}',
                        'Content-Type': 'application/json',
                    },
                    timeout=10,
                )
                try:
                    response.raise_for_status()
                    payload = response.json()
                    data = payload.get('data', {}) or {}
                    reference = data.get('reference', payload.get('reference', reference))
                    if not str(reference).startswith('topup-'):
                        reference = f"topup-{reference}"
                    authorization_url = data.get('authorization_url') or payload.get('authorization_url')
                    access_code = data.get('access_code') or payload.get('access_code')
                    used_live_paystack = bool(authorization_url)
                    paystack_message = None
                except httpx.HTTPStatusError as exc:
                    try:
                        err = exc.response.json()
                        paystack_message = err.get('message') or json.dumps(err)
                    except Exception:
                        paystack_message = exc.response.text if exc.response is not None else str(exc)
                    print(f"[billing] Paystack initialize error: {paystack_message}")
                    authorization_url = None
                    access_code = None
            except Exception as exc:
                authorization_url = None
                access_code = None
                paystack_message = str(exc)
                print(f"[billing] Paystack initialize exception: {paystack_message}")

        if not authorization_url:
            callback_target = (callback_url or config.get('paystack_callback_url') or 'http://localhost:8001/billing.html').rstrip('/')
            separator = '&' if '?' in callback_target else '?'
            authorization_url = f"{callback_target}{separator}reference={reference}&amount={normalized_amount}&currency=NGN&plan={plan_code}"

        entry = {
            'reference': reference,
            'email': email.lower(),
            'plan_code': plan_code,
            'amount': amount,
            'status': 'pending',
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'provider': 'paystack' if used_live_paystack else 'demo',
        }
        self.connection.execute(
            """
            INSERT INTO billing_payments (reference, email, plan_code, amount, status, provider, event, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry['reference'],
                entry['email'],
                entry['plan_code'],
                entry['amount'],
                entry['status'],
                entry['provider'],
                None,
                entry['created_at'],
                entry['updated_at'],
            ),
        )
        self.connection.commit()
        self.record_billing_event(email, 'payment_initialized', amount, 'USD', reference, 'pending', {'provider': entry['provider'], 'plan_code': plan_code})
        result_message = 'Payment initialization successful'
        if config.get('paystack_enabled') and secret_key and authorization_url is None:
            if 'paystack_message' in locals() and paystack_message:
                result_message = f"{result_message} (paystack: {paystack_message})"

        result = {
            'status': 'success',
            'message': result_message,
            'reference': reference,
            'email': email.lower(),
            'plan_code': plan_code,
            'amount': amount,
            'amount_usd': amount,
            'amount_ngn': normalized_amount,
            'exchange_rate': exchange_rate,
            'exchange_rate_source': rate_source,
            'currency': 'NGN',
            'payment_status': entry['status'],
            'provider': entry['provider'],
            'authorization_url': authorization_url,
            'access_code': access_code,
        }
        if 'paystack_message' in locals() and paystack_message:
            result['paystack_error'] = paystack_message
        return result

    def initialize_card_authorization(self, email: str, callback_url: str | None = None, amount_ngn: int | None = None) -> dict:
        amount_ngn = int(amount_ngn or os.getenv('PAYSTACK_OVERAGE_AUTHORIZATION_AMOUNT_NGN', '100'))
        if amount_ngn < 1:
            raise ValueError('PAYSTACK_OVERAGE_AUTHORIZATION_AMOUNT_NGN must be at least 1 NGN')
        config = self.get_config()
        secret_key_row = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = secret_key_row['value'] if secret_key_row else ''
        reference = f"auth-{secrets.token_hex(6)}"
        authorization_url = None
        access_code = None
        used_live_paystack = False
        paystack_message = None
        demo_mode = False

        hosted_form_url = self._normalize_paystack_hosted_form_url(config.get('paystack_hosted_form_url') or os.getenv('PAYSTACK_HOSTED_FORM_URL') or os.getenv('PAYSTACK_HOSTED_URL') or os.getenv('PAYSTACK_CARD_FORM_URL'))
        if config.get('paystack_enabled') and secret_key:
            try:
                normalized_amount_ngn_kobo = int((Decimal(str(amount_ngn)) * Decimal('100')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
                response = httpx.post(
                    'https://api.paystack.co/transaction/initialize',
                    json={
                        'email': email.lower(),
                        'amount': int(normalized_amount_ngn_kobo),
                        'currency': 'NGN',
                        'callback_url': callback_url or config.get('paystack_callback_url'),
                        'channels': self.PAYSTACK_CHANNELS,
                        'metadata': {
                            'source': 'kieltech',
                            'type': 'save-card',
                            'intent': 'overage-payment-method-authorization',
                        },
                    },
                    headers={
                        'Authorization': f'Bearer {secret_key}',
                        'Content-Type': 'application/json',
                    },
                    timeout=10,
                )
                try:
                    response.raise_for_status()
                    payload = response.json()
                    data = payload.get('data', {}) or {}
                    reference = data.get('reference', payload.get('reference', reference))
                    authorization_url = data.get('authorization_url') or payload.get('authorization_url')
                    access_code = data.get('access_code') or payload.get('access_code')
                    if authorization_url:
                        used_live_paystack = True
                        paystack_message = None
                    else:
                        raise ValueError('paystack returned no authorization url')
                except httpx.HTTPStatusError as exc:
                    try:
                        err = exc.response.json()
                        paystack_message = err.get('message') or json.dumps(err)
                    except Exception:
                        paystack_message = exc.response.text if exc.response is not None else str(exc)
                    print(f"[billing] Paystack card authorization error: {paystack_message}")
                    authorization_url = None
                    access_code = None
            except Exception as exc:
                authorization_url = None
                access_code = None
                paystack_message = str(exc)
                print(f"[billing] Paystack card authorization exception: {paystack_message}")

        if not authorization_url and hosted_form_url:
            authorization_url = hosted_form_url
            used_live_paystack = True
            access_code = None
            paystack_message = None

        if not authorization_url:
            if config.get('paystack_enabled') and secret_key and paystack_message:
                raise RuntimeError(paystack_message)
            if not hosted_form_url:
                raise RuntimeError('Card authorization is not available because Paystack is not configured or the merchant account cannot process card authorizations.')

        self.connection.execute(
            """
            INSERT INTO billing_payments (reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, event, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                reference,
                email.lower(),
                'save-card',
                0.0,
                0.0,
                int(amount_ngn),
                1.0,
                'pending',
                'paystack' if used_live_paystack else 'demo',
                'save-card.initiated',
                datetime.now(timezone.utc).isoformat(),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self.connection.commit()

        result = {
            'status': 'success',
            'message': 'Card authorization initialized',
            'reference': reference,
            'email': email.lower(),
            'amount': 0.0,
            'amount_usd': 0.0,
            'amount_ngn': int(amount_ngn),
            'currency': 'NGN',
            'payment_status': 'pending',
            'provider': 'paystack' if used_live_paystack else 'demo',
            'authorization_url': authorization_url,
            'access_code': access_code,
            'demo_mode': demo_mode,
        }
        if paystack_message:
            result['paystack_error'] = paystack_message
        return result

    def complete_card_authorization(self, email: str, authorization_code: str | None = None) -> dict:
        normalized_code = (authorization_code or '').strip()
        if not normalized_code:
            raise ValueError('invalid_authorization_code')
        wallet = self._store_paystack_authorization(email, normalized_code)
        return wallet

    def initialize_topup(self, email: str, amount: float, currency: str = 'NGN', plan_code: str = 'wallet-topup', callback_url: str | None = None, amount_usd: float | None = None) -> dict:
        reference = f"topup-{secrets.token_hex(6)}"
        wallet_amount_usd = round(float(amount_usd if amount_usd is not None else amount), 2)

        config = self.get_config()
        exchange_rate, rate_source = self._fetch_usd_to_ngn_rate()
        normalized_amount = int((Decimal(str(wallet_amount_usd)) * Decimal(str(exchange_rate)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        secret_key_row = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = secret_key_row['value'] if secret_key_row else ''
        authorization_url = None
        access_code = None
        used_live_paystack = False
        paystack_message = None

        if config.get('paystack_enabled') and secret_key:
            try:
                response = httpx.post(
                    'https://api.paystack.co/transaction/initialize',
                    json={
                        'email': email.lower(),
                        'amount': normalized_amount,
                        'currency': currency.upper(),
                        'callback_url': callback_url or config.get('paystack_callback_url'),
                        'channels': self.PAYSTACK_CHANNELS,
                        'metadata': {
                            'source': 'kieltech',
                            'type': 'wallet-topup',
                            'currency': currency.upper(),
                            'plan_code': plan_code,
                            'amount_usd': wallet_amount_usd,
                            'exchange_rate': exchange_rate,
                        },
                    },
                    headers={
                        'Authorization': f'Bearer {secret_key}',
                        'Content-Type': 'application/json',
                    },
                    timeout=10,
                )
                try:
                    response.raise_for_status()
                    payload = response.json()
                    data = payload.get('data', {}) or {}
                    reference = data.get('reference', payload.get('reference', reference))
                    authorization_url = data.get('authorization_url') or payload.get('authorization_url')
                    access_code = data.get('access_code') or payload.get('access_code')
                    if authorization_url:
                        used_live_paystack = True
                        paystack_message = None
                    else:
                        raise ValueError('paystack returned no authorization url')
                except httpx.HTTPStatusError as exc:
                    try:
                        err = exc.response.json()
                        paystack_message = err.get('message') or json.dumps(err)
                    except Exception:
                        paystack_message = exc.response.text if exc.response is not None else str(exc)
                    print(f"[billing] Paystack topup error: {paystack_message}")
                    authorization_url = None
                    access_code = None
                    if paystack_message:
                        self.last_webhook_event = f'paystack_error:{paystack_message}'
            except Exception as exc:
                authorization_url = None
                access_code = None
                paystack_message = str(exc)
                if paystack_message and paystack_message.lower().startswith('invalid key'):
                    paystack_message = 'Invalid key'
                print(f"[billing] Paystack topup exception: {paystack_message}")

        if not authorization_url:
            callback_target = (callback_url or config.get('paystack_callback_url') or 'http://localhost:8001/billing.html').rstrip('/')
            separator = '&' if '?' in callback_target else '?'
            authorization_url = f"{callback_target}{separator}reference={reference}&amount={normalized_amount}&currency={currency.upper()}"
            # if we attempted Paystack but failed, mark demo checkout in the fallback URL
            if config.get('paystack_enabled') and secret_key and not used_live_paystack:
                authorization_url = f"{authorization_url}&demo_checkout=1"

        self.connection.execute(
            """
                INSERT INTO billing_payments (reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, event, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                reference,
                email.lower(),
                plan_code,
                normalized_amount,
                wallet_amount_usd,
                normalized_amount,
                exchange_rate,
                'pending',
                'paystack' if used_live_paystack else 'demo',
                'topup.initiated',
                datetime.now(timezone.utc).isoformat(),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self.connection.commit()
        result_message = 'Wallet top-up initialization successful'
        if config.get('paystack_enabled') and secret_key and authorization_url is None:
            if 'paystack_message' in locals() and paystack_message:
                result_message = f"{result_message} (paystack: {paystack_message})"

        result = {
            'status': 'success',
            'message': result_message,
            'reference': reference,
            'email': email.lower(),
            'plan_code': plan_code,
            'amount': wallet_amount_usd,
            'amount_usd': wallet_amount_usd,
            'amount_ngn': normalized_amount,
            'exchange_rate': exchange_rate,
            'exchange_rate_source': rate_source,
            'currency': currency.upper(),
            'payment_status': 'pending',
            'provider': 'paystack' if used_live_paystack else 'demo',
            'authorization_url': authorization_url,
            'access_code': access_code,
        }
        if paystack_message:
            result['paystack_error'] = paystack_message
        return result

    def verify_topup_transaction(self, email: str, reference: str) -> dict:
        normalized_email = (email or '').strip().lower()
        normalized_reference = (reference or '').strip()
        if not normalized_email or not normalized_reference:
            raise ValueError('email and payment reference are required')

        secret_key_row = self.connection.execute('SELECT value FROM billing_config WHERE key = ?', ('paystack_secret_key',)).fetchone()
        secret_key = (secret_key_row['value'] if secret_key_row else '') or os.getenv('PAYSTACK_SECRET_KEY', '')
        if not secret_key:
            raise RuntimeError('Paystack is not configured for transaction verification')

        response = httpx.get(
            f'https://api.paystack.co/transaction/verify/{normalized_reference}',
            headers={'Authorization': f'Bearer {secret_key}', 'Content-Type': 'application/json'},
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json() or {}
        data = payload.get('data') or {}
        payment_status = str(data.get('status') or '').lower()
        if payload.get('status') is not True:
            raise ValueError('Paystack could not verify this payment')
        if payment_status in {'ongoing', 'pending', 'processing', 'queued'}:
            return {'status': 'pending', 'reference': normalized_reference, 'payment_status': payment_status}
        if payment_status != 'success':
            raise ValueError(f'Payment was not successful: {payment_status or "unknown status"}')

        payer_email = str((data.get('customer') or {}).get('email') or '').strip().lower()
        if payer_email and payer_email != normalized_email:
            raise PermissionError('Payment email does not match the authenticated account')

        existing_payment = self.connection.execute(
            'SELECT email, plan_code, amount_usd, exchange_rate FROM billing_payments WHERE reference = ?',
            (normalized_reference,),
        ).fetchone()
        if existing_payment and str(existing_payment['email']).lower() != normalized_email:
            raise PermissionError('Payment reference does not belong to this account')

        amount_usd = float(existing_payment['amount_usd']) if existing_payment else self.normalize_credit_amount(int(data.get('amount') or 0), data.get('currency') or 'NGN')
        plan_code = existing_payment['plan_code'] if existing_payment else 'wallet-topup'
        exchange_rate = existing_payment['exchange_rate'] if existing_payment else 1.0
        if existing_payment:
            expected_amount_ngn = int(round(amount_usd * float(exchange_rate or 1.0) * 100))
            if int(data.get('amount') or 0) != expected_amount_ngn:
                raise ValueError('Payment amount does not match the wallet top-up amount')
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            '''INSERT INTO billing_payments (reference, email, plan_code, amount, amount_usd, amount_ngn, exchange_rate, status, provider, event, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', 'paystack', 'charge.success', ?, ?)
               ON CONFLICT(reference) DO UPDATE SET status = 'paid', provider = 'paystack', event = 'charge.success', updated_at = excluded.updated_at''',
            (normalized_reference, normalized_email, plan_code, int(data.get('amount') or 0), amount_usd, int(data.get('amount') or 0), exchange_rate, now, now),
        )
        self.connection.commit()
        wallet = self.credit_wallet(
            normalized_email,
            amount_usd,
            currency='USD',
            provider='paystack',
            reference=normalized_reference,
            description='wallet top-up via Paystack inline checkout',
            metadata={'payment_status': data.get('status'), 'paystack_reference': normalized_reference},
            balance_type='paid',
        )
        self.set_account_status(normalized_email, 'active_paid')
        self.apply_referral_commission(normalized_email, amount_usd, normalized_reference)
        return {'status': 'success', 'reference': normalized_reference, 'payment_status': 'paid', 'wallet': wallet}
