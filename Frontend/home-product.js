(() => {
  const localHost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const apiBase = window.KIELTECH_API_BASE_URL
    || (localHost ? `http://${window.location.hostname || 'localhost'}:8000` : 'https://kieltech-backend.onrender.com');
  const preview = document.getElementById('homeModelPreview');
  const catalogStatus = document.getElementById('homeCatalogStatus');
  const contactForm = document.getElementById('homeContactForm');
  const contactStatus = document.getElementById('homeContactStatus');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let modelTimer = null;
  let modelTransitionTimer = null;
  let currentModelIndex = 0;
  let previewModels = [];
  let pointerInsidePreview = false;
  let focusInsidePreview = false;

  const categoryLabels = {
    'text-generation': 'Language',
    'image-generation': 'Image generation',
    'image-understanding': 'Vision & OCR',
    multimodal: 'Multimodal',
    embeddings: 'Embeddings',
    voice: 'Voice',
    'video-generation': 'Video'
  };

  const formatRate = (value) => {
    if (value === null || value === undefined || value === '') return 'Not published';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'Not published';
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} / 1M`;
  };

  const modalityNames = (model) => {
    const modalities = Array.isArray(model.modalities) ? model.modalities : [];
    if (modalities.length) {
      return [...new Set(modalities.map((modality) => ({
        'text-generation': 'Text',
        'image-understanding': 'Image input',
        'image-generation': 'Image generation',
        embeddings: 'Embeddings',
        voice: 'Audio'
      })[modality] || modality))].join(' · ');
    }
    if (model.category === 'image-generation') return 'Text prompt · Image output';
    if (model.category === 'image-understanding') return 'Text · Image input';
    if (model.category === 'text-generation') return 'Text';
    return categoryLabels[model.category] || 'See model details';
  };

  const createText = (tagName, className, value) => {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  };

  const createModelCard = (model) => {
    const ready = model.is_ready === true && model.is_configured === true && model.is_active !== false;
    const card = document.createElement('article');
    card.className = 'home-model-preview__card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-roledescription', 'slide');
    card.setAttribute('aria-label', `Model: ${model.display_name || model.model_id}`);

    const top = document.createElement('div');
    top.className = 'home-model-preview__top';
    const title = document.createElement('div');
    title.append(
      createText('h3', 'home-model-preview__name', model.display_name || model.model_id),
      createText('p', 'home-model-preview__category', model.type_label || categoryLabels[model.category] || model.category || 'Model')
    );
    const state = createText('span', 'home-model-preview__state', ready ? 'Available' : 'Unavailable');
    state.dataset.ready = String(ready);
    top.append(title, state);

    const rates = document.createElement('div');
    rates.className = 'home-model-preview__rates';
    const inputRate = document.createElement('span');
    inputRate.append('Input ', createText('strong', '', formatRate(model.input_price)));
    const outputRate = document.createElement('span');
    outputRate.append('Output ', createText('strong', '', formatRate(model.output_price)));

    card.append(
      top,
      createText('p', 'home-model-preview__modalities', `Inputs & outputs: ${modalityNames(model)}`),
      rates
    );
    rates.append(inputRate, outputRate);
    return card;
  };

  const stopModelRotation = () => {
    window.clearTimeout(modelTimer);
    modelTimer = null;
  };

  const stopModelTransition = () => {
    window.clearTimeout(modelTransitionTimer);
    modelTransitionTimer = null;
    preview?.querySelector('.home-model-preview__card')?.classList.remove('is-leaving', 'is-entering');
  };

  const scheduleModelRotation = () => {
    stopModelRotation();
    if (previewModels.length < 2
      || document.hidden
      || reducedMotion.matches
      || pointerInsidePreview
      || focusInsidePreview) return;
    modelTimer = window.setTimeout(showNextModel, 3500);
  };

  const renderModel = (index, animate = true) => {
    currentModelIndex = (index + previewModels.length) % previewModels.length;
    const card = createModelCard(previewModels[currentModelIndex]);
    card.setAttribute('aria-label', `Model ${currentModelIndex + 1} of ${previewModels.length}: ${previewModels[currentModelIndex].display_name || previewModels[currentModelIndex].model_id}`);
    if (animate && !reducedMotion.matches) card.classList.add('is-entering');
    preview.replaceChildren(card);
  };

  const showNextModel = () => {
    if (document.hidden || pointerInsidePreview || focusInsidePreview || reducedMotion.matches) {
      scheduleModelRotation();
      return;
    }
    const currentCard = preview.querySelector('.home-model-preview__card');
    currentCard?.classList.add('is-leaving');
    window.clearTimeout(modelTransitionTimer);
    modelTransitionTimer = window.setTimeout(() => {
      renderModel(currentModelIndex + 1);
      scheduleModelRotation();
    }, currentCard && !reducedMotion.matches ? 220 : 0);
  };

  preview?.addEventListener('pointerenter', () => {
    pointerInsidePreview = true;
    stopModelRotation();
  });
  preview?.addEventListener('pointerleave', () => {
    pointerInsidePreview = false;
    scheduleModelRotation();
  });
  preview?.addEventListener('focusin', () => {
    focusInsidePreview = true;
    stopModelRotation();
  });
  preview?.addEventListener('focusout', (event) => {
    if (preview.contains(event.relatedTarget)) return;
    focusInsidePreview = false;
    scheduleModelRotation();
  });
  document.addEventListener('visibilitychange', () => {
    stopModelTransition();
    scheduleModelRotation();
  });
  reducedMotion.addEventListener?.('change', () => {
    stopModelTransition();
    scheduleModelRotation();
  });

  const updateExampleModel = (modelId) => {
    window.updateKieltechIntegrationModel?.(modelId);
  };

  const loadCatalog = async () => {
    if (!preview || !catalogStatus) return;
    try {
      const response = await fetch(`${apiBase}/v1/models/catalog`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
      const payload = await response.json();
      if (!Array.isArray(payload.models)) throw new Error('The catalog response did not include a model list.');

      const models = payload.models
        .filter((model) => model && model.model_id && model.display_name)
        .sort((left, right) => {
          const leftReady = left.is_ready === true && left.is_configured === true && left.is_active !== false;
          const rightReady = right.is_ready === true && right.is_configured === true && right.is_active !== false;
          return Number(rightReady) - Number(leftReady)
            || String(left.display_name).localeCompare(String(right.display_name));
        });
      const readyChatModel = models.find((model) => model.is_ready === true
        && model.is_configured === true
        && model.is_active !== false
        && model.is_chat_available === true);

      preview.replaceChildren();
      if (models.length) {
        previewModels = models;
        currentModelIndex = 0;
        renderModel(currentModelIndex, false);
        scheduleModelRotation();
      } else {
        previewModels = [];
        const empty = createText('div', 'home-model-preview__fallback', 'No models are currently listed in the public catalog.');
        const link = createText('a', '', 'Browse the full catalog');
        link.href = 'models.html';
        empty.append(link);
        preview.append(empty);
      }
      if (readyChatModel) updateExampleModel(readyChatModel.model_id);

      const updatedAt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
      catalogStatus.dataset.tone = 'success';
      catalogStatus.textContent = `Live catalog · ${models.length} ${models.length === 1 ? 'model' : 'models'} · Checked ${updatedAt}`;
    } catch (error) {
      catalogStatus.dataset.tone = 'error';
      catalogStatus.textContent = `Live catalog unavailable: ${error.message}`;
      preview.replaceChildren();
      const fallback = document.createElement('a');
      fallback.className = 'home-model-preview__fallback';
      fallback.href = 'models.html';
      fallback.textContent = 'Open the full model catalog';
      preview.append(fallback);
    }
  };

  const submitContact = async (event) => {
    event.preventDefault();
    if (!contactForm || !contactStatus) return;
    const submitButton = contactForm.querySelector('button[type="submit"]');
    const formData = new FormData(contactForm);
    const values = Object.fromEntries(formData.entries());
    const payload = {
      name: String(values.name || '').trim(),
      email: String(values.email || '').trim(),
      company: String(values.company || '').trim() || 'Not provided',
      role: String(values.role || 'Product team'),
      request_type: String(values.request_type || 'General'),
      usage: String(values.usage || 'Product and API enquiry'),
      services: String(values.services || 'KielTech API'),
      deployment: String(values.deployment || 'Hosted API'),
      message: String(values.message || '').trim(),
      consent: values.consent === 'on',
      website: String(values.website || '').trim()
    };

    submitButton.disabled = true;
    contactStatus.dataset.tone = '';
    contactStatus.textContent = 'Sending your enquiry…';
    try {
      const response = await fetch(`${apiBase}/v1/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        const requestId = result.request_id ? ` Reference: ${result.request_id}.` : '';
        throw new Error(`${result.detail || 'Your enquiry could not be sent.'}${requestId}`);
      }
      contactForm.reset();
      contactStatus.dataset.tone = 'success';
      contactStatus.textContent = `${result.message || 'Your enquiry has been received.'}${result.request_id ? ` Reference: ${result.request_id}.` : ''}`;
    } catch (error) {
      contactStatus.dataset.tone = 'error';
      contactStatus.textContent = error.message || 'Unable to send your enquiry. Please try again later.';
    } finally {
      submitButton.disabled = false;
    }
  };

  contactForm?.addEventListener('submit', submitContact);
  loadCatalog();
})();
