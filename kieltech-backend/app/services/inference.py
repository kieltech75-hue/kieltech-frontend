import asyncio
import base64
import io
import json
import os
import random
from typing import AsyncGenerator, Any, Dict, Optional
import httpx
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class MockModelService:
    """OpenRouter-backed OpenAI-compatible inference service.

    This service must not silently degrade to mock responses while a real API key is configured.
    In production or when the real provider is available, requests go directly to Nararouter.
    """

    def __init__(self) -> None:
        self.api_key = os.getenv('OPENROUTER_API_KEY', '').strip()
        self.use_mock = (os.getenv('KIELTECH_USE_MOCK', 'false').strip().lower() == 'true')
        self.api_base_url = os.getenv('OPENROUTER_API_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/')
        self.model = os.getenv('OPENROUTER_MODEL', 'openai/gpt-4o-mini')

    def _require_openrouter_key(self) -> str:
        if not self.api_key:
            raise RuntimeError('OPENROUTER_API_KEY is missing. Configure a valid key before using the AI service.')
        return self.api_key

    def _resolve_provider_model(self, model: str | None) -> str:
        if model in {'kielmind-lite', 'kielmind-pro', 'kiellens-ocr', 'kiellens-chat', 'kielforge-fast', 'kielforge-hd'} and self.model:
            return self.model
        return model or self.model or 'openai/gpt-4o-mini'

    def build_chat_request_payload(self, prompt: str, system_instructions: str, model: str, temperature: float = 0.5, max_tokens: int = 900, *, messages: Optional[list] = None, tools: Optional[list] = None, tool_choice: Optional[str | dict] = None, stream: bool = False, stream_options: Optional[dict] = None) -> Dict[str, Any]:
        provider_model = self._resolve_provider_model(model)
        payload = {
            'model': provider_model,
            'messages': messages or [
                *([{'role': 'system', 'content': system_instructions}] if system_instructions else []),
                {'role': 'user', 'content': prompt},
            ],
            'temperature': temperature,
            'max_tokens': max_tokens,
            'stream': stream,
        }
        if stream_options is not None:
            payload['stream_options'] = stream_options
        if tools is not None:
            payload['tools'] = tools
        if tool_choice is not None:
            payload['tool_choice'] = tool_choice
        return {key: value for key, value in payload.items() if value is not None}

    def _extract_tool_calls(self, message: Dict[str, Any] | None) -> list:
        if not isinstance(message, dict):
            return []
        raw_calls = message.get('tool_calls') or []
        if not raw_calls:
            return []

        calls: list = []
        for item in raw_calls:
            call = item if isinstance(item, dict) else {}
            function = call.get('function') or {}
            name = function.get('name') or call.get('name') or ''
            call_args = function.get('arguments') or call.get('arguments') or '{}'
            if isinstance(call_args, str):
                try:
                    parsed_args = json.loads(call_args) if call_args.strip() else {}
                except json.JSONDecodeError:
                    parsed_args = {'raw': call_args}
            else:
                parsed_args = call_args or {}
            calls.append({
                'id': call.get('id') or '',
                'type': call.get('type') or 'function',
                'function': {
                    'name': name,
                    'arguments': parsed_args,
                },
            })
        return calls

    def _generate_with_openrouter(self, prompt: str, system_instructions: str, model: str, temperature: float, max_tokens: int, messages: Optional[list] = None, tools: Optional[list] = None, tool_choice: Optional[str | dict] = None) -> Dict[str, Any]:
        api_key = self._require_openrouter_key()
        endpoint = f'{self.api_base_url}/chat/completions'
        payload = self.build_chat_request_payload(
            prompt,
            system_instructions,
            model,
            temperature=temperature,
            messages=messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
        )
        
        request = Request(
            endpoint,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}',
                'HTTP-Referer': os.getenv('NARAROUTER_SITE_URL', 'http://127.0.0.1:8001'),
                'X-Title': os.getenv('NARAROUTER_APP_NAME', 'KielTech'),
            },
            method='POST',
        )

        try:
            with urlopen(request, timeout=90) as response:
                result = json.loads(response.read().decode('utf-8'))
        except HTTPError as error:
            detail = error.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'OpenRouter API error ({error.code}): {detail[:500]}') from error
        except URLError as error:
            raise RuntimeError('Unable to perform any task please try again') from error

        choice = (result.get('choices') or [{}])[0]
        message = choice.get('message') or {}
        
        content_value = message.get('content')
        if isinstance(content_value, list):
            text = ''.join(part.get('text', '') for part in content_value if isinstance(part, dict)).strip()
        elif isinstance(content_value, str):
            text = content_value.strip()
        else:
            text = ''

        tool_calls = self._extract_tool_calls(message)
        usage = result.get('usage', {})
        response_payload = {
            'output': {'text': text},
            'text': text,
            'tool_calls': tool_calls,
            'usage': {
                'prompt_tokens': usage.get('prompt_tokens', 0),
                'completion_tokens': usage.get('completion_tokens', 0),
                'total_tokens': usage.get('total_tokens', 0),
            },
        }
        if not text and not tool_calls:
            raise RuntimeError('Nararouter returned no text or tool call. Check the prompt, model access, and API key.')

        if not text and not tool_calls:
            raise RuntimeError('OpenRouter returned no text or tool call. Check the prompt, model access, and API key.')
        return {'model': model, 'provider': 'openrouter', 'response': response_payload}

    async def generate_chat_completion(self, prompt: str, system_instructions: str, model: str, stream: bool, temperature: float = 0.5, max_tokens: int = 900, *, messages: Optional[list] = None, tools: Optional[list] = None, tool_choice: Optional[str | dict] = None) -> Dict[str, Any]:
        if self.use_mock:
            raise RuntimeError('Mock AI mode is disabled. Configure OPENROUTER_API_KEY to use the live provider.')
        return await asyncio.to_thread(self._generate_with_openrouter, prompt, system_instructions, model, temperature, max_tokens, messages, tools, tool_choice)

    async def stream_chat_completion(self, prompt: str, system_instructions: str, model: str, temperature: float = 0.5, max_tokens: int = 900, *, messages: Optional[list] = None, tools: Optional[list] = None, tool_choice: Optional[str | dict] = None) -> AsyncGenerator[str, None]:
        if self.use_mock:
            raise RuntimeError('Mock AI mode is disabled. Configure OPENROUTER_API_KEY to use the live provider.')
        endpoint = f'{self.api_base_url}/chat/completions'
        payload = self.build_chat_request_payload(
            prompt,
            system_instructions,
            model,
            temperature=temperature,
            max_tokens=max_tokens,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=True,
            stream_options={'include_usage': True},
        )
        headers = {
            'Authorization': f'Bearer {self._require_openrouter_key()}',
            'HTTP-Referer': os.getenv('NARAROUTER_SITE_URL', 'http://127.0.0.1:8001'),
            'X-Title': os.getenv('NARAROUTER_APP_NAME', 'KielTech'),
        }
        async with httpx.AsyncClient(timeout=90) as client:
            async with client.stream('POST', endpoint, json=payload, headers=headers) as response:
                if response.status_code >= 400:
                    detail = (await response.aread()).decode('utf-8', errors='replace')
                    raise RuntimeError(f'OpenRouter API error ({response.status_code}): {detail[:500]}')
                async for line in response.aiter_lines():
                    data = line[5:].strip() if line.startswith('data:') else ''
                    if data and data != '[DONE]':
                        yield data
        return

    async def analyze_vision(self, prompt: str, image_url: Optional[str], image_base64: Optional[str], model: str = 'kiellens-chat', history: Optional[list[dict]] = None) -> Dict[str, Any]:
        if self.use_mock:
            raise RuntimeError('Vision analysis is unavailable in mock mode. Configure OPENROUTER_API_KEY to analyze uploaded images.')

        image_source = image_url
        if image_base64:
            if image_base64.startswith('data:image/'):
                image_source = image_base64
            else:
                image_source = f'data:image/png;base64,{image_base64}'
        if not image_source:
            raise ValueError('An image URL or base64 image is required.')

        vision_default = os.getenv('OPENROUTER_VISION_MODEL', '').strip()
        if model in {'kiellens-ocr', 'kiellens-chat'} and vision_default:
            provider_model = vision_default
        else:
            provider_model = self._resolve_provider_model(model)
        endpoint = f'{self.api_base_url}/chat/completions'
        messages = [
            {'role': item['role'], 'content': item['content']}
            for item in (history or [])
            if isinstance(item, dict) and item.get('role') in {'user', 'assistant'}
        ]
        messages.append({
            'role': 'user',
            'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image_url', 'image_url': {'url': image_source}},
            ],
        })
        payload = {
            'model': provider_model,
            'messages': messages,
            'max_tokens': 900,
            'temperature': 0.2,
        }
        headers = {
            'Authorization': f'Bearer {self._require_openrouter_key()}',
            'HTTP-Referer': os.getenv('OPENROUTER_SITE_URL', 'http://127.0.0.1:8001'),
            'X-Title': os.getenv('OPENROUTER_APP_NAME', 'KielTech'),
        }

        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
        if response.status_code >= 400:
            raise RuntimeError(f'OpenRouter vision API error ({response.status_code}): {response.text[:500]}')

        result = response.json()
        choice = (result.get('choices') or [{}])[0]
        content = (choice.get('message') or {}).get('content')
        if isinstance(content, list):
            description = '\n'.join(part.get('text', '') for part in content if isinstance(part, dict) and part.get('type') == 'text').strip()
        else:
            description = str(content or '').strip()
        if not description:
            raise RuntimeError('OpenRouter returned no vision analysis. Check the selected model and image input.')

        return {
            'model': model,
            'provider': 'openrouter',
            'prompt': prompt,
            'response': {
                'description': description,
                'usage': result.get('usage', {}),
            },
            'source': 'image_url' if image_url and not image_base64 else 'image_base64',
        }

    async def generate_image(self, prompt: str, size: str, steps: int) -> Dict[str, Any]:
        await asyncio.sleep(0.05)
        image_bytes = b'fake-image-bytes'
        encoded = base64.b64encode(image_bytes).decode('utf-8')
        return {
            'status': 'success',
            'prompt': prompt,
            'size': size,
            'steps': steps,
            'image_base64': encoded,
            'mime_type': 'image/png',
        }
