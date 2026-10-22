import json
import os
import uuid
from unittest.mock import patch

import pytest

from fastapi.testclient import TestClient

from app.main import app
from app.routers import api as api_module


class DummyResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode('utf-8')


def test_firebase_token_verification_requires_project_service_account() -> None:
    with patch.dict(os.environ, {'FIREBASE_SERVICE_ACCOUNT_JSON': ''}, clear=False):
        with pytest.raises(api_module.FirebaseAuthConfigurationError, match='FIREBASE_SERVICE_ACCOUNT_JSON'):
            api_module._verify_firebase_google_token('test-id-token')


def test_google_login_redirects_to_google_authorize() -> None:
    client = TestClient(app)
    with patch.dict(os.environ, {'GOOGLE_CLIENT_ID': 'test-client-id', 'GOOGLE_REDIRECT_URI': 'http://127.0.0.1:8000/v1/auth/google/callback'}, clear=False):
        response = client.get('/v1/auth/google/login', follow_redirects=False)

    assert response.status_code == 307
    location = response.headers['location']
    assert 'accounts.google.com/o/oauth2/v2/auth' in location
    assert 'client_id=test-client-id' in location


def test_google_callback_creates_a_user_session() -> None:
    client = TestClient(app)
    responses = [
        DummyResponse({'access_token': 'abc123', 'token_type': 'Bearer'}),
        DummyResponse({'email': 'google-user@example.com', 'name': 'Google User', 'picture': 'https://example.com/avatar.png', 'id': 'google-123'}),
    ]

    with patch.dict(os.environ, {'GOOGLE_CLIENT_ID': 'test-client-id', 'GOOGLE_CLIENT_SECRET': 'test-client-secret', 'GOOGLE_REDIRECT_URI': 'http://127.0.0.1:8000/v1/auth/google/callback'}, clear=False), \
         patch('app.routers.api.urlopen', side_effect=responses):
        response = client.get('/v1/auth/google/callback?code=test-code&state=test-state', follow_redirects=False)

    assert response.status_code == 200
    assert 'google-auth' in response.text
    assert 'Google User' in response.text


def test_google_callback_reports_google_error_details() -> None:
    client = TestClient(app)

    with patch.dict(os.environ, {'GOOGLE_CLIENT_ID': 'test-client-id', 'GOOGLE_CLIENT_SECRET': 'test-client-secret', 'GOOGLE_REDIRECT_URI': 'http://127.0.0.1:8000/v1/auth/google/callback'}, clear=False):
        response = client.get('/v1/auth/google/callback?error=access_denied&error_description=User+denied+access', follow_redirects=False)

    assert response.status_code == 400
    assert 'google_auth_failed' in response.text
    assert 'User denied access' in response.text


def test_firebase_google_sign_in_creates_kieltech_session() -> None:
    client = TestClient(app)
    claims = {
        'email': 'firebase-user@example.com',
        'email_verified': True,
        'name': 'Firebase User',
        'uid': 'firebase-uid-123',
        'firebase': {'sign_in_provider': 'google.com'},
    }
    user = {
        'id': 'user-123',
        'name': 'Firebase User',
        'email': 'firebase-user@example.com',
        'is_admin': False,
        'is_enterprise_dedicated': False,
        'created_at': '2026-01-01T00:00:00+00:00',
    }

    with patch.object(api_module, '_verify_firebase_google_token', return_value=claims), \
         patch.object(api_module, 'get_firebase_role', return_value='user'), \
         patch.object(api_module.auth_service, 'get_or_create_google_user', return_value=user) as get_user, \
         patch.object(api_module.auth_service, 'create_session_for_user') as create_session:
        response = client.post('/v1/auth/firebase/google', json={'id_token': 'firebase-id-token'})

    assert response.status_code == 200
    assert response.json()['user']['email'] == 'firebase-user@example.com'
    assert response.json()['admin_role_status'] == 'verified'
    assert response.json()['token'].startswith('kt-google-')
    assert response.cookies.get('kieltech_session') == response.json()['token']
    get_user.assert_called_once_with('Firebase User', 'firebase-user@example.com', 'firebase-uid-123')
    create_session.assert_called_once_with('user-123', response.json()['token'])


def test_google_only_account_gets_password_sign_in_guidance_and_can_set_password() -> None:
    email = f'google-password-{uuid.uuid4().hex}@example.com'
    user = api_module.auth_service.get_or_create_google_user('Google User', email, f'firebase-{uuid.uuid4().hex}')

    assert user['password_auth_enabled'] is False
    with pytest.raises(ValueError, match='^PASSWORD_SIGN_IN_UNAVAILABLE::'):
        api_module.auth_service.login_user(email, 'any-password')

    api_module.auth_service.update_credentials(email, password='new-password-123')
    assert api_module.auth_service.get_user_by_email(email)['password_auth_enabled'] is True
    assert api_module.auth_service.login_user(user['username'], 'new-password-123')['user']['email'] == email


def test_password_login_endpoint_returns_provider_specific_guidance(monkeypatch) -> None:
    def reject_password_login(*_):
        raise ValueError(
            "PASSWORD_SIGN_IN_UNAVAILABLE::This account doesn't support password sign-in. "
            'Sign in with Google instead, or set up a password in Settings once you are logged in.'
        )

    monkeypatch.setattr(api_module.auth_service, 'login_user', reject_password_login)
    response = TestClient(app).post(
        '/v1/auth/login',
        json={'identifier': 'google-user@example.com', 'password': 'any-password'},
    )

    assert response.status_code == 403
    assert response.json() == {
        'error': 'password_sign_in_unavailable',
        'detail': "This account doesn't support password sign-in. Sign in with Google instead, or set up a password in Settings once you are logged in.",
    }


def test_firebase_google_sign_in_remains_available_when_role_store_is_down() -> None:
    claims = {
        'email': 'firebase-user@example.com',
        'email_verified': True,
        'name': 'Firebase User',
        'uid': 'firebase-uid-123',
        'firebase': {'sign_in_provider': 'google.com'},
    }
    user = {
        'id': 'user-123',
        'name': 'Firebase User',
        'email': 'firebase-user@example.com',
        'is_admin': False,
        'is_enterprise_dedicated': False,
        'created_at': '2026-01-01T00:00:00+00:00',
    }

    with patch.object(api_module, '_verify_firebase_google_token', return_value=claims), \
         patch.object(api_module, 'get_firebase_role', side_effect=api_module.FirebaseRoleResolutionError('Firestore is unavailable')), \
         patch.object(api_module.auth_service, 'get_or_create_google_user', return_value=user), \
         patch.object(api_module.auth_service, 'create_session_for_user'):
        response = TestClient(app).post('/v1/auth/firebase/google', json={'id_token': 'firebase-id-token'})

    assert response.status_code == 200
    assert response.json()['user']['is_admin'] is False
    assert response.json()['admin_role_status'] == 'unavailable'


def test_firebase_google_sign_in_rejects_invalid_id_token() -> None:
    client = TestClient(app)
    with patch.object(
        api_module,
        '_verify_firebase_google_token',
        side_effect=api_module.FirebaseAuthTokenError('Google sign-in token is invalid or expired.'),
    ):
        response = client.post('/v1/auth/firebase/google', json={'id_token': 'invalid-token'})

    assert response.status_code == 401
    assert response.json()['error'] == 'invalid_firebase_token'


def test_firebase_google_sign_in_reports_missing_admin_credentials() -> None:
    client = TestClient(app)
    with patch.object(
        api_module,
        '_verify_firebase_google_token',
        side_effect=api_module.FirebaseAuthConfigurationError('Firebase Admin credentials are unavailable.'),
    ):
        response = client.post('/v1/auth/firebase/google', json={'id_token': 'firebase-id-token'})

    assert response.status_code == 503
    assert response.json()['error'] == 'firebase_auth_unavailable'


def test_current_user_reports_firestore_role_without_exposing_firebase_uid(monkeypatch) -> None:
    monkeypatch.setattr(
        api_module.auth_service,
        'get_user_from_token',
        lambda token: {
            'id': 'user-123',
            'name': 'Firebase User',
            'email': 'firebase-user@example.com',
            'firebase_uid': 'firebase-uid-123',
            'is_admin': False,
        },
    )
    monkeypatch.setattr(api_module, 'get_firebase_role', lambda uid: 'owner' if uid == 'firebase-uid-123' else 'user')

    response = TestClient(app).get('/v1/auth/me', headers={'Authorization': 'Bearer valid-session'})

    assert response.status_code == 200
    assert response.json()['user']['is_admin'] is True
    assert response.json()['user']['is_owner'] is True
    assert response.json()['user']['role'] == 'owner'
    assert response.json()['admin_role_status'] == 'verified'
    assert 'firebase_uid' not in response.json()['user']
