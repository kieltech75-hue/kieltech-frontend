import asyncio
import base64
import json
import mimetypes
import posixpath
from urllib.parse import unquote, urlsplit


_PREVIEW_ORIGIN = 'http://kieltech-preview.local'
_MAX_SELECTOR_LENGTH = 500
_MAX_TEXT_LENGTH = 10_000
_MAX_RESULT_LENGTH = 30_000
_MAX_SCREENSHOT_BYTES = 512_000
_MAX_TIMEOUT_MS = 10_000


class StudioBrowserSession:
    def __init__(self, load_files):
        self._load_files = load_files
        self._playwright = None
        self._browser = None
        self._context = None
        self._pages = []
        self._page = None
        self._console_messages = []
        self._network_requests = []

    async def _start(self):
        if self._context:
            return
        try:
            from playwright.async_api import async_playwright
        except ImportError as error:
            raise RuntimeError('Playwright is not installed on the Studio backend.') from error
        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.launch(
                executable_path=self._playwright.chromium.executable_path,
            )
            self._context = await self._browser.new_context(viewport={'width': 1280, 'height': 800})
            await self._context.route('**/*', self._serve_project_file)
            self._page = await self._context.new_page()
            self._pages = [self._page]
            self._attach_page_events(self._page)
            await self._page.goto(f'{_PREVIEW_ORIGIN}/index.html', wait_until='domcontentloaded', timeout=15_000)
        except Exception:
            await self.close()
            raise

    def _attach_page_events(self, page):
        page.on('console', lambda message: self._console_messages.append({
            'type': message.type,
            'text': message.text[:2_000],
        }))
        page.on('pageerror', lambda error: self._console_messages.append({
            'type': 'error',
            'text': str(error)[:2_000],
        }))
        page.on('request', lambda request: self._network_requests.append({
            'method': request.method,
            'url': request.url[:2_000],
            'resource_type': request.resource_type,
        }) if len(self._network_requests) < 200 else None)
        page.on('dialog', lambda dialog: asyncio.create_task(dialog.accept()))

    async def _serve_project_file(self, route):
        parsed = urlsplit(route.request.url)
        if parsed.scheme + '://' + parsed.netloc != _PREVIEW_ORIGIN:
            await route.abort()
            return
        raw_path = unquote(parsed.path).replace('\\', '/')
        if '\x00' in raw_path or '..' in raw_path.split('/'):
            await route.fulfill(status=400, body='Invalid project path.')
            return
        project_path = posixpath.normpath(raw_path.lstrip('/'))
        if project_path in {'', '.'}:
            project_path = 'index.html'
        files = self._load_files()
        content = files.get(project_path)
        if content is None:
            await route.fulfill(status=404, body='Project file not found.')
            return
        content_type = mimetypes.guess_type(project_path)[0] or 'application/octet-stream'
        if content_type.startswith('text/') or content_type in {'application/javascript', 'application/json'}:
            content_type += '; charset=utf-8'
        await route.fulfill(
            status=200,
            content_type=content_type,
            body=content,
            headers={'X-Content-Type-Options': 'nosniff'},
        )

    async def _get_page(self):
        await self._start()
        if not self._page or self._page.is_closed():
            self._page = await self._context.new_page()
            self._pages.append(self._page)
            self._attach_page_events(self._page)
            await self._page.goto(f'{_PREVIEW_ORIGIN}/index.html', wait_until='domcontentloaded', timeout=15_000)
        return self._page

    @staticmethod
    def _selector(arguments):
        selector = str(arguments.get('selector') or '').strip()
        if not selector or len(selector) > _MAX_SELECTOR_LENGTH:
            raise ValueError('Provide a selector between 1 and 500 characters.')
        return selector

    @staticmethod
    def _limited_text(value, label='text'):
        text = str(value or '')
        if len(text) > _MAX_TEXT_LENGTH:
            raise ValueError(f'{label.capitalize()} cannot exceed {_MAX_TEXT_LENGTH} characters.')
        return text

    async def execute(self, name, arguments):
        if name == 'browser_close':
            await self.close()
            return {'ok': True, 'message': 'Playwright browser session closed.'}

        page = await self._get_page()
        if name == 'browser_navigate':
            path = str(arguments.get('path') or '/index.html').strip()
            parsed = urlsplit(path)
            if parsed.scheme or parsed.netloc or path.startswith('//'):
                return {'ok': False, 'error': 'Navigation is limited to files in this Studio project. Provide a project-relative path.'}
            normalized = posixpath.normpath('/' + unquote(parsed.path).lstrip('/'))
            if '..' in unquote(parsed.path).replace('\\', '/').split('/'):
                return {'ok': False, 'error': 'Navigation path must stay within this Studio project.'}
            target = f'{_PREVIEW_ORIGIN}{normalized}'
            response = await page.goto(target, wait_until='domcontentloaded', timeout=15_000)
            return {'ok': True, 'url': page.url, 'title': await page.title(), 'status': response.status if response else None}
        if name == 'browser_reload':
            response = await page.reload(wait_until='domcontentloaded', timeout=15_000)
            return {'ok': True, 'url': page.url, 'status': response.status if response else None}
        if name in {'browser_go_back', 'browser_go_forward'}:
            response = await (page.go_back(timeout=15_000) if name == 'browser_go_back' else page.go_forward(timeout=15_000))
            return {'ok': True, 'url': page.url, 'title': await page.title(), 'status': response.status if response else None}
        if name == 'browser_get_url':
            return {'ok': True, 'url': page.url}
        if name == 'browser_get_title':
            return {'ok': True, 'title': await page.title()}
        if name == 'browser_snapshot':
            snapshot = await page.locator('body').aria_snapshot()
            return {'ok': True, 'url': page.url, 'title': await page.title(), 'snapshot': snapshot[:_MAX_RESULT_LENGTH], 'truncated': len(snapshot) > _MAX_RESULT_LENGTH}
        if name in {'browser_click', 'browser_dblclick', 'browser_hover'}:
            locator = page.locator(self._selector(arguments)).first
            if name == 'browser_click':
                await locator.click(timeout=5_000)
            elif name == 'browser_dblclick':
                await locator.dblclick(timeout=5_000)
            else:
                await locator.hover(timeout=5_000)
            return {'ok': True, 'url': page.url, 'title': await page.title()}
        if name in {'browser_fill', 'browser_type'}:
            selector = self._selector(arguments)
            text = self._limited_text(arguments.get('text'), 'Input')
            locator = page.locator(selector).first
            if name == 'browser_fill':
                await locator.fill(text, timeout=5_000)
            else:
                await locator.press_sequentially(text, timeout=5_000)
            return {'ok': True, 'selector': selector, 'value_length': len(text)}
        if name == 'browser_press_key':
            key = self._limited_text(arguments.get('key'), 'Key')
            if not key or len(key) > 100:
                raise ValueError('Provide a valid keyboard key.')
            selector = str(arguments.get('selector') or '').strip()
            if selector:
                await page.locator(self._selector(arguments)).first.press(key, timeout=5_000)
            else:
                await page.keyboard.press(key)
            return {'ok': True, 'key': key}
        if name == 'browser_select_option':
            selector = self._selector(arguments)
            value = arguments.get('value')
            if not isinstance(value, (str, list)):
                raise ValueError('The option value must be a string or list of strings.')
            await page.locator(selector).first.select_option(value, timeout=5_000)
            return {'ok': True, 'selector': selector, 'value': value}
        if name in {'browser_check', 'browser_uncheck'}:
            selector = self._selector(arguments)
            locator = page.locator(selector).first
            await (locator.check(timeout=5_000) if name == 'browser_check' else locator.uncheck(timeout=5_000))
            return {'ok': True, 'selector': selector, 'checked': name == 'browser_check'}
        if name == 'browser_wait_for':
            selector = self._selector(arguments)
            state = str(arguments.get('state') or 'visible')
            if state not in {'visible', 'hidden', 'attached', 'detached'}:
                raise ValueError('Wait state must be visible, hidden, attached, or detached.')
            timeout_ms = min(max(int(arguments.get('timeout_ms') or 5_000), 1), _MAX_TIMEOUT_MS)
            await page.locator(selector).first.wait_for(state=state, timeout=timeout_ms)
            return {'ok': True, 'selector': selector, 'state': state}
        if name == 'browser_wait':
            duration_ms = min(max(int(arguments.get('duration_ms') or 0), 0), _MAX_TIMEOUT_MS)
            await page.wait_for_timeout(duration_ms)
            return {'ok': True, 'waited_ms': duration_ms}
        if name == 'browser_resize':
            width = int(arguments.get('width') or 1280)
            height = int(arguments.get('height') or 800)
            if not 320 <= width <= 1920 or not 240 <= height <= 1200:
                raise ValueError('Viewport width must be 320–1920 and height 240–1200.')
            await page.set_viewport_size({'width': width, 'height': height})
            return {'ok': True, 'width': width, 'height': height}
        if name == 'browser_take_screenshot':
            image = await page.screenshot(
                type='jpeg',
                quality=65,
                full_page=bool(arguments.get('full_page', False)),
                animations='disabled',
            )
            if len(image) > _MAX_SCREENSHOT_BYTES:
                return {'ok': False, 'error': 'Screenshot exceeds the 500 KB tool limit. Resize the viewport or capture the visible viewport only.'}
            return {
                'ok': True,
                'url': page.url,
                'mime_type': 'image/jpeg',
                'image_base64': base64.b64encode(image).decode('ascii'),
                'bytes': len(image),
            }
        if name == 'browser_console_messages':
            return {'ok': True, 'messages': self._console_messages[-50:]}
        if name == 'browser_network_requests':
            return {'ok': True, 'requests': self._network_requests[-50:]}
        if name == 'browser_evaluate':
            expression = self._limited_text(arguments.get('expression'), 'Expression')
            if not expression:
                raise ValueError('Provide a JavaScript expression to evaluate.')
            value = await asyncio.wait_for(page.evaluate(expression), timeout=5)
            try:
                serialized = json.dumps(value, ensure_ascii=False)
            except (TypeError, ValueError):
                serialized = json.dumps(str(value), ensure_ascii=False)
            return {'ok': True, 'value': serialized[:_MAX_RESULT_LENGTH], 'truncated': len(serialized) > _MAX_RESULT_LENGTH}
        if name == 'browser_tabs':
            return {'ok': True, 'active': self._pages.index(page), 'tabs': [{'index': index, 'url': item.url, 'title': await item.title()} for index, item in enumerate(self._pages) if not item.is_closed()]}
        if name == 'browser_tab_new':
            next_page = await self._context.new_page()
            self._pages.append(next_page)
            self._page = next_page
            self._attach_page_events(next_page)
            path = str(arguments.get('path') or '/index.html')
            return await self.execute('browser_navigate', {'path': path})
        if name == 'browser_tab_select':
            index = int(arguments.get('index', -1))
            if index < 0 or index >= len(self._pages) or self._pages[index].is_closed():
                raise ValueError('The requested browser tab does not exist.')
            self._page = self._pages[index]
            return {'ok': True, 'active': index, 'url': self._page.url, 'title': await self._page.title()}
        if name == 'browser_tab_close':
            await page.close()
            self._pages = [item for item in self._pages if not item.is_closed()]
            self._page = self._pages[-1] if self._pages else None
            return {'ok': True, 'closed': True, 'remaining_tabs': len(self._pages)}
        return {'ok': False, 'error': f'Unsupported Playwright tool: {name}'}

    async def close(self):
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        self._browser = None
        self._context = None
        self._playwright = None
        self._pages = []
        self._page = None
