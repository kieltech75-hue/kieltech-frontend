(() => {
  const apiBase = window.KIELTECH_API_BASE_URL
    || (['localhost', '127.0.0.1', ''].includes(window.location.hostname)
      ? `http://${window.location.hostname || 'localhost'}:8000`
      : 'https://kieltech-backend.onrender.com');
  const tabs = [...document.querySelectorAll('[data-audience]')];
  const audienceDescription = document.getElementById('audienceDescription');
  const recipientList = document.getElementById('recipientList');
  const recipientCount = document.getElementById('recipientCount');
  const userSearch = document.getElementById('userSearch');
  const grantSummary = document.getElementById('grantSummary');
  const creditStatus = document.getElementById('creditStatus');
  const creditAmount = document.getElementById('creditAmount');
  const creditReason = document.getElementById('creditReason');
  const sendButton = document.getElementById('sendCreditButton');
  const creditForm = document.getElementById('creditForm');
  const confirmDialog = document.getElementById('creditConfirmDialog');
  let grantConfirmed = false;
  let users = [];
  let audience = 'single';
  let selectedEmail = '';
  let visibleLimit = 30;
  let isLoadingUsers = false;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  const formatUsd = (value) => `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

  const setStatus = (message, kind = '') => {
    creditStatus.textContent = message;
    if (kind) creditStatus.dataset.kind = kind;
    else delete creditStatus.dataset.kind;
  };

  const getAudienceUsers = () => users.filter((user) => {
    if (user.is_blocked || (audience !== 'single' && user.is_admin)) return false;
    if (audience === 'enterprise') return Boolean(user.is_enterprise_dedicated);
    if (audience === 'non_enterprise') return !user.is_enterprise_dedicated;
    return true;
  });

  const getAmount = () => {
    const value = Number(creditAmount.value);
    return Number.isFinite(value) && value > 0 && value <= 10000 ? Math.round(value * 100) / 100 : 0;
  };

  const renderRecipients = () => {
    const eligible = getAudienceUsers();
    if (audience === 'single') {
      const query = userSearch.value.trim().toLocaleLowerCase();
      const matches = eligible.filter((user) => !query
        || String(user.name || '').toLocaleLowerCase().includes(query)
        || String(user.email || '').toLocaleLowerCase().includes(query));
      const shown = matches.slice(0, visibleLimit);
      recipientCount.textContent = query
        ? `Showing ${shown.length} of ${matches.length} matching accounts (${eligible.length} eligible total)`
        : `${eligible.length} eligible account${eligible.length === 1 ? '' : 's'}`;
      recipientList.innerHTML = shown.length
        ? shown.map((user) => `
          <button class="credit-user" type="button" data-email="${escapeHtml(user.email)}" aria-pressed="${selectedEmail === user.email}">
            <span><strong>${escapeHtml(user.name || 'Unnamed user')}</strong><small>${escapeHtml(user.email)}</small></span>
            <span class="credit-user__balance">Wallet<br>${escapeHtml(formatUsd(user.wallet_balance))}</span>
          </button>`).join('')
        : '<div class="credit-empty">No accounts match this search.</div>';
      if (matches.length > shown.length) {
        recipientList.insertAdjacentHTML('beforeend', `<div class="credit-empty">Showing ${shown.length} of ${matches.length}. Refine your search.</div>`);
      }
      recipientList.querySelectorAll('[data-email]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedEmail = button.dataset.email || '';
          renderRecipients();
          updateSummary();
        });
      });
      if (matches.length > shown.length) {
        recipientList.insertAdjacentHTML('beforeend', `<button class="credit-show-more" type="button" data-show-more>Show ${Math.min(visibleLimit, matches.length - shown.length)} more accounts (${matches.length - shown.length} remaining)</button>`);
      }
      recipientList.querySelector('[data-show-more]')?.addEventListener('click', () => {
        visibleLimit += 30;
        renderRecipients();
      });
      return;
    }

    const audienceLabel = audience === 'enterprise' ? 'enterprise' : 'non-enterprise';
    const shown = eligible.slice(0, visibleLimit);
    recipientCount.textContent = `${eligible.length} eligible ${audienceLabel} account${eligible.length === 1 ? '' : 's'}`;
    const preview = shown.map((user) => `
      <div class="credit-user">
        <span><strong>${escapeHtml(user.name || 'Unnamed user')}</strong><small>${escapeHtml(user.email)}</small></span>
        <span class="credit-user__balance">Wallet<br>${escapeHtml(formatUsd(user.wallet_balance))}</span>
      </div>`).join('');
    recipientList.innerHTML = eligible.length
      ? preview
      : `<div class="credit-empty">No active ${audienceLabel} accounts are eligible.</div>`;
    if (eligible.length > shown.length) {
      recipientList.insertAdjacentHTML('beforeend', `<button class="credit-show-more" type="button" data-show-more>Show ${Math.min(visibleLimit, eligible.length - shown.length)} more accounts (${eligible.length - shown.length} remaining)</button>`);
      recipientList.querySelector('[data-show-more]')?.addEventListener('click', () => {
        visibleLimit += 30;
        renderRecipients();
      });
    }
  };

  const updateSummary = () => {
    const eligible = getAudienceUsers();
    const amount = getAmount();
    if (audience === 'single') {
      const selected = eligible.find((user) => user.email === selectedEmail);
      grantSummary.textContent = selected
        ? `${selected.email} will receive ${formatUsd(amount)}. Current wallet balance: ${formatUsd(selected.wallet_balance)}.`
        : 'Select one user to review the grant.';
      sendButton.disabled = !selected || !amount;
      sendButton.textContent = 'Grant free credit';
      return;
    }

    const total = amount * eligible.length;
    const label = audience === 'enterprise' ? 'enterprise users' : 'non-enterprise users';
    grantSummary.textContent = eligible.length
      ? `${eligible.length} ${label} will each receive ${formatUsd(amount)}. Total grant: ${formatUsd(total)}.`
      : `There are no eligible ${label}.`;
    sendButton.disabled = eligible.length === 0 || !amount;
    sendButton.textContent = `Grant to ${eligible.length} users`;
  };

  const setAudience = (nextAudience) => {
    audience = nextAudience;
    selectedEmail = '';
    userSearch.value = '';
    visibleLimit = 30;
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.audience === audience)));
    const descriptions = {
      single: 'Search for one account, then select it to prepare a grant.',
      enterprise: 'The grant applies to every active account currently marked as enterprise.',
      non_enterprise: 'The grant applies to every active account not marked as enterprise.'
    };
    audienceDescription.textContent = descriptions[audience];
    document.getElementById('grantHeading').textContent = audience === 'single' ? 'Grant free credit' : 'Distribute free credit';
    userSearch.hidden = audience !== 'single';
    renderRecipients();
    updateSummary();
    setStatus('');
  };

  const loadUsers = async () => {
    if (isLoadingUsers) return false;
    isLoadingUsers = true;
    const refreshButton = document.getElementById('refreshUsersButton');
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    setStatus('Loading accounts…');
    try {
      const response = await fetch(`${apiBase}/admin/users`, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          ...(localStorage.getItem('kieltechToken')
            ? { Authorization: `Bearer ${localStorage.getItem('kieltechToken')}` }
            : {})
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || `Unable to load accounts (${response.status}).`);
      }
      users = Array.isArray(payload.users) ? payload.users : [];
      visibleLimit = 30;
      renderRecipients();
      updateSummary();
      setStatus('');
      return true;
    } catch (error) {
      users = [];
      selectedEmail = '';
      recipientList.innerHTML = '<div class="credit-empty">Could not load accounts.</div>';
      recipientCount.textContent = 'Account list is unavailable';
      updateSummary();
      setStatus(error.message || 'Unable to load accounts.', 'error');
      return false;
    } finally {
      isLoadingUsers = false;
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh accounts';
    }
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => setAudience(tab.dataset.audience)));
  document.getElementById('refreshUsersButton').addEventListener('click', loadUsers);
  userSearch.addEventListener('input', () => {
    visibleLimit = 30;
    renderRecipients();
  });
  creditAmount.addEventListener('input', updateSummary);

  creditForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const isConfirmed = grantConfirmed;
    grantConfirmed = false;
    if (!isConfirmed && !await loadUsers()) return;
    const amount = getAmount();
    const eligible = getAudienceUsers();
    if (!amount) {
      setStatus('Enter a credit amount from $0.01 to $10,000.00.', 'error');
      return;
    }
    if (audience === 'single' && !eligible.some((user) => user.email === selectedEmail)) {
      setStatus('Select an active user before granting credit.', 'error');
      return;
    }
    if (!eligible.length) {
      setStatus('There are no eligible recipients for this grant.', 'error');
      return;
    }
    if (!isConfirmed) {
      const selectedUser = audience === 'single'
        ? eligible.find((user) => user.email === selectedEmail)
        : null;
      const audienceLabel = audience === 'enterprise' ? 'enterprise' : 'non-enterprise';
      document.getElementById('creditConfirmRecipient').textContent = selectedUser
        ? `${selectedUser.name || 'Unnamed user'} (${selectedUser.email})`
        : `${eligible.length} ${audienceLabel} user${eligible.length === 1 ? '' : 's'}`;
      document.getElementById('creditConfirmAmount').textContent = formatUsd(amount);
      document.getElementById('creditConfirmTotal').textContent = formatUsd(amount * (selectedUser ? 1 : eligible.length));
      document.getElementById('creditConfirmDescription').textContent = selectedUser
        ? 'Review this individual wallet grant before continuing.'
        : `Each eligible ${audienceLabel} account will receive the same amount.`;
      document.getElementById('confirmCreditGrant').textContent = selectedUser
        ? 'Confirm grant'
        : `Grant to ${eligible.length} users`;
      confirmDialog.showModal();
      return;
    }

    sendButton.disabled = true;
    sendButton.textContent = 'Granting…';
    setStatus('Applying free-credit grant…');
    try {
      const token = localStorage.getItem('kieltechToken') || '';
      const response = await fetch(`${apiBase}/admin/free-credit`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          audience,
          email: audience === 'single' ? selectedEmail : undefined,
          amount,
          reason: creditReason.value.trim()
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || `Credit grant failed (${response.status}).`);
      }
      users = users.map((user) => {
        const updated = payload.results?.find((item) => item.email === user.email);
        return updated ? { ...user, wallet_balance: updated.wallet_balance } : user;
      });
      const grantedCount = Number(payload.granted_count || 0);
      const failureCount = Number(payload.failed_count || 0);
      const notificationFailureCount = Number(payload.notification_failed_count || 0);
      const notificationFailures = (payload.results || [])
        .filter((item) => item.email_sent === false)
        .map((item) => `${item.email}: ${item.email_error || 'email delivery failed'}`);
      const message = `${grantedCount} of ${payload.recipient_count} grants completed${failureCount ? `; ${failureCount} credit grant${failureCount === 1 ? '' : 's'} failed` : ''}${grantedCount ? `; ${grantedCount - notificationFailureCount} email notification${grantedCount - notificationFailureCount === 1 ? '' : 's'} sent` : '; no notification emails sent'}${notificationFailureCount ? `; ${notificationFailureCount} could not be sent` : ''}.`;
      setStatus(message, failureCount || notificationFailureCount ? 'error' : 'success');
      const errors = [
        ...(failureCount ? (payload.failures || []).map((item) => `${item.email}: ${item.detail}`) : []),
        ...notificationFailures
      ];
      if (errors.length) {
        setStatus(`${message} ${errors.join(' ')}`, 'error');
      }
      if (audience === 'single' && payload.results?.[0]) {
        selectedEmail = payload.results[0].email;
      } else if (!failureCount) {
        selectedEmail = '';
      }
      renderRecipients();
      updateSummary();
    } catch (error) {
      setStatus(error.message || 'Unable to grant free credit.', 'error');
      updateSummary();
    } finally {
      sendButton.disabled = false;
      updateSummary();
    }
  });

  document.getElementById('cancelCreditGrant').addEventListener('click', () => confirmDialog.close());
  document.getElementById('confirmCreditGrant').addEventListener('click', () => {
    confirmDialog.close();
    grantConfirmed = true;
    creditForm.requestSubmit();
  });

  setAudience('single');
  loadUsers();
  window.setInterval(() => {
    if (!document.hidden) loadUsers();
  }, 60_000);
})();
