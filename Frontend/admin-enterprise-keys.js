(() => {
  const apiBase = window.KIELTECH_API_BASE_URL
    || (['localhost', '127.0.0.1', ''].includes(window.location.hostname)
      ? `http://${window.location.hostname || 'localhost'}:8000`
      : 'https://kieltech-backend.onrender.com');
  let token = localStorage.getItem('kieltechToken') || '';
  const pageStatus = document.getElementById('enterprisePageStatus');
  const requestsBody = document.getElementById('enterpriseRequestsBody');
  const keysBody = document.getElementById('enterpriseKeysBody');
  const modelsRoot = document.getElementById('enterpriseModels');
  const modelCount = document.getElementById('enterpriseModelCount');
  const form = document.getElementById('enterpriseKeyForm');
  const emailInput = document.getElementById('enterpriseEmail');
  const rpmSelect = document.getElementById('enterpriseRpm');
  const customRpmField = document.getElementById('enterpriseCustomRpmField');
  const customRpmInput = document.getElementById('enterpriseCustomRpm');
  const issueButton = document.getElementById('enterpriseIssueButton');
  const generatedPanel = document.getElementById('enterpriseGenerated');
  const generatedKey = document.getElementById('enterpriseGeneratedKey');
  const sendKeyButton = document.getElementById('enterpriseSendKey');
  const keyDeliveryStatus = document.getElementById('enterpriseKeyDeliveryStatus');
  let requests = [];
  let selectedRequestId = null;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  const setStatus = (message, kind = '') => {
    pageStatus.textContent = message;
    if (kind) pageStatus.dataset.kind = kind;
    else delete pageStatus.dataset.kind;
  };

  const apiRequest = async (path, options = {}) => {
    token = localStorage.getItem('kieltechToken') || '';
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : payload.error;
      const error = new Error(detail || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const dateLabel = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const renderRequests = () => {
    if (!requests.length) {
      requestsBody.innerHTML = '<tr><td class="enterprise-empty" colspan="4">No enterprise requests have been submitted yet.</td></tr>';
      return;
    }
    requestsBody.innerHTML = requests.map((item, index) => `
      <tr>
        <td><span class="enterprise-table__primary">${escapeHtml(item.contact_name)}</span><span class="enterprise-table__secondary">${escapeHtml(item.contact_email)} · ${escapeHtml(item.company || 'Company not provided')}</span></td>
        <td><span class="enterprise-table__primary">${escapeHtml(item.services || 'Model not specified')}</span><span class="enterprise-table__secondary">${escapeHtml(item.estimated_usage || '')} ${escapeHtml(item.deployment_requirements || '')}</span></td>
        <td>${escapeHtml(dateLabel(item.created_at))}</td>
        <td><button class="enterprise-button" type="button" data-configure-request="${index}">Configure</button></td>
      </tr>`).join('');
  };

  const renderKeys = (keys) => {
    if (!keys.length) {
      keysBody.innerHTML = '<tr><td class="enterprise-empty" colspan="5">No enterprise keys have been issued yet.</td></tr>';
      return;
    }
    keysBody.innerHTML = keys.map((item) => `
      <tr>
        <td><span class="enterprise-table__primary">${escapeHtml(item.client_email || 'Unbound')}</span><span class="enterprise-table__secondary">${item.redeemed_by ? `Redeemed by ${escapeHtml(item.redeemed_by)}` : `Issued ${escapeHtml(dateLabel(item.created_at))}`}</span></td>
        <td><span class="enterprise-pill" data-status="${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
        <td>${Number(item.model_ids?.length || 0)} model${item.model_ids?.length === 1 ? '' : 's'}</td>
        <td>${escapeHtml(item.rpm_limit === 'unlimited' ? 'Unlimited' : `${item.rpm_limit} RPM`)}</td>
        <td>${escapeHtml(dateLabel(item.expires_at))}</td>
      </tr>`).join('');
  };

  const renderModels = (models) => {
    const readyModels = models.filter((model) => model.is_ready === true && model.is_configured === true);
    modelCount.textContent = readyModels.length ? `(${readyModels.length} ready)` : '(none ready)';
    if (!readyModels.length) {
      modelsRoot.innerHTML = '<p class="enterprise-models__empty">There are no ready, configured catalog models to assign. Configure a model first.</p>';
      issueButton.disabled = true;
      return;
    }
    issueButton.disabled = false;
    modelsRoot.innerHTML = readyModels.map((model) => `
      <label class="enterprise-model">
        <input type="checkbox" name="model_ids" value="${escapeHtml(model.model_id)}">
        <span><strong>${escapeHtml(model.display_name || model.model_id)}</strong><small>${escapeHtml(model.model_id)} · ${escapeHtml(model.category || 'Model')}</small></span>
      </label>`).join('');
  };

  const refresh = async () => {
    setStatus('Loading enterprise requests, models, and key history…');
    requestsBody.innerHTML = '<tr><td class="enterprise-empty" colspan="4">Loading enterprise requests…</td></tr>';
    keysBody.innerHTML = '<tr><td class="enterprise-empty" colspan="5">Loading issued keys…</td></tr>';
    try {
      const [requestData, keyData, catalogData] = await Promise.all([
        apiRequest('/admin/enterprise/requests'),
        apiRequest('/admin/enterprise/keys'),
        apiRequest('/v1/models/catalog')
      ]);
      requests = Array.isArray(requestData.requests) ? requestData.requests : [];
      renderRequests();
      renderKeys(Array.isArray(keyData.keys) ? keyData.keys : []);
      renderModels(Array.isArray(catalogData.models) ? catalogData.models : []);
      setStatus('');
    } catch (error) {
      requestsBody.innerHTML = '<tr><td class="enterprise-empty" colspan="4">Could not load enterprise requests.</td></tr>';
      keysBody.innerHTML = '<tr><td class="enterprise-empty" colspan="5">Could not load issued keys.</td></tr>';
      if (error.status === 401) {
        try {
          const { user } = await apiRequest('/v1/auth/me');
          setStatus(user?.is_admin
            ? 'Your administrator session was rejected. Sign out and sign in again, then refresh.'
            : 'You are signed in, but this account does not have administrator access.',
          'error');
        } catch (authError) {
          setStatus(authError.status === 401
            ? 'Your sign-in session is expired or unavailable on this site. Sign in again, then refresh.'
            : error.message,
          'error');
        }
      } else {
        setStatus(error.message, 'error');
      }
    }
  };

  requestsBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-configure-request]');
    if (!button) return;
    const item = requests[Number(button.dataset.configureRequest)];
    if (!item) return;
    selectedRequestId = item.request_id;
    emailInput.value = item.contact_email || '';
    document.getElementById('enterpriseIssueButton').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setStatus(`Request from ${item.contact_name} selected. Choose models and issue settings.`, 'success');
  });

  rpmSelect.addEventListener('change', () => {
    const custom = rpmSelect.value === 'custom';
    customRpmField.hidden = !custom;
    customRpmInput.disabled = !custom;
    customRpmInput.required = custom;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const modelIds = [...modelsRoot.querySelectorAll('input[name="model_ids"]:checked')].map((input) => input.value);
    if (!modelIds.length) {
      setStatus('Select at least one ready model before generating a key.', 'error');
      return;
    }
    const rpmLimit = rpmSelect.value === 'custom' ? customRpmInput.value : rpmSelect.value;
    const payload = {
      client_email: emailInput.value.trim(),
      duration_days: Number(document.getElementById('enterpriseDuration').value),
      rpm_limit: rpmLimit,
      model_ids: modelIds,
      ...(selectedRequestId ? { request_id: selectedRequestId } : {})
    };
    issueButton.disabled = true;
    issueButton.textContent = 'Generating…';
    generatedPanel.hidden = true;
    setStatus('Generating a single-use key…');
    try {
      const result = await apiRequest('/admin/enterprise/keys', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      generatedKey.textContent = result.passkey;
      generatedPanel.hidden = false;
      keyDeliveryStatus.textContent = `Activation deadline: ${dateLabel(result.activation_expires_at)}. The ${result.access_duration_days}-day access period starts when the requester redeems the key.`;
      setStatus(result.message || 'Enterprise key generated.', 'success');
      await refresh();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      issueButton.disabled = false;
      issueButton.textContent = 'Generate enterprise key';
    }
  });

  document.getElementById('enterpriseCopyKey').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(generatedKey.textContent);
      setStatus('Key copied to clipboard. Store and share it securely.', 'success');
    } catch {
      setStatus('Clipboard access failed. Select and copy the key manually.', 'error');
    }
  });

  sendKeyButton.addEventListener('click', async () => {
    const passkey = generatedKey.textContent.trim();
    const clientEmail = emailInput.value.trim();
    if (!passkey || !clientEmail) {
      setStatus('Generate a key and provide the requester email before sending.', 'error');
      return;
    }
    sendKeyButton.disabled = true;
    sendKeyButton.textContent = 'Sending…';
    setStatus(`Sending the key to ${clientEmail}…`);
    try {
      const result = await apiRequest('/admin/enterprise/keys/send', {
        method: 'POST',
        body: JSON.stringify({ passkey, client_email: clientEmail })
      });
      keyDeliveryStatus.textContent = result.message;
      setStatus(result.message, 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      sendKeyButton.disabled = false;
      sendKeyButton.textContent = 'Send to requester';
    }
  });

  document.getElementById('enterpriseRefresh').addEventListener('click', refresh);
  refresh();
})();
