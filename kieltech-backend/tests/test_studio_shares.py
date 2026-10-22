from fastapi.testclient import TestClient

from app.main import app


def test_studio_share_round_trip_and_owner_update():
    client = TestClient(app)
    created = client.post(
        '/v1/studio/shares',
        json={
            'project_name': 'Shared Studio Project',
            'permission': 'read-write',
            'project_files': [
                {'name': 'src', 'type': 'folder', 'children': [{'name': 'app.tsx', 'type': 'file', 'content': 'export default 1;'}]}
            ],
        },
    )

    assert created.status_code == 201
    payload = created.json()
    token = payload['share_token']
    owner_token = payload['owner_token']

    shared = client.get(f'/v1/studio/shares/{token}')
    assert shared.status_code == 200
    assert shared.json()['permission'] == 'read-write'
    assert shared.json()['project_files'][0]['children'][0]['name'] == 'app.tsx'

    updated = client.patch(
        f'/v1/studio/shares/{token}',
        headers={'X-Share-Owner-Token': owner_token},
        json={'project_files': [{'name': 'index.html', 'type': 'file', 'content': '<h1>Updated</h1>'}]},
    )
    assert updated.status_code == 200
    assert updated.json()['project_files'][0]['name'] == 'index.html'


def test_read_only_share_rejects_update():
    client = TestClient(app)
    created = client.post(
        '/v1/studio/shares',
        json={'permission': 'read-only', 'project_files': []},
    )
    payload = created.json()

    response = client.patch(
        f"/v1/studio/shares/{payload['share_token']}",
        headers={'X-Share-Owner-Token': payload['owner_token']},
        json={'project_files': []},
    )
    assert response.status_code == 403


def test_server_studio_project_requires_authentication_in_production(monkeypatch):
    monkeypatch.setenv('ENVIRONMENT', 'production')
    client = TestClient(app)
    response = client.post('/v1/studio/projects', json={'project_name': 'Secure project'})
    assert response.status_code == 401


def test_server_studio_file_action_rejects_unsafe_paths_and_allows_owner(monkeypatch):
    client = TestClient(app)
    created = client.post('/v1/studio/projects', headers={'X-User-Email': 'owner@example.com'}, json={'project_name': 'Secure project'})
    assert created.status_code == 201
    project_id = created.json()['project_id']

    traversal = client.post(
        f'/v1/studio/projects/{project_id}/files/actions',
        headers={'X-User-Email': 'owner@example.com'},
        json={'action': 'create_file', 'path': '../secret.txt', 'content': 'nope'},
    )
    assert traversal.status_code == 400

    secret = client.post(
        f'/v1/studio/projects/{project_id}/files/actions',
        headers={'X-User-Email': 'owner@example.com'},
        json={'action': 'create_file', 'path': 'config.js', 'content': 'api_key="secret-value"'},
    )
    assert secret.status_code == 400

    created_file = client.post(
        f'/v1/studio/projects/{project_id}/files/actions',
        headers={'X-User-Email': 'owner@example.com'},
        json={'action': 'create_file', 'path': 'src/app.js', 'content': 'export default 1;'},
    )
    assert created_file.status_code == 200

    foreign = client.post(
        f'/v1/studio/projects/{project_id}/files/actions',
        headers={'X-User-Email': 'other@example.com'},
        json={'action': 'update_file', 'path': 'src/app.js', 'content': 'export default 2;'},
    )
    assert foreign.status_code == 404
