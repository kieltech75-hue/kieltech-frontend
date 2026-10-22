(() => {
  const isLocal = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const apiBase = (window.KIELTECH_API_BASE_URL
    || (isLocal ? `http://${window.location.hostname || 'localhost'}:8000` : 'https://kieltech-backend.onrender.com'))
    .replace(/\/$/, '');
  const customerPageLink = document.getElementById('viewCustomerPage');
  if (customerPageLink && isLocal) {
    customerPageLink.href = `http://${window.location.hostname || 'localhost'}:8001/chat-templates.html`;
  }
  const apiFetch = (path, options = {}) => {
    const token = localStorage.getItem('kieltechToken');
    return fetch(`${apiBase}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
  };
  const form = document.getElementById('templateForm');
  const fields = document.getElementById('templateFields');
  const fileInput = document.getElementById('templateImage');
  const imagePreview = document.getElementById('imagePreview');
  const imagePreviewImage = document.getElementById('imagePreviewImage');
  const imagePreviewName = document.getElementById('imagePreviewName');
  const result = document.getElementById('templateResult');
  const list = document.getElementById('templateList');
  const search = document.getElementById('templateSearch');
  const includeArchived = document.getElementById('includeArchived');
  const summary = document.getElementById('templateSummary');
  const refreshButton = document.getElementById('refreshTemplates');
  const submitButton = document.getElementById('publishTemplate');
  const modelSelect = document.getElementById('templateModel');
  const removeImageButton = document.getElementById('removeTemplateImage');
  const maxImageBytes = 5 * 1024 * 1024;
  let templates = [];
  let modelLabels = new Map();
  let imageData = '';
  let adminAccess = false;
  submitButton.disabled = true;

  const makeElement = (tagName, className, text) => {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const setStatus = (message, tone = '') => {
    result.textContent = message;
    if (tone) result.dataset.tone = tone;
    else delete result.dataset.tone;
  };

  const showListState = (title, message, state = 'empty', action) => {
    list.setAttribute('aria-busy', String(state === 'loading'));
    list.replaceChildren();
    const container = makeElement('div', 'template-state');
    if (state === 'loading') {
      const spinner = makeElement('span', 'template-spinner');
      spinner.setAttribute('aria-hidden', 'true');
      container.append(spinner);
    } else {
      const icon = makeElement('span', 'template-state__icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = state === 'auth'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/><path d="M8 8V6a4 4 0 1 1 8 0v2"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4z"/><path d="M8 9h8m-8 4h5"/></svg>';
      container.append(icon);
    }
    container.append(makeElement('strong', '', title), makeElement('p', '', message));
    if (action) {
      const link = makeElement('a', '', action.label);
      link.href = action.href;
      container.append(link);
    }
    list.append(container);
  };

  const formatDate = (value) => {
    if (!value) return 'Date unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Date unavailable'
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  };

  const clearImage = () => {
    imageData = '';
    fileInput.value = '';
    imagePreviewImage.removeAttribute('src');
    imagePreviewName.textContent = '';
    imagePreview.hidden = true;
  };

  const createTemplateCard = (template) => {
    const article = makeElement('article', 'template-card');
    const validImage = typeof template.image === 'string'
      && /^data:image\/(?:png|jpeg|webp);base64,/.test(template.image);

    if (validImage) {
      const image = makeElement('img', 'template-card__image');
      image.src = template.image;
      image.alt = `${template.title || 'Template'} preview`;
      article.append(image);
    } else {
      const placeholder = makeElement('span', 'template-card__placeholder');
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>';
      article.append(placeholder);
    }

    const main = makeElement('div', 'template-card__main');
    const titleRow = makeElement('div', 'template-card__title-row');
    titleRow.append(makeElement('h3', 'template-card__title', template.title || 'Untitled template'));
    const badge = makeElement(
      'span',
      template.active ? 'template-badge' : 'template-badge template-badge--archived',
      template.active ? 'Published' : 'Archived'
    );
    titleRow.append(badge);
    main.append(titleRow);
    main.append(makeElement('p', 'template-card__description', template.description || 'No description provided.'));

    const meta = makeElement('div', 'template-card__meta');
    meta.append(
      makeElement('span', '', template.category || 'General'),
      makeElement('span', '', modelLabels.get(template.model) || 'Model unavailable'),
      makeElement('span', '', `Updated ${formatDate(template.updated_at || template.created_at)}`)
    );
    main.append(meta);

    const promptDetails = document.createElement('details');
    promptDetails.className = 'template-card__prompt';
    promptDetails.append(makeElement('summary', '', 'View prompt'));
    promptDetails.append(makeElement('pre', '', template.prompt || 'No prompt available.'));
    main.append(promptDetails);
    article.append(main);

    const actions = makeElement('div', 'template-card__actions');
    if (template.active) {
      const removeButton = makeElement('button', 'template-button template-button--danger', 'Remove');
      removeButton.type = 'button';
      removeButton.setAttribute('aria-label', `Remove ${template.title || 'template'} from the customer page`);
      removeButton.addEventListener('click', () => removeTemplate(template.id, removeButton));
      actions.append(removeButton);
    } else {
      const restoreButton = makeElement('button', 'template-button', 'Republish');
      restoreButton.type = 'button';
      restoreButton.setAttribute('aria-label', `Republish ${template.title || 'template'}`);
      restoreButton.addEventListener('click', () => restoreTemplate(template.id, restoreButton));
      actions.append(restoreButton);
    }
    article.append(actions);
    return article;
  };

  const renderTemplates = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = templates.filter((template) => {
      if (!includeArchived.checked && !template.active) return false;
      const searchable = [template.title, template.description, template.prompt, template.category, template.model]
        .join(' ')
        .toLocaleLowerCase();
      return !query || searchable.includes(query);
    });
    const published = templates.filter((template) => template.active).length;
    const archived = templates.length - published;
    summary.textContent = `${published} published · ${archived} archived`;

    if (!visible.length) {
      const title = query ? 'No matching templates' : 'No published templates yet';
      const message = query
        ? 'Try another search term or clear the search field.'
        : 'Published templates will appear here after you create them.';
      showListState(title, message);
      return;
    }

    list.replaceChildren(...visible.map(createTemplateCard));
    list.setAttribute('aria-busy', 'false');
  };

  const loadTemplates = async () => {
    refreshButton.disabled = true;
    showListState('Loading templates', 'Fetching the current template library.', 'loading');
    try {
      const response = await apiFetch('/v1/admin/chat/templates', {
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        adminAccess = false;
        fields.disabled = true;
        submitButton.disabled = true;
        showListState(
          'Admin sign-in required',
          'Sign in with an administrator account to publish and manage templates.',
          'auth',
          { label: 'Sign in', href: '/login.html?return_to=admin-chat-templates.html' }
        );
        return false;
      }
      if (!response.ok) throw new Error(data.detail || data.error || 'Unable to load templates.');
      templates = Array.isArray(data.templates) ? data.templates : [];
      adminAccess = true;
      fields.disabled = false;
      submitButton.disabled = false;
      renderTemplates();
      return true;
    } catch (error) {
      adminAccess = false;
      fields.disabled = true;
      submitButton.disabled = true;
      showListState('Templates unavailable', error.message || 'Unable to reach the template service.', 'error');
      return false;
    } finally {
      refreshButton.disabled = false;
    }
  };

  const removeTemplate = async (templateId, button) => {
    const template = templates.find((item) => String(item.id) === String(templateId));
    if (!template || !window.confirm(`Remove “${template.title}” from the customer page? It will be archived and can be republished later.`)) return;
    button.disabled = true;
    button.textContent = 'Removing…';
    try {
      const response = await apiFetch(`/v1/admin/chat/templates/${encodeURIComponent(templateId)}`, {
        method: 'DELETE'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || 'Unable to remove template.');
      setStatus('Template removed from the customer page.', 'success');
      await loadTemplates();
    } catch (error) {
      setStatus(error.message || 'Unable to remove template.', 'error');
      button.disabled = false;
      button.textContent = 'Remove';
    }
  };

  const restoreTemplate = async (templateId, button) => {
    const template = templates.find((item) => String(item.id) === String(templateId));
    if (!template || !window.confirm(`Republish “${template.title}” on the customer page?`)) return;
    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
      const response = await apiFetch(`/v1/admin/chat/templates/${encodeURIComponent(templateId)}/restore`, {
        method: 'POST'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || 'Unable to republish template.');
      setStatus('Template republished.', 'success');
      await loadTemplates();
    } catch (error) {
      setStatus(error.message || 'Unable to republish template.', 'error');
      button.disabled = false;
      button.textContent = 'Republish';
    }
  };

  const updateCounters = () => {
    document.querySelectorAll('[data-count-for]').forEach((counter) => {
      const field = document.getElementById(counter.dataset.countFor);
      counter.textContent = `${field.value.length} / ${field.maxLength}`;
    });
  };

  const loadModelOptions = async () => {
    modelSelect.disabled = true;
    modelSelect.replaceChildren(new Option('Loading image models…', ''));
    const response = await apiFetch('/v1/models/catalog', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || 'Unable to load the model catalog.');
    const models = Array.isArray(data.models) ? data.models : [];
    modelLabels = new Map(models.map((model) => [model.model_id, model.display_name || model.model_id]));
    const imageModels = models.filter((model) => model.category === 'image-generation');
    modelSelect.replaceChildren();
    if (!imageModels.length) {
      modelSelect.append(new Option('No image-generation models are listed', ''));
      return;
    }
    imageModels.forEach((model) => {
      const ready = model.is_ready === true && model.is_configured === true;
      const option = new Option(
        `${model.display_name || model.model_id}${ready ? '' : ' — Configure model'}`,
        model.model_id
      );
      option.disabled = !ready;
      modelSelect.append(option);
    });
    modelSelect.disabled = !imageModels.some((model) => model.is_ready === true && model.is_configured === true);
  };

  document.querySelectorAll('[data-count-for]').forEach((counter) => {
    const field = document.getElementById(counter.dataset.countFor);
    field.addEventListener('input', updateCounters);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      clearImage();
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      clearImage();
      setStatus('Choose a PNG, JPG, or WebP image.', 'error');
      return;
    }
    if (file.size > maxImageBytes) {
      clearImage();
      setStatus('Image must be 5 MB or smaller.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.addEventListener('error', () => setStatus('Unable to read this image.', 'error'), { once: true });
    reader.addEventListener('load', () => {
      imageData = String(reader.result || '');
      imagePreviewImage.src = imageData;
      imagePreviewName.textContent = file.name;
      imagePreview.hidden = false;
      setStatus('Image ready to publish.');
    }, { once: true });
    reader.readAsDataURL(file);
  });

  removeImageButton.addEventListener('click', () => {
    clearImage();
    setStatus('Image removed.');
  });

  form.addEventListener('reset', () => {
    window.setTimeout(() => {
      clearImage();
      updateCounters();
      setStatus('');
    }, 0);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submitButton.disabled = true;
    form.setAttribute('aria-busy', 'true');
    submitButton.textContent = 'Publishing…';
    setStatus('Publishing template…');
    try {
      const response = await apiFetch('/v1/admin/chat/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: document.getElementById('templateTitle').value,
          description: document.getElementById('templateDescription').value,
          category: document.getElementById('templateCategory').value,
          model: document.getElementById('templateModel').value,
          prompt: document.getElementById('templatePrompt').value,
          image: imageData
        })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        adminAccess = false;
        fields.disabled = true;
        throw new Error('Admin sign-in is required before publishing.');
      }
      if (!response.ok) throw new Error(data.detail || data.error || 'Unable to publish template.');
      form.reset();
      setStatus('Template published successfully.', 'success');
      await loadTemplates();
    } catch (error) {
      setStatus(error.message || 'Unable to publish template.', 'error');
    } finally {
      submitButton.disabled = !adminAccess;
      submitButton.textContent = 'Publish template';
      form.removeAttribute('aria-busy');
    }
  });

  search.addEventListener('input', renderTemplates);
  includeArchived.addEventListener('change', renderTemplates);
  refreshButton.addEventListener('click', loadTemplates);
  updateCounters();
  loadModelOptions()
    .then(loadTemplates)
    .catch((error) => {
      modelSelect.replaceChildren(new Option('Model catalog unavailable', ''));
      modelSelect.disabled = true;
      setStatus(error.message || 'Unable to load the model catalog.', 'error');
      loadTemplates();
    });
})();