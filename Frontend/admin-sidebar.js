(() => {
  const protectAdminPage = async () => {
    const pendingStyle = document.createElement('style');
    pendingStyle.textContent = 'html.kt-admin-auth-pending body{visibility:hidden}';
    document.head.append(pendingStyle);
    document.documentElement.classList.add('kt-admin-auth-pending');

    const token = localStorage.getItem('kieltechToken') || '';
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const loginUrl = `/login.html?return_to=${encodeURIComponent(returnTo)}`;

    const isLocal = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
    const apiBase = window.KIELTECH_API_BASE_URL
      || (isLocal
        ? `http://${window.location.hostname || 'localhost'}:8000`
        : 'https://kieltech-backend.onrender.com');

    try {
      const response = await fetch(`${apiBase}/v1/auth/me`, {
        credentials: 'include',
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        localStorage.removeItem('kieltechToken');
        window.location.replace(loginUrl);
        return;
      }
      if (payload.admin_role_status === 'unavailable') {
        throw new Error('Administrator role verification is temporarily unavailable. Please try again.');
      }
      if (!response.ok) throw new Error(payload.detail || 'Unable to verify administrator access.');
      if (payload.user?.is_admin !== true) {
        window.location.replace('/index.html');
        return;
      }
      if (
        ['/owner/admins', '/admin-owner.html'].includes(window.location.pathname)
        && payload.user?.is_owner !== true
      ) {
        window.location.replace(`${apiBase.replace(/\/+$/, '')}/admin/dashboard`);
        return;
      }
      document.documentElement.classList.remove('kt-admin-auth-pending');
    } catch (error) {
      console.error('Unable to verify administrator access:', error);
      document.documentElement.classList.remove('kt-admin-auth-pending');
      const message = document.createElement('main');
      message.setAttribute('role', 'alert');
      message.textContent = error.message || 'Administrator access could not be verified. Check your connection and try again.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => window.location.reload());
      const home = document.createElement('a');
      home.href = '/index.html';
      home.textContent = 'Return to homepage';
      message.append(document.createElement('br'), retry, document.createTextNode(' '), home);
      document.body.replaceChildren(message);
    }
  };

  void protectAdminPage();

  const links = [
    { href: '/admin-dashboard.html', label: 'Dashboard', icon: '⌂' },
    { href: '/admin-customers.html', label: 'Customers', icon: '◌' },
    { href: '/admin-ai-studio.html', label: 'AI Studio', icon: '✦' },
    { href: '/admin-email.html', label: 'Email', icon: '@' },
    { href: '/admin-model-reviews.html', label: 'Models review', icon: '★' },
    { href: '/admin-models.html', label: 'Models', icon: '▤' },
    { href: '/admin-enterprise-keys.html', label: 'Enterprise Key', icon: '⌑' },
    { href: '/admin-free-credit.html', label: 'Free credit', icon: '$' },
    { href: '/admin-chat-templates.html', label: 'Templates', icon: '▦' },
    { href: '/admin-uptime-policy.html', label: 'Uptime Policy', icon: '◷' },
    { href: '/admin-uptime-history.html', label: 'Uptime History', icon: '◴' }
  ];

  const routeAliases = new Map([
    ['/admin/dashboard', '/admin-dashboard.html'],
    ['/admin/customers', '/admin-customers.html'],
    ['/admin/ai-studio', '/admin-ai-studio.html'],
    ['/admin/email', '/admin-email.html'],
    ['/admin/model-reviews', '/admin-model-reviews.html'],
    ['/admin/enterprise-keys', '/admin-enterprise-keys.html'],
    ['/admin/free-credit', '/admin-free-credit.html'],
    ['/admin/chat-templates', '/admin-chat-templates.html'],
    ['/admin/uptime-policy', '/admin-uptime-policy.html'],
    ['/admin/uptime-policy/history', '/admin-uptime-history.html']
  ]);

  const addStyles = () => {
    if (document.getElementById('kieltech-admin-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'kieltech-admin-sidebar-styles';
    style.textContent = `
      body.kt-admin-theme{--kt-admin-accent:#35c9f4;--kt-admin-accent-strong:#1687c4;--kt-admin-accent-soft:rgba(35,148,202,.14);--kt-admin-border:rgba(53,201,244,.2);--model-page:#071726;--model-surface:#0b2036;--model-border:rgba(53,201,244,.18);--model-accent:#35c9f4;--template-page:#071726;--template-surface:#0b2036;--template-surface-raised:#112c47;--template-border:rgba(53,201,244,.18);--template-accent:#35c9f4;--template-muted:#95aec1;background-color:#071726!important;color:#eaf5ff}
      body.kt-admin-theme .shell,body.kt-admin-theme .admin-slide-shell{background-color:#071726!important;background-image:radial-gradient(circle at top left,rgba(35,148,202,.12),transparent 30%),linear-gradient(135deg,#071726 0%,#0b2036 100%)!important}
      body.kt-admin-theme.admin-page>div:first-child{background-image:radial-gradient(circle at top left,rgba(35,148,202,.12),transparent 28%),linear-gradient(135deg,#071726 0%,#0b2036 100%)!important}
      body.kt-admin-theme :is(.panel,.card,.stat,.platform-card,.pricing-card,.model-category,.template-section,.review-table,.review-heading,.summary,.check,.row){background-color:#0b2036!important;border-color:var(--kt-admin-border)!important}
      body.kt-admin-theme :is(input,select,textarea,.template-control,.model-control){background-color:#071726!important;border-color:rgba(53,201,244,.18)!important}
      body.kt-admin-theme [class*="bg-slate-950"]{background-color:#071726!important}
      body.kt-admin-theme [class*="bg-slate-900"]{background-color:#0b2036!important}
      body.kt-admin-theme [class*="bg-slate-800"]{background-color:#112c47!important}
      body.kt-admin-theme [class*="text-blue-"],body.kt-admin-theme [class*="text-sky-"],body.kt-admin-theme [class*="text-brand-"]{color:var(--kt-admin-accent)!important}
      body.kt-admin-theme [class*="border-blue-"],body.kt-admin-theme [class*="border-sky-"],body.kt-admin-theme [class*="border-brand-"]{border-color:var(--kt-admin-border)!important}
      body.kt-admin-theme [class*="bg-blue-"],body.kt-admin-theme [class*="bg-sky-"],body.kt-admin-theme [class*="bg-brand-"]{background-color:var(--kt-admin-accent-soft)!important}
      body.kt-admin-theme [class~="bg-brand-500"]{background-color:var(--kt-admin-accent)!important;color:#061525!important}
      body.kt-admin-theme [class*="bg-brand-500/"]{background-color:var(--kt-admin-accent-soft)!important}
      body.kt-admin-theme :is(.btn-primary,.button-primary,.models-action--primary,.api-button,.refresh),body.kt-admin-theme .button:not(.button-danger):not(.delete-button){background-color:var(--kt-admin-accent)!important;border-color:var(--kt-admin-accent)!important;color:#061525!important;box-shadow:none!important}
      body.kt-admin-theme :is(.btn-primary,.button-primary,.models-action--primary,.api-button,.refresh):hover,body.kt-admin-theme .button:not(.button-danger):not(.delete-button):hover{background-color:#9be9ff!important;border-color:#9be9ff!important;color:#061525!important}
      body.kt-admin-theme :is(.button-danger,.btn-danger,.delete-button){background-color:rgba(248,113,113,.12)!important;border-color:rgba(248,113,113,.4)!important;color:#fca5a5!important}
      body.kt-admin-theme :is(.eyebrow,.api-link,.platform-pill,.text-link){color:var(--kt-admin-accent)!important}
      body.kt-admin-theme :is(input,select,textarea,button,a,[tabindex]):focus-visible{outline-color:var(--kt-admin-accent-strong)!important;border-color:var(--kt-admin-accent-strong)!important;box-shadow:0 0 0 3px rgba(35,148,202,.18)!important}
      body.kt-admin-theme :is(.kt-admin-sidebar-toggle,#sidebarToggle,#sidebarToggleButton,.admin-review-sidebar-toggle){border-color:var(--kt-admin-border)!important;color:var(--kt-admin-accent)!important}
      body.kt-admin-theme #sidebarToggle,body.kt-admin-theme #sidebarToggleButton,body.kt-admin-theme .admin-review-sidebar-toggle{background:#0b2036!important}
      body.kt-admin-theme .chip.active{border-color:var(--kt-admin-border)!important;background:var(--kt-admin-accent-soft)!important;color:#e8f7ff!important}
      body.kt-admin-theme .sidebar-btn:hover,body.kt-admin-theme .sidebar-btn.active{border-color:var(--kt-admin-border)!important;background:var(--kt-admin-accent-soft)!important;color:#e8f7ff!important}
      body.kt-admin-theme .tab.is-active,body.kt-admin-theme .scope-button.is-active{border-color:var(--kt-admin-border)!important;background:var(--kt-admin-accent-soft)!important;color:#e8f7ff!important}
      body.kt-admin-theme .kt-admin-sidebar-toggle{background:#0b2036!important}
      body.kt-admin-theme [style*="#2f6fed"],body.kt-admin-theme [style*="#347fe9"],body.kt-admin-theme [style*="#3b82f6"],body.kt-admin-theme [style*="#7dd3fc"],body.kt-admin-theme [style*="#38bdf8"]{border-color:var(--kt-admin-border)!important}
      body.kt-admin-theme [style*="#2f6fed"],body.kt-admin-theme [style*="#347fe9"],body.kt-admin-theme [style*="#3b82f6"],body.kt-admin-theme [style*="#7dd3fc"],body.kt-admin-theme [style*="#38bdf8"]{color:var(--kt-admin-accent)!important}
      body.kt-admin-theme button[style*="#2f6fed"],body.kt-admin-theme button[style*="#347fe9"],body.kt-admin-theme a[style*="#347fe9"]{background-color:var(--kt-admin-accent)!important;color:#061525!important}
      body.kt-admin-theme svg [stroke="#3b82f6"],body.kt-admin-theme svg [stroke="#60a5fa"],body.kt-admin-theme svg [stroke="#7dd3fc"],body.kt-admin-theme svg [stroke="#38bdf8"]{stroke:#35c9f4!important}
      body.kt-admin-theme svg [fill="#3b82f6"],body.kt-admin-theme svg [fill="#60a5fa"],body.kt-admin-theme svg [fill="#7dd3fc"],body.kt-admin-theme svg [fill="#38bdf8"]{fill:#35c9f4!important}
      body.kt-admin-theme svg [stroke="rgb(59,130,246)"],body.kt-admin-theme svg [stroke="rgb(96,165,250)"],body.kt-admin-theme svg [stroke="rgb(125,211,252)"]{stroke:#35c9f4!important}
      body.kt-admin-theme svg [fill="rgb(59,130,246)"],body.kt-admin-theme svg [fill="rgb(96,165,250)"],body.kt-admin-theme svg [fill="rgb(125,211,252)"]{fill:#35c9f4!important}
      .kt-admin-sidebar-toggle{position:fixed;top:1rem;left:1rem;z-index:1002;display:grid;width:44px;height:44px;place-items:center;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:#0c1420;color:#e5edf7;cursor:pointer}
      .kt-admin-sidebar-toggle svg{width:20px;height:20px}
      .kt-admin-sidebar-backdrop{position:fixed;inset:0;z-index:1000;border:0;background:rgba(3,8,20,.72)}
      .kt-admin-sidebar-backdrop[hidden]{display:none}
      .kt-admin-sidebar{position:fixed;inset:0 auto 0 0;z-index:1001;box-sizing:border-box;width:min(20rem,86vw);height:100vh;height:100dvh;overflow-y:auto;padding:1.25rem;border-right:1px solid rgba(255,255,255,.12);background:#071726;color:#e5edf7;transform:translateX(-105%);transition:transform .2s ease}
      .kt-admin-sidebar.is-open{transform:translateX(0)}
      body.kt-admin-sidebar-open{overflow:hidden}
      .kt-admin-sidebar__brand{display:flex;align-items:center;gap:.65rem;margin:0 0 1.25rem;color:#f8fafc;font-size:1rem;font-weight:700}
      .kt-admin-sidebar__brand-mark{width:38px;height:38px;flex:0 0 auto;object-fit:contain}
      .kt-admin-sidebar__nav{display:grid;gap:.5rem}
      .kt-admin-sidebar-link{box-sizing:border-box;display:flex;align-items:center;gap:.75rem;width:100%;min-height:54px;margin-top:.5rem;padding:.625rem .75rem;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.04);color:#cbd5e1;font:inherit;text-decoration:none}
      .kt-admin-sidebar-link[href="/admin-dashboard.html"]{margin-top:2rem}
      .kt-admin-sidebar-link:hover,.kt-admin-sidebar-link[aria-current="page"]{border-color:var(--kt-admin-border);background:var(--kt-admin-accent-soft);color:#e8f7ff}
      .kt-admin-sidebar-link__icon{display:grid;box-sizing:border-box;width:2rem;height:2rem;flex:0 0 2rem;place-items:center;border-radius:8px;background:rgba(255,255,255,.05);color:var(--kt-admin-accent);text-align:center}
    `;
    document.head.append(style);
  };

  const resolvePath = (value) => {
    try {
      const path = new URL(value, window.location.origin).pathname;
      return routeAliases.get(path) || path;
    } catch {
      return value;
    }
  };

  const createLink = ({ href, label, icon }) => {
    const link = document.createElement('a');
    link.className = 'kt-admin-sidebar-link';
    link.href = href;
    link.innerHTML = `<span class="kt-admin-sidebar-link__icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
    if (new URL(href, window.location.origin).pathname === window.location.pathname) {
      link.setAttribute('aria-current', 'page');
    }
    return link;
  };

  const initialize = () => {
    document.body.classList.add('kt-admin-theme');
    addStyles();

    const sidebar = document.querySelector('#sidebar, #adminSidebar, .shell > div > aside');
    if (sidebar) {
      const brandLabel = [...sidebar.querySelectorAll('p')].find((item) => item.textContent.trim() === 'KielTech');
      if (brandLabel && !sidebar.querySelector('.kt-admin-sidebar__brand-mark, img[src="/KielTech-logo.png"]')) {
        const brandMark = document.createElement('img');
        brandMark.className = 'kt-admin-sidebar__brand-mark';
        brandMark.src = '/KielTech-logo.png';
        brandMark.alt = '';
        brandLabel.style.display = 'flex';
        brandLabel.style.alignItems = 'center';
        brandLabel.style.gap = '.65rem';
        brandLabel.prepend(brandMark);
      }
      const existingToggle = document.querySelector('#sidebarToggle, #sidebarToggleButton, .admin-review-sidebar-toggle');
      const presentPaths = new Set();
      const currentPath = resolvePath(window.location.pathname);

      sidebar.querySelectorAll('a[href], [data-nav-target]').forEach((item) => {
        const attribute = item.matches('[data-nav-target]') ? 'data-nav-target' : 'href';
        const original = item.getAttribute(attribute);
        const canonical = resolvePath(original);
        item.setAttribute(attribute, canonical);
        presentPaths.add(canonical);
        if (item.matches('a[href]')) {
          item.classList.remove('bg-brand-500/10', 'border-brand-500/20', 'text-white');
          if (canonical === currentPath) item.setAttribute('aria-current', 'page');
          else item.removeAttribute('aria-current');
        }
      });

      const container = sidebar.querySelector('nav') || sidebar;
      container.querySelectorAll('a[href]').forEach((anchor) => anchor.classList.add('kt-admin-sidebar-link'));
      const firstLink = container.querySelector('a[href]');
      const insertBefore = container.querySelector('a[href="/admin-uptime-policy.html"], a[href="/admin-uptime-policy"]');
      links.forEach((link) => {
        if (presentPaths.has(link.href)) return;
        const anchor = createLink(link);
        if (link.href === '/admin-dashboard.html' && firstLink?.parentElement === container) container.insertBefore(anchor, firstLink);
        else if (insertBefore?.parentElement === container) container.insertBefore(anchor, insertBefore);
        else container.append(anchor);
        presentPaths.add(link.href);
        anchor.addEventListener('click', () => {
          if (existingToggle?.getAttribute('aria-expanded') === 'true') existingToggle.click();
        });
      });
      return;
    }

    const toggle = document.createElement('button');
    toggle.className = 'kt-admin-sidebar-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Open admin sidebar');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>';

    const backdrop = document.createElement('button');
    backdrop.className = 'kt-admin-sidebar-backdrop';
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', 'Close admin sidebar');
    backdrop.hidden = true;

    const sidebarPanel = document.createElement('aside');
    sidebarPanel.className = 'kt-admin-sidebar';
    sidebarPanel.setAttribute('aria-label', 'Admin navigation');
    sidebarPanel.innerHTML = '<div class="kt-admin-sidebar__brand"><img class="kt-admin-sidebar__brand-mark" src="/KielTech-logo.png" alt=""><span>KielTech Admin</span></div><nav class="kt-admin-sidebar__nav"></nav>';
    const nav = sidebarPanel.querySelector('nav');
    links.forEach((link) => nav.append(createLink(link)));
    document.body.append(toggle, backdrop, sidebarPanel);

    const closeSidebar = () => {
      sidebarPanel.classList.remove('is-open');
      document.body.classList.remove('kt-admin-sidebar-open');
      backdrop.hidden = true;
      toggle.setAttribute('aria-label', 'Open admin sidebar');
      toggle.setAttribute('aria-expanded', 'false');
    };
    const openSidebar = () => {
      sidebarPanel.classList.add('is-open');
      document.body.classList.add('kt-admin-sidebar-open');
      backdrop.hidden = false;
      toggle.setAttribute('aria-label', 'Close admin sidebar');
      toggle.setAttribute('aria-expanded', 'true');
    };

    toggle.addEventListener('click', () => {
      if (sidebarPanel.classList.contains('is-open')) closeSidebar();
      else openSidebar();
    });
    backdrop.addEventListener('click', closeSidebar);
    nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeSidebar));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSidebar();
    });
  };

  document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();