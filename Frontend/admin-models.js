(() => {
  const categoryDefinitions = [
    ['text-generation', 'Text generation'],
    ['image-understanding', 'Image understanding models'],
    ['image-generation', 'Image generation models'],
    ['multimodal', 'Multimodal models'],
    ['voice', 'Voice models'],
    ['video-generation', 'Video generation models'],
    ['embeddings', 'Embed Models']
  ];
  const apiBase = window.KIELTECH_API_BASE_URL
    || (['localhost', '127.0.0.1', ''].includes(window.location.hostname)
      ? `http://${window.location.hostname || 'localhost'}:8000`
      : 'https://kieltech-backend.onrender.com');
  const categorySelect = document.getElementById('modelCategory');
  const modelForm = document.getElementById('modelForm');
  const dialog = document.getElementById('modelDialog');
  const dialogStatus = document.getElementById('modelFormStatus');
  const pageStatus = document.getElementById('modelPageStatus');
  const categoryRoot = document.getElementById('modelCategories');
  const removedModelsSection = document.getElementById('removedModelsSection');
  const removedModelsBody = document.getElementById('removedModelsBody');
  const removedModelsCount = document.getElementById('removedModelsCount');
  const chatAvailabilityBody = document.getElementById('chatAvailabilityBody');
  const chatAvailabilityCount = document.getElementById('chatAvailabilityCount');
  const studioModelAssignmentBody = document.getElementById('studioModelAssignmentBody');
  const studioModelAssignmentCount = document.getElementById('studioModelAssignmentCount');
  const studioModelAssignmentStatus = document.getElementById('studioModelAssignmentStatus');
  const saveStudioModelAssignmentsButton = document.getElementById('saveStudioModelAssignments');
  const chatCapabilityDialog = document.getElementById('chatCapabilityDialog');
  const chatCapabilityForm = document.getElementById('chatCapabilityForm');
  const chatCapabilityInput = document.getElementById('chatCapabilityInput');
  const chatCapabilityHeading = document.getElementById('chatCapabilityHeading');
  const saveChatCapabilityButton = document.getElementById('saveChatCapabilityButton');
  const permanentDeleteDialog = document.getElementById('permanentDeleteDialog');
  const permanentDeleteForm = document.getElementById('permanentDeleteForm');
  const permanentDeleteInput = document.getElementById('permanentDeleteConfirmation');
  const permanentDeleteModelId = document.getElementById('permanentDeleteModelId');
  const confirmPermanentDeleteButton = document.getElementById('confirmPermanentDelete');
  const summary = document.getElementById('modelSummary');
  const addButton = document.getElementById('addModelButton');
  const publishButton = document.getElementById('publishModelButton');
  const modelName = document.getElementById('modelDisplayName');
  const providerModelInput = document.getElementById('providerModel');
  const modelIdPreview = document.getElementById('modelIdPreview');
  const dialogTitle = document.getElementById('modelDialogTitle');
  const dialogDescription = document.getElementById('modelDialogDescription');
  const categoryRuntimeNote = document.getElementById('categoryRuntimeNote');
  const multimodalOptions = document.getElementById('multimodalOptions');
  const multimodalProfile = document.getElementById('multimodalProfile');
  const modelTypeLabel = document.getElementById('modelTypeLabel');
  const search = document.getElementById('modelSearch');
  const token = localStorage.getItem('kieltechToken') || '';

  const slugify = (value) => value.toLocaleLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 120);

  const formatErrorDetail = (detail) => {
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return String(item);
        const location = Array.isArray(item.loc) ? item.loc.filter(Boolean).join('.') : '';
        const message = typeof item.msg === 'string' ? item.msg : JSON.stringify(item);
        return location ? `${location}: ${message}` : message;
      }).join(' ');
    }
    if (detail && typeof detail === 'object') {
      if (typeof detail.message === 'string') return detail.message;
      if (typeof detail.msg === 'string') return detail.msg;
      return JSON.stringify(detail);
    }
    return '';
  };

  const request = async (path, options = {}) => {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(formatErrorDetail(data.detail) || formatErrorDetail(data.error) || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  };

  const formatPrice = (value) => value === null || value === undefined || value === ''
    ? 'Pending'
    : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  const formatContext = (value) => value === null || value === undefined || value === ''
    ? 'Pending'
    : `${Number(value).toLocaleString('en-US')} tokens`;
  const multimodalTag = (model) => {
    if (model.type_label) return model.type_label;
    const modalities = model.modalities || [];
    const values = new Set(modalities);
    if (values.has('text-generation') && values.has('image-generation') && values.has('image-understanding')) return 'Text + Image + Vision';
    if (values.has('text-generation') && values.has('image-understanding')) return 'Text + Vision';
    return 'Text + Vision';
  };
  const setStatus = (element, message, tone = '') => {
    element.textContent = message;
    if (tone) element.dataset.tone = tone;
    else delete element.dataset.tone;
  };

  const removeModel = async (model, button) => {
    button.disabled = true;
    button.textContent = 'Removing…';
    setStatus(pageStatus, `Removing ${model.display_name} from the public catalog…`);
    try {
      await request(`/v1/admin/models/${encodeURIComponent(model.model_id)}`, { method: 'DELETE' });
      await loadModels();
      setStatus(pageStatus, `${model.display_name} removed from the public catalog.`, 'success');
    } catch (error) {
      setStatus(pageStatus, error.message || 'Unable to remove model.', 'error');
      button.disabled = false;
      button.textContent = 'Remove';
    }
  };

  const restoreModel = async (model, button) => {
    button.disabled = true;
    button.textContent = 'Restoring…';
    setStatus(pageStatus, `Restoring ${model.display_name} to the public catalog…`);
    try {
      await request(`/v1/admin/models/${encodeURIComponent(model.model_id)}/restore`, { method: 'POST' });
      await loadModels();
      setStatus(pageStatus, `${model.display_name} restored to the public catalog.`, 'success');
    } catch (error) {
      setStatus(pageStatus, error.message || 'Unable to restore model.', 'error');
      button.disabled = false;
      button.textContent = 'Restore';
    }
  };

  let pendingPermanentDeleteModel = null;
  const openPermanentDeleteDialog = (model) => {
    pendingPermanentDeleteModel = model;
    permanentDeleteInput.value = '';
    permanentDeleteInput.placeholder = model.model_id;
    permanentDeleteModelId.textContent = model.model_id;
    confirmPermanentDeleteButton.disabled = true;
    setStatus(document.getElementById('permanentDeleteStatus'), '');
    permanentDeleteDialog.showModal();
    permanentDeleteInput.focus();
  };

  const closePermanentDeleteDialog = () => {
    pendingPermanentDeleteModel = null;
    permanentDeleteDialog.close();
  };

  const permanentlyDeleteModel = async (model) => {
    confirmPermanentDeleteButton.disabled = true;
    setStatus(document.getElementById('permanentDeleteStatus'), `Permanently deleting ${model.display_name}…`);
    try {
      await request(`/v1/admin/models/${encodeURIComponent(model.model_id)}/permanent`, { method: 'DELETE' });
      closePermanentDeleteDialog();
      await loadModels();
      setStatus(pageStatus, `${model.display_name} permanently deleted.`, 'success');
    } catch (error) {
      setStatus(document.getElementById('permanentDeleteStatus'), error.message || 'Unable to permanently delete model.', 'error');
      confirmPermanentDeleteButton.disabled = false;
    }
  };

  permanentDeleteInput.addEventListener('input', () => {
    confirmPermanentDeleteButton.disabled = !pendingPermanentDeleteModel
      || permanentDeleteInput.value.trim() !== pendingPermanentDeleteModel.model_id;
  });
  permanentDeleteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingPermanentDeleteModel || permanentDeleteInput.value.trim() !== pendingPermanentDeleteModel.model_id) return;
    permanentlyDeleteModel(pendingPermanentDeleteModel);
  });
  document.getElementById('cancelPermanentDelete').addEventListener('click', closePermanentDeleteDialog);
  document.getElementById('closePermanentDeleteDialog').addEventListener('click', closePermanentDeleteDialog);
  permanentDeleteDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePermanentDeleteDialog();
  });

  let pendingChatAssignment = null;
  const cancelChatAssignment = () => {
    if (pendingChatAssignment) {
      pendingChatAssignment.checkbox.checked = pendingChatAssignment.model.is_chat_available === true;
      pendingChatAssignment.checkbox.disabled = false;
      pendingChatAssignment = null;
    }
    if (chatCapabilityDialog.open) chatCapabilityDialog.close();
  };

  const saveChatAvailability = async (model, checkbox, isChatAvailable, chatCapability = null) => {
    checkbox.disabled = true;
    setStatus(pageStatus, `Updating Kiel Chat availability for ${model.display_name}…`);
    try {
      await request(`/v1/admin/models/${encodeURIComponent(model.model_id)}/chat-availability`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_chat_available: isChatAvailable, chat_capability: chatCapability })
      });
      pendingChatAssignment = null;
      if (chatCapabilityDialog.open) chatCapabilityDialog.close();
      await loadModels();
      setStatus(pageStatus, `${model.display_name} ${isChatAvailable ? 'added to' : 'removed from'} the Kiel Chat selector.`, 'success');
    } catch (error) {
      checkbox.checked = model.is_chat_available === true;
      checkbox.disabled = false;
      if (isChatAvailable && chatCapabilityDialog.open) {
        setStatus(document.getElementById('chatCapabilityStatus'), error.message || 'Unable to update Kiel Chat availability.', 'error');
      } else {
        setStatus(pageStatus, error.message || 'Unable to update Kiel Chat availability.', 'error');
      }
    }
  };

  const updateChatAvailability = (model, checkbox) => {
    if (!checkbox.checked) {
      saveChatAvailability(model, checkbox, false);
      return;
    }
    pendingChatAssignment = { model, checkbox };
    checkbox.disabled = true;
    chatCapabilityHeading.textContent = `Describe ${model.display_name}`;
    chatCapabilityInput.value = model.chat_capability || '';
    saveChatCapabilityButton.disabled = false;
    setStatus(document.getElementById('chatCapabilityStatus'), '');
    chatCapabilityDialog.showModal();
    chatCapabilityInput.focus();
  };

  chatCapabilityForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingChatAssignment || !chatCapabilityForm.reportValidity()) return;
    const capability = chatCapabilityInput.value.trim();
    if (!capability) {
      chatCapabilityInput.setCustomValidity('Enter a short model ability.');
      chatCapabilityInput.reportValidity();
      return;
    }
    chatCapabilityInput.setCustomValidity('');
    saveChatCapabilityButton.disabled = true;
    const { model, checkbox } = pendingChatAssignment;
    saveChatAvailability(model, checkbox, true, capability).finally(() => {
      saveChatCapabilityButton.disabled = false;
    });
  });
  chatCapabilityInput.addEventListener('input', () => chatCapabilityInput.setCustomValidity(''));
  document.getElementById('cancelChatCapabilityDialog').addEventListener('click', cancelChatAssignment);
  document.getElementById('closeChatCapabilityDialog').addEventListener('click', cancelChatAssignment);
  chatCapabilityDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelChatAssignment();
  });

  let editingModelId = null;
  const resetModelEditor = () => {
    editingModelId = null;
    modelName.disabled = false;
    dialogTitle.textContent = 'Add model';
    dialogDescription.textContent = 'Add a model to the catalog. Pricing and endpoint configuration can be filled in later.';
    publishButton.textContent = 'Publish model';
    modelIdPreview.textContent = slugify(modelName.value) || 'generated-from-model-name';
  };

  const openEditModel = (model) => {
    modelForm.reset();
    editingModelId = model.model_id;
    modelName.value = model.display_name || '';
    modelName.disabled = false;
    modelIdPreview.textContent = model.model_id;
    providerModelInput.value = model.provider_model || '';
    categorySelect.value = model.category;
    modelTypeLabel.value = model.type_label || '';
    if (model.category === 'multimodal') {
      multimodalProfile.value = (model.modalities || []).includes('image-generation')
        ? 'text-generation,image-generation,image-understanding'
        : 'text-generation,image-understanding';
    }
    document.getElementById('inputPrice').value = model.input_price ?? '';
    document.getElementById('outputPrice').value = model.output_price ?? '';
    document.getElementById('maxContext').value = model.max_context ?? '';
    updateCategoryRuntimeNote();
    dialogTitle.textContent = 'Edit model';
    dialogDescription.textContent = `Update the name and configuration for ${model.display_name}. The catalog ID cannot be changed.`;
    publishButton.textContent = 'Save changes';
    setStatus(dialogStatus, '');
    dialog.showModal();
  };

  const createCell = (text) => {
    const cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  };

  const modelSetupState = (model) => {
    const hasProvider = Boolean(model.provider_model || model.is_builtin || model.created_by === 'catalog-seed');
    const hasPricing = model.input_price !== null
      && model.input_price !== undefined
      && model.output_price !== null
      && model.output_price !== undefined;
    const hasContext = model.max_context !== null && model.max_context !== undefined;
    const ready = model.is_ready === true
      && model.is_configured === true
      && hasProvider
      && hasPricing
      && hasContext
      && model.is_active !== false;
    const missing = [];
    if (!hasProvider) missing.push('provider model ID');
    if (!hasPricing) missing.push('input/output pricing');
    if (!hasContext) missing.push('context limit');
    if (model.is_ready !== true || model.is_active === false) missing.push('active model status');
    if (model.is_configured !== true && !missing.length) missing.push('model configuration');
    return {
      ready,
      label: ready ? 'Ready' : 'Configure model',
      detail: ready
        ? 'Provider, pricing, and context are configured.'
        : `Complete setup: ${missing.join(', ') || 'model configuration'}.`
    };
  };

  const createSetupStatusCell = (model) => {
    const state = modelSetupState(model);
    const cell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `model-setup-status ${state.ready ? 'is-ready' : 'is-configure'}`;
    badge.textContent = state.label;
    badge.title = state.detail;
    badge.setAttribute('aria-label', `${state.label}: ${state.detail}`);
    cell.append(badge);
    return cell;
  };

  const renderCategories = (models) => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = models.filter((model) => !query || `${model.display_name} ${model.model_id} ${model.provider_model || ''} ${model.type_label || ''}`.toLocaleLowerCase().includes(query));
    const grouped = new Map(categoryDefinitions.map(([id]) => [id, []]));
    filtered.forEach((model) => grouped.get(model.category)?.push(model));
    categoryRoot.replaceChildren();
    removedModelsBody.replaceChildren();
    removedModelsSection.hidden = true;

    categoryDefinitions.forEach(([categoryId, categoryName]) => {
      const section = document.createElement('section');
      section.className = 'model-category';
      const header = document.createElement('header');
      header.className = 'model-category__header';
      const heading = document.createElement('h2');
      heading.textContent = categoryName;
      const items = grouped.get(categoryId) || [];
      if (categoryId === 'video-generation' && !items.length) return;
      const count = document.createElement('span');
      count.className = 'model-category__count';
      const readyCount = items.filter((model) => modelSetupState(model).ready).length;
      count.textContent = `${readyCount} ready · ${items.length - readyCount} configure · ${items.length} ${items.length === 1 ? 'model' : 'models'}`;
      header.append(heading, count);
      section.append(header);

      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'model-empty';
        empty.textContent = query ? 'No models match this search.' : 'No models in this category yet.';
        section.append(empty);
        categoryRoot.append(section);
        return;
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'model-table-wrap';
      const table = document.createElement('table');
      table.className = 'model-table';
      table.innerHTML = '<thead><tr><th>Model</th><th>Status</th><th>Input / 1M</th><th>Output / 1M</th><th>Max context</th><th>Actions</th></tr></thead>';
      const body = document.createElement('tbody');
      items.forEach((model) => {
        const row = document.createElement('tr');
        const modelCell = document.createElement('td');
        const name = document.createElement('div');
        name.className = 'model-table__name';
        name.append(document.createTextNode(model.display_name));
        if (model.category === 'multimodal') {
          const capability = document.createElement('span');
          capability.className = 'model-capability';
          capability.textContent = multimodalTag(model);
          name.append(capability);
        }
        if (model.is_new) {
          const badge = document.createElement('span');
          badge.className = 'model-new';
          badge.textContent = 'New';
          name.append(badge);
        }
        modelCell.append(name);
        const id = document.createElement('small');
        id.className = 'model-table__id';
        id.textContent = model.model_id;
        modelCell.append(id);
        const statusCell = createSetupStatusCell(model);
        const context = createCell(formatContext(model.max_context));
        context.className = 'model-table__context';
        const actions = document.createElement('td');
        actions.className = 'model-table__actions';
        const actionGroup = document.createElement('div');
        actionGroup.className = 'model-table__action-group';
        if (model.is_editable) {
          const editButton = document.createElement('button');
          editButton.className = 'model-button model-edit-button';
          editButton.textContent = 'Edit';
          editButton.type = 'button';
          editButton.setAttribute('aria-label', `Edit ${model.display_name}`);
          editButton.addEventListener('click', () => openEditModel(model));
          actionGroup.append(editButton);
        }
        if (model.is_removable) {
          const removeButton = document.createElement('button');
          removeButton.className = 'model-button model-button--danger model-remove-button';
          removeButton.textContent = 'Remove';
          removeButton.type = 'button';
          removeButton.setAttribute('aria-label', `Remove ${model.display_name} from the public catalog`);
          removeButton.addEventListener('click', () => removeModel(model, removeButton));
          actionGroup.append(removeButton);
        } else {
          actions.textContent = model.is_builtin || model.created_by === 'catalog-seed' ? 'Protected' : '';
        }
        if (actionGroup.childElementCount) actions.append(actionGroup);
        row.append(
          modelCell,
          statusCell,
          createCell(formatPrice(model.input_price)),
          createCell(formatPrice(model.output_price)),
          context,
          actions
        );
        body.append(row);
      });
      table.append(body);
      wrapper.append(table);
      section.append(wrapper);
      categoryRoot.append(section);
    });
  };

  const renderRemovedModels = (models) => {
    const query = search.value.trim().toLocaleLowerCase();
    const removed = models.filter((model) => !query || `${model.display_name} ${model.model_id} ${model.provider_model || ''}`.toLocaleLowerCase().includes(query));
    removedModelsSection.hidden = removed.length === 0;
    removedModelsCount.textContent = `${removed.length} ${removed.length === 1 ? 'model' : 'models'}`;
    removedModelsBody.replaceChildren();

    removed.forEach((model) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const displayName = document.createElement('div');
      displayName.className = 'model-table__name';
      displayName.textContent = model.display_name;
      const id = document.createElement('small');
      id.className = 'model-table__id';
      id.textContent = model.model_id;
      name.append(displayName, id);

      const status = createCell('Removed');
      status.className = 'model-removed__status';
      const provider = createCell(model.provider_model || 'Not configured');
      const actions = document.createElement('td');
      actions.className = 'model-table__actions';
      const restoreButton = document.createElement('button');
      restoreButton.className = 'model-button model-button--primary model-restore-button';
      restoreButton.type = 'button';
      restoreButton.textContent = 'Restore';
      restoreButton.setAttribute('aria-label', `Restore ${model.display_name} to the public catalog`);
      restoreButton.addEventListener('click', () => restoreModel(model, restoreButton));
      const permanentDeleteButton = document.createElement('button');
      permanentDeleteButton.className = 'model-button model-button--danger model-permanent-delete-button';
      permanentDeleteButton.type = 'button';
      permanentDeleteButton.textContent = 'Permanently delete';
      permanentDeleteButton.setAttribute('aria-label', `Permanently delete ${model.display_name}`);
      permanentDeleteButton.addEventListener('click', () => openPermanentDeleteDialog(model));
      const actionGroup = document.createElement('div');
      actionGroup.className = 'model-table__action-group';
      actionGroup.append(restoreButton, permanentDeleteButton);
      actions.append(actionGroup);
      row.append(name, status, provider, actions);
      removedModelsBody.append(row);
    });
  };

  const renderChatAvailability = (models) => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = models.filter((model) => !query || `${model.display_name} ${model.model_id} ${model.provider_model || ''}`.toLocaleLowerCase().includes(query));
    const assignedCount = models.filter((model) => model.is_chat_available === true).length;
    const readyCount = models.filter((model) => modelSetupState(model).ready).length;
    chatAvailabilityCount.textContent = `${assignedCount} assigned · ${readyCount} ready`;
    chatAvailabilityBody.replaceChildren();

    if (!filtered.length) {
      const row = document.createElement('tr');
      const empty = createCell(query ? 'No models match this search.' : 'No active models are available.');
      empty.colSpan = 3;
      empty.className = 'model-empty';
      row.append(empty);
      chatAvailabilityBody.append(row);
      return;
    }

    filtered.forEach((model) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const displayName = document.createElement('div');
      displayName.className = 'model-table__name';
      displayName.textContent = model.display_name;
      const id = document.createElement('small');
      id.className = 'model-table__id';
      id.textContent = model.model_id;
      name.append(displayName, id);
      if (model.is_chat_available && model.chat_capability) {
        const capability = document.createElement('small');
        capability.className = 'model-chat-capability';
        capability.textContent = model.chat_capability;
        name.append(capability);
      }

      const availability = document.createElement('td');
      const label = document.createElement('label');
      label.className = 'model-chat-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = model.is_chat_available === true;
      checkbox.setAttribute('aria-label', `Make ${model.display_name} available in Kiel Chat`);
      checkbox.addEventListener('change', () => updateChatAvailability(model, checkbox));
      const track = document.createElement('span');
      track.className = 'model-chat-toggle__track';
      const accessibleText = document.createElement('span');
      accessibleText.className = 'model-visually-hidden';
      accessibleText.textContent = `Available in Kiel Chat: ${model.display_name}`;
      label.append(checkbox, track, accessibleText);
      availability.append(label);
      row.append(name, createSetupStatusCell(model), availability);
      chatAvailabilityBody.append(row);
    });
  };

  let allModels = [];
  let allRemovedModels = [];
  let studioModels = [];
  let assignedStudioModelIds = new Set();
  let draftStudioModelIds = new Set();
  let studioAssignmentsSaving = false;

  const studioAssignmentsHaveChanges = () => (
    assignedStudioModelIds.size !== draftStudioModelIds.size
    || [...assignedStudioModelIds].some((modelId) => !draftStudioModelIds.has(modelId))
  );

  const renderStudioModelAssignments = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = studioModels.filter((model) => (
      !query || `${model.display_name} ${model.model_id} ${model.provider_model || ''} ${model.category || ''}`.toLocaleLowerCase().includes(query)
    ));
    const assignableCount = studioModels.filter((model) => model.is_assignable).length;
    const assignedCount = draftStudioModelIds.size;
    studioModelAssignmentCount.textContent = `${assignedCount} assigned · ${studioModels.length} models · ${assignableCount} ready`;
    saveStudioModelAssignmentsButton.disabled = studioAssignmentsSaving || !studioAssignmentsHaveChanges();
    studioModelAssignmentBody.replaceChildren();

    if (!filtered.length) {
      const row = document.createElement('tr');
      const empty = createCell(query ? 'No models match this search.' : 'No models are currently available in the registry.');
      empty.colSpan = 5;
      empty.className = 'model-empty';
      row.append(empty);
      studioModelAssignmentBody.append(row);
      return;
    }

    filtered.forEach((model) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const displayName = document.createElement('div');
      displayName.className = 'model-table__name';
      displayName.textContent = model.display_name || model.model_id;
      const id = document.createElement('small');
      id.className = 'model-table__id';
      id.textContent = model.model_id;
      name.append(displayName, id);

      const category = createCell(categoryDefinitions.find(([id]) => id === model.category)?.[1] || model.category || 'Other');
      const provider = createCell(model.provider_model || model.model_id);
      provider.className = 'model-table__id';
      const readiness = createCell(model.is_assignable
        ? 'Ready'
        : model.is_studio_supported
          ? 'Configure model'
          : 'Not supported');
      readiness.className = `model-studio-readiness ${model.is_assignable ? 'is-ready' : model.is_studio_supported ? 'is-configure' : 'is-unsupported'}`;
      readiness.title = model.status || '';
      const assignment = document.createElement('td');
      const label = document.createElement('label');
      label.className = 'model-chat-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = draftStudioModelIds.has(model.model_id);
      checkbox.disabled = studioAssignmentsSaving || !model.is_assignable;
      checkbox.setAttribute('aria-label', `Assign ${model.display_name || model.model_id} to Studio`);
      if (!model.is_assignable) checkbox.title = model.status || 'This model is not currently available for Studio.';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) draftStudioModelIds.add(model.model_id);
        else draftStudioModelIds.delete(model.model_id);
        setStatus(
          studioModelAssignmentStatus,
          studioAssignmentsHaveChanges() ? 'Unsaved Studio model assignment changes.' : 'Assignments are up to date.',
          studioAssignmentsHaveChanges() ? '' : 'success'
        );
        renderStudioModelAssignments();
      });
      const track = document.createElement('span');
      track.className = 'model-chat-toggle__track';
      const accessibleText = document.createElement('span');
      accessibleText.className = 'model-visually-hidden';
      accessibleText.textContent = `Assigned to Studio: ${model.display_name || model.model_id}`;
      label.append(checkbox, track, accessibleText);
      assignment.append(label);
      row.append(name, category, provider, readiness, assignment);
      studioModelAssignmentBody.append(row);
    });
  };

  const loadStudioModelAssignments = async () => {
    studioModelAssignmentBody.innerHTML = '<tr><td colspan="5" class="model-empty">Loading Studio model assignments…</td></tr>';
    try {
      const payload = await request('/v1/admin/studio/models', { cache: 'no-store' });
      studioModels = Array.isArray(payload.models) ? payload.models : [];
      assignedStudioModelIds = new Set(Array.isArray(payload.assigned_model_ids) ? payload.assigned_model_ids : []);
      draftStudioModelIds = new Set(assignedStudioModelIds);
      setStatus(studioModelAssignmentStatus, '');
      renderStudioModelAssignments();
    } catch (error) {
      studioModels = [];
      studioModelAssignmentCount.textContent = 'Model registry unavailable';
      saveStudioModelAssignmentsButton.disabled = true;
      studioModelAssignmentBody.innerHTML = '<tr><td colspan="5" class="model-empty">Studio assignments could not be loaded.</td></tr>';
      setStatus(studioModelAssignmentStatus, error.message || 'Unable to load Studio model assignments.', 'error');
    }
  };

  saveStudioModelAssignmentsButton.addEventListener('click', async () => {
    if (studioAssignmentsSaving || !studioAssignmentsHaveChanges()) return;
    studioAssignmentsSaving = true;
    renderStudioModelAssignments();
    setStatus(studioModelAssignmentStatus, 'Saving Studio model assignments…');
    try {
      const payload = await request('/v1/admin/studio/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_ids: [...draftStudioModelIds] })
      });
      assignedStudioModelIds = new Set(Array.isArray(payload.assigned_model_ids) ? payload.assigned_model_ids : [...draftStudioModelIds]);
      draftStudioModelIds = new Set(assignedStudioModelIds);
      setStatus(studioModelAssignmentStatus, 'Studio model assignments saved.', 'success');
    } catch (error) {
      setStatus(studioModelAssignmentStatus, error.message || 'Unable to save Studio model assignments.', 'error');
    } finally {
      studioAssignmentsSaving = false;
      renderStudioModelAssignments();
    }
  });

  const loadModels = async () => {
    addButton.disabled = true;
    setStatus(pageStatus, 'Loading the model registry…');
    try {
      const [catalog, admin] = await Promise.all([
        request('/v1/models/catalog', { cache: 'no-store' }),
        request('/v1/admin/models', { cache: 'no-store' })
      ]);
      const adminById = new Map((admin.models || []).map((model) => [model.model_id, model]));
      allRemovedModels = (admin.models || []).filter((model) => model.is_active === false);
      allModels = (catalog.models || []).map((model) => {
        const managedModel = adminById.get(model.model_id);
        return {
          ...(managedModel || {}),
          ...model,
          is_configured: model.is_configured ?? managedModel?.is_configured ?? false,
          is_ready: model.is_ready ?? managedModel?.is_ready ?? false,
          provider_model: model.provider_model || managedModel?.provider_model || null,
          is_editable: Boolean(managedModel),
          is_removable: Boolean(managedModel)
        };
      });
      allModels.sort((left, right) => {
        if (left.category !== right.category) return categoryDefinitions.findIndex(([id]) => id === left.category) - categoryDefinitions.findIndex(([id]) => id === right.category);
        if (left.is_new !== right.is_new) return left.is_new ? -1 : 1;
        return String(right.created_at || '').localeCompare(String(left.created_at || ''));
      });
      summary.textContent = `${allModels.length} models across ${categoryDefinitions.length} categories`;
      renderCategories(allModels);
      renderChatAvailability(allModels);
      renderRemovedModels(allRemovedModels);
      await loadStudioModelAssignments();
      setStatus(pageStatus, 'Model catalog is up to date.', 'success');
      addButton.disabled = false;
    } catch (error) {
      const authFailure = error.status === 401 || error.status === 403;
      categoryRoot.replaceChildren();
      summary.textContent = 'Registry unavailable';
      setStatus(pageStatus, authFailure ? 'Admin sign-in is required to manage models.' : error.message, 'error');
      addButton.disabled = authFailure;
      if (authFailure) {
        const signIn = document.createElement('a');
        signIn.className = 'model-button';
        signIn.href = '/login.html?return_to=admin-models.html';
        signIn.textContent = 'Sign in';
        pageStatus.append(' ', signIn);
      }
    }
  };

  categoryDefinitions.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    categorySelect.append(option);
  });

  const updateCategoryRuntimeNote = () => {
    const isMultimodal = categorySelect.value === 'multimodal';
    multimodalOptions.hidden = !isMultimodal;
    modelTypeLabel.required = isMultimodal;
    multimodalProfile.required = isMultimodal;
    const supportedNotes = {
      'text-generation': 'Ready models are listed now; API access activates after the endpoint, rates, and context are configured.',
      'image-understanding': 'Ready models are listed now; API access activates after the endpoint, rates, and context are configured.',
      multimodal: 'Ready models are listed now; API access activates after the endpoint, rates, and context are configured.',
      'image-generation': 'Ready models are listed now; API access activates after the image endpoint and pricing are configured.',
      voice: 'Catalog only: no voice inference endpoint is currently available.',
      'video-generation': 'Catalog only: no video inference endpoint is currently available.',
      embeddings: 'Catalog only: no embedding inference endpoint is currently available.'
    };
    categoryRuntimeNote.textContent = supportedNotes[categorySelect.value] || '';
  };
  categorySelect.addEventListener('change', updateCategoryRuntimeNote);
  modelForm.addEventListener('reset', () => window.setTimeout(updateCategoryRuntimeNote, 0));
  updateCategoryRuntimeNote();

  modelName.addEventListener('input', () => {
    if (!editingModelId) {
      modelIdPreview.textContent = slugify(modelName.value) || 'generated-from-model-name';
    }
  });

  addButton.addEventListener('click', () => {
    modelForm.reset();
    resetModelEditor();
    setStatus(dialogStatus, '');
    dialog.showModal();
    modelName.focus();
  });
  document.getElementById('closeModelDialog').addEventListener('click', () => dialog.close());
  document.getElementById('cancelModelDialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', resetModelEditor);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog.open) dialog.close();
  });
  search.addEventListener('input', () => {
    renderCategories(allModels);
    renderChatAvailability(allModels);
    renderRemovedModels(allRemovedModels);
    renderStudioModelAssignments();
  });

  modelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!modelForm.reportValidity()) return;
    const modelId = editingModelId || slugify(modelName.value);
    const payload = {
      display_name: modelName.value.trim(),
      model_id: modelId,
      provider_model: providerModelInput.value.trim() || null,
      category: categorySelect.value,
      type_label: categorySelect.value === 'multimodal' ? modelTypeLabel.value.trim() : null,
      modalities: categorySelect.value === 'multimodal' ? multimodalProfile.value.split(',') : [],
      input_price: document.getElementById('inputPrice').value === '' ? null : Number(document.getElementById('inputPrice').value),
      cache_price: 0,
      output_price: document.getElementById('outputPrice').value === '' ? null : Number(document.getElementById('outputPrice').value),
      max_context: document.getElementById('maxContext').value === '' ? null : Number(document.getElementById('maxContext').value)
    };
    if (modelId.length < 2) {
      setStatus(dialogStatus, 'Enter a model name that can produce a valid ID.', 'error');
      return;
    }

    publishButton.disabled = true;
    setStatus(dialogStatus, editingModelId ? 'Saving model changes…' : 'Publishing model…');
    try {
      const isEditing = Boolean(editingModelId);
      await request(isEditing ? `/v1/admin/models/${encodeURIComponent(modelId)}` : '/v1/admin/models', {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setStatus(dialogStatus, isEditing ? 'Model updated.' : 'Model published.', 'success');
      dialog.close();
      setStatus(pageStatus, isEditing ? `${payload.display_name} updated.` : `${payload.display_name} published. It is now at the top of its category.`, 'success');
      await loadModels();
    } catch (error) {
      setStatus(dialogStatus, error.message || 'Unable to publish model.', 'error');
    } finally {
      publishButton.disabled = false;
    }
  });

  document.getElementById('refreshModels').addEventListener('click', loadModels);
  loadModels();
})();
