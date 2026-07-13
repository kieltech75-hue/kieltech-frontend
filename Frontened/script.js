const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:5000'
  : 'https://kieltech-backend.onrender.com';

const state = {
  token: localStorage.getItem('kieltechToken') || ''
};

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function init() {
  const promptInput = document.getElementById('promptInput');
  const askButton = document.getElementById('askButton');
  const demoResponse = document.getElementById('demoResponse');
  const contactForm = document.getElementById('contactForm');
  const formMessage = document.getElementById('formMessage');
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const authMessage = document.getElementById('authMessage');
  const downloadList = document.getElementById('downloadList');
  const dashboardPanel = document.getElementById('dashboardPanel');

  if (askButton && promptInput && demoResponse) {
    askButton.addEventListener('click', async () => {
      const prompt = promptInput.value.trim();
      if (!prompt) {
        demoResponse.textContent = 'Please enter a prompt first.';
        return;
      }

      demoResponse.textContent = 'Thinking...';
      try {
        const data = await request('/api/ai/chat', {
          method: 'POST',
          body: JSON.stringify({ prompt })
        });
        demoResponse.textContent = data.reply || 'No response received.';
      } catch (error) {
        demoResponse.textContent = error.message;
      }
    });
  }

  if (contactForm && formMessage) {
    contactForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(contactForm).entries());
      formMessage.textContent = 'Sending...';
      try {
        const data = await request('/api/contact', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        formMessage.textContent = data.message || 'Thanks for reaching out.';
        contactForm.reset();
      } catch (error) {
        formMessage.textContent = error.message;
      }
    });
  }

  if (loginForm && authMessage) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(loginForm).entries());
      authMessage.textContent = 'Signing in...';
      try {
        const data = await request('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        state.token = data.token;
        localStorage.setItem('kieltechToken', data.token);
        authMessage.textContent = `Welcome back, ${data.user.name}!`;
        window.location.href = 'dashboard.html';
      } catch (error) {
        authMessage.textContent = error.message;
      }
    });
  }

  if (signupForm && authMessage) {
    signupForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(signupForm).entries());
      authMessage.textContent = 'Creating account...';
      try {
        await request('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        authMessage.textContent = 'Account created. Please log in.';
        window.location.href = 'login.html';
      } catch (error) {
        authMessage.textContent = error.message;
      }
    });
  }

  if (downloadList) {
    loadDownloads();
  }

  if (dashboardPanel) {
    loadDashboard();
  }
}

async function loadDownloads() {
  const downloadList = document.getElementById('downloadList');
  if (!downloadList) return;

  try {
    const data = await request('/api/downloads');
    const ratingsData = await request('/api/ratings');
    const ratingsByItem = {};
    for (const rating of ratingsData.ratings || []) {
      ratingsByItem[rating.item_id] = (ratingsByItem[rating.item_id] || []).concat(rating.rating);
    }

    downloadList.innerHTML = '';
    data.downloads.forEach((download) => {
      const average = ratingsByItem[download.id]?.length
        ? (ratingsByItem[download.id].reduce((sum, value) => sum + value, 0) / ratingsByItem[download.id].length).toFixed(1)
        : 'No ratings yet';

      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <h3>${download.title}</h3>
        <p>${download.description}</p>
        <p class="demo-response">Downloads: ${download.downloads_count}</p>
        <p class="demo-response">Average rating: ${average}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-download-id="${download.id}">Download</button>
          <button class="btn btn-secondary" data-rate-item="${download.id}" data-rating="5">★</button>
          <button class="btn btn-secondary" data-rate-item="${download.id}" data-rating="4">★</button>
          <button class="btn btn-secondary" data-rate-item="${download.id}" data-rating="3">★</button>
        </div>
      `;
      downloadList.appendChild(card);
    });

    downloadList.querySelectorAll('[data-download-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-download-id');
        try {
          const data = await request(`/api/downloads/${id}`, { method: 'POST' });
          button.textContent = data.message;
        } catch (error) {
          button.textContent = error.message;
        }
      });
    });

    downloadList.querySelectorAll('[data-rate-item]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemId = button.getAttribute('data-rate-item');
        const rating = Number(button.getAttribute('data-rating'));
        try {
          await request('/api/ratings', {
            method: 'POST',
            body: JSON.stringify({ item_id: Number(itemId), rating })
          });
          button.textContent = 'Rated';
          loadDownloads();
        } catch (error) {
          button.textContent = error.message;
        }
      });
    });
  } catch (error) {
    downloadList.innerHTML = `<div class="card"><p>${error.message}</p></div>`;
  }
}

async function loadDashboard() {
  const dashboardPanel = document.getElementById('dashboardPanel');
  if (!dashboardPanel) return;

  if (!state.token) {
    dashboardPanel.innerHTML = '<div class="card"><h3>Access required</h3><p>Please <a href="login.html" class="text-link">log in</a> to view your dashboard.</p></div>';
    return;
  }

  try {
    const profile = await request('/api/auth/me');
    const stats = await request('/api/admin/stats').catch(() => null);
    const moderation = profile.user.is_admin ? await request('/api/admin/moderation').catch(() => null) : null;

    const statCards = stats?.stats ? `
      <div class="dashboard-grid">
        <div class="stat-card">
          <span class="stat-label">Pending downloads</span>
          <strong>${stats.stats.pendingDownloads}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Pending ratings</span>
          <strong>${stats.stats.pendingRatings}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Approved downloads</span>
          <strong>${stats.stats.approvedDownloads}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Approved ratings</span>
          <strong>${stats.stats.approvedRatings}</strong>
        </div>
      </div>
    ` : '';

    const moderationMarkup = profile.user.is_admin && moderation ? `
      <div class="card">
        <h3>Moderation queue</h3>
        <div class="list-stack">
          ${(moderation.downloads || []).map((item) => `
            <div class="list-item">
              <div>
                <strong>${item.title}</strong>
                <p class="demo-response">Pending download review</p>
              </div>
              <div class="hero-actions">
                <button class="btn btn-primary" data-admin-action="downloads" data-id="${item.id}" data-action="approve">Approve</button>
                <button class="btn btn-secondary" data-admin-action="downloads" data-id="${item.id}" data-action="reject">Reject</button>
              </div>
            </div>
          `).join('')}
          ${(moderation.ratings || []).map((item) => `
            <div class="list-item">
              <div>
                <strong>Rating #${item.id}</strong>
                <p class="demo-response">Score: ${item.rating}/5</p>
              </div>
              <div class="hero-actions">
                <button class="btn btn-primary" data-admin-action="ratings" data-id="${item.id}" data-action="approve">Approve</button>
                <button class="btn btn-secondary" data-admin-action="ratings" data-id="${item.id}" data-action="reject">Reject</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    dashboardPanel.innerHTML = `
      <div class="dashboard-shell">
        <div class="card dashboard-hero">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>Welcome back, ${profile.user.name}</h2>
            <p class="hero-copy">Your account is connected to the KielTech dashboard with secure access to downloads, ratings, and moderation tools.</p>
          </div>
          <div class="pill">${profile.user.is_admin ? 'Admin access active' : 'Member access'}</div>
        </div>
        ${statCards}
        <div class="card">
          <h3>Account details</h3>
          <p class="demo-response">Email: ${profile.user.email}</p>
          <p class="demo-response">Role: ${profile.user.is_admin ? 'Administrator' : 'Member'}</p>
        </div>
        ${moderationMarkup}
      </div>
    `;

    dashboardPanel.querySelectorAll('[data-admin-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const type = button.getAttribute('data-admin-action');
        const id = button.getAttribute('data-id');
        const action = button.getAttribute('data-action');
        try {
          await request(`/api/admin/moderation/${type}/${id}`, {
            method: 'POST',
            body: JSON.stringify({ action })
          });
          button.textContent = 'Done';
          loadDashboard();
        } catch (error) {
          button.textContent = error.message;
        }
      });
    });
  } catch (error) {
    dashboardPanel.innerHTML = `<div class="card"><h3>Session expired</h3><p>${error.message}</p></div>`;
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('kieltech-theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const shouldUseLight = savedTheme ? savedTheme === 'light' : prefersLight;

  document.body.classList.toggle('light-mode', shouldUseLight);
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.innerHTML = `
      <span class="theme-toggle__icon theme-toggle__icon--moon">🌙</span>
      <span class="theme-toggle__icon theme-toggle__icon--sun">☀️</span>
    `;
    toggle.setAttribute('aria-pressed', String(shouldUseLight));
  }
}

function bindThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light-mode');
    const nextTheme = isLight ? 'light' : 'dark';
    localStorage.setItem('kieltech-theme', nextTheme);
    toggle.setAttribute('aria-pressed', String(isLight));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindThemeToggle();
  init();
});
