import asyncio
import secrets
import sys
from pathlib import Path

import httpx
import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app
from app.routers.api import _chat_model_messages, _load_kiel_chat_context, auth_service, billing_service, service
from app.services.inference import MockModelService


def make_request(method: str, path: str, **kwargs):
    async def _request():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_request())


def test_public_model_catalog_uses_public_availability_labels(monkeypatch):
    from app.routers import api as api_module

    monkeypatch.setattr(api_module, '_get_public_model_catalog_data', lambda: [
        {'model_id': 'ready-model', 'is_ready': True, 'is_configured': True, 'is_active': True},
        {'model_id': 'setup-model', 'is_ready': True, 'is_configured': False, 'is_active': True},
        {'model_id': 'inactive-model', 'is_ready': True, 'is_configured': True, 'is_active': False},
    ])

    response = make_request('get', '/v1/models/catalog')

    assert response.status_code == 200
    models = {model['model_id']: model for model in response.json()['models']}
    assert models['ready-model']['status'] == 'Available'
    assert models['ready-model']['is_available'] is True
    assert models['setup-model']['status'] == 'Unavailable'
    assert models['setup-model']['is_available'] is False
    assert models['inactive-model']['status'] == 'Unavailable'
    assert models['inactive-model']['is_available'] is False


def test_chat_completions_endpoint():
    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Say hello',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['model'] == 'kielmind-lite'
    assert 'text' in payload['response']


def test_chat_retains_only_four_latest_uploaded_images_and_keeps_assistant_images():
    suffix = secrets.token_hex(4)
    email = f'chat-image-{suffix}@example.com'
    user = auth_service.register_user('Chat Image User', email, 'password123')
    token = f'chat-image-token-{suffix}'
    auth_service.create_session_for_user(user['id'], token)
    headers = {'Authorization': f'Bearer {token}'}
    conversation_ids = []
    for index in range(2):
        response = make_request('post', '/v1/chat/conversations', headers=headers, json={'title': f'Image chat {index}'})
        assert response.status_code == 201
        conversation_ids.append(response.json()['id'])

    for index in range(5):
        conversation_id = conversation_ids[index % len(conversation_ids)]
        response = make_request(
            'post',
            f'/v1/chat/conversations/{conversation_id}/messages',
            headers=headers,
            json={
                'role': 'user',
                'content': f'Uploaded image {index}',
                'image': f'data:image/png;base64,aW1hZ2Uw{index}',
                'image_name': f'image-{index}.png',
            },
        )
        assert response.status_code == 201

    assistant_image = '![Generated image](https://example.com/generated.png)'
    response = make_request(
        'post',
        f'/v1/chat/conversations/{conversation_ids[0]}/messages',
        headers=headers,
        json={'role': 'assistant', 'content': assistant_image},
    )
    assert response.status_code == 201

    messages = []
    for conversation_id in conversation_ids:
        response = make_request('get', f'/v1/chat/conversations/{conversation_id}', headers=headers)
        assert response.status_code == 200
        messages.extend(response.json()['messages'])

    retained_uploads = sorted(
        (item for item in messages if item['role'] == 'user' and item['image']),
        key=lambda item: item['id'],
    )
    assert [item['image_name'] for item in retained_uploads] == ['image-1.png', 'image-2.png', 'image-3.png', 'image-4.png']
    assert any(item['role'] == 'assistant' and item['content'] == assistant_image for item in messages)


def test_chat_context_loads_saved_turns_through_boundary_and_restores_images():
    suffix = secrets.token_hex(4)
    email = f'chat-context-{suffix}@example.com'
    user = auth_service.register_user('Chat Context User', email, 'password123')
    token = f'chat-context-token-{suffix}'
    auth_service.create_session_for_user(user['id'], token)
    headers = {'Authorization': f'Bearer {token}'}
    conversation = make_request(
        'post',
        '/v1/chat/conversations',
        headers=headers,
        json={'title': 'Context test'},
    ).json()
    conversation_id = conversation['id']
    for index in range(39):
        billing_service.connection.execute(
            'INSERT INTO kiel_chat_messages (conversation_id, owner_email, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            (conversation_id, email, 'assistant', f'Earlier turn {index}', 'kielmind-lite', f'2026-01-01T00:{index:02d}:00+00:00'),
        )
    billing_service.connection.commit()
    image_data = 'data:image/png;base64,aGVsbG8='
    user_turn = make_request(
        'post',
        f'/v1/chat/conversations/{conversation_id}/messages',
        headers=headers,
        json={'role': 'user', 'content': 'Remember this diagram', 'image': image_data, 'image_name': 'diagram.png'},
    ).json()
    make_request(
        'post',
        f'/v1/chat/conversations/{conversation_id}/messages',
        headers=headers,
        json={'role': 'assistant', 'content': 'It shows a process flow.'},
    )
    final_turn = make_request(
        'post',
        f'/v1/chat/conversations/{conversation_id}/messages',
        headers=headers,
        json={'role': 'user', 'content': 'What did the diagram show?'},
    ).json()

    context = _load_kiel_chat_context(conversation_id, email, final_turn['id'])
    provider_messages = _chat_model_messages(context)

    assert len(provider_messages) == 40
    image_message = next(message for message in provider_messages if isinstance(message['content'], list))
    assert image_message['content'][1]['image_url']['url'] == image_data
    assert _load_kiel_chat_context(conversation_id, email, user_turn['id'])[-1]['id'] == user_turn['id']
    assert _load_kiel_chat_context(conversation_id, 'other@example.com', final_turn['id']) is None


def test_referral_summary_uses_persisted_attributions_and_site_url(monkeypatch):
    auth_service.reset()
    billing_service.reset()
    referrer = auth_service.register_user('Referrer', 'referrer@example.com', 'password123')
    auth_service.register_user('Referred', 'referred@example.com', 'password123')
    referral_code = auth_service.get_user_by_email('referrer@example.com')['referral_code']
    auth_service.connection.execute(
        'INSERT INTO referral_attributions (referrer_email, referred_email, referral_code, reward_amount, created_at) VALUES (?, ?, ?, ?, ?)',
        ('referrer@example.com', 'referred@example.com', referral_code, 2.5, '2026-01-01T00:00:00+00:00'),
    )
    auth_service.connection.commit()
    billing_service.set_wallet_balances('referred@example.com', paid_balance=10.0, account_status='active_paid')
    token = 'referral-test-token'
    auth_service.create_session_for_user(referrer['id'], token)
    monkeypatch.setenv('FRONTEND_URL', 'https://kieltech.app')

    response = make_request('get', '/v1/referrals/me', headers={'Authorization': f'Bearer {token}'})

    assert response.status_code == 200
    payload = response.json()
    assert payload['referral_url'] == f"https://kieltech.app/signup.html?ref={referral_code}"
    assert payload['people_referred'] == 1
    assert payload['active'] == 1
    assert payload['pending'] == 0
    assert payload['credit_earned'] == 2.5


def test_mock_model_service_build_payload_supports_tools():
    service_instance = MockModelService()
    tools = [{
        'type': 'function',
        'function': {
            'name': 'create_file',
            'description': 'Create a file in the workspace',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'content': {'type': 'string'}
                },
                'required': ['path', 'content']
            }
        }
    }]

    payload = service_instance.build_chat_request_payload(
        'Create a file called demo.txt',
        'You are a coding agent.',
        'kielmind-lite',
        temperature=0.4,
        max_tokens=512,
        tools=tools,
        tool_choice='auto',
    )

    assert payload['model'] == 'openai/gpt-4o-mini'
    assert payload['tool_choice'] == 'auto'
    assert payload['tools'][0]['function']['name'] == 'create_file'


def test_extract_tool_calls_handles_openai_style_tool_calls():
    service_instance = MockModelService()
    result = service_instance._extract_tool_calls({
        'tool_calls': [{
            'id': 'call_123',
            'type': 'function',
            'function': {
                'name': 'create_file',
                'arguments': '{"path":"demo.txt","content":"hello"}'
            }
        }]
    })

    assert result[0]['function']['name'] == 'create_file'
    assert result[0]['function']['arguments']['path'] == 'demo.txt'
    assert result[0]['function']['arguments']['content'] == 'hello'


def test_streaming_chat_returns_server_sent_events(monkeypatch):
    async def fake_stream(prompt, system_instructions, model, temperature=0.5, max_tokens=900):
        yield '{"model":"kielmind-lite","choices":[{"delta":{"content":"hello"}}]}'

    monkeypatch.setattr(service, 'stream_chat_completion', fake_stream)
    response = make_request(
        'post',
        '/v1/chat/completions',
        json={'prompt': 'Say hello', 'model': 'kielmind-lite', 'stream': True},
    )

    assert response.status_code == 200
    assert response.headers['content-type'].startswith('text/event-stream')
    assert 'data: ' in response.text
    assert 'data: [DONE]' in response.text


def test_missing_openrouter_key_does_not_silently_use_mock(monkeypatch):
    from app.services.inference import MockModelService

    monkeypatch.delenv('KIELTECH_USE_MOCK', raising=False)
    monkeypatch.setenv('OPENROUTER_API_KEY', '')
    service_instance = MockModelService()

    assert service_instance.use_mock is False
    with pytest.raises(RuntimeError, match='OPENROUTER_API_KEY|OpenRouter API key'):
        asyncio.run(service_instance.generate_chat_completion('hello', 'Be brief', 'kielmind-lite', stream=False))


def test_vision_analysis_endpoint():
    response = make_request(
        'post',
        '/v1/vision/analysis',
        json={
            'prompt': 'Describe this image',
            'image_url': 'https://example.com/demo.png',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['model'] == 'kiel lens'


def test_image_generation_endpoint():
    response = make_request(
        'post',
        '/v1/images/generations',
        json={
            'prompt': 'A futuristic skyline',
            'size': '1024x1024',
            'steps': 20,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'success'


def test_downloads_endpoint_returns_catalog():
    response = make_request('get', '/v1/downloads')
    assert response.status_code == 200
    payload = response.json()
    assert 'downloads' in payload
    assert payload['downloads']


def test_download_file_endpoint_serves_placeholder_installer():
    response = make_request('get', '/downloads/human-language-0.1.8-x64.exe')
    assert response.status_code == 200
    assert response.content


def test_ratings_endpoint_round_trip():
    response = make_request('post', '/v1/ratings', json={'item_id': 1, 'rating': 5})
    assert response.status_code == 200
    payload = response.json()
    assert payload['rating'] == 5

    response = make_request('get', '/v1/ratings')
    assert response.status_code == 200
    payload = response.json()
    assert any(item['item_id'] == 1 for item in payload['ratings'])


def test_wallet_topup_initialization_returns_reference():
    response = make_request(
        'post',
        '/v1/billing/initialize-topup',
        json={
            'email': 'dev@example.com',
            'amount': 2500,
            'currency': 'NGN',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'success'
    assert payload['reference']


def test_webhook_credits_wallet_balance():
    response = make_request(
        'post',
        '/v1/billing/webhook',
        content='{"event":"charge.success","data":{"reference":"wallet-topup-1","customer":{"email":"dev@example.com"},"amount":2500}}',
        headers={'x-paystack-signature': 'test'},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'success'

    wallet = make_request('get', '/v1/billing/wallet?email=dev@example.com')
    assert wallet.status_code == 200
    assert wallet.json()['balance'] >= 25.0


def test_inference_requires_wallet_balance():
    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Need credits',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'no-balance@example.com'},
    )
    assert response.status_code == 402
    payload = response.json()
    assert payload['error'] == 'payment_required'


def test_model_specific_quota_blocks_low_balance_requests():
    billing_service.reset()
    billing_service.credit_wallet('quota@example.com', 0.0001, currency='USD', provider='test', description='seed-wallet')

    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'x' * 6000,
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-pro',
        },
        headers={'X-User-Email': 'quota@example.com'},
    )

    assert response.status_code == 402
    payload = response.json()
    assert payload['error'] == 'payment_required'
    assert 'token quota' in payload['detail'].lower()


def test_overage_opt_in_allows_request_when_balance_is_low():
    billing_service.reset()
    billing_service.set_wallet_balances('overage@example.com', free_credit_balance=0.0, paid_balance=0.0001, account_status='free_tier')
    billing_service.set_overage_policy('overage@example.com', enabled=True)

    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Need overage support',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'overage@example.com'},
    )

    assert response.status_code == 200
    wallet = billing_service.get_wallet('overage@example.com')
    assert wallet['overage_enabled'] is True
    assert wallet['card_on_file'] is True


def test_model_specific_charge_deducts_exact_amount_after_request():
    billing_service.reset()
    billing_service.credit_wallet('metered@example.com', 0.20, currency='USD', provider='test', description='seed-wallet')

    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Explain the billing flow',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'metered@example.com'},
    )

    assert response.status_code == 200
    wallet = billing_service.get_wallet('metered@example.com')
    assert wallet['balance'] < 0.20
    assert wallet['transactions']


def test_signup_verification_grants_free_credit_and_logs_promotion():
    auth_service.reset()
    billing_service.reset()

    signup_response = make_request(
        'post',
        '/v1/auth/signup',
        json={
            'name': 'Free User',
            'email': 'free-tier@example.com',
            'password': 'secret123',
            'phone_number': '+2348010000000',
            'device_fingerprint': 'device-123',
            'ip_address': '203.0.113.5',
        },
    )
    assert signup_response.status_code == 201

    otp = auth_service.get_pending_otp('free-tier@example.com')
    assert otp

    verify_response = make_request(
        'post',
        '/v1/auth/otp/verify',
        json={
            'email': 'free-tier@example.com',
            'otp': otp,
            'device_fingerprint': 'device-123',
            'ip_address': '203.0.113.5',
        },
    )
    assert verify_response.status_code == 200

    wallet = billing_service.get_wallet('free-tier@example.com')
    assert wallet['balance'] == 1.0
    assert any(transaction['description'] == 'Signup Promotion' for transaction in wallet['transactions'])

    wallet_response = make_request('get', '/v1/billing/wallet?email=free-tier@example.com')
    assert wallet_response.json()['free_tier']['claimed'] is True
    assert wallet_response.json()['free_tier']['bonus_balance'] == 1.0


def test_duplicate_device_ip_cannot_claim_free_tier_twice():
    auth_service.reset()
    billing_service.reset()

    first_signup = make_request(
        'post',
        '/v1/auth/signup',
        json={
            'name': 'First User',
            'email': 'first@example.com',
            'password': 'secret123',
            'phone_number': '+2348010000001',
            'device_fingerprint': 'shared-device',
            'ip_address': '203.0.113.10',
        },
    )
    assert first_signup.status_code == 201

    second_signup = make_request(
        'post',
        '/v1/auth/signup',
        json={
            'name': 'Second User',
            'email': 'second@example.com',
            'password': 'secret123',
            'phone_number': '+2348010000002',
            'device_fingerprint': 'shared-device',
            'ip_address': '203.0.113.10',
        },
    )
    assert second_signup.status_code == 409
    assert 'device' in second_signup.json()['detail'].lower() or 'ip' in second_signup.json()['detail'].lower()


def test_free_tier_requests_are_rate_limited():
    auth_service.reset()
    billing_service.reset()

    signup_response = make_request(
        'post',
        '/v1/auth/signup',
        json={
            'name': 'Rate Limited',
            'email': 'rate-limit@example.com',
            'password': 'secret123',
            'phone_number': '+2348010000003',
            'device_fingerprint': 'rate-device',
            'ip_address': '203.0.113.15',
        },
    )
    assert signup_response.status_code == 201

    otp = auth_service.get_pending_otp('rate-limit@example.com')
    verify_response = make_request(
        'post',
        '/v1/auth/otp/verify',
        json={'email': 'rate-limit@example.com', 'otp': otp},
    )
    assert verify_response.status_code == 200

    for _ in range(5):
        response = make_request(
            'post',
            '/v1/chat/completions',
            json={
                'prompt': 'test',
                'system_instructions': 'Be concise',
                'stream': False,
                'model': 'kielmind-lite',
            },
            headers={'X-User-Email': 'rate-limit@example.com'},
        )
        assert response.status_code in {200, 402}

    blocked_response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'test',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'rate-limit@example.com'},
    )
    assert blocked_response.status_code == 429


def test_balance_based_tier_sets_dynamic_rate_limit_headers():
    billing_service.reset()
    billing_service.set_wallet_balances('tiered@example.com', free_credit_balance=0.0, paid_balance=250.0, account_status='active_paid')

    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'Hello tiered user',
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'tiered@example.com'},
    )

    assert response.status_code == 200
    assert response.headers['X-RateLimit-Limit'] == '300'
    assert response.headers['X-RateLimit-Remaining'] == '299'
    assert int(response.headers['X-RateLimit-Reset']) >= 0


def test_dual_balance_waterfall_and_webhook_upgrade():
    billing_service.reset()

    billing_service.set_wallet_balances('dual@example.com', free_credit_balance=0.004, paid_balance=0.008, account_status='free_tier')

    response = make_request(
        'post',
        '/v1/chat/completions',
        json={
            'prompt': 'x' * 6000,
            'system_instructions': 'Be concise',
            'stream': False,
            'model': 'kielmind-lite',
        },
        headers={'X-User-Email': 'dual@example.com'},
    )
    assert response.status_code == 200

    wallet = billing_service.get_wallet('dual@example.com')
    assert wallet['free_credit_balance'] < 0.004
    assert wallet['paid_balance'] < 0.008
    assert wallet['balance'] < 0.012

    webhook_response = make_request(
        'post',
        '/v1/billing/webhook',
        content='{"event":"charge.success","data":{"reference":"wallet-topup-2","customer":{"email":"dual@example.com"},"amount":2500}}',
        headers={'x-paystack-signature': 'test'},
    )
    assert webhook_response.status_code == 200

    upgraded_wallet = billing_service.get_wallet('dual@example.com')
    assert upgraded_wallet['account_status'] == 'active_paid'
    assert upgraded_wallet['paid_balance'] >= 25.00045


def test_admin_can_edit_and_remove_managed_models():
    suffix = secrets.token_hex(4)
    email = f'model-removal-{suffix}@example.com'
    auth_service.register_user('Model Admin', email, 'password123')
    auth_service.set_user_admin(email, True)
    token = auth_service.login_user(email, 'password123')['token']
    headers = {'Authorization': f'Bearer {token}'}
    model_id = f'test-removable-{suffix}'
    billing_service.create_managed_model({
        'model_id': model_id,
        'display_name': 'Removable Test Model',
        'provider_model': 'test/removable-model',
        'category': 'text-generation',
        'input_price': 0.1,
        'cache_price': 0.0,
        'output_price': 0.2,
        'max_context': 4096,
        'modalities': ['text-generation'],
    })

    public_before = make_request('get', '/v1/models/catalog')
    assert any(model['model_id'] == model_id for model in public_before.json()['models'])
    assert make_request('delete', f'/v1/admin/models/{model_id}').status_code == 401
    assert make_request('delete', '/v1/admin/models/kielforge-fast').status_code == 401
    assert make_request('post', f'/v1/admin/models/{model_id}/restore').status_code == 401
    assert make_request('delete', f'/v1/admin/models/{model_id}/permanent').status_code == 401
    availability_path = f'/v1/admin/models/{model_id}/chat-availability'
    assert make_request('put', availability_path, json={
        'is_chat_available': True,
        'chat_capability': 'Test ability',
    }).status_code == 401

    assigned = make_request('put', availability_path, headers=headers, json={
        'is_chat_available': True,
        'chat_capability': 'High reasoning',
    })
    assert assigned.status_code == 200
    assigned_model = next(
        model for model in make_request('get', '/v1/models/catalog').json()['models']
        if model['model_id'] == model_id
    )
    assert assigned_model['is_chat_available'] is True
    assert assigned_model['chat_capability'] == 'High reasoning'

    updated = make_request('put', f'/v1/admin/models/{model_id}', headers=headers, json={
        'model_id': model_id,
        'display_name': 'Updated Test Model',
        'provider_model': 'test/updated-model',
        'category': 'text-generation',
        'input_price': 0.3,
        'cache_price': 0.0,
        'output_price': 0.4,
        'max_context': 8192,
        'modalities': [],
    })
    assert updated.status_code == 200
    updated_public = make_request('get', '/v1/models/catalog').json()['models']
    updated_model = next(model for model in updated_public if model['model_id'] == model_id)
    assert updated_model['display_name'] == 'Updated Test Model'
    assert updated_model['input_price'] == 0.3
    assert updated_model['max_context'] == 8192
    admin_after_update = make_request('get', '/v1/admin/models', headers=headers).json()['models']
    updated_admin_model = next(model for model in admin_after_update if model['model_id'] == model_id)
    assert updated_admin_model['provider_model'] == 'test/updated-model'

    removed = make_request('delete', f'/v1/admin/models/{model_id}', headers=headers)
    assert removed.status_code == 200
    assert removed.json()['removed'] is True
    public_after = make_request('get', '/v1/models/catalog')
    assert all(model['model_id'] != model_id for model in public_after.json()['models'])
    admin_models = make_request('get', '/v1/admin/models', headers=headers)
    stored_model = next(model for model in admin_models.json()['models'] if model['model_id'] == model_id)
    assert stored_model['is_active'] is False

    restored = make_request('post', f'/v1/admin/models/{model_id}/restore', headers=headers)
    assert restored.status_code == 200
    assert restored.json()['restored'] is True
    public_restored = make_request('get', '/v1/models/catalog').json()['models']
    assert any(model['model_id'] == model_id for model in public_restored)
    restored_admin_models = make_request('get', '/v1/admin/models', headers=headers).json()['models']
    restored_model = next(model for model in restored_admin_models if model['model_id'] == model_id)
    assert restored_model['is_active'] is True
    assert restored_model['is_chat_available'] is True
    assert restored_model['chat_capability'] == 'High reasoning'

    removed_again = make_request('delete', f'/v1/admin/models/{model_id}', headers=headers)
    assert removed_again.status_code == 200
    permanent = make_request('delete', f'/v1/admin/models/{model_id}/permanent', headers=headers)
    assert permanent.status_code == 200
    assert permanent.json()['permanently_deleted'] is True
    assert all(model['model_id'] != model_id for model in make_request('get', '/v1/models/catalog').json()['models'])
    remaining_admin_models = make_request('get', '/v1/admin/models', headers=headers).json()['models']
    assert all(model['model_id'] != model_id for model in remaining_admin_models)
    reused = make_request('post', '/v1/admin/models', headers=headers, json={
        'model_id': model_id,
        'display_name': 'Reused Test Model',
        'provider_model': 'test/reused-model',
        'category': 'text-generation',
        'input_price': 0.2,
        'cache_price': 0.0,
        'output_price': 0.3,
        'max_context': 8192,
        'modalities': [],
    })
    assert reused.status_code == 201
    reused_model = next(
        model for model in make_request('get', '/v1/models/catalog').json()['models']
        if model['model_id'] == model_id
    )
    assert reused_model['display_name'] == 'Reused Test Model'


def test_admin_can_edit_and_remove_builtin_models_and_catalog_updates_immediately():
    suffix = secrets.token_hex(4)
    email = f'builtin-model-admin-{suffix}@example.com'
    auth_service.register_user('Built-in Model Admin', email, 'password123')
    auth_service.set_user_admin(email, True)
    token = auth_service.login_user(email, 'password123')['token']
    headers = {'Authorization': f'Bearer {token}'}
    model_id = 'kielforge-fast'
    original_row = billing_service.connection.execute(
        'SELECT display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, created_by, created_at, is_active FROM managed_models WHERE model_id = ?',
        (model_id,),
    ).fetchone()
    if not original_row:
        billing_service.create_managed_model({
            'model_id': model_id,
            'display_name': 'KielForge-Fast',
            'provider_model': model_id,
            'category': 'image-generation',
            'input_price': 0.01,
            'cache_price': 0.0,
            'output_price': 0.01,
            'max_context': 65536,
            'modalities': [],
        }, created_by='catalog-builtin')
        original_row = billing_service.connection.execute(
            'SELECT display_name, provider_model, category, input_price, cache_price, output_price, max_context, modalities, created_by, created_at, is_active FROM managed_models WHERE model_id = ?',
            (model_id,),
        ).fetchone()

    original = dict(original_row)
    billing_service.connection.execute(
        'UPDATE managed_models SET is_active = TRUE WHERE model_id = ?',
        (model_id,),
    )
    billing_service.connection.commit()
    try:
        before = make_request('get', '/v1/models/catalog').json()['models']
        assert any(model['model_id'] == model_id for model in before)
        update_payload = {
            'model_id': model_id,
            'display_name': 'KielForge-Fast Edited',
            'provider_model': original['provider_model'] or model_id,
            'category': original['category'],
            'input_price': 0.025,
            'cache_price': original['cache_price'],
            'output_price': 0.025,
            'max_context': original['max_context'],
            'modalities': [],
        }
        updated = make_request('put', f'/v1/admin/models/{model_id}', headers=headers, json=update_payload)
        assert updated.status_code == 200
        changed = make_request('get', '/v1/models/catalog').json()['models']
        changed_model = next(model for model in changed if model['model_id'] == model_id)
        assert changed_model['display_name'] == 'KielForge-Fast Edited'
        assert changed_model['input_price'] == 0.025

        removed = make_request('delete', f'/v1/admin/models/{model_id}', headers=headers)
        assert removed.status_code == 200
        after_removal = make_request('get', '/v1/models/catalog').json()['models']
        assert all(model['model_id'] != model_id for model in after_removal)
    finally:
        billing_service.connection.execute(
            '''UPDATE managed_models
               SET display_name = ?, provider_model = ?, category = ?, input_price = ?, cache_price = ?,
                   output_price = ?, max_context = ?, modalities = ?, created_by = ?, created_at = ?, is_active = ?
               WHERE model_id = ?''',
            (
                original['display_name'], original['provider_model'], original['category'],
                original['input_price'], original['cache_price'], original['output_price'],
                original['max_context'], original['modalities'], original['created_by'],
                original['created_at'], original['is_active'], model_id,
            ),
        )
        billing_service.connection.commit()


def test_admin_chat_template_can_be_removed_and_republished():
    suffix = secrets.token_hex(4)
    email = f'template-publish-{suffix}@example.com'
    auth_service.register_user('Template Admin', email, 'password123')
    auth_service.set_user_admin(email, True)
    token = auth_service.login_user(email, 'password123')['token']
    headers = {'Authorization': f'Bearer {token}'}

    created = make_request('post', '/v1/admin/chat/templates', headers=headers, json={
        'title': f'Republish test {suffix}',
        'description': 'Template lifecycle test',
        'category': 'General',
        'model': 'kielmind-lite',
        'prompt': 'A test prompt',
    })
    assert created.status_code == 201
    template_id = created.json()['id']

    removed = make_request('delete', f'/v1/admin/chat/templates/{template_id}', headers=headers)
    assert removed.status_code == 200
    public_after_remove = make_request('get', '/v1/chat/templates')
    assert all(item['id'] != template_id for item in public_after_remove.json()['templates'])

    restored = make_request('post', f'/v1/admin/chat/templates/{template_id}/restore', headers=headers)
    assert restored.status_code == 200
    public_after_restore = make_request('get', '/v1/chat/templates')
    assert any(item['id'] == template_id for item in public_after_restore.json()['templates'])
