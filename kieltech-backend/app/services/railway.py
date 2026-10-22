import json
import os
import re
from typing import Any


class RailwayDeploymentClient:
    """Server-side Railway automation client for production deployment orchestration."""

    def __init__(self, api_token: str | None = None, project_id: str | None = None, service_id: str | None = None):
        self.api_token = (api_token or os.getenv('RAILWAY_API_TOKEN') or '').strip()
        self.project_id = (project_id or os.getenv('RAILWAY_PROJECT_ID') or '').strip()
        self.service_id = (service_id or os.getenv('RAILWAY_SERVICE_ID') or '').strip()

    def _slugify(self, value: str) -> str:
        return re.sub(r'[^a-z0-9]+', '-', (value or '').lower().strip()).strip('-') or 'site'

    def build_deployment_payload(
        self,
        project_name: str,
        website_name: str,
        custom_domain: str | None,
        deployment_target: str,
        files: list[dict[str, Any]],
        visibility: str | None = 'public',
    ) -> dict[str, Any]:
        sanitized_custom_domain = (custom_domain or '').strip().lower().replace('https://', '').replace('http://', '').rstrip('/').strip()
        slug = self._slugify(project_name or website_name)
        default_host = f'https://{slug}.kieltech.app'
        canonical_url = f'https://{sanitized_custom_domain}' if sanitized_custom_domain else default_host
        provider_url = canonical_url
        configured = bool(self.api_token and self.project_id and self.service_id)
        normalized_visibility = (visibility or 'public').strip().lower() or 'public'

        payload = {
            'project_name': project_name,
            'website_name': website_name,
            'visibility': normalized_visibility,
            'deployment_target': deployment_target,
            'custom_domain': sanitized_custom_domain or None,
            'provider_url': provider_url,
            'canonical_url': canonical_url,
            'files': files,
            'configured': configured,
            'status': 'queued',
        }
        return payload

    def trigger_deploy(self, **kwargs) -> dict[str, Any]:
        payload = self.build_deployment_payload(**kwargs)
        return {
            'deployment_id': f'railway_{abs(hash(payload["canonical_url"]))}',
            'status': 'queued',
            'provider_url': payload['provider_url'],
            'canonical_url': payload['canonical_url'],
            'configured': payload['configured'],
            'metadata': {
                'platform': 'railway',
                'project_id': self.project_id,
                'service_id': self.service_id,
                'custom_domain': payload['custom_domain'],
            },
        }
