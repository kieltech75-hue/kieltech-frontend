(() => {
  const localHosts = ['localhost', '127.0.0.1', ''];
  const apiBase = (window.KIELTECH_API_BASE_URL
    || (localHosts.includes(window.location.hostname)
      ? `http://${window.location.hostname || 'localhost'}:8000`
      : 'https://kieltech-backend.onrender.com')).replace(/\/+$/, '');
  const token = localStorage.getItem('kieltechToken') || '';
  const status = document.getElementById('ownerRoleStatus');
  const rows = document.getElementById('ownerUserRows');
  const search = document.getElementById('ownerUserSearch');
  let users = [];

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  const setStatus = (message, state = '') => {
    status.textContent = message;
    status.dataset.state = state;
  };

  const request = async (path, options = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      credentials: 'include',
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'The role request could not be completed.');
    return payload;
  };

  const renderUsers = () => {
    const query = search.value.trim().toLowerCase();
    const filtered = users.filter((user) =>
      [user.name, user.username, user.email].some((value) => String(value || '').toLowerCase().includes(query))
    );
    if (!filtered.length) {
      rows.innerHTML = `<tr><td colspan="3" class="owner-empty">${users.length ? 'No matching accounts.' : 'No Google-linked accounts were found.'}</td></tr>`;
      return;
    }
    rows.innerHTML = filtered.map((user) => {
      const role = user.role === 'owner' ? 'Owner' : user.role === 'admin' ? 'Admin' : 'User';
      const action = user.role === 'owner'
        ? '<span class="owner-role">Protected</span>'
        : user.role === 'admin'
          ? `<button class="owner-action owner-action--remove" type="button" data-admin-uid="${escapeHtml(user.firebase_uid)}" data-enable="false">Revoke admin</button>`
          : `<button class="owner-action" type="button" data-admin-uid="${escapeHtml(user.firebase_uid)}" data-enable="true">Make admin</button>`;
      return `<tr>
        <td><strong>${escapeHtml(user.name || user.email)}</strong><small>${escapeHtml(user.email)}</small>${user.username ? `<small>@${escapeHtml(user.username)}</small>` : ''}</td>
        <td><span class="owner-role">${role}</span></td>
        <td>${action}</td>
      </tr>`;
    }).join('');
  };

  const loadUsers = async () => {
    setStatus('Loading linked accounts…');
    try {
      const payload = await request('/owner/admins/users');
      users = Array.isArray(payload.users) ? payload.users : [];
      renderUsers();
      setStatus(`${users.length} Google-linked account${users.length === 1 ? '' : 's'} loaded.`);
    } catch (error) {
      console.error('Unable to load owner-managed account roles:', error);
      setStatus(error.message || 'Unable to load linked accounts. Try again.', 'error');
      rows.innerHTML = '<tr><td colspan="3" class="owner-empty">Account roles could not be loaded.</td></tr>';
    }
  };

  rows.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-admin-uid]');
    if (!button || button.disabled) return;
    const enabled = button.dataset.enable === 'true';
    const user = users.find((item) => item.firebase_uid === button.dataset.adminUid);
    if (!user || user.role === 'owner') return;
    if (!enabled && !window.confirm(`Revoke administrator access for ${user.email}?`)) return;
    button.disabled = true;
    setStatus(enabled ? `Granting admin access to ${user.email}…` : `Revoking admin access for ${user.email}…`);
    try {
      const payload = await request(`/owner/admins/users/${encodeURIComponent(user.firebase_uid)}/admin-role`, {
        method: 'PUT',
        body: JSON.stringify({ is_admin: enabled })
      });
      user.role = payload.user.role;
      renderUsers();
      setStatus(`${user.email} is now ${user.role === 'admin' ? 'an admin' : 'a regular user'}.`, 'success');
    } catch (error) {
      console.error('Unable to update administrator access:', error);
      button.disabled = false;
      setStatus(error.message || 'Unable to update the role. Try again.', 'error');
    }
  });

  search.addEventListener('input', renderUsers);
  void loadUsers();
})();
