from fastapi.testclient import TestClient

from app.main import app


def test_static_assets_are_served() -> None:
    client = TestClient(app)

    script_response = client.get('/script.js')
    assert script_response.status_code == 200

    logo_response = client.get('/KielTech-logo.png')
    assert logo_response.status_code == 200


def test_missing_frontend_page_uses_branded_not_found_page() -> None:
    response = TestClient(app).get('/model-that-does-not-exist.html')

    assert response.status_code == 404
    assert response.headers['content-type'].startswith('text/html')
    assert 'Page Not Found' in response.text
    assert 'KielTech-logo.png' in response.text
