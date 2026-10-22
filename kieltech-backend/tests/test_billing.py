import asyncio
import hashlib
import hmac
import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app, should_bypass_rate_limit
from app.routers.api import auth_service, billing_service
from app.schemas import ManagedModelCreateRequest
from app.services.billing import BillingService


def test_managed_multimodal_model_type_label_is_normalized_and_persisted():
    payload = ManagedModelCreateRequest(
        display_name='Omni Vision',
        model_id='omni-vision',
        category='multimodal',
        type_label='  Text, Vision  ',
        modalities=['text-generation', 'image-understanding'],
    )
    assert payload.type_label == 'Text, Vision'

    service = BillingService()
    service.reset()
    created = service.create_managed_model(payload.model_dump())
    assert created['type_label'] == 'Text, Vision'

    listed = next(model for model in service.list_managed_models() if model['model_id'] == 'omni-vision')
    assert listed['type_label'] == 'Text, Vision'

    updated_payload = payload.model_dump() | {'type_label': 'Text and Vision'}
    assert service.update_managed_model('omni-vision', updated_payload)
    updated = next(model for model in service.list_managed_models() if model['model_id'] == 'omni-vision')
    assert updated['type_label'] == 'Text and Vision'


def test_model_rate_matrix_uses_new_public_pricing():
    service = BillingService()
    service.reset()

    assert service.MODEL_RATE_MATRIX['kielmind-lite'] == 6.99
    assert service.MODEL_RATE_MATRIX['kielmind-pro'] == 7.99
    assert service.MODEL_RATE_MATRIX['kiellens-ocr'] == 7.49
    assert service.MODEL_RATE_MATRIX['kiellens-chat'] == 8.49
    assert service.MODEL_RATE_MATRIX['kielforge-fast'] == 0.010
    assert service.MODEL_RATE_MATRIX['kielforge-hd'] == 0.015


def make_request(method: str, path: str, **kwargs):
    async def _request():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_request())


def test_referral_commission_is_one_time_and_refund_preserves_other_free_credit():
    auth_service.reset()
    billing_service.reset()
    referrer = auth_service.register_user('Referrer', 'referrer@example.com', 'password123')
    auth_service.register_user('Referred', 'referred@example.com', 'password123')
    referral_code = auth_service.get_user_by_email('referrer@example.com')['referral_code']
    auth_service.connection.execute(
        'INSERT INTO referral_attributions (referrer_email, referred_email, referral_code, created_at) VALUES (?, ?, ?, ?)',
        ('referrer@example.com', 'referred@example.com', referral_code, '2026-01-01T00:00:00+00:00'),
    )
    auth_service.connection.commit()
    billing_service.set_wallet_balances('referrer@example.com', free_credit_balance=3.0)

    assert billing_service.apply_referral_commission('referred@example.com', 10.0, 'topup-first') == 0.5
    assert billing_service.apply_referral_commission('referred@example.com', 20.0, 'topup-second') == 0.0
    wallet = billing_service.get_wallet('referrer@example.com')
    assert wallet['free_credit_balance'] == 3.0
    assert wallet['referral_credit_balance'] == 0.5

    assert billing_service.reverse_referral_commission('referred@example.com', 'topup-first') == 0.5
    wallet = billing_service.get_wallet('referrer@example.com')
    assert wallet['free_credit_balance'] == 3.0
    assert wallet['referral_credit_balance'] == 0.0


def test_billing_service_tracks_overage_mode():
    service = BillingService()
    service.reset()
    summary = service.get_usage_summary('user-1')

    assert summary['current_usage'] == 0
    assert summary['overage_mode'] is False

    service.record_usage('user-1', 1000)
    summary = service.get_usage_summary('user-1')
    assert summary['current_usage'] == 1000
    assert summary['overage_mode'] is False

    service.record_usage('user-1', 1)
    summary = service.get_usage_summary('user-1')
    assert summary['current_usage'] == 1001
    assert summary['overage_mode'] is True


def test_billing_service_loads_paystack_keys_from_backend_env(monkeypatch):
    monkeypatch.delenv('PAYSTACK_SECRET_KEY', raising=False)
    monkeypatch.delenv('PAYSTACK_PUBLIC_KEY', raising=False)

    service = BillingService()
    service.reset()
    config = service.get_config()

    assert config['paystack_enabled'] is True
    assert config['paystack_public_key']


def test_initialize_payment_returns_paystack_reference():
    response = make_request(
        'post',
        '/v1/billing/initialize',
        json={
            'email': 'dev@example.com',
            'plan_code': 'basic-monthly',
            'amount': 5000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'success'
    assert payload['reference'].startswith('topup-')


def test_webhook_handler_accepts_valid_signature(monkeypatch):
    monkeypatch.setenv('PAYSTACK_SECRET_KEY', 'sk_test_secret')
    billing_service.reset()
    payload = json.dumps({'event': 'charge.success', 'data': {}}).encode('utf-8')
    signature = hmac.new(b'sk_test_secret', payload, hashlib.sha512).hexdigest()

    response = make_request(
        'post',
        '/v1/billing/webhook',
        content=payload,
        headers={'x-paystack-signature': signature, 'content-type': 'application/json'},
    )

    assert response.status_code == 200
    assert response.json()['status'] == 'success'
    assert billing_service.last_webhook_event == 'charge.success'


def test_webhook_stores_saved_card_authorization(monkeypatch):
    monkeypatch.setenv('PAYSTACK_SECRET_KEY', 'sk_test_secret')
    billing_service.reset()
    payload = json.dumps({
        'event': 'charge.success',
        'data': {
            'reference': 'save-card-ref',
            'customer': {'email': 'savecard@example.com'},
            'authorization': {'authorization_code': 'AUTH_CODE_123'},
            'metadata': {'type': 'save-card'},
        },
    }).encode('utf-8')
    signature = hmac.new(b'sk_test_secret', payload, hashlib.sha512).hexdigest()

    response = make_request(
        'post',
        '/v1/billing/webhook',
        content=payload,
        headers={'x-paystack-signature': signature, 'content-type': 'application/json'},
    )

    assert response.status_code == 200
    assert response.json()['status'] == 'success'
    wallet = billing_service._get_or_create_wallet('savecard@example.com')
    assert wallet['paystack_authorization_code'] == 'AUTH_CODE_123'


def test_initialize_payment_returns_authorization_url_from_paystack(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-xyz789',
                'access_code': 'access-code-123',
                'authorization_url': 'https://checkout.paystack.com/paystack-xyz789',
            },
        })

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_payment('dev@example.com', 'basic-monthly', 5000)

    assert result['authorization_url'] == 'https://checkout.paystack.com/paystack-xyz789'
    assert result['access_code'] == 'access-code-123'


def test_initialize_card_authorization_returns_paystack_authorization_url(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-auth-123',
                'access_code': 'access-auth-456',
                'authorization_url': 'https://checkout.paystack.com/save-card-123',
            },
        })

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_card_authorization('dev@example.com', callback_url='http://localhost/billing.html')

    assert result['authorization_url'] == 'https://checkout.paystack.com/save-card-123'
    assert result['access_code'] == 'access-auth-456'
    assert result['provider'] == 'paystack'


def test_initialize_card_authorization_sends_amount_in_kobo_to_paystack(monkeypatch):
    captured = {}

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        captured['kwargs'] = kwargs
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-auth-124',
                'access_code': 'access-auth-457',
                'authorization_url': 'https://checkout.paystack.com/save-card-124',
            },
        })

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    billing_service.initialize_card_authorization('dev@example.com', callback_url='http://localhost/billing.html')

    assert captured['kwargs']['json']['amount'] == 10000
    assert captured['kwargs']['json']['currency'] == 'NGN'


def test_initialize_card_authorization_prefers_direct_paystack_flow_over_hosted_form_url(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-auth-125',
                'access_code': 'access-auth-458',
                'authorization_url': 'https://checkout.paystack.com/save-card-125',
            },
        })

    monkeypatch.setenv('PAYSTACK_HOSTED_FORM_URL', 'https://checkout.paystack.com/live-card-form')
    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_card_authorization('dev@example.com', callback_url='http://localhost/billing.html')

    assert result['authorization_url'] == 'https://checkout.paystack.com/save-card-125'
    assert result['provider'] == 'paystack'


def test_initialize_card_authorization_uses_configured_hosted_form_url(monkeypatch):
    monkeypatch.setenv('PAYSTACK_HOSTED_FORM_URL', 'https://checkout.paystack.com/live-card-form')

    def fake_post(*args, **kwargs):
        raise RuntimeError('Paystack unavailable')

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_card_authorization('dev@example.com', callback_url='http://localhost/billing.html')

    assert result['authorization_url'] == 'https://checkout.paystack.com/live-card-form'
    assert result['provider'] == 'paystack'


def test_initialize_card_authorization_raises_when_paystack_is_unavailable(monkeypatch):
    monkeypatch.delenv('PAYSTACK_HOSTED_FORM_URL', raising=False)
    monkeypatch.delenv('PAYSTACK_HOSTED_URL', raising=False)
    monkeypatch.delenv('PAYSTACK_CARD_FORM_URL', raising=False)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='', paystack_enabled=False)

    try:
        billing_service.initialize_card_authorization('dev@example.com', callback_url='http://localhost/billing.html')
    except RuntimeError as exc:
        assert 'Paystack' in str(exc)
    else:
        raise AssertionError('Expected RuntimeError when Paystack is unavailable')


def test_save_card_endpoint_marks_card_on_file_with_card_details():
    billing_service.reset()
    response = make_request(
        'post',
        '/v1/billing/save-card',
        json={
            'email': 'demo@example.com',
            'cardholder_name': 'Ada Lovelace',
            'card_number': '4111111111111111',
            'expiry_month': '12',
            'expiry_year': '2030',
            'cvc': '123',
        },
    )

    assert response.status_code == 200
    wallet = billing_service._get_or_create_wallet('demo@example.com')
    assert wallet['card_on_file'] == 1
    assert wallet['card_last4'] == '1111'
    assert wallet['card_brand'] == 'visa'


def test_save_card_complete_endpoint_marks_card_on_file():
    billing_service.reset()
    response = make_request(
        'post',
        '/v1/billing/save-card/complete',
        json={'email': 'demo@example.com', 'authorization_code': 'AUTH_DEMO_123'},
    )

    assert response.status_code == 200
    wallet = billing_service._get_or_create_wallet('demo@example.com')
    assert wallet['card_on_file'] == 1
    assert wallet['paystack_authorization_code'] == 'AUTH_DEMO_123'


def test_initialize_topup_uses_saved_card_when_available():
    billing_service.reset()
    billing_service.save_card_on_file('demo@example.com', card_number='4111111111111111')

    result = billing_service.initialize_topup('demo@example.com', 25, currency='USD', plan_code='wallet-topup')

    assert result['status'] == 'success'
    assert result['provider'] == 'saved-card'
    wallet = billing_service.get_wallet('demo@example.com')
    assert wallet['paid_balance'] == 25.0


def test_initialize_topup_sends_callback_and_metadata_to_paystack(monkeypatch):
    captured = {}

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        captured['args'] = args
        captured['kwargs'] = kwargs
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-topup-123',
                'access_code': 'access-code-topup',
                'authorization_url': 'https://checkout.paystack.com/topup',
            },
        })

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

        @property
        def text(self):
            return self._payload.get('text', '')

    def fake_get(*args, **kwargs):
        return FakeResponse({'text': '... data-value="1500.5" ...'})

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert result['authorization_url'] == 'https://checkout.paystack.com/topup'
    payload = captured['kwargs']['json']
    assert payload['email'] == 'dev@example.com'
    assert payload['amount'] == 20556750
    assert payload['currency'] == 'NGN'
    assert 'plan' not in payload
    assert 'callback_url' in payload
    assert payload['metadata']['source'] == 'kieltech'
    assert payload['metadata']['amount_usd'] == 150
    assert payload['metadata']['exchange_rate'] == 1370.45


def test_initialize_topup_enables_requested_paystack_channels(monkeypatch):
    captured = {}

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        captured['kwargs'] = kwargs
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-card-only',
                'access_code': 'access-code-card-only',
                'authorization_url': 'https://checkout.paystack.com/card-only',
            },
        })

    def fake_get(*args, **kwargs):
        return FakeResponse({'text': '... data-value="1500.5" ...'})

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert captured['kwargs']['json']['channels'] == ['bank', 'card', 'ussd', 'apple_pay', 'bank_transfer', 'payattitude']


def test_initialize_topup_falls_back_to_demo_when_paystack_rejects_the_key(monkeypatch):
    def fake_post(*args, **kwargs):
        response = httpx.Response(
            401,
            request=httpx.Request('POST', 'https://api.paystack.co/transaction/initialize'),
            json={'message': 'Invalid key'},
        )
        raise httpx.HTTPStatusError('invalid key', request=response.request, response=response)

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True)

    result = billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert result['provider'] == 'demo'
    assert result['authorization_url'] is not None
    assert 'demo_checkout=1' in result['authorization_url']
    assert result['paystack_error'] == 'Invalid key'


def test_initialize_topup_returns_production_callback_url_when_paystack_is_unconfigured():
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='', paystack_enabled=False)

    result = billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert result['status'] == 'success'
    assert result['provider'] == 'demo'
    assert result['authorization_url'] is not None
    assert 'demo_checkout' not in result['authorization_url']
    assert 'billing.html' in result['authorization_url']


def test_initialize_topup_falls_back_to_config_rate_when_exchange_rate_fetch_fails(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(*args, **kwargs):
        raise RuntimeError('rate service unavailable')

    def fake_post(*args, **kwargs):
        return FakeResponse({
            'status': True,
            'message': 'Authorization URL created',
            'data': {
                'reference': 'paystack-topup-456',
                'access_code': 'access-code-topup-456',
                'authorization_url': 'https://checkout.paystack.com/topup-456',
            },
        })

    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)
    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='sk_test_secret', paystack_enabled=True, usd_to_ngn_rate=1350.0)

    result = billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert result['authorization_url'] == 'https://checkout.paystack.com/topup-456'
    assert result['exchange_rate'] == 1350.0
    assert result['amount_ngn'] == 20250000
    assert result['amount_usd'] == 150


def test_usage_charge_uses_final_price_per_million_units():
    billing_service.reset()

    assert billing_service.estimate_charge('kielmind-lite', usage={'total_tokens': 1_000_000}) == 6.99
    assert billing_service.estimate_charge('kielmind-pro', usage={'total_tokens': 100_000}) == 0.799
    assert billing_service.estimate_charge('kielforge-hd', usage={'images': 1}) == 0.015


def test_fetch_usd_to_ngn_rate_uses_open_exchange_rate_api(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(*args, **kwargs):
        return FakeResponse({'rates': {'NGN': 1600.5}})

    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)

    service = BillingService()
    service.reset()

    rate, provider = service._fetch_usd_to_ngn_rate()
    assert rate == 1600.5
    assert provider == 'open.er-api.com'


def test_initialize_topup_reports_exchange_rate_source(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(*args, **kwargs):
        return FakeResponse({'rates': {'NGN': 1600.5}})

    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)

    billing_service.reset()
    result = billing_service.initialize_topup('dev@example.com', 150, currency='NGN', plan_code='wallet-topup')

    assert result['exchange_rate_source'] == 'open.er-api.com'


def test_chat_request_records_usage():
    billing_service.reset()
    billing_service.credit_wallet('wallet-user@example.com', 10.0, currency='USD', provider='test', reference='test-topup', description='Test top up')
    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Hello',
            'model': 'kielmind-lite',
            'stream': False,
        },
        headers={'x-user-email': 'wallet-user@example.com'},
    )

    assert response.status_code == 200
    usage = make_request('get', '/v1/billing/usage', headers={'x-user-email': 'wallet-user@example.com'})
    payload = usage.json()
    assert payload['current_usage'] >= 1


def test_dashboard_model_usage_is_scoped_and_aggregated():
    auth_service.reset()
    billing_service.reset()
    signup = make_request(
        'post',
        '/v1/auth/signup',
        json={'name': 'Usage User', 'email': 'dashboard-usage@example.com', 'password': 'secret123'},
    )
    assert signup.status_code == 201
    login = make_request(
        'post',
        '/v1/auth/login',
        json={'email': 'dashboard-usage@example.com', 'password': 'secret123'},
    )
    assert login.status_code == 200
    token = login.json()['token']
    now = datetime.now(timezone.utc).isoformat()
    billing_service.record_api_usage(
        'dashboard-usage@example.com', 'private-key-id', '/v1/chat/completions',
        'custom-chat-model', 200, now, now, 12, 8, 20, cost_usd=0.004,
    )
    billing_service.record_api_usage(
        'dashboard-usage@example.com', None, '/v1/vision/analysis',
        'custom-chat-model', 500, now, now, 5, 0, 5, cost_usd=0.001,
    )
    billing_service.record_api_usage(
        'dashboard-usage@example.com', None, '/v1/chat/completions',
        'custom-chat-model', 429, '2020-01-01T00:00:00+00:00', '2020-01-01T00:00:00+00:00',
    )
    billing_service.record_api_usage(
        'other-user@example.com', None, '/v1/chat/completions',
        'other-model', 200, now, now, 10, 10, 20, cost_usd=0.002,
    )
    billing_service.record_api_usage(
        'other-user@example.com', None, '/v1/chat/completions',
        'other-model', 500, '2020-01-01T00:00:00+00:00', '2020-01-01T00:00:00+00:00',
    )

    response = make_request(
        'get',
        '/v1/dashboard/model-usage?days=7',
        headers={'Authorization': f'Bearer {token}'},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['totals'] == {
        'requests': 2,
        'successful_requests': 1,
        'failed_requests': 1,
        'total_tokens': 25,
        'cost_usd': 0.005,
    }
    assert payload['all_time_failed_requests'] == 2
    assert payload['models'][0]['model_id'] == 'custom-chat-model'
    assert payload['models'][0]['requests'] == 2
    assert all('api_key_id' not in item for item in payload['recent'])
    assert all(item['model_id'] != 'other-model' for item in payload['models'])


def test_config_endpoint_exposes_paystack_public_key(monkeypatch):
    monkeypatch.setenv('PAYSTACK_PUBLIC_KEY', 'pk_live_test_public')
    billing_service.reset()

    response = make_request('get', '/v1/billing/config')

    assert response.status_code == 200
    assert response.json()['paystack_public_key'] == 'pk_live_test_public'


def test_config_endpoint_uses_live_exchange_rate_instead_of_stored_value(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(*args, **kwargs):
        return FakeResponse({'rates': {'NGN': 1600.5}})

    monkeypatch.setattr('app.services.billing.httpx.get', fake_get)
    billing_service.reset()
    billing_service.set_config(usd_to_ngn_rate=1000.0)

    response = make_request('get', '/v1/billing/config')

    assert response.status_code == 200
    assert response.json()['usd_to_ngn_rate'] == 1600.5


def test_billing_service_loads_paystack_keys_from_env_file(tmp_path, monkeypatch):
    env_file = tmp_path / '.env'
    env_file.write_text('PAYSTACK_SECRET_KEY=sk_from_env\nPAYSTACK_PUBLIC_KEY=pk_from_env\n', encoding='utf-8')
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv('PAYSTACK_SECRET_KEY', raising=False)
    monkeypatch.delenv('PAYSTACK_PUBLIC_KEY', raising=False)

    service = BillingService()
    service.reset()

    config = service.get_config()

    assert config['paystack_enabled'] is True
    assert config['paystack_public_key'] == 'pk_from_env'


def test_config_endpoint_persists_paystack_settings():
    response = make_request(
        'post',
        '/v1/billing/config',
        json={
            'paystack_secret_key': 'sk_test_secret_123',
            'paystack_enabled': True,
            'default_plan_code': 'basic-monthly',
            'default_amount': 5000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['paystack_enabled'] is True
    assert payload['default_plan_code'] == 'basic-monthly'

    config_response = make_request('get', '/v1/billing/config')
    config_payload = config_response.json()
    assert config_payload['paystack_enabled'] is True
    assert config_payload['default_plan_code'] == 'basic-monthly'
    assert config_payload['default_amount'] == 5000
    assert config_payload['paystack_public_key'] == '' or isinstance(config_payload['paystack_public_key'], str)
    assert config_payload['paystack_webhook_url'].endswith('/v1/billing/webhook')
    assert config_payload['paystack_callback_url'].endswith('/billing.html')


def test_config_endpoint_persists_paystack_public_key():
    response = make_request(
        'post',
        '/v1/billing/config',
        json={
            'paystack_secret_key': 'sk_test_secret_123',
            'paystack_public_key': 'pk_test_public_123',
            'default_plan_code': 'basic-monthly',
            'default_amount': 5000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['paystack_public_key'] == 'pk_test_public_123'

    config_response = make_request('get', '/v1/billing/config')
    config_payload = config_response.json()
    assert config_payload['paystack_public_key'] == 'pk_test_public_123'


def test_history_endpoint_lists_recent_billing_activity():
    billing_service.reset()
    init_response = make_request(
        'post',
        '/v1/billing/initialize',
        json={
            'email': 'history@example.com',
            'plan_code': 'basic-monthly',
            'amount': 5000,
        },
    )

    assert init_response.status_code == 200
    history_response = make_request('get', '/v1/billing/history')
    payload = history_response.json()
    assert payload['items']
    assert payload['items'][0]['status'] in {'pending', 'paid', 'failed'}


def test_webhook_rejects_invalid_signature(monkeypatch):
    monkeypatch.setenv('PAYSTACK_SECRET_KEY', 'sk_test_secret')
    billing_service.reset()
    payload = json.dumps({'event': 'charge.success', 'data': {'reference': 'bad-signature', 'customer': {'email': 'dev@example.com'}, 'amount': 2500}}).encode('utf-8')

    response = make_request(
        'post',
        '/v1/billing/webhook',
        content=payload,
        headers={'x-paystack-signature': 'not-the-right-signature', 'content-type': 'application/json'},
    )

    assert response.status_code == 400
    assert response.json()['message'] == 'invalid_signature'


def test_wallet_exposes_balance_tier_and_rate_limit():
    billing_service.reset()
    billing_service.set_wallet_balances('tier@example.com', free_credit_balance=0.0, paid_balance=250.0, account_status='active_paid')

    wallet = billing_service.get_wallet('tier@example.com')

    assert wallet['tier']['name'] == 'Pro'
    assert wallet['rate_limit'] == 300


def test_wallet_equivalency_exposes_all_dashboard_models():
    billing_service.reset()
    billing_service.set_wallet_balances('dashboard@example.com', free_credit_balance=0.0, paid_balance=10.0, account_status='active_paid')

    wallet = billing_service.get_wallet('dashboard@example.com')

    expected_models = {
        'kielmind-lite': 'tokens',
        'kielmind-pro': 'tokens',
        'kiellens-ocr': 'requests',
        'kiellens-chat': 'requests',
        'kielforge-fast': 'generations',
        'kielforge-hd': 'generations',
    }

    assert set(wallet['equivalency'].keys()) == set(expected_models)
    for model_key, expected_label in expected_models.items():
        assert wallet['equivalency'][model_key]['label'] == expected_label


def test_webhook_assigns_high_balance_tier_after_topup():
    billing_service.reset()
    billing_service.set_config(paystack_secret_key='', paystack_enabled=False)
    payment = billing_service.initialize_topup('tier@example.com', 600, currency='NGN', plan_code='wallet-topup')
    payload = json.dumps({'event': 'charge.success', 'data': {'reference': payment['reference'], 'customer': {'email': 'tier@example.com'}, 'amount': payment['amount_ngn'], 'currency': 'NGN'}}).encode('utf-8')

    response = make_request(
        'post',
        '/v1/billing/webhook',
        content=payload,
        headers={'x-paystack-signature': 'test', 'content-type': 'application/json'},
    )

    assert response.status_code == 200
    wallet = billing_service.get_wallet('tier@example.com')
    assert wallet['tier']['name'] == 'Elite'
    assert wallet['rate_limit'] == 1000


def test_enterprise_flag_bypasses_public_rate_limits():
    billing_service.reset()
    auth_service.reset()
    auth_service.register_user('Enterprise User', 'enterprise@example.com', 'secret123')

    user = auth_service.get_user_by_email('enterprise@example.com')
    user['is_enterprise_dedicated'] = True
    billing_service.set_wallet_balances('enterprise@example.com', free_credit_balance=0.0, paid_balance=5000.0, account_status='active_paid', is_enterprise_dedicated=True)

    wallet = billing_service.get_wallet('enterprise@example.com')
    assert wallet['is_enterprise_dedicated'] is True
    assert should_bypass_rate_limit(user, wallet) is True


def test_public_ultra_tier_caps_at_five_thousand_rpm():
    billing_service.reset()
    wallet = billing_service.set_wallet_balances('public@example.com', free_credit_balance=0.0, paid_balance=2000.0, account_status='active_paid')

    assert wallet['tier']['name'] == 'Ultra'
    assert wallet['rate_limit'] == 5000


def test_enterprise_passkey_redemption_enables_dedicated_access():
    billing_service.reset()
    auth_service.reset()

    auth_service.register_user('Enterprise User', 'passkey@example.com', 'secret123')
    login_response = make_request(
        'post',
        '/v1/auth/login',
        json={'email': 'passkey@example.com', 'password': 'secret123'},
    )
    assert login_response.status_code == 200
    token = login_response.json()['token']

    billing_service.create_enterprise_key('enterprise-passkey-1')

    response = make_request(
        'post',
        '/api/billing/redeem-passkey',
        headers={'Authorization': f'Bearer {token}'},
        json={'passkey': 'enterprise-passkey-1'},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['message'] == 'Enterprise passkey redeemed'

    wallet = billing_service.get_wallet('passkey@example.com')
    assert wallet['is_enterprise_dedicated'] is True

    user = auth_service.get_user_by_email('passkey@example.com')
    assert user['is_enterprise_dedicated'] is True


def test_enterprise_key_is_opaque_bound_to_requester_and_redeemable_once(monkeypatch):
    monkeypatch.setenv('ENTERPRISE_PASSKEY_SECRET', 'enterprise-test-signing-secret')
    billing_service.reset()
    auth_service.reset()

    auth_service.register_user('Enterprise Admin', 'enterprise-admin@example.com', 'secret123')
    auth_service.set_user_admin('enterprise-admin@example.com', True)
    auth_service.register_user('Requested User', 'requested@example.com', 'secret123')
    auth_service.register_user('Other User', 'other@example.com', 'secret123')
    admin_token = auth_service.login_user('enterprise-admin@example.com', 'secret123')['token']
    other_token = auth_service.login_user('other@example.com', 'secret123')['token']
    requested_token = auth_service.login_user('requested@example.com', 'secret123')['token']

    generated_response = make_request(
        'post',
        '/admin/enterprise/keys',
        headers={'Authorization': f'Bearer {admin_token}'},
        json={
            'client_email': 'requested@example.com',
            'duration_days': 30,
            'rpm_limit': 120,
            'model_ids': ['kielmind-lite'],
        },
    )
    assert generated_response.status_code == 201
    generated = generated_response.json()
    passkey = generated['passkey']
    assert 'requested@example.com' not in passkey
    activation_expiry = datetime.fromisoformat(generated['activation_expires_at'])
    assert 29 <= (activation_expiry - datetime.now(timezone.utc)).days <= 30
    stored_key = billing_service.connection.execute(
        'SELECT key, client_email, expires_at, metadata FROM enterprise_keys WHERE key = ?',
        (billing_service._hash_key(passkey),),
    ).fetchone()
    assert stored_key['key'] == billing_service._hash_key(passkey)
    assert stored_key['client_email'] == 'requested@example.com'
    assert datetime.fromisoformat(stored_key['expires_at']) == activation_expiry
    assert json.loads(stored_key['metadata'])['duration_days'] == 30

    sent_messages = []

    def fake_send_email(recipient, subject, body, html_body=None):
        sent_messages.append((recipient, subject, body, html_body))
        return True

    monkeypatch.setattr(billing_service, '_send_email_notification', fake_send_email)
    email_response = make_request(
        'post',
        '/admin/enterprise/keys/send',
        headers={'Authorization': f'Bearer {admin_token}'},
        json={'passkey': passkey, 'client_email': 'requested@example.com'},
    )
    assert email_response.status_code == 200
    assert sent_messages[0][0] == 'requested@example.com'
    assert passkey in sent_messages[0][2]
    assert '30 days after creation' in sent_messages[0][2]
    assert 'single-use' in sent_messages[0][2]

    rejected_response = make_request(
        'post',
        '/api/billing/redeem-passkey',
        headers={'Authorization': f'Bearer {other_token}'},
        json={'passkey': passkey},
    )
    assert rejected_response.status_code == 400
    assert rejected_response.json()['detail'] == 'This passkey was issued to a different account'
    assert billing_service.list_enterprise_keys()[0]['status'] == 'available'

    redeemed_response = make_request(
        'post',
        '/api/billing/redeem-passkey',
        headers={'Authorization': f'Bearer {requested_token}'},
        json={'passkey': passkey},
    )
    assert redeemed_response.status_code == 200
    assert redeemed_response.json()['enterprise_model_ids'] == ['kielmind-lite']
    assert billing_service.list_enterprise_keys()[0]['status'] == 'redeemed'


def test_admin_validation_endpoint_accepts_matching_secret(monkeypatch):
    monkeypatch.setenv('ADMIN_SECRET_KEY', 'test-admin-secret')

    valid_response = make_request('post', '/admin/validate-secret', json={'secret': 'test-admin-secret'})
    assert valid_response.status_code == 200
    assert valid_response.json()['valid'] is True

    invalid_response = make_request('post', '/admin/validate-secret', json={'secret': 'wrong-secret'})
    assert invalid_response.status_code == 401
    assert invalid_response.json()['valid'] is False


def test_admin_portal_requires_valid_secret_and_generates_passkey(monkeypatch):
    monkeypatch.setenv('ADMIN_SECRET_KEY', 'test-admin-secret')

    portal_response = make_request('get', '/admin/dashboard')
    assert portal_response.status_code == 200
    assert 'Enterprise Console' in portal_response.text

    unauthorized_response = make_request('post', '/admin/generate-key', json={'client_email': 'client@example.com'})
    assert unauthorized_response.status_code == 401

    generated_response = make_request(
        'post',
        '/admin/generate-key',
        headers={'X-Admin-Secret': 'test-admin-secret'},
        json={'client_email': 'client@example.com'},
    )

    assert generated_response.status_code == 200
    payload = generated_response.json()
    assert payload['message'] == 'Enterprise passkey generated'
    assert payload['passkey'].startswith('KIEL-ENT-')


def test_admin_passkey_generation_and_redemption_support_gpu_provisioning(monkeypatch):
    monkeypatch.setenv('ADMIN_SECRET_KEY', 'test-admin-secret')
    monkeypatch.setenv('RUNPOD_API_KEY', 'test-runpod-key')
    billing_service.reset()
    auth_service.reset()
    auth_service.register_user('GPU User', 'gpu@example.com', 'secret123')

    calls = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeResponse({'id': 'pod-123', 'status': 'RUNNING', 'proxy_url': 'https://proxy.example.com'})

    monkeypatch.setattr('app.services.billing.httpx.post', fake_post)

    generated_response = make_request(
        'post',
        '/admin/generate-key',
        headers={'X-Admin-Secret': 'test-admin-secret'},
        json={'client_email': 'gpu@example.com', 'duration_days': 45, 'rpm_limit': 12000, 'gpu_model': 'NVIDIA A100-SXM4-80GB', 'runpod_template_id': 'tmpl-123'},
    )

    assert generated_response.status_code == 200
    payload = generated_response.json()
    assert payload['gpu_model'] == 'NVIDIA A100-SXM4-80GB'
    assert payload['runpod_template_id'] == 'tmpl-123'

    login_response = make_request('post', '/v1/auth/login', json={'email': 'gpu@example.com', 'password': 'secret123'})
    assert login_response.status_code == 200

    redeem_response = make_request(
        'post',
        '/api/billing/redeem-passkey',
        headers={'Authorization': f"Bearer {login_response.json()['token']}"},
        json={'passkey': payload['passkey']},
    )

    assert redeem_response.status_code == 200
    user = auth_service.get_user_by_email('gpu@example.com')
    assert user['is_enterprise_dedicated'] is True
    assert user['enterprise_rpm_limit'] == 12000
    assert user['gpu_model'] == 'NVIDIA A100-SXM4-80GB'
    assert user['runpod_proxy_url'] == 'https://proxy.example.com'
    assert len(calls) == 1


def test_mock_runpod_provisioning_activates_enterprise_access_without_live_template(monkeypatch):
    monkeypatch.setenv('ADMIN_SECRET_KEY', 'test-admin-secret')
    monkeypatch.setenv('RUNPOD_MOCK_MODE', '1')
    billing_service.reset()
    auth_service.reset()
    auth_service.register_user('Mock GPU User', 'mock-gpu@example.com', 'secret123')

    generated_response = make_request(
        'post',
        '/admin/generate-key',
        headers={'X-Admin-Secret': 'test-admin-secret'},
        json={'client_email': 'mock-gpu@example.com', 'duration_days': 14, 'rpm_limit': 7500, 'gpu_model': 'NVIDIA A100-SXM4-80GB'},
    )

    assert generated_response.status_code == 200
    payload = generated_response.json()

    login_response = make_request('post', '/v1/auth/login', json={'email': 'mock-gpu@example.com', 'password': 'secret123'})
    assert login_response.status_code == 200

    redeem_response = make_request(
        'post',
        '/api/billing/redeem-passkey',
        headers={'Authorization': f"Bearer {login_response.json()['token']}"},
        json={'passkey': payload['passkey']},
    )

    assert redeem_response.status_code == 200
    body = redeem_response.json()
    assert body['message'] == 'Enterprise passkey redeemed'
    assert body['runpod_proxy_url'] == 'https://api.runpod.ai/v2/mock-test-pod-8000/chat'

    wallet = billing_service.get_wallet('mock-gpu@example.com')
    assert wallet['is_enterprise_dedicated'] is True

    user = auth_service.get_user_by_email('mock-gpu@example.com')
    assert user['is_enterprise_dedicated'] is True
    assert user['enterprise_rpm_limit'] == 7500
    assert user['enterprise_expires_at']
    assert user['runpod_proxy_url'] == 'https://api.runpod.ai/v2/mock-test-pod-8000/chat'


def test_auth_login_and_me_endpoints():
    signup_response = make_request(
        'post',
        '/v1/auth/signup',
        json={'name': 'Demo User', 'email': 'demo-auth@example.com', 'password': 'secret123'},
    )
    assert signup_response.status_code == 201

    login_response = make_request(
        'post',
        '/v1/auth/login',
        json={'email': 'demo-auth@example.com', 'password': 'secret123'},
    )
    assert login_response.status_code == 200
    token = login_response.json()['token']

    me_response = make_request('get', '/v1/auth/me', headers={'Authorization': f'Bearer {token}'})
    assert me_response.status_code == 200
    assert me_response.json()['user']['email'] == 'demo-auth@example.com'


def test_login_email_verification_send_does_not_block_api_event_loop(monkeypatch):
    auth_service.reset()
    billing_service.reset()
    auth_service.register_user('Unverified User', 'unverified-login@example.com', 'secret123')
    sent_from_threads = []

    def send_verification_email(*args, **kwargs):
        sent_from_threads.append(threading.current_thread())
        return True

    monkeypatch.setattr(billing_service, '_send_email_notification', send_verification_email)

    response = make_request(
        'post',
        '/v1/auth/login',
        json={'email': 'unverified-login@example.com', 'password': 'secret123'},
    )

    assert response.status_code == 403
    assert response.json()['error'] == 'verification_required'
    assert sent_from_threads
    assert sent_from_threads[0] is not threading.main_thread()
