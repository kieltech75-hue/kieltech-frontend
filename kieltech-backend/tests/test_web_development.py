import asyncio
from pathlib import Path
import sys

import httpx

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app
from app.routers.api import _STUDIO_DEPLOYMENT_RATE_LIMITS, _WEB_DEVELOPMENT_CONNECTION, auth_service
from app.services.railway import RailwayDeploymentClient


def make_request(method: str, path: str, **kwargs):
    async def _request():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_request())


def test_railway_client_builds_safe_default_urls_without_external_configuration():
    client = RailwayDeploymentClient()
    payload = client.build_deployment_payload(
        project_name='Demo Launch',
        website_name='Demo Launch',
        custom_domain='',
        visibility='public',
        deployment_target='production-host',
        files=[{'path': 'index.html', 'content': '<h1>demo</h1>'}],
    )

    assert payload['status'] == 'queued'
    assert payload['canonical_url'] == 'https://demo-launch.kieltech.app'
    assert payload['provider_url'] == 'https://demo-launch.kieltech.app'
    assert payload['configured'] is False


def test_studio_deployment_request_requires_authentication_and_returns_status():
    auth_service.reset()
    _WEB_DEVELOPMENT_CONNECTION.execute('DELETE FROM studio_projects WHERE project_id = ?', ('proj_demo_123',))
    _WEB_DEVELOPMENT_CONNECTION.execute('DELETE FROM studio_deployments WHERE project_id = ?', ('proj_demo_123',))
    _WEB_DEVELOPMENT_CONNECTION.commit()
    _STUDIO_DEPLOYMENT_RATE_LIMITS.clear()
    auth_service.register_user('Deploy User', 'deploy-user@example.com', 'strong-pass-123')
    token = auth_service.login_user('deploy-user@example.com', 'strong-pass-123')['token']

    response = make_request(
        'post',
        '/v1/studio/projects/proj_demo_123/deployments',
        headers={'Authorization': f'Bearer {token}'},
        json={
            'website_name': 'Demo Site',
            'visibility': 'public',
            'deployment_target': 'kieltech-preview',
            'custom_domain': 'demo-site.kieltech.app',
            'files': [
                {'path': 'index.html', 'content': '<html><body>Hello</body></html>'},
                {'path': 'styles.css', 'content': 'body { color: #111; }'}
            ],
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload['project_id'] == 'proj_demo_123'
    assert payload['website_name'] == 'Demo Site'
    assert payload['status'] == 'queued'
    assert payload['validation_status'] == 'queued'
    assert payload['version'] == 1
    assert payload['provider_url'] == 'https://demo-site.kieltech.app'
    assert payload['canonical_url'] == 'https://demo-site.kieltech.app'
    assert payload['metadata']['artifact_type'] == 'studio-deployment'
    assert payload['url'] == 'https://demo-site.kieltech.app'

    row = _WEB_DEVELOPMENT_CONNECTION.execute(
        'SELECT project_version, validation_status, provider_url, canonical_url, package_path, metadata FROM studio_deployments WHERE id = ?',
        (payload['id'],),
    ).fetchone()
    assert row['project_version'] == 1
    assert row['validation_status'] == 'queued'
    assert row['provider_url'] == 'https://demo-site.kieltech.app'
    assert row['canonical_url'] == 'https://demo-site.kieltech.app'
    assert row['package_path']
    assert 'studio-deployment' in row['metadata']


def test_studio_preview_returns_requested_page_and_shared_assets():
    project = make_request(
        'post',
        '/v1/studio/projects',
        headers={'X-User-Email': 'preview-owner@example.com'},
        json={'project_name': 'Preview project'},
    )
    assert project.status_code == 201
    project_id = project.json()['project_id']
    response = make_request(
        'post',
        f'/v1/studio/projects/{project_id}/preview',
        headers={'X-User-Email': 'preview-owner@example.com'},
        json={
            'page_path': 'pages/about.html',
            'files': [
                {'path': 'index.html', 'content': '<a href="pages/about.html">About</a>'},
                {'path': 'pages/about.html', 'content': '<h1>About KielTech</h1>'},
                {'path': 'styles.css', 'content': 'body { color: #111; }'},
                {'path': 'script.js', 'content': 'console.log("preview");'},
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['project_id'] == project_id
    assert payload['page_path'] == 'pages/about.html'
    assert payload['html'] == '<h1>About KielTech</h1>'
    assert 'body { color: #111; }' in payload['css']
    assert 'console.log("preview");' in payload['js']


def test_studio_deployment_rejects_anonymous_before_payload_validation():
    response = make_request(
        'post',
        '/v1/studio/projects/anonymous-project/deployments',
        content=b'not-json',
        headers={'Content-Type': 'application/json'},
    )

    assert response.status_code == 401


def test_studio_deployment_rejects_secret_leakage_in_project_files():
    auth_service.reset()
    _WEB_DEVELOPMENT_CONNECTION.execute('DELETE FROM studio_projects WHERE project_id = ?', ('secret-leak-project',))
    _WEB_DEVELOPMENT_CONNECTION.commit()
    _STUDIO_DEPLOYMENT_RATE_LIMITS.clear()
    auth_service.register_user('Secret User', 'secret-user@example.com', 'strong-pass-123')
    token = auth_service.login_user('secret-user@example.com', 'strong-pass-123')['token']

    response = make_request(
        'post',
        '/v1/studio/projects/secret-leak-project/deployments',
        headers={'Authorization': f'Bearer {token}'},
        json={
            'website_name': 'Secret Leak Site',
            'files': [
                {'path': 'index.html', 'content': '<script>const api_key = "example-placeholder-value";</script>'},
                {'path': 'styles.css', 'content': 'body { color: #111; }'},
            ],
        },
    )

    assert response.status_code == 400
    assert response.json()['error'] == 'invalid_project'


def test_studio_deployment_rejects_authenticated_non_owner():
    auth_service.reset()
    _WEB_DEVELOPMENT_CONNECTION.execute('DELETE FROM studio_projects WHERE project_id = ?', ('owned-project',))
    _WEB_DEVELOPMENT_CONNECTION.commit()
    _STUDIO_DEPLOYMENT_RATE_LIMITS.clear()
    auth_service.register_user('Project Owner', 'project-owner@example.com', 'owner-pass-123')
    owner_token = auth_service.login_user('project-owner@example.com', 'owner-pass-123')['token']
    owner_response = make_request(
        'post',
        '/v1/studio/projects/owned-project/deployments',
        headers={'Authorization': f'Bearer {owner_token}'},
        json={'website_name': 'Owned Site', 'files': [{'path': 'index.html', 'content': '<h1>Owner</h1>'}]},
    )
    assert owner_response.status_code == 201

    auth_service.register_user('Other User', 'other-user@example.com', 'other-pass-123')
    other_token = auth_service.login_user('other-user@example.com', 'other-pass-123')['token']
    response = make_request(
        'post',
        '/v1/studio/projects/owned-project/deployments',
        headers={'Authorization': f'Bearer {other_token}'},
        json={'website_name': 'Unauthorized Site', 'files': [{'path': 'index.html', 'content': '<h1>Other</h1>'}]},
    )

    assert response.status_code == 403


def test_web_development_request_is_created_and_stored():
    response = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'builder@example.com',
            'project_name': 'AI Studio',
            'project_brief': 'Create a polished landing page',
            'selected_ai': 'UI Studio AI',
            'selected_ai_category': 'Frontend',
            'selected_ai_price': '$350',
            'delivery_preference': 'publish',
            'deployment_target': 'free-hosting',
            'feature_list': 'Hero, pricing, contact',
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'reviewing'
    assert payload['project_name'] == 'AI Studio'
    assert payload['email'] == 'builder@example.com'
    assert payload['selected_ai'] == 'UI Studio AI'


def test_web_development_requests_can_be_listed_by_email():
    make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'history@example.com',
            'project_name': 'Portfolio',
            'project_brief': 'Create a modern portfolio',
            'selected_ai': 'UX Flow AI',
            'selected_ai_category': 'Frontend',
            'selected_ai_price': '$550',
            'delivery_preference': 'download',
            'deployment_target': 'later',
            'feature_list': 'About, projects, contact',
        },
    )

    response = make_request('get', '/v1/web-development/requests?email=history@example.com')

    assert response.status_code == 200
    payload = response.json()
    assert payload['count'] >= 1
    assert any(item['project_name'] == 'Portfolio' for item in payload['requests'])


def test_web_development_request_status_can_be_updated():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'status@example.com',
            'project_name': 'Marketplace',
            'project_brief': 'Create a marketplace MVP',
            'selected_ai': 'Ops AI',
            'selected_ai_category': 'Backend',
            'selected_ai_price': '$900',
            'delivery_preference': 'both',
            'deployment_target': 'use-my-domain',
            'feature_list': 'Checkout, dashboard',
        },
    )

    request_id = created.json()['id']
    updated = make_request(
        'patch',
        f'/v1/web-development/requests/{request_id}/status',
        json={'status': 'draft-ready'},
    )

    assert updated.status_code == 200
    assert updated.json()['status'] == 'draft-ready'


def test_web_development_delivery_workflow_creates_an_artifact():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'delivery@example.com',
            'project_name': 'Launchpad',
            'project_brief': 'Create a launchpad experience',
            'selected_ai': 'Launch AI',
            'selected_ai_category': 'Fullstack',
            'selected_ai_price': '$1100',
            'delivery_preference': 'download',
            'deployment_target': 'free-hosting',
            'feature_list': 'Landing, pricing, FAQ',
        },
    )

    request_id = created.json()['id']
    response = make_request(
        'post',
        f'/v1/web-development/requests/{request_id}/deliver',
        json={'action': 'download'},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'completed'
    assert payload['action'] == 'download'
    assert payload['artifact_url'].endswith('.zip')
    artifact_path = Path(__file__).resolve().parents[1] / 'downloads' / Path(payload['artifact_url']).name
    assert artifact_path.exists()


def test_web_development_request_retry_on_failed_request():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'retry@example.com',
            'project_name': 'Retry Project',
            'project_brief': 'Create a retry flow for failed requests',
            'selected_ai': 'Recovery AI',
            'selected_ai_category': 'Fullstack',
            'selected_ai_price': '$500',
            'delivery_preference': 'download',
            'deployment_target': 'later',
            'feature_list': 'Retry, audit, fallback',
        },
    )

    request_id = created.json()['id']
    make_request('patch', f'/v1/web-development/requests/{request_id}/status', json={'status': 'failed'})

    response = make_request(
        'post',
        f'/v1/web-development/requests/{request_id}/retry',
        json={'action': 'download'},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'completed'
    assert payload['artifact_url'].endswith('.zip')


def test_web_development_billing_checkout_and_events_update_request_state():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'billing@example.com',
            'project_name': 'Billing Portal',
            'project_brief': 'Create a billing-aware portal experience with deposits and invoices',
            'selected_ai': 'Growth Stack AI',
            'selected_ai_category': 'Fullstack',
            'selected_ai_price': '$1500',
            'delivery_preference': 'publish',
            'deployment_target': 'use-my-domain',
            'feature_list': 'Invoices, deposits, refunds',
        },
    )

    request_id = created.json()['id']
    checkout = make_request(
        'post',
        f'/v1/web-development/requests/{request_id}/billing/checkout',
        json={'amount': 450, 'currency': 'USD', 'payment_type': 'deposit'},
    )

    assert checkout.status_code == 200
    checkout_payload = checkout.json()
    assert checkout_payload['payment_status'] == 'pending'
    assert checkout_payload['reference']

    event = make_request(
        'post',
        f'/v1/web-development/requests/{request_id}/billing/events',
        json={
            'event': 'payment.confirmed',
            'status': 'paid',
            'amount': 450,
            'currency': 'USD',
            'reference': checkout_payload['reference'],
            'invoice_id': 'INV-1001',
            'note': 'Deposit received',
        },
    )

    assert event.status_code == 200
    status_payload = make_request('get', f'/v1/web-development/requests/{request_id}/billing/status').json()
    assert status_payload['payment_status'] == 'paid'
    assert status_payload['invoice_status'] == 'generated'
    assert status_payload['amount_paid'] == 450
    assert status_payload['invoice_id'] == 'INV-1001'


def test_admin_can_review_and_update_web_development_requests():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'admin-review@example.com',
            'project_name': 'Admin Portal',
            'project_brief': 'Create a polished admin portal experience for internal operations',
            'selected_ai': 'Ops AI',
            'selected_ai_category': 'Fullstack',
            'selected_ai_price': '$950',
            'delivery_preference': 'publish',
            'deployment_target': 'use-my-domain',
            'feature_list': 'Reports, approvals, audit logs',
        },
    )

    request_id = created.json()['id']
    updated = make_request(
        'patch',
        f'/v1/admin/web-development/requests/{request_id}',
        headers={'x-admin-secret': 'kieltech2009$'},
        json={'review_status': 'approved', 'review_note': 'Ready for delivery', 'status': 'queued'},
    )

    assert updated.status_code == 200
    payload = updated.json()
    assert payload['review_status'] == 'approved'
    assert payload['review_note'] == 'Ready for delivery'
    assert payload['status'] == 'queued'

    listing = make_request('get', '/v1/admin/web-development/requests', headers={'x-admin-secret': 'kieltech2009$'})
    assert listing.status_code == 200
    assert any(item['id'] == request_id for item in listing.json()['requests'])


def test_admin_workflow_endpoint_groups_requests_by_stage():
    created = make_request(
        'post',
        '/v1/web-development/requests',
        json={
            'email': 'workflow@example.com',
            'project_name': 'Workflow board',
            'project_brief': 'Create a better admin workflow board',
            'selected_ai': 'Ops AI',
            'selected_ai_category': 'Backend',
            'selected_ai_price': '$650',
            'delivery_preference': 'both',
            'deployment_target': 'later',
            'feature_list': 'Workflow, stages, audit',
        },
    )

    request_id = created.json()['id']
    make_request(
        'patch',
        f'/v1/admin/web-development/requests/{request_id}',
        headers={'x-admin-secret': 'kieltech2009$'},
        json={'review_status': 'approved', 'review_note': 'Queued for orchestration', 'status': 'queued'},
    )

    response = make_request('get', '/v1/admin/web-development/workflow', headers={'x-admin-secret': 'kieltech2009$'})

    assert response.status_code == 200
    payload = response.json()
    assert payload['summary']['queued'] >= 1
    stage = next((item for item in payload['stages'] if item['key'] == 'queued'), None)
    assert stage is not None
    assert any(item['id'] == request_id for item in stage['requests'])
