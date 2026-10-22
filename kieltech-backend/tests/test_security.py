import os

from fastapi import Request

from app.routers.api import _production_auth_required


def test_production_ai_requires_authentication(monkeypatch):
    monkeypatch.setenv('ENVIRONMENT', 'production')
    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': []})

    response = _production_auth_required(request)

    assert response is not None
    assert response.status_code == 401


def test_development_allows_existing_demo_flow(monkeypatch):
    monkeypatch.setenv('ENVIRONMENT', 'development')
    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': []})

    assert _production_auth_required(request) is None
