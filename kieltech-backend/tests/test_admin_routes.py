from fastapi.testclient import TestClient

from app import main as main_module
from app.services import firebase_roles
from app.main import app
from app.routers import api as api_module


def test_ready_model_catalog_contains_requested_ready_models() -> None:
    catalog = {model['model_id']: model for model in api_module._READY_MODEL_CATALOG}

    assert {'kiel-3-cyber', 'kiel-3-omni'} <= catalog.keys()
    assert not {'kiel-3-terra', 'kiel-3-astra', 'kiel-3-luna', 'kiel-3.1-cyber'} & catalog.keys()
    assert catalog['kiel-2-vqa']['type_label'] == 'Vision'
    assert catalog['kiel-2.1-omni']['type_label'] == 'Text, Vision and Image'
    assert catalog['kiel-3-omni']['type_label'] == 'Text, Vision, Image, Voice'


def test_customer_funds_source_labels_distinguish_paid_and_free_credit() -> None:
    assert main_module._wallet_transaction_source_label({
        'kind': 'credit',
        'provider': 'admin',
        'metadata': {'balance_type': 'free_credit'},
    }) == 'Free credit'
    assert main_module._wallet_transaction_source_label({
        'kind': 'credit',
        'provider': 'paystack',
        'metadata': {'balance_type': 'paid'},
    }) == 'Paid'


def test_admin_free_credit_bulk_grant_targets_only_matching_active_audience(monkeypatch) -> None:
    users = [
        {'email': 'enterprise@example.com', 'is_enterprise_dedicated': True, 'is_admin': False, 'is_blocked': False},
        {'email': 'customer@example.com', 'is_enterprise_dedicated': False, 'is_admin': False, 'is_blocked': False},
        {'email': 'blocked@example.com', 'is_enterprise_dedicated': True, 'is_admin': False, 'is_blocked': True},
        {'email': 'admin@example.com', 'is_enterprise_dedicated': True, 'is_admin': True, 'is_blocked': False},
    ]
    granted = []
    monkeypatch.setattr(main_module, 'is_admin_authenticated', lambda request: True)
    monkeypatch.setattr(main_module.auth_service, 'list_users', lambda: users)
    emails = []
    monkeypatch.setattr(main_module.billing_service, '_send_email_notification', lambda email, subject, body, html_body=None: emails.append((email, subject, body, html_body)) or True)

    def credit_wallet(email, amount, **options):
        granted.append((email, amount, options))
        return {'free_credit_balance': amount, 'balance': amount}

    monkeypatch.setattr(main_module.billing_service, 'credit_wallet', credit_wallet)
    response = TestClient(app).post('/admin/free-credit', json={
        'audience': 'enterprise',
        'amount': 12.5,
        'reason': 'Launch promotion',
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload['recipient_count'] == 1
    assert payload['granted_count'] == 1
    assert payload['failed_count'] == 0
    assert [grant[0] for grant in granted] == ['enterprise@example.com']
    assert granted[0][1] == 12.5
    assert granted[0][2]['balance_type'] == 'free_credit'
    assert granted[0][2]['metadata']['reason'] == 'Launch promotion'
    assert len(emails) == 1
    assert emails[0][0] == 'enterprise@example.com'
    assert '12.50 USD' in emails[0][2]
    assert 'Launch promotion' in emails[0][2]
    assert response.json()['notification_failed_count'] == 0


def test_admin_free_credit_single_grant_can_target_admin_account(monkeypatch) -> None:
    users = [
        {'email': 'owner@example.com', 'is_enterprise_dedicated': True, 'is_admin': True, 'is_blocked': False},
        {'email': 'customer@example.com', 'is_enterprise_dedicated': False, 'is_admin': False, 'is_blocked': False},
    ]
    granted = []
    monkeypatch.setattr(main_module, 'is_admin_authenticated', lambda request: True)
    monkeypatch.setattr(main_module.auth_service, 'list_users', lambda: users)
    monkeypatch.setattr(main_module.billing_service, '_send_email_notification', lambda *args, **kwargs: True)
    monkeypatch.setattr(
        main_module.billing_service,
        'credit_wallet',
        lambda email, amount, **options: (
            granted.append((email, amount, options)) or {'free_credit_balance': amount, 'balance': amount}
        ),
    )

    response = TestClient(app).post('/admin/free-credit', json={
        'audience': 'single',
        'email': 'owner@example.com',
        'amount': 10,
    })

    assert response.status_code == 200
    assert response.json()['recipient_count'] == 1
    assert [grant[0] for grant in granted] == ['owner@example.com']
    assert granted[0][1] == 10


def test_admin_free_credit_reports_email_failure_without_failing_credit_grant(monkeypatch) -> None:
    users = [{'email': 'customer@example.com', 'is_admin': False, 'is_blocked': False}]
    monkeypatch.setattr(main_module, 'is_admin_authenticated', lambda request: True)
    monkeypatch.setattr(main_module.auth_service, 'list_users', lambda: users)
    monkeypatch.setattr(
        main_module.billing_service,
        'credit_wallet',
        lambda email, amount, **options: {'free_credit_balance': amount, 'balance': amount},
    )
    monkeypatch.setattr(main_module.billing_service, 'last_email_error', 'SMTP unavailable', raising=False)
    monkeypatch.setattr(main_module.billing_service, '_send_email_notification', lambda *args, **kwargs: False)

    response = TestClient(app).post('/admin/free-credit', json={
        'audience': 'single',
        'email': 'customer@example.com',
        'amount': 10,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload['granted_count'] == 1
    assert payload['failed_count'] == 0
    assert payload['notification_failed_count'] == 1
    assert payload['results'][0]['email_sent'] is False
    assert payload['results'][0]['email_error'] == 'SMTP unavailable'


def test_admin_free_credit_rejects_invalid_amount(monkeypatch) -> None:
    monkeypatch.setattr(main_module, 'is_admin_authenticated', lambda request: True)
    response = TestClient(app).post('/admin/free-credit', json={
        'audience': 'single',
        'email': 'customer@example.com',
        'amount': 0,
    })

    assert response.status_code == 400
    assert response.json()['error'] == 'invalid_amount'


def test_admin_users_endpoint_lists_seeded_demo_users() -> None:
    client = TestClient(app)
    response = client.get('/admin/users', headers={'X-Admin-Secret': 'kieltech2009$'})

    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload.get('users'), list)
    assert any(user.get('email') == 'kieltech75@gmail.com' for user in payload['users'])
    assert any(user.get('email') == 'demo-user@example.com' for user in payload['users'])


def test_admin_customer_detail_page_serves_html() -> None:
    client = TestClient(app)
    response = client.get('/admin/customers/demo-user@example.com')

    assert response.status_code == 200
    assert 'Customer profile' in response.text


def test_admin_dashboard_data_endpoint_returns_live_summary() -> None:
    client = TestClient(app)
    response = client.get('/admin/dashboard-data', headers={'X-Admin-Secret': 'kieltech2009$'})

    assert response.status_code == 200
    payload = response.json()
    assert payload['metrics']['customers'] >= 2
    assert payload['metrics']['enterprise'] >= 1
    assert isinstance(payload['customers'], list)
    from app.main import billing_service

    assert payload['metrics']['usage_tracked'] == billing_service.get_total_api_request_count()
    assert all('wallet_balance' not in user for user in payload['customers'])


def test_admin_page_access_uses_current_firestore_role(monkeypatch) -> None:
    monkeypatch.setattr(
        main_module.auth_service,
        'get_user_from_token',
        lambda token: {'id': 'user-1', 'email': 'admin@example.com', 'firebase_uid': 'firebase-uid', 'is_admin': False},
    )
    monkeypatch.setattr(main_module, 'is_firebase_admin_uid', lambda uid: uid == 'firebase-uid')
    client = TestClient(app)

    allowed = client.get('/admin/dashboard', headers={'Authorization': 'Bearer valid-session'})
    assert allowed.status_code == 200
    assert 'Admin Dashboard' in allowed.text

    monkeypatch.setattr(main_module, 'is_firebase_admin_uid', lambda uid: False)
    denied = client.get('/admin/dashboard', headers={'Authorization': 'Bearer valid-session'})
    assert denied.status_code == 401


def test_admin_page_fails_closed_when_firestore_role_check_is_unavailable(monkeypatch) -> None:
    from app.services.firebase_roles import FirebaseRoleResolutionError

    monkeypatch.setattr(
        main_module.auth_service,
        'get_user_from_token',
        lambda token: {'id': 'user-1', 'email': 'admin@example.com', 'firebase_uid': 'firebase-uid'},
    )

    def raise_role_error(uid):
        raise FirebaseRoleResolutionError('Firestore is unavailable')

    monkeypatch.setattr(main_module, 'is_firebase_admin_uid', raise_role_error)
    response = TestClient(app).get(
        '/admin/dashboard',
        headers={'Authorization': 'Bearer valid-session'},
    )

    assert response.status_code == 503
    assert response.json()['error'] == 'admin_role_unavailable'


def test_owner_can_manage_roles_for_linked_google_accounts(monkeypatch) -> None:
    linked_users = [
        {
            'firebase_uid': 'owner-uid',
            'name': 'Owner User',
            'username': 'owner-user',
            'email': 'owner@example.com',
        },
        {
            'firebase_uid': 'admin-uid',
            'name': 'Admin User',
            'username': 'admin-user',
            'email': 'admin@example.com',
        },
    ]
    monkeypatch.setattr(main_module, 'is_owner_authenticated', lambda request: True)
    monkeypatch.setattr(main_module.auth_service, 'list_users', lambda: linked_users)
    monkeypatch.setattr(main_module, 'list_firebase_roles', lambda: {'owner-uid': 'owner', 'admin-uid': 'admin'})
    role_changes = []

    def set_admin_role(uid, enabled):
        role = 'admin' if enabled else 'user'
        role_changes.append((uid, role))
        return role

    monkeypatch.setattr(main_module, 'set_firebase_admin_role', set_admin_role)
    client = TestClient(app)

    page = client.get('/owner/admins')
    assert page.status_code == 200
    assert 'Administrator access' in page.text

    users = client.get('/owner/admins/users')
    assert users.status_code == 200
    assert [(user['email'], user['role']) for user in users.json()['users']] == [
        ('owner@example.com', 'owner'),
        ('admin@example.com', 'admin'),
    ]

    granted = client.put('/owner/admins/users/admin-uid/admin-role', json={'is_admin': True})
    assert granted.status_code == 200
    assert granted.json()['user']['role'] == 'admin'

    monkeypatch.setattr(main_module, 'list_firebase_roles', lambda: {'owner-uid': 'owner', 'admin-uid': 'admin'})
    revoked = client.put('/owner/admins/users/admin-uid/admin-role', json={'is_admin': False})
    assert revoked.status_code == 200
    assert revoked.json()['user']['role'] == 'user'
    assert role_changes == [('admin-uid', 'admin'), ('admin-uid', 'user')]


def test_owner_role_manager_cannot_change_owner_or_be_used_by_admin(monkeypatch) -> None:
    linked_users = [
        {'firebase_uid': 'owner-uid', 'email': 'owner@example.com'},
        {'firebase_uid': 'admin-uid', 'email': 'admin@example.com'},
    ]
    monkeypatch.setattr(main_module.auth_service, 'list_users', lambda: linked_users)
    monkeypatch.setattr(main_module, 'list_firebase_roles', lambda: {'owner-uid': 'owner'})
    changes = []
    monkeypatch.setattr(main_module, 'set_firebase_admin_role', lambda *args: changes.append(args) or 'admin')
    client = TestClient(app)

    monkeypatch.setattr(main_module, 'is_owner_authenticated', lambda request: True)
    owner_change = client.put('/owner/admins/users/owner-uid/admin-role', json={'is_admin': False})
    assert owner_change.status_code == 409
    assert owner_change.json()['error'] == 'owner_role_unchangeable'
    assert not changes

    monkeypatch.setattr(main_module, 'is_owner_authenticated', lambda request: False)
    denied = client.put('/owner/admins/users/admin-uid/admin-role', json={'is_admin': True})
    assert denied.status_code == 403
    assert not changes


def test_owner_role_inherits_admin_access(monkeypatch) -> None:
    monkeypatch.setattr(firebase_roles, 'get_firebase_role', lambda uid: 'owner')

    assert firebase_roles.is_firebase_owner_uid('owner-uid') is True
    assert firebase_roles.is_firebase_admin_uid('owner-uid') is True


def test_enterprise_keys_page_requires_admin_authentication(monkeypatch) -> None:
    monkeypatch.setattr(main_module, 'is_admin_authenticated', lambda request: False)
    response = TestClient(app).get('/admin-enterprise-keys.html')

    assert response.status_code == 401


def test_direct_admin_html_access_requires_firestore_role(monkeypatch) -> None:
    monkeypatch.setattr(
        main_module.auth_service,
        'get_user_from_token',
        lambda token: {'id': 'user-1', 'email': 'admin@example.com', 'firebase_uid': 'firebase-uid', 'is_admin': True},
    )
    monkeypatch.setattr(main_module, 'is_firebase_admin_uid', lambda uid: False)

    response = TestClient(app).get(
        '/admin-dashboard.html',
        headers={'Authorization': 'Bearer valid-session'},
    )

    assert response.status_code == 401


def test_admin_model_request_counts_include_active_models_and_recorded_requests() -> None:
    from app.main import _get_public_model_catalog_data, billing_service

    client = TestClient(app)
    models = _get_public_model_catalog_data()
    assert models
    model_id = models[0]['model_id']
    before = billing_service.get_model_request_counts().get(model_id.lower(), 0)
    billing_service.record_api_usage(
        'model-count-test@example.com',
        None,
        '/test/model-request-count',
        model_id,
        200,
        '2026-10-01T00:00:00+00:00',
        '2026-10-01T00:00:01+00:00',
    )

    response = client.get('/admin/model-request-counts', headers={'X-Admin-Secret': 'kieltech2009$'})

    assert response.status_code == 200
    payload = response.json()
    assert {model['model_id'].lower() for model in payload['models']} == {
        model['model_id'].lower() for model in models
    }
    tracked_model = next(model for model in payload['models'] if model['model_id'].lower() == model_id.lower())
    assert tracked_model['request_count'] == before + 1


def test_studio_assignment_candidates_include_all_model_categories(monkeypatch) -> None:
    catalog = [
        {
            'model_id': 'ready-chat', 'display_name': 'Ready Chat', 'category': 'text-generation',
            'is_ready': True, 'is_configured': True,
        },
        {
            'model_id': 'image-model', 'display_name': 'Image Model', 'category': 'image-generation',
            'is_ready': True, 'is_configured': True,
        },
        {
            'model_id': 'embedding-model', 'display_name': 'Embedding Model', 'category': 'embeddings',
            'is_ready': True, 'is_configured': True,
        },
        {
            'model_id': 'pending-chat', 'display_name': 'Pending Chat', 'category': 'text-generation',
            'is_ready': True, 'is_configured': False,
        },
    ]
    managed = [
        model | {
            'provider_model': f"provider/{model['model_id']}",
            'is_active': True,
            'is_ready': model['is_ready'],
            'is_configured': model['is_configured'],
        }
        for model in catalog
    ] + [{
        'model_id': 'removed-chat', 'display_name': 'Removed Chat', 'category': 'text-generation',
        'provider_model': 'provider/removed-chat', 'is_active': False,
        'is_ready': False, 'is_configured': True,
    }]

    monkeypatch.setattr(api_module.billing_service, 'list_managed_models', lambda include_inactive=True: managed)
    monkeypatch.setattr(api_module, '_get_public_model_catalog_data', lambda: catalog)
    monkeypatch.setattr(api_module.billing_service, 'list_permanently_deleted_model_ids', lambda: [])

    candidates = api_module._get_studio_assignment_candidates()
    candidates_by_id = {model['model_id']: model for model in candidates}

    assert set(candidates_by_id) == {'ready-chat', 'image-model', 'embedding-model', 'pending-chat', 'removed-chat'}
    assert candidates_by_id['ready-chat']['is_assignable'] is True
    assert candidates_by_id['image-model']['is_assignable'] is False
    assert 'Not supported in Studio' in candidates_by_id['image-model']['status']
    assert candidates_by_id['embedding-model']['is_assignable'] is False
    assert candidates_by_id['pending-chat']['is_assignable'] is False
    assert candidates_by_id['removed-chat']['is_assignable'] is False


def test_admin_send_email_scope_filters_enterprise_recipients() -> None:
    client = TestClient(app)
    response = client.post(
        '/admin/send-email',
        headers={'X-Admin-Secret': 'kieltech2009$'},
        json={'scope': 'enterprise', 'subject': 'Enterprise update', 'message': 'Hello'}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['scope'] == 'enterprise'
    assert payload['recipient_count'] >= 1
    assert all(payload['recipients'])


def test_frontend_pages_are_served_from_backend() -> None:
    client = TestClient(app)

    root_response = client.get('/')
    assert root_response.status_code == 200
    assert 'KielTech' in root_response.text

    login_response = client.get('/login.html')
    assert login_response.status_code == 200
    assert 'Login' in login_response.text
