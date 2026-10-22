import uuid

from fastapi.testclient import TestClient
from app.main import app
from app.routers.api import auth_service, billing_service
from app.services.auth import AuthService, TokenService, mask_token
from app.services.billing import BillingService


def test_auth_users_and_sessions_survive_service_restart():
    email = f'persistent-{uuid.uuid4().hex}@example.com'
    first = AuthService()
    first.register_user('Persistent User', email, 'secret')
    logged_in = first.login_user(email, 'secret')

    second = AuthService()
    assert second.get_user_by_email(email)['name'] == 'Persistent User'
    assert second.get_user_from_token(logged_in['token'])['email'] == email
    first.close()
    second.close()


def test_api_key_owner_and_last_use_survive_service_restart():
    owner_email = f'owner-{uuid.uuid4().hex}@example.com'
    first = TokenService()
    created = first.create_token(f'production-key-{uuid.uuid4().hex}', owner_email)
    authenticated = first.authenticate(created['token'])

    second = TokenService()
    assert second.authenticate(created['token'])['owner_email'] == owner_email
    assert second.list_tokens('other@example.com') == []
    assert authenticated['last_used_at'] is not None
    first.close()
    second.close()


def test_api_key_masks_use_bullets_and_repair_legacy_encoding():
    owner_email = f'mask-{uuid.uuid4().hex}@example.com'
    first = TokenService()
    created = first.create_token(f'masked-key-{uuid.uuid4().hex}', owner_email)
    expected_mask = f"kt-{'•' * 8}{created['token'][-4:]}"
    assert created['masked'] == expected_mask

    legacy_bullets = '\u00e2\u20ac\u00a2' * 8
    legacy_mask = f"kt-{legacy_bullets}{created['token'][-4:]}"
    first.connection.execute(
        'UPDATE api_tokens SET masked = ? WHERE id = ?',
        (legacy_mask, created['id']),
    )
    first.connection.commit()

    second = TokenService()
    listed = next(item for item in second.list_tokens(owner_email) if item['id'] == created['id'])
    assert listed['masked'] == expected_mask
    first.close()
    second.close()


def test_usage_page_filters_and_security_events_are_persistent():
    billing = BillingService()
    billing.record_api_usage('owner@example.com', 'key-1', '/v1/chat/completions', 'kielmind-lite', 200, '2026-08-26T01:00:00+00:00', '2026-08-26T01:00:01+00:00', total_tokens=10, cost_usd=0.1)
    billing.record_api_usage('owner@example.com', 'key-1', '/v1/chat/completions', 'kielmind-pro', 200, '2026-08-26T02:00:00+00:00', '2026-08-26T02:00:01+00:00', total_tokens=20, cost_usd=0.2)
    page = billing.get_api_usage_page('owner@example.com', model='kielmind-pro', page=1, page_size=1)
    assert page['total'] == 1
    assert page['items'][0]['total_tokens'] == 20

    billing.record_security_event('request_rejected', endpoint='/v1/chat/completions', status_code=401)
    restarted = BillingService()
    assert restarted.get_security_events(10)[0]['event'] == 'request_rejected'
    billing.close()
    restarted.close()


def test_admin_requires_admin_bearer_session_not_shared_secret(monkeypatch):
    monkeypatch.setenv('ADMIN_SECRET_KEY', 'legacy-secret')
    auth_service.reset()
    billing_service.reset()
    auth_service.register_user('Regular User', 'regular@example.com', 'secret')
    regular_token = auth_service.login_user('regular@example.com', 'secret')['token']
    client = TestClient(app)

    assert client.get('/admin/dashboard-data', headers={'X-Admin-Secret': 'legacy-secret'}).status_code == 401
    assert client.get('/admin/dashboard-data', headers={'Authorization': f'Bearer {regular_token}'}).status_code == 401

    auth_service.set_user_admin('regular@example.com', True)
    admin_token = auth_service.login_user('regular@example.com', 'secret')['token']
    assert client.get('/admin/dashboard-data', headers={'Authorization': f'Bearer {admin_token}'}).status_code == 200
