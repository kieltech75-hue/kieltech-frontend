(() => {
  const categories = {
    'text-generation': { section: 0, badge: 'Text' },
    'image-generation': { section: 1, badge: 'Image' },
    multimodal: { section: 2, badge: 'Multimodal' },
    voice: { section: 3, badge: 'Voice' },
    'video-generation': { section: 6, badge: 'Video' },
    embeddings: { section: 5, badge: 'Embed' }
  };
  const isLocal = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const apiBase = window.KIELTECH_API_BASE_URL
    || (isLocal ? `http://${window.location.hostname || 'localhost'}:8000` : 'https://kieltech-backend.onrender.com');
  const sections = [...document.querySelectorAll('.model-section')];
  const modelCountElement = document.getElementById('currentModelCount');
  const lockedModelCountElement = document.getElementById('lockedModelCount');
  const currentPlanElement = document.getElementById('currentPlanName');
  const search = document.getElementById('modelSearch');
  const access = document.getElementById('modelAccess');
  let catalogRefreshInProgress = false;

  const updateAvailableModelCount = () => {
    if (!modelCountElement) return;
    const readyModelIds = new Set();
    document.querySelectorAll('.model-section tbody tr[data-model]').forEach((row) => {
      if (row.querySelector('.model-status')?.textContent.trim().toLowerCase() !== 'available') return;
      const modelId = row.dataset.model.trim().split(/\s+/)[0].toLowerCase();
      if (modelId) readyModelIds.add(modelId);
    });
    modelCountElement.textContent = readyModelIds.size.toLocaleString('en-US');
  };

  const updateAccountSummary = () => {
    const headers = {};
    try {
      const token = localStorage.getItem('kieltechToken');
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {}

    fetch(`${apiBase}/v1/models/summary`, { headers, credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const summary = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(summary.detail || 'Account summary is unavailable.');
        if (currentPlanElement) currentPlanElement.textContent = summary.plan || 'Unknown';
        if (lockedModelCountElement) lockedModelCountElement.textContent = Number(summary.locked_models || 0).toLocaleString('en-US');
      })
      .catch(() => {
        if (currentPlanElement) currentPlanElement.textContent = 'Sign in';
      });
  };

  updateAccountSummary();

  const formatRate = (value) => {
    if (value === null || value === undefined || value === '') return 'Pending';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'Pending';
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  };

  const formatContext = (value) => {
    if (value === null || value === undefined || value === '') return 'Pending';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'Pending';
    return amount >= 1000 ? `${Math.round(amount / 1000)}K` : String(amount);
  };

  const getModelBadge = (model) => {
    const category = model.category === 'image-understanding' ? 'multimodal' : model.category;
    if (category !== 'multimodal') return categories[category]?.badge || category;
    if (model.type_label) return model.type_label;
    const modalities = new Set(model.modalities || []);
    if (modalities.has('text-generation') && modalities.has('image-generation') && modalities.has('image-understanding')) return 'Text + Image + Vision';
    if (modalities.has('text-generation') && modalities.has('image-understanding')) return 'Text + Vision';
    return 'Text + Vision';
  };

  const createPriceCell = (value) => {
    const cell = document.createElement('td');
    cell.className = 'price';
    const amount = document.createElement('strong');
    amount.textContent = formatRate(value);
    cell.append(amount);
    return cell;
  };

  const createModelRow = (model) => {
    const row = document.createElement('tr');
    row.dataset.model = `${model.model_id} ${model.display_name} ${model.category}`.toLocaleLowerCase();
    row.dataset.category = model.category === 'image-understanding' ? 'multimodal' : model.category;

    const nameCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'model-name';
    const mark = document.createElement('span');
    mark.className = 'model-mark';
    const initial = (model.display_name || 'M').trim().charAt(0).toUpperCase();
    if (initial === 'K') {
      const icon = document.createElement('img');
      icon.src = 'kieltech-k-transparent.png';
      icon.alt = '';
      mark.append(icon);
    } else {
      mark.textContent = initial;
    }
    const copy = document.createElement('span');
    copy.className = 'model-copy';
    copy.textContent = model.display_name;
    const badge = document.createElement('span');
    badge.className = 'model-badge';
    badge.textContent = getModelBadge(model);
    name.append(mark, copy, badge);
    if (model.is_new) {
      const fresh = document.createElement('span');
      fresh.className = 'model-badge model-badge--new';
      fresh.textContent = 'New';
      name.append(fresh);
    }
    nameCell.append(name);

    const status = document.createElement('td');
    status.className = 'model-status';
    status.textContent = model.is_ready === true && model.is_configured === true && model.is_active !== false
      ? 'Available'
      : 'Unavailable';
    row.append(
      nameCell,
      status,
      createPriceCell(model.input_price),
      createPriceCell(model.output_price)
    );
    const context = document.createElement('td');
    context.className = 'max-context-value';
    context.textContent = formatContext(model.max_context);
    row.append(context);
    return row;
  };

  const applyFilters = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const selectedCategory = access.value;
    sections.forEach((section) => {
      const sectionCategories = (section.dataset.categories || '').split(',').filter(Boolean);
      const categoryVisible = selectedCategory === 'all' || sectionCategories.includes(selectedCategory);
      let visibleCount = 0;
      section.querySelectorAll('tbody tr[data-model]').forEach((row) => {
        const rowCategory = row.dataset.category || '';
        row.dataset.category = rowCategory;
        const visible = categoryVisible
          && (selectedCategory === 'all' || rowCategory === selectedCategory)
          && (!query || `${row.dataset.model} ${row.textContent}`.toLocaleLowerCase().includes(query));
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      const empty = section.querySelector('.empty-row');
      if (empty) empty.style.display = categoryVisible && visibleCount === 0 ? 'block' : 'none';
      section.hidden = !categoryVisible;
    });
  };

  const insertModels = (models) => {
    sections.forEach((section) => {
      const body = section.querySelector('tbody');
      body.replaceChildren();
      const categoryIds = (section.dataset.categories || '').split(',').filter(Boolean);
      const matching = models
        .filter((model) => {
          const category = model.category === 'image-understanding' ? 'multimodal' : model.category;
          return categories[category] && categoryIds.includes(category);
        })
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
      const empty = section.querySelector('.empty-row');
      if (!matching.length) {
        if (empty) {
          empty.textContent = 'No models are currently listed in the Admin Models catalog.';
          empty.style.display = 'block';
        }
        return;
      }
      if (empty) empty.style.display = 'none';
      const fragment = document.createDocumentFragment();
      matching.forEach((model) => {
        const row = createModelRow(model);
        fragment.append(row);
      });
      body.append(fragment);
    });
  };

  search.addEventListener('input', applyFilters);
  access.addEventListener('change', applyFilters);
  sections.forEach((section) => {
    section.querySelectorAll('.models-table').forEach((table) => {
      const header = table.querySelector('thead tr');
      if (header && !header.querySelector('[data-status-column]')) {
        const statusHeader = document.createElement('th');
        statusHeader.textContent = 'Status';
        statusHeader.dataset.statusColumn = 'true';
        header.insertBefore(statusHeader, header.children[1] || null);
      }
      table.querySelectorAll('tbody tr[data-model]').forEach((row) => {
        if (row.querySelector('.model-status')) return;
        const status = document.createElement('td');
        status.className = 'model-status';
        status.textContent = 'Unavailable';
        row.insertBefore(status, row.children[1] || null);
      });
    });
    section.querySelectorAll('tbody tr[data-model]').forEach((row) => {
      row.dataset.category = '';
    });
  });
  applyFilters();

  const refreshCatalog = async () => {
    if (catalogRefreshInProgress) return;
    catalogRefreshInProgress = true;
    try {
      const response = await fetch(`${apiBase}/v1/models/catalog`, { credentials: 'include', cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Live model catalog is unavailable.');
      const catalogModels = (Array.isArray(data.models) ? data.models : [])
        .filter((model) => model.model_id && model.display_name && model.category);
      insertModels(catalogModels);
      applyFilters();
      updateAvailableModelCount();
      document.getElementById('modelCatalogStatus')?.remove();
    } catch (error) {
      let status = document.getElementById('modelCatalogStatus');
      if (!status) {
        status = document.createElement('p');
        status.id = 'modelCatalogStatus';
        status.setAttribute('role', 'status');
        status.style.cssText = 'margin:.5rem 0;color:#fca5a5;font-size:.78rem';
        document.querySelector('.model-tools').after(status);
      }
      status.textContent = error.message || 'Live model catalog is unavailable.';
    } finally {
      catalogRefreshInProgress = false;
    }
  };

  refreshCatalog();
  window.setInterval(() => {
    if (!document.hidden) refreshCatalog();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCatalog();
  });
  window.addEventListener('focus', refreshCatalog);
})();
