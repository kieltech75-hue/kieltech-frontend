import asyncio
from pathlib import Path
import sys
import zipfile

import httpx

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app
from app.routers.api import _WEB_DEVELOPMENT_CONNECTION, auth_service, router


def request(method, path, **kwargs):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            return await client.request(method, path, **kwargs)
    return asyncio.run(run())


def verified_user(email, password='strong-pass-123'):
    auth_service.register_user(email.split('@')[0], email, password)
    auth_service.connection.execute('UPDATE auth_users SET email_verified = 1 WHERE email = ?', (email,))
    auth_service.connection.commit()
    return auth_service.login_user(email, password)['token']


def build_payload(email):
    return {
        'email': email,
        'project_name': 'Production website',
        'project_brief': 'Create a production-ready website for a real customer workflow.',
        'selected_ai': 'UI Studio AI',
        'selected_ai_category': 'Frontend',
        'selected_ai_price': '$350',
        'delivery_preference': 'download',
        'deployment_target': 'kieltech-preview',
        'feature_list': 'Landing page, contact form, responsive layout',
    }


def test_web_request_requires_authenticated_session():
    response = request('post', '/v1/web-development/requests', json=build_payload('anonymous@example.com'))
    assert response.status_code == 401


def test_web_request_is_owner_scoped():
    auth_service.reset()
    owner_token = verified_user('owner-production@example.com')
    other_token = verified_user('other-production@example.com')
    created = request('post', '/v1/web-development/requests', headers={'Authorization': f'Bearer {owner_token}'}, json=build_payload('owner-production@example.com'))
    assert created.status_code == 200
    request_id = created.json()['id']

    listing = request('get', '/v1/web-development/requests', headers={'Authorization': f'Bearer {other_token}'})
    assert listing.status_code == 200
    assert all(item['id'] != request_id for item in listing.json()['requests'])

    status = request('patch', f'/v1/web-development/requests/{request_id}/status', headers={'Authorization': f'Bearer {other_token}'}, json={'status': 'building'})
    assert status.status_code == 403


def test_delivery_requires_verified_payment_and_approval_state():
    auth_service.reset()
    owner_token = verified_user('delivery-production@example.com')
    created = request('post', '/v1/web-development/requests', headers={'Authorization': f'Bearer {owner_token}'}, json=build_payload('delivery-production@example.com'))
    assert created.status_code == 200
    request_id = created.json()['id']

    delivery = request('post', f'/v1/web-development/requests/{request_id}/deliver', headers={'Authorization': f'Bearer {owner_token}'}, json={'action': 'download'})
    assert delivery.status_code == 402


def test_delivery_artifact_is_a_real_zip_after_payment_and_approval():
    auth_service.reset()
    owner_token = verified_user('artifact-production@example.com')
    created = request('post', '/v1/web-development/requests', headers={'Authorization': f'Bearer {owner_token}'}, json=build_payload('artifact-production@example.com'))
    assert created.status_code == 200
    request_id = created.json()['id']
    _WEB_DEVELOPMENT_CONNECTION.execute(
        'UPDATE web_development_requests SET billing_payment_status = ?, status = ? WHERE id = ?',
        ('paid', 'approval_required', request_id),
    )
    _WEB_DEVELOPMENT_CONNECTION.commit()

    delivery = request('post', f'/v1/web-development/requests/{request_id}/deliver', headers={'Authorization': f'Bearer {owner_token}'}, json={'action': 'download'})
    assert delivery.status_code == 200
    artifact_path = Path(delivery.json()['artifact_path'])
    assert zipfile.is_zipfile(artifact_path)
    with zipfile.ZipFile(artifact_path) as archive:
        assert 'README.txt' in archive.namelist()
        assert 'index.html' in archive.namelist()


def test_retry_route_is_registered_once():
    retry_routes = [route for route in router.routes if getattr(route, 'path', '').endswith('/web-development/requests/{request_id}/retry')]
    assert len(retry_routes) == 1
