// Use the page host for local development so we don't mix localhost vs 127.0.0.1
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '';
const API_BASE_CANDIDATES = isLocal
  ? [
      `http://${window.location.hostname || 'localhost'}:8000`,
      'http://127.0.0.1:8000',
      'http://localhost:8000',
      'http://127.0.0.1:8001',
      'http://localhost:8001',
      `http://${window.location.hostname || 'localhost'}:8001`
    ].filter((value, index, list) => list.indexOf(value) === index)
  : ['https://kieltech-backend.onrender.com'];

function createStudioStreamRenderer(targetBody) {
  let text = '';
  let pending = '';
  let frameId = 0;
  let drainResolvers = [];
  let isFinalizing = false;
  let inCodeBlock = false;
  let proseText = '';
  let proseContainer = null;
  let codeContainer = null;
  let codeElement = null;
  const codeCharactersPerFrame = 160;

  const appendProse = (chunk) => {
    if (!chunk) return;
    proseText += chunk;
    if (!proseContainer) {
      proseContainer = document.createElement('div');
      proseContainer.className = 'studio-stream-prose';
      targetBody.appendChild(proseContainer);
    }
    proseContainer.innerHTML = parseMarkdown(proseText);
  };

  const startCodeBlock = (language) => {
    codeContainer = document.createElement('div');
    codeContainer.className = 'studio-chat-code studio-chat-code--streaming';

    const header = document.createElement('div');
    header.className = 'studio-chat-code__header';
    const languageLabel = document.createElement('span');
    languageLabel.textContent = language.trim() || 'code';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'studio-chat-code__copy';
    copyButton.dataset.studioCopyCode = '';
    copyButton.setAttribute('aria-label', 'Copy code');
    copyButton.title = 'Copy code';
    copyButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>';
    header.append(languageLabel, copyButton);

    const pre = document.createElement('pre');
    codeElement = document.createElement('code');
    pre.appendChild(codeElement);
    codeContainer.append(header, pre);
    targetBody.appendChild(codeContainer);
    proseContainer = null;
    proseText = '';
    inCodeBlock = true;
  };

  const finishCodeBlock = () => {
    const code = codeElement?.textContent || '';
    if (codeElement && code.length <= 40000) codeElement.innerHTML = syntaxHighlight(code);
    codeContainer?.classList.remove('studio-chat-code--streaming');
    codeContainer = null;
    codeElement = null;
    inCodeBlock = false;
  };

  const appendCodeText = (value) => {
    if (value && codeElement) codeElement.appendChild(document.createTextNode(value));
  };

  const renderPending = () => {
    while (pending) {
      if (inCodeBlock) {
        const closingFence = /\n```[ \t]*(?:\r?\n)/.exec(pending);
        if (closingFence && closingFence.index <= codeCharactersPerFrame) {
          appendCodeText(pending.slice(0, closingFence.index));
          pending = pending.slice(closingFence.index + closingFence[0].length);
          finishCodeBlock();
          continue;
        }
        if (isFinalizing) {
          const chunkLength = Math.min(codeCharactersPerFrame, pending.length);
          appendCodeText(pending.slice(0, chunkLength));
          pending = pending.slice(chunkLength);
          if (pending) break;
          continue;
        }
        const safeLength = Math.max(0, pending.length - 4);
        if (!safeLength) break;
        const chunkLength = Math.min(codeCharactersPerFrame, safeLength);
        appendCodeText(pending.slice(0, chunkLength));
        pending = pending.slice(chunkLength);
        if (pending) break;
        continue;
      }

      const openingFence = /(?:^|\n)```([^\r\n]*)\r?\n/.exec(pending);
      if (openingFence) {
        const fenceStart = openingFence.index + (openingFence[0].startsWith('\n') ? 1 : 0);
        appendProse(pending.slice(0, fenceStart));
        pending = pending.slice(openingFence.index + openingFence[0].length);
        startCodeBlock(openingFence[1]);
        break;
      }

      if (isFinalizing) {
        appendProse(pending);
        pending = '';
        continue;
      }

      const possibleFence = pending.lastIndexOf('\n```');
      const safeLength = Math.max(
        0,
        Math.min(pending.length - 16, possibleFence >= 0 ? possibleFence : pending.length - 16),
      );
      if (!safeLength) break;
      appendProse(pending.slice(0, safeLength));
      pending = pending.slice(safeLength);
      break;
    }
  };

  const renderFrame = () => {
    frameId = 0;
    renderPending();
    if (isFinalizing && !pending && inCodeBlock) finishCodeBlock();
    if (pending) {
      frameId = window.requestAnimationFrame(renderFrame);
      return;
    }
    const resolvers = drainResolvers;
    drainResolvers = [];
    resolvers.forEach((resolve) => resolve());
  };

  const scheduleRender = () => {
    if (!frameId) frameId = window.requestAnimationFrame(renderFrame);
  };

  const reset = () => {
    window.cancelAnimationFrame(frameId);
    frameId = 0;
    text = '';
    pending = '';
    isFinalizing = false;
    inCodeBlock = false;
    proseText = '';
    proseContainer = null;
    codeContainer = null;
    codeElement = null;
    targetBody.replaceChildren();
  };

  return {
    append(chunk) {
      text += chunk;
      pending += chunk;
      scheduleRender();
    },
    finish(finalText = text) {
      if (!finalText.startsWith(text)) {
        reset();
        text = finalText;
        pending = finalText;
      } else if (finalText.length > text.length) {
        const remainingText = finalText.slice(text.length);
        text = finalText;
        pending += remainingText;
      }
      isFinalizing = true;
      return new Promise((resolve) => {
        drainResolvers.push(resolve);
        scheduleRender();
      });
    }
  };
}

const state = {
  token: localStorage.getItem('kieltechToken') || ''
};

let studioClipboard = null;
let selectedExplorerEntryPath = '';

let activeRevokeTokenId = null;
let runtimeDiagnosticState = { errors: 0, warnings: 0 };
let openEditorTabNames = [];
let openEditorTabFolders = [];
let activeEditorFileName = null;
let activeEditorFolderName = '';
let activePreviewPagePath = '';
let previewRequestVersion = 0;
let previewConsoleEntries = [];
let previewConsoleUiState = {
  filter: 'all',
  search: '',
  paused: false,
  status: 'running',
  lastProjectKey: 'default'
};
const reportedStaticDiagnosticKeys = new Set();
let studioSelectedModel = localStorage.getItem('kieltech-studio-model') || '';

async function initStudioModelSelector() {
  const selector = document.getElementById('studioModelSelector');
  const menu = document.getElementById('studioModelMenu');
  const label = document.getElementById('studioSelectedModelLabel');
  if (!label) return;
  if (!selector || !menu) {
    label.textContent = 'No model assigned';
    return;
  }

  const token = localStorage.getItem('kieltechToken') || '';
  let candidates = [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/v1/studio/models`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (res.ok) {
      const payload = await res.json().catch(() => ({}));
      let items = [];
      if (Array.isArray(payload)) items = payload;
      else if (Array.isArray(payload.models)) items = payload.models;
      else if (Array.isArray(payload.items)) items = payload.items;
      else if (Array.isArray(payload.model_ids)) items = payload.model_ids;

      if (items.length) {
        candidates = items.map((item) => {
          if (typeof item === 'string') return { id: item, label: item };
          if (item && typeof item === 'object') {
            const id = item.model_id || item.id || item.name || '';
          const label = item.display_name || item.name || id;
            return { id, label };
          }
          return null;
        }).filter(Boolean);
      }
    } else if (res.status === 401) {
      console.warn('Studio model request requires a valid authenticated session.');
    } else {
      console.warn('Studio model request failed:', res.status);
    }
  } catch (e) {
    console.warn('Unable to load assigned studio models:', e);
  }

  if (!candidates.length) {
    studioSelectedModel = '';
    localStorage.removeItem('kieltech-studio-model');
    label.textContent = 'No models assigned';
    menu.innerHTML = '';
    menu.hidden = true;
    menu.classList.remove('is-open');
    selector.setAttribute('aria-expanded', 'false');
    return;
  }

  if (!candidates.find((c) => c.id === studioSelectedModel)) studioSelectedModel = candidates[0].id;
  const selectedCandidate = candidates.find((c) => c.id === studioSelectedModel) || candidates[0];
  label.textContent = selectedCandidate.label || studioSelectedModel;

  const closeMenu = () => {
    menu.hidden = true;
    menu.classList.remove('is-open');
    selector.setAttribute('aria-expanded', 'false');
  };

  selector.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    menu.classList.toggle('is-open', willOpen);
    selector.setAttribute('aria-expanded', String(willOpen));
  });

  menu.innerHTML = candidates.map((c) => `
    <button type="button" class="studio-model-menu__item" data-model="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>
  `).join('\n');

  menu.querySelectorAll('[data-model]').forEach((option) => {
    option.addEventListener('click', () => {
      studioSelectedModel = option.dataset.model;
      const sel = candidates.find((c) => c.id === studioSelectedModel) || { label: studioSelectedModel };
      label.textContent = sel.label || studioSelectedModel;
      localStorage.setItem('kieltech-studio-model', studioSelectedModel);
      menu.querySelectorAll('[data-model]').forEach((item) => item.classList.toggle('is-active', item === option));
      showToast(`${sel.label || studioSelectedModel} selected`);
      closeMenu();
    });
  });

  menu.querySelector(`[data-model="${studioSelectedModel}"]`)?.classList.add('is-active');
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && event.target !== selector) closeMenu();
  });
}

// State representing the project structure
const studioWorkspaceStorageKey = 'kieltech-studio-workspace-v1';
const studioEditorStateStorageKey = 'kieltech-studio-editor-state-v1';
const placeholderWorkspaceNames = new Set(['app', 'assets', 'src', 'metadata.json', 'build.gradle.kts', 'MainActivity.kt', 'strings.xml', 'ResultScreen.kt']);
let projectFiles = [];
let studioWorkspaceReady = false;
let studioServerSaveTimer = 0;
let studioServerSaveInFlight = Promise.resolve();

function setStudioSaveStatus(message, stateName = 'saved') {
  const status = document.getElementById('studioSaveStatus');
  if (!status) return;
  status.textContent = stateName === 'saved' ? '' : message;
  status.hidden = stateName === 'saved';
  status.dataset.state = stateName;
  const retry = document.getElementById('studioSaveRetry');
  if (retry) retry.hidden = stateName !== 'error';
}

async function saveStudioWorkspaceToServer() {
  setStudioSaveStatus('Saving…', 'saving');
  const projectId = await ensureServerStudioProject(localStorage.getItem('kieltech-studio-project-name') || 'KielTech Studio project');
  const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({
      files: getWorkspaceFiles().map((file) => ({ path: file.path, content: String(file.content || '') }))
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `Save failed (HTTP ${response.status}).`);
  setStudioSaveStatus('Saved to your account', 'saved');
}

function scheduleStudioServerSave() {
  if (!studioWorkspaceReady || !state.token || document.body.dataset.sharePermission === 'read-only') return;
  setStudioSaveStatus('Unsaved changes', 'unsaved');
  window.clearTimeout(studioServerSaveTimer);
  studioServerSaveTimer = window.setTimeout(() => {
    studioServerSaveInFlight = studioServerSaveInFlight
      .catch(() => {})
      .then(saveStudioWorkspaceToServer)
      .catch((error) => {
        console.error('Unable to save Studio workspace:', error);
        setStudioSaveStatus('Save failed — retry after checking your connection', 'error');
      });
  }, 700);
}

async function flushStudioServerSave() {
  window.clearTimeout(studioServerSaveTimer);
  if (!studioWorkspaceReady || !state.token || document.body.dataset.sharePermission === 'read-only') return;
  studioServerSaveInFlight = studioServerSaveInFlight.catch(() => {}).then(saveStudioWorkspaceToServer);
  await studioServerSaveInFlight;
}

// Expose projectFiles globally so tool router and external code can access it
Object.defineProperty(window, 'projectFiles', {
  get() { return projectFiles; },
  set(value) { projectFiles = value; },
  configurable: true
});

function scrollExplorerToEntry(entryPath = '') {
  if (!entryPath) return;
  const fileTreeContainer = document.querySelector('.studio-file-tree__content, #studioFileTreeContent');
  if (!fileTreeContainer) return;
  const item = Array.from(fileTreeContainer.querySelectorAll('.studio-file-item')).find((node) => node.dataset.entryPath === entryPath);
  if (!item) return;
  item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderFileExplorer() {
  const fileTreeContainer = document.querySelector('.studio-file-list') || document.getElementById('studioFileList');
  if (!fileTreeContainer) return;

  const renderEntry = (entry, depth = 0, parentName = '') => {
          const isFolder = entry.type === 'folder';
          const icon = getFileIconMarkup(entry.name, isFolder, entry.open);
          const activeClass = entry.active ? 'active' : '';
    const indentClass = depth ? `indent-${depth}` : '';
    const folderClass = isFolder ? 'folder' : 'file';
    const statusIcon = entry.status === 'edited'
      ? '<span class="material-symbols-outlined file-status edited">check_circle</span>'
      : entry.status === 'draft'
        ? '<span class="material-symbols-outlined file-status draft">draft</span>'
        : '';

    const toggleIcon = isFolder ? `<span class="material-symbols-outlined folder-toggle">${entry.open ? 'expand_more' : 'chevron_right'}</span>` : '';
    const dataset = isFolder ? `data-folder-name="${escapeHtml(entry.name)}"` : `data-folder-name="${escapeHtml(parentName)}"`;
    const entryPath = parentName ? `${parentName}/${entry.name}` : entry.name;
    const readOnly = document.body.dataset.sharePermission === 'read-only';
    const contextActions = '<button type="button" data-context-action="new-file">New File</button><button type="button" data-context-action="new-folder">New Folder</button>';
    const editActions = readOnly ? '' : '<button type="button" data-context-action="copy">Copy</button><button type="button" data-context-action="paste">Paste</button><button type="button" data-context-action="rename">Rename</button><button type="button" data-context-action="delete">Delete</button>';

    const row = `
      <li class="studio-file-item ${folderClass} ${activeClass} ${indentClass}" data-filename="${escapeHtml(entry.name)}" data-entry-path="${escapeHtml(entryPath)}" ${dataset}>
        ${toggleIcon}
        ${icon}
        <span class="label">${escapeHtml(entry.name)}</span>
        ${statusIcon}
        <button class="studio-file-menu-button" type="button" aria-label="Actions for ${escapeHtml(entry.name)}" aria-expanded="false" title="More actions"><span class="material-symbols-outlined" aria-hidden="true">more_horiz</span></button>
        <span class="studio-file-context-menu" hidden>
          ${contextActions}${editActions}<button type="button" data-context-action="copy-path">Copy Path</button>
        </span>
      </li>
    `;

    if (isFolder && Array.isArray(entry.children) && entry.open) {
      return row + entry.children.map((child) => renderEntry(child, depth + 1, entry.name)).join('');
    }

    return row;
  };

  fileTreeContainer.innerHTML = projectFiles.map((entry) => renderEntry(entry)).join('');
  attachFileExplorerItemListeners(fileTreeContainer);
}

function attachFileExplorerItemListeners(fileTreeContainer) {
  if (!fileTreeContainer) return;

  fileTreeContainer.querySelectorAll('.studio-file-item').forEach((item) => {
    item.onclick = (event) => {
      const target = event.target.closest('.studio-file-item');
      if (!target) return;
      if (event.target.closest('.studio-file-menu-button, .studio-file-context-menu')) return;
      const filename = target.dataset.filename;
      const folderName = target.dataset.folderName;

      if (target.classList.contains('folder')) {
        projectFiles = projectFiles.map((file) => file.name === filename && file.type === 'folder' ? { ...file, open: !file.open } : file);
        renderFileExplorer();
        saveWorkspaceState();
        return;
      }

      selectFileByName(filename, folderName);
    };
  });
}

function saveWorkspaceState() {
  try {
    localStorage.setItem(studioWorkspaceStorageKey, JSON.stringify({ projectFiles, openEditorTabNames, openEditorTabFolders, activeEditorFileName, activeEditorFolderName, activePreviewPagePath }));
    scheduleStudioServerSave();
  } catch (error) {
    console.warn('Unable to save studio workspace state:', error);
  }
}

async function syncSharedWorkspace() {
  const shareToken = new URLSearchParams(window.location.search).get('share');
  if (!shareToken || document.body.dataset.sharePermission !== 'read-write') return;
  try {
    await fetch(`${getApiBaseUrl()}/v1/studio/shares/${encodeURIComponent(shareToken)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Share-Token': shareToken },
      body: JSON.stringify({ project_files: projectFiles })
    });
  } catch (error) {
    console.warn('Unable to sync shared workspace:', error);
  }
}

function restoreWorkspaceState() {
  try {
    const rawState = localStorage.getItem(studioWorkspaceStorageKey);
    if (!rawState) return;
    const storedState = JSON.parse(rawState);
    const storedFiles = Array.isArray(storedState) ? storedState : storedState.projectFiles;
    const removePlaceholders = (entries) => entries
      .filter((entry) => !placeholderWorkspaceNames.has(entry.name))
      .map((entry) => entry.type === 'folder' && Array.isArray(entry.children)
        ? { ...entry, children: removePlaceholders(entry.children) }
        : entry);
    if (Array.isArray(storedFiles)) {
      projectFiles = removePlaceholders(storedFiles);
    }
    if (storedState && !Array.isArray(storedState)) {
      if (Array.isArray(storedState.openEditorTabNames)) openEditorTabNames = storedState.openEditorTabNames;
      if (Array.isArray(storedState.openEditorTabFolders)) openEditorTabFolders = storedState.openEditorTabFolders;
      if (typeof storedState.activeEditorFileName === 'string') activeEditorFileName = storedState.activeEditorFileName;
      if (typeof storedState.activeEditorFolderName === 'string') activeEditorFolderName = storedState.activeEditorFolderName;
      if (typeof storedState.activePreviewPagePath === 'string') activePreviewPagePath = storedState.activePreviewPagePath;
    }
  } catch (error) {
    console.warn('Unable to restore studio workspace state:', error);
  }
}

function addOrUpdateFile(filePath, newContent, status = 'edited') {
  const existing = projectFiles.find((file) => file.name === filePath);
  if (existing) {
    existing.content = newContent;
    existing.status = status;
  } else {
    projectFiles.push({
      name: filePath,
      type: 'file',
      status,
      content: newContent
    });
  }
  renderFileExplorer();
  renderEditor();
  refreshPreviewFromWorkspace();
  saveWorkspaceState();
  refreshDiagnostics();
}

function getDefaultCodeFileName() {
  const preferred = 'metadata.json';
  if (findFileEntry(preferred)) {
    return preferred;
  }

  const fileEntries = projectFiles.flatMap((file) => {
    if (file.type === 'file') return [file];
    if (file.type === 'folder' && Array.isArray(file.children) && file.open) {
      return file.children.filter((child) => child.type === 'file');
    }
    return [];
  });

  return fileEntries[0]?.name || null;
}

function selectDefaultCodeFile() {
  const defaultFileName = getDefaultCodeFileName();
  if (!defaultFileName) return;
  selectFileByName(defaultFileName);
}

function getActiveFile() {
  let activeFile = projectFiles.find((file) => file.active && file.type === 'file');
  if (!activeFile) {
    for (const file of projectFiles) {
      if (file.type === 'file') {
        activeFile = file;
        break;
      }
      if (file.type === 'folder' && file.open && Array.isArray(file.children)) {
        const child = file.children.find((childFile) => childFile.active && childFile.type === 'file');
        if (child) {
          activeFile = child;
          break;
        }
      }
    }
  }

  if (!activeFile) {
    for (const file of projectFiles) {
      if (file.type === 'file') {
        activeFile = file;
        break;
      }
      if (file.type === 'folder' && Array.isArray(file.children) && file.children.length) {
        activeFile = file.children[0];
        break;
      }
    }
  }

  return activeFile || null;
}

function getFileExtension(fileName = '') {
  const normalizedName = String(fileName || '').toLowerCase();
  if (normalizedName === 'dockerfile') return 'docker';
  if (normalizedName === 'makefile') return 'makefile';
  if (normalizedName === 'package.json') return 'nodejs';
  if (normalizedName === 'package-lock.json') return 'npm';
  return normalizedName.split('.').pop() || 'default';
}

function getExternalFileIconName(fileName = '') {
  const extension = getFileExtension(fileName);
  const canonical = {
    default: 'txt',
    txt: 'txt',
    md: 'markdown',
    mdx: 'markdown',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'sass',
    sass: 'sass',
    js: 'javascript',
    jsx: 'react',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    pyw: 'python',
    pyi: 'python',
    ipynb: 'python',
    json: 'json',
    jsonc: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    xaml: 'xml',
    kt: 'kotlin',
    kts: 'kotlin',
    java: 'java',
    gradle: 'gradle',
    env: 'settings',
    hm: 'markdown',
    example: 'settings',
    sh: 'terminal',
    bash: 'terminal',
    zsh: 'terminal',
    fish: 'terminal',
    ps1: 'powershell',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    docker: 'docker',
    dockerfile: 'docker',
    makefile: 'makefile',
    nodejs: 'nodejs',
    npm: 'npm',
    lock: 'npm',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    svg: 'svg',
    webp: 'image',
    pdf: 'pdf',
    zip: 'zip',
    rar: 'zip',
    tar: 'zip',
    gz: 'zip',
    mp4: 'video',
    mp3: 'audio',
    wav: 'audio',
    csv: 'table',
    tsv: 'table',
    gitignore: 'git',
    gitattributes: 'git',
    log: 'log',
    ini: 'settings',
    cfg: 'settings',
    toml: 'settings'
  };

  if (!(extension in canonical)) {
    return 'txt';
  }

  const normalizedName = canonical[extension] || 'txt';
  return normalizedName === 'default' ? 'txt' : normalizedName;
}

function getFileIconMarkup(fileName = '', isFolder = false, isOpen = false) {
  const extension = getFileExtension(fileName);
  if (isFolder) {
    const folderPath = isOpen ? 'M3.5 7h6l2 2h9v10h-17z M3.5 7v-2h6l2 2' : 'M3.5 6.5h6l2 2h9v10h-17z';
    return `<span class="file-extension-icon file-icon--folder file-extension-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="${folderPath}"/></svg></span>`;
  }

  const safeExt = String(extension || 'txt').toLowerCase();
  const label = safeExt === 'txt' || safeExt === 'default' ? 'TXT' : (safeExt.length > 3 ? safeExt.slice(0, 3).toUpperCase() : safeExt.toUpperCase());
  const encodedSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="${label} file icon">
      <path d="M7.2 2.8h7.2l5.8 5.8v11.8a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 20.4V5A2.2 2.2 0 0 1 7.2 2.8Z" fill="#F8FAFC" stroke="#D0D7E2" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M14.4 2.8v5.8h5.8" fill="none" stroke="#D0D7E2" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8.3 10.8h7.4M8.3 13.7h7.4M8.3 16.6h5.3" fill="none" stroke="#6B7280" stroke-width="1" stroke-linecap="round"/>
      <rect x="8.15" y="15.9" width="7.4" height="4.1" rx="0.8" fill="#E5E7EB"/>
      <text x="11.85" y="18.8" text-anchor="middle" font-size="2.9" font-weight="700" fill="#475569" font-family="Arial, Helvetica, sans-serif">${label}</text>
    </svg>
  `);

  const externalIconName = getExternalFileIconName(fileName);
  const iconUrl = `https://cdn.jsdelivr.net/gh/PKief/vscode-material-icon-theme@main/icons/${encodeURIComponent(externalIconName)}.svg`;
  const fallbackDataUri = `data:image/svg+xml;charset=UTF-8,${encodedSvg}`;

  return `
    <span class="file-extension-icon file-icon--${escapeHtml(extension)}" aria-hidden="true">
      <img class="file-extension-image" src="${iconUrl}" alt="" loading="eager" onerror="this.onerror=null; this.src='${fallbackDataUri}';" />
    </span>
  `;
}

function findFileEntry(filename, folderName = '') {
  const normalizedName = String(filename || '').trim();
  if (!normalizedName) return null;

  const searchEntries = (entries, parentName = '') => {
    for (const entry of entries) {
      if (entry.type === 'file' && entry.name === normalizedName && (!folderName || parentName === folderName)) {
        return entry;
      }
      if (entry.type === 'folder' && Array.isArray(entry.children)) {
        const nestedMatch = searchEntries(entry.children, entry.name);
        if (nestedMatch) {
          return nestedMatch;
        }
      }
    }
    return null;
  };

  return searchEntries(projectFiles);
}

function markFileAsActive(filename, folderName = '') {
  const normalizedName = String(filename || '').trim();
  if (!normalizedName) return;

  selectedExplorerEntryPath = folderName ? `${folderName}/${normalizedName}` : normalizedName;

  const applyActiveState = (entries, parentName = '') => entries.map((entry) => {
    if (entry.type === 'folder' && Array.isArray(entry.children)) {
      return {
        ...entry,
        active: false,
        children: applyActiveState(entry.children, entry.name)
      };
    }

    return {
      ...entry,
      active: entry.type === 'file' && entry.name === normalizedName && (!folderName || parentName === folderName)
    };
  });

  projectFiles = applyActiveState(projectFiles);
  activeEditorFileName = normalizedName;
  activeEditorFolderName = folderName;
}

function getActiveFile() {
  if (activeEditorFileName) {
    const activeFile = findFileEntry(activeEditorFileName);
    if (activeFile) {
      return activeFile;
    }
  }

  let activeFile = projectFiles.find((file) => file.active && file.type === 'file');
  if (!activeFile) {
    for (const file of projectFiles) {
      if (file.type === 'file') {
        activeFile = file;
        break;
      }
      if (file.type === 'folder' && file.open && Array.isArray(file.children)) {
        const child = file.children.find((childFile) => childFile.active && childFile.type === 'file');
        if (child) {
          activeFile = child;
          break;
        }
      }
    }
  }

  if (!activeFile) {
    for (const file of projectFiles) {
      if (file.type === 'file') {
        activeFile = file;
        break;
      }
      if (file.type === 'folder' && Array.isArray(file.children) && file.children.length) {
        activeFile = file.children[0];
        break;
      }
    }
  }

  return activeFile || null;
}

function renderEditor() {
  const editorTabs = document.querySelector('.studio-editor-tabs');
  const codeViewer = document.getElementById('codeViewerContainer');
  if (!editorTabs || !codeViewer) return;

  if (!openEditorTabNames.length) {
    editorTabs.innerHTML = '<span class="studio-editor-empty">Select a file to open it</span>';
    codeViewer.innerHTML = '<div class="studio-code-viewer__empty">Select a file from the explorer to inspect its contents.</div>';
    return;
  }

  const tabFiles = openEditorTabNames
    .map((filename, index) => findFileEntry(filename, openEditorTabFolders[index] || ''))
    .filter(Boolean);

  if (!tabFiles.length) {
    editorTabs.innerHTML = '<span class="studio-editor-empty">Select a file to open it</span>';
    codeViewer.innerHTML = '<div class="studio-code-viewer__empty">Select a file from the explorer to inspect its contents.</div>';
    return;
  }

  const activeTabFile = findFileEntry(activeEditorFileName, activeEditorFolderName) || tabFiles[0];

  editorTabs.innerHTML = tabFiles.map((file, index) => `
    <div class="studio-editor-tab ${file.name === activeTabFile?.name && (openEditorTabFolders[index] || '') === activeEditorFolderName ? 'active' : ''}" data-filename="${escapeHtml(file.name)}" data-folder-name="${escapeHtml(openEditorTabFolders[index] || '')}">
      ${getFileIconMarkup(file.name)}
      <span>${escapeHtml(file.name)}</span>
      <button class="studio-editor-tab-close tab-close" type="button" data-filename="${escapeHtml(file.name)}" data-folder-name="${escapeHtml(openEditorTabFolders[index] || '')}" aria-label="Close ${escapeHtml(file.name)}">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
  `).join('');

  const content = activeTabFile?.content || '// No file selected.';
  const filename = activeTabFile?.name || 'code file';
  const source = String(content);
  const lines = source.split('\n');
  codeViewer.innerHTML = `
    <div class="studio-code-editor-shell">
      <div class="studio-code-editor-gutter" aria-hidden="true">${lines.map((_, index) => `<span class="studio-editor-line-number">${index + 1}</span>`).join('')}</div>
      <div class="studio-code-editor-highlight-wrapper">
        <pre class="studio-code-highlight-layer" aria-hidden="true">${syntaxHighlight(source) || '&nbsp;'}</pre>
        <textarea class="studio-code-editor-input" data-filename="${escapeHtml(filename)}" spellcheck="false" aria-label="Edit ${escapeHtml(filename)}">${escapeHtml(source)}</textarea>
      </div>
    </div>
  `;
}

function syntaxHighlight(code) {
  if (typeof code !== 'string') return '';
  const tokenPattern = /(?:<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/.*|#[0-9a-fA-F]{3,8}\b|@[\w-]+|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<\/?[A-Za-z][\w:-]*|\b(?:true|false|null|undefined|None|True|False|and|or|not|in|is|as|when|val|var|fun|data|object|interface|package|import|public|private|protected|internal|override|return|if|else|for|while|do|switch|case|break|continue|async|await|class|extends|implements|new|throw|try|catch|finally|const|let|function|def|from|yield|lambda|match|plugins|android|namespace|version)\b|\b(?:String|Int|Float|Double|Boolean|Long|List|Map|Any|Unit|void|number|boolean|object|unknown|never)\b|-?\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*(?=\s*:)|[{}[\]()<>.,;:?+\-*\/=&|%!~^])/g;
  let output = '';
  let cursor = 0;

  code.replace(tokenPattern, (token, offset) => {
    output += escapeHtml(code.slice(cursor, offset));
    const tokenClass = token.startsWith('//') || token.startsWith('/*') || token.startsWith('<!--')
      ? 'token-comment'
      : token.startsWith('#')
        ? 'token-number'
        : token.startsWith('@')
          ? 'token-decorator'
          : token.startsWith('<')
            ? 'token-tag'
      : token.startsWith('"') || token.startsWith("'") || token.startsWith('`')
        ? 'token-string'
        : /^(true|false|null|undefined|None|True|False|and|or|not|in|is|as|when|val|var|fun|data|object|interface|package|import|public|private|protected|internal|override|return|if|else|for|while|do|switch|case|break|continue|async|await|class|extends|implements|new|throw|try|catch|finally|const|let|function|def|from|yield|lambda|match|plugins|android|namespace|version)$/.test(token)
          ? 'token-keyword'
          : /^(String|Int|Float|Double|Boolean|Long|List|Map|Any|Unit|void|number|boolean|object|unknown|never)$/.test(token)
            ? 'token-type'
            : /[A-Za-z_$][\w$]*\s*\($/.test(token)
              ? 'token-function'
              : /[A-Za-z_$][\w$]*$/.test(token) && code[offset - 1] === ':'
                ? 'token-property'
                : /^[+\-*\/=&|%!~^?]+$/.test(token)
                  ? 'token-operator'
          : /^-?\d/.test(token)
            ? 'token-number'
            : 'token-punctuation';
    output += `<span class="${tokenClass}">${escapeHtml(token)}</span>`;
    cursor = offset + token.length;
    return token;
  });

  return output + escapeHtml(code.slice(cursor));
}

function prepareMarkdownCodeBlocks(text) {
  const blocks = [];
  const inlineBlocks = [];
  let source = String(text ?? '').replace(/```([\w+#.-]*)\s*\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.push({ language: language || 'code', code: code.replace(/^\n|\n$/g, '') }) - 1;
    return `\n@@STUDIO_CODE_BLOCK_${index}@@\n`;
  });
  source = source.replace(/`([^`\n]+)`/g, (_, code) => `@@STUDIO_INLINE_CODE_${inlineBlocks.push(code) - 1}@@`);
  return { source, blocks, inlineBlocks };
}

function restoreMarkdownCodeBlocks(html, blocks, inlineBlocks = []) {
  html = html.replace(/@@STUDIO_CODE_BLOCK_(\d+)@@/g, (_, index) => {
    const block = blocks[Number(index)];
    if (!block) return '';
    return `<div class="studio-chat-code"><div class="studio-chat-code__header"><span>${escapeHtml(block.language)}</span><button type="button" class="studio-chat-code__copy" data-studio-copy-code aria-label="Copy code" title="Copy code"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg></button></div><pre><code>${syntaxHighlight(block.code)}</code></pre></div>`;
  });
  return html.replace(/@@STUDIO_INLINE_CODE_(\d+)@@/g, (_, index) => {
    const code = inlineBlocks[Number(index)];
    return code === undefined ? '' : `<code>${escapeHtml(code)}</code>`;
  });
}

function prepareMarkdownTables(text) {
  const tables = [];
  let source = String(text ?? '').replace(/(\|[^\n]*\|)[ \t]*\n(?:[ \t]*\n)+(?=[ \t]*\|)/g, '$1\n').replace(/(\|[^\n]*\|)[ \t]*\n(?=[ \t]*\|)/g, '$1\n').replace(/(?:^|\n)(\|[^\n]+\|\n\|[^\n]+\|\n(?:\|[^\n]+\|\n?)+)/gim, (tableText) => {
    const rawRows = tableText.trim().split(/\r?\n/).filter((row) => row.trim());
    const headerCells = rawRows[0].trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map((cell) => cell.trim());
    const separatorCells = rawRows[1].trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map((cell) => cell.trim());
    if (headerCells.length < 2 || separatorCells.length < 2) return tableText;
    const rows = rawRows.map((row) => row.trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map((cell) => cell.trim()));
    const headers = rows.shift() || [];
    rows.shift();
    const alignments = headers.map((_, index) => {
      const marker = tableText.trim().split(/\r?\n/)[1]?.trim().replace(/^\|\s*|\s*\|$/g, '').split('|')[index]?.trim() || '';
      return marker.startsWith(':') && marker.endsWith(':') ? 'center' : marker.endsWith(':') ? 'right' : marker.startsWith(':') ? 'left' : '';
    });
    const cell = (value, tag, index) => `<${tag}${alignments[index] ? ` style="text-align:${alignments[index]}"` : ''}>${escapeHtml(String(value).replace(/\*/g, ''))}</${tag}>`;
    const markup = `<div class="studio-markdown-table-wrap" role="region" tabindex="0" aria-label="Scrollable response table"><table class="studio-markdown-table"><thead><tr>${headers.map((value, index) => cell(value, 'th', index)).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, index) => cell(row[index] || '', 'td', index)).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `\n@@STUDIO_TABLE_BLOCK_${tables.push(markup) - 1}@@\n`;
  });
  source = source.replace(/^([^\n]+\t[^\n]+(?:\t[^\n]+)+)\n((?:[^\n]+\t[^\n]+(?:\t[^\n]+)+\n?)+)/gm, (_, headerText, bodyText) => {
    const headers = headerText.split('\t').map((cell) => cell.trim());
    const rows = bodyText.trim().split(/\r?\n/).map((row) => row.split('\t').map((cell) => cell.trim()));
    const cell = (value, tag) => `<${tag}>${escapeHtml(String(value).replace(/\*/g, ''))}</${tag}>`;
    const markup = `<div class="studio-markdown-table-wrap" role="region" tabindex="0" aria-label="Scrollable response table"><table class="studio-markdown-table"><thead><tr>${headers.map((value) => cell(value, 'th')).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, index) => cell(row[index] || '', 'td')).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `\n@@STUDIO_TABLE_BLOCK_${tables.push(markup) - 1}@@\n`;
  });
  return { source, tables };
}

function restoreMarkdownTables(html, tables) {
  return html.replace(/@@STUDIO_TABLE_BLOCK_(\d+)@@/g, (_, index) => tables[Number(index)] || '');
}

if (!window.__kieltechStudioCodeCopyBound) {
  window.__kieltechStudioCodeCopyBound = true;
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-studio-copy-code]');
    if (!button) return;
    const code = button.closest('.studio-chat-code')?.querySelector('pre code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">check</span>';
      button.setAttribute('aria-label', 'Code copied');
      window.setTimeout(() => {
        button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">content_copy</span>';
        button.setAttribute('aria-label', 'Copy code');
      }, 1400);
    } catch (error) {
      button.setAttribute('aria-label', 'Copy failed');
    }
  });
}

function updateFileContent(content) {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  projectFiles = projectFiles.map((file) => {
    if (file.type === 'file' && file.name === activeFile.name) {
      return { ...file, content, status: 'edited' };
    }
    if (file.type === 'folder' && Array.isArray(file.children)) {
      return {
        ...file,
        children: file.children.map((child) => child.name === activeFile.name ? { ...child, content, status: 'edited' } : child)
      };
    }
    return file;
  });

  saveWorkspaceState();
  refreshDiagnostics();
}

function closeEditorTab(filename, folderName = '') {
  const normalizedName = String(filename || '').trim();
  if (!normalizedName) return;

  const tabIndex = openEditorTabNames.findIndex((name, index) => name === normalizedName && (openEditorTabFolders[index] || '') === folderName);
  if (tabIndex === -1) return;

  const wasActive = activeEditorFileName === normalizedName;
  openEditorTabNames.splice(tabIndex, 1);
  openEditorTabFolders.splice(tabIndex, 1);

  if (wasActive && openEditorTabNames.length) {
    const nextIndex = Math.min(tabIndex, openEditorTabNames.length - 1);
    activeEditorFileName = openEditorTabNames[nextIndex];
    activeEditorFolderName = openEditorTabFolders[nextIndex] || '';
  } else if (!openEditorTabNames.length) {
    activeEditorFileName = null;
    activeEditorFolderName = '';
  }

  renderFileExplorer();
  renderEditor();
  saveWorkspaceState();
}

function handleEditorTabClick(event) {
  const closeButton = event.target.closest('.studio-editor-tab-close, .tab-close');
  const tab = event.target.closest('.studio-editor-tab');

  if (closeButton) {
    event.preventDefault();
    event.stopPropagation();
    closeEditorTab(closeButton.dataset.filename, closeButton.dataset.folderName || '');
    return;
  }

  if (!tab) return;
  selectFileByName(tab.dataset.filename, tab.dataset.folderName || '');
}

function filterExplorer(query) {
  const normalized = String(query || '').trim().toLowerCase();
  const fileList = document.querySelector('.studio-file-list, .file-list, #studioFileList');
  if (!fileList) return;

  const items = Array.from(fileList.querySelectorAll('.studio-file-item'));
  items.forEach((item) => item.classList.remove('is-hidden'));
  if (!normalized) return;
  items.forEach((item) => {
    const filename = item.dataset.filename?.toLowerCase() || '';
    const folderName = item.dataset.folderName?.toLowerCase() || '';
    item.classList.toggle('is-hidden', !filename.includes(normalized) && !folderName.includes(normalized));
  });
}

function getFolderEntries(entries = projectFiles, parentPath = '') {
  return entries.flatMap((entry) => {
    if (entry.type !== 'folder') return [];
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    return [{ entry, path }, ...getFolderEntries(entry.children || [], path)];
  });
}

function isDuplicateEntryName(name, parentPath = '', excludedEntryPath = '') {
  const safeName = String(name || '').trim();
  if (!safeName) return false;
  const entries = parentPath ? findFolderEntries(parentPath) : projectFiles;
  if (!entries) return false;
  return entries.some((entry) => {
    if (excludedEntryPath && (parentPath ? `${parentPath}/${entry.name}` : entry.name) === excludedEntryPath) return false;
    return entry.name.toLowerCase() === safeName.toLowerCase();
  });
}

function getUniqueEntryName(baseName, parentPath = '', excludedEntryPath = '') {
  const safeBaseName = String(baseName || '').trim();
  if (!safeBaseName) return '';
  const entries = parentPath ? findFolderEntries(parentPath) : projectFiles;
  if (!entries) return safeBaseName;

  const getNameParts = (name) => {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex <= 0 || name.endsWith('.')) {
      return { stem: name, extension: '' };
    }
    return { stem: name.slice(0, lastDotIndex), extension: name.slice(lastDotIndex) };
  };

  const isUsed = (candidate) => entries.some((entry) => {
    if (excludedEntryPath && (parentPath ? `${parentPath}/${entry.name}` : entry.name) === excludedEntryPath) return false;
    return entry.name.toLowerCase() === candidate.toLowerCase();
  });

  if (!isUsed(safeBaseName)) return safeBaseName;

  const { stem, extension } = getNameParts(safeBaseName);
  let counter = 2;
  let candidate = `${stem} (${counter})${extension}`;
  while (isUsed(candidate)) {
    counter += 1;
    candidate = `${stem} (${counter})${extension}`;
  }
  return candidate;
}

function cloneEntryTree(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'file') {
    return {
      ...entry,
      status: 'draft',
      content: entry.content || '',
      active: false
    };
  }

  if (entry.type === 'folder') {
    return {
      ...entry,
      open: false,
      active: false,
      children: Array.isArray(entry.children) ? entry.children.map((child) => cloneEntryTree(child)) : []
    };
  }

  return null;
}

function getEntryParentPath(entryPath = '') {
  const segments = String(entryPath || '').split('/').filter(Boolean);
  if (segments.length <= 1) return '';
  return segments.slice(0, -1).join('/');
}

function findEntryByPath(entryPath = '') {
  const trimmedPath = String(entryPath || '').trim();
  if (!trimmedPath) return null;

  const segments = trimmedPath.split('/').filter(Boolean);
  if (!segments.length) return null;

  let entries = projectFiles;
  let matchedEntry = null;

  for (const segment of segments) {
    const nextMatch = entries.find((entry) => entry.name === segment);
    if (!nextMatch) return null;
    matchedEntry = nextMatch;
    entries = nextMatch.type === 'folder' && Array.isArray(nextMatch.children) ? nextMatch.children : [];
  }

  return matchedEntry;
}

function cloneEntryForPaste(entry, destinationParentPath = '') {
  const sourceCopy = cloneEntryTree(entry);
  if (!sourceCopy) return null;

  const resolvedName = getUniqueEntryName(sourceCopy.name, destinationParentPath);
  const cloned = {
    ...sourceCopy,
    name: resolvedName,
    active: false
  };

  if (cloned.type === 'folder') {
    cloned.open = false;
    const nextParentPath = destinationParentPath ? `${destinationParentPath}/${resolvedName}` : resolvedName;
    cloned.children = Array.isArray(sourceCopy.children) ? sourceCopy.children.map((child) => cloneEntryForPaste(child, nextParentPath)) : [];
  }

  return cloned;
}

function pasteCopiedEntry(targetParentPath = '') {
  if (!studioClipboard || !studioClipboard.entry) {
    showToast('Nothing copied to paste.');
    return false;
  }

  const destinationEntries = targetParentPath ? findFolderEntries(targetParentPath) : projectFiles;
  if (!destinationEntries) {
    showToast('Target folder not found.');
    return false;
  }

  const pastedEntry = cloneEntryForPaste(studioClipboard.entry, targetParentPath);
  if (!pastedEntry) return false;

  destinationEntries.push(pastedEntry);
  renderFileExplorer();
  renderEditor();
  saveWorkspaceState();
  syncSharedWorkspace();
  showToast(`${pastedEntry.name} pasted`);
  return true;
}

function ensureClipboardFolderPath(folderPath) {
  const segments = String(folderPath || '').split('/').filter(Boolean);
  let currentPath = '';
  for (const segment of segments) {
    const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!findEntryByPath(nextPath)) addEntryToFolder(segment, 'folder', currentPath);
    currentPath = nextPath;
  }
  return currentPath;
}

function getClipboardTextFilename(content) {
  const text = String(content || '').trim();
  if (/<(?:!doctype\s+html|html|head|body)\b/i.test(text)) return 'pasted-page.html';
  if (/^[^{]*\{[\s\S]*\}/.test(text) && !/\b(function|const|let|var|import|export)\b/.test(text)) return 'pasted-styles.css';
  return 'pasted-code.js';
}

async function importExternalClipboardFiles(rawFiles, targetParentPath = '') {
  const files = Array.from(rawFiles || []);
  if (!files.length) return false;

  let imported = 0;
  for (const file of files) {
    const relativePath = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const pathParts = relativePath.split('/').filter(Boolean);
    const fileName = pathParts.pop();
    if (!fileName) continue;
    const folderPath = pathParts.length
      ? `${targetParentPath ? `${targetParentPath}/` : ''}${pathParts.join('/')}`
      : targetParentPath;
    if (pathParts.length) ensureClipboardFolderPath(folderPath);
    const content = await file.text();
    const parentEntries = folderPath ? findFolderEntries(folderPath) : projectFiles;
    if (!parentEntries) continue;
    const entry = {
      name: getUniqueEntryName(fileName, folderPath),
      type: 'file',
      status: 'draft',
      content
    };
    parentEntries.push(entry);
    imported += 1;
  }

  if (!imported) return false;
  renderFileExplorer();
  renderEditor();
  saveWorkspaceState();
  syncSharedWorkspace();
  refreshPreviewFromWorkspace();
  showToast(`${imported} file${imported === 1 ? '' : 's'} pasted`);
  return true;
}

async function pasteExternalClipboard(targetParentPath = '', fallbackText = '') {
  try {
    const clipboardItems = navigator.clipboard?.read ? await navigator.clipboard.read() : [];
    const files = [];
    for (const item of clipboardItems) {
      for (const type of item.types) {
        if (!type.startsWith('text/')) {
          const blob = await item.getType(type);
          files.push(new File([blob], `pasted-${files.length + 1}.${type.includes('html') ? 'html' : 'txt'}`, { type }));
          break;
        }
      }
    }
    if (await importExternalClipboardFiles(files, targetParentPath)) return true;

    const text = fallbackText || (navigator.clipboard?.readText ? await navigator.clipboard.readText() : '');
    if (!text.trim()) return false;
      const requestedName = getClipboardTextFilename(text);
    const parentEntries = targetParentPath ? findFolderEntries(targetParentPath) : projectFiles;
    if (!parentEntries) return false;
    parentEntries.push({ name: getUniqueEntryName(requestedName.trim(), targetParentPath), type: 'file', status: 'draft', content: text });
    renderFileExplorer();
    renderEditor();
    saveWorkspaceState();
    syncSharedWorkspace();
    refreshPreviewFromWorkspace();
    showToast('Pasted content as a new file');
    return true;
  } catch (error) {
    return false;
  }
}

async function pasteFromAvailableClipboard(targetParentPath = '') {
  if (await pasteExternalClipboard(targetParentPath)) return true;
  return pasteCopiedEntry(targetParentPath);
}

function addEntryToFolder(name, type, parentPath = '') {
  const safeName = String(name || '').trim();
  if (!safeName) {
    showToast('Name cannot be empty.');
    return null;
  }
  const resolvedName = getUniqueEntryName(safeName, parentPath);
  const newEntry = type === 'folder'
    ? { name: resolvedName, type: 'folder', open: true, children: [] }
    : { name: resolvedName, type: 'file', status: 'draft', content: '// New file\n' };
  if (!parentPath) {
    projectFiles.push(newEntry);
    return newEntry;
  }
  const segments = parentPath.split('/');
  let entries = projectFiles;
  for (const segment of segments) {
    const folder = entries.find((entry) => entry.type === 'folder' && entry.name === segment);
    if (!folder) return null;
    folder.children ||= [];
    entries = folder.children;
  }
  entries.push(newEntry);
  return newEntry;
}

function renameEntry(entryPath, nextName) {
  const safeNextName = String(nextName || '').trim();
  if (!safeNextName) {
    showToast('Name cannot be empty.');
    return false;
  }
  const segments = entryPath.split('/');
  const oldName = segments.pop();
  const parentPath = segments.join('/');
  const entries = parentPath ? findFolderEntries(parentPath) : projectFiles;
  const entry = entries?.find((item) => item.name === oldName);
  if (!entry) return false;
  const resolvedName = getUniqueEntryName(safeNextName, parentPath, entryPath);
  entry.name = resolvedName;
  const oldPrefix = entryPath;
  const nextPrefix = parentPath ? `${parentPath}/${resolvedName}` : resolvedName;
  openEditorTabFolders = openEditorTabFolders.map((folder) => {
    const normalizedFolder = folder || '';
    return normalizedFolder === oldPrefix ? nextPrefix : normalizedFolder.startsWith(`${oldPrefix}/`) ? `${nextPrefix}${normalizedFolder.slice(oldPrefix.length)}` : normalizedFolder;
  });
  openEditorTabNames = openEditorTabNames.map((name, index) => name === oldName && (openEditorTabFolders[index] || '') === parentPath ? nextName : name);
  if (activeEditorFileName === oldName && activeEditorFolderName === parentPath) {
    activeEditorFileName = nextName;
  }
  if (activeEditorFolderName === oldPrefix || activeEditorFolderName.startsWith(`${oldPrefix}/`)) activeEditorFolderName = `${nextPrefix}${activeEditorFolderName.slice(oldPrefix.length)}`;
  return true;
}

function findFolderEntries(folderPath) {
  const segments = folderPath.split('/').filter(Boolean);
  let entries = projectFiles;
  for (const segment of segments) {
    const folder = entries.find((entry) => entry.type === 'folder' && entry.name === segment);
    if (!folder) return null;
    entries = folder.children || [];
  }
  return entries;
}

function deleteEntry(entryPath) {
  const segments = entryPath.split('/');
  const name = segments.pop();
  const parentPath = segments.join('/');
  const entries = parentPath ? findFolderEntries(parentPath) : projectFiles;
  if (!entries) return false;
  const index = entries.findIndex((entry) => entry.name === name);
  if (index === -1) return false;
  entries.splice(index, 1);
  const removedPrefix = `${entryPath}/`;
  const keptTabs = openEditorTabNames.reduce((result, tabName, tabIndex) => {
    const tabFolder = openEditorTabFolders[tabIndex] || '';
    const tabPath = tabFolder ? `${tabFolder}/${tabName}` : tabName;
    if (tabPath === entryPath || tabPath.startsWith(removedPrefix)) return result;
    result.push({ name: tabName, folder: tabFolder });
    return result;
  }, []);
  openEditorTabNames = keptTabs.map((tab) => tab.name);
  openEditorTabFolders = keptTabs.map((tab) => tab.folder);
  if (activeEditorFileName && (activeEditorFolderName ? `${activeEditorFolderName}/${activeEditorFileName}` : activeEditorFileName) === entryPath) {
    activeEditorFileName = openEditorTabNames[0] || null;
    activeEditorFolderName = openEditorTabFolders[0] || '';
  }
  return true;
}

function updateExplorerState(clickedFile) {
  projectFiles = projectFiles.map((file) => {
    if (file.type === 'folder' && file.name === clickedFile.name) {
      return { ...file, open: !file.open };
    }
    return {
      ...file,
      active: file.name === clickedFile.name && file.type === 'file'
    };
  });

  projectFiles = projectFiles.map((file) => {
    if (file.type === 'folder' && Array.isArray(file.children)) {
      const children = file.children.map((child) => ({
        ...child,
        active: child.name === clickedFile.name && child.type === 'file'
      }));
      return { ...file, children };
    }
    return file;
  });
}

function handleFileExplorerClick(event) {
  const item = event.target.closest('.studio-file-item');
  if (!item) return;
  const filename = item.dataset.filename;
  const folderName = item.dataset.folderName;
  const entryPath = item.dataset.entryPath || (folderName ? `${folderName}/${filename}` : filename || '');
  selectedExplorerEntryPath = entryPath;

  if (item.classList.contains('folder')) {
    projectFiles = projectFiles.map((file) => file.name === filename && file.type === 'folder' ? { ...file, open: !file.open } : file);
    renderFileExplorer();
    saveWorkspaceState();
    return;
  }

  selectFileByName(filename, folderName);
}

function selectFileByName(filename, folderName) {
  const targetFile = findFileEntry(filename, folderName);
  if (!targetFile) return;

  selectedExplorerEntryPath = folderName ? `${folderName}/${filename}` : filename;
  markFileAsActive(filename, folderName);
  const tabKey = `${folderName || ''}:${filename}`;
  const existingTabKeys = openEditorTabNames.map((name, index) => `${openEditorTabFolders[index] || ''}:${name}`);
  if (!existingTabKeys.includes(tabKey)) {
    openEditorTabNames.push(filename);
    openEditorTabFolders.push(folderName || '');
  }

  renderFileExplorer();
  renderEditor();
  saveWorkspaceState();
  requestAnimationFrame(() => {
    const resolvedPath = folderName ? `${folderName}/${filename}` : filename;
    scrollExplorerToEntry(resolvedPath);
  });
}

function buildZipAndDownload() {
  const zip = new JSZip();

  projectFiles.forEach((entry) => {
    if (entry.type === 'file') {
      zip.file(entry.name, entry.content || '');
    } else if (entry.type === 'folder' && Array.isArray(entry.children)) {
      const folder = zip.folder(entry.name);
      entry.children.forEach((child) => {
        if (child.type === 'file') {
          folder.file(child.name, child.content || '');
        }
      });
    }
  });

  return zip.generateAsync({ type: 'blob' }).then((content) => URL.createObjectURL(content));
}

function setupFileExplorerInteractions() {
  const fileTree = document.querySelector('.studio-file-tree');
  if (!fileTree) return;
}

function setupCodeEditorInteractions() {
  const editorTabs = document.querySelector('.studio-editor-tabs');
  if (!editorTabs || editorTabs.dataset.bound === 'true') return;
  editorTabs.addEventListener('click', handleEditorTabClick);
  editorTabs.dataset.bound = 'true';
}

function getApiBaseUrl() {
  return API_BASE_CANDIDATES[0] || 'http://localhost:8000';
}

async function ensureServerStudioProject(projectName = 'KielTech Studio project') {
  const storageKey = 'kieltech-server-studio-project-id';
  let existingId = localStorage.getItem(storageKey);
  if (existingId && state.token) {
    const existingResponse = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(existingId)}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (existingResponse.ok) return existingId;
    if (existingResponse.status !== 404) throw new Error('The current Studio project could not be verified on the backend.');
    localStorage.removeItem(storageKey);
    existingId = '';
  }
  if (existingId) return existingId;
  if (state.token) {
    const listResponse = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!listResponse.ok) throw new Error('The studio projects could not be restored from the backend.');
    const listPayload = await listResponse.json();
    const recentProjectId = listPayload.projects?.[0]?.project_id;
    if (recentProjectId) {
      localStorage.setItem(storageKey, recentProjectId);
      return recentProjectId;
    }
  }
  const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    },
    body: JSON.stringify({ project_name: projectName })
  });
  if (!response.ok) throw new Error('The studio project could not be created on the backend.');
  const payload = await response.json();
  if (!payload.project_id) throw new Error('The backend returned an invalid studio project.');
  localStorage.setItem(storageKey, payload.project_id);
  return payload.project_id;
}

async function applyServerStudioFileAction(action, path, content = '') {
  const projectId = await ensureServerStudioProject();
  const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}/files/actions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    },
    body: JSON.stringify({ action, path, content })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || 'The backend rejected the workspace file action.');
  return payload;
}

async function applyServerStudioFileBatch(actions = []) {
  const projectId = await ensureServerStudioProject();
  const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}/files/actions/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    },
    body: JSON.stringify({ actions: actions.map((action) => ({ action: action.action, path: action.path, content: action.nextContent })) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || 'The backend rejected the workspace file batch.');
  return payload;
}

async function loadServerStudioProjectState() {
  const storageKey = 'kieltech-server-studio-project-id';
  const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
  let projectId = requestedProjectId || localStorage.getItem(storageKey);
  if (!state.token) return null;
  if (!projectId) {
    const listResponse = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!listResponse.ok) throw new Error('The studio projects could not be restored from the backend.');
    const listPayload = await listResponse.json();
    projectId = listPayload.projects?.[0]?.project_id;
    if (!projectId) return null;
    localStorage.setItem(storageKey, projectId);
  }
  let response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${state.token}` }
  });
  if (response.status === 404) {
    if (requestedProjectId) return null;
    localStorage.removeItem(storageKey);
    const listResponse = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!listResponse.ok) throw new Error('The studio projects could not be restored from the backend.');
    const listPayload = await listResponse.json();
    projectId = listPayload.projects?.[0]?.project_id;
    if (!projectId) return null;
    localStorage.setItem(storageKey, projectId);
    response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
  }
  if (!response.ok) throw new Error('The studio project could not be restored from the backend.');
  const project = await response.json();
  localStorage.setItem(storageKey, project.project_id);
  if (requestedProjectId && project.project_id === requestedProjectId) {
    const url = new URL(window.location.href);
    url.searchParams.delete('project_id');
    window.history.replaceState({}, '', url);
  }
  return project;
}

function initStudioProjectDirectory() {
  const root = document.getElementById('studioProjectDirectory');
  const list = document.getElementById('studioProjectDirectoryList');
  const status = document.getElementById('studioProjectDirectoryStatus');
  const search = document.getElementById('studioProjectDirectorySearch');
  if (!root || !list || !status) return;

  const createDialog = document.getElementById('studioDirectoryCreateDialog');
  const createForm = document.getElementById('studioDirectoryCreateForm');
  const createName = document.getElementById('studioDirectoryProjectName');
  const createStatus = document.getElementById('studioDirectoryCreateStatus');
  const createSignIn = document.getElementById('studioDirectorySignIn');
  const closeCreateDialog = () => {
    if (createDialog) createDialog.hidden = true;
  };
  const openCreateDialog = () => {
    if (!createDialog || !createForm) return;
    createForm.reset();
    if (createStatus) createStatus.textContent = state.token ? '' : 'Sign in to create and save a project.';
    if (createSignIn) createSignIn.hidden = Boolean(state.token);
    createDialog.hidden = false;
    createName?.focus();
  };
  document.getElementById('studioProjectDirectoryNewButton')?.addEventListener('click', openCreateDialog);
  list.addEventListener('click', (event) => {
    if (event.target.closest('[data-studio-directory-create]')) openCreateDialog();
  });
  createDialog?.querySelectorAll('[data-directory-dialog-close]').forEach((button) => {
    button.addEventListener('click', closeCreateDialog);
  });
  createDialog?.addEventListener('click', (event) => {
    if (event.target === createDialog) closeCreateDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && createDialog && !createDialog.hidden) closeCreateDialog();
  });
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.token) {
      if (createStatus) createStatus.textContent = 'Sign in to create and save a project.';
      if (createSignIn) createSignIn.hidden = false;
      return;
    }
    const projectName = createName?.value.trim() || '';
    if (!projectName) {
      if (createStatus) createStatus.textContent = 'Enter a name for your project.';
      createName?.focus();
      return;
    }
    const submitButton = createForm.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    if (createStatus) createStatus.textContent = 'Creating your project…';
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ project_name: projectName })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || `Could not create project (HTTP ${response.status}).`);
      if (!payload.project_id) throw new Error('The project was created, but no project ID was returned.');
      window.location.assign(`web-development-studio.html?project_id=${encodeURIComponent(payload.project_id)}`);
    } catch (error) {
      if (createStatus) createStatus.textContent = error.message || 'Unable to create the project.';
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  let projects = [];
  const renderProjects = () => {
    const query = (search?.value || '').trim().toLocaleLowerCase();
    const visibleProjects = projects.filter((project) => (project.project_name || 'Untitled project').toLocaleLowerCase().includes(query));
    if (!visibleProjects.length) {
      list.innerHTML = `<div class="studio-library-empty"><span class="material-symbols-outlined" aria-hidden="true">${query ? 'search_off' : 'web'}</span><h2>${query ? 'No matching projects' : 'No projects yet'}</h2><p>${query ? 'Try another search term.' : 'Create your first website project and it will appear here.'}</p>${query ? '' : '<button class="studio-library-button" type="button" data-studio-directory-create>Create your first project</button>'}</div>`;
      return;
    }
    list.innerHTML = visibleProjects.map((project) => {
      const name = project.project_name || 'Untitled project';
      const updated = project.updated_at ? new Date(project.updated_at) : null;
      const updatedLabel = updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Recently updated';
      const href = `web-development-studio.html?project_id=${encodeURIComponent(project.project_id)}`;
      return `<article class="studio-library-card">
        <a class="studio-library-card__open" href="${href}" aria-label="Open ${escapeHtml(name)} in Website Studio">
          <span class="studio-library-card__preview"><span class="material-symbols-outlined" aria-hidden="true">web</span><span class="studio-library-card__preview-label">WEBSITE PROJECT</span></span>
          <span class="studio-library-card__details"><strong>${escapeHtml(name)}</strong><span>${Number(project.file_count || 0)} files <span aria-hidden="true">·</span> Updated ${escapeHtml(updatedLabel)}</span></span>
          <span class="studio-library-card__arrow material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </a>
      </article>`;
    }).join('');
  };

  const loadProjects = async () => {
    if (!state.token) {
      status.innerHTML = 'Sign in to see projects saved to your account. <a href="login.html?return_to=studio-projects.html">Sign in</a>';
      list.innerHTML = '';
      return;
    }
    status.textContent = 'Loading your projects…';
    list.innerHTML = '';
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects`, {
        headers: { Authorization: `Bearer ${state.token}` },
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || `Could not load projects (HTTP ${response.status}).`);
      projects = Array.isArray(payload.projects) ? payload.projects : [];
      status.textContent = projects.length === 1 ? '1 saved website project' : `${projects.length} saved website projects`;
      renderProjects();
    } catch (error) {
      status.textContent = error.message || 'Your projects could not be loaded.';
      status.classList.add('is-error');
      list.innerHTML = '<button class="studio-library-button studio-library-button--secondary" id="studioProjectDirectoryRetry" type="button">Try again</button>';
      document.getElementById('studioProjectDirectoryRetry')?.addEventListener('click', () => {
        status.classList.remove('is-error');
        loadProjects();
      }, { once: true });
    }
  };

  search?.addEventListener('input', renderProjects);
  loadProjects();
}

function normalizeStudioToolPath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/');
  if (!path) return '';
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

function ensureStudioFolderPathExists(folderPath = '') {
  const normalized = normalizeStudioToolPath(folderPath);
  if (!normalized) return true;
  const segments = normalized.split('/').filter(Boolean);
  let currentPath = '';
  for (const segment of segments) {
    const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!findEntryByPath(nextPath)) {
      addEntryToFolder(segment, 'folder', currentPath);
    }
    currentPath = nextPath;
  }
  return true;
}

function writeStudioProjectFileByPath(filePath, content, status = 'edited') {
  const normalizedPath = normalizeStudioToolPath(filePath);
  if (!normalizedPath) return null;

  const segments = normalizedPath.split('/');
  const fileName = segments.pop();
  if (!fileName) return null;

  const parentPath = segments.join('/');
  ensureStudioFolderPathExists(parentPath);
  const targetEntries = parentPath ? findFolderEntries(parentPath) : projectFiles;
  if (!targetEntries) return null;

  const existingFile = targetEntries.find((entry) => entry.type === 'file' && entry.name === fileName);
  if (existingFile) {
    existingFile.content = String(content ?? '');
    existingFile.status = status;
  } else {
    targetEntries.push({ name: fileName, type: 'file', status, content: String(content ?? '') });
  }

  renderFileExplorer();
  renderEditor();
  saveWorkspaceState();
  refreshPreviewFromWorkspace();
  return fileName;
}

function ensureFolderPathExists(folderPath = '') {
  return ensureStudioFolderPathExists(folderPath);
}

function writeProjectFileByPath(filePath, content, status = 'edited') {
  return writeStudioProjectFileByPath(filePath, content, status);
}

function inferStudioToolCallFromPrompt(promptText = '') {
  const normalized = String(promptText || '').trim();
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  const makePathFromPrompt = (fallbackExt = 'txt') => {
    const pathMatch = normalized.match(/(?:create|make|add|write|update|edit|rename|delete|remove)\s+(?:a\s+)?(?:file|document|page|component|module|script|style|html|css|js|json|txt|md)?\s*(?:named|called|with\s+name|at|to)\s*["'`]?([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)["'`]?/i)
      || normalized.match(/(?:for|in)\s+(?:the\s+)?(?:file|path|location)\s*["'`]?([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)["'`]?/i)
      || normalized.match(/([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)/i);
    return pathMatch ? normalizeStudioToolPath(pathMatch[1]) : `generated-file.${fallbackExt}`;
  };

  if (/\b(delete|remove)\b/.test(lowered)) {
    return { tool: 'delete_file', path: makePathFromPrompt('txt'), summary: 'Delete the target file from the workspace.' };
  }

  if (/\b(edit|update|modify|change|fix|refactor|improve)\b/.test(lowered)) {
    return { tool: 'update_file', path: makePathFromPrompt('js'), summary: 'Update the selected file with the requested revision.', content: normalized };
  }

  if (/\b(create|make|add|write|new file|generate)\b/.test(lowered)) {
    return {
      tool: 'create_file',
      path: makePathFromPrompt('txt'),
      summary: 'Create the requested file in the project workspace.',
      content: normalized.includes('text') || normalized.includes('content')
        ? normalized.replace(/.*?(?:text|content)\s*(?:is|=|:)?\s*["'`]?/i, '').replace(/["'`]/g, '').trim() || 'New file created by the studio agent.'
        : 'New file created by the studio agent.'
    };
  }

  if (/\b(read|open|show|inspect|view)\b/.test(lowered)) {
    return { tool: 'read_file', path: makePathFromPrompt('txt'), summary: 'Open the requested file for review.' };
  }

  if (/\b(list|show\s+all|files|workspace)\b/.test(lowered)) {
    return { tool: 'list_files', summary: 'List the available workspace files.' };
  }

  return null;
}

function execStudioToolCallFromPrompt(toolCall, promptText = '') {
  if (!toolCall || typeof toolCall !== 'object') return false;

  const normalizedTool = {
    read: 'read_file',
    open: 'read_file',
    list: 'list_files',
    search: 'list_files',
    create: 'create_file',
    write: 'create_file',
    edit: 'update_file',
    update: 'update_file',
    delete: 'delete_file',
    remove: 'delete_file',
    run: 'run_build',
    build: 'run_build',
    preview: 'run_build'
  }[(String(toolCall.tool || toolCall.action || '').trim().toLowerCase())] || (String(toolCall.tool || toolCall.action || '').trim().toLowerCase());

  const path = normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '');
  const content = typeof toolCall.content === 'string' ? toolCall.content : toolCall.code || toolCall.text || '';

  if (normalizedTool === 'read_file') {
    if (!path) return false;
    const entry = findEntryByPath(path) || findFileEntry(path.split('/').pop(), path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    if (entry) {
      selectFileByName(entry.name, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      return true;
    }
    return false;
  }

  if (normalizedTool === 'list_files') {
    return true;
  }

  if (normalizedTool === 'create_file') {
    if (!path) return false;
    writeStudioProjectFileByPath(path, content || '// New file\n', 'draft');
    return true;
  }

  if (normalizedTool === 'update_file') {
    if (!path) return false;
    const fileName = path.split('/').pop();
    const folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const existing = findFileEntry(fileName, folderPath);
    if (!existing) return false;
    existing.content = String(content || existing.content || '');
    existing.status = 'edited';
    renderFileExplorer();
    renderEditor();
    saveWorkspaceState();
    refreshPreviewFromWorkspace();
    return true;
  }

  if (normalizedTool === 'delete_file') {
    if (!path) return false;
    const deleted = deleteEntry(path);
    if (deleted) {
      renderFileExplorer();
      renderEditor();
      saveWorkspaceState();
      refreshPreviewFromWorkspace();
      return true;
    }
    return false;
  }

  if (normalizedTool === 'run_build') {
    return true;
  }

  return false;
}

window.KieltechStudioToolRouter = {
  normalizeStudioToolPath,
  inferStudioToolCallFromPrompt,
  execStudioToolCallFromPrompt
};

function formatApiError(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if (item.msg) {
            const loc = Array.isArray(item.loc) ? item.loc.join(' > ') : item.loc;
            return loc ? `${loc}: ${item.msg}` : item.msg;
          }
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join(' / ');
  }
  if (detail && typeof detail === 'object') {
    if (detail.msg) return detail.msg;
    return JSON.stringify(detail);
  }
  return String(detail);
}

function showAccountBlockedModal(reason) {
  const modalId = 'accountBlockedModal';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.innerHTML = `
      <div class="account-blocked-modal__backdrop" data-account-blocked-close></div>
      <section class="account-blocked-modal__dialog" role="alertdialog" aria-modal="true" aria-labelledby="accountBlockedTitle">
        <div class="account-blocked-modal__icon">!</div>
        <div>
          <p class="account-blocked-modal__eyebrow">Access restricted</p>
          <h2 id="accountBlockedTitle">Account blocked</h2>
          <p class="account-blocked-modal__message"></p>
        </div>
        <button type="button" class="account-blocked-modal__close" data-account-blocked-close aria-label="Close">Close</button>
      </section>`;
    const style = document.createElement('style');
    style.textContent = `
      #accountBlockedModal { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 1rem; }
      .account-blocked-modal__backdrop { position: absolute; inset: 0; background: rgba(2, 6, 23, .78); backdrop-filter: blur(5px); }
      .account-blocked-modal__dialog { position: relative; display: grid; grid-template-columns: auto 1fr; gap: .75rem 1rem; width: min(460px, 100%); padding: 1.35rem; border: 1px solid rgba(248, 113, 113, .42); border-radius: 16px; background: #0c1420; box-shadow: 0 24px 70px rgba(0, 0, 0, .45); color: #e5edf7; }
      .account-blocked-modal__icon { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: rgba(220, 38, 38, .2); color: #fca5a5; font-weight: 800; }
      .account-blocked-modal__eyebrow { margin: 0 0 .2rem; color: #fca5a5; font-size: .72rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
      .account-blocked-modal__dialog h2 { margin: 0; color: #f8fafc; font-size: 1.15rem; }
      .account-blocked-modal__message { grid-column: 2; margin: 0; max-height: 12rem; overflow: auto; color: #cbd5e1; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; word-break: break-word; }
      .account-blocked-modal__close { grid-column: 2; justify-self: start; margin-top: .25rem; border: 1px solid rgba(248, 113, 113, .35); border-radius: 9px; background: rgba(220, 38, 38, .14); color: #fecaca; cursor: pointer; padding: .55rem .8rem; }
      .account-blocked-modal__close:hover { background: rgba(220, 38, 38, .28); }
      @media (max-width: 420px) { .account-blocked-modal__dialog { grid-template-columns: 1fr; } .account-blocked-modal__message, .account-blocked-modal__close { grid-column: 1; } }
    `;
    document.head.appendChild(style);
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-account-blocked-close]').forEach((element) => {
      element.addEventListener('click', () => modal.remove());
    });
  }
  const message = modal.querySelector('.account-blocked-modal__message');
  if (message) message.textContent = reason || 'Your account has been blocked.';
  modal.querySelector('.account-blocked-modal__close')?.focus();
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // Only set Content-Type when there is a request body and it's not FormData
  if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let lastError = null;
  let sawNetworkError = false;

  // Defensive: ensure billing init calls always send NGN currency
  try {
    if (options && options.body && typeof options.body === 'string' && (path && path.includes('/v1/billing/initialize-topup') || path && path.includes('/v1/billing/initialize'))) {
      const parsed = JSON.parse(options.body);
      parsed.currency = 'NGN';
      options.body = JSON.stringify(parsed);
    }
  } catch (e) {
    // ignore parse errors
  }
  // For API paths, always target the explicit backend host to avoid hitting the
  // static file server (which serves the frontend). This ensures requests like
  // `/v1/billing/...` go to the uvicorn backend on port 8000.
  const isApiPath = typeof path === 'string' && path.startsWith('/v1');
  const candidates = isApiPath ? [getApiBaseUrl()] : API_BASE_CANDIDATES;

  for (const base of candidates) {
    const url = isApiPath && base === getApiBaseUrl() ? `${base}${path}` : `${base}${path}`;
    try {
      const response = await fetch(url, {
        ...options,
        headers,
        // allow credentials when same-origin is used
        credentials: 'include',
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        return data;
      }
      if (data.error === 'account_blocked') {
        const reason = data.reason || data.detail || 'Account access is suspended.';
        showAccountBlockedModal(reason);
        lastError = new Error(reason);
        lastError.status = response.status;
        lastError.code = 'account_blocked';
        lastError.reason = reason;
        break;
      }
      const detail = data.detail || data.error;
      const detailText = formatApiError(detail);
      lastError = new Error(detailText || `Request failed with status ${response.status}`);
      lastError.status = response.status;
      lastError.code = data.error || '';
      lastError.email = data.email || '';
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      sawNetworkError = true;
      lastError = new Error(`Unable to reach the server at ${url}. ${error?.message || String(error)}`);
    }
  }

  if (isLocal && sawNetworkError && !lastError.message.includes('Request failed with status')) {
    throw new Error('The servers are facing some issues right now. Please try again.');
  }

  throw lastError || new Error('Unable to reach the server');
}

function setFormMessage(element, message, type = 'info') {
  if (!element) return;
  element.textContent = typeof message === 'string' ? message : message ? JSON.stringify(message) : '';
  element.className = `form-status ${type === 'success' ? 'is-success' : type === 'error' ? 'is-error' : type === 'loading' ? 'is-loading' : ''}`.trim();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast toast--visible';
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.className = 'toast';
  }, 3200);
}

function initMainSiteAuthNavigation() {
  const getAuthLinks = () => ({
    loginLinks: Array.from(document.querySelectorAll('header a[href^="login.html"]')),
    signupLinks: Array.from(document.querySelectorAll('header a[href^="signup.html"], .home-page a[href^="signup.html"]')),
    dashboardLinks: Array.from(document.querySelectorAll('header a[href="dashboard.html"]')),
    adminLinks: Array.from(document.querySelectorAll('#homeAdminLink'))
  });

  const applyAnonymousState = () => {
    const { loginLinks, signupLinks, dashboardLinks, adminLinks } = getAuthLinks();
    loginLinks.forEach((link) => { link.hidden = false; link.textContent = 'Login'; });
    signupLinks.forEach((link) => { link.hidden = false; });
    dashboardLinks.forEach((link) => { link.hidden = true; });
    adminLinks.forEach((link) => { link.hidden = true; });
    const drawerLogout = document.getElementById('serviceDrawerLogout');
    if (drawerLogout) drawerLogout.hidden = true;
  };

  const applyAuthenticatedState = (user = {}) => {
    const { loginLinks, signupLinks, dashboardLinks, adminLinks } = getAuthLinks();
    loginLinks.forEach((link) => { link.hidden = true; });
    signupLinks.forEach((link) => { link.hidden = true; });
    adminLinks.forEach((link) => {
      link.hidden = user.is_admin !== true;
      const isOwner = user.is_owner === true || user.role === 'owner';
      link.textContent = isOwner ? 'Owner' : 'Admin';
      const adminApiBase = window.KIELTECH_API_BASE_URL
        || (isLocal
          ? `http://${window.location.hostname || 'localhost'}:8000`
          : 'https://kieltech-backend.onrender.com');
      link.href = `${adminApiBase.replace(/\/+$/, '')}${isOwner ? '/owner/admins' : '/admin/dashboard'}`;
    });
    dashboardLinks.forEach((link) => {
      link.hidden = false;
      const icon = link.querySelector('.service-drawer__link-icon');
      if (icon) {
        const label = document.createElement('span');
        label.textContent = 'Dashboard';
        link.replaceChildren(icon, label);
      } else {
        link.textContent = 'Dashboard';
      }
    });
    const drawerLogout = document.getElementById('serviceDrawerLogout');
    if (drawerLogout) drawerLogout.hidden = false;
  };

  const initialLinks = getAuthLinks();
  if (!initialLinks.loginLinks.length && !initialLinks.signupLinks.length && !initialLinks.dashboardLinks.length) return;
  const token = state.token;
  if (!token) {
    applyAnonymousState();
    return;
  }
  request('/v1/auth/me')
    .then((profile) => {
      if (profile?.admin_role_status === 'unavailable') {
        console.error('Administrator role verification is currently unavailable.');
      }
      applyAuthenticatedState(profile?.user || {});
    })
    .catch((error) => {
      if (error?.status === 401) {
        localStorage.removeItem('kieltechToken');
        state.token = '';
        applyAnonymousState();
        return;
      }
      applyAuthenticatedState();
    });
}

function maskToken(token) {
  if (!token) return '';
  return token.replace(/(.{3}).*(.{4})/, '$1••••••••$2');
}

function ensureServicesDrawerUI() {
  const navActions = document.querySelector('.nav-actions');
  const existingToggle = document.getElementById('serviceDrawerToggle');
  const existingDrawer = document.getElementById('serviceDrawer');

  if (!existingToggle && !existingDrawer) {
    return null;
  }

  let toggle = existingToggle;
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'serviceDrawerToggle';
    toggle.className = 'service-drawer-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '☰ Services';

    if (navActions) {
      const themeToggle = navActions.querySelector('#themeToggle');
      if (themeToggle) {
        navActions.insertBefore(toggle, themeToggle);
      } else {
        navActions.appendChild(toggle);
      }
    } else {
      document.body.insertBefore(toggle, document.body.firstChild);
    }
  }

  const brandColumn = document.querySelector('.brand-block') || document.querySelector('.brand-row');
  if (brandColumn && toggle.parentElement !== brandColumn) {
    brandColumn.appendChild(toggle);
  }

  let drawer = existingDrawer;
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'serviceDrawer';
    drawer.className = 'service-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="service-drawer__backdrop" data-close-drawer></div>
      <aside class="service-drawer__panel" role="navigation" aria-label="Services menu">
        <div class="service-drawer__header">
          <div class="service-drawer__identity">
            <div class="service-drawer__brand">
              <img class="service-drawer__brand-mark" src="/KielTech-logo.png" alt="">
              <span class="service-drawer__brand-text">KielTech</span>
            </div>
            <span class="service-drawer__subtitle">Developer workspace</span>
          </div>
          <button id="serviceDrawerClose" class="service-drawer__close" type="button" aria-label="Close services menu">×</button>
        </div>
        <nav class="service-drawer__nav">
          <a class="service-drawer__link" href="/tokens.html"><span class="service-drawer__link-icon service-drawer__link-icon--token" aria-hidden="true">🔑</span><span>API Token</span></a>
          <a class="service-drawer__link" href="/api-integration.html"><span class="service-drawer__link-icon service-drawer__link-icon--ai" aria-hidden="true">✦</span><span>API Integration</span></a>
          <a class="service-drawer__link" href="/studio-projects.html"><span class="service-drawer__link-icon service-drawer__link-icon--studio" aria-hidden="true">🛠️</span><span>KielTech AI studio</span></a>
          <a class="service-drawer__link" href="/billing.html"><span class="service-drawer__link-icon service-drawer__link-icon--billing" aria-hidden="true">$</span><span>Billing</span></a>
          <a class="service-drawer__link" href="/settings.html"><span class="service-drawer__link-icon service-drawer__link-icon--settings" aria-hidden="true">⚙️</span><span>Settings</span></a>
        </nav>
        <div class="service-drawer__footer">
          <div class="service-drawer__account-label"><span class="service-drawer__account-dot" aria-hidden="true"></span><span>Account session</span></div>
          <button id="serviceDrawerLogout" class="service-drawer__logout" type="button" hidden><span class="service-drawer__logout-icon" aria-hidden="true">↪</span><span>Sign out</span></button>
        </div>
      </aside>
    `;
    document.body.appendChild(drawer);
  }

  const drawerNav = drawer.querySelector('.service-drawer__nav');
  drawer.querySelectorAll('.service-drawer__link').forEach((link) => {
    const href = link.getAttribute('href') || '';
    const label = link.textContent.trim().toLocaleLowerCase();
    if (href === '/human-language.html' || href === 'human-language.html' || label === 'human language') {
      link.remove();
    }
  });
  const drawerHeader = drawer.querySelector('.service-drawer__header');
  const existingBrand = drawer.querySelector('.service-drawer__brand');
  if (drawerHeader && existingBrand && !drawerHeader.querySelector('.service-drawer__subtitle')) {
    const identity = document.createElement('div');
    identity.className = 'service-drawer__identity';
    existingBrand.replaceWith(identity);
    identity.appendChild(existingBrand);
    const subtitle = document.createElement('span');
    subtitle.className = 'service-drawer__subtitle';
    subtitle.textContent = 'Developer workspace';
    identity.appendChild(subtitle);
  }
  drawer.querySelectorAll('.service-drawer__link, .service-drawer__home').forEach((link) => {
    if (link.querySelector('.service-drawer__link-icon')) return;
    const icon = document.createElement('span');
    icon.className = 'service-drawer__link-icon';
    icon.setAttribute('aria-hidden', 'true');
    const href = link.getAttribute('href') || '';
    icon.textContent = href.includes('token') ? '🔑'
      : href.includes('ai-api') ? '✦'
        : href.includes('human') ? '</>'
          : href.includes('web-development') ? '🛠️'
            : href.includes('model-status') ? '📊'
            : href.includes('billing') ? '$'
              : href.includes('settings') ? '⚙️' : '⌂';
    link.insertBefore(icon, link.firstChild);
  });
  if (drawerNav && !drawer.querySelector('.service-drawer__home')) {
    const homeLink = document.createElement('a');
    homeLink.className = 'service-drawer__home';
    homeLink.href = '/index.html';
    homeLink.innerHTML = '<span class="service-drawer__link-icon" aria-hidden="true">🏠</span><span>Home</span>';
    drawer.querySelector('.service-drawer__panel').insertBefore(homeLink, drawerNav);
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="dashboard"]')) {
    const dashboardLink = document.createElement('a');
    dashboardLink.className = 'service-drawer__link';
    dashboardLink.dataset.nav = 'dashboard';
    dashboardLink.href = 'dashboard.html';
    dashboardLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--dashboard" aria-hidden="true">▥</span><span>Dashboard</span>';

    const tokenLink = drawerNav.querySelector('a[href="/tokens.html"]');
    if (tokenLink) {
      drawerNav.insertBefore(dashboardLink, tokenLink);
    } else {
      drawerNav.insertBefore(dashboardLink, drawerNav.firstChild);
    }
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="models"]')) {
    const modelsLink = document.createElement('a');
    modelsLink.className = 'service-drawer__link';
    modelsLink.dataset.nav = 'models';
    modelsLink.href = 'models.html';
    modelsLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--model" aria-hidden="true">🤖</span><span>Model</span>';
    const tokenLink = drawerNav.querySelector('a[href="/tokens.html"], a[href="tokens.html"]');
    if (tokenLink) drawerNav.insertBefore(modelsLink, tokenLink);
    else drawerNav.appendChild(modelsLink);
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="kiel-chat"]')) {
    const chatLink = document.createElement('a');
    chatLink.className = 'service-drawer__link';
    chatLink.dataset.nav = 'kiel-chat';
    chatLink.href = 'chat.html';
    chatLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--chat" aria-hidden="true">◌</span><span>Kiel Chat</span>';
    const dashboardLink = drawerNav.querySelector('a[data-nav="dashboard"]');
    if (dashboardLink) drawerNav.insertBefore(chatLink, dashboardLink.nextSibling);
    else drawerNav.insertBefore(chatLink, drawerNav.firstChild);
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="model-status"]')) {
    const statusLink = document.createElement('a');
    statusLink.className = 'service-drawer__link';
    statusLink.dataset.nav = 'model-status';
    statusLink.href = 'model-status.html';
    statusLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--status" aria-hidden="true">📊</span><span>Model status</span>';
    const modelsLink = drawerNav.querySelector('a[data-nav="models"]');
    if (modelsLink) drawerNav.insertBefore(statusLink, modelsLink.nextSibling);
    else drawerNav.appendChild(statusLink);
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="referral"]')) {
    const referralLink = document.createElement('a');
    referralLink.className = 'service-drawer__link';
    referralLink.dataset.nav = 'referral';
    referralLink.href = 'referral.html';
    referralLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--referral" aria-hidden="true">🎁</span><span>Referral</span>';
    const statusLink = drawerNav.querySelector('a[data-nav="model-status"]');
    if (statusLink) drawerNav.insertBefore(referralLink, statusLink.nextSibling);
    else drawerNav.appendChild(referralLink);
  }

  if (drawerNav && !drawer.querySelector('.service-drawer__link[data-nav="model-review"]')) {
    const reviewLink = document.createElement('a');
    reviewLink.className = 'service-drawer__link';
    reviewLink.dataset.nav = 'model-review';
    reviewLink.href = 'model-review.html';
    reviewLink.innerHTML = '<span class="service-drawer__link-icon service-drawer__link-icon--review" aria-hidden="true"></span><span>Model review</span>';
    const statusLink = drawerNav.querySelector('a[data-nav="model-status"]');
    if (statusLink) drawerNav.insertBefore(reviewLink, statusLink.nextSibling);
    else drawerNav.appendChild(reviewLink);
  }

  const normalizeDrawerIcon = (selector, iconText, iconClass) => {
    const link = drawer.querySelector(selector);
    if (!link) return;
    let icon = link.querySelector('.service-drawer__link-icon');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'service-drawer__link-icon';
      icon.setAttribute('aria-hidden', 'true');
      link.insertBefore(icon, link.firstChild);
    }
    icon.classList.add(iconClass);
    icon.textContent = iconText;
  };

  normalizeDrawerIcon('a[data-nav="dashboard"], a[href="dashboard.html"], a[href="/dashboard.html"]', '▥', 'service-drawer__link-icon--dashboard');
  normalizeDrawerIcon('a[data-nav="kiel-chat"], a[href="chat.html"], a[href="/chat.html"]', '◌', 'service-drawer__link-icon--chat');
  normalizeDrawerIcon('a[data-nav="referral"], a[href="referral.html"], a[href="/referral.html"]', '🎁', 'service-drawer__link-icon--referral');
  normalizeDrawerIcon('a[href="tokens.html"], a[href="/tokens.html"]', '🔑', 'service-drawer__link-icon--token');
  normalizeDrawerIcon('.service-drawer__home, a[href="/index.html"], a[href="index.html"]', '🏠', 'service-drawer__link-icon--home');
  normalizeDrawerIcon('a[href="/models.html"], a[href="models.html"]', '🤖', 'service-drawer__link-icon--model');
  normalizeDrawerIcon('a[href="/model-status.html"], a[href="model-status.html"]', '📊', 'service-drawer__link-icon--status');
  normalizeDrawerIcon('a[data-nav="model-review"], a[href="/model-review.html"], a[href="model-review.html"]', '', 'service-drawer__link-icon--review');
  normalizeDrawerIcon('a[href="/api-integration.html"], a[href="api-integration.html"]', '✦', 'service-drawer__link-icon--ai');
  drawer.querySelectorAll('a[href="/web-development.html"], a[href="web-development.html"], a[href="/web-development-studio.html"], a[href="web-development-studio.html"]').forEach((link) => {
    link.href = '/studio-projects.html';
    const label = link.querySelector('span:last-child');
    if (label) label.textContent = 'KielTech AI studio';
    else link.textContent = 'KielTech AI studio';
  });
  normalizeDrawerIcon('a[href="/studio-projects.html"], a[href="studio-projects.html"]', '🛠️', 'service-drawer__link-icon--studio');
  normalizeDrawerIcon('a[href="/billing.html"], a[href="billing.html"]', '$', 'service-drawer__link-icon--billing');
  normalizeDrawerIcon('a[href="/settings.html"], a[href="settings.html"]', '⚙️', 'service-drawer__link-icon--settings');

  if (drawerNav && !drawer.querySelector('a[href="/billing.html"]')) {
    const billingLink = document.createElement('a');
    billingLink.className = 'service-drawer__link';
    billingLink.href = '/billing.html';
    billingLink.textContent = 'Billing';
    drawerNav.appendChild(billingLink);
  }

  if (drawerNav && !drawer.querySelector('a[href="/settings.html"]')) {
    const settingsLink = document.createElement('a');
    settingsLink.className = 'service-drawer__link';
    settingsLink.href = '/settings.html';
    settingsLink.textContent = 'Settings';
    drawerNav.appendChild(settingsLink);
  }

  if (!drawer.querySelector('.service-drawer__footer')) {
    const footer = document.createElement('div');
    footer.className = 'service-drawer__footer';
    footer.innerHTML = '<div class="service-drawer__account-label"><span class="service-drawer__account-dot" aria-hidden="true"></span><span>Account session</span></div><button id="serviceDrawerLogout" class="service-drawer__logout" type="button" hidden><span class="service-drawer__logout-icon" aria-hidden="true">↪</span><span>Sign out</span></button>';
    drawer.querySelector('.service-drawer__panel')?.appendChild(footer);
  }

  return { toggle, drawer };
}

function ensureSignOutDialog() {
  let dialog = document.getElementById('signOutConfirmDialog');
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.id = 'signOutConfirmDialog';
  dialog.className = 'sign-out-dialog';
  dialog.setAttribute('aria-labelledby', 'signOutConfirmTitle');
  dialog.setAttribute('aria-describedby', 'signOutConfirmDescription');
  dialog.innerHTML = `
    <div class="sign-out-dialog__content">
      <div class="sign-out-dialog__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 17l5-5-5-5M15 12H3"/>
          <path d="M12 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/>
        </svg>
      </div>
      <p class="sign-out-dialog__eyebrow">Account session</p>
      <h2 id="signOutConfirmTitle">Sign out of KielTech?</h2>
      <p id="signOutConfirmDescription">You can sign back in at any time. Your account and saved work will remain available.</p>
      <p class="sign-out-dialog__status" id="signOutConfirmStatus" role="status" aria-live="polite"></p>
      <div class="sign-out-dialog__actions">
        <button class="btn btn-secondary" type="button" data-sign-out-cancel>Stay signed in</button>
        <button class="btn btn-danger" type="button" data-sign-out-confirm>Sign out</button>
      </div>
    </div>`;
  document.body.append(dialog);

  const cancelButton = dialog.querySelector('[data-sign-out-cancel]');
  const confirmButton = dialog.querySelector('[data-sign-out-confirm]');
  const status = dialog.querySelector('#signOutConfirmStatus');
  const closeDialog = (confirmed) => {
    if (typeof dialog.resolveSignOut === 'function') dialog.resolveSignOut(confirmed);
    dialog.resolveSignOut = null;
    dialog.triggerButton = null;
    dialog.close();
  };

  cancelButton.addEventListener('click', () => closeDialog(false));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!confirmButton.disabled) closeDialog(false);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !confirmButton.disabled) closeDialog(false);
  });
  confirmButton.addEventListener('click', async () => {
    if (confirmButton.disabled) return;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    if (dialog.triggerButton) dialog.triggerButton.disabled = true;
    status.textContent = 'Signing out securely…';
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || 'Unable to sign out. Please try again.');
      }
      localStorage.removeItem('kieltechToken');
      state.token = '';
      closeDialog(true);
      window.location.assign('index.html');
    } catch (error) {
      status.textContent = error.message || 'Unable to sign out. Please check your connection and try again.';
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      if (dialog.triggerButton) dialog.triggerButton.disabled = false;
    }
  });

  return dialog;
}

function confirmSignOut(triggerButton) {
  const dialog = ensureSignOutDialog();
  if (dialog.open) return Promise.resolve(false);
  const status = dialog.querySelector('#signOutConfirmStatus');
  const confirmButton = dialog.querySelector('[data-sign-out-confirm]');
  const cancelButton = dialog.querySelector('[data-sign-out-cancel]');
  status.textContent = '';
  confirmButton.disabled = false;
  cancelButton.disabled = false;
  dialog.triggerButton = triggerButton || null;
  dialog.showModal();
  confirmButton.focus();
  return new Promise((resolve) => { dialog.resolveSignOut = resolve; });
}

function initServiceDrawer() {
  const ui = ensureServicesDrawerUI();
  if (!ui) {
    return;
  }

  const { toggle, drawer } = ui;
  const closeButton = document.getElementById('serviceDrawerClose');
  const logoutButton = document.getElementById('serviceDrawerLogout');
  const links = drawer.querySelectorAll('.service-drawer__link');
  const homeLink = drawer.querySelector('.service-drawer__home');

  links.forEach((link) => {
    const href = link.getAttribute('href') || '';
    const iconText = href.includes('dashboard') ? '▥' : href.includes('referral') ? '🎁' : '';
    const iconClass = href.includes('dashboard') ? 'service-drawer__link-icon--dashboard' : href.includes('referral') ? 'service-drawer__link-icon--referral' : '';
    if (!iconText) return;
    let icon = link.querySelector('.service-drawer__link-icon');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'service-drawer__link-icon';
      icon.setAttribute('aria-hidden', 'true');
      link.insertBefore(icon, link.firstChild);
    }
    icon.classList.add(iconClass);
    icon.textContent = iconText;
  });

  const openDrawer = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const shouldOpen = !drawer.classList.contains('is-open');
    drawer.classList.toggle('is-open', shouldOpen);
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    drawer.setAttribute('aria-hidden', String(!shouldOpen));
  };

  const closeDrawer = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    drawer.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-hidden', 'true');
  };

  toggle.addEventListener('click', openDrawer);
  closeButton?.addEventListener('click', closeDrawer);
  drawer.querySelectorAll('[data-close-drawer]').forEach((element) => {
    element.addEventListener('click', closeDrawer);
  });

  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  links.forEach((link) => {
    const href = link.getAttribute('href') || '';
    const normalizedHref = href.split('/').pop() || 'index.html';
    if (normalizedHref === currentPage || (normalizedHref === 'index.html' && currentPage === '')) {
      link.classList.add('is-active');
    }
  });

  if (homeLink) {
    const homeHref = homeLink.getAttribute('href') || 'index.html';
    const normalizedHomeHref = homeHref.split('/').pop() || 'index.html';
    if (normalizedHomeHref === currentPage || (normalizedHomeHref === 'index.html' && currentPage === '')) {
      homeLink.classList.add('is-active');
    }
  }

  if (logoutButton) logoutButton.hidden = !state.token;
  logoutButton?.addEventListener('click', () => confirmSignOut(logoutButton));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer(event);
    }
  });
}

function initHumanLanguageDocs() {
  const docsToggle = document.getElementById('docsToggle');
  const docsPanel = document.getElementById('docsPanel');
  const docsNav = document.getElementById('docsNav');
  const docsContent = document.getElementById('docsContent');
  const docsClose = document.getElementById('docsClose');

  if (!docsToggle || !docsPanel || !docsNav || !docsContent) {
    return;
  }

  const docsSections = [
    {
      id: 'overview',
      title: 'Overview',
      content: `
        <h4>Human programming language</h4>
        <p>Human is a readable, English-like programming language with a runtime that can power scripts, web services, APIs, and lightweight applications.</p>
        <p>The runtime now supports typed variables, pattern matching, web routes, auth, sessions, uploads, data helpers, and a frontend layer for interactive UI experiences.</p>
      `
    },
    {
      id: 'what-human-is',
      title: 'What Human is',
      content: `
        <h4>What Human is</h4>
        <p>Human is designed for clarity first. Its syntax is intentionally close to everyday language, while the runtime supports a rich standard library and native web features.</p>
        <ul>
          <li>Typed variables and function annotations</li>
          <li>Strings, lists, dicts, math, and JSON helpers</li>
          <li>Routes, middleware, auth, uploads, downloads, and OpenAPI docs</li>
          <li>Browser-style DOM, events, styling, reactivity, and hot reload</li>
        </ul>
      `
    },
    {
      id: 'why-use-human',
      title: 'Why use Human?',
      content: `
        <h4>Why use Human?</h4>
        <p>Human is a strong fit for learning programming, building internal tools, prototyping backends, and creating documentation-friendly demos.</p>
        <p>It also supports lightweight browser-like interfaces without a second frontend framework.</p>
      `
    },
    {
      id: 'installation',
      title: 'Installation',
      content: `
        <h4>Installation</h4>
        <pre><code>pip install human-language</code></pre>
        <pre><code>python -m pip install -e .</code></pre>
        <p>Run a program with:</p>
        <pre><code>human examples/hello_world.hm</code></pre>
      `
    },
    {
      id: 'first-program',
      title: 'First program',
      content: `
        <h4>Your first program</h4>
        <pre><code>print "Hello, Human!"

set age to 25
if age is greater than 18 then
    print "You are an adult"
else
    print "You are under 18"
end if</code></pre>
      `
    },
    {
      id: 'learn-human',
      title: 'Learn Human',
      content: `
        <h4>Learn Human in order</h4>
        <ol>
          <li>Start with QUICKSTART.md for beginner-friendly examples.</li>
          <li>Read SYNTAX.md for grammar and core constructs.</li>
          <li>Use FEATURES.md for the full list of current capabilities.</li>
        </ol>
      `
    }
  ];

  const renderSection = (sectionId) => {
    const section = docsSections.find((entry) => entry.id === sectionId) || docsSections[0];
    docsContent.innerHTML = section.content;
    docsNav.querySelectorAll('.docs-nav__item').forEach((button) => {
      button.classList.toggle('is-active', button.getAttribute('data-doc') === section.id);
    });
  };

  docsNav.innerHTML = docsSections.map((section) => `
    <button class="docs-nav__item" type="button" data-doc="${section.id}">${section.title}</button>
  `).join('');

  const openDocs = () => {
    docsPanel.hidden = false;
    docsPanel.classList.add('is-open');
    docsToggle.setAttribute('aria-expanded', 'true');
    docsToggle.textContent = 'Hide docs';
  };

  const closeDocs = () => {
    docsPanel.classList.remove('is-open');
    docsPanel.hidden = true;
    docsToggle.setAttribute('aria-expanded', 'false');
    docsToggle.textContent = 'Human docs';
  };

  docsToggle.addEventListener('click', () => {
    if (docsPanel.classList.contains('is-open')) {
      closeDocs();
      return;
    }

    openDocs();
  });

  docsClose?.addEventListener('click', closeDocs);
  docsPanel.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.matches('[data-close-docs]')) {
      closeDocs();
    }
  });

  docsNav.querySelectorAll('.docs-nav__item').forEach((button) => {
    button.addEventListener('click', () => {
      renderSection(button.getAttribute('data-doc'));
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDocs();
    }
  });

  renderSection('overview');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTokenPageState() {
  const modal = document.getElementById('tokenModal');
  const tokenTableBody = document.getElementById('tokenTableBody');
  const createPanel = document.getElementById('createTokenPanel');
  const createdPanel = document.getElementById('tokenCreatedPanel');
  const tokenInput = document.getElementById('tokenNameInput');
  const tokenNameError = document.getElementById('tokenNameError');
  const modalTokenValue = document.getElementById('modalTokenValue');
  const createButton = document.getElementById('createTokenButton');
  const confirmCreateButton = document.getElementById('confirmCreateToken');
  const copyButton = document.getElementById('copyModalToken');
  const activeCount = document.getElementById('tokenActiveCount');
  const activeHint = document.getElementById('tokenActiveHint');
  const lastCreated = document.getElementById('tokenLastCreated');
  const lastCreatedHint = document.getElementById('tokenLastCreatedHint');
  const securityStatus = document.getElementById('tokenSecurityStatus');

  return {
    modal,
    tokenTableBody,
    createPanel,
    createdPanel,
    tokenInput,
    tokenNameError,
    modalTokenValue,
    createButton,
    confirmCreateButton,
    copyButton,
    activeCount,
    activeHint,
    lastCreated,
    lastCreatedHint,
    securityStatus,
  };
}

function updateTokenOverview(ui, tokens) {
  if (!ui) return;
  const activeTokens = tokens.filter((token) => token && token.revoked !== true && token.is_active !== false);
  const latestToken = [...activeTokens]
    .filter((token) => token.created_at)
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];

  if (ui.activeCount) ui.activeCount.textContent = String(activeTokens.length);
  if (ui.activeHint) ui.activeHint.textContent = activeTokens.length === 1 ? '1 active credential' : `${activeTokens.length} active credentials`;
  if (ui.lastCreated) ui.lastCreated.textContent = latestToken ? new Date(latestToken.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
  if (ui.lastCreatedHint) ui.lastCreatedHint.textContent = latestToken ? new Date(latestToken.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'No key activity yet';
  if (ui.securityStatus) ui.securityStatus.textContent = 'Protected';
}

function openTokenModal(mode = 'create') {
  const ui = getTokenPageState();
  if (!ui.modal) return;
  ui.modal.classList.add('is-open');
  ui.modal.setAttribute('aria-hidden', 'false');
  const title = document.getElementById('tokenModalTitle');
  if (title) {
    title.textContent = mode === 'created' ? 'API token created' : 'Create API Token';
  }
  if (ui.tokenInput) {
    ui.tokenInput.value = '';
    if (mode === 'create') {
      ui.tokenInput.focus();
    }
  }
  if (ui.tokenNameError) {
    ui.tokenNameError.style.display = 'none';
  }
  if (ui.createPanel) ui.createPanel.classList.toggle('hidden', mode !== 'create');
  if (ui.createdPanel) ui.createdPanel.classList.toggle('hidden', mode === 'create');
}

function closeTokenModal() {
  const ui = getTokenPageState();
  if (!ui.modal) return;
  ui.modal.classList.remove('is-open');
  ui.modal.setAttribute('aria-hidden', 'true');
  if (ui.createPanel) ui.createPanel.classList.remove('hidden');
  if (ui.createdPanel) ui.createdPanel.classList.add('hidden');
  if (ui.tokenInput) ui.tokenInput.value = '';
}

async function loadTokens() {
  const ui = getTokenPageState();
  if (!ui.tokenTableBody) return;

  ui.tokenTableBody.innerHTML = '<tr><td colspan="5" class="text-muted">Loading tokens...</td></tr>';

  try {
    const data = await request('/v1/auth/tokens');
    const tokens = (Array.isArray(data.tokens) ? data.tokens : []).filter((token) => token && token.active !== false && token.revoked !== true && token.is_active !== false);
    updateTokenOverview(ui, tokens);

    if (!tokens.length) {
      ui.tokenTableBody.innerHTML = '<tr><td colspan="5" class="text-muted">No API keys yet. Create a named key when you are ready to connect a service.</td></tr>';
      return;
    }

    ui.tokenTableBody.innerHTML = tokens.map((token) => `
      <tr>
        <td data-label="Key name">
          <div class="token-name">${escapeHtml(token.name || 'Untitled token')}</div>
          <div class="token-meta">${escapeHtml(token.masked || '••••••••')}</div>
        </td>
        <td data-label="Created">${escapeHtml(token.created_at ? new Date(token.created_at).toLocaleString() : '—')}</td>
        <td data-label="Last used">${escapeHtml(token.last_used_at ? new Date(token.last_used_at).toLocaleString() : 'Never')}</td>
        <td data-label="Status"><span class="token-badge token-badge--active">Active</span></td>
        <td data-label="Actions">
          <div class="token-actions">
            <button class="btn btn-danger" type="button" data-revoke-token="${escapeHtml(token.id)}">Revoke</button>
          </div>
        </td>
      </tr>
    `).join('');

    const revokeModal = document.getElementById('revokeModal');
    if (!revokeModal) return;

    ui.tokenTableBody.querySelectorAll('[data-revoke-token]').forEach((button) => {
      button.addEventListener('click', () => {
        const tokenId = button.getAttribute('data-revoke-token');
        if (!tokenId) return;
        activeRevokeTokenId = tokenId;
        revokeModal.classList.add('is-open');
        revokeModal.setAttribute('aria-hidden', 'false');
      });
    });
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      if (ui.createButton) ui.createButton.disabled = true;
      if (ui.activeCount) ui.activeCount.textContent = '—';
      if (ui.activeHint) ui.activeHint.textContent = 'Sign in to view key inventory';
      if (ui.lastCreated) ui.lastCreated.textContent = '—';
      if (ui.lastCreatedHint) ui.lastCreatedHint.textContent = 'Authentication required';
      if (ui.securityStatus) ui.securityStatus.textContent = 'Sign in';
      ui.tokenTableBody.innerHTML = '<tr><td colspan="5" class="token-access-state"><strong>Sign in required</strong><span>Authenticate to view and manage your API keys.</span><a class="btn btn-primary" href="login.html?return_to=tokens.html">Sign in</a></td></tr>';
      return;
    }
    ui.tokenTableBody.innerHTML = `<tr><td colspan="5" class="token-access-state"><strong>Unable to load API keys</strong><span>${escapeHtml(error.message)}</span><button class="btn btn-secondary" type="button" data-retry-tokens>Try again</button></td></tr>`;
    ui.tokenTableBody.querySelector('[data-retry-tokens]')?.addEventListener('click', loadTokens);
  }
}

function initTokenManager() {
  const ui = getTokenPageState();
  const revokeModal = document.getElementById('revokeModal');
  const confirmRevokeButton = document.getElementById('confirmRevokeToken');
  activeRevokeTokenId = null;

  if (!ui.createButton || !ui.confirmCreateButton || !ui.modal || !revokeModal || !confirmRevokeButton) {
    return;
  }

  ui.createButton.addEventListener('click', () => openTokenModal('create'));
  ui.confirmCreateButton.addEventListener('click', async () => {
    const name = (ui.tokenInput?.value || '').trim();
    if (!name) {
      if (ui.tokenNameError) {
        ui.tokenNameError.textContent = 'Please enter a token name before creating it.';
        ui.tokenNameError.style.display = 'block';
      }
      ui.tokenInput?.focus();
      return;
    }

    if (ui.tokenNameError) {
      ui.tokenNameError.style.display = 'none';
    }

    ui.confirmCreateButton.disabled = true;
    ui.confirmCreateButton.textContent = 'Creating...';

    try {
      const data = await request('/v1/auth/tokens/create', {
        method: 'POST',
        body: JSON.stringify({ name })
      });

      if (ui.modalTokenValue) {
        ui.modalTokenValue.textContent = data.token || 'Token unavailable';
      }
      openTokenModal('created');
      showToast('Token created successfully');
      await loadTokens();
    } catch (error) {
      if (ui.tokenNameError && error.message.toLowerCase().includes('name already')) {
        ui.tokenNameError.textContent = 'Name already used. Choose a different token name.';
        ui.tokenNameError.style.display = 'block';
        ui.tokenInput?.focus();
      } else {
        showToast(error.message);
      }
    } finally {
      ui.confirmCreateButton.disabled = false;
      ui.confirmCreateButton.textContent = 'Create token';
    }
  });

  ui.copyButton?.addEventListener('click', async () => {
    const token = ui.modalTokenValue?.textContent?.trim();
    if (!token || token === 'Token unavailable') {
      showToast('No token available to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(token);
      showToast('Token copied to clipboard');
    } catch (error) {
      showToast('Unable to copy token');
    }
  });

  revokeModal.querySelectorAll('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', () => {
      revokeModal.classList.remove('is-open');
      revokeModal.setAttribute('aria-hidden', 'true');
      activeRevokeTokenId = null;
    });
  });

  confirmRevokeButton.addEventListener('click', async () => {
    if (!activeRevokeTokenId) return;
    confirmRevokeButton.disabled = true;
    confirmRevokeButton.textContent = 'Revoking...';

    try {
      await request('/v1/auth/tokens/revoke', {
        method: 'POST',
        body: JSON.stringify({ id: activeRevokeTokenId })
      });
      const overview = getTokenPageState();
      const currentCount = Number(overview.activeCount?.textContent || 0);
      if (overview.activeCount && Number.isFinite(currentCount) && currentCount > 0) {
        const nextCount = currentCount - 1;
        overview.activeCount.textContent = String(nextCount);
        if (overview.activeHint) overview.activeHint.textContent = nextCount === 1 ? '1 active credential' : `${nextCount} active credentials`;
      }
      showToast('Token revoked and deleted');
      revokeModal.classList.remove('is-open');
      revokeModal.setAttribute('aria-hidden', 'true');
      activeRevokeTokenId = null;
      await loadTokens();
    } catch (error) {
      showToast(error.message);
    } finally {
      confirmRevokeButton.disabled = false;
      confirmRevokeButton.textContent = 'I understand, revoke it';
    }
  });

  ui.modal.querySelectorAll('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', closeTokenModal);
  });

  ui.tokenInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      ui.confirmCreateButton.click();
    }
  });

  loadTokens();
}

function initStudioTabs() {
  const tabPreviewBtn = document.getElementById('tabPreviewBtn');
  const tabCodeBtn = document.getElementById('tabCodeBtn');
  const previewView = document.getElementById('previewView');
  const codeView = document.getElementById('codeView');

  if (!tabPreviewBtn || !tabCodeBtn || !previewView || !codeView) {
    return;
  }

  const ensureToolbarVisible = () => {
    const toolbar = document.getElementById('studioSubToolbar');
    if (toolbar) {
      toolbar.style.display = 'flex';
      toolbar.style.visibility = 'visible';
      toolbar.style.opacity = '1';
    }
    tabPreviewBtn.style.display = 'flex';
    tabCodeBtn.style.display = 'flex';
    tabPreviewBtn.style.visibility = 'visible';
    tabCodeBtn.style.visibility = 'visible';
    tabPreviewBtn.style.opacity = '1';
    tabCodeBtn.style.opacity = '1';
  };

  const applyStudioViewMode = (mode) => {
    const isPreview = mode === 'preview';
    tabPreviewBtn.classList.toggle('active', isPreview);
    tabCodeBtn.classList.toggle('active', !isPreview);
    previewView.classList.toggle('active', isPreview);
    codeView.classList.toggle('active', !isPreview);
    ensureToolbarVisible();
  };

  tabPreviewBtn.addEventListener('click', () => applyStudioViewMode('preview'));

  tabCodeBtn.addEventListener('click', () => applyStudioViewMode('code'));
}

async function loadBillingPanel() {
  const billingPanel = document.getElementById('billingPanel');
  if (!billingPanel) return;

  billingPanel.innerHTML = '<p class="demo-response">Loading billing details...</p>';

  try {
    const emailInput = document.getElementById('billingEmailInput');
    const profileResponse = await request('/v1/auth/me').catch(() => null);
    const authenticatedEmail = profileResponse?.user?.email || emailInput?.value?.trim() || 'kieltech75@gmail.com';
    if (emailInput) {
      emailInput.value = authenticatedEmail;
    }
    const [usage, config, history, wallet] = await Promise.all([
      request(`/v1/billing/usage?email=${encodeURIComponent(authenticatedEmail)}`),
      request('/v1/billing/config').catch(() => ({ paystack_enabled: false, default_plan_code: 'basic-monthly', default_amount: 5000 })),
      request('/v1/billing/history').catch(() => ({ items: [] })),
      request(`/v1/billing/wallet?email=${encodeURIComponent(authenticatedEmail)}`)
    ]);

    const progressPercent = Math.min(100, Math.round((usage.current_usage / usage.included_limit) * 100));
    const overageLabel = usage.overage_mode ? 'Overage active' : 'Within included quota';
    const nextAmount = Math.max(0, usage.current_usage - usage.included_limit);
    const paymentStatusLabel = usage.payment_status === 'paid' ? 'Paid' : usage.payment_status === 'failed' ? 'Failed' : 'Pending';
    const paymentStatusTone = usage.payment_status === 'paid' ? 'status-pill--success' : usage.payment_status === 'failed' ? 'status-pill--info' : 'status-pill--muted';
    const paymentBadge = document.getElementById('paymentStatusBadge');
    if (paymentBadge) {
      paymentBadge.textContent = paymentStatusLabel;
      paymentBadge.className = `status-pill ${paymentStatusTone}`;
    }
    const topupSuccess = new URLSearchParams(window.location.search).get('topup') === 'success';
    const historyRows = (history.items || []).map((item) => `
      <div class="list-item">
        <div>
          <strong>${item.reference || 'Invoice'}</strong>
          <p class="demo-response">${item.plan_code || 'Plan'} · ${item.amount || 0} · ${item.status || 'pending'}</p>
        </div>
        <span class="pill">${item.status || 'pending'}</span>
      </div>
    `).join('');
    const walletRows = (wallet.transactions || []).map((item) => {
      const metadata = item.metadata || {};
      const modelLabel = metadata.model ? ` • ${escapeHtml(metadata.model)}` : '';
      const tokenLabel = metadata.total_tokens ? ` • ${Number(metadata.total_tokens).toLocaleString()} tokens` : '';
      const transactionCurrency = item.currency || wallet.currency || 'NGN';
      const amountLabel = item.kind === 'credit' ? `+${formatCurrency(item.amount || 0, transactionCurrency)}` : `-${formatCurrency(item.amount || 0, transactionCurrency)}`;
      return `
        <div class="list-item">
          <div>
            <strong>${escapeHtml(item.description || item.kind || 'Wallet activity')}${modelLabel}</strong>
            <p class="demo-response">${escapeHtml(item.provider || 'wallet')} · ${new Date(item.created_at || Date.now()).toLocaleString()}${tokenLabel}</p>
          </div>
          <span class="pill">${amountLabel}</span>
        </div>
      `;
    }).join('');
    const equivalencyRows = Object.entries(wallet.equivalency || {}).map(([model, entry]) => `
      <div class="list-item">
        <div>
          <strong>${escapeHtml(model)}</strong>
          <p class="demo-response">Estimated ${escapeHtml(entry.label || 'units')} remaining</p>
        </div>
        <span class="pill">${Number(entry.value || 0).toLocaleString()}</span>
      </div>
    `).join('');
    const freeTier = wallet.free_tier || {};
    const freeTierStatus = freeTier.claimed ? 'Claimed' : (freeTier.eligible ? 'Eligible' : 'Not eligible');
    const tierInfo = getRateLimitTier(wallet.balance || 0, wallet.account_status || 'free_tier');
    const tierCards = [
      { name: 'Standard', range: '$1 - $100', rpm: '60 RPM', min: 1, max: 100 },
      { name: 'Pro', range: '$101 - $500', rpm: '300 RPM', min: 101, max: 500 },
      { name: 'Elite', range: '$501 - $1,500', rpm: '1,000 RPM', min: 501, max: 1500 },
      { name: 'Ultra', range: '$1,501+', rpm: '5,000 RPM', min: 1501, max: Infinity },
    ].map((tier) => {
      const isActive = tier.name === tierInfo.name;
      const activeClass = isActive ? 'tier-card--active' : '';
      return `
        <div class="tier-card ${activeClass}">
          <div class="tier-card__header">
            <strong>${escapeHtml(tier.name)}</strong>
            ${isActive ? '<span class="tier-badge">Active</span>' : ''}
          </div>
          <p class="demo-response">${escapeHtml(tier.range)}</p>
          <p class="demo-response"><strong>${escapeHtml(tier.rpm)}</strong></p>
        </div>
      `;
    }).join('');

    billingPanel.innerHTML = `
      <div class="billing-card billing-card--hero">
        ${topupSuccess ? `<div class="card" style="margin-bottom: 0.8rem; padding: 0.8rem; border: 1px solid #4ade80; background: rgba(74, 222, 128, 0.12);"><strong>Wallet top-up success</strong><p class="demo-response" style="margin: 0.3rem 0 0;">Your wallet was funded successfully. The balance above is ready for model usage.</p></div>` : ''}
        <div class="billing-row billing-row--stacked">
          <div>
            <p class="card-kicker">Usage quota</p>
            <strong class="billing-usage-value">${usage.current_usage}/${usage.included_limit} requests</strong>
          </div>
          <span class="status-pill status-pill--info">${overageLabel}</span>
        </div>
        <div class="quota-progress" aria-label="Usage progress">
          <div class="quota-progress__bar" style="width: ${progressPercent}%"></div>
        </div>
        <p class="demo-response">${usage.overage_mode ? `You are past your included quota. Overage pricing is $${usage.overage_price.toFixed(2)} per request.` : `You still have ${usage.included_limit - usage.current_usage} requests left this period.`}</p>
        <p class="demo-response">Estimated overage requests: ${nextAmount}</p>
        <p class="demo-response">Payment status: <strong>${paymentStatusLabel}</strong> · Next invoice: ${usage.next_invoice_amount || 0} units</p>
        <p class="demo-response">Paystack status: ${config.paystack_enabled ? 'Enabled' : 'Not configured'} · Plan: ${config.default_plan_code || 'basic-monthly'}</p>
        <div class="card" style="margin-top: 0.7rem; padding: 0.8rem; display: grid; gap: 0.6rem;">
          <div class="billing-row">
            <strong>Wallet balance</strong>
            <span class="pill">${formatCurrency(wallet.balance || 0, 'USD')}</span>
          </div>
          <div class="tier-status-card">
            <div class="billing-row">
              <div>
                <strong>${tierInfo.name} tier</strong>
                <p class="demo-response" style="margin: 0.2rem 0 0;">${tierInfo.rpm.toLocaleString()} RPM • ${formatCurrency(wallet.balance || 0, 'USD')} active balance</p>
              </div>
              <span class="pill">${tierInfo.badge}</span>
            </div>
            <div class="tier-progress" aria-label="Tier progress">
              <div class="tier-progress__bar" style="width: ${tierInfo.progressPercent}%"></div>
            </div>
            <p class="demo-response" style="margin: 0;">${tierInfo.nextTier ? `Need ${formatCurrency(tierInfo.nextAmount, 'USD')} more to unlock the ${tierInfo.nextTier} tier.` : 'You are already in the highest tier available.'}</p>
          </div>
          <div class="tier-grid">${tierCards}</div>
          <p class="demo-response">Estimated token and generation budget for ${escapeHtml(wallet.email || billingEmail)}.</p>
          <div class="card" style="padding: 0.75rem; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03);">
            <div class="billing-row">
              <strong>Free-tier promo</strong>
              <span class="pill">${freeTierStatus}</span>
            </div>
            <p class="demo-response" style="margin: 0.35rem 0 0;">Credit eligibility is managed by the account billing service.</p>
          </div>
          <div class="list-stack">${equivalencyRows || '<p class="demo-response">No quota estimate available.</p>'}</div>
          <p class="demo-response">Recent transaction activity.</p>
          <div class="hero-actions">
            <button class="btn btn-primary" id="topupWalletButton" type="button">Top up wallet</button>
          </div>
          <div class="list-stack">${walletRows || '<p class="demo-response">No wallet activity yet.</p>'}</div>
        </div>
        <div class="card" style="margin-top: 0.7rem; padding: 0.8rem; display: grid; gap: 0.6rem;">
          <label class="playground-field" for="billingEmailInput" style="margin:0;">
            <span class="playground-label">Customer email</span>
            <input id="billingEmailInput" type="email" value="kieltech75@gmail.com" />
          </label>
          <label class="playground-field" for="billingPlanInput" style="margin:0;">
            <span class="playground-label">Plan code</span>
            <input id="billingPlanInput" type="text" value="${config.default_plan_code || 'basic-monthly'}" />
          </label>
          <label class="playground-field" for="billingAmountInput" style="margin:0;">
            <span class="playground-label">Amount (USD)</span>
            <input id="billingAmountInput" type="number" min="1" step="1" value="${config.default_amount || 150}" />
          </label>
          <div class="hero-actions">
            <button class="btn btn-primary" id="initializeBillingButton" type="button">Initialize Paystack payment</button>
          </div>
        </div>
        <div class="card" style="margin-top: 0.7rem; padding: 0.8rem; display: grid; gap: 0.6rem;">
          <h4 style="margin: 0;">Paystack configuration</h4>
          <p class="demo-response" style="margin: 0;">Paystack is configured in live-only mode on the backend. The live secret key is kept on the backend and is not exposed to the browser.</p>
        </div>
        <div class="card" style="margin-top: 0.7rem; padding: 0.8rem;">
          <h4 style="margin: 0 0 0.4rem;">Invoice history</h4>
          <div class="list-stack">${historyRows || '<p class="demo-response">No invoices yet.</p>'}</div>
        </div>
      </div>
    `;

    const initializeButton = document.getElementById('initializeBillingButton');
    const topupButton = document.getElementById('topupWalletButton');
    initializeButton?.addEventListener('click', async () => {
      initializeButton.disabled = true;
      initializeButton.textContent = 'Initializing...';
      try {
        const emailInput = document.getElementById('billingEmailInput');
        const planInput = document.getElementById('billingPlanInput');
        const amountInput = document.getElementById('billingAmountInput');
        const payment = await request('/v1/billing/initialize', {
          method: 'POST',
          body: JSON.stringify({
            email: emailInput?.value?.trim() || 'kieltech75@gmail.com',
            plan_code: planInput?.value?.trim() || config.default_plan_code || 'basic-monthly',
            amount: Number(amountInput?.value || config.default_amount || 150),
            amount_usd: Number(amountInput?.value || config.default_amount || 150),
            currency: 'NGN',
            callback_url: `${window.location.origin}/billing.html`
          })
        });
        if (payment.authorization_url) {
          window.open(payment.authorization_url, '_blank', 'noopener,noreferrer');
        }
        if (typeof window.__kieltechRefreshDashboard === 'function') {
          window.__kieltechRefreshDashboard();
        }
        billingPanel.innerHTML = `
          <div class="billing-card">
            <strong>Payment initialized</strong>
            <p class="demo-response">Reference: ${payment.reference}</p>
            <p class="demo-response">Amount: ${payment.amount} · Status: ${payment.payment_status || 'pending'}</p>
            <p class="demo-response">Provider: ${payment.provider || 'demo'}</p>
            ${payment.authorization_url ? `<p class="demo-response">Checkout: <a href="${payment.authorization_url}" target="_blank" rel="noreferrer">Open Paystack checkout</a></p>` : ''}
            ${payment.paystack_error ? `<p class="demo-response" style="color:#f87171;">Error: ${escapeHtml(payment.paystack_error)}</p>` : ''}
          </div>
        `;
        showToast(payment.authorization_url ? 'Paystack checkout opened' : 'Paystack payment initialized');
      } catch (error) {
        showToast(error.message);
      } finally {
        initializeButton.disabled = false;
        initializeButton.textContent = 'Initialize Paystack payment';
      }
    });

    topupButton?.addEventListener('click', async () => {
      topupButton.disabled = true;
      topupButton.textContent = 'Opening checkout...';
      try {
        const emailInput = document.getElementById('billingEmailInput');
        const amountInput = document.getElementById('billingAmountInput');
        const profileResponse = await request('/v1/auth/me').catch(() => null);
        const billingEmail = profileResponse?.user?.email || emailInput?.value?.trim() || 'kieltech75@gmail.com';
        const topup = await request('/v1/billing/initialize-topup', {
          method: 'POST',
          body: JSON.stringify({
            email: billingEmail,
            amount: Number(amountInput?.value || 150),
            amount_usd: Number(amountInput?.value || 150),
            currency: 'NGN',
            plan_code: 'wallet-topup',
            callback_url: `${window.location.origin}/billing.html`
          })
        });
        if (topup.authorization_url) {
          window.open(topup.authorization_url, '_blank', 'noopener,noreferrer');
        }
        if (typeof window.__kieltechRefreshDashboard === 'function') {
          window.__kieltechRefreshDashboard();
        }
        if (topup.paystack_error) {
          showToast(`Paystack error: ${topup.paystack_error}`);
        } else if (topup.provider === 'saved-card') {
          showToast(`Wallet funded from your saved card for $${Number(topup.amount || 0).toFixed(2)}`);
        } else {
          showToast(topup.authorization_url ? 'Checkout opened for your wallet top-up' : 'Wallet top-up initialized');
        }
      } catch (error) {
        showToast(error.message);
      } finally {
        topupButton.disabled = false;
        topupButton.textContent = 'Top up wallet';
      }
    });
  } catch (error) {
    billingPanel.innerHTML = `<p class="demo-response">${error.message}</p>`;
  }
}

async function loadBillingOverview() {
  const billingAuthNotice = document.getElementById('billingAuthNotice');
  const emailInput = document.getElementById('billingEmailInput');
  const billingAccountEmail = document.getElementById('billingAccountEmail');
  const billingAccountName = document.getElementById('billingAccountName');
  const billingCurrentPlan = document.getElementById('billingCurrentPlan');
  const billingCurrentPlanBadge = document.getElementById('billingCurrentPlanBadge');
  const billingCurrentUsage = document.getElementById('billingCurrentUsage');
  const billingRateLimit = document.getElementById('billingRateLimit');
  const billingWalletBalance = document.getElementById('billingWalletBalance');
  const billingSpendLimits = document.getElementById('billingSpendLimits');
  const billingOverageStatus = document.getElementById('billingOverageStatus');
  const billingProviderStatus = document.getElementById('billingProviderStatus');
  const billingProviderDetail = document.getElementById('billingProviderDetail');
  if (!emailInput && !billingAccountEmail && !billingAccountName && !billingCurrentPlan && !billingCurrentUsage && !billingRateLimit && !billingWalletBalance && !billingSpendLimits && !billingOverageStatus && !billingProviderStatus && !billingProviderDetail) {
    return;
  }

  const profileResponse = await request('/v1/auth/me').catch(() => null);
  const billingActions = ['billingInitializeButton', 'redeemPasskeyButton', 'saveCardForOverageButton', 'overageOptInCheckbox'];
  if (!profileResponse?.user?.email) {
    if (billingAuthNotice) billingAuthNotice.classList.add('is-visible');
    billingActions.forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = true;
    });
    if (emailInput) emailInput.value = '';
    if (billingWalletBalance) billingWalletBalance.textContent = 'Sign in';
    if (billingCurrentUsage) billingCurrentUsage.textContent = 'Sign in';
    if (billingCurrentPlan) billingCurrentPlan.textContent = '—';
    if (billingRateLimit) billingRateLimit.textContent = '—';
    return;
  }

  if (billingAuthNotice) billingAuthNotice.classList.remove('is-visible');
  billingActions.forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = false;
  });
  const authenticatedEmail = profileResponse.user.email;

  if (emailInput) {
    emailInput.value = authenticatedEmail;
  }

  const [wallet, usage, config] = await Promise.all([
    request(`/v1/billing/wallet?email=${encodeURIComponent(authenticatedEmail)}`),
    request(`/v1/billing/usage?email=${encodeURIComponent(authenticatedEmail)}`),
    request('/v1/billing/config'),
  ]);

  const tierInfo = getRateLimitTier(wallet.balance || 0, wallet.account_status || 'free_tier');
  const currentUsageText = `${Number(usage.current_usage || 0).toLocaleString()} / ${Number(usage.included_limit || 1000).toLocaleString()} requests`;

  if (billingAccountEmail) {
    billingAccountEmail.textContent = authenticatedEmail;
  }

  if (billingAccountName) {
    billingAccountName.textContent = profileResponse?.user?.name || 'Developer';
  }

  if (billingCurrentPlan) {
    billingCurrentPlan.textContent = tierInfo.name;
  }

  if (billingCurrentPlanBadge) {
    billingCurrentPlanBadge.textContent = tierInfo.name;
  }

  if (billingCurrentUsage) {
    billingCurrentUsage.textContent = currentUsageText;
  }

  if (billingRateLimit) {
    billingRateLimit.textContent = `${typeof tierInfo.rpm === 'number' ? tierInfo.rpm.toLocaleString() : tierInfo.rpm} RPM`;
  }

  if (billingSpendLimits) {
    const dailyLimit = formatCurrency(wallet.daily_spend_limit || 0, wallet.currency || 'USD');
    const monthlyLimit = formatCurrency(wallet.monthly_spend_limit || 0, wallet.currency || 'USD');
    billingSpendLimits.textContent = `${dailyLimit} daily / ${monthlyLimit} monthly`;
  }
  const overageDailyLimitInput = document.getElementById('overageDailyLimitInput');
  const overageMonthlyLimitInput = document.getElementById('overageMonthlyLimitInput');
  if (overageDailyLimitInput) overageDailyLimitInput.value = Number(wallet.daily_spend_limit || 0).toFixed(2);
  if (overageMonthlyLimitInput) overageMonthlyLimitInput.value = Number(wallet.monthly_spend_limit || 0).toFixed(2);

  if (billingWalletBalance) {
    billingWalletBalance.textContent = formatCurrency(wallet.balance || 0, wallet.currency || 'USD');
  }

  if (billingOverageStatus) {
    billingOverageStatus.textContent = usage.overage_mode ? 'Enabled' : 'Disabled';
    billingOverageStatus.className = `pill ${usage.overage_mode ? 'status-pill--active' : ''}`.trim();
  }

  if (billingProviderStatus) {
    const paystackState = config.paystack_enabled ? 'Live' : 'Offline';
    billingProviderStatus.textContent = paystackState;
    billingProviderStatus.className = `pill ${config.paystack_enabled ? 'status-pill--success' : 'status-pill--muted'}`.trim();
  }

  if (billingProviderDetail) {
    billingProviderDetail.textContent = config.paystack_enabled
      ? `Paystack is enabled for wallet top-ups and checkout flows. Current default plan is ${config.default_plan_code || 'basic-monthly'}.`
      : 'Payment configuration is currently offline. Use the checkout flow only after backend payment settings are restored.';
  }

}

function initBillingPage() {
  const billingPage = window.location.pathname.includes('/billing') || window.location.pathname.endsWith('/billing.html');
  if (!billingPage) return;

  renderBillingTierCards('Standard');
  updateBillingSelectionSummary('Standard');
  initBillingPageHandlers();
  loadBillingOverview().catch((error) => {
    const notice = document.getElementById('billingAuthNotice');
    if (!notice) return;
    notice.classList.add('is-visible');
    const title = notice.querySelector('strong');
    const detail = notice.querySelector('span');
    if (title) title.textContent = 'Billing data unavailable';
    if (detail) detail.textContent = error.message || 'Unable to load billing data. Please try again.';
  });
}

async function initSettingsPage() {
  const settingsPage = window.location.pathname.includes('/settings') || window.location.pathname.endsWith('/settings.html');
  if (!settingsPage) return;

  const checkbox = document.getElementById('cancelOverageCheckbox');
  const saveButton = document.getElementById('saveCancelOverageButton');
  const message = document.getElementById('cancelOverageMessage');
  const statusPill = document.getElementById('settingsStatusPill');
  const cardStatusText = document.getElementById('cardStatusText');
  const toggleHintText = document.getElementById('toggleHintText');
  const profileName = document.getElementById('settingsProfileName');
  const profileEmail = document.getElementById('settingsProfileEmail');
  const profileVerification = document.getElementById('settingsProfileVerification');
  const profileCreated = document.getElementById('settingsProfileCreated');
  const profileMessage = document.getElementById('settingsProfileMessage');
  const logoutButton = document.getElementById('settingsLogoutButton');
  const credentialEditButton = document.getElementById('requestCredentialEditButton');
  const credentialEditMessage = document.getElementById('credentialEditMessage');
  const email = document.getElementById('billingEmailInput')?.value?.trim();

  const setMessage = (text, tone = 'info') => {
    if (!message) return;
    message.textContent = text;
    message.className = `form-status ${tone === 'loading' ? 'is-loading' : tone === 'success' ? 'form-status--success' : tone === 'error' ? 'form-status--error' : 'form-status--info'}`.trim();
  };

  let userEmail = email || '';
  let currentCardOnFile = false;

  const toggleLabel = document.querySelector('.settings-toggle');

  const updateVisualState = () => {
    const isEnabled = Boolean(checkbox?.checked);
    if (statusPill) {
      statusPill.textContent = isEnabled ? 'On' : 'Off';
      statusPill.classList.toggle('is-active', isEnabled);
    }

    if (cardStatusText) {
      cardStatusText.textContent = currentCardOnFile
        ? 'Card saved and ready'
        : 'No card on file yet';
    }

    if (checkbox) {
      checkbox.disabled = !currentCardOnFile;
    }
    if (toggleLabel) {
      toggleLabel.classList.toggle('is-disabled', !currentCardOnFile);
    }
    if (toggleHintText) {
      toggleHintText.textContent = currentCardOnFile ? 'Ready to use' : 'Enabled once card is added';
    }
  };

  const updateSaveButtonText = () => {
    if (!saveButton) return;
    saveButton.textContent = currentCardOnFile ? 'Update authorization' : 'Authorize payment method';
    updateVisualState();
  };

  const loadSettings = async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const focus = params.get('focus');
      const profile = await request('/v1/auth/me');
      userEmail = profile?.user?.email || userEmail;
      if (profileName) profileName.textContent = profile.user.name || profile.user.username || 'Developer';
      if (profileEmail) profileEmail.textContent = userEmail || '—';
      if (profileVerification) profileVerification.textContent = profile.user.email_verified ? 'Verified' : 'Verification required';
      if (profileCreated) profileCreated.textContent = profile.user.created_at ? new Date(profile.user.created_at).toLocaleDateString() : '—';
      const response = await request(`/v1/billing/overage-policy?email=${encodeURIComponent(userEmail)}`);
      if (response && checkbox) {
        checkbox.checked = Boolean(response.overage_enabled);
        currentCardOnFile = Boolean(response.card_on_file);
        updateSaveButtonText();
        if (currentCardOnFile) {
          setMessage('Your authorized payment method is ready for overage billing.', 'success');
        } else if (focus === 'overage') {
          setMessage('Continue by adding your card for overage here, then return to billing.', 'info');
        } else {
          setMessage('Add a card to enable overage billing.', 'info');
        }
      }

      if (focus === 'overage') {
        const overageCard = document.getElementById('overageBillingCard');
        if (overageCard) {
          overageCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    } catch (error) {
      setMessage(error.message || 'Unable to load current settings.', 'error');
      if (profileMessage) profileMessage.textContent = error.message || 'Unable to load account details.';
    }
  };

  const saveCardAndEnableOverage = async () => {
    if (!saveButton) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Opening secure authorization...';
    setMessage(currentCardOnFile ? 'Opening Paystack to replace your overage payment method...' : 'Opening Paystack to authorize your overage payment method...', 'loading');

    try {
      const response = await request('/v1/billing/save-card', {
        method: 'POST',
        body: JSON.stringify({ email: userEmail }),
      });
      if (!response.access_code || typeof window.PaystackPop !== 'function') {
        throw new Error('Secure payment authorization is unavailable. Please try again.');
      }
      const popup = new window.PaystackPop();
      popup.resumeTransaction(response.access_code);
      setMessage('Complete authorization in the secure Paystack window. This does not top up your wallet.', 'info');
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const status = await request(`/v1/billing/overage-policy?email=${encodeURIComponent(userEmail)}`);
        if (status.card_on_file) {
          currentCardOnFile = true;
          checkbox.checked = true;
          updateVisualState();
          setMessage('Payment method updated. Overage billing is enabled.', 'success');
          break;
        }
      }

    } catch (error) {
      setMessage(error.message || 'Unable to save card.', 'error');
    } finally {
      saveButton.disabled = false;
      updateSaveButtonText();
    }
  };

  checkbox?.addEventListener('change', async () => {
    if (!currentCardOnFile && checkbox.checked) {
      checkbox.checked = false;
      setMessage('Add a card before enabling overage billing.', 'error');
      return;
    }

    try {
      const response = await request('/v1/billing/overage-policy', {
        method: 'POST',
        body: JSON.stringify({
          email: userEmail,
          enabled: checkbox.checked,
          card_on_file: currentCardOnFile,
        }),
      });
      if (response?.overage_enabled) {
        setMessage('Overage billing is enabled for your saved card.', 'success');
      } else {
        setMessage('Overage billing is disabled.', 'success');
      }
      updateVisualState();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      setMessage(error.message || 'Unable to update overage settings.', 'error');
    }
  });

  await loadSettings();
  updateVisualState();
  saveButton?.addEventListener('click', saveCardAndEnableOverage);
  credentialEditButton?.addEventListener('click', async () => {
    credentialEditButton.disabled = true;
    if (credentialEditMessage) credentialEditMessage.textContent = 'Sending secure editing link...';
    try {
      const data = await request('/v1/auth/credentials/request', { method: 'POST' });
      if (credentialEditMessage) credentialEditMessage.textContent = data.message || 'Check your email for the editing link.';
    } catch (error) {
      if (credentialEditMessage) credentialEditMessage.textContent = error.message || 'Unable to send editing link.';
    } finally {
      credentialEditButton.disabled = false;
    }
  });
  logoutButton?.addEventListener('click', () => confirmSignOut(logoutButton));
}

function initBillingPageHandlers() {
  const params = new URLSearchParams(window.location.search);
  const checkoutReference = params.get('reference');
  const demoCheckout = params.get('demo_checkout');
  if (checkoutReference || demoCheckout) {
    const summary = document.querySelector('.billing-summary-card');
    if (summary) {
      const message = document.createElement('p');
      message.className = 'demo-response';
      message.style.marginTop = '0.5rem';
      message.textContent = 'Your checkout is complete. You are back on the billing page.';
      summary.appendChild(message);
    }
  }

  const amountInput = document.getElementById('billingAmountInput');
  const initializeButton = document.getElementById('billingInitializeButton');
  const enterpriseSalesLink = document.getElementById('enterpriseSalesLink');
  const redeemPasskeyButton = document.getElementById('redeemPasskeyButton');
  const passkeyInput = document.getElementById('enterprisePasskeyInput');
  const passkeyVisibilityButton = document.getElementById('toggleEnterprisePasskeyVisibility');
  const passkeyMessage = document.getElementById('enterprisePasskeyMessage');
  const overageOptInCheckbox = document.getElementById('overageOptInCheckbox');
  const saveCardForOverageButton = document.getElementById('saveCardForOverageButton');
  const editOverageLimitsButton = document.getElementById('editOverageLimitsButton');
  const overageLimitsModal = document.getElementById('overageLimitsModal');
  const overageDailyLimitInput = document.getElementById('overageDailyLimitInput');
  const overageMonthlyLimitInput = document.getElementById('overageMonthlyLimitInput');
  const overageLimitsPasswordInput = document.getElementById('overageLimitsPasswordInput');
  const saveOverageLimitsButton = document.getElementById('saveOverageLimitsButton');
  const overageLimitsMessage = document.getElementById('overageLimitsMessage');
  const billingSpendLimits = document.getElementById('billingSpendLimits');
  const modal = document.getElementById('tierOverflowModal');
  const modalTitle = modal?.querySelector('#tierOverflowTitle');
  const modalSubtitle = modal?.querySelector('.modal__subtitle');
  const modalNote = modal?.querySelector('.modal-note');
  const confirmUpgradeButton = document.getElementById('confirmTierUpgradeButton');
  const enterpriseContactForm = document.getElementById('billingEnterpriseContactForm');
  const enterpriseContactMessage = document.getElementById('billingEnterpriseContactMessage');
  const enterpriseRateField = document.getElementById('billingEnterpriseRateField');

  passkeyVisibilityButton?.addEventListener('click', () => {
    if (!passkeyInput) return;
    const isVisible = passkeyInput.type === 'password';
    passkeyInput.type = isVisible ? 'text' : 'password';
    passkeyVisibilityButton.setAttribute('aria-pressed', String(isVisible));
    passkeyVisibilityButton.setAttribute('aria-label', isVisible ? 'Hide passkey' : 'Show passkey');
    const visibleIcon = passkeyVisibilityButton.querySelector('[data-passkey-visible-icon]');
    const hiddenIcon = passkeyVisibilityButton.querySelector('[data-passkey-hidden-icon]');
    if (visibleIcon) visibleIcon.hidden = isVisible;
    if (hiddenIcon) hiddenIcon.hidden = !isVisible;
    passkeyInput.focus();
  });
  const enterpriseRateInput = enterpriseContactForm?.querySelector('[name="rate"]');
  const closeOverageLimitsModal = () => { if (overageLimitsModal) { overageLimitsModal.hidden = true; overageLimitsModal.classList.remove('is-open'); overageLimitsModal.setAttribute('aria-hidden', 'true'); } };
  editOverageLimitsButton?.addEventListener('click', () => { if (!overageLimitsModal) return; overageLimitsModal.hidden = false; overageLimitsModal.classList.add('is-open'); overageLimitsModal.setAttribute('aria-hidden', 'false'); overageLimitsPasswordInput?.focus(); });
  overageLimitsModal?.querySelectorAll('[data-close-overage-modal]').forEach((button) => button.addEventListener('click', closeOverageLimitsModal));
  overageLimitsModal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeOverageLimitsModal();
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      saveOverageLimitsButton?.click();
    }
  });
  saveOverageLimitsButton?.addEventListener('click', async () => {
    const dailyLimit = Number(overageDailyLimitInput?.value);
    const monthlyLimit = Number(overageMonthlyLimitInput?.value);
    const password = overageLimitsPasswordInput?.value || '';
    if (!Number.isFinite(dailyLimit) || !Number.isFinite(monthlyLimit) || dailyLimit < 0 || monthlyLimit < dailyLimit || !password) {
      if (overageLimitsMessage) { overageLimitsMessage.textContent = 'Enter valid limits and your account password. Monthly must be at least daily.'; overageLimitsMessage.className = 'form-status form-status--error'; }
      return;
    }
    saveOverageLimitsButton.disabled = true;
    if (overageLimitsMessage) { overageLimitsMessage.textContent = 'Verifying password and saving...'; overageLimitsMessage.className = 'form-status form-status--loading'; }
    try {
      const wallet = await request('/v1/billing/overage-limits', { method: 'POST', body: JSON.stringify({ daily_limit: dailyLimit, monthly_limit: monthlyLimit, password }) });
      if (billingSpendLimits) billingSpendLimits.textContent = `${formatCurrency(wallet.daily_spend_limit || 0, wallet.currency || 'USD')} daily / ${formatCurrency(wallet.monthly_spend_limit || 0, wallet.currency || 'USD')} monthly`;
      if (overageLimitsMessage) { overageLimitsMessage.textContent = 'Overage limits updated.'; overageLimitsMessage.className = 'form-status form-status--success'; }
      overageLimitsPasswordInput.value = '';
      window.setTimeout(closeOverageLimitsModal, 700);
    } catch (error) {
      const message = error.status === 401 || /wrong password|reauthentication/i.test(error.message || '')
        ? 'Wrong password. Overage limits were not changed.'
        : (error.message || 'Unable to update overage limits.');
      if (overageLimitsMessage) { overageLimitsMessage.textContent = message; overageLimitsMessage.className = 'form-status form-status--error'; }
    } finally { saveOverageLimitsButton.disabled = false; }
  });
  let enterpriseRatePeriod = '';
  const closeButtons = modal ? modal.querySelectorAll('[data-close-modal]') : [];
  let pendingTierName = 'Standard';
  let tierModalConfirmAction = null;

  enterpriseContactForm?.querySelectorAll('[data-rate-period]').forEach((button) => {
    button.addEventListener('click', () => {
      enterpriseRatePeriod = button.getAttribute('data-rate-period') || '';
      enterpriseContactForm.querySelectorAll('[data-rate-period]').forEach((item) => item.classList.toggle('is-selected', item === button));
      enterpriseRateField?.classList.add('is-visible');
      enterpriseRateInput?.setAttribute('required', 'required');
      enterpriseRateInput?.focus();
    });
  });

  enterpriseContactForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!enterpriseRatePeriod) {
      if (enterpriseContactMessage) {
        enterpriseContactMessage.textContent = 'Select RPH, RPD, or RPM before sending your request.';
        enterpriseContactMessage.className = 'form-status form-status--error';
      }
      return;
    }
    if (!enterpriseContactForm.checkValidity()) {
      enterpriseContactForm.reportValidity();
      return;
    }
    const submitButton = enterpriseContactForm.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(enterpriseContactForm).entries());
    payload.rate_period = enterpriseRatePeriod;
    if (enterpriseContactMessage) {
      enterpriseContactMessage.textContent = 'Sending request...';
      enterpriseContactMessage.className = 'form-status form-status--loading';
    }
    if (submitButton) submitButton.disabled = true;
    try {
      const response = await request('/v1/contact', { method: 'POST', body: JSON.stringify(payload) });
      if (enterpriseContactMessage) {
        const requestReference = response.request_id ? ` Reference: ${response.request_id}.` : '';
        enterpriseContactMessage.textContent = `${response.message || 'Request received.'}${requestReference}`;
        enterpriseContactMessage.className = 'form-status form-status--success';
      }
      enterpriseContactForm.reset();
      enterpriseRatePeriod = '';
      enterpriseRateField?.classList.remove('is-visible');
      enterpriseRateInput?.removeAttribute('required');
      enterpriseContactForm.querySelectorAll('[data-rate-period]').forEach((item) => item.classList.remove('is-selected'));
    } catch (error) {
      if (enterpriseContactMessage) {
        enterpriseContactMessage.textContent = error.message || 'Unable to send your request.';
        enterpriseContactMessage.className = 'form-status form-status--error';
      }
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  const syncSelectedTier = () => {
    const currentTier = document.querySelector('.billing-tier-card.is-selected')?.getAttribute('data-tier-name') || 'Standard';
    const selectedTierName = getTierForAmount(Number(amountInput?.value || 0), currentTier).name;
    renderBillingTierCards(selectedTierName);
    updateBillingSelectionSummary(selectedTierName);
    pendingTierName = selectedTierName;
  };

  const submitBillingAmount = async (amountValue, tierName) => {
    const email = document.getElementById('billingEmailInput')?.value?.trim() || 'kieltech75@gmail.com';
    const initializeResponse = await request('/v1/billing/initialize-topup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        amount: Number(amountValue),
        amount_usd: Number(amountValue),
        currency: 'NGN',
        plan_code: 'wallet-topup',
      }),
    });

    if (!initializeResponse.access_code) {
      throw new Error('Paystack did not return a secure checkout session. Please try again or contact support.');
    }

    if (typeof window.PaystackPop !== 'function') {
      throw new Error('Secure card checkout is unavailable. Please refresh the page and try again.');
    }

    const paystack = new window.PaystackPop();
    paystack.resumeTransaction(initializeResponse.access_code);
    showToast(`Secure checkout opened for the ${tierName} tier`);

    const reference = initializeResponse.reference;
    if (reference) {
      void (async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 5000));
          try {
            const verificationResponse = await request('/v1/billing/verify-topup', {
              method: 'POST',
              body: JSON.stringify({ reference }),
            });
            if (verificationResponse.status === 'pending') {
              continue;
            }
            showToast('Payment verified and wallet credited');
            window.location.assign(`billing.html?reference=${encodeURIComponent(reference)}&topup=success`);
            return;
          } catch (error) {
            if (error.status && ![400, 502].includes(error.status)) {
              showToast(error.message || 'Payment verification failed.');
              return;
            }
          }
        }
        showToast('Payment is still pending. Your wallet will update after Paystack confirms the transaction.');
      })();
    }
  };

  const getSelectedTierName = () => document.querySelector('.billing-tier-card.is-selected')?.getAttribute('data-tier-name') || 'Standard';

  const openTierValidationModal = ({ title, subtitle, note, confirmText, onConfirm }) => {
    if (!modal || !modalTitle || !modalSubtitle || !modalNote || !confirmUpgradeButton) return;
    modalTitle.textContent = title;
    modalSubtitle.textContent = subtitle;
    modalNote.textContent = note;
    confirmUpgradeButton.textContent = confirmText;
    tierModalConfirmAction = onConfirm;
    openTierOverflowModal();
  };

  closeButtons.forEach((button) => {
    button.addEventListener('click', closeTierOverflowModal);
  });

  confirmUpgradeButton?.addEventListener('click', async () => {
    if (typeof tierModalConfirmAction === 'function') {
      try {
        await tierModalConfirmAction();
      } catch (error) {
        showToast(error.message);
      }
    }
    closeTierOverflowModal();
    tierModalConfirmAction = null;
  });

  initializeButton?.addEventListener('click', async () => {
    initializeButton.disabled = true;
    initializeButton.textContent = 'Validating tier...';
    try {
      if (!amountInput || !amountInput.checkValidity()) {
        amountInput?.reportValidity();
        return;
      }
      const amountValue = Number(amountInput?.value || 0);
      const selectedTierName = getSelectedTierName();
      const expectedTier = getTierForAmount(amountValue, selectedTierName);

      if (expectedTier.name !== selectedTierName) {
        const tierDefinitions = getTierDefinitions();
        const selectedTier = tierDefinitions.find((tier) => tier.name === selectedTierName) || tierDefinitions[0];
        const nextTier = tierDefinitions.find((tier) => tier.name === expectedTier.name);
        const selectedRange = selectedTier.max === null ? `${selectedTier.min}+` : `${selectedTier.min} - ${selectedTier.max}`;
        openTierValidationModal({
          title: 'Amount does not match selected tier',
          subtitle: `Your entered amount is best suited for the ${expectedTier.name} tier.`,
          note: nextTier
            ? `The ${selectedTierName} tier accepts $${selectedRange}. Choose ${expectedTier.name} to continue with $${amountValue}, or adjust your amount to stay within the ${selectedTierName} tier.`
            : `The ${selectedTierName} tier accepts $${selectedRange}. Adjust your amount to stay within that range or choose a different tier.`,
          confirmText: `Use ${expectedTier.name} tier`,
          onConfirm: async () => {
            renderBillingTierCards(expectedTier.name);
            updateBillingSelectionSummary(expectedTier.name);
            await submitBillingAmount(amountValue, expectedTier.name);
          },
        });
      } else {
        await submitBillingAmount(amountValue, selectedTierName);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      initializeButton.disabled = false;
      initializeButton.textContent = 'Continue to secure checkout';
    }
  });

  amountInput?.addEventListener('input', syncSelectedTier);
  syncSelectedTier();

  saveCardForOverageButton?.addEventListener('click', () => {
    const enabled = overageOptInCheckbox?.checked;
    if (!enabled) {
      const overagePolicyMessage = document.getElementById('overagePolicyMessage');
      if (overagePolicyMessage) {
        overagePolicyMessage.textContent = 'Confirm that you want to continue to card setup for possible overage use.';
        overagePolicyMessage.className = 'form-status form-status--error';
      }
      return;
    }

    saveCardForOverageButton.disabled = true;
    saveCardForOverageButton.textContent = 'Redirecting...';
    const email = document.getElementById('billingEmailInput')?.value?.trim() || 'kieltech75@gmail.com';
    const target = new URL('settings.html', window.location.origin);
    target.searchParams.set('focus', 'overage');
    if (email) {
      target.searchParams.set('email', email);
    }
    window.location.href = target.toString();
  });

  redeemPasskeyButton?.addEventListener('click', async () => {
    const passkey = passkeyInput?.value?.trim();
    if (!passkey) {
      setFormMessage(passkeyMessage, 'Please enter a passkey first.', 'error');
      return;
    }

    redeemPasskeyButton.disabled = true;
    const redeemLabel = redeemPasskeyButton.querySelector('span:not([aria-hidden])');
    if (redeemLabel) redeemLabel.textContent = 'Redeeming...';
    setFormMessage(passkeyMessage, 'Redeeming your enterprise passkey...', 'loading');

    try {
      const result = await request('/api/billing/redeem-passkey', {
        method: 'POST',
        body: JSON.stringify({ passkey })
      });
      const successMessage = result.runpod_proxy_url
        ? `Enterprise access enabled. Mock GPU endpoint ready at ${result.runpod_proxy_url}`
        : (result.message || 'Enterprise access enabled.');
      setFormMessage(passkeyMessage, successMessage, 'success');
      showToast(result.runpod_proxy_url ? 'Enterprise passkey redeemed successfully with mock GPU provisioning' : 'Enterprise passkey redeemed successfully');
      window.location.href = 'dashboard.html';
    } catch (error) {
      setFormMessage(passkeyMessage, error.message, 'error');
    } finally {
      redeemPasskeyButton.disabled = false;
      if (redeemLabel) redeemLabel.textContent = 'Redeem passkey';
    }
  });

  passkeyInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !redeemPasskeyButton?.disabled) {
      event.preventDefault();
      redeemPasskeyButton?.click();
    }
  });
}

function initDashboardContent() {
  const dashboardPanel = document.getElementById('dashboardPanel');
  if (!dashboardPanel) return;

  if (!state.token) {
    dashboardPanel.innerHTML = '<div class="dashboard-list"><div class="dashboard-item"><div><strong>Access required</strong><p class="demo-response">Please log in to view your product activity.</p></div><a class="btn btn-primary" href="login.html">Log in</a></div></div>';
    return;
  }

  dashboardPanel.innerHTML = '<p class="demo-response">Loading your dashboard...</p>';
  request('/v1/auth/me').then(async (profile) => {
    const downloadsData = await request('/v1/downloads').catch(() => ({ downloads: [] }));
    const reviewsData = await request('/v1/ratings').catch(() => ({ ratings: [] }));
    const [wallet, usage] = await Promise.all([
      request(`/v1/billing/wallet?email=${encodeURIComponent(profile.user.email)}`),
      request(`/v1/billing/usage?email=${encodeURIComponent(profile.user.email)}`),
    ]);
    const userReviews = reviewsData.ratings.filter((item) => String(item.user_id) === String(profile.user.id));
    const recentDownloads = downloadsData.downloads.slice(0, 3);
    const tierInfo = getRateLimitTier(wallet.balance || 0, wallet.account_status || 'free_tier');
    const requestsMetricValue = document.getElementById('requestsMetricValue');
    const rpmMetricValue = document.getElementById('rpmMetricValue');
    const walletMetricValue = document.getElementById('walletMetricValue');
    const planStatusBadge = document.getElementById('planStatusBadge');
    const modelCatalogData = await request('/v1/models/catalog', { cache: 'no-store' });
    const quotaModels = Array.isArray(modelCatalogData.models) ? modelCatalogData.models : [];
    const modelQuotaRows = quotaModels.map((model) => {
      const modelKey = model.model_id;
      const entry = wallet.equivalency?.[modelKey];
      if (!entry) return `<div class="quota-row"><span>${escapeHtml(model.display_name || modelKey)}</span><strong>Usage estimate unavailable</strong></div>`;
      const value = Number(entry.value || 0);
      const unit = entry.label || 'units';
      return `<div class="quota-row"><span>${escapeHtml(model.display_name || modelKey)}</span><strong>${value.toLocaleString()} ${unit}</strong></div>`;
    }).join('');
    const walletSummaryRows = quotaModels.map((model) => {
      const modelKey = model.model_id;
      const entry = wallet.equivalency?.[modelKey];
      if (!entry) return `<div class="quota-row"><span>${escapeHtml(model.display_name || modelKey)}</span><strong>Usage estimate unavailable</strong></div>`;
      const value = Number(entry.value || 0);
      const unit = entry.label || 'units';
      return `<div class="quota-row"><span>${escapeHtml(model.display_name || modelKey)}</span><strong>${value.toLocaleString()} ${unit}</strong></div>`;
    }).join('');

    if (requestsMetricValue) {
      requestsMetricValue.textContent = `${Number(usage.current_usage || 0).toLocaleString()} / ${Number(usage.included_limit || 1000).toLocaleString()}`;
    }
    if (rpmMetricValue) {
      rpmMetricValue.textContent = `${Number(tierInfo.rpm || 0).toLocaleString()} RPM`;
    }
    if (walletMetricValue) {
      walletMetricValue.textContent = `${formatCurrency(wallet.balance || 0)} ${wallet.currency || 'USD'}`;
    }
    if (planStatusBadge) {
      planStatusBadge.textContent = tierInfo.name;
      planStatusBadge.className = `status-pill ${tierInfo.name === 'Ultra' ? 'status-pill--active' : 'status-pill--info'}`;
    }

    dashboardPanel.innerHTML = `
      <div class="dashboard-list">
        <div class="dashboard-item">
          <div>
            <strong>${profile.user.name}</strong>
            <p class="demo-response">${profile.user.email}</p>
          </div>
          <span class="hero-badge">${profile.user.role === 'owner' ? 'Owner' : profile.user.is_admin ? 'Admin' : 'Member'}</span>
        </div>
        <div class="dashboard-item">
          <div>
            <strong>Recent downloads</strong>
            <p class="demo-response">${recentDownloads.length ? recentDownloads.map((item) => item.title).join(', ') : 'No downloads yet'}</p>
          </div>
          <a class="btn btn-secondary" href="downloads.html">Browse products</a>
        </div>
        <div class="dashboard-item">
          <div>
            <strong>Wallet balance</strong>
            <p class="demo-response">${formatCurrency(wallet.balance || 0)} ${wallet.currency || 'USD'} available for AI usage.</p>
            <p class="demo-response">Credit status is sourced from the authenticated billing account.</p>
            <div class="quota-stack">
              <div class="quota-stack__header">Model usage remaining</div>
              <div class="quota-stack__body">${walletSummaryRows}</div>
            </div>
          </div>
          <span class="hero-badge">${(wallet.transactions || []).length ? 'Active' : 'Ready'}</span>
        </div>
        <div class="dashboard-item">
          <div>
            <strong>Models quota</strong>
            <div class="quota-stack">
              <div class="quota-stack__body">${modelQuotaRows}</div>
            </div>
          </div>
        </div>
        <div class="dashboard-item">
          <div>
            <strong>Reviews</strong>
            <p class="demo-response">${userReviews.length ? userReviews.map((item) => `Rated ${item.rating}/5`).join(' • ') : 'No reviews submitted yet'}</p>
          </div>
          <a class="btn btn-secondary" href="downloads.html">Leave a review</a>
        </div>
      </div>
    `;
  }).catch((error) => {
    dashboardPanel.innerHTML = `<p class="demo-response">${error.message}</p>`;
  });
}

function initApiAccessForm() {
  const form = document.getElementById('apiAccessForm');
  const message = document.getElementById('apiAccessMessage');
  if (!form || !message) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    message.textContent = 'Submitting your request...';
    message.className = 'form-status is-loading';
    try {
      const data = await request('/v1/api-access', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      message.textContent = data.message || 'Request received. We will follow up shortly.';
      message.className = 'form-status is-success';
      form.reset();
    } catch (error) {
      message.textContent = error.message;
      message.className = 'form-status is-error';
    }
  });
}

async function renderHumanInstallers() {
  const container = document.getElementById('humanInstallerActions');
  if (!container) return;

  try {
    const downloadsData = await request('/v1/downloads');
    const humanInstallers = (downloadsData.downloads || []).filter((download) => {
      const title = (download.title || '').toLowerCase();
      return title.includes('human language') && (title.includes('32-bit') || title.includes('64-bit'));
    });

    if (!humanInstallers.length) {
      container.innerHTML = '<p class="release-empty">Installers are currently unavailable.</p>';
      return;
    }

    const rows = humanInstallers.map((download) => {
      const title = (download.title || '').toLowerCase();
      const arch = title.includes('64-bit') ? '64-bit' : title.includes('32-bit') ? '32-bit' : '';
      const versionLabel = arch ? `Human Language v0.1.8 (${arch})` : 'Human Language v0.1.8';
      const releaseNotesHref = 'human/releases.html';
      const releaseStatus = arch ? 'Latest release' : 'Stable release';
      const releaseDate = download.created_at ? new Date(download.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) : 'Latest release';

      return `
        <li class="release-row">
          <div class="release-row__main">
            <a class="release-link" href="${releaseNotesHref}">${versionLabel}</a>
            <span class="release-meta">— ${releaseStatus}</span>
          </div>
          <div class="release-actions">
            <a class="release-action" href="#" data-download-id="${download.id}">Download</a>
            <a class="release-action secondary" href="${releaseNotesHref}">Release notes</a>
          </div>
        </li>
      `;
    }).join('');

    container.innerHTML = `
      <ul class="release-list__items">
        ${rows}
      </ul>
    `;

    container.querySelectorAll('[data-download-id]').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const id = link.getAttribute('data-download-id');
        const originalText = link.textContent;
        link.textContent = 'Starting...';
        try {
          const data = await request(`/v1/downloads/${id}`, { method: 'POST' });
          const fileUrl = `${getApiBaseUrl()}${data.download.file_url}`;
          window.location.href = fileUrl;
          link.textContent = originalText;
        } catch (error) {
          link.textContent = originalText;
          link.setAttribute('title', error.message);
        }
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="release-empty">${error.message}</p>`;
  }
}

let dashboardUsageDays = 30;

const formatDashboardDate = (value, options = { month: 'short', day: 'numeric' }) => {
  if (!value) return 'No activity yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString([], options);
};

const formatDashboardDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const formatDashboardCost = (value) => `$${Number(value || 0).toFixed(6)}`;

const formatDashboardCurrency = (value, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

async function renderDashboardCards() {
  const container = document.getElementById('dashboardContent');
  if (!container) return;

  if (!container.dataset.refreshing) {
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = '<div class="dashboard-loading-state" role="status"><span class="dashboard-loading-state__spinner" aria-hidden="true"></span><span>Loading your developer console...</span></div>';
  }

  try {
    const profile = await request('/v1/auth/me');
    const walletEmail = profile?.user?.email;
    if (!walletEmail) throw new Error('Your session is not available. Please sign in again.');
    const [wallet, modelUsage, catalog] = await Promise.all([
      request(`/v1/billing/wallet?email=${encodeURIComponent(walletEmail)}`),
      request(`/v1/dashboard/model-usage?days=${dashboardUsageDays}`),
      request('/v1/models/catalog'),
    ]);

    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const usageByModel = new Map((modelUsage.models || []).map((item) => [String(item.model_id).toLowerCase(), item]));
    const maxRequests = Math.max(1, ...models.map((model) => usageByModel.get(String(model.model_id).toLowerCase())?.requests || 0));
    const totalRequests = Number(modelUsage.totals?.requests || 0);
    const modelRows = models.map((model) => {
      const modelId = String(model.model_id || '');
      const tracked = usageByModel.get(modelId.toLowerCase()) || {};
      const ready = model.is_ready === true && model.is_configured === true;
      const displayName = model.display_name || modelId;
      const share = totalRequests ? Math.round((Number(tracked.requests || 0) / totalRequests) * 100) : 0;
      const barWidth = Math.round((Number(tracked.requests || 0) / maxRequests) * 100);
      return `
        <tr data-dashboard-model-row data-model-search="${escapeHtml(`${displayName} ${modelId} ${model.category || ''}`.toLowerCase())}">
          <td><div class="dashboard-tracked-model"><strong>${escapeHtml(displayName)}</strong><code>${escapeHtml(modelId)}</code></div></td>
          <td><span class="dashboard-category-tag">${escapeHtml((model.category || 'model').replaceAll('-', ' '))}</span></td>
          <td><span class="dashboard-availability ${ready ? 'is-ready' : 'is-pending'}"><i aria-hidden="true"></i>${ready ? 'Available' : 'Unavailable'}</span></td>
          <td><div class="dashboard-request-metric"><strong>${Number(tracked.requests || 0).toLocaleString()}</strong><span>${share}% of tracked requests</span><div class="dashboard-request-meter" role="meter" aria-label="${escapeHtml(displayName)} request volume" aria-valuemin="0" aria-valuemax="${maxRequests}" aria-valuenow="${Number(tracked.requests || 0)}"><i style="width:${barWidth}%"></i></div></div></td>
          <td>${Number(tracked.total_tokens || 0).toLocaleString()}</td>
          <td>${formatDashboardCost(tracked.cost_usd)}</td>
          <td>${formatDashboardDate(tracked.last_used_at)}</td>
        </tr>
      `;
    }).join('');
    const dailyMap = new Map((modelUsage.daily || []).map((item) => [item.date, item]));
    const chartDays = Array.from({ length: dashboardUsageDays }, (_, index) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - dashboardUsageDays + index + 1);
      const key = date.toISOString().slice(0, 10);
      return dailyMap.get(key) || { date: key, requests: 0 };
    });
    const maxDailyRequests = Math.max(1, ...chartDays.map((day) => Number(day.requests || 0)));
    const activityBars = chartDays.map((day) => {
      const count = Number(day.requests || 0);
      const height = count ? Math.max(5, Math.round((count / maxDailyRequests) * 100)) : 2;
      return `<div class="dashboard-activity-bar" title="${escapeHtml(formatDashboardDate(day.date, { weekday: 'short', month: 'short', day: 'numeric' }))}: ${count.toLocaleString()} requests"><i style="height:${height}%"></i></div>`;
    }).join('');
    const recentRows = (modelUsage.recent || []).map((item) => {
      const displayModel = models.find((model) => String(model.model_id).toLowerCase() === String(item.model_id).toLowerCase())?.display_name || item.model_id;
      const successful = Number(item.status_code) < 400;
      return `<tr>
        <td><strong>${escapeHtml(displayModel)}</strong><small>${escapeHtml(item.endpoint || 'API request')}</small></td>
        <td><time datetime="${escapeHtml(item.requested_at || '')}">${escapeHtml(formatDashboardDateTime(item.requested_at))}</time></td>
        <td>${Number(item.total_tokens || 0).toLocaleString()}</td>
        <td>${formatDashboardCost(item.cost_usd)}</td>
        <td><span class="dashboard-result-tag ${successful ? 'is-success' : 'is-error'}">${successful ? 'Succeeded' : `Failed (${Number(item.status_code) || '—'})`}</span></td>
      </tr>`;
    }).join('');
    const refreshedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    container.dataset.refreshing = 'false';
    container.setAttribute('aria-busy', 'false');
    container.classList.remove('is-refreshing');
    container.innerHTML = `
      <section class="dashboard-console-header dashboard-console-card">
        <div><div class="dashboard-console-kicker"><span class="dashboard-console-kicker__dot" aria-hidden="true"></span><p class="eyebrow">Developer console</p><span>Live workspace</span></div><h2>Welcome back, ${escapeHtml(profile.user.username || profile.user.name || walletEmail)}</h2><p>Monitor API activity, model performance, and spend across your KielTech workspace.</p></div>
        <div class="dashboard-console-actions"><button class="btn btn-secondary" type="button" data-dashboard-refresh>Refresh data</button><a class="btn btn-primary" href="tokens.html?create=1">Create API key</a><a class="btn btn-secondary" href="api-integration.html#documentation">Read API docs</a></div>
      </section>
      <section class="dashboard-card-grid dashboard-console-card-group">
        <article class="dashboard-balance-card dashboard-balance-card--hero">
          <div class="dashboard-status-row"><p class="eyebrow">Wallet balance</p><span class="dashboard-sync-pill" data-state="synced">Synced · ${escapeHtml(refreshedAt)}</span></div>
          <h2>${formatDashboardCurrency(wallet.balance, wallet.currency || 'USD')}</h2>
          <p>Available balance for eligible model requests.</p>
          <div class="dashboard-balance-card__meta"><span>Free credit <strong>${formatDashboardCurrency(wallet.free_credit_balance, wallet.currency || 'USD')}</strong></span><span>Paid balance <strong>${formatDashboardCurrency(wallet.paid_balance, wallet.currency || 'USD')}</strong></span></div>
        </article>
        <article class="dashboard-balance-card dashboard-account-card">
          <div class="dashboard-status-row"><p class="eyebrow">Account</p><span class="dashboard-account-status"><i aria-hidden="true"></i>Verified</span></div>
          <h3>${escapeHtml(profile.user.email)}</h3>
          <p class="dashboard-model-card__note">Developer account with authenticated API access.</p>
          <a class="dashboard-account-link" href="settings.html">Manage account <span aria-hidden="true">→</span></a>
        </article>
      </section>
      <section class="dashboard-usage-section dashboard-console-card-group" aria-labelledby="dashboardUsageTitle">
        <div class="dashboard-section-heading dashboard-usage-heading"><div><p class="eyebrow">Usage analytics</p><h2 id="dashboardUsageTitle">Model usage</h2><p>Actual API requests and token consumption from your account.</p></div>
          <label class="dashboard-period-control">Period<select data-dashboard-period aria-label="Usage reporting period"><option value="7" ${dashboardUsageDays === 7 ? 'selected' : ''}>Last 7 days</option><option value="30" ${dashboardUsageDays === 30 ? 'selected' : ''}>Last 30 days</option><option value="90" ${dashboardUsageDays === 90 ? 'selected' : ''}>Last 90 days</option></select></label>
        </div>
        <div class="dashboard-usage-summary" aria-label="Usage totals for the last ${dashboardUsageDays} days">
          <article><span>API requests</span><strong>${totalRequests.toLocaleString()}</strong><small>Across all models</small></article>
          <article><span>Tokens processed</span><strong>${Number(modelUsage.totals?.total_tokens || 0).toLocaleString()}</strong><small>Input and output</small></article>
          <article><span>Tracked spend</span><strong>${formatDashboardCost(modelUsage.totals?.cost_usd)}</strong><small>Recorded API charges</small></article>
          <article><span>Failed requests</span><strong>${Number(modelUsage.all_time_failed_requests || 0).toLocaleString()}</strong><small>All-time errors across your account</small></article>
        </div>
        <div class="dashboard-usage-chart">
          <div class="dashboard-chart-heading"><div><h3>Request activity</h3><p>Daily API requests · ${dashboardUsageDays}-day view</p></div><span class="dashboard-chart-legend"><i aria-hidden="true"></i>Requests</span></div>
          <div class="dashboard-activity-chart" role="img" aria-label="Daily request activity for the last ${dashboardUsageDays} days">${activityBars}</div>
          <div class="dashboard-chart-axis"><span>${escapeHtml(formatDashboardDate(chartDays[0]?.date))}</span><span>Today</span></div>
        </div>
      </section>
      <section class="dashboard-models-section dashboard-model-inventory dashboard-console-card-group">
        <div class="dashboard-section-heading dashboard-models-heading"><div><p class="eyebrow">Model inventory</p><h2>Models &amp; usage</h2><p>${models.length} active models from the live model catalog. Usage is shown for the selected period.</p></div><label class="dashboard-model-search"><span class="dashboard-visually-hidden">Search models</span><input type="search" data-dashboard-model-search placeholder="Search models"></label></div>
        <div class="dashboard-table-wrap"><table class="dashboard-usage-table"><thead><tr><th scope="col">Model</th><th scope="col">Category</th><th scope="col">Availability</th><th scope="col">Requests</th><th scope="col">Tokens</th><th scope="col">Spend</th><th scope="col">Last used</th></tr></thead><tbody data-dashboard-model-rows>${modelRows || '<tr><td class="dashboard-table-empty" colspan="7">No active models are currently listed in the catalog.</td></tr>'}</tbody></table></div>
      </section>
      <section class="dashboard-models-section dashboard-console-card-group">
        <div class="dashboard-section-heading"><div><p class="eyebrow">Request log</p><h2>Recent API activity</h2><p>Latest tracked requests in the selected period.</p></div></div>
        <div class="dashboard-table-wrap"><table class="dashboard-usage-table dashboard-recent-table"><thead><tr><th scope="col">Model &amp; endpoint</th><th scope="col">Time</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Result</th></tr></thead><tbody>${recentRows || '<tr><td class="dashboard-table-empty" colspan="5">No API activity has been recorded during this period yet.</td></tr>'}</tbody></table></div>
      </section>
      <div class="dashboard-console-links"><a href="api-integration.html#playground">Test the API <small>Authenticated playground</small></a><a href="status.html">System status <small>Platform health and updates</small></a><a href="contact.html">Get support <small>Sales, billing, and security</small></a></div>
    `;

    container.querySelector('[data-dashboard-period]')?.addEventListener('change', (event) => {
      dashboardUsageDays = Number(event.currentTarget.value);
      container.dataset.refreshing = 'true';
      container.classList.add('is-refreshing');
      renderDashboardCards();
    });
    container.querySelector('[data-dashboard-refresh]')?.addEventListener('click', () => window.__kieltechRefreshDashboard?.());
    container.querySelector('[data-dashboard-model-search]')?.addEventListener('input', (event) => {
      const query = event.currentTarget.value.trim().toLocaleLowerCase();
      container.querySelectorAll('[data-dashboard-model-row]').forEach((row) => {
        row.hidden = !row.dataset.modelSearch.includes(query);
      });
    });

    if (window.__kieltechDashboardRefreshTimer) window.clearInterval(window.__kieltechDashboardRefreshTimer);
    const refreshDashboard = () => {
      container.dataset.refreshing = 'true';
      container.classList.add('is-refreshing');
      const syncPill = container.querySelector('.dashboard-sync-pill');
      if (syncPill) {
        syncPill.setAttribute('data-state', 'updating');
        syncPill.innerHTML = '<span class="dashboard-sync-pill__spinner" aria-hidden="true"></span>Updating…';
      }
      renderDashboardCards();
    };
    window.__kieltechDashboardRefreshTimer = window.setInterval(refreshDashboard, 30000);
    if (window.__kieltechDashboardFocusRefresh) {
      window.removeEventListener('focus', window.__kieltechDashboardFocusRefresh);
    }
    window.__kieltechDashboardFocusRefresh = refreshDashboard;
    window.addEventListener('focus', refreshDashboard);
    window.__kieltechRefreshDashboard = refreshDashboard;
  } catch (error) {
    const requiresLogin = /authentication|required|session|sign.?in/i.test(error.message || '');
    container.dataset.refreshing = 'false';
    container.classList.remove('is-refreshing');
    container.setAttribute('aria-busy', 'false');
    container.innerHTML = requiresLogin
      ? '<div class="card dashboard-empty-state"><h2>Sign in to open your developer console</h2><p>Manage your API keys, live usage, and billing after signing in.</p><a class="btn btn-primary" href="login.html?return_to=dashboard.html">Sign in</a></div>'
      : `<div class="dashboard-empty-state"><span class="dashboard-empty-state__icon" aria-hidden="true">!</span><h2>Dashboard data is temporarily unavailable</h2><p>${escapeHtml(error.message || 'Unable to load dashboard data')}</p><button class="btn btn-secondary" type="button" data-dashboard-retry>Try again</button></div>`;
    container.querySelector('[data-dashboard-retry]')?.addEventListener('click', () => renderDashboardCards());
  }
}

function initAdminSidebar() {
  const sidebar = document.getElementById('adminSidebar');
  const backdrop = document.getElementById('adminSidebarBackdrop');
  const toggleButton = document.getElementById('sidebarToggleButton');
  if (!sidebar || !toggleButton) {
    return;
  }

  const openSidebar = () => {
    sidebar.classList.add('is-open');
    backdrop?.classList.add('is-visible');
    toggleButton.setAttribute('aria-expanded', 'true');
  };

  const closeSidebar = () => {
    sidebar.classList.remove('is-open');
    backdrop?.classList.remove('is-visible');
    toggleButton.setAttribute('aria-expanded', 'false');
  };

  toggleButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (sidebar.classList.contains('is-open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  backdrop?.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('[data-nav-target]').forEach((link) => {
    link.addEventListener('click', () => {
      const target = link.getAttribute('data-nav-target');
      if (target) {
        window.location.assign(target);
      }
      closeSidebar();
    });
  });

  sidebar.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      closeSidebar();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSidebar();
    }
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadAdminUsers() {
  const apiBase = getApiBaseUrl();
  const response = await fetch(`${apiBase}/admin/users`, {
    credentials: 'include'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || 'Unable to fetch admin users');
  }
  return Array.isArray(payload.users) ? payload.users : [];
}

async function initAdminCustomersPage() {
  const customerSearch = document.getElementById('customerSearch');
  const customerSearchClear = document.getElementById('customerSearchClear');
  const customerList = document.getElementById('customerList');
  const customerListCount = document.getElementById('customerListCount');
  const enterpriseCustomerList = document.getElementById('enterpriseCustomerList');
  const enterpriseCustomerListCount = document.getElementById('enterpriseCustomerListCount');
  if (!customerSearch || !customerList) {
    return;
  }

  let users = [];
  let selectedEmail = '';
  const pathSegments = window.location.pathname.split('/').filter(Boolean);
  const requestedEmail = pathSegments[pathSegments.length - 1];
  if (requestedEmail && requestedEmail !== 'customers') {
    selectedEmail = decodeURIComponent(requestedEmail);
  }

  const render = () => {
    const query = customerSearch.value.trim().toLowerCase();
    const matchesSearch = (user) => {
      const haystack = `${user.name || ''} ${user.email || ''}`.toLowerCase();
      return !query || haystack.includes(query);
    };
    const filtered = users.filter(matchesSearch);
    const enterpriseUsers = users.filter((user) => Boolean(user.is_enterprise_dedicated) && matchesSearch(user));

    if (customerListCount) {
      customerListCount.textContent = query ? `${filtered.length} of ${users.length}` : `${filtered.length} total`;
    }
    if (enterpriseCustomerListCount) {
      const enterpriseTotal = users.filter((user) => Boolean(user.is_enterprise_dedicated)).length;
      enterpriseCustomerListCount.textContent = query ? `${enterpriseUsers.length} of ${enterpriseTotal}` : `${enterpriseTotal} total`;
    }
    if (customerSearchClear) {
      customerSearchClear.hidden = !query;
    }

    const renderRows = (list, rows) => {
      if (!list) return;
      list.innerHTML = rows.length
      ? rows.map((user) => `
        <div class="customer-list-entry">
          <div class="user-item">
            <div class="customer-identity">
              <span class="customer-avatar">${escapeHtml((user.name || user.email || 'C').trim().charAt(0))}</span>
              <div>
              <strong>${escapeHtml(user.name || user.email || 'Customer')}</strong>
              <a href="/admin/customers/${encodeURIComponent(user.email || '')}">${escapeHtml(user.email || '')}</a>
              </div>
            </div>
            <button class="customer-view-button" type="button" data-user-email="${escapeHtml(user.email || '')}">View</button>
          </div>
        </div>
      `).join('')
      : '<div class="detail-card">No users matched the current search.</div>';

    list.querySelectorAll('[data-user-email]').forEach((button) => {
      button.addEventListener('click', () => {
        const email = button.getAttribute('data-user-email');
        if (!email) return;
        window.location.href = `/admin/customers/${encodeURIComponent(email)}`;
      });
    });
    };
    renderRows(customerList, filtered);
    renderRows(enterpriseCustomerList, enterpriseUsers);
  };

  const loadCustomerDetail = async (email, inlineDetail = null) => {
    selectedEmail = email;
    if (!inlineDetail) customerDetail.innerHTML = '<div class="detail-card">Loading live customer details…</div>';
    try {
      const response = await fetch(`${getApiBaseUrl()}/admin/users/${encodeURIComponent(email)}`, {
        credentials: 'include'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || 'Unable to load customer details');
      }
      const user = payload.user || {};
      const detailMarkup = `
        <div class="detail-card customer-inline-detail-card">
          <div class="detail-card__meta">
            <span class="status-pill ${user.is_blocked ? 'status-pill--muted' : 'status-pill--success'}">${user.is_blocked ? 'Blocked' : 'Active'}</span>
            <span>${escapeHtml(user.is_enterprise_dedicated ? 'Enterprise' : 'Standard')}</span>
          </div>
          <h3 style="margin:0;">${escapeHtml(user.name || user.email || 'Customer profile')}</h3>
          <p style="margin:0;">${escapeHtml(user.email || '')}</p>
          <div class="detail-card__meta">
            <span>Wallet: ${escapeHtml(user.wallet_balance ?? 0)} ${escapeHtml(user.wallet_currency || 'USD')}</span>
            <span>Usage: ${escapeHtml(user.usage_current ?? 0)}</span>
          </div>
          <button class="btn btn-primary" id="toggleBlockButton" type="button">${user.is_blocked ? 'Unblock Account' : 'Block Account'}</button>
        </div>`;
      if (inlineDetail) {
        inlineDetail.innerHTML = detailMarkup;
      } else {
        customerDetail.innerHTML = detailMarkup;
      }

      (inlineDetail || customerDetail).querySelector('#toggleBlockButton')?.addEventListener('click', async () => {
        try {
          const updateResponse = await fetch(`${getApiBaseUrl()}/admin/users/${encodeURIComponent(email)}/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'kieltech2009$' },
            body: JSON.stringify({ blocked: !user.is_blocked })
          });
          const updatePayload = await updateResponse.json().catch(() => ({}));
          if (!updateResponse.ok) {
            throw new Error(updatePayload.detail || 'Unable to update account state');
          }
          await loadCustomerDetail(email, inlineDetail);
        } catch (error) {
          const target = inlineDetail || customerDetail;
          target.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to update account state')}</div>`;
        }
      });
    } catch (error) {
      const target = inlineDetail || customerDetail;
      target.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to load customer details')}</div>`;
    }
  };

  try {
    users = await loadAdminUsers();
    render();
    customerSearch.addEventListener('input', render);
    customerSearchClear?.addEventListener('click', () => {
      customerSearch.value = '';
      customerSearch.focus();
      render();
    });
  } catch (error) {
    customerList.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to load customers')}</div>`;
  }
}

async function initAdminEnterprisePage() {
  const enterpriseSearch = document.getElementById('enterpriseSearch');
  const enterpriseList = document.getElementById('enterpriseList');
  const enterpriseDetail = document.getElementById('enterpriseDetail');
  if (!enterpriseSearch || !enterpriseList || !enterpriseDetail) {
    return;
  }

  let users = [];
  const render = () => {
    const query = enterpriseSearch.value.trim().toLowerCase();
    const filtered = users.filter((user) => {
      const haystack = `${user.name || ''} ${user.email || ''}`.toLowerCase();
      return !query || haystack.includes(query);
    });

    enterpriseList.innerHTML = filtered.length
      ? filtered.map((user) => `
        <div class="enterprise-item">
          <div>
            <strong>${escapeHtml(user.name || user.email || 'Enterprise user')}</strong>
            <div class="detail-card__meta">${escapeHtml(user.email || '')}</div>
          </div>
          <button type="button" data-enterprise-email="${escapeHtml(user.email || '')}">View</button>
        </div>
      `).join('')
      : '<div class="detail-card">No enterprise users matched the current search.</div>';

    enterpriseList.querySelectorAll('[data-enterprise-email]').forEach((button) => {
      button.addEventListener('click', async () => {
        const email = button.getAttribute('data-enterprise-email');
        if (!email) return;
        try {
          const response = await fetch(`${getApiBaseUrl()}/admin/users/${encodeURIComponent(email)}`, {
            headers: { 'X-Admin-Secret': 'kieltech2009$' }
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.detail || 'Unable to load enterprise details');
          }
          const user = payload.user || {};
          enterpriseDetail.innerHTML = `
            <div class="detail-card">
              <div class="detail-card__meta">
                <span class="status-pill status-pill--success">Active</span>
                <span>${escapeHtml(user.gpu_model || 'GPU model pending')}</span>
              </div>
              <h3 style="margin:0;">${escapeHtml(user.name || user.email || 'Enterprise user')}</h3>
              <p style="margin:0;">${escapeHtml(user.email || '')}</p>
              <div class="detail-card__meta">
                <span>Enterprise plan: ${escapeHtml(user.enterprise_rpm_limit || 'Dedicated')}</span>
                <span>Wallet: ${escapeHtml(user.wallet_balance ?? 0)} ${escapeHtml(user.wallet_currency || 'USD')}</span>
              </div>
              <div class="detail-card__meta">
                <span>Usage: ${escapeHtml(user.usage_current ?? 0)} requests</span>
                <span>Expires: ${escapeHtml(user.enterprise_expires_at || 'Ongoing')}</span>
              </div>
            </div>
          `;
        } catch (error) {
          enterpriseDetail.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to load enterprise details')}</div>`;
        }
      });
    });
  };

  try {
    users = (await loadAdminUsers()).filter((user) => user.is_enterprise_dedicated);
    render();
    enterpriseSearch.addEventListener('input', render);
  } catch (error) {
    enterpriseList.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to load enterprise users')}</div>`;
  }
}

async function initAdminEmailPage() {
  const emailScope = document.getElementById('emailScope');
  const emailSubject = document.getElementById('emailSubject');
  const emailMessage = document.getElementById('emailMessage');
  const sendEmailButton = document.getElementById('sendEmailButton');
  const emailResult = document.getElementById('emailResult');
  const audienceSummary = document.getElementById('emailAudienceSummary');
  const scopeButtons = document.querySelectorAll('[data-scope]');
  if (!emailScope || !emailSubject || !emailMessage || !sendEmailButton || !emailResult || !audienceSummary) {
    return;
  }

  const renderAudienceSummary = async () => {
    const scope = emailScope.value;
    try {
      const response = await fetch(`${getApiBaseUrl()}/admin/users`, {
        headers: { 'X-Admin-Secret': 'kieltech2009$' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || 'Unable to load audience');
      }
      const users = Array.isArray(payload.users) ? payload.users : [];
      const recipients = scope === 'enterprise'
        ? users.filter((user) => user.is_enterprise_dedicated)
        : users;
      audienceSummary.innerHTML = `
        <div class="detail-card">
          <p style="margin:0;"><strong>${recipients.length}</strong> recipients</p>
          <p style="margin:0;">Scope: ${scope === 'enterprise' ? 'Enterprise users only' : 'All registered users'}</p>
          <div class="detail-card__meta">
            ${recipients.slice(0, 5).map((user) => `<span>${escapeHtml(user.email || '')}</span>`).join('')}
          </div>
        </div>
      `;
    } catch (error) {
      audienceSummary.innerHTML = `<div class="detail-card">${escapeHtml(error.message || 'Unable to load audience')}</div>`;
    }
  };

  scopeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const selectedScope = button.getAttribute('data-scope');
      if (selectedScope) {
        emailScope.value = selectedScope;
        scopeButtons.forEach((item) => item.classList.toggle('btn-primary', item === button));
        scopeButtons.forEach((item) => item.classList.toggle('btn-secondary', item !== button));
        renderAudienceSummary();
      }
    });
  });

  emailScope.addEventListener('change', renderAudienceSummary);
  emailSubject.addEventListener('input', () => {});
  emailMessage.addEventListener('input', () => {});

  sendEmailButton.addEventListener('click', async () => {
    const subject = emailSubject.value.trim() || 'KielTech update';
    const message = emailMessage.value.trim();
    if (!message) {
      emailResult.textContent = 'Please draft a message before sending.';
      return;
    }

    sendEmailButton.disabled = true;
    sendEmailButton.textContent = 'Sending...';
    emailResult.textContent = 'Sending broadcast...';
    try {
      const response = await fetch(`${getApiBaseUrl()}/admin/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'kieltech2009$' },
        body: JSON.stringify({ scope: emailScope.value, subject, message })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || 'Unable to send the broadcast');
      }
      emailResult.textContent = `Broadcast queued for ${payload.recipient_count} ${payload.scope === 'enterprise' ? 'enterprise' : 'platform'} recipients.`;
    } catch (error) {
      emailResult.textContent = error.message || 'Broadcast failed.';
    } finally {
      sendEmailButton.disabled = false;
      sendEmailButton.textContent = 'Send broadcast';
    }
  });

  renderAudienceSummary();
}

function initWebDevelopmentExperience() {
  const pathname = window.location.pathname;
  const isWebDevelopmentPage = pathname.includes('/web-development.html') || pathname.endsWith('/web-development');
  const isWebDevelopmentBuildPage = pathname.includes('/web-development-build.html') || pathname.includes('web-development-build');
  const isWebDevelopmentStudioPage = pathname.includes('/web-development-studio.html') || pathname.includes('web-development-studio');
  if (!isWebDevelopmentPage && !isWebDevelopmentBuildPage && !isWebDevelopmentStudioPage) return;

  const draftStorageKey = 'kieltech-web-dev-draft-v1';
  const storedRequestKey = 'kieltech-web-dev-request-v1';
  const urlParams = new URLSearchParams(window.location.search);
  const urlAiName = urlParams.get('aiName');
  const urlAiCategory = urlParams.get('aiCategory');
  const urlAiPrice = urlParams.get('aiPrice');
  const urlAiModel = urlParams.get('aiModel');
  const translations = {
    en: {
      heroEyebrow: 'Web development',
      heroHeading: 'Modern websites and web products built for real growth.',
      heroCopy: 'From polished marketing sites to custom web apps, we design and build digital experiences that are fast, reliable, and made to convert.',
      introEyebrow: 'Build with purpose',
      introHeading: 'Choose an AI specialist, describe your idea, and we’ll guide it into a polished web experience.',
      introDescription: 'Whether you need a landing page, a business portal, an API layer, or a full product, we can route your request to the right specialist and help you publish or download it at the end.',
      startBuild: 'Start your build',
      bookCall: 'Book a discovery call',
      requestEyebrow: 'Your build request',
      requestHeading: 'Tell us what you want the selected AI to build.',
      selectedAiPrompt: 'Select an AI specialist to begin.',
      projectNameLabel: 'Project name',
      projectNamePlaceholder: 'My portfolio website',
      projectEmailLabel: 'Email',
      projectEmailPlaceholder: 'you@example.com',
      projectBriefLabel: 'Describe what you want built',
      projectBriefPlaceholder: 'I need a landing page with pricing, about, contact, and a signup flow.',
      deliveryPreferenceLabel: 'Preferred delivery',
      deploymentTargetLabel: 'Deployment target',
      featureListLabel: 'Pages or features you want included',
      featureListPlaceholder: 'About page, blog, contact form, dashboard, integrations',
      startBuildButton: 'Start build request',
      resetBuildButton: 'Start over',
      payDepositButton: 'Pay deposit',
      refundButton: 'Refund',
      markInvoiceButton: 'Mark invoice generated'
    }
  };

  const applyLanguage = () => {
    const dict = translations.en;
    document.documentElement.lang = 'en';
    document.title = 'KielTech AI website studio';
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.getAttribute('data-i18n');
      if (dict[key]) {
        element.textContent = dict[key];
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      const key = element.getAttribute('data-i18n-placeholder');
      if (dict[key]) {
        element.placeholder = dict[key];
      }
    });
  };

  const saveDraft = () => {
    const payload = {
      selectedAi: selectedAi ? { category: selectedAi.category, name: selectedAi.name, price: selectedAi.price, model: selectedAi.model } : null,
      form: {
        projectName: projectNameInput?.value || '',
        projectEmail: projectEmailInput?.value || '',
        projectBrief: projectBriefInput?.value || '',
        deliveryPreference: deliveryPreferenceInput?.value || 'publish',
        deploymentTarget: deploymentTargetInput?.value || 'free-hosting',
        featureList: featureListInput?.value || ''
      }
    };
    localStorage.setItem(draftStorageKey, JSON.stringify(payload));
  };

  const clearDraft = () => {
    localStorage.removeItem(draftStorageKey);
  };

  const restoreDraft = () => {
    try {
      const rawDraft = localStorage.getItem(draftStorageKey);
      const rawStored = localStorage.getItem(storedRequestKey);
      const draftPayload = rawDraft ? JSON.parse(rawDraft) : null;
      const storedPayload = rawStored ? JSON.parse(rawStored) : null;
      const payload = storedPayload || draftPayload;
      if (!payload) return;

      const formPayload = payload.form || {
        projectName: payload.projectName,
        projectEmail: payload.email,
        projectBrief: payload.projectBrief,
        deliveryPreference: payload.deliveryPreference,
        deploymentTarget: payload.deploymentTarget,
        featureList: payload.featureList
      };

      if (projectNameInput) projectNameInput.value = formPayload.projectName || projectNameInput.value || '';
      if (projectEmailInput) projectEmailInput.value = formPayload.projectEmail || formPayload.email || projectEmailInput.value || '';
      if (projectBriefInput) projectBriefInput.value = formPayload.projectBrief || projectBriefInput.value || '';
      if (deliveryPreferenceInput) deliveryPreferenceInput.value = formPayload.deliveryPreference || deliveryPreferenceInput.value || 'publish';
      if (deploymentTargetInput) deploymentTargetInput.value = formPayload.deploymentTarget || deploymentTargetInput.value || 'free-hosting';
      if (featureListInput) featureListInput.value = formPayload.featureList || featureListInput.value || '';

      if (payload?.selectedAi && !selectedAi) {
        selectedAi = payload.selectedAi;
        if (selectedAi.model) {
          studioSelectedModel = selectedAi.model;
          localStorage.setItem('kieltech-studio-model', selectedAi.model);
        }
        const matchingCard = Array.from(aiCards).find((card) => {
          const button = card.querySelector('.select-ai-button');
          return button?.getAttribute('data-ai-name') === payload.selectedAi.name;
        });
        if (matchingCard) {
          aiCards.forEach((item) => item.classList.remove('is-selected'));
          matchingCard.classList.add('is-selected');
        }
        if (requestSection) {
          revealForm();
        }
        if (selectedAiSummary) {
          selectedAiSummary.innerHTML = `<strong>${selectedAi.category}</strong> specialist selected: ${selectedAi.name} (${selectedAi.price})`;
        }
      }
    } catch (error) {
      console.warn('Unable to restore draft', error);
    }
  };

  const showLoadingSkeleton = (targetPanel) => {
    if (!targetPanel) return;
    targetPanel.innerHTML = `
      <div class="skeleton-block">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-card"></div>
      </div>
    `;
  };

  const requestSection = document.getElementById('buildRequestSection');
  const selectedAiSummary = document.getElementById('selectedAiSummary');
  const form = document.getElementById('webDevelopmentRequestForm');
  const formMessage = document.getElementById('webDevelopmentFormMessage');
  const progressPanel = document.getElementById('buildProgressPanel');
  const outcomePanel = document.getElementById('buildOutcomePanel');
  const deliverySummaryPanel = document.getElementById('deliverySummaryPanel');
  const resetButton = document.getElementById('resetBuildButton');
  const startBuildButton = document.getElementById('startBuildButton');
  const projectNameInput = document.getElementById('projectNameInput');
  const projectEmailInput = document.getElementById('projectEmailInput');
  const projectBriefInput = document.getElementById('projectBriefInput');
  const deliveryPreferenceInput = document.getElementById('deliveryPreferenceInput');
  const deploymentTargetInput = document.getElementById('deploymentTargetInput');
  const featureListInput = document.getElementById('featureListInput');
  const historyPanel = document.getElementById('webDevelopmentHistory');
  const notificationCenterList = document.getElementById('notificationCenterList');
  const notificationCenterCount = document.getElementById('notificationCenterCount');
  const toastPanel = document.getElementById('webDevelopmentToast');
  const billingPanel = document.getElementById('webDevelopmentBillingPanel');
  const billingPanelTitle = document.getElementById('billingPanelTitle');
  const billingPanelSummary = document.getElementById('billingPanelSummary');
  const billingStatusBadge = document.getElementById('billingStatusBadge');
  const billingPanelMessage = document.getElementById('billingPanelMessage');
  const payDepositButton = document.getElementById('payDepositButton');
  const refundButton = document.getElementById('refundButton');
  const markInvoiceButton = document.getElementById('markInvoiceButton');
  const studioPromptInput = document.getElementById('studioPromptInput');
  const studioVoiceButton = document.getElementById('studioVoiceButton');
  const studioContextButton = document.getElementById('studioContextButton');
  const studioContextChips = document.getElementById('studioContextChips');
  const studioStatus = document.getElementById('studioStatus');
  const studioAuthModal = document.getElementById('studioAuthModal');
  const studioAuthModalCancel = document.getElementById('studioAuthModalCancel');
  const studioRequestSummary = document.getElementById('webDevelopmentStudioRequestSummary');
  const studioProjectName = document.getElementById('studioProjectName');
  const studioSelectedAi = document.getElementById('studioSelectedAi');
  const studioRequestedFeatures = document.getElementById('studioRequestedFeatures');
  const studioTemperature = document.getElementById('studioTemperature');
  const studioTemperatureValue = document.getElementById('studioTemperatureValue');
  const studioMaxTokens = document.getElementById('studioMaxTokens');
  const studioMaxTokensValue = document.getElementById('studioMaxTokensValue');
  const studioActionButton = document.getElementById('studioActionButton');
  const studioAiTitle = document.getElementById('studioAiTitle');
  const studioAiSubtitle = document.getElementById('studioAiSubtitle');
  const studioAiRuntime = document.getElementById('studioAiRuntime');
  const editRequestButton = document.getElementById('editRequestButton');
  const viewLandingButton = document.getElementById('viewLandingButton');
  const studioHistoryList = document.getElementById('studioHistoryList');
  const studioPreviewPanel = document.getElementById('studioPreviewPanel');
  const studioCodePanel = document.getElementById('studioCodePanel');
  let aiCards = document.querySelectorAll('.ai-service-card');
  const isSelectionPage = isWebDevelopmentPage && !isWebDevelopmentBuildPage && !isWebDevelopmentStudioPage;

  if (isSelectionPage) {
    const catalogSection = document.getElementById('ai-selection');
    if (catalogSection) {
      const heading = catalogSection.querySelector('.section-heading');
      if (heading) heading.innerHTML = '<p class="eyebrow">AI models</p><h2>Choose your coding assistant.</h2><p>Select one model for the request. The Studio workspace will stay locked to your choice.</p>';
      const grid = catalogSection.querySelector('.ai-card-grid');
      if (grid) {
        grid.addEventListener('click', (event) => {
          const button = event.target.closest('.select-ai-button');
          if (button) selectAiModel(button, button.closest('.ai-service-card'));
        });
        grid.innerHTML = '<p class="demo-response" role="status">Loading available models…</p>';
        request('/v1/models/catalog', { cache: 'no-store' }).then((payload) => {
          const models = (Array.isArray(payload.models) ? payload.models : [])
            .filter((model) => ['text-generation', 'image-understanding', 'multimodal'].includes(model.category)
              && model.is_ready === true && model.is_configured === true);
          if (!models.length) {
            grid.innerHTML = '<p class="demo-response" role="status">No ready text or vision models are currently listed in the Admin Models catalog.</p>';
            aiCards = [];
            return;
          }
          grid.innerHTML = models.map((model) => {
            const name = escapeHtml(model.display_name || model.model_id);
            const modelId = escapeHtml(model.model_id);
            const inputPrice = Number(model.input_price);
            const outputPrice = Number(model.output_price);
            const price = Number.isFinite(inputPrice) && Number.isFinite(outputPrice)
              ? `Input $${inputPrice.toLocaleString()} / Output $${outputPrice.toLocaleString()} per 1M`
              : 'Pricing unavailable';
            return `
              <article class="card ai-service-card model-selection-card">
                <div class="ai-service-card__meta"><p class="eyebrow">${escapeHtml(model.category.replaceAll('-', ' '))}</p><h3>${name}</h3></div>
                <div class="package-price">${escapeHtml(price)}</div>
                <p>Configured model available for website planning and implementation workflows.</p>
                <button class="btn btn-secondary select-ai-button" type="button" data-ai-category="${escapeHtml(model.category)}" data-ai-name="${name}" data-ai-model="${modelId}" data-ai-price="${escapeHtml(price)}" aria-pressed="false">Use this model</button>
              </article>
            `;
          }).join('');
          aiCards = grid.querySelectorAll('.ai-service-card');
        }).catch((error) => {
          grid.innerHTML = `<p class="demo-response" role="status">${escapeHtml(error.message || 'Unable to load the Admin Models catalog.')}</p>`;
          aiCards = [];
        });
      }
      catalogSection.parentElement.querySelectorAll(':scope > section:not(#ai-selection)').forEach((section) => {
        if (!section.id || section.id !== 'webDevelopmentAuthNotice') section.hidden = true;
      });
    }
  }

  if (isWebDevelopmentBuildPage && (!requestSection || !form)) return;
  if (isWebDevelopmentStudioPage && !studioPromptInput) return;

  if (isWebDevelopmentBuildPage) {
    request('/v1/auth/me').then((profile) => {
      if (projectEmailInput && profile?.user?.email) {
        projectEmailInput.value = profile.user.email;
        projectEmailInput.readOnly = true;
      }
      if (form) form.setAttribute('aria-busy', 'false');
      if (startBuildButton) startBuildButton.disabled = false;
    }).catch(() => {
      if (form) form.innerHTML = '<div class="card dashboard-empty-state"><h2>Sign in to submit a build request</h2><p>Your build request and project history are tied to your authenticated account.</p><a class="btn btn-primary" href="login.html?return_to=web-development-build.html">Sign in</a></div>';
    });
  }

  if (isSelectionPage) {
    const authNotice = document.getElementById('webDevelopmentAuthNotice');
    request('/v1/auth/me').catch(() => {
      if (authNotice) authNotice.hidden = false;
      aiCards.forEach((serviceCard) => {
        const serviceButton = serviceCard.querySelector('.select-ai-button');
        if (serviceButton) {
          serviceButton.disabled = true;
          serviceButton.setAttribute('aria-disabled', 'true');
          serviceButton.title = 'Sign in to submit a build request';
        }
      });
    });
  }

  let selectedAi = null;
  if (urlAiName) {
    selectedAi = {
      category: urlAiCategory || 'Web development',
      name: urlAiName,
      price: urlAiPrice || '$0',
      model: urlAiModel
    };
  }

  let notificationQueue = [];
  let activeBillingRequestId = null;
  let activeBillingRequestName = '';

  [projectNameInput, projectEmailInput, projectBriefInput, deliveryPreferenceInput, deploymentTargetInput, featureListInput].forEach((input) => {
    input?.addEventListener('input', saveDraft);
    input?.addEventListener('change', saveDraft);
  });

  const showWebDevelopmentToast = (message) => {
    if (!toastPanel) return;
    toastPanel.textContent = message;
    toastPanel.classList.add('is-visible');
    window.clearTimeout(showWebDevelopmentToast.timeoutId);
    showWebDevelopmentToast.timeoutId = window.setTimeout(() => {
      toastPanel.classList.remove('is-visible');
    }, 3200);
  };

  const addNotification = (title, message, tone = 'info') => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      message,
      tone,
    };
    notificationQueue = [item, ...notificationQueue].slice(0, 8);
    renderNotifications();
    showWebDevelopmentToast(message);
  };

  const renderNotifications = () => {
    if (!notificationCenterList || !notificationCenterCount) return;
    notificationCenterCount.textContent = String(notificationQueue.length);
    if (!notificationQueue.length) {
      notificationCenterList.innerHTML = '<div class="notification-center__empty">No updates yet.</div>';
      return;
    }
    notificationCenterList.innerHTML = notificationQueue.map((item) => `
      <div class="notification-card">
        <div class="notification-card__title">
          <span>${escapeHtml(item.title)}</span>
          <span>${item.tone === 'error' ? '⚠️' : item.tone === 'success' ? '✅' : '🔔'}</span>
        </div>
        <div class="notification-card__body">${escapeHtml(item.message)}</div>
      </div>
    `).join('');
  };

  const makeSummary = () => {
    if (!selectedAi || !selectedAiSummary) return;

    selectedAiSummary.innerHTML = `
      <strong>${escapeHtml(selectedAi.name)}</strong>
      <span>${escapeHtml(selectedAi.category)} · ${escapeHtml(selectedAi.price)}</span><br>
      <span class="selected-ai-summary__model">Model ID: ${escapeHtml(selectedAi.model || 'Not selected')}</span>
    `;
  };

  const resetFlow = () => {
    form?.reset();
    selectedAi = null;
    aiCards.forEach((card) => card.classList.remove('is-selected'));
    requestSection?.classList.add('is-hidden');
    progressPanel?.classList.add('is-hidden');
    if (outcomePanel) outcomePanel.innerHTML = '';
    deliverySummaryPanel?.classList.add('is-hidden');
    if (deliverySummaryPanel) deliverySummaryPanel.innerHTML = '';
    clearDraft();
    setFormMessage(formMessage, '', 'info');
    if (startBuildButton && form?.getAttribute('aria-busy') === 'false') startBuildButton.removeAttribute('disabled');
    if (startBuildButton) startBuildButton.textContent = 'Start build request';
    addNotification('Workflow reset', 'The build request flow has been reset and is ready for a new submission.', 'info');
  };

  const revealForm = () => {
    if (!requestSection) return;
    requestSection.classList.remove('is-hidden');
    requestSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    makeSummary();
  };

  applyLanguage();
  restoreDraft();

  if (isWebDevelopmentBuildPage) {
    requestSection?.classList.remove('is-hidden');
    if (selectedAi && selectedAiSummary) {
      makeSummary();
    }
  }

  if (isWebDevelopmentStudioPage) {
    const storedRequest = localStorage.getItem(storedRequestKey);
    let requestPayload = null;

    try {
      requestPayload = storedRequest ? JSON.parse(storedRequest) : null;
    } catch (error) {
      console.warn('Unable to parse stored web development request', error);
    }

    if (!requestPayload || !requestPayload.selectedAi) {
      requestPayload = {
        projectName: 'KielTech Studio project',
        projectBrief: 'A local website project managed by the AI Studio agent.',
        deliveryPreference: 'preview',
        deploymentTarget: 'local workspace',
        selectedAi: {
          name: 'No model selected',
          category: 'Web development',
          price: '$0'
        },
        createdAt: new Date().toISOString()
      };
    }

    if (requestPayload && requestPayload.selectedAi) {
      if (requestPayload.selectedAi.model) {
        studioSelectedModel = requestPayload.selectedAi.model;
        localStorage.setItem('kieltech-studio-model', studioSelectedModel);
      }
      if (studioAiTitle) {
        studioAiTitle.textContent = requestPayload.selectedAi.name || 'Selected AI from the build request';
      }
      if (studioAiSubtitle) {
        const aiCategory = requestPayload.selectedAi.category ? ` • ${requestPayload.selectedAi.category}` : '';
        const aiPrice = requestPayload.selectedAi.price ? ` • ${requestPayload.selectedAi.price}` : '';
        studioAiSubtitle.textContent = `Selected AI specialist${aiCategory}${aiPrice}`;
      }
      if (studioAiRuntime) {
        let studioRuntimeInterval = null;
        const updateRuntimeText = () => {
          const createdAt = requestPayload.createdAt ? new Date(requestPayload.createdAt) : null;
          const diffSeconds = createdAt && !Number.isNaN(createdAt.getTime())
            ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000))
            : 648;
          const minutes = Math.floor(diffSeconds / 60);
          const seconds = diffSeconds % 60;
          const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
          studioAiRuntime.textContent = `${studioIsGenerating ? 'Running' : 'Ran for'} ${formattedTime}`;
        };
        updateRuntimeText();
        studioRuntimeInterval = window.setInterval(updateRuntimeText, 1000);

        // Expose control to pause/resume the runtime display while AI is generating
        // attach helpers to the element so run/stop handlers can clear the interval
        studioAiRuntime._intervalId = studioRuntimeInterval;
        studioAiRuntime._clearInterval = () => {
          if (studioAiRuntime._intervalId) {
            clearInterval(studioAiRuntime._intervalId);
            studioAiRuntime._intervalId = null;
          }
        };
      }
      if (studioSelectedAi) {
        studioSelectedAi.textContent = `Selected AI: ${requestPayload.selectedAi.name} (${requestPayload.selectedAi.category})`;
      }
      if (studioProjectName) {
        studioProjectName.textContent = requestPayload.projectName || 'Unnamed request';
        const navTitle = document.getElementById('studioNavTitle');
        if (navTitle) {
          navTitle.textContent = requestPayload.projectName || 'Untitled';
        }
      }
      if (studioRequestedFeatures) {
        studioRequestedFeatures.textContent = requestPayload.projectBrief || 'No brief provided.';
      }
      if (studioRequestSummary) {
        studioRequestSummary.innerHTML = `
          <div><strong>Project:</strong> ${escapeHtml(requestPayload.projectName || 'Unnamed project')}</div>
          <div><strong>Brief:</strong> ${escapeHtml(requestPayload.projectBrief || 'No brief provided')}</div>
          <div><strong>Delivery:</strong> ${escapeHtml(requestPayload.deliveryPreference || 'publish')}</div>
          <div><strong>Deployment:</strong> ${escapeHtml(requestPayload.deploymentTarget || 'free-hosting')}</div>
        `;
      }

      const historyStorageKey = 'kieltech-web-dev-studio-history-v1';
      const workflowStorageKey = `kieltech-studio-workflow-v1:${requestPayload.requestId || requestPayload.projectName || 'default'}`;
      let currentWorkflowRunId = '';
      const persistWorkflowToServer = async (entries, runId = currentWorkflowRunId) => {
        const projectId = localStorage.getItem('kieltech-server-studio-project-id');
        if (!projectId || !state.token || !runId) return;
        const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}/workflows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
          body: JSON.stringify({ run_id: runId, entries })
        });
        if (!response.ok) throw new Error(`Workflow persistence failed (${response.status})`);
      };
      const savePersistentWorkflow = (entries) => {
        try {
          const stored = JSON.parse(localStorage.getItem(workflowStorageKey) || '{}');
          if (Array.isArray(stored.entries)) {
            const legacyRunId = `legacy-${Date.now()}`;
            currentWorkflowRunId = legacyRunId;
            localStorage.setItem(workflowStorageKey, JSON.stringify({
              activeRunId: legacyRunId,
              runs: [{ runId: legacyRunId, entries: stored.entries, savedAt: new Date().toISOString() }]
            }));
            return;
          }
          const runs = Array.isArray(stored.runs) ? stored.runs : [];
          const runId = currentWorkflowRunId || `run-${Date.now()}`;
          const nextRun = { runId, entries, savedAt: new Date().toISOString() };
          const existingIndex = runs.findIndex((run) => run.runId === runId);
          if (existingIndex >= 0) runs[existingIndex] = nextRun;
          else runs.push(nextRun);
          localStorage.setItem(workflowStorageKey, JSON.stringify({ activeRunId: runId, runs }));
          const projectId = localStorage.getItem('kieltech-server-studio-project-id');
          if (projectId && state.token) {
            persistWorkflowToServer(entries, runId).catch((error) => console.warn('Unable to persist Studio workflow on server', error));
          }
        } catch (error) {
          console.warn('Unable to persist Studio workflow', error);
        }
      };
      const loadPersistentWorkflow = () => {
        try {
          const stored = JSON.parse(localStorage.getItem(workflowStorageKey) || '{}');
          if (Array.isArray(stored.entries)) {
            currentWorkflowRunId = `legacy-${Date.now()}`;
            localStorage.setItem(workflowStorageKey, JSON.stringify({
              activeRunId: currentWorkflowRunId,
              runs: [{ runId: currentWorkflowRunId, entries: stored.entries, savedAt: new Date().toISOString() }]
            }));
            return stored.entries;
          }
          const runs = Array.isArray(stored.runs) ? stored.runs : [];
          currentWorkflowRunId = stored.activeRunId || runs[runs.length - 1]?.runId || '';
          return runs.flatMap((run, index) => [
            { title: `Workflow run ${index + 1}`, state: 'done', summary: `Persisted workflow from ${new Date(run.savedAt || Date.now()).toLocaleString()}.`, detail: 'This workflow was restored from the current request history.', files: [], next: 'Expand the workflow steps below.' },
            ...(Array.isArray(run.entries) ? run.entries : [])
          ]);
        } catch (error) {
          return [];
        }
      };

      const restoreServerWorkflows = async () => {
        if (!state.token) return;
        try {
          const projectId = await ensureServerStudioProject(requestPayload.projectName || 'KielTech Studio project');
          const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}`, {
            headers: { Authorization: `Bearer ${state.token}` }
          });
          if (!response.ok) return;
          const payload = await response.json();
          const workflows = Array.isArray(payload.workflows) ? payload.workflows : [];
          if (!workflows.length) return;
          const storedRuns = workflows.map((workflow) => ({ runId: workflow.run_id, entries: workflow.entries || [], savedAt: workflow.updated_at || workflow.created_at, durationMs: Math.max(0, new Date(workflow.updated_at || workflow.created_at).getTime() - new Date(workflow.created_at || workflow.updated_at).getTime()) }));
          localStorage.setItem(workflowStorageKey, JSON.stringify({ activeRunId: storedRuns[storedRuns.length - 1]?.runId || '', runs: storedRuns }));
          renderStudioActionHistory(loadPersistentWorkflow(), { persist: false });
        } catch (error) {
          console.warn('Unable to restore server workflows', error);
        }
      };

      const resolveSuggestedFeatureChoice = (promptText = '') => {
        const choiceMatch = String(promptText || '').trim().match(/^(?:(?:please\s+)?(?:implement|build|add|do|choose|select|use|take|type|pick|go\s+with|number|option|feature)\s*)?(?:option|feature|number|#)?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:one|option|feature))?[.! ]*$/i);
        if (!choiceMatch) return String(promptText || '').trim();
        const choice = Number(choiceMatch[1]);
        const recentSuggestions = window.KieltechStudioChat?.getRecentAssistantText?.() || '';
        const listItems = recentSuggestions.split(/\r?\n/).map((line) => {
          const match = line.trim().match(/^(?:(\d{1,2})[.)]|[-*])\s+(.+)$/);
          return match ? { number: match[1] ? Number(match[1]) : null, text: match[2].replace(/[*_`]/g, '').trim() } : null;
        }).filter(Boolean);
        const selected = listItems.find((item) => item.number === choice) || listItems[choice - 1];
        if (!selected) return String(promptText || '').trim();
        const isFeatureSuggestion = /\b(?:feature suggestions?|suggestions?|recommendations?|next features?|could add|consider adding|features? (?:should|can|could|would) (?:we|you) add|(?:could|might) consider)\b/i.test(recentSuggestions);
        return isFeatureSuggestion
          ? `Implement suggested feature ${choice}: ${selected.text}`
          : `I choose option ${choice}: ${selected.text}. Please continue using this choice.`;
      };

      let studioHistory = [];
      try {
        studioHistory = JSON.parse(localStorage.getItem(historyStorageKey) || '[]');
      } catch (error) {
        console.warn('Unable to load studio history', error);
      }

      const setStudioStatus = (message, tone = 'info') => {
        if (!studioStatus) return;
        studioStatus.hidden = true;
      };

      const showStudioAuthModal = () => {
        if (!studioAuthModal) return;
        studioAuthModal.hidden = false;
        studioAuthModal.querySelector('a')?.focus();
      };

      const closeStudioAuthModal = () => {
        if (studioAuthModal) studioAuthModal.hidden = true;
      };

      studioAuthModalCancel?.addEventListener('click', closeStudioAuthModal);
      studioAuthModal?.querySelector('[data-studio-auth-close]')?.addEventListener('click', closeStudioAuthModal);

      const renderStudioHistory = () => {
        if (!studioHistoryList) return;
        if (!studioHistory.length) {
          studioHistoryList.innerHTML = '<div class="studio-history-empty">No runs yet. Start by describing the next build step.</div>';
          return;
        }

        studioHistoryList.innerHTML = studioHistory.map((item) => `
          <button class="studio-history-item" type="button" data-history-id="${escapeHtml(String(item.id))}">
            <strong>${escapeHtml(item.prompt || 'Run')}</strong>
            <span>${escapeHtml(new Date(item.createdAt || Date.now()).toLocaleString())}</span>
          </button>
        `).join('');
      };

      const studioSuggestionRow = document.querySelector('.studio-suggestion-chips');
      const defaultStudioSuggestions = ['AI Features', 'Add Camera Preview', 'Add Historical Themes', 'Capture Button Animation', 'Add Share Button'];

      const getStudioSuggestions = (promptText = '', responseText = '') => {
        const context = `${promptText} ${responseText}`.toLowerCase();
        const suggestions = [];
        const addSuggestion = (suggestion) => {
          if (!suggestions.includes(suggestion)) suggestions.push(suggestion);
        };

        if (context.includes('sidebar') || context.includes('side bar') || context.includes('navigation')) {
          addSuggestion('Add responsive sidebar navigation');
          addSuggestion('Add active navigation states');
        }
        if (context.includes('button') || context.includes('click') || context.includes('action')) {
          addSuggestion('Add button hover and loading states');
          addSuggestion('Add keyboard support for actions');
        }
        if (context.includes('camera') || context.includes('image') || context.includes('photo')) {
          addSuggestion('Add image upload and preview');
          addSuggestion('Add camera permission handling');
        }
        if (context.includes('theme') || context.includes('color') || context.includes('dark')) {
          addSuggestion('Add light and dark themes');
          addSuggestion('Add a color customization panel');
        }
        if (context.includes('form') || context.includes('input') || context.includes('login')) {
          addSuggestion('Add form validation and error states');
          addSuggestion('Add a mobile-friendly form layout');
        }
        if (context.includes('responsive') || context.includes('mobile') || context.includes('tablet')) {
          addSuggestion('Improve responsive layout behavior');
          addSuggestion('Add mobile navigation controls');
        }
        if (!suggestions.length) defaultStudioSuggestions.forEach(addSuggestion);
        return suggestions.slice(0, 5);
      };

      const renderStudioSuggestions = (promptText = '', responseText = '') => {
        if (!studioSuggestionRow) return;
        studioSuggestionRow.innerHTML = getStudioSuggestions(promptText, responseText)
          .map((suggestion) => `<button type="button" class="studio-suggestion-chip">${escapeHtml(suggestion)}</button>`)
          .join('');
      };

      if (studioSuggestionRow && studioSuggestionRow.dataset.suggestionsBound !== 'true') {
        studioSuggestionRow.dataset.suggestionsBound = 'true';
        studioSuggestionRow.addEventListener('click', (event) => {
        const suggestionButton = event.target.closest('.studio-suggestion-chip');
        if (!suggestionButton || !studioPromptInput) return;
        const suggestion = suggestionButton.textContent.trim();
        const currentPrompt = studioPromptInput.value.trim();
        const actionableSuggestion = `Implement this workspace change: ${suggestion}`;
        studioPromptInput.value = currentPrompt ? `${currentPrompt}\n${actionableSuggestion}` : actionableSuggestion;
        studioPromptInput.focus();
        adjustStudioTextarea(studioPromptInput);
        updateStudioActionState();
        });
      }

      const setStudioTab = (tabName) => {
        const previewTabButtons = Array.from(document.querySelectorAll('.studio-preview-tab'));
        const previewPanels = Array.from(document.querySelectorAll('.studio-preview-content'));
        
        previewTabButtons.forEach((tab) => {
          tab.classList.toggle('is-active', tab.dataset.tab === tabName);
        });
        
        previewPanels.forEach((panel) => {
          const panelTab = panel.id.replace('studio', '').replace('Panel', '').toLowerCase();
          panel.classList.toggle('is-active', panelTab === tabName);
        });
      };

      const extractStudioPublicSummarySections = (responseText = '') => {
        const cleanText = typeof responseText === 'string' ? responseText.trim() : '';
        if (!cleanText) return null;

        const publicText = cleanText
          .replace(/(?:^|\n)\s*Reasoning:\s*[\s\S]*?(?=\n\s*(?:Action|Verification):|$)/gi, '')
          .trim();
        const actionMatch = publicText.match(/(?:^|\n)\s*Action:\s*([\s\S]*?)(?=\n\s*Verification:|$)/i);
        const verificationMatch = publicText.match(/(?:^|\n)\s*Verification:\s*([\s\S]*?)(?=\n\s*Action:|$)/i);

        const sections = {
          publicText,
          action: actionMatch?.[1]?.trim() || '',
          verification: verificationMatch?.[1]?.trim() || ''
        };
        return sections;
      };

      const buildStudioProgressSummary = (promptText = '', responseText = '', structuredTool = null) => {
        const parsed = extractStudioPublicSummarySections(responseText);
        if (parsed) {
          const parts = [];
          if (parsed.action) parts.push(parsed.action);
          if (parsed.verification) parts.push(parsed.verification);
          if (!parts.length && parsed.publicText) parts.push(parsed.publicText);
          if (parts.length) {
            return parts.join(' ');
          }
        }

        const cleanReply = parsed?.publicText || '';
        if (cleanReply) {
          return cleanReply.replace(/\s+/g, ' ').trim();
        }

        if (structuredTool && typeof structuredTool === 'object') {
          const toolName = String(structuredTool.tool || structuredTool.action || 'workspace_action').replace(/_/g, ' ');
          const path = normalizeStudioToolPath(structuredTool.path || structuredTool.file || structuredTool.target || '');
          if (path) {
            return `I inspected the request, selected the ${toolName} action for ${path}, and prepared the workspace update for review.`;
          }
          return `I inspected the request, selected the ${toolName} action, and prepared the workspace update for review.`;
        }

        return `I inspected the request and mapped it to the relevant workspace action for: ${promptText || 'this task'}.`;
      };

      const renderStudioProgressPanel = (responseText = '', promptText = '') => {
        const parsed = extractStudioPublicSummarySections(responseText);
        const actionText = parsed?.action || parsed?.publicText || 'Workspace update prepared for review.';
        const verificationText = parsed?.verification || 'Project changes are ready for review.';

        if (!studioPreviewPanel) return;

        const sections = [
          { key: 'request', title: 'Request', badge: 'Received', icon: 'task_alt', tone: 'reasoning', text: promptText || 'Your workspace request will appear here.' },
          { key: 'action', title: 'Workspace update', badge: 'Prepared', icon: 'build', tone: 'action', text: actionText },
          { key: 'verification', title: 'Checks', badge: 'Review', icon: 'verified', tone: 'verification', text: verificationText }
        ];

        studioPreviewPanel.innerHTML = `
          <div class="studio-output-card studio-output-card--reasoning">
            <div class="studio-output-card__eyebrow">Build progress</div>
            <h4>${escapeHtml(requestPayload.projectName || 'Workspace update')}</h4>
            <p>Track the request, project changes, and review status.</p>
            <div class="studio-review-accordion studio-review-accordion--nested" data-review-accordion>
              ${sections.map((section) => `
                <div class="studio-review-accordion__item ${section.key === 'request' ? 'is-open' : ''}">
                  <button class="studio-review-accordion__trigger" type="button" aria-expanded="${section.key === 'request' ? 'true' : 'false'}">
                    <span class="studio-review-accordion__rail" aria-hidden="true"></span>
                    <span class="studio-review-accordion__title">
                      <span class="studio-review-accordion__icon studio-review-accordion__icon--${section.tone}">
                        <span class="material-symbols-outlined">${section.icon}</span>
                      </span>
                      <span>${section.title}</span>
                    </span>
                    <span class="studio-review-accordion__meta">
                      <span class="studio-review-accordion__badge studio-review-accordion__badge--${section.tone}">${section.badge}</span>
                      <span class="studio-review-accordion__chevron material-symbols-outlined" aria-hidden="true">${section.key === 'request' ? 'expand_less' : 'chevron_right'}</span>
                    </span>
                  </button>
                  <div class="studio-review-accordion__panel" ${section.key === 'request' ? '' : 'hidden'}>
                    <div class="studio-review-accordion__body">${escapeHtml(section.text)}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;

        const accordionButtons = studioPreviewPanel.querySelectorAll('[data-review-accordion] .studio-review-accordion__trigger');
        accordionButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const item = button.closest('.studio-review-accordion__item');
            const panel = item?.querySelector('.studio-review-accordion__panel');
            const chevron = button.querySelector('.studio-review-accordion__chevron');
            const isOpen = item?.classList.contains('is-open');
            const nextState = !isOpen;

            item?.classList.toggle('is-open', nextState);
            button.setAttribute('aria-expanded', String(nextState));
            if (panel) {
              panel.hidden = !nextState;
            }
            if (chevron) {
              chevron.textContent = nextState ? 'expand_less' : 'chevron_right';
            }
          });
        });
      };

      const renderStudioApprovedOutputCard = (promptText = '', actions = []) => {
        const files = Array.isArray(actions) ? actions.map((action) => action.path).filter(Boolean) : [];
        if (!studioPreviewPanel) return;

        studioPreviewPanel.innerHTML = `
          <div class="studio-output-card studio-output-card--result">
            <div class="studio-output-card__eyebrow">Approved output</div>
            <h4>${escapeHtml(requestPayload.projectName || 'Build workspace')}</h4>
            <p>${escapeHtml(promptText || 'Workspace changes applied successfully.')}</p>
            <div class="studio-output-card__meta">
              <span class="studio-output-card__pill">${files.length || 1} file${files.length === 1 ? '' : 's'}</span>
              <span class="studio-output-card__pill studio-output-card__pill--success">Ready</span>
            </div>
            ${files.length ? `<ul class="studio-output-card__list">${files.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>` : ''}
          </div>
        `;
      };

      const buildWorkspaceContext = () => {
        const files = getWorkspaceFiles().filter((file) => isPreviewSafeFile(file.path));
        const tree = files.map((file) => file.path).join('\n') || '(workspace is empty)';
        const source = files.slice(0, 8).map((file) => {
          const content = String(file.content || '').slice(0, 1200);
          return `FILE: ${file.path}\n${content}`;
        }).join('\n\n');
        return `WORKSPACE FILE TREE:\n${tree}\n\nRELEVANT FILE CONTENT (bounded snapshot):\n${source || '(no readable source files)'}`;
      };

      const streamStudioPlan = async (promptText, workflowSteps) => {
        const response = await fetch(`${getApiBaseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
          },
          body: JSON.stringify({
            prompt: `Project brief: ${requestPayload.projectBrief}\n\n${buildWorkspaceContext()}\n\nUser request: ${promptText}`,
            system_instructions: 'You are the planning phase of a coding agent. Return a concise user-facing implementation plan in 2 to 4 short sentences. Mention the likely files or workspace areas, the main implementation steps, and how the result will be verified. Do not reveal private chain-of-thought, hidden deliberation, or internal reasoning. Do not edit files in this phase.',
            model: studioSelectedModel,
            temperature: 0.2,
            max_tokens: 220,
            stream: true
          }),
          signal: studioAbortController?.signal
        });
        if (!response.ok || !response.body) throw new Error('The planning stream could not be started.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let plan = '';
        const consumePlanEvent = (eventText) => {
          const data = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') return;
          try {
            const payload = JSON.parse(data);
            const delta = payload?.choices?.[0]?.delta?.content || payload?.response?.output?.text || payload?.text || '';
            if (typeof delta === 'string' && delta) {
              plan += delta;
              workflowSteps[1].summary = plan.trim();
              workflowSteps[1].detail = 'The plan is being generated from the request and current workspace context.';
              renderStudioActionHistory(workflowSteps);
            }
          } catch (error) {
            // Ignore incomplete SSE payloads until the next event boundary.
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          events.forEach(consumePlanEvent);
          if (done) break;
        }
        consumePlanEvent(buffer);
        return plan.trim();
      };

      const streamStudioCompletionExplanation = async (promptText = '', actions = []) => {
        const files = Array.isArray(actions) ? actions.map((action) => action.path).filter(Boolean) : [];
        const response = await fetch(`${getApiBaseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
          },
          body: JSON.stringify({
            prompt: `The workspace action is complete. User request: ${promptText}\nChanged files: ${files.join(', ') || 'none'}\nBuild result: the preview was refreshed successfully.`,
            system_instructions: 'You are the AI coding assistant in KielTech Studio. Explain the completed workspace action directly to the user, then suggest 2 to 4 practical next features that fit the current project. Mention what changed, the exact files, why the changes were made, and how verification was completed. Choose your own natural title or subtitle for the explanation or suggestions, or omit a heading when one is unnecessary. Do not use ## or ### for subheadings; use a standalone bold title when a heading helps. Never use a line beginning with * as a subheading. Reserve * for list bullets or inline emphasis. Never use fixed headings such as "Suggested Next Features" or "Explanation of Features"; choose wording that fits the response. For grouped items, choose either Markdown bullet points or a numbered list based on whether the items are alternatives or ordered steps, and use that style consistently. Do not use literal labels such as "Reasoning:", "Action:", "Verification:", "What I did", or "Request:". Do not mention fallback text, missing responses, internal implementation, or that you are summarizing. Do not write or apply more code in this response. Return a concise, polished explanation followed by actionable next-feature suggestions.',
            model: studioSelectedModel,
            temperature: 0.2,
            max_tokens: 300,
            stream: true
          })
        });
        if (!response.ok || !response.body) {
          throw new Error('The AI explanation stream could not be started.');
        }

        const chatHistory = document.querySelector('.studio-chat-history');
        const streamCard = document.createElement('div');
        streamCard.className = 'studio-card studio-card--ai studio-streaming-card';
        streamCard.innerHTML = '<div class="studio-card__body"><span class="studio-streaming-card__status">Preparing explanation...</span></div>';
        chatHistory?.appendChild(streamCard);
        const streamBody = streamCard.querySelector('.studio-card__body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let explanation = '';
        const streamRenderer = createStudioStreamRenderer(streamBody);

        const consumeEvent = (eventText) => {
          const dataLines = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
          if (!dataLines.length || dataLines.join('') === '[DONE]') return;
          try {
            const payload = JSON.parse(dataLines.join('\n'));
            const delta = payload?.choices?.[0]?.delta?.content || payload?.response?.output?.text || payload?.text || '';
            if (typeof delta === 'string' && delta) {
              explanation += delta;
              if (streamBody) streamRenderer.append(delta);
              const area = document.querySelector('.studio-left-scroll-area');
              if (area) area.scrollTop = area.scrollHeight;
            }
          } catch (error) {
            // Ignore incomplete SSE JSON fragments until the next event boundary.
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          events.forEach(consumeEvent);
          if (done) break;
        }

        if (streamBody) await streamRenderer.finish(explanation);
        streamCard.remove();
        return explanation
          .replace(/^\s*(?:Reasoning|Action|Verification)\s*:\s*/gim, '')
          .trim();
      };

      const placeCompletedActionHistoryBelowChat = () => {
        const scrollArea = document.querySelector('.studio-left-scroll-area');
        const historyList = document.getElementById('studioActionHistoryList');
        const chatHistory = document.querySelector('.studio-chat-history');
        if (scrollArea && historyList && chatHistory) {
          scrollArea.appendChild(historyList);
        }
      };

      const placeCompletedActionHistoryBeforeAssistant = () => {
        const historyList = document.getElementById('studioActionHistoryList');
        const chatHistory = document.querySelector('.studio-chat-history');
        if (!historyList || !chatHistory) return;
        const assistantMessage = Array.from(chatHistory.children).reverse().find((child) => child.classList.contains('studio-card--ai') || child.classList.contains('studio-ai-response'));
        if (assistantMessage) {
          const assistantBody = assistantMessage.querySelector('.studio-card__body, .studio-ai-response__body');
          if (assistantBody) {
            assistantMessage.insertBefore(historyList, assistantBody);
          } else {
            assistantMessage.appendChild(historyList);
          }
        } else {
          chatHistory.appendChild(historyList);
        }
      };

      const renderStudioWorkspace = (responseText, promptText = '') => {
        const previewText = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
        const previewLines = previewText
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 4);
        const stepsMarkup = previewLines.length
          ? `<ul>${previewLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
          : `<p>${escapeHtml(previewText)}</p>`;
        const codeSample = `<!-- Generated by KielTech AI Studio -->\n<section class=\"studio-generated\">\n  <h2>${escapeHtml(requestPayload.projectName || 'Generated build')}</h2>\n  <p>${escapeHtml(previewText)}</p>\n</section>`;

        if (studioPreviewPanel) {
          studioPreviewPanel.innerHTML = `
            <div class="studio-output-card">
              <div class="studio-output-card__eyebrow">Live preview</div>
              <h4>${escapeHtml(requestPayload.projectName || 'Build workspace')}</h4>
              <p>${escapeHtml(promptText || 'Your generated build guidance will appear here.')}</p>
              <div class="studio-output-card__body">${stepsMarkup}</div>
              <div class="studio-output-card__chips">
                <span>${escapeHtml(requestPayload.selectedAi.name)}</span>
                <span>${escapeHtml(requestPayload.deliveryPreference || 'publish')}</span>
              </div>
            </div>
          `;
        }

        if (studioCodePanel) {
          studioCodePanel.innerHTML = `<pre class="studio-code-block">${escapeHtml(codeSample)}</pre>`;
        }
      };

      let studioIsGenerating = false;
      let studioAbortController = null;
      let studioRunStartedAt = 0;
      let studioRunElapsedMs = 0;
      let studioCompletedActionEntries = [];

      const updateStudioActionState = () => {
        if (!studioActionButton || !studioPromptInput) return;
        const hasInput = Boolean(studioPromptInput.value.trim());
        if (studioIsGenerating) {
          studioActionButton.classList.add('is-generating');
          studioActionButton.disabled = false;
          studioActionButton.setAttribute('aria-label', 'Stop');
        } else {
          studioActionButton.classList.remove('is-generating');
          studioActionButton.disabled = !hasInput;
          studioActionButton.setAttribute('aria-label', 'Send');
        }
      };

      const stopStudioGeneration = () => {
        if (!studioIsGenerating) return;
        studioAbortController?.abort();
        studioAbortController = null;
        studioIsGenerating = false;
        clearStudioPendingPatch();
        updateStudioActionState();
        setStudioStatus('AI action stopped.', 'info');
      };

      const clearStudioRunArtifact = () => {
        const actionHistory = document.getElementById('studioActionHistoryList');
        if (actionHistory) actionHistory.innerHTML = '';
        const buildControls = document.getElementById('studioBuildControls');
        if (buildControls) buildControls.hidden = true;
      };

      const resolveBuildPreviewUrl = () => {
        const previewUrl = requestPayload?.previewUrl || requestPayload?.buildUrl || requestPayload?.preview_url || requestPayload?.build_url;
        if (typeof previewUrl === 'string' && previewUrl.trim() && !isStudioPreviewUrl(previewUrl)) {
          return previewUrl.trim();
        }

        return 'about:blank';
      };

      const waitForStudioStep = (duration = 450) => new Promise((resolve) => window.setTimeout(resolve, duration));

      const renderStudioActionHistory = (entries = [], options = {}) => {
        const list = document.getElementById('studioActionHistoryList');
        if (!list) return;
        if (entries.length && options.persist !== false) savePersistentWorkflow(entries);

        const completedEntries = entries.filter((entry) => entry.state === 'done');
        const fileNames = [...new Set(entries.flatMap((entry) => Array.isArray(entry.files) ? entry.files : []))];
        const runningEntry = entries.find((entry) => entry.state === 'running');
        const historyLabel = runningEntry ? 'Workflow' : completedEntries.length === entries.length && entries.length ? 'Steps finished' : 'Workflow';
        const historyIcon = runningEntry ? 'progress_activity' : completedEntries.length === entries.length && entries.length ? 'check_circle' : 'history';
        const shouldCollapse = !runningEntry && completedEntries.length === entries.length && entries.length > 0;
        const elapsedLabel = studioRunElapsedMs > 0
          ? `Finished in ${Math.max(0.1, studioRunElapsedMs / 1000).toFixed(1)}s`
          : `${fileNames.length || entries.length} file${(fileNames.length || entries.length) === 1 ? '' : 's'}`;
        const stepLabel = shouldCollapse ? elapsedLabel : `${fileNames.length || entries.length} file${(fileNames.length || entries.length) === 1 ? '' : 's'}`;

        list.innerHTML = `
          <div class="studio-action-history__header ${shouldCollapse ? 'is-collapsed' : ''}" data-action-history-toggle role="button" tabindex="0" aria-expanded="${shouldCollapse ? 'false' : 'true'}">
            <div class="studio-action-history__title">
              <span class="material-symbols-outlined ${runningEntry ? 'is-spinning' : ''}" aria-hidden="true">${historyIcon}</span>
              <strong>${historyLabel}</strong>
            </div>
            <div class="studio-action-history__meta">
              <span>${stepLabel}</span>
              <span class="material-symbols-outlined studio-action-history__chevron" aria-hidden="true">${shouldCollapse ? 'chevron_right' : 'expand_more'}</span>
            </div>
          </div>
          <div class="studio-action-history__entries" ${shouldCollapse ? 'hidden' : ''}>
            ${entries.map((entry) => `
            <div class="studio-action-item ${entry.state === 'done' ? 'is-expanded' : entry.state === 'error' ? 'is-error' : entry.state === 'running' ? 'is-loading' : ''}">
            <div class="studio-action-item__top">
              <span class="studio-action-item__prompt"><span class="material-symbols-outlined" aria-hidden="true">${entry.state === 'done' ? 'edit' : entry.state === 'error' ? 'error' : entry.state === 'running' ? 'progress_activity' : 'schedule'}</span>${escapeHtml(entry.title || 'Action')}</span>
              <span class="studio-action-item__state">${escapeHtml(entry.state === 'done' ? 'Complete' : entry.state === 'error' ? 'Blocked' : entry.state === 'running' ? 'In progress' : 'Planned')}</span>
            </div>
            <div class="studio-action-item__summary">${escapeHtml(entry.summary || '')}</div>
            ${entry.detail ? `<div class="studio-action-item__reasoning">${escapeHtml(entry.detail)}</div>` : ''}
            ${entry.files && entry.files.length ? `<div class="studio-action-item__files">${entry.files.map((file) => `<span><span class="studio-file-status ${entry.state === 'running' ? 'studio-file-status--loading' : ''} ${entry.state === 'done' ? 'material-symbols-outlined' : ''}">${entry.state === 'done' ? 'check_circle' : '•'}</span>${escapeHtml(file)}</span>`).join('')}</div>` : ''}
            ${entry.tools && entry.tools.length ? `<div class="studio-tool-cards">${entry.tools.map((tool) => `<div class="studio-tool-card"><span class="material-symbols-outlined" aria-hidden="true">${tool.icon || 'build'}</span><div><strong>${escapeHtml(tool.label || 'Workspace action')}</strong><small>${escapeHtml(tool.path || 'Workspace')}</small></div><span class="studio-tool-card__state">${entry.state === 'done' ? 'Complete' : 'Planned'}</span></div>`).join('')}</div>` : ''}
            ${entry.next ? `<div class="studio-action-item__next"><strong>Next</strong><span>${escapeHtml(entry.next)}</span></div>` : ''}
            </div>
            `).join('')}
          </div>
        `;

        const historyHeader = list.querySelector('[data-action-history-toggle]');
        const historyEntries = list.querySelector('.studio-action-history__entries');
        const toggleHistory = () => {
          if (!historyHeader || !historyEntries) return;
          const nextOpen = historyEntries.hidden;
          historyEntries.hidden = !nextOpen;
          historyHeader.classList.toggle('is-collapsed', !nextOpen);
          historyHeader.setAttribute('aria-expanded', String(nextOpen));
          const chevron = historyHeader.querySelector('.studio-action-history__chevron');
          if (chevron) chevron.textContent = nextOpen ? 'expand_more' : 'chevron_right';
        };
        historyHeader?.addEventListener('click', toggleHistory);
        historyHeader?.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleHistory();
          }
        });
      };

      const normalizeStudioToolPath = (value) => {
        const path = String(value || '').trim().replace(/\\/g, '/');
        if (!path) return '';
        return path.replace(/^\.\//, '').replace(/^\/+/, '');
      };

      const ensureFolderPathExists = (folderPath = '') => {
        const normalized = normalizeStudioToolPath(folderPath);
        if (!normalized) return true;
        const segments = normalized.split('/').filter(Boolean);
        let currentPath = '';
        for (const segment of segments) {
          const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
          if (!findEntryByPath(nextPath)) {
            addEntryToFolder(segment, 'folder', currentPath);
          }
          currentPath = nextPath;
        }
        return true;
      };

      const writeProjectFileByPath = (filePath, content, status = 'edited') => {
        const normalizedPath = normalizeStudioToolPath(filePath);
        if (!normalizedPath) return null;

        const segments = normalizedPath.split('/');
        const fileName = segments.pop();
        if (!fileName) return null;

        const parentPath = segments.join('/');
        ensureFolderPathExists(parentPath);
        const targetEntries = parentPath ? findFolderEntries(parentPath) : projectFiles;
        if (!targetEntries) return null;

        const existingFile = targetEntries.find((entry) => entry.type === 'file' && entry.name === fileName);
        if (existingFile) {
          existingFile.content = String(content ?? '');
          existingFile.status = status;
        } else {
          targetEntries.push({ name: fileName, type: 'file', status, content: String(content ?? '') });
        }

        renderFileExplorer();
        renderEditor();
        saveWorkspaceState();
        refreshPreviewFromWorkspace();
        return fileName;
      };

      const parseStudioToolCalls = (replyText, rawResponse = null) => {
        const toolCallList = rawResponse?.response?.tool_calls
          ?? rawResponse?.tool_calls
          ?? rawResponse?.choices?.[0]?.message?.tool_calls
          ?? rawResponse?.message?.tool_calls
          ?? [];

        const normalizedList = Array.isArray(toolCallList) ? toolCallList : [];
        if (normalizedList.length) {
          return normalizedList.map((toolCall) => {
            const fn = toolCall?.function || {};
            const parsedArgs = typeof fn.arguments === 'string'
              ? (() => {
                  try {
                    return JSON.parse(fn.arguments);
                  } catch (error) {
                    return { raw: fn.arguments };
                  }
                })()
              : (fn.arguments || {});

            return {
              tool: (fn.name || toolCall?.name || 'tool_call').toLowerCase(),
              path: parsedArgs.path || parsedArgs.file || parsedArgs.target || '',
              query: parsedArgs.query || parsedArgs.search || '',
              content: typeof parsedArgs.content === 'string' ? parsedArgs.content : (parsedArgs.code || parsedArgs.text || ''),
              summary: fn.name || toolCall?.name || 'Tool response',
            };
          });
        }

        if (!replyText || typeof replyText !== 'string') return [];
        const text = replyText.trim();
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const rawJson = fenced ? fenced[1] : text;

        try {
          const parsed = JSON.parse(rawJson);
          if (Array.isArray(parsed)) {
            return parsed.filter((item) => item && (item.tool || item.action || item.name)).map((item) => ({
              tool: String(item.tool || item.action || item.name || '').trim().toLowerCase(),
              path: item.path || item.file || item.target || '',
              query: item.query || item.search || '',
              content: typeof item.content === 'string' ? item.content : (item.code || item.text || ''),
              summary: item.summary || item.name || 'Tool response'
            }));
          }
          if (parsed && (parsed.tool || parsed.action || parsed.name)) {
            return [{
              tool: String(parsed.tool || parsed.action || parsed.name || '').trim().toLowerCase(),
              path: parsed.path || parsed.file || parsed.target || '',
              query: parsed.query || parsed.search || '',
              content: typeof parsed.content === 'string' ? parsed.content : (parsed.code || parsed.text || ''),
              summary: parsed.summary || parsed.name || 'Tool response'
            }];
          }
        } catch (error) {
          // fall through below
        }

        const toolMatches = [...text.matchAll(/(?:tool|action)\s*[:=]\s*["']?([a-zA-Z_\-]+)/gi)];
        const pathMatches = [...text.matchAll(/(?:path|file|target)\s*[:=]\s*["']?([^"'\n]+)/gi)];
        const contentMatches = [...text.matchAll(/(?:content|code|body|changes)\s*[:=]\s*["']?([\s\S]*?)(?:\n\s*(?:reason|summary|tool|action)\s*[:=]|$)/gi)];
        if (!toolMatches.length) return [];

        return toolMatches.map((match, index) => ({
          tool: match[1].trim().toLowerCase(),
          path: pathMatches[index]?.[1]?.trim() || '',
          content: contentMatches[index]?.[1]?.trim() || '',
          summary: text
        }));
      };

      const parseStudioToolCall = (replyText, rawResponse = null) => {
        const calls = parseStudioToolCalls(replyText, rawResponse);
        return calls[0] || null;
      };

      const dedupeWorkspaceToolCalls = (toolCalls = []) => {
        const byPath = new Map();
        (Array.isArray(toolCalls) ? toolCalls : []).forEach((toolCall) => {
          const path = normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '');
          if (!path) return;
          byPath.set(path, { ...toolCall, path });
        });
        return [...byPath.values()];
      };

      const inferStudioToolCallFromPrompt = (promptText = '') => {
        const normalized = String(promptText || '').trim();
        if (!normalized) return null;

        const lowered = normalized.toLowerCase();
        const makePathFromPrompt = (fallbackExt = 'txt') => {
          const pathMatch = normalized.match(/(?:create|make|add|write|update|edit|rename|delete|remove)\s+(?:a\s+)?(?:file|document|page|component|module|script|style|html|css|js|json|txt|md)?\s*(?:named|called|with\s+name|at|to)\s*["'`]?([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)["'`]?/i)
            || normalized.match(/(?:for|in)\s+(?:the\s+)?(?:file|path|location)\s*["'`]?([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)["'`]?/i)
            || normalized.match(/(?:create|make|add|write|new)\s+(?:a\s+)?([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)(?:\b|$)/i)
            || normalized.match(/([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)/i);

          if (pathMatch) return normalizeStudioToolPath(pathMatch[1]);

          const slug = normalized
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();

          const fallbackName = slug || 'generated-feature';
          return `${fallbackName}.${fallbackExt}`;
        };

        const makeFeatureContent = () => {
          const title = normalized
            .replace(/^(?:add|create|make|write|new)\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim();
          const cleanTitle = title || 'Studio feature';
          return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${cleanTitle}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; color: #1f2937; background: #f8fafc; }
      .card { max-width: 800px; margin: 0 auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin-top: 0; color: #0f172a; }
      p { line-height: 1.6; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${cleanTitle}</h1>
      <p>This feature was added by the KielTech Studio agent.</p>
      <p>Use this section as a starting point for the requested enhancement.</p>
    </div>
  </body>
</html>`;
        };

        if (/\b(delete|remove)\b/.test(lowered)) {
          return { tool: 'delete_file', path: makePathFromPrompt('txt'), summary: 'Delete the target file from the workspace.' };
        }

        if (/\b(edit|update|modify|change|fix|refactor|improve)\b/.test(lowered)) {
          return { tool: 'update_file', path: makePathFromPrompt('js'), summary: 'Update the selected file with the requested revision.', content: normalized };
        }

        if (/\b(create|make|add|write|new file|generate)\b/.test(lowered)) {
          const derivedPath = makePathFromPrompt('html');
          return {
            tool: 'create_file',
            path: derivedPath,
            summary: 'Create the requested file in the project workspace.',
            content: normalized.includes('text') || normalized.includes('content') ? normalized.replace(/.*?(?:text|content)\s*(?:is|=|:)?\s*["'`]?/i, '').replace(/["'`]/g, '').trim() || 'New file created by the studio agent.' : makeFeatureContent()
          };
        }

        if (/\b(read|open|show|inspect|view)\b/.test(lowered)) {
          return { tool: 'read_file', path: makePathFromPrompt('txt'), summary: 'Open the requested file for review.' };
        }

        if (/\b(list|show\s+all|files|workspace)\b/.test(lowered)) {
          return { tool: 'list_files', summary: 'List the available workspace files.' };
        }

        return null;
      };

      const execStudioToolCall = (toolCall, promptText = '') => {
        if (!toolCall || typeof toolCall !== 'object') return false;

        const normalizedTool = {
          read: 'read_file',
          open: 'read_file',
          list: 'list_files',
          search: 'list_files',
          create: 'create_file',
          write: 'create_file',
          edit: 'update_file',
          update: 'update_file',
          delete: 'delete_file',
          remove: 'delete_file',
          run: 'run_build',
          build: 'run_build',
          preview: 'run_build',
          search: 'search_web',
          web_search: 'search_web'
        }[(String(toolCall.tool || toolCall.action || '').trim().toLowerCase())] || (String(toolCall.tool || toolCall.action || '').trim().toLowerCase());

        const path = normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '');
        const content = typeof toolCall.content === 'string' ? toolCall.content : toolCall.code || toolCall.text || '';

        if (normalizedTool === 'search_web') {
          const query = String(toolCall.query || toolCall.search || content || promptText || '').trim();
          renderStudioActionHistory([
            { title: 'Search online', state: 'running', summary: `Searching the web for ${query}.`, detail: 'The agent is checking current public information before continuing.', files: [], next: 'Use the search results to refine the implementation.' }
          ]);
          request('/v1/studio/search', { method: 'POST', body: JSON.stringify({ query }) })
            .then((result) => {
              const sourceFiles = (result.results || []).map((item) => item.url).filter(Boolean);
              renderStudioActionHistory([
                { title: 'Search online', state: 'done', summary: `Found ${result.results?.length || 0} public sources for ${query}.`, detail: 'The search results are available to guide the next implementation step.', files: sourceFiles, next: 'Review the sources and continue the workspace plan.' }
              ]);
            })
            .catch((error) => {
              renderStudioActionHistory([
                { title: 'Search online', state: 'error', summary: error.message || 'Online search failed.', detail: 'The workspace was not changed by the search action.', files: [], next: 'Continue with the available workspace context or try a different query.' }
              ]);
            });
          return true;
        }

        if (normalizedTool === 'read_file') {
          if (!path) return false;
          const entry = findEntryByPath(path) || findFileEntry(path.split('/').pop(), path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
          if (entry) {
            selectFileByName(entry.name, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
            return true;
          }
          return false;
        }

        if (normalizedTool === 'list_files') {
          setStudioStatus('Workspace reviewed. The agent selected a file listing step.', 'success');
          const names = projectFiles.flatMap((entry) => entry.type === 'folder' ? [entry.name, ...collectFileNames(entry.children || [])] : [entry.name]);
          renderStudioWorkspace(`Project files: ${names.slice(0, 20).join(', ') || 'No workspace files available.'}`, promptText || 'Workspace review');
          return true;
        }

        if (normalizedTool === 'create_file') {
          if (!path) return false;
          writeProjectFileByPath(path, content || '// New file\n', 'draft');
          setStudioStatus(`Created ${path} with the requested content.`, 'success');
          return true;
        }

        if (normalizedTool === 'update_file') {
          if (!path) return false;
          const fileName = path.split('/').pop();
          const folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          const nextContent = content || findFileEntry(fileName, folderPath)?.content || '';
          writeProjectFileByPath(path, nextContent, 'edited');
          setStudioStatus(`Updated ${path} in the project workspace.`, 'success');
          return true;
        }

        if (normalizedTool === 'delete_file') {
          if (!path) return false;
          const deleted = deleteEntry(path);
          if (deleted) {
            renderFileExplorer();
            renderEditor();
            saveWorkspaceState();
            setStudioStatus(`Removed ${path} from the workspace.`, 'success');
            return true;
          }
          return false;
        }

        if (normalizedTool === 'run_build') {
          const summary = typeof toolCall.summary === 'string' ? toolCall.summary : promptText || 'Workspace task executed.';
          renderStudioWorkspace(summary, promptText || 'Workspace action');
          setStudioStatus('The agent selected a workspace build step.', 'success');
          loadAppPreview(resolveBuildPreviewUrl());
          return true;
        }

        return false;
      };

      let studioPendingPatch = null;
      let studioApprovedChangeHistory = [];

      const clearStudioPendingPatch = () => {
        studioPendingPatch = null;
        const controls = document.getElementById('studioBuildControls');
        if (controls) controls.hidden = true;
      };

      const inferStudioPatchFiles = (toolCall = null) => {
        if (!toolCall || typeof toolCall !== 'object') return [];
        const rawPath = toolCall.path || toolCall.file || toolCall.target || '';
        const normalized = normalizeStudioToolPath(rawPath);
        return normalized ? [normalized] : ['workspace'];
      };

      const deepCloneWorkspaceSnapshot = () => JSON.parse(JSON.stringify(projectFiles));

      const generateStudioPatchDiffLines = (previousContent = '', nextContent = '') => {
        const previousLines = String(previousContent || '').split(/\r?\n/);
        const nextLines = String(nextContent || '').split(/\r?\n/);
        const table = Array.from({ length: previousLines.length + 1 }, () => Array(nextLines.length + 1).fill(0));

        for (let i = previousLines.length - 1; i >= 0; i -= 1) {
          for (let j = nextLines.length - 1; j >= 0; j -= 1) {
            table[i][j] = previousLines[i] === nextLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
          }
        }

        const changes = [];
        let i = 0;
        let j = 0;

        while (i < previousLines.length && j < nextLines.length) {
          if (previousLines[i] === nextLines[j]) {
            changes.push({ type: 'context', value: previousLines[i] });
            i += 1;
            j += 1;
          } else if (table[i + 1][j] >= table[i][j + 1]) {
            changes.push({ type: 'remove', value: previousLines[i] });
            i += 1;
          } else {
            changes.push({ type: 'add', value: nextLines[j] });
            j += 1;
          }
        }

        while (i < previousLines.length) {
          changes.push({ type: 'remove', value: previousLines[i] });
          i += 1;
        }

        while (j < nextLines.length) {
          changes.push({ type: 'add', value: nextLines[j] });
          j += 1;
        }

        return changes.length ? changes : [{ type: 'context', value: '' }];
      };

      const buildStudioPatchActions = (toolCalls = []) => {
        const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls].filter(Boolean);
        return calls.map((toolCall) => {
          const normalizedTool = {
            read: 'read_file',
            open: 'read_file',
            list: 'list_files',
            search: 'list_files',
            create: 'create_file',
            write: 'create_file',
            edit: 'update_file',
            update: 'update_file',
            delete: 'delete_file',
            remove: 'delete_file'
          }[(String(toolCall.tool || toolCall.action || '').trim().toLowerCase())] || (String(toolCall.tool || toolCall.action || '').trim().toLowerCase());

          const path = normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '');
          const content = typeof toolCall.content === 'string' ? toolCall.content : (toolCall.code || toolCall.text || '');
          const existingEntry = path ? (findEntryByPath(path) || findFileEntry(path.split('/').pop(), path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')) : null;
          const previousContent = existingEntry && typeof existingEntry.content === 'string' ? existingEntry.content : '';
          const nextContent = normalizedTool === 'delete_file' ? '' : (content || previousContent || '');

          return {
            action: normalizedTool,
            path,
            previousContent,
            nextContent,
            summary: toolCall.summary || toolCall.tool || 'Workspace update'
          };
        }).filter((action) => action.action && action.path);
      };

      const renderStudioPatchDiffMarkup = (patchAction) => {
        const path = patchAction.path || 'workspace';
        const prevLines = String(patchAction.previousContent || '').split(/\r?\n/);
        const nextLines = String(patchAction.nextContent || '').split(/\r?\n/);
        const maxLines = Math.max(prevLines.length, nextLines.length);

        const sideBySideLines = Array.from({ length: maxLines }, (_, index) => {
          const before = prevLines[index] ?? '';
          const after = nextLines[index] ?? '';
          const same = before === after;
          return `
            <div class="studio-side-diff-row ${same ? 'is-unchanged' : before && !after ? 'is-removed' : !before && after ? 'is-added' : 'is-changed'}">
              <div class="studio-side-diff-cell studio-side-diff-cell--before">${escapeHtml(before || '') || '&nbsp;'}</div>
              <div class="studio-side-diff-cell studio-side-diff-cell--after">${escapeHtml(after || '') || '&nbsp;'}</div>
            </div>
          `;
        }).join('');

        return `
          <div class="studio-diff-file">
            <div class="studio-diff-file__header">
              <span>${escapeHtml(path)}</span>
              <span class="studio-diff-file__kind">${patchAction.action === 'create_file' ? 'Create' : patchAction.action === 'delete_file' ? 'Delete' : 'Update'}</span>
            </div>
            <div class="studio-side-diff">
              <div class="studio-side-diff__header">
                <span>Before</span>
                <span>After</span>
              </div>
              ${sideBySideLines}
            </div>
          </div>
        `;
      };

      const undoLastApprovedChange = () => {
        if (!studioApprovedChangeHistory.length) {
          setStudioStatus('No recent approved change is available to undo.', 'info');
          return false;
        }

        const snapshot = studioApprovedChangeHistory.pop();
        if (!Array.isArray(snapshot)) {
          setStudioStatus('The last approved change could not be restored.', 'error');
          return false;
        }

        projectFiles = snapshot;
        renderFileExplorer();
        renderEditor();
        saveWorkspaceState();
        refreshPreviewFromWorkspace();
        setStudioStatus('The last approved change was undone.', 'success');
        renderStudioActionHistory([
          { title: 'Last change undone', state: 'done', summary: 'The most recently approved workspace change was reverted.', detail: 'The workspace returned to its prior approved state.', files: ['workspace'], next: 'You can continue with a refined edit or re-approve a new patch.' }
        ]);
        return true;
      };

      const applyStudioPendingPatch = () => {
        if (!studioPendingPatch || !studioPendingPatch.actions || !studioPendingPatch.actions.length) {
          setStudioStatus('There is no pending patch to apply.', 'error');
          return false;
        }

        const beforeSnapshot = deepCloneWorkspaceSnapshot();
        const { promptText, reasoningSummary, actions } = studioPendingPatch;
        const controls = document.getElementById('studioBuildControls');
        if (controls) controls.hidden = true;

        let appliedCount = 0;
        for (const action of actions) {
          if (action.action === 'create_file') {
            writeProjectFileByPath(action.path, action.nextContent, 'edited');
            appliedCount += 1;
          } else if (action.action === 'update_file') {
            writeProjectFileByPath(action.path, action.nextContent, 'edited');
            appliedCount += 1;
          } else if (action.action === 'delete_file') {
            deleteEntry(action.path);
            appliedCount += 1;
          }
        }

        studioApprovedChangeHistory.push(beforeSnapshot);
        if (studioApprovedChangeHistory.length > 8) {
          studioApprovedChangeHistory.shift();
        }

        const statusText = appliedCount > 0 ? 'Patch approved and applied to the workspace.' : 'The patch could not be applied because the tool target was invalid.';
        setStudioStatus(statusText, appliedCount > 0 ? 'success' : 'error');

        if (appliedCount > 0) {
          renderStudioApprovedOutputCard(promptText, actions);
          setStudioTab('preview');
        }

        const changedFiles = actions.map((action) => action.path);
        const completed = appliedCount > 0;
        studioCompletedActionEntries = [
          { title: 'Inspect workspace', state: completed ? 'done' : 'error', summary: 'The agent reviewed the active workspace and selected the relevant targets.', detail: 'The request was grounded in the current project state before any files were changed.', files: changedFiles, next: 'Use the generated plan to guide the edit.' },
          { title: 'Plan changes', state: completed ? 'done' : 'error', summary: reasoningSummary || `Prepared a focused plan for ${changedFiles.join(', ')}.`, detail: 'The model explained the intended change and kept the scope limited to the request.', files: changedFiles, next: 'Execute the approved workspace actions.' },
          { title: 'Execute workspace actions', state: completed ? 'done' : 'error', summary: completed ? `Applied ${actions.length} file operation${actions.length === 1 ? '' : 's'} to ${changedFiles.join(', ')}.` : 'The generated change was not applied because the target was invalid.', detail: completed ? 'The approved file operations updated the workspace.' : 'Review the target path and retry the request.', files: completed ? changedFiles : [], next: 'Verify the updated workspace and preview.' },
          { title: 'Verify result', state: completed ? 'done' : 'error', summary: completed ? `Refreshed the preview from ${changedFiles.join(', ')}.` : 'Verification was skipped because execution failed.', detail: completed ? 'The updated workspace is ready for inspection and another iteration.' : 'Resolve the execution issue before retrying.', files: completed ? changedFiles : [], next: completed ? 'Review the AI explanation and suggested next features.' : 'Refine the request and retry.' }
        ];
        renderStudioActionHistory(studioCompletedActionEntries);
        clearStudioPendingPatch();
        return appliedCount > 0;
      };

      const approveStudioPatchAndExplain = async (workflowSteps = null) => {
        const pendingActions = studioPendingPatch?.actions ? [...studioPendingPatch.actions] : [];
        const pendingPrompt = studioPendingPatch?.promptText || '';
        if (!pendingActions.length) {
          studioIsGenerating = false;
          updateStudioActionState();
          return false;
        }

        try {
          await applyServerStudioFileBatch(pendingActions);
        } catch (error) {
          setStudioStatus(error.message || 'The backend rejected the workspace changes.', 'error');
          studioIsGenerating = false;
          updateStudioActionState();
          return false;
        }

        const applied = applyStudioPendingPatch();
        if (!applied) return false;

        if (workflowSteps) {
          workflowSteps[2].state = 'done';
          workflowSteps[2].summary = 'Workspace actions completed.';
          workflowSteps[3].state = 'running';
          workflowSteps[3].summary = 'Refreshing the preview and checking the updated workspace.';
          renderStudioActionHistory(workflowSteps);
        }

        loadAppPreview(resolveBuildPreviewUrl());
        setStudioStatus('Changes applied and preview refreshed.', 'success');
        try {
          const explanation = await streamStudioCompletionExplanation(pendingPrompt, pendingActions);
          if (explanation) {
            window.KieltechStudioChat?.persist('assistant', explanation, requestPayload.selectedAi?.name || studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
            window.KieltechStudioChat?.render();
            studioRunElapsedMs = studioRunStartedAt ? Date.now() - studioRunStartedAt : 0;
            if (workflowSteps) {
              workflowSteps[3].state = 'done';
              workflowSteps[3].summary = 'Preview refreshed and the workspace is ready.';
              renderStudioActionHistory(workflowSteps);
              await persistWorkflowToServer(workflowSteps, currentWorkflowRunId);
            }
            renderStudioActionHistory(studioCompletedActionEntries);
            placeCompletedActionHistoryBeforeAssistant();
            studioIsGenerating = false;
            updateStudioActionState();
          } else {
            setStudioStatus('Changes applied. The AI explanation was empty.', 'error');
            studioIsGenerating = false;
            updateStudioActionState();
          }
        } catch (error) {
          setStudioStatus('Changes applied, but the AI explanation could not be generated.', 'error');
          studioIsGenerating = false;
          updateStudioActionState();
        }
        return true;
      };

      const rejectStudioPendingPatch = () => {
        if (!studioPendingPatch) {
          if (studioApprovedChangeHistory.length) {
            undoLastApprovedChange();
            return;
          }
          setStudioStatus('There is no pending patch or recent approval to undo.', 'info');
          return;
        }

        const patchFiles = studioPendingPatch?.files?.length ? studioPendingPatch.files : [];
        studioRunElapsedMs = studioRunStartedAt ? Date.now() - studioRunStartedAt : 0;
        renderStudioActionHistory([
          { title: 'Rejected patch', state: 'error', summary: 'The patch was rejected and the workspace was not changed.', detail: 'The proposed file changes were discarded. Adjust the request to clarify the target behavior or scope before trying again.', files: patchFiles, next: 'Describe the exact change you want to make.' }
        ]);
        placeCompletedActionHistoryBelowChat();
        clearStudioPendingPatch();
        studioIsGenerating = false;
        updateStudioActionState();
      };

      const renderAgentPatchReview = (promptText, replyText, files = [], patchActions = []) => {
        const list = document.getElementById('studioActionHistoryList');
        const controls = document.getElementById('studioBuildControls');
        const keepChangesBtn = document.getElementById('studioKeepChanges');
        const undoChangesBtn = document.getElementById('studioUndoChanges');

        if (!list) return;

        const patchSummary = typeof replyText === 'string' ? replyText : JSON.stringify(replyText);
        const summaryText = patchSummary.replace(/\s+/g, ' ').trim().slice(0, 180) || 'No patch summary was returned.';
        const resolvedPatchActions = Array.isArray(patchActions) && patchActions.length ? patchActions : files.map((file) => ({ path: file, previousContent: '', nextContent: '', action: 'update_file' }));
        const diffMarkup = resolvedPatchActions.map((patchAction) => renderStudioPatchDiffMarkup(patchAction)).join('');
        const groupedCounts = resolvedPatchActions.reduce((result, action) => {
          const actionType = action.action === 'create_file' ? 'Create' : action.action === 'delete_file' ? 'Delete' : 'Update';
          result[actionType] = (result[actionType] || 0) + 1;
          return result;
        }, {});

        list.innerHTML = `
          <div class="studio-action-item is-expanded">
            <div class="studio-action-item__top">
              <span class="studio-action-item__prompt">Review proposed changes</span>
              <span class="studio-action-item__state">Awaiting approval</span>
            </div>
            <div class="studio-action-item__summary">Requested: ${escapeHtml(promptText)}</div>
            <div class="studio-action-item__reasoning"><strong>Plan summary:</strong> ${escapeHtml(summaryText)}</div>
            <div class="studio-action-item__files">${files.map((file) => `<span><span class="studio-file-status">•</span>${escapeHtml(file)}</span>`).join('')}</div>
            <div class="studio-action-item__next"><strong>Approval required</strong><span>Review the files and diff, then approve or reject the proposed workspace actions.</span></div>
          </div>
          <div class="studio-agent-review">
            <div class="studio-review-accordion" data-review-accordion>
              <div class="studio-review-accordion__item is-open">
                <button class="studio-review-accordion__trigger" type="button" aria-expanded="true">
                  <span class="studio-review-accordion__rail" aria-hidden="true"></span>
                  <span class="studio-review-accordion__title">
                    <span class="studio-review-accordion__icon studio-review-accordion__icon--reasoning">
                      <span class="material-symbols-outlined">summarize</span>
                    </span>
                    <span>Review all changed files</span>
                  </span>
                  <span class="studio-review-accordion__meta">
                    <span class="studio-review-accordion__badge studio-review-accordion__badge--reasoning">${resolvedPatchActions.length}</span>
                    <span class="studio-review-accordion__chevron material-symbols-outlined" aria-hidden="true">expand_less</span>
                  </span>
                </button>
                <div class="studio-review-accordion__panel">
                  <div class="studio-review-accordion__body">
                    <div class="studio-review-summary">
                      <div class="studio-review-summary__stat">
                        <span class="studio-review-summary__label">Files</span>
                        <strong>${resolvedPatchActions.length}</strong>
                      </div>
                      ${Object.entries(groupedCounts).map(([label, count]) => `
                        <div class="studio-review-summary__stat">
                          <span class="studio-review-summary__label">${label}</span>
                          <strong>${count}</strong>
                        </div>
                      `).join('')}
                    </div>
                    <div class="studio-review-summary__list">
                      ${resolvedPatchActions.map((patchAction) => `
                        <div class="studio-review-summary__item">
                          <span class="studio-review-summary__path">${escapeHtml(patchAction.path)}</span>
                          <span class="studio-review-summary__action">${patchAction.action === 'create_file' ? 'Create' : patchAction.action === 'delete_file' ? 'Delete' : 'Update'}</span>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              </div>
              <div class="studio-review-accordion__item">
                <button class="studio-review-accordion__trigger" type="button" aria-expanded="false">
                  <span class="studio-review-accordion__rail" aria-hidden="true"></span>
                  <span class="studio-review-accordion__title">
                    <span class="studio-review-accordion__icon studio-review-accordion__icon--action">
                      <span class="material-symbols-outlined">diff</span>
                    </span>
                    <span>Side-by-side diff</span>
                  </span>
                  <span class="studio-review-accordion__meta">
                    <span class="studio-review-accordion__badge studio-review-accordion__badge--action">${resolvedPatchActions.length ? 'View' : '0'}</span>
                    <span class="studio-review-accordion__chevron material-symbols-outlined" aria-hidden="true">chevron_right</span>
                  </span>
                </button>
                <div class="studio-review-accordion__panel" hidden>
                  <div class="studio-review-accordion__body">
                    <div class="studio-agent-diff">${diffMarkup || '<pre>+ No diff available yet.</pre>'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="studio-agent-review__actions">
              <button type="button" class="studio-agent-review__button studio-agent-review__button--accept" data-agent-action="approve">Approve changes</button>
              <button type="button" class="studio-agent-review__button studio-agent-review__button--reject" data-agent-action="reject">Reject</button>
            </div>
          </div>
        `;

        const accordionButtons = list.querySelectorAll('[data-review-accordion] .studio-review-accordion__trigger');
        accordionButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const item = button.closest('.studio-review-accordion__item');
            const panel = item?.querySelector('.studio-review-accordion__panel');
            const chevron = button.querySelector('.studio-review-accordion__chevron');
            const isOpen = item?.classList.contains('is-open');
            const nextState = !isOpen;

            item?.classList.toggle('is-open', nextState);
            button.setAttribute('aria-expanded', String(nextState));
            if (panel) {
              panel.hidden = !nextState;
            }
            if (chevron) {
              chevron.textContent = nextState ? 'expand_less' : 'chevron_right';
            }
          });
        });

        if (controls) controls.hidden = false;
        keepChangesBtn?.setAttribute('aria-label', 'Approve changes');
        undoChangesBtn?.setAttribute('aria-label', 'Reject pending patch');
        undoChangesBtn && (undoChangesBtn.textContent = 'Reject');

        const approvalButton = list.querySelector('[data-agent-action="approve"]');
        const rejectionButton = list.querySelector('[data-agent-action="reject"]');

        approvalButton?.addEventListener('click', () => {
          approveStudioPatchAndExplain();
        });

        rejectionButton?.addEventListener('click', () => {
          rejectStudioPendingPatch();
        });

        keepChangesBtn?.addEventListener('click', () => {
          approveStudioPatchAndExplain();
        });

        undoChangesBtn?.addEventListener('click', () => {
          if (studioPendingPatch) {
            rejectStudioPendingPatch();
          } else if (studioApprovedChangeHistory.length) {
            undoLastApprovedChange();
          } else {
            setStudioStatus('No recent approved change is available to undo.', 'info');
          }
        });
      };

      const streamStudioConversation = async (promptText, targetBody) => {
        targetBody.classList.add('studio-card__body--streaming');
        targetBody.replaceChildren();
        const progressPanel = document.createElement('details');
        progressPanel.className = 'studio-transient-progress';
        progressPanel.open = true;
        const progressSummary = document.createElement('summary');
        progressSummary.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">progress_activity</span><span>Working</span>';
        const progressMessage = document.createElement('div');
        progressMessage.className = 'studio-transient-progress__message';
        progressMessage.setAttribute('role', 'status');
        progressMessage.setAttribute('aria-live', 'polite');
        progressMessage.textContent = 'Getting things ready...';
        progressPanel.append(progressSummary, progressMessage);
        const answerBody = document.createElement('div');
        answerBody.className = 'studio-transient-progress__answer';
        answerBody.setAttribute('aria-live', 'polite');
        targetBody.append(progressPanel, answerBody);
        const projectId = await ensureServerStudioProject(requestPayload.projectName || 'KielTech Studio project');
        const history = Array.from(document.querySelectorAll('.studio-chat-history .studio-card')).map((card) => ({
          role: card.classList.contains('studio-card--user') ? 'user' : 'assistant',
          content: card.querySelector('.studio-card__body')?.innerText || ''
        })).filter((item) => item.content.trim()).slice(-20);
        if (history[history.length - 1]?.role === 'user' && history[history.length - 1].content.trim() === promptText.trim()) history.pop();
        const response = await fetch(`${getApiBaseUrl()}/v1/studio/conversation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
          body: JSON.stringify({
            project_id: projectId,
            model: studioSelectedModel,
            prompt: promptText,
            history
          }),
          signal: studioAbortController.signal
        });
        if (!response.ok || !response.body) {
          let detail = '';
          try {
            const payload = await response.json();
            detail = payload.detail || payload.message || payload.error || '';
          } catch (error) {
            detail = '';
          }
          throw new Error(detail ? `The AI conversation could not be started: ${detail}` : `The AI conversation could not be started (HTTP ${response.status}).`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let answer = '';
        let streamError = '';
        const streamRenderer = createStudioStreamRenderer(answerBody);
        const consume = (eventText) => {
          const data = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') return;
          if (data.startsWith('[STATUS]')) {
            progressMessage.textContent = data.slice(8).trim() || 'Working on your request...';
            return;
          }
          try {
            const payload = JSON.parse(data);
            if (payload.type === 'error' || payload.error) {
              streamError = payload.message || payload.error?.message || 'The AI conversation failed while generating a reply.';
              return;
            }
            const delta = payload?.choices?.[0]?.delta?.content || payload?.response?.output?.text || payload?.text || '';
            if (delta) {
              progressMessage.textContent = 'Generating your response...';
              answer += delta;
              streamRenderer.append(delta);
              const area = document.querySelector('.studio-left-scroll-area');
              if (area) area.scrollTop = area.scrollHeight;
            }
          } catch (error) {
            // Wait for the next complete SSE event.
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          events.forEach(consume);
          if (done) break;
        }
        consume(buffer);
        await streamRenderer.finish(answer);
        progressPanel.remove();
        targetBody.classList.remove('studio-card__body--streaming');
        if (streamError) throw new Error(streamError);
        const completedAnswer = answer.trim();
        if (!completedAnswer) throw new Error('The AI service returned an empty response. Please try again.');
        return completedAnswer;
      };

      let selectedStudioContext = [];

      const renderStudioContextChips = () => {
        if (!studioContextChips) return;
        studioContextChips.hidden = !selectedStudioContext.length;
        studioContextChips.innerHTML = selectedStudioContext.map((item) => `<span class="studio-context-chip"><span class="material-symbols-outlined" aria-hidden="true">description</span><span class="studio-context-chip__path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span><button type="button" class="studio-context-chip__remove" data-context-remove="${escapeHtml(item.path)}" aria-label="Remove ${escapeHtml(item.path)}" title="Remove context"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span>`).join('');
      };

      const chooseStudioContext = () => {
        const existingMenu = document.getElementById('studioContextMenu');
        if (existingMenu) {
          existingMenu.remove();
          return;
        }
        const menu = document.createElement('div');
        menu.id = 'studioContextMenu';
        menu.className = 'studio-context-menu';
        const files = getWorkspaceFiles().filter((file) => isPreviewSafeFile(file.path));
        const currentFile = typeof activeEditorFileName === 'string' ? files.find((file) => file.path === activeEditorFileName || file.path.endsWith(`/${activeEditorFileName}`)) : null;
        const options = [
          ...(currentFile ? [{ label: 'Add current editor file', paths: [currentFile.path] }] : []),
          { label: 'Add up to 5 project files', paths: files.slice(0, 5).map((file) => file.path) },
          ...files.slice(0, 12).map((file) => ({ label: `Add ${file.path}`, paths: [file.path] }))
        ];
        menu.innerHTML = options.map((option, index) => `<button type="button" data-context-option="${index}">${escapeHtml(option.label)}</button>`).join('');
        studioContextButton?.parentElement?.appendChild(menu);
        menu.addEventListener('click', (event) => {
          const button = event.target.closest('[data-context-option]');
          if (!button) return;
          const option = options[Number(button.dataset.contextOption)];
          option.paths.forEach((path) => {
            if (selectedStudioContext.length >= 5) return;
            const file = files.find((item) => item.path === path);
            if (file && !selectedStudioContext.some((item) => item.path === path)) selectedStudioContext.push({ path, content: String(file.content || '') });
          });
          renderStudioContextChips();
          menu.remove();
        });
      };

      studioContextButton?.addEventListener('click', chooseStudioContext);
      document.addEventListener('click', (event) => {
        const menu = document.getElementById('studioContextMenu');
        if (!menu || event.target.closest('#studioContextButton') || event.target.closest('#studioContextMenu')) return;
        menu.remove();
      });
      studioContextChips?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-context-remove]');
        if (!button) return;
        selectedStudioContext = selectedStudioContext.filter((item) => item.path !== button.dataset.contextRemove);
        renderStudioContextChips();
      });

      const streamBackendStudioAgent = async (promptText, requestContext = selectedStudioContext) => {
        const projectId = await ensureServerStudioProject(requestPayload.projectName || 'KielTech Studio project');
        const scrollBackendAgentToLatest = () => {
          const area = document.querySelector('.studio-left-scroll-area');
          if (area) area.scrollTop = area.scrollHeight;
        };
        const history = Array.from(document.querySelectorAll('.studio-chat-history .studio-card')).slice(-20).map((card) => ({
          role: card.classList.contains('studio-card--user') ? 'user' : 'assistant',
          content: card.querySelector('.studio-card__body')?.innerText || ''
        })).filter((item) => item.content.trim());
        const response = await fetch(`${getApiBaseUrl()}/v1/studio/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
          body: JSON.stringify({ project_id: projectId, run_id: currentWorkflowRunId, prompt: promptText, model: studioSelectedModel, history, context: requestContext }),
          signal: studioAbortController.signal
        });
        if (!response.ok || !response.body) throw new Error('The Studio agent could not be started.');

        const chatHistory = document.querySelector('.studio-chat-history');
        const aiCard = document.createElement('div');
        aiCard.className = 'studio-card studio-card--ai';
        aiCard.dataset.studioRunId = currentWorkflowRunId;
        aiCard.innerHTML = `<div class="studio-card__header"><span class="studio-card__runtime" data-studio-runtime>Running 0:00</span></div><details class="studio-copilot-activity" open><summary><span class="material-symbols-outlined studio-copilot-activity__spinner" aria-hidden="true">progress_activity</span><span class="studio-copilot-activity__state">Reviewing your request...</span></summary><div class="studio-copilot-activity__content"><div class="studio-copilot-activity__steps" data-studio-activity-steps aria-live="polite"></div><div class="studio-copilot-activity__features" data-studio-feature-checklist></div><div class="studio-copilot-activity__verification" data-studio-verification></div><div class="studio-copilot-activity__files" data-studio-activity-files></div></div></details><div class="studio-card__body"><span class="studio-streaming-card__status">Reviewing your request...</span></div>`;
        chatHistory?.appendChild(aiCard);
        const body = aiCard.querySelector('.studio-card__body');
        const activity = aiCard.querySelector('.studio-copilot-activity');
        const activityState = aiCard.querySelector('.studio-copilot-activity__state');
        const activitySteps = aiCard.querySelector('[data-studio-activity-steps]');
        const activityFeatures = aiCard.querySelector('[data-studio-feature-checklist]');
        const activityVerification = aiCard.querySelector('[data-studio-verification]');
        const activityFiles = aiCard.querySelector('[data-studio-activity-files]');
        const fileChanges = [];
        const renderedProgressExplanations = new Set();
        let pendingProgressExplanation = '';
        let workspaceSync = Promise.resolve();
        let previewSyncFailed = false;
        let implementationSummaryReady = false;
        let implementationSummaryPayload = null;
        let verificationStatus = 'pending';
        const featureChecklist = [];
        const verificationResults = [];
        const runtimeLabels = aiCard.querySelectorAll('[data-studio-runtime]');
        const startedAt = Date.now();
        const renderLiveWorkflowStep = (entry, state, seenExplanations) => {
          const summary = entry.summary || entry.title || 'Workspace step completed.';
          const summaryLower = summary.toLocaleLowerCase();
          const paths = Array.isArray(entry.paths)
            ? entry.paths.filter((path) => typeof path === 'string' && !summaryLower.includes(path.toLocaleLowerCase()))
            : [];
          const explanation = typeof entry.explanation === 'string' ? entry.explanation.trim() : '';
          const explanationKey = explanation.replace(/\s+/g, ' ').toLocaleLowerCase();
          const showExplanation = explanation && !seenExplanations.has(explanationKey);
          if (showExplanation) seenExplanations.add(explanationKey);
          const icon = state === 'error' ? 'error' : state === 'done' ? 'check_circle' : 'progress_activity';
          return `<div class="studio-copilot-activity__step is-${escapeHtml(state)}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><div class="studio-copilot-activity__step-content"><span>${escapeHtml(summary)}</span>${paths.length ? `<div class="studio-copilot-activity__paths">${paths.map((path) => `<code>${escapeHtml(path)}</code>`).join('')}</div>` : ''}${showExplanation ? `<p class="studio-copilot-activity__explanation">${escapeHtml(explanation)}</p>` : ''}</div></div>`;
        };
        const renderActivity = (state = 'Working through your request...') => {
          const terminalStates = ['Completed', 'Completed with issues', 'Unable to complete', 'No final response', 'Preview refresh failed', 'Reviewed — no files changed', 'Implemented — verification pending', 'Implemented — checks failed', 'Implemented — checks unavailable'];
          activity?.classList.remove('is-complete', 'is-error', 'is-pending', 'is-review');
          if (activityState) activityState.textContent = state;
          const progressIcon = aiCard.querySelector('.studio-copilot-activity__spinner');
          if (progressIcon) {
            progressIcon.textContent = state === 'Completed'
              ? 'check_circle'
              : state === 'Unable to complete' || state === 'No final response' || state === 'Completed with issues' || state === 'Preview refresh failed' || state === 'Implemented — checks failed'
                ? 'error'
                : terminalStates.includes(state)
                  ? 'pending'
                : 'progress_activity';
          }
          if (activitySteps) {
            renderedProgressExplanations.clear();
            activitySteps.innerHTML = workflowEntries.map((entry) => renderLiveWorkflowStep(entry, entry.state || 'running', renderedProgressExplanations)).join('');
          }
          if (activityFeatures) {
            activityFeatures.innerHTML = featureChecklist.length
              ? `<strong>Feature checklist</strong>${featureChecklist.map((item) => `<div class="studio-copilot-activity__feature"><span class="studio-copilot-activity__feature-status is-${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll('_', ' '))}</span><div><b>${escapeHtml(item.feature)}</b>${(item.evidence || []).map((evidence) => `<div class="studio-copilot-activity__evidence"><code>${escapeHtml(evidence.path)}</code><span>${escapeHtml(evidence.excerpt)}</span></div>`).join('')}<small>${escapeHtml(item.assessment || 'Source evidence matched; runtime behavior not verified.')}</small></div></div>`).join('')}`
              : '';
          }
          if (activityVerification) {
            activityVerification.innerHTML = verificationResults.length
              ? `<strong>Verification checks</strong>${verificationResults.map((item) => `<div class="studio-copilot-activity__check is-${escapeHtml(item.status)}"><span class="material-symbols-outlined" aria-hidden="true">${item.status === 'passed' ? 'check_circle' : item.status === 'failed' ? 'error' : 'pending'}</span><div><b>${escapeHtml(item.check.replaceAll('_', ' '))}</b><span>${escapeHtml(item.detail || item.status)}</span></div></div>`).join('')}`
              : '';
          }
          if (activityFiles) activityFiles.innerHTML = fileChanges.length ? `<strong>Changed project paths</strong>${fileChanges.map((change) => `<div class="studio-copilot-activity__file"><span class="material-symbols-outlined" aria-hidden="true">${change.action === 'delete_file' ? 'delete' : change.action === 'update_file' ? 'edit_document' : change.action === 'move_file' ? 'drive_file_move' : 'description'}</span><span><b>${escapeHtml(change.label)}</b> ${escapeHtml(change.path)}</span></div>`).join('')}` : '<span class="studio-copilot-activity__empty">No files changed.</span>';
        };
        const updateRuntime = (completed = false) => {
          const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
          runtimeLabels.forEach((label) => { label.textContent = `${completed ? 'Ran for' : 'Running'} ${duration}`; });
        };
        const runtimeTimer = window.setInterval(updateRuntime, 1000);
        runtimeLabels.forEach((label) => {
          label.dataset.studioRuntimeStartedAt = String(startedAt);
          label.dataset.studioRuntimeTimer = String(runtimeTimer);
        });
        const workflowEntries = [];
        let finalText = '';
        let workflowSucceeded = false;
        const getCompletionLabel = () => {
          const applied = implementationSummaryPayload && typeof implementationSummaryPayload.implemented !== 'undefined'
            ? Boolean(implementationSummaryPayload.implemented)
            : Boolean(fileChanges.length);
          if (!applied) return 'Reviewed — no files changed';
          if (verificationStatus === 'passed') return 'Completed';
          if (verificationStatus === 'failed') return 'Implemented — checks failed';
          if (verificationStatus === 'unavailable') return 'Implemented — checks unavailable';
          return 'Implemented — verification pending';
        };
        const streamRenderer = createStudioStreamRenderer(body);
        const syncLiveWorkspacePreview = async () => {
          const serverState = await loadServerStudioProjectState();
          if (!Array.isArray(serverState?.files)) {
            throw new Error('The updated project files were not returned by the server.');
          }
          projectFiles = serverState.files.map((file) => ({
            name: file.path,
            type: 'file',
            status: 'synced',
            content: String(file.content || '')
          }));
          renderFileExplorer();
          renderEditor();
          refreshPreviewFromWorkspace();
        };
        const getFileChangeLabel = (action) => ({
          create_file: 'Created',
          append_to_file: 'Created',
          update_file: 'Edited',
          replace_in_file: 'Edited',
          delete_file: 'Deleted',
          move_file: 'Moved'
        }[action] || 'Edited');
        const handleEvent = (eventText) => {
          const data = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') return;
          let payload;
          try { payload = JSON.parse(data); } catch (error) { return; }
          if (payload.type === 'thinking_summary') {
            const message = payload.message || 'Reviewing the project and planning the next step.';
            if (body) body.innerHTML = `<span class="studio-streaming-card__status">${escapeHtml(message)}</span>`;
            workflowEntries.push({ title: payload.title || 'Progress update', state: 'running', summary: message, detail: 'A concise update on the work in progress.', files: [], next: 'Continue with the next project step.' });
            renderActivity(message);
            renderStudioActionHistory(workflowEntries);
          } else if (payload.type === 'step_explanation') {
            const progressText = typeof payload.summary === 'string' ? payload.summary.trim() : '';
            pendingProgressExplanation = progressText;
          } else if (payload.type === 'implementation_summary') {
            // Keep the full payload (summary, files, implemented) so finalization logic
            // can distinguish 'applied' vs 'inspection/suggested' runs.
            implementationSummaryPayload = payload;
            implementationSummaryReady = true;
            verificationStatus = payload.verification_status || 'pending';
            if (Array.isArray(payload.verification_results)) {
              verificationResults.splice(0, verificationResults.length, ...payload.verification_results);
            }
            if (Array.isArray(payload.feature_checklist)) {
              featureChecklist.splice(0, featureChecklist.length, ...payload.feature_checklist);
            }
            renderActivity(getCompletionLabel());
          } else if (payload.type === 'verification_result') {
            const existingIndex = verificationResults.findIndex((item) => item.check === payload.check && item.script === payload.script);
            if (existingIndex >= 0) verificationResults[existingIndex] = payload;
            else verificationResults.push(payload);
            if (payload.status === 'failed') verificationStatus = 'failed';
            else if (payload.status === 'unavailable' && verificationStatus !== 'failed') verificationStatus = 'unavailable';
            renderActivity(payload.status === 'passed'
              ? `Verification passed: ${payload.check.replaceAll('_', ' ')}`
              : payload.status === 'failed'
                ? `Verification failed: ${payload.check.replaceAll('_', ' ')}`
                : payload.status === 'observed'
                  ? `Smoke check observed: ${payload.check.replaceAll('_', ' ')}`
                  : `Verification unavailable: ${payload.check.replaceAll('_', ' ')}`);
          } else if (payload.type === 'feature_status') {
            const existingIndex = featureChecklist.findIndex((item) => item.feature?.toLocaleLowerCase() === payload.feature?.toLocaleLowerCase());
            if (existingIndex >= 0) featureChecklist[existingIndex] = payload;
            else featureChecklist.push(payload);
            renderActivity('Updating the feature checklist');
          } else if (payload.type === 'tool_started') {
            const title = payload.title || 'Working with the project';
            const summary = payload.summary || 'Applying a project operation.';
            if (body) body.innerHTML = `<span class="studio-streaming-card__status">${escapeHtml(summary)}</span>`;
            const paths = Array.isArray(payload.paths) ? payload.paths.filter((path) => typeof path === 'string' && path.trim()) : [];
            workflowEntries.push({
              title,
              state: 'running',
              summary,
              paths,
              explanation: paths.length ? (payload.explanation || pendingProgressExplanation) : '',
              detail: 'Studio is working with the project files and will report the result.',
              files: [],
              next: 'Check the operation result.'
            });
            renderActivity(summary);
            renderStudioActionHistory(workflowEntries);
          } else if (payload.type === 'tool_completed') {
            const completionSummary = payload.summary || (payload.result?.ok ? 'The project step is complete.' : payload.result?.error || 'The project step could not be completed.');
            if (body) body.innerHTML = `<span class="studio-streaming-card__status">${escapeHtml(completionSummary)}</span>`;
            const entry = workflowEntries[workflowEntries.length - 1];
            if (entry) { entry.state = payload.result?.ok ? 'done' : 'error'; entry.summary = completionSummary; }
            renderActivity(completionSummary);
            renderStudioActionHistory(workflowEntries);
          } else if (payload.type === 'file_changed') {
            const changeLabel = getFileChangeLabel(payload.action);
            if (body) body.innerHTML = `<span class="studio-streaming-card__status">${changeLabel} ${escapeHtml(payload.path || 'project files')}</span>`;
            const entry = workflowEntries[workflowEntries.length - 1];
            if (entry) entry.files = [...new Set([...(entry.files || []), payload.path])];
            if (payload.path && !fileChanges.some((change) => change.path === payload.path)) fileChanges.push({ action: payload.action || 'update_file', label: changeLabel, path: payload.path });
            renderActivity(`${changeLabel} ${payload.path || 'project files'}`);
            renderStudioActionHistory(workflowEntries);
            workspaceSync = workspaceSync.then(async () => {
              await syncLiveWorkspacePreview();
              const previewStatus = `Preview updated after changes to ${payload.path || 'project files'}.`;
              if (activityState) activityState.textContent = previewStatus;
              if (body) body.textContent = previewStatus;
            }).catch((error) => {
              previewSyncFailed = true;
              console.warn('Unable to refresh the Studio preview after a file change:', error);
              renderActivity('Preview refresh failed');
              activity?.classList.add('is-error');
              if (activity) activity.open = true;
              if (body) body.textContent = 'Code updated, but the preview could not be refreshed.';
            });
          } else if (payload.type === 'preview_device') {
            const selected = setStudioPreviewDevice(payload);
            const deviceName = selected.viewport === 'tablet'
              ? 'iPad'
              : selected.viewport === 'mobile'
                ? 'phone'
                : 'desktop';
            const summary = `Switched the preview to ${deviceName}${selected.viewport === 'desktop' ? '' : ` (${selected.width} × ${selected.height}, DPR ${selected.dpr})`}.`;
            const entry = workflowEntries[workflowEntries.length - 1];
            if (entry) {
              entry.state = 'done';
              entry.summary = summary;
            }
            renderActivity(summary);
            if (body) body.textContent = summary;
            renderStudioActionHistory(workflowEntries);
          } else if (payload.type === 'response_started') {
            if (implementationSummaryReady) {
              const completionLabel = getCompletionLabel();
              renderActivity(completionLabel);
              if (completionLabel === 'Completed' && activity) activity.classList.add('is-complete');
              else if (completionLabel.startsWith('Implemented —')) activity?.classList.add(verificationStatus === 'failed' ? 'is-error' : 'is-pending');
              else activity?.classList.add('is-review');
            } else renderActivity('Writing the final response...');
            if (body) {
              body.setAttribute('aria-busy', 'true');
              body.innerHTML = '<span class="studio-streaming-card__status">Responding...</span>';
            }
          } else if (payload.type === 'response_delta') {
            if (typeof payload.delta !== 'string' || !payload.delta) return;
            finalText += payload.delta;
            if (body) {
              body.classList.add('studio-card__body--streaming');
              streamRenderer.append(payload.delta);
            }
            scrollBackendAgentToLatest();
          } else if (payload.type === 'final_response') {
            finalText = payload.content || finalText;
            workflowSucceeded = !workflowEntries.some((entry) => entry.state === 'error');
            if (body) {
              body.classList.add('studio-card__body--streaming');
            }
            // ensure any running steps are marked done
            workflowEntries.forEach((entry) => { if (entry.state === 'running') entry.state = 'done'; });
            // Determine whether actual changes were applied. Prefer the implementation_summary's
            // implemented flag if available, otherwise fall back to whether fileChanges were recorded.
            const completionLabel = getCompletionLabel();
            renderActivity(previewSyncFailed ? 'Preview refresh failed' : workflowSucceeded ? completionLabel : 'Completed with issues');
            renderStudioActionHistory(workflowEntries.map((entry) => ({ ...entry, state: entry.state === 'running' ? 'done' : entry.state })));
          } else if (payload.type === 'error') {
            workflowSucceeded = false;
            finalText = payload.message || 'The Studio agent could not complete the request.';
            renderActivity('Unable to complete');
            activity?.classList.add('is-error');
            renderStudioActionHistory(workflowEntries.map((entry) => ({ ...entry, state: 'error', summary: finalText })));
          }
          scrollBackendAgentToLatest();
        };
        try {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            events.filter(Boolean).forEach(handleEvent);
            if (done) break;
          }
          if (buffer.trim()) handleEvent(buffer);
        } catch (error) {
          const message = error.message || 'The agent response could not be rendered.';
          await streamRenderer.finish(message);
          if (body) {
            body.classList.remove('studio-card__body--streaming');
            body.removeAttribute('aria-busy');
            body.innerHTML = `<p>${escapeHtml(message)}</p>`;
          }
          renderActivity('Unable to complete');
          activity?.classList.add('is-error');
          renderStudioActionHistory(workflowEntries.map((entry) => ({ ...entry, state: 'error', summary: message })));
          throw error;
        }
        if (!finalText) {
          finalText = 'The Studio agent ended without a final response. Please try the request again.';
          if (body) {
            body.classList.add('studio-card__body--streaming');
          }
          renderActivity('No final response');
          activity?.classList.add('is-error');
          renderStudioActionHistory(workflowEntries.map((entry) => ({ ...entry, state: 'error', summary: finalText })));
        }
        await streamRenderer.finish(finalText);
        if (body) body.innerHTML = parseMarkdown(finalText);
        await workspaceSync;
        if (previewSyncFailed) {
          verificationStatus = 'failed';
          verificationResults.push({
            check: 'preview_refresh',
            status: 'failed',
            passed: false,
            detail: 'Updated files could not be reloaded in the Studio preview.'
          });
          renderActivity('Preview refresh failed');
        }
        if (activity && workflowSucceeded && !previewSyncFailed && verificationStatus === 'passed' && implementationSummaryPayload?.implemented) {
          activity.classList.add('is-complete');
          activity.open = false;
        } else if (activity && workflowSucceeded && !previewSyncFailed && !implementationSummaryPayload?.implemented) {
          activity.classList.add('is-review');
          activity.open = true;
        } else if (activity && workflowSucceeded && !previewSyncFailed && verificationStatus !== 'failed') {
          activity.classList.add('is-pending');
          activity.open = true;
        } else if (activity) {
          activity.classList.add('is-error');
          activity.open = true;
        }
        if (body) {
          body.classList.remove('studio-card__body--streaming');
          body.removeAttribute('aria-busy');
        }
        const serverState = await loadServerStudioProjectState();
        if (serverState?.files?.length) {
          projectFiles = serverState.files.map((file) => ({ name: file.path, type: 'file', status: 'synced', content: String(file.content || '') }));
          renderFileExplorer();
          renderEditor();
          refreshPreviewFromWorkspace();
        }
        await window.KieltechStudioChat?.persist(
          'assistant',
          finalText,
          studioModelDisplayNames[studioSelectedModel] || studioSelectedModel,
          workflowEntries.length
            ? {
                workspaceTask: true,
                workflowEntries: workflowEntries.map((entry) => ({ ...entry, state: entry.state === 'running' ? 'done' : entry.state })),
                featureChecklist,
                verificationStatus,
                verificationResults
              }
            : {}
        );
        window.clearInterval(runtimeTimer);
        updateRuntime(true);
        return finalText;
      };

      const clearSubmittedStudioPrompt = () => {
        if (!studioPromptInput) return;
        studioPromptInput.value = '';
        studioPromptInput.style.height = '42px';
        studioPromptInput.dispatchEvent(new Event('input', { bubbles: true }));
      };

      const clearSubmittedStudioContext = () => {
        selectedStudioContext = [];
        renderStudioContextChips();
      };

      const classifyStudioRequest = (promptText) => {
        const prompt = String(promptText || '').trim();
        const actionVerbs = '(?:implement|create|make|build|generate|design|add|write|edit|update|modify|fix|refactor|improve|remove|delete|rename|move|apply|change|restyle|redesign)';
        const explicitChange = new RegExp(
          `^(?:(?:please|could you|can you|would you|i want you to|i need you to|i'd like you to|i want to|i need to|i'd like to|let's|lets|help me)\\s+)*(?:please\\s+)?(?:${actionVerbs})\\b`,
          'i'
        );
        const requestedChange = new RegExp(
          `\\b(?:please|i want you to|i need you to|i'd like you to|i want to|i need to|i'd like to|could you|can you|would you|let's|lets)\\s+(?:please\\s+)?(?:help me\\s+)?(?:${actionVerbs})\\b`,
          'i'
        );
        const projectGap = /\b(?:my|this|the)\s+(?:website|site|landing page|page|app|project|workspace)\s+(?:needs|should have|is missing|does not have|doesn't have)\b/i;
        if (explicitChange.test(prompt) || requestedChange.test(prompt) || projectGap.test(prompt)) {
          return { mode: 'workspace', reason: 'The request asks for a concrete project change.' };
        }
        return { mode: 'conversation', reason: 'The request asks for information or discussion, not a project change.' };
      };

      const runStudioGeneration = async () => {
        const rawPromptText = studioPromptInput?.value?.trim() || '';
        const promptText = resolveSuggestedFeatureChoice(rawPromptText);
        const requestClassification = classifyStudioRequest(promptText);
        if (!state.token) {
          showStudioAuthModal();
          return;
        }
        if (!promptText) {
          setStudioStatus('Write a prompt first so the studio can help.', 'error');
          return;
        }

        const submittedContext = [...selectedStudioContext];
        clearSubmittedStudioPrompt();
        clearSubmittedStudioContext();
        window.KieltechStudioChat?.persist('user', rawPromptText);
        window.KieltechStudioChat?.render();
        clearStudioRunArtifact();
        currentWorkflowRunId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        if (requestClassification.mode !== 'workspace') {
          studioAbortController = new AbortController();
          studioIsGenerating = true;
          studioAutoScrollEnabled = true;
          updateStudioActionState();
          const chatHistory = document.querySelector('.studio-chat-history');
          const aiCard = document.createElement('div');
          aiCard.className = 'studio-card studio-card--ai';
          aiCard.innerHTML = '<div class="studio-card__body" aria-live="polite"></div>';
          chatHistory?.appendChild(aiCard);
          try {
            const answer = await streamStudioConversation(promptText, aiCard.querySelector('.studio-card__body'));
            window.KieltechStudioChat?.persist('assistant', answer, studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
          } catch (error) {
            const body = aiCard.querySelector('.studio-card__body');
            body.classList.remove('studio-card__body--streaming');
            body.textContent = error.name === 'AbortError'
              ? 'Generation stopped.'
              : error.message || 'The conversation could not be completed.';
          } finally {
            aiCard.querySelector('.studio-card__body')?.classList.remove('studio-card__body--streaming');
            studioIsGenerating = false;
            studioAbortController = null;
            updateStudioActionState();
            clearStudioRunArtifact();
          }
          return;
        }

        studioAbortController = new AbortController();
        studioIsGenerating = true;
        studioAutoScrollEnabled = true;
        updateStudioActionState();
        try {
          await streamBackendStudioAgent(promptText, submittedContext);
        } catch (error) {
          setStudioStatus(error.message || 'The Studio agent could not complete the request.', 'error');
        } finally {
          const runtimeLabel = Array.from(document.querySelectorAll('.studio-chat-history .studio-card--ai [data-studio-runtime]'))
            .reverse()
            .find((label) => label.closest('.studio-card')?.dataset.studioRunId === currentWorkflowRunId);
          if (runtimeLabel) {
            window.clearInterval(Number(runtimeLabel.dataset.studioRuntimeTimer));
            const startedAt = Number(runtimeLabel.dataset.studioRuntimeStartedAt);
            const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
            runtimeLabel.textContent = `Ran for ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
            delete runtimeLabel.dataset.studioRuntimeTimer;
          }
          studioIsGenerating = false;
          studioAbortController = null;
          updateStudioActionState();
        }
        return;

        studioRunStartedAt = Date.now();
        studioRunElapsedMs = 0;

        // Pause the runtime ticker and mark as running
        if (studioAiRuntime && typeof studioAiRuntime._clearInterval === 'function') {
          studioAiRuntime._clearInterval();
        }
        if (studioAiRuntime) studioAiRuntime.textContent = 'Running';

        studioAbortController = new AbortController();
        studioIsGenerating = true;
          studioAutoScrollEnabled = true;
        updateStudioActionState();
          window.requestAnimationFrame(scrollStudioToLatest);
        if (studioPromptInput) {
          if (typeof adjustStudioTextarea === 'function') adjustStudioTextarea(studioPromptInput);
          updateStudioActionState();
          window.requestAnimationFrame(() => {
            if (studioIsGenerating) {
              studioPromptInput.style.height = '42px';
            }
          });
        }

        const workflowSteps = [
          {
            title: 'Scan workspace',
            state: 'running',
            summary: requestClassification.reason,
            detail: 'The agent is locating the owning files before it proposes any change.',
            files: ['Frontend/script.js', 'Frontend/styles.css', 'Frontend/web-development-studio.html'],
            next: 'Read the relevant files and create a concise implementation plan.'
          },
          {
            title: 'Analyze and plan',
            state: 'queued',
            summary: 'Reading relevant file contents and turning the request into a focused plan.',
            detail: 'The agent uses the workspace context to select file actions and verification steps.',
            files: ['Frontend/script.js', 'Frontend/styles.css'],
            next: 'Execute the selected file and folder actions.'
          },
          {
            title: 'Execute workspace actions',
            state: 'queued',
            summary: 'Reading, creating, updating, or removing the requested files through workspace tools.',
            detail: 'Each file action is collected into a reviewable patch before it is applied.',
            files: [],
            next: 'Verify the result and prepare the change review.'
          },
          {
            title: 'Verify result',
            state: 'queued',
            summary: 'Checking the resulting files, preview, and relevant behavior before completion.',
            detail: 'Validation confirms the requested workflow works and highlights anything that needs review.',
            files: [],
            next: 'Review the patch and choose Keep or Reject.'
          }
        ];
        renderStudioActionHistory(workflowSteps);
        let workflowPulseTimer = null;
        try {
          const workspaceContext = buildWorkspaceContext();
          workflowSteps[0].summary = 'Scanning project files and folders...';
          workflowSteps[0].detail = 'Reading the workspace map and bounded source snapshots to locate the files relevant to this request.';
          workflowSteps[0].files = getWorkspaceFiles().slice(0, 12).map((file) => file.path);
          renderStudioActionHistory(workflowSteps);
          await waitForStudioStep(500);
          workflowSteps[0].state = 'done';
          workflowSteps[1].state = 'running';
          workflowSteps[1].summary = 'Preparing a concise implementation plan.';
          workflowSteps[1].detail = 'The AI is preparing a user-facing plan before any workspace action runs.';
          renderStudioActionHistory(workflowSteps);

          const planRequestTimeout = window.setTimeout(() => studioAbortController?.abort(), 45000);
          let streamedPlan = '';
          try {
            streamedPlan = await streamStudioPlan(promptText, workflowSteps);
          } finally {
            window.clearTimeout(planRequestTimeout);
          }
          if (streamedPlan) {
            workflowSteps[1].summary = streamedPlan;
          }
          workflowSteps[1].state = 'done';
          workflowSteps[2].state = 'running';
          const executionMessages = [
            'Pinpointing relevant files and dependencies...',
            'Creating the requested file and folder structure...',
            'Editing existing source files...',
            'Checking paths, extensions, and source consistency...'
          ];
          let executionMessageIndex = 0;
          workflowPulseTimer = window.setInterval(() => {
            workflowSteps[2].summary = executionMessages[executionMessageIndex % executionMessages.length];
            workflowSteps[2].detail = 'The agent is working through the selected workspace actions.';
            executionMessageIndex += 1;
            renderStudioActionHistory(workflowSteps);
          }, 700);
          renderStudioActionHistory(workflowSteps);

          const workspaceTools = [
            {
              type: 'function',
              function: {
                name: 'create_file',
                description: 'Create any text-based file at any relative path. Parent folders and subfolders are created automatically. Preserve the exact filename and extension requested by the user.',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'Any relative file path, including nested folders and any extension, such as src/components/Button.tsx, app/routes/api.py, config.json, or docs/README.md' },
                    content: { type: 'string', description: 'The full file contents to write.' }
                  },
                  required: ['path', 'content']
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'update_file',
                description: 'Update an existing text-based file at any relative path and preserve its requested extension.',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    content: { type: 'string' }
                  },
                  required: ['path', 'content']
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read any existing workspace file at any relative path before planning a change.',
                parameters: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                  required: ['path']
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'delete_file',
                description: 'Delete any existing workspace file at a relative path.',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
              }
            },
            {
              type: 'function',
              function: {
                name: 'list_files',
                description: 'List files in the workspace so the agent can choose the right target.',
                parameters: { type: 'object', properties: {}, additionalProperties: false }
              }
            },
            {
              type: 'function',
              function: {
                name: 'search_web',
                description: 'Search Wikipedia when the request depends on uncertain public concepts or documentation. Use concise queries and summarize sources before proposing code changes.',
                parameters: {
                  type: 'object',
                  properties: { query: { type: 'string', minLength: 2, maxLength: 240 } },
                  required: ['query']
                }
              }
            }
          ];

          const workspaceFirstIntent = /(?:create|make|build|generate|design|add|write|edit|update|modify|fix|new).*?(?:website|site|landing page|page|demo|app|ui|component|file|project)|(?:website|site|landing page|demo|app|page).*(?:create|make|build|generate|design|add|write|edit|update|modify|fix)/i.test(promptText);

          const payload = {
            prompt: `Request mode: ${requestClassification.mode}\nClassification: ${requestClassification.reason}\n\nProject brief: ${requestPayload.projectBrief}\n\n${workspaceContext}\n\nSelected AI: ${requestPayload.selectedAi.name} (${requestPayload.selectedAi.category})\n\nUser-facing plan: ${streamedPlan || 'Create a focused implementation plan from the workspace context.'}\n\nWorkspace capability: You may create any number of text-based files, use any requested extension, and create nested folders implicitly through relative paths. Return one file tool call per distinct file and preserve exact paths.\n\nUser instruction: ${promptText}`,
            system_instructions: `You are a coding agent running inside the KielTech Studio, and your behavior should match a real AI coding assistant like Google AI Studio. Your default workflow is tool-first, not chat-first.\n\nPriority rules:\n1. If the user asks to create, build, edit, modify, generate, fix, add, implement, improve, or support a feature, always inspect relevant files and return the appropriate workspace tool calls. Do not answer with generic prose.\n2. Requests prefixed with "Implement this workspace change:" are mandatory file-change requests, even when they describe a small UX or accessibility improvement.\n3. For website, landing page, demo, UI, or app creation requests, immediately choose create_file or update_file and prepare the patch review.\n4. If the user names multiple files, return one separate tool call for each named file. Never combine multiple files into one generic create_file call.\n5. If the user asks for help, explanation, or concept guidance without requesting a file change, you may answer informationally without a tool.\n6. Provide a concise natural-language explanation after tool use, but do not use literal labels such as Reasoning:, Action:, or Verification:.\n7. Never say "I can help" without taking the requested action.\n8. Keep explanations concise and action-oriented.\n\nWorkspace-first intent override: ${workspaceFirstIntent ? 'This prompt is clearly a workspace creation task, so file tools are mandatory.' : 'This prompt is not clearly a workspace creation task, so normal tool selection still applies.'}`,
            model: studioSelectedModel,
            temperature: 0.5,
            max_tokens: 900,
            stream: false,
            tools: workspaceTools,
            tool_choice: 'required'
          };

          const workspaceRequestTimeout = window.setTimeout(() => studioAbortController?.abort(), 75000);
          let response;
          try {
            response = await request('/v1/chat/completions', {
              method: 'POST',
              body: JSON.stringify(payload),
              signal: studioAbortController.signal
            });
          } finally {
            window.clearTimeout(workspaceRequestTimeout);
          }

          if (workflowPulseTimer) {
            window.clearInterval(workflowPulseTimer);
            workflowPulseTimer = null;
          }

          if (!studioIsGenerating) {
            return;
          }

          const reply = response?.response?.output?.text || response?.response?.text || response?.reply || response?.output || response?.message || response?.choices?.[0]?.message?.content || 'The AI prepared the requested workspace action for review.';
          const replyText = typeof reply === 'string' ? reply : JSON.stringify(reply);
          const structuredTools = parseStudioToolCalls(replyText, response);
          const patchActionTools = ['create_file', 'update_file', 'delete_file'];
          let patchToolCalls = structuredTools.filter((toolCall) => patchActionTools.includes(String(toolCall.tool || toolCall.action || '').toLowerCase()));
          patchToolCalls = dedupeWorkspaceToolCalls(patchToolCalls);
          const inspectedFiles = structuredTools
            .filter((toolCall) => ['read_file', 'list_files'].includes(String(toolCall.tool || toolCall.action || '').toLowerCase()))
            .map((toolCall) => normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || 'workspace'))
            .filter(Boolean);
          if (inspectedFiles.length) {
            workflowSteps[0].files = [...new Set(inspectedFiles)];
            workflowSteps[0].summary = `Read ${inspectedFiles.join(', ')} to understand the current implementation.`;
            workflowSteps[0].detail = 'The agent inspected the existing file contents before preparing the proposed changes.';
          } else {
            workflowSteps[0].summary = 'Workspace files and folders were mapped for the request.';
          }
          renderStudioActionHistory(workflowSteps);
          const structuredTool = patchToolCalls[0] || structuredTools[0] || null;
          const progressSummary = buildStudioProgressSummary(promptText, replyText, structuredTool);
          const isWebsiteCreationRequest = /(?:website|site|landing page|demo|blue theme|ui|page).*(?:create|make|build|generate|design|add)|(?:create|make|build|generate|design|add).*(?:website|site|landing page|demo|page)/i.test(promptText);

          if (!patchToolCalls.length && isWebsiteCreationRequest) {
            const defaultHtmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Blue Demo</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="hero">
      <nav class="topbar">
        <div class="brand">KielTech</div>
        <div class="nav-links">
          <a href="#about">About</a>
          <a href="#features">Features</a>
          <a href="#contact">Contact</a>
        </div>
      </nav>
      <div class="hero-inner">
        <div>
          <p class="eyebrow">Live demo</p>
          <h1>Blue themed website</h1>
          <p class="lead">A polished demo page built with a clean blue palette and modern structure.</p>
          <button>Get started</button>
        </div>
      </div>
    </header>
    <main>
      <section id="about" class="panel">
        <h2>About</h2>
        <p>This demo page shows how a blue theme can look in a modern product website.</p>
      </section>
      <section id="features" class="panel">
        <h2>Features</h2>
        <ul>
          <li>Clean layout</li>
          <li>Professional contrast</li>
          <li>Responsive sections</li>
        </ul>
      </section>
      <section id="contact" class="panel">
        <h2>Contact</h2>
        <p>hello@example.com</p>
      </section>
    </main>
  </body>
</html>`;

            const defaultCssContent = `:root {
  --bg: #edf6ff;
  --panel: #dfeeff;
  --primary: #0b63d9;
  --primary-dark: #0a4eb3;
  --text: #12315c;
  --muted: #365c8f;
  --white: #ffffff;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: linear-gradient(180deg, #edf6ff 0%, #dfeeff 100%);
  color: var(--text);
}

.hero {
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
  color: var(--white);
  padding: 1rem 0 4rem;
}

.topbar {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.brand {
  font-size: 1.3rem;
  font-weight: 700;
}

.nav-links {
  display: flex;
  gap: 1.2rem;
}

.nav-links a {
  color: var(--white);
  opacity: 0.9;
  text-decoration: none;
}

.hero-inner {
  max-width: 1100px;
  margin: 3rem auto 0;
  padding: 0 2rem;
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.7rem;
  opacity: 0.9;
}

.hero h1 {
  font-size: clamp(2.2rem, 4vw, 3.8rem);
  margin: 0.4rem 0 0.8rem;
}

.lead {
  max-width: 600px;
  font-size: 1.1rem;
  line-height: 1.6;
  opacity: 0.95;
}

button {
  border: 0;
  background: var(--white);
  color: var(--primary-dark);
  padding: 0.85rem 1.5rem;
  border-radius: 999px;
  font-weight: 700;
  cursor: pointer;
}

main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem;
  display: grid;
  gap: 1.5rem;
}

.panel {
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(11, 99, 217, 0.12);
  border-radius: 18px;
  padding: 1.5rem 1.8rem;
  box-shadow: 0 10px 30px rgba(11, 99, 217, 0.08);
}

.panel h2 {
  margin-top: 0;
  color: var(--primary-dark);
}

ul {
  margin: 0;
  padding-left: 1.2rem;
  line-height: 1.8;
}
`;

            patchToolCalls = [
              { tool: 'create_file', path: 'index.html', content: defaultHtmlContent, summary: 'Create the requested demo page' },
              { tool: 'create_file', path: 'styles.css', content: defaultCssContent, summary: 'Create the requested blue theme stylesheet' }
            ];
          }

          const plannedFiles = [...new Set(patchToolCalls.map((toolCall) => normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '')).filter(Boolean))];
          workflowSteps[0].files = plannedFiles.length ? plannedFiles : workflowSteps[0].files;
          workflowSteps[1].summary = reasoningSummary || workflowSteps[1].summary;
          workflowSteps[1].detail = 'The model generated this plan from the request, workspace context, and selected file actions.';
          workflowSteps[1].files = plannedFiles.length ? plannedFiles : workflowSteps[1].files;
          workflowSteps[2].files = plannedFiles;
          workflowSteps[2].tools = patchToolCalls.map((toolCall) => {
            const action = String(toolCall.tool || toolCall.action || 'workspace').toLowerCase();
            return {
              label: action === 'create_file' ? 'Create file' : action === 'update_file' ? 'Update file' : action === 'delete_file' ? 'Delete file' : action.replace(/_/g, ' '),
              icon: action === 'create_file' ? 'add_box' : action === 'update_file' ? 'edit_document' : action === 'delete_file' ? 'delete' : 'build',
              path: normalizeStudioToolPath(toolCall.path || toolCall.file || toolCall.target || '')
            };
          });
          workflowSteps[2].state = 'queued';
          workflowSteps[2].summary = plannedFiles.length
            ? `Ready to execute ${plannedFiles.length} file operation${plannedFiles.length === 1 ? '' : 's'} after approval.`
            : workflowSteps[2].summary;
          workflowSteps[2].next = 'Review and approve the patch to execute it.';
          workflowSteps[3].state = 'queued';
          workflowSteps[3].summary = 'Waiting for the approved workspace actions to finish.';
          renderStudioActionHistory(workflowSteps);

          if (patchToolCalls.length) {
            const patchActions = buildStudioPatchActions(patchToolCalls);
            const patchFiles = patchActions.map((action) => action.path);
            studioPendingPatch = {
              toolCall: patchToolCalls[0],
              promptText,
              reasoningSummary,
              summary: patchToolCalls[0].summary || 'Workspace patch requested',
              files: patchFiles,
              actions: patchActions
            };
            renderStudioProgressPanel(replyText, promptText);
            renderStudioSuggestions(promptText, progressSummary);
            setStudioTab('preview');
            placeCompletedActionHistoryBelowChat();
            workflowSteps[2].state = 'running';
            workflowSteps[2].summary = patchActions.map((action) => `${action.action === 'create_file' ? 'Creating' : action.action === 'update_file' ? 'Editing' : 'Deleting'} ${action.path}`).join(' | ');
            workflowSteps[2].tools = patchActions.map((action) => ({
              label: action.action === 'create_file' ? 'Creating' : action.action === 'update_file' ? 'Editing' : 'Deleting',
              icon: action.action === 'create_file' ? 'add_box' : action.action === 'update_file' ? 'edit_document' : 'delete',
              path: action.path
            }));
            renderStudioActionHistory(workflowSteps);
            await approveStudioPatchAndExplain(workflowSteps);
          } else if (structuredTool) {
            const toolApplied = execStudioToolCall(structuredTool, promptText);
            renderStudioProgressPanel(toolApplied ? progressSummary : replyText, promptText);
            renderStudioSuggestions(promptText, progressSummary);
            window.KieltechStudioChat?.persist('assistant', toolApplied ? progressSummary : replyText, requestPayload.selectedAi?.name || studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
            window.KieltechStudioChat?.render();
            loadAppPreview(resolveBuildPreviewUrl());
            setStudioTab('preview');
            if (!toolApplied) {
              renderStudioActionHistory([
                { title: 'Inspect workspace', state: 'error', summary: reasoningSummary || 'The requested workspace item could not be inspected.', detail: 'The file or folder was not found in the current workspace. No files were changed.', files: structuredTool.path ? [structuredTool.path] : [], next: 'Check the path or ask the agent to list the workspace files first.' }
              ]);
            }
          } else {
            renderStudioProgressPanel(progressSummary, promptText);
            renderStudioSuggestions(promptText, progressSummary);
            window.KieltechStudioChat?.persist('assistant', progressSummary, requestPayload.selectedAi?.name || studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
            window.KieltechStudioChat?.render();
            loadAppPreview(resolveBuildPreviewUrl());
            setStudioTab('preview');
            setStudioStatus('The studio responded without a required file tool call. Review the answer and continue manually.', 'info');
          }

          studioHistory.unshift({
            id: `${Date.now()}`,
            prompt: promptText,
            createdAt: new Date().toISOString()
          });
          studioHistory = studioHistory.slice(0, 6);
          localStorage.setItem(historyStorageKey, JSON.stringify(studioHistory));
          renderStudioHistory();
        } catch (error) {
          if (workflowPulseTimer) {
            window.clearInterval(workflowPulseTimer);
            workflowPulseTimer = null;
          }
          if (error.name === 'AbortError') {
            setStudioStatus('AI action stopped by user.', 'info');
          } else {
            const message = error.message || 'Unable to reach the AI studio.';
            setStudioStatus('The AI action could not be completed because the studio backend is unavailable.', 'error');
            if (studioPreviewPanel) {
              studioPreviewPanel.innerHTML = '<div class="studio-output-card"><div class="studio-output-card__eyebrow">Studio unavailable</div><p>The AI action could not be completed. Please try again when the studio backend is running.</p></div>';
            }
          }
        } finally {
          if (workflowPulseTimer) {
            window.clearInterval(workflowPulseTimer);
            workflowPulseTimer = null;
          }
          studioIsGenerating = studioPendingPatch ? true : false;
          studioAbortController = null;
          updateStudioActionState();
          // Show completed and the elapsed time since request creation
          if (studioAiRuntime) {
            const createdAt = requestPayload?.createdAt ? new Date(requestPayload.createdAt) : null;
            const diffSeconds = createdAt && !Number.isNaN(createdAt.getTime())
              ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000))
              : 0;
            const minutes = Math.floor(diffSeconds / 60);
            const seconds = diffSeconds % 60;
            const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            studioAiRuntime.textContent = `Ran for ${formattedTime}`;
          }
        }
      };

      const adjustStudioTextarea = (el) => {
        if (!el) return;
        try {
          el.style.height = 'auto';
          const max = Number(el.getAttribute('data-max-height')) || 360;
          const defaultHeight = 42;
          const nextHeight = Math.max(defaultHeight, Math.min(max, el.scrollHeight));
          el.style.height = `${nextHeight}px`;
        } catch (e) {
          // ignore
        }
      };

      const resetStudioTextarea = () => {
        if (!studioPromptInput) return;
        studioPromptInput.value = '';
        studioPromptInput.style.height = 'auto';
        const max = Number(studioPromptInput.getAttribute('data-max-height')) || 360;
        studioPromptInput.style.height = `${Math.min(max, 42)}px`;
        updateStudioActionState();
      };

      let studioVoiceRecognition = null;
      let studioVoiceRecorder = null;
      let studioVoiceStream = null;
      let studioVoiceUsingRecorder = false;
      let studioVoiceListening = false;
      let studioVoiceSilenceTimer = null;
      let studioVoiceAutoSendPending = false;
      let studioVoiceDraftPrefix = '';
      let studioVoiceFinalTranscript = '';

      const clearStudioVoiceSilenceTimer = () => {
        if (studioVoiceSilenceTimer) window.clearTimeout(studioVoiceSilenceTimer);
        studioVoiceSilenceTimer = null;
      };

      const scheduleStudioVoiceAutoSend = () => {
        clearStudioVoiceSilenceTimer();
        studioVoiceSilenceTimer = window.setTimeout(() => {
          studioVoiceSilenceTimer = null;
          if (!studioVoiceListening || !studioPromptInput?.value.trim()) return;
          studioVoiceAutoSendPending = true;
          studioVoiceRecognition?.stop();
        }, 2000);
      };

      const setStudioVoiceState = (isListening) => {
        studioVoiceListening = isListening;
        studioVoiceButton?.classList.toggle('is-listening', isListening);
        studioVoiceButton?.setAttribute('aria-pressed', isListening ? 'true' : 'false');
        studioVoiceButton?.setAttribute('aria-label', isListening ? 'Stop voice input' : 'Voice input');
        studioVoiceButton?.setAttribute('title', isListening ? 'Stop voice input' : 'Voice input');
        const icon = studioVoiceButton?.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = isListening ? 'stop' : 'mic';
      };

      const startBrowserStudioVoiceInput = () => {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
          setStudioStatus('Voice input is not supported in this browser.', 'error');
          return;
        }

        if (!studioVoiceRecognition) {
          studioVoiceRecognition = new Recognition();
          studioVoiceRecognition.continuous = true;
          studioVoiceRecognition.interimResults = true;
          studioVoiceRecognition.lang = document.documentElement.lang || 'en-US';
          studioVoiceRecognition.onresult = (event) => {
            let interimTranscript = '';
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
              const transcript = event.results[index][0].transcript;
              if (event.results[index].isFinal) studioVoiceFinalTranscript += transcript;
              else interimTranscript += transcript;
            }
            if (!studioPromptInput) return;
            const voiceText = `${studioVoiceFinalTranscript} ${interimTranscript}`.trim();
            studioPromptInput.value = studioVoiceDraftPrefix ? `${studioVoiceDraftPrefix} ${voiceText}` : voiceText;
            studioPromptInput.dispatchEvent(new Event('input', { bubbles: true }));
            studioPromptInput.focus();
            scheduleStudioVoiceAutoSend();
          };
          studioVoiceRecognition.onerror = (event) => {
            clearStudioVoiceSilenceTimer();
            studioVoiceAutoSendPending = false;
            if (event.error !== 'aborted') setStudioStatus(`Voice input error: ${event.error || 'unknown error'}.`, 'error');
            setStudioVoiceState(false);
          };
          studioVoiceRecognition.onend = () => {
            setStudioVoiceState(false);
            if (studioVoiceAutoSendPending) {
              studioVoiceAutoSendPending = false;
              window.setTimeout(() => runStudioGeneration(), 0);
            }
          };
        }

        try {
          clearStudioVoiceSilenceTimer();
          studioVoiceAutoSendPending = false;
          studioVoiceDraftPrefix = studioPromptInput?.value.trim() || '';
          studioVoiceFinalTranscript = '';
          studioVoiceRecognition.start();
          setStudioVoiceState(true);
        } catch (error) {
          setStudioStatus('Voice input could not be started. Check microphone permission.', 'error');
          setStudioVoiceState(false);
        }
      };

      const transcribeStudioRecording = async (audioBlob) => {
        try {
          const response = await request('/v1/studio/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
            body: audioBlob
          });
          const transcript = String(response.text || '').trim();
          if (!transcript || !studioPromptInput) return;
          const prefix = studioVoiceDraftPrefix;
          studioPromptInput.value = prefix ? `${prefix} ${transcript}` : transcript;
          studioPromptInput.dispatchEvent(new Event('input', { bubbles: true }));
          studioPromptInput.focus();
        } catch (error) {
          setStudioStatus(error.message || 'Voice transcription failed. Try again.', 'error');
        }
      };

      const startStudioVoiceInput = async () => {
        studioVoiceDraftPrefix = studioPromptInput?.value.trim() || '';
        if (!window.KIELTECH_SERVER_TRANSCRIPTION) {
          startBrowserStudioVoiceInput();
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
          startBrowserStudioVoiceInput();
          return;
        }
        try {
          studioVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
          studioVoiceRecorder = new MediaRecorder(studioVoiceStream, preferredType ? { mimeType: preferredType } : undefined);
          const chunks = [];
          studioVoiceRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
          studioVoiceRecorder.onstop = async () => {
            const audioBlob = new Blob(chunks, { type: studioVoiceRecorder.mimeType || 'audio/webm' });
            studioVoiceStream?.getTracks().forEach((track) => track.stop());
            studioVoiceStream = null;
            studioVoiceRecorder = null;
            setStudioVoiceState(false);
            if (audioBlob.size) await transcribeStudioRecording(audioBlob);
          };
          studioVoiceUsingRecorder = true;
          studioVoiceRecorder.start();
          setStudioVoiceState(true);
          setStudioStatus('Listening. Press the microphone again when you are finished.', 'info');
        } catch (error) {
          studioVoiceStream?.getTracks().forEach((track) => track.stop());
          studioVoiceStream = null;
          studioVoiceRecorder = null;
          studioVoiceUsingRecorder = false;
          startBrowserStudioVoiceInput();
        }
      };

      studioVoiceButton?.addEventListener('click', async () => {
        if (studioVoiceListening) {
          if (studioVoiceUsingRecorder) {
            studioVoiceUsingRecorder = false;
            studioVoiceRecorder?.stop();
            return;
          }
          clearStudioVoiceSilenceTimer();
          studioVoiceAutoSendPending = false;
          studioVoiceRecognition?.stop();
          setStudioVoiceState(false);
        } else {
          startStudioVoiceInput();
        }
      });

      studioPromptInput?.addEventListener('input', () => {
        adjustStudioTextarea(studioPromptInput);
        updateStudioActionState();
      });

      if (studioPromptInput) {
        studioPromptInput.style.maxHeight = '120px';
        studioPromptInput.setAttribute('data-max-height', '120');
        adjustStudioTextarea(studioPromptInput);
      }

      studioActionButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (studioIsGenerating) {
          stopStudioGeneration();
          return;
        }
        runStudioGeneration();
      });

      studioPromptInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (studioIsGenerating) {
            stopStudioGeneration();
          } else {
            runStudioGeneration();
          }
        }
      });
      // feedback thumbs toggle
      const feedbackButtons = Array.from(document.querySelectorAll('.studio-feedback-thumb'));
      feedbackButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          // ensure only one feedback can be active at a time
          feedbackButtons.forEach((b) => {
            if (b !== btn) {
              b.classList.remove('is-active');
              b.setAttribute('aria-pressed', 'false');
            }
          });
          const isActive = btn.classList.toggle('is-active');
          btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      });
      studioTemperature?.addEventListener('input', () => {
        if (studioTemperatureValue) {
          studioTemperatureValue.textContent = Number(studioTemperature.value).toFixed(2);
        }
      });
      studioMaxTokens?.addEventListener('input', () => {
        if (studioMaxTokensValue) {
          studioMaxTokensValue.textContent = studioMaxTokens.value;
        }
      });
      studioHistoryList?.addEventListener('click', (event) => {
        const historyButton = event.target.closest('[data-history-id]');
        if (!historyButton) return;
        const matchingItem = studioHistory.find((item) => String(item.id) === historyButton.getAttribute('data-history-id'));
        if (matchingItem?.prompt && studioPromptInput) {
          studioPromptInput.value = matchingItem.prompt;
          setStudioStatus('Loaded a previous run into the prompt box.', 'info');
        }
      });

      const studioResizer = document.getElementById('studioResizer');
      const studioLayout = document.querySelector('.studio-layout');
      let isResizingStudio = false;
      let startX = 0;
      let startLeftWidth = 0;

      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

      const onStudioMouseMove = (event) => {
        if (!isResizingStudio || !studioLayout) return;
        const rect = studioLayout.getBoundingClientRect();
        const minLeft = rect.width * 0.2;
        const maxLeft = rect.width * 0.8;
        const newLeft = clamp(startLeftWidth + (event.clientX - startX), minLeft, maxLeft);
        studioLayout.style.gridTemplateColumns = `${newLeft}px 12px minmax(0, 1fr)`;
      };

      const stopStudioResize = () => {
        isResizingStudio = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onStudioMouseMove);
        document.removeEventListener('mouseup', stopStudioResize);
        document.removeEventListener('mouseleave', stopStudioResize);
        studioResizer?.classList.remove('is-active');
      };

      if (studioResizer && studioLayout) {
        studioResizer.addEventListener('dragstart', (event) => {
          event.preventDefault();
        });

        studioResizer.addEventListener('mousedown', (event) => {
          isResizingStudio = true;
          startX = event.clientX;
          const leftRect = studioLayout.querySelector('.studio-left-panel')?.getBoundingClientRect();
          startLeftWidth = leftRect ? leftRect.width : studioLayout.clientWidth * 0.34;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.body.style.webkitUserSelect = 'none';
          document.body.style.mozUserSelect = 'none';
          document.body.style.msUserSelect = 'none';
          document.addEventListener('mousemove', onStudioMouseMove);
          document.addEventListener('mouseup', stopStudioResize);
          document.addEventListener('mouseleave', stopStudioResize);
          studioResizer.classList.add('is-active');
          event.preventDefault();
        });
      }

      // Wire up new preview tabs
      const previewTabButtons = Array.from(document.querySelectorAll('.studio-preview-tab'));
      previewTabButtons.forEach((tab) => {
        tab.addEventListener('click', () => setStudioTab(tab.dataset.tab));
      });

      // Wire up top nav buttons
      document.getElementById('studioBackButton')?.addEventListener('click', () => {
        window.location.href = 'web-development.html';
      });
      document.getElementById('studioSettingsButton')?.addEventListener('click', () => {
        setStudioStatus('Settings panel opening...', 'info');
      });

      // Wire Share button and panel
      const studioShareButton = document.getElementById('studioShareButton');
      const studioSharePanel = document.getElementById('studioSharePanel');
      const studioCreateShareButton = document.getElementById('studioCreateShareButton');
      const studioCopyShareLink = document.getElementById('studioCopyShareLink');
      const studioShareLink = document.getElementById('studioShareLink');
      const studioNativeShare = document.getElementById('studioNativeShare');
      const studioShareStatus = document.getElementById('studioShareStatus');
      const studioShareClose = document.getElementById('studioShareClose');
      const studioSharePermission = document.getElementById('studioSharePermission');

      if (studioCreateShareButton && studioCreateShareButton.dataset.shareBound !== 'true') {
        studioCreateShareButton.dataset.shareBound = 'true';
        studioCreateShareButton.addEventListener('click', async () => {
          studioCreateShareButton.disabled = true;
          studioShareStatus.textContent = 'Creating share...';
          studioShareStatus.className = 'studio-share-status is-loading';

          try {
            const projectName = (studioNavTitle?.textContent || 'My Project').trim();
            const shareProjectFiles = Array.isArray(projectFiles) ? projectFiles : [];
            const permission = studioSharePermission?.value || 'read-write';

            const response = await fetch(`${getApiBaseUrl()}/v1/studio/shares`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ project_name: projectName, permission, project_files: shareProjectFiles }),
            });

            if (!response.ok) {
              throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            const shareUrl = `${window.location.origin}${window.location.pathname}?share=${data.share_token}`;
            studioShareLink.value = shareUrl;
            studioShareStatus.textContent = 'Share link created!';
            studioShareStatus.className = 'studio-share-status is-success';
            setTimeout(() => { studioShareStatus.textContent = ''; studioShareStatus.className = ''; }, 3000);
          } catch (err) {
            studioShareStatus.textContent = 'Failed to create share';
            studioShareStatus.className = 'studio-share-status is-error';
            setStudioStatus(`Share failed: ${err.message}`, 'error');
          } finally {
            studioCreateShareButton.disabled = false;
          }
        });
      }

      if (studioCopyShareLink && studioShareLink && studioCopyShareLink.dataset.shareBound !== 'true') {
        studioCopyShareLink.dataset.shareBound = 'true';
        studioCopyShareLink.addEventListener('click', async () => {
          const url = studioShareLink.value;
          if (!url) {
            setStudioStatus('No share link yet. Create a share first.', 'error');
            return;
          }
          try {
            await navigator.clipboard.writeText(url);
            studioShareStatus.textContent = 'Link copied!';
            studioShareStatus.className = 'studio-share-status is-success';
            setTimeout(() => { studioShareStatus.textContent = ''; studioShareStatus.className = ''; }, 2000);
          } catch (err) {
            setStudioStatus('Failed to copy link', 'error');
          }
        });
      }

      if (studioNativeShare) {
        studioNativeShare.addEventListener('click', async () => {
          const url = studioShareLink?.value;
          const projectName = (studioNavTitle?.textContent || 'My Project').trim();
          if (!url) {
            setStudioStatus('No share link yet. Create a share first.', 'error');
            return;
          }
          if (navigator.share) {
            try {
              await navigator.share({ title: projectName, text: 'Check out my KielTech Studio project:', url });
            } catch (err) {
              if (err.name !== 'AbortError') {
                setStudioStatus('Share failed', 'error');
              }
            }
          } else {
            setStudioStatus('Web Share API not available', 'error');
          }
        });
      }

      editRequestButton?.addEventListener('click', () => {
        window.location.href = 'web-development-build.html';
      });
      viewLandingButton?.addEventListener('click', () => {
        window.location.href = 'web-development.html';
      });

      renderStudioHistory();
      renderStudioWorkspace('Studio is ready for your first workspace request.', '');
      renderStudioSuggestions(requestPayload.projectBrief || '', '');
      setStudioTab('preview');
    }
  }

  const setBillingPanelState = (message, tone = 'info') => {
    if (!billingPanelMessage) return;
    billingPanelMessage.textContent = message;
    billingPanelMessage.className = `form-status ${tone === 'success' ? 'is-success' : tone === 'error' ? 'is-error' : tone === 'loading' ? 'is-loading' : ''}`.trim();
  };

  const renderBillingPanel = async (requestId, requestName = '') => {
    if (!billingPanel || !billingPanelTitle || !billingPanelSummary || !billingStatusBadge || !payDepositButton || !refundButton || !markInvoiceButton) return;

    activeBillingRequestId = requestId || activeBillingRequestId;
    activeBillingRequestName = requestName || activeBillingRequestName || 'Selected project';

    if (!activeBillingRequestId) {
      billingPanel.classList.remove('is-hidden');
      billingPanelTitle.textContent = 'Select a build request';
      billingPanelSummary.innerHTML = 'Choose a request from the history list to manage deposit, refund, and invoice milestones.';
      billingStatusBadge.textContent = 'Pending';
      billingStatusBadge.className = 'billing-status-pill is-pending';
      setBillingPanelState('Select a request to manage billing.', 'info');
      return;
    }

    billingPanel.classList.remove('is-hidden');
    billingPanelTitle.textContent = activeBillingRequestName || 'Project billing';
    billingPanelSummary.innerHTML = 'Loading invoice and payment milestones...';
    billingStatusBadge.textContent = 'Checking...';
    billingStatusBadge.className = 'billing-status-pill';
    setBillingPanelState('Loading billing status…', 'loading');

    payDepositButton.disabled = true;
    refundButton.disabled = true;
    markInvoiceButton.disabled = true;

    try {
      const status = await request(`/v1/web-development/requests/${activeBillingRequestId}/billing/status`);
      const amountDue = Number(status.amount_due || 0);
      const paymentStatus = String(status.payment_status || 'pending').toLowerCase();
      const invoiceStatus = String(status.invoice_status || 'pending').toLowerCase();
      const paymentLabel = paymentStatus === 'paid' ? 'Paid' : paymentStatus === 'partial' ? 'Partial payment' : paymentStatus === 'refunded' ? 'Refunded' : paymentStatus === 'failed' ? 'Payment failed' : 'Pending';
      const invoiceLabel = invoiceStatus === 'generated' ? 'Invoice generated' : 'Invoice pending';
      const amountPaid = Number(status.amount_paid || 0);
      const amountTotal = Number(status.amount_total || 0);

      billingStatusBadge.textContent = paymentLabel;
      billingStatusBadge.className = `billing-status-pill ${paymentStatus === 'paid' ? 'is-paid' : paymentStatus === 'partial' ? 'is-partial' : paymentStatus === 'refunded' ? 'is-refunded' : 'is-pending'}`;
      billingPanelSummary.innerHTML = `
        <strong>${escapeHtml(activeBillingRequestName || 'Selected project')}</strong><br />
        Payment status: ${escapeHtml(paymentLabel)}<br />
        Invoice: ${escapeHtml(invoiceLabel)}<br />
        Paid ${escapeHtml(String(amountPaid))} / ${escapeHtml(String(amountTotal))} ${escapeHtml(status.currency || 'USD')} • Due ${escapeHtml(String(amountDue))}
      `;
      setBillingPanelState(`Billing is ${paymentStatus === 'paid' ? 'up to date' : paymentStatus === 'partial' ? 'partially paid' : paymentStatus === 'refunded' ? 'refunded' : 'pending'}.`, 'info');
    } catch (error) {
      billingStatusBadge.textContent = 'Error';
      billingStatusBadge.className = 'billing-status-pill is-pending';
      billingPanelSummary.innerHTML = 'Unable to load billing status for this request.';
      setBillingPanelState(error.message || 'Billing status could not be loaded.', 'error');
    } finally {
      payDepositButton.disabled = false;
      refundButton.disabled = false;
      markInvoiceButton.disabled = false;
    }
  };

  const runBillingAction = async (action) => {
    if (!activeBillingRequestId) {
      setBillingPanelState('Select a request before updating billing.', 'error');
      return;
    }

    payDepositButton.disabled = true;
    refundButton.disabled = true;
    markInvoiceButton.disabled = true;
    setBillingPanelState('Updating billing…', 'loading');

    try {
      if (action === 'deposit') {
        const checkoutResponse = await request(`/v1/web-development/requests/${activeBillingRequestId}/billing/checkout`, {
          method: 'POST',
          body: JSON.stringify({ amount: 250, currency: 'USD', payment_type: 'deposit', note: 'Deposit for build milestones' })
        });
        if (checkoutResponse.authorization_url) {
          window.location.assign(checkoutResponse.authorization_url);
        } else {
          throw new Error('Paystack did not return a checkout URL. Payment was not recorded.');
        }
      } else if (action === 'refund') {
        await request(`/v1/web-development/requests/${activeBillingRequestId}/billing/events`, {
          method: 'POST',
          body: JSON.stringify({ event: 'refund.processed', status: 'refunded', amount: 125, currency: 'USD', reference: `refund-${activeBillingRequestId}`, note: 'Refund issued for the web development milestone' })
        });
        addNotification('Refund recorded', `A refund was recorded for ${activeBillingRequestName || 'the project'}.`, 'success');
      } else if (action === 'invoice') {
        await request(`/v1/web-development/requests/${activeBillingRequestId}/billing/events`, {
          method: 'POST',
          body: JSON.stringify({ event: 'invoice.generated', status: 'generated', amount: 0, currency: 'USD', invoice_id: `INV-${activeBillingRequestId}`, note: 'Invoice generated for the project' })
        });
        addNotification('Invoice marked', `Invoice generation was recorded for ${activeBillingRequestName || 'the project'}.`, 'success');
      }
      await renderBillingPanel(activeBillingRequestId, activeBillingRequestName);
      await renderHistory();
    } catch (error) {
      setBillingPanelState(error.message || 'Unable to update billing.', 'error');
      addNotification('Billing update failed', error.message || 'Unable to update billing.', 'error');
    } finally {
      payDepositButton.disabled = false;
      refundButton.disabled = false;
      markInvoiceButton.disabled = false;
    }
  };

  const renderHistory = async () => {
    if (!historyPanel) return;
    showLoadingSkeleton(historyPanel);
    const email = projectEmailInput?.value?.trim() || 'demo-user@example.com';
    try {
      const response = await request(`/v1/web-development/requests?email=${encodeURIComponent(email)}`);
      const requests = Array.isArray(response?.requests) ? response.requests : [];
      if (!requests.length) {
        historyPanel.innerHTML = '<div class="history-item"><strong>No build requests yet.</strong><p class="release-meta">Your requests will appear here once you submit one.</p></div>';
        return;
      }

      historyPanel.innerHTML = requests.map((item) => {
        const notificationLabel = item.notification_state === 'delivery_ready'
          ? 'Delivery ready'
          : item.notification_state === 'in_progress'
            ? 'Build in progress'
            : item.notification_state === 'failed'
              ? 'Update failed'
              : 'Request received';
        const paymentStatus = item.billing_payment_status || 'pending';
        const paymentBadge = paymentStatus === 'paid' ? 'Paid' : paymentStatus === 'partial' ? 'Partial' : paymentStatus === 'refunded' ? 'Refunded' : 'Pending';
        const invoiceLabel = item.billing_invoice_status === 'generated' ? 'Invoice generated' : 'Invoice pending';

        return `
          <div class="history-item">
            <strong>${escapeHtml(item.project_name || 'Unnamed build')}</strong>
            <div class="history-item__meta">
              <span>${escapeHtml(item.selected_ai || 'AI specialist')}</span>
              <span>•</span>
              <span>${escapeHtml(item.status || 'reviewing')}</span>
              <span>•</span>
              <span>${escapeHtml(new Date(item.created_at || '').toLocaleString() || 'Just now')}</span>
            </div>
            <p class="release-meta">${escapeHtml(item.project_brief || 'No brief provided')}</p>
            <p class="release-meta">Notifications: ${escapeHtml(notificationLabel)}</p>
            <p class="release-meta">Billing: ${escapeHtml(paymentBadge)} • ${escapeHtml(invoiceLabel)} • ${escapeHtml(String(item.billing_amount_paid || 0))} / ${escapeHtml(String(item.billing_amount_total || 0))} ${escapeHtml(item.billing_currency || 'USD')}</p>
            <div class="history-item__actions">
              <button class="btn btn-primary" type="button" data-history-action="publish" data-request-id="${escapeHtml(String(item.id || ''))}">Publish</button>
              <button class="btn btn-secondary" type="button" data-history-action="download" data-request-id="${escapeHtml(String(item.id || ''))}">Download</button>
              <button class="btn btn-secondary" type="button" data-history-action="continue" data-request-id="${escapeHtml(String(item.id || ''))}">Continue building</button>
              <button class="btn btn-secondary" type="button" data-history-action="billing" data-request-id="${escapeHtml(String(item.id || ''))}">Manage billing</button>
              ${item.notification_state === 'failed' ? `<button class="btn btn-secondary" type="button" data-history-action="retry" data-request-id="${escapeHtml(String(item.id || ''))}">Retry</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    } catch (error) {
      historyPanel.innerHTML = `<div class="history-item"><strong>Unable to load your requests.</strong><p class="release-meta">${escapeHtml(error.message || 'Please try again later.')}</p></div>`;
    }
  };

  const updateRequestStatus = async (requestId, status) => {
    if (!requestId) return;
    try {
      await request(`/v1/web-development/requests/${requestId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
    } catch (error) {
      console.warn('Unable to update request status', error);
      throw error;
    }
  };

  const selectAiModel = (button, card) => {
      const selected = {
        category: button.getAttribute('data-ai-category') || 'Web development',
        name: button.getAttribute('data-ai-name') || 'Selected AI',
        price: button.getAttribute('data-ai-price') || '$0',
        model: button.getAttribute('data-ai-model') || ''
      };

      selectedAi = selected;
      studioSelectedModel = selected.model;
      if (selected.model) localStorage.setItem('kieltech-studio-model', selected.model);
      else localStorage.removeItem('kieltech-studio-model');
      aiCards.forEach((item) => item.classList.remove('is-selected'));
      card.classList.add('is-selected');
      aiCards.forEach((item) => item.querySelector('.select-ai-button')?.setAttribute('aria-pressed', item === card ? 'true' : 'false'));

      if (isSelectionPage) {
        saveDraft();
        const params = new URLSearchParams({
          aiName: selected.name,
          aiCategory: selected.category,
          aiPrice: selected.price,
          aiModel: selected.model
        });

        window.location.href = `web-development-build.html?${params.toString()}`;
        return;
      }

      revealForm();
      saveDraft();
  };

  if (!isSelectionPage) {
    aiCards.forEach((card) => {
      const button = card.querySelector('.select-ai-button');
      if (button) button.addEventListener('click', () => selectAiModel(button, card));
    });
  }

  resetButton?.addEventListener('click', () => {
    if (isWebDevelopmentBuildPage) {
      window.location.href = 'web-development.html';
      return;
    }

    resetFlow();
  });

  if (isWebDevelopmentBuildPage && form) {
    form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!selectedAi) {
      setFormMessage(formMessage, 'Please choose an AI specialist before submitting your request.', 'error');
      return;
    }

    const projectName = projectNameInput?.value?.trim() || '';
    const projectEmail = projectEmailInput?.value?.trim() || '';
    const projectBrief = projectBriefInput?.value?.trim() || '';

    if (!projectName || !projectEmail || !projectBrief) {
      setFormMessage(formMessage, 'Please complete the project name, email, and brief before continuing.', 'error');
      return;
    }

    startBuildButton.disabled = true;
    startBuildButton.textContent = 'Processing...';
    setFormMessage(formMessage, 'Preparing your request and routing it to the selected specialist...', 'loading');

    const progressItems = progressPanel.querySelectorAll('.build-progress-item');
    progressItems.forEach((item, index) => {
      item.classList.remove('is-active', 'is-complete');
      if (index === 0) {
        item.classList.add('is-active');
      }
    });
    progressPanel.classList.remove('is-hidden');

    let createdRequest = null;

    try {
      createdRequest = await request('/v1/web-development/requests', {
        method: 'POST',
        body: JSON.stringify({
          email: projectEmail,
          project_name: projectName,
          project_brief: projectBrief,
          selected_ai: selectedAi.name,
          selected_ai_category: selectedAi.category,
          selected_ai_price: selectedAi.price,
          selected_ai_model: selectedAi.model || '',
          delivery_preference: deliveryPreferenceInput?.value || 'publish',
          deployment_target: deploymentTargetInput?.value || 'free-hosting',
          feature_list: featureListInput?.value?.trim() || 'Core landing page and conversion flow',
        })
      });
    } catch (error) {
      setFormMessage(formMessage, error.message || 'Unable to save your build request.', 'error');
      startBuildButton.disabled = false;
      startBuildButton.textContent = 'Start build request';
      if (progressPanel) {
        progressPanel.classList.add('is-hidden');
        const progressItems = progressPanel.querySelectorAll('.build-progress-item');
        progressItems.forEach((item) => item.classList.remove('is-active', 'is-complete'));
      }
      return;
    }

    clearDraft();

    const requestPayload = {
      requestId: createdRequest?.id,
      email: projectEmail,
      projectName,
      projectBrief,
      deliveryPreference: deliveryPreferenceInput?.value || 'publish',
      deploymentTarget: deploymentTargetInput?.value || 'free-hosting',
      featureList: featureListInput?.value?.trim() || 'Core landing page and conversion flow',
      selectedAi,
      createdAt: new Date().toISOString()
    };
    localStorage.setItem(storedRequestKey, JSON.stringify(requestPayload));

    setFormMessage(formMessage, 'Build request submitted for review. Opening your AI studio workspace...', 'success');
    startBuildButton.textContent = 'Opening studio...';

    window.setTimeout(() => { window.location.href = 'web-development-studio.html'; }, 1000);
  });
  }

  if (isWebDevelopmentBuildPage && outcomePanel) {
    outcomePanel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-build-action]');
      if (!button) return;

      const action = button.getAttribute('data-build-action');
      if (action === 'publish') {
        outcomePanel.innerHTML = `
          <h3>Publish setup</h3>
          <p>We can configure deployment through a free hosting platform or connect your own domain.</p>
          <div class="build-option-list">
            <button class="btn btn-primary" type="button" data-build-action="done">Continue to web development page</button>
          </div>
        `;
      } else if (action === 'download') {
        outcomePanel.innerHTML = `
          <h3>Code package ready</h3>
          <p>Your build files will be packaged and shared as a downloadable archive once the project is finalized.</p>
          <div class="build-option-list">
            <button class="btn btn-primary" type="button" data-build-action="done">Continue to web development page</button>
          </div>
        `;
      } else if (action === 'done') {
        window.location.href = 'web-development.html';
      }
    });
  }

  const showDeliverySummary = (action, projectName) => {
    const isPublish = action === 'publish';
    deliverySummaryPanel.classList.remove('is-hidden');
    deliverySummaryPanel.innerHTML = `
      <h3>${isPublish ? 'Publish handoff ready' : 'Download package ready'}</h3>
      <p><strong>${escapeHtml(projectName || 'Your project')}</strong> is prepared for ${isPublish ? 'publishing with deployment guidance' : 'download as a code package'}.</p>
      <p class="release-meta">${isPublish ? 'A launch checklist, deployment target, and next-step briefing will follow once you confirm the handoff.' : 'The package will include your requested pages, assets, and implementation notes for local review.'}</p>
    `;
  };

  historyPanel?.addEventListener('click', async (event) => {
    const actionButton = event.target.closest('button[data-history-action]');
    if (!actionButton) return;

    event.preventDefault();
    const action = actionButton.getAttribute('data-history-action');
    const requestId = actionButton.getAttribute('data-request-id');
    const projectName = actionButton.closest('.history-item')?.querySelector('strong')?.textContent || 'Your project';
    const nextStatus = action === 'publish' ? 'publish-selected' : action === 'download' ? 'download-selected' : 'continue-building';

    actionButton.disabled = true;
    actionButton.textContent = 'Working...';

    try {
      if (action === 'retry') {
        await request(`/v1/web-development/requests/${requestId}/retry`, {
          method: 'POST',
          body: JSON.stringify({ action: 'download' }),
        });
        addNotification('Retry started', `Retrying ${projectName}. We'll notify you when delivery is ready.`, 'success');
      } else if (action === 'billing') {
        activeBillingRequestId = requestId;
        activeBillingRequestName = projectName;
        await renderBillingPanel(requestId, projectName);
        addNotification('Billing panel opened', `Managing billing milestones for ${projectName}.`, 'info');
      } else {
        await updateRequestStatus(requestId, nextStatus);
        showDeliverySummary(action, projectName);
        addNotification('Request updated', action === 'publish' ? 'Publish flow selected for this request.' : action === 'download' ? 'Download flow selected for this request.' : 'The request is ready for continued build work.', 'success');
        if (action === 'continue') {
          requestSection.classList.remove('is-hidden');
          requestSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
      await renderHistory();
    } catch (error) {
      addNotification('Request update failed', error.message || 'Unable to update the request action.', 'error');
    } finally {
      actionButton.disabled = false;
      if (action === 'publish') {
        actionButton.textContent = 'Publish';
      } else if (action === 'download') {
        actionButton.textContent = 'Download';
      } else if (action === 'continue') {
        actionButton.textContent = 'Continue building';
      } else if (action === 'retry') {
        actionButton.textContent = 'Retry';
      }
    }
  });

  payDepositButton?.addEventListener('click', () => runBillingAction('deposit'));
  refundButton?.addEventListener('click', () => runBillingAction('refund'));
  markInvoiceButton?.addEventListener('click', () => runBillingAction('invoice'));

  renderHistory();
  renderBillingPanel();
}

function initStudioProjectManagement() {
  const projectsDialog = document.getElementById('studioProjectsDialog');
  const projectsList = document.getElementById('studioProjectsList');
  const createProjectDialog = document.getElementById('studioCreateProjectDialog');
  const createProjectForm = document.getElementById('studioCreateProjectForm');
  const versionsDialog = document.getElementById('studioVersionsDialog');
  const versionsList = document.getElementById('studioVersionsList');
  const guidanceDialog = document.getElementById('studioGuidanceDialog');
  const guidanceForm = document.getElementById('studioProjectGuidanceForm');
  const currentProjectId = () => localStorage.getItem('kieltech-server-studio-project-id');
  const api = async (path, options = {}) => {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${state.token}`, ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Studio request failed (HTTP ${response.status}).`);
    return payload;
  };
  const closeDialog = (dialog) => { if (dialog) dialog.hidden = true; };
  document.querySelectorAll('.studio-project-dialog [data-studio-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.closest('.studio-project-dialog')));
  });
  document.querySelectorAll('.studio-project-dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    document.getElementById('studioSaveRetry')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await flushStudioServerSave();
      } catch (error) {
        setStudioSaveStatus(error.message || 'Save failed — retry after checking your connection', 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
  const loadProject = async (projectId) => {
    window.clearTimeout(studioServerSaveTimer);
    await studioServerSaveInFlight.catch(() => {});
    const payload = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}`);
    localStorage.setItem('kieltech-server-studio-project-id', payload.project_id);
    localStorage.setItem('kieltech-studio-project-name', payload.project_name || 'KielTech Studio project');
    window.KieltechStudioChat?.switchProject(payload.project_id);
    projectFiles = (payload.files || []).map((file) => ({
      name: file.path,
      type: 'file',
      status: 'synced',
      content: String(file.content || '')
    }));
    const title = document.getElementById('studioNavTitle');
    const titleInput = document.getElementById('studioTitleInput');
    if (title) title.textContent = payload.project_name || 'KielTech Studio project';
    if (titleInput) titleInput.value = payload.project_name || '';
    activeEditorFileName = '';
    activeEditorFolderName = '';
    openEditorTabNames = [];
    openEditorTabFolders = [];
    renderFileExplorer();
    renderEditor();
    refreshPreviewFromWorkspace();
    saveWorkspaceState();
    setStudioSaveStatus('Saved to your account', 'saved');
    closeDialog(projectsDialog);
  };
  const renderProjects = async () => {
    if (!projectsList) return;
    projectsList.innerHTML = '<p class="studio-project-list__message">Loading your projects…</p>';
    try {
      if (!state.token) throw new Error('Sign in to view your saved projects.');
      const payload = await api('/v1/studio/projects');
      const projects = Array.isArray(payload.projects) ? payload.projects : [];
      if (!projects.length) {
        projectsList.innerHTML = '<p class="studio-project-list__message">No saved projects yet. Create one to get started.</p>';
        return;
      }
      projectsList.innerHTML = projects.map((project) => `
        <article class="studio-project-list__item">
          <div><strong>${escapeHtml(project.project_name || 'Untitled project')}</strong><span>${Number(project.file_count || 0)} files · Updated ${escapeHtml(new Date(project.updated_at).toLocaleString())}</span></div>
          <button type="button" data-open-project="${escapeHtml(project.project_id)}">${project.project_id === currentProjectId() ? 'Current' : 'Open'}</button>
        </article>`).join('');
    } catch (error) {
      projectsList.innerHTML = `<p class="studio-project-list__message is-error">${escapeHtml(error.message)}</p>`;
    }
  };
  document.getElementById('studioProjectsButton')?.addEventListener('click', () => {
    if (!projectsDialog) return;
    projectsDialog.hidden = false;
    renderProjects();
  });
  projectsList?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-open-project]');
    if (!button || button.dataset.openProject === currentProjectId()) {
      if (button) closeDialog(projectsDialog);
      return;
    }
    button.disabled = true;
    try {
      await flushStudioServerSave();
      await loadProject(button.dataset.openProject);
    } catch (error) {
      showToast(error.message || 'Unable to open this project');
      button.disabled = false;
    }
  });
  document.getElementById('studioCreateProjectButton')?.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!createProjectDialog) return;
    const status = document.getElementById('studioCreateProjectStatus');
    const input = createProjectForm?.elements.namedItem('project_name');
    if (status) status.textContent = '';
    if (input) input.value = '';
    createProjectDialog.hidden = false;
    input?.focus();
  });
  createProjectForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = createProjectForm.querySelector('[type="submit"]');
    const status = document.getElementById('studioCreateProjectStatus');
    const input = createProjectForm.elements.namedItem('project_name');
    const projectName = input.value.trim();
    if (!projectName) {
      if (status) status.textContent = 'Enter a name for your project.';
      input.focus();
      return;
    }
    if (submitButton) submitButton.disabled = true;
    if (status) status.textContent = 'Creating your project…';
    try {
      await flushStudioServerSave();
      const created = await api('/v1/studio/projects', { method: 'POST', body: JSON.stringify({ project_name: projectName }) });
      closeDialog(createProjectDialog);
      closeDialog(projectsDialog);
      await loadProject(created.project_id);
      createProjectForm.reset();
      showToast('Project created and saved to your account');
    } catch (error) {
      if (status) status.textContent = error.message || 'Unable to create the project.';
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
  const studioUrl = new URL(window.location.href);
  if (studioUrl.searchParams.get('new_project') === '1') {
    studioUrl.searchParams.delete('new_project');
    window.history.replaceState({}, '', studioUrl);
    document.getElementById('studioCreateProjectButton')?.click();
  }
  document.getElementById('studioVersionsButton')?.addEventListener('click', async () => {
    if (!versionsDialog || !versionsList) return;
    versionsDialog.hidden = false;
    versionsList.innerHTML = '<p class="studio-project-list__message">Loading saved versions…</p>';
    try {
      const projectId = await ensureServerStudioProject(localStorage.getItem('kieltech-studio-project-name') || 'KielTech Studio project');
      const payload = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}/versions`);
      const versionMarkup = payload.versions?.length ? payload.versions.map((version) => `
        <article class="studio-project-list__item">
          <div><strong>${escapeHtml(version.label)}</strong><span>${escapeHtml(new Date(version.created_at).toLocaleString())}</span></div>
          <button type="button" data-restore-version="${Number(version.version_id)}">Restore</button>
        </article>`).join('') : '<p class="studio-project-list__message">No restore points yet. Studio creates a checkpoint before each server save.</p>';
      let deploymentMarkup = '';
      try {
        const deploymentPayload = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}/deployments`);
        deploymentMarkup = deploymentPayload.deployments?.length
          ? `<h3>Deployment history</h3>${deploymentPayload.deployments.map((deployment) => `
            <article class="studio-project-list__item">
              <div><strong>Version ${Number(deployment.project_version)} · ${escapeHtml(deployment.website_name)}</strong><span>${escapeHtml(deployment.status)} · ${escapeHtml(new Date(deployment.created_at).toLocaleString())}</span></div>
              <button type="button" data-rollback-deployment="${escapeHtml(deployment.id)}">Roll back</button>
            </article>`).join('')}`
          : '<h3>Deployment history</h3><p class="studio-project-list__message">No deployments for this project yet.</p>';
      } catch (error) {
        deploymentMarkup = `<h3>Deployment history</h3><p class="studio-project-list__message is-error">${escapeHtml(error.message)}</p>`;
      }
      versionsList.innerHTML = `<h3>Workspace restore points</h3>${versionMarkup}${deploymentMarkup}`;
    } catch (error) {
      versionsList.innerHTML = `<p class="studio-project-list__message is-error">${escapeHtml(error.message)}</p>`;
    }
  });
  versionsList?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore-version]');
    const rollbackButton = event.target.closest('[data-rollback-deployment]');
    if (!button && !rollbackButton) return;
    const target = button || rollbackButton;
    const isDeploymentRollback = Boolean(rollbackButton);
    const action = isDeploymentRollback ? 'Roll back to this deployment?' : 'Restore this version?';
    if (!window.confirm(`${action} The current workspace will be preserved as a recovery point.`)) return;
    target.disabled = true;
    try {
      await flushStudioServerSave();
      const projectId = currentProjectId();
      if (isDeploymentRollback) {
        const result = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(target.dataset.rollbackDeployment)}/rollback`, { method: 'POST', body: '{}' });
        showToast(`Rollback deployment queued as version ${result.version}`);
        target.disabled = false;
        target.textContent = 'Queued';
        return;
      }
      await api(`/v1/studio/projects/${encodeURIComponent(projectId)}/versions/${target.dataset.restoreVersion}/restore`, { method: 'POST', body: '{}' });
      const payload = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}`);
      projectFiles = (payload.files || []).map((file) => ({ name: file.path, type: 'file', status: 'synced', content: String(file.content || '') }));
      renderFileExplorer();
      renderEditor();
      refreshPreviewFromWorkspace();
      saveWorkspaceState();
      closeDialog(versionsDialog);
      showToast('Project restored from the selected version');
    } catch (error) {
      showToast(error.message || 'Unable to restore this version');
      target.disabled = false;
    }
  });
  const fillGuidance = async () => {
    if (!guidanceForm) return;
    const projectId = await ensureServerStudioProject(localStorage.getItem('kieltech-studio-project-name') || 'KielTech Studio project');
    const payload = await api(`/v1/studio/projects/${encodeURIComponent(projectId)}`);
    const context = payload.project_context || {};
    ['purpose', 'visual_style', 'constraints'].forEach((field) => {
      const input = guidanceForm.elements.namedItem(field);
      if (input) input.value = context[field] || '';
    });
  };
  document.getElementById('studioProjectContextButton')?.addEventListener('click', async () => {
    if (!guidanceDialog) return;
    guidanceDialog.hidden = false;
    const status = document.getElementById('studioGuidanceStatus');
    if (status) status.textContent = 'Loading project guidance…';
    try {
      await fillGuidance();
      if (status) status.textContent = '';
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  });
  guidanceForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = guidanceForm.querySelector('[type="submit"]');
    const status = document.getElementById('studioGuidanceStatus');
    if (button) button.disabled = true;
    if (status) status.textContent = 'Saving guidance…';
    try {
      const projectId = await ensureServerStudioProject(localStorage.getItem('kieltech-studio-project-name') || 'KielTech Studio project');
      const projectContext = Object.fromEntries(['purpose', 'visual_style', 'constraints'].map((field) => [field, guidanceForm.elements.namedItem(field).value.trim()]));
      await api(`/v1/studio/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ project_name: document.getElementById('studioNavTitle')?.textContent.trim() || 'KielTech Studio project', project_context: projectContext })
      });
      if (status) status.textContent = 'Saved with this project';
      showToast('Project guidance saved');
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function initStudioWebsiteNameEditor() {
  const studioNavTitle = document.getElementById('studioNavTitle');
  const studioTitleInput = document.getElementById('studioTitleInput');
  const studioWebsiteNameEdit = document.getElementById('studioWebsiteNameEdit');
  if (!studioNavTitle || !studioTitleInput) return;

  const startEditing = () => {
    studioNavTitle.style.display = 'none';
    studioTitleInput.style.display = 'block';
    studioTitleInput.value = studioNavTitle.textContent.trim();
    studioTitleInput.focus();
    studioTitleInput.select();
  };

  const finishEditing = async () => {
    const previousTitle = studioNavTitle.textContent.trim();
    const newTitle = studioTitleInput.value.trim() || 'Untitled';
    studioNavTitle.textContent = newTitle;
    studioNavTitle.style.display = 'block';
    studioTitleInput.style.display = 'none';
    localStorage.setItem('kieltech-studio-project-name', newTitle);
    const projectId = localStorage.getItem('kieltech-server-studio-project-id');
    if (projectId && state.token) {
      try {
        const response = await fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
          body: JSON.stringify({ project_name: newTitle })
        });
        if (!response.ok) throw new Error(`Project rename failed (HTTP ${response.status}).`);
        setStudioSaveStatus('Project name saved', 'saved');
      } catch (error) {
        console.error('Unable to rename Studio project:', error);
        studioNavTitle.textContent = previousTitle;
        studioTitleInput.value = previousTitle;
        localStorage.setItem('kieltech-studio-project-name', previousTitle);
        setStudioSaveStatus('Project name could not be saved', 'error');
        const retry = document.getElementById('studioSaveRetry');
        if (retry) retry.hidden = true;
        showToast(error.message);
      }
    }
    const studioStatus = document.getElementById('studioStatus');
    if (studioStatus) {
      studioStatus.textContent = `Project renamed to "${newTitle}"`;
      studioStatus.className = 'studio-status is-success';
    }
  };

  studioWebsiteNameEdit?.addEventListener('click', (event) => {
    event.stopPropagation();
    startEditing();
  });
  studioNavTitle.addEventListener('click', startEditing);
  studioTitleInput.addEventListener('blur', finishEditing);
  studioTitleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishEditing();
    } else if (event.key === 'Escape') {
      studioTitleInput.style.display = 'none';
      studioNavTitle.style.display = 'block';
      studioTitleInput.blur();
    }
  });

  const savedProjectName = localStorage.getItem('kieltech-studio-project-name');
  if (savedProjectName && studioNavTitle.textContent.trim() === 'Website name') {
    studioNavTitle.textContent = savedProjectName;
  }
}

function initStudioSharePanel() {
  const studioShareButton = document.getElementById('studioShareButton');
  const studioSharePanel = document.getElementById('studioSharePanel');
  const studioShareClose = document.getElementById('studioShareClose');
  const studioCreateShareButton = document.getElementById('studioCreateShareButton');
  const studioSharePermission = document.getElementById('studioSharePermission');
  const studioShareLink = document.getElementById('studioShareLink');
  const studioShareStatus = document.getElementById('studioShareStatus');
  const studioCopyShareLink = document.getElementById('studioCopyShareLink');
  if (!studioShareButton || !studioSharePanel) return;

  studioShareButton.addEventListener('click', () => {
    const isOpen = !studioSharePanel.hasAttribute('hidden');
    if (isOpen) {
      studioSharePanel.setAttribute('hidden', '');
      studioShareButton.setAttribute('aria-expanded', 'false');
    } else {
      studioSharePanel.removeAttribute('hidden');
      studioShareButton.setAttribute('aria-expanded', 'true');
    }
  });

  studioShareClose?.addEventListener('click', () => {
    studioSharePanel.setAttribute('hidden', '');
    studioShareButton.setAttribute('aria-expanded', 'false');
  });

  if (studioCreateShareButton && studioCreateShareButton.dataset.shareBound !== 'true') {
    studioCreateShareButton.dataset.shareBound = 'true';
    studioCreateShareButton.addEventListener('click', async () => {
      studioCreateShareButton.disabled = true;
      studioShareStatus.textContent = 'Creating share...';
      studioShareStatus.className = 'studio-share-status is-loading';
      try {
        const projectName = (document.getElementById('studioNavTitle')?.textContent || 'My Project').trim();
        const permission = studioSharePermission?.value || 'read-write';
        const response = await fetch(`${getApiBaseUrl()}/v1/studio/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: projectName,
            permission,
            project_files: Array.isArray(window.projectFiles) ? window.projectFiles : []
          }),
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        studioShareLink.value = `${window.location.origin}${window.location.pathname}?share=${data.share_token}`;
        studioShareStatus.textContent = 'Share link created!';
        studioShareStatus.className = 'studio-share-status is-success';
      } catch (error) {
        studioShareStatus.textContent = 'Failed to create share';
        studioShareStatus.className = 'studio-share-status is-error';
      } finally {
        studioCreateShareButton.disabled = false;
      }
    });
  }

  if (studioCopyShareLink && studioShareLink && studioCopyShareLink.dataset.shareBound !== 'true') {
    studioCopyShareLink.dataset.shareBound = 'true';
    studioCopyShareLink.addEventListener('click', async () => {
      const url = studioShareLink.value;
      if (!url) {
        studioShareStatus.textContent = 'Create a share link first.';
        studioShareStatus.className = 'studio-share-status is-error';
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        } else {
          const copyInput = document.createElement('textarea');
          copyInput.value = url;
          copyInput.setAttribute('readonly', '');
          copyInput.style.position = 'fixed';
          copyInput.style.opacity = '0';
          document.body.appendChild(copyInput);
          copyInput.select();
          if (!document.execCommand('copy')) throw new Error('copy_failed');
          copyInput.remove();
        }
        studioShareStatus.textContent = 'Link copied!';
        studioShareStatus.className = 'studio-share-status is-success';
      } catch (error) {
        studioShareStatus.textContent = 'Failed to copy link';
        studioShareStatus.className = 'studio-share-status is-error';
      }
    });
  }
}

function initStudioSuggestionChips() {
  const suggestionRow = document.querySelector('.studio-suggestion-chips');
  const promptInput = document.getElementById('studioPromptInput');
  const actionButton = document.getElementById('studioActionButton');
  if (!suggestionRow || !promptInput || suggestionRow.dataset.suggestionsBound === 'true') return;

  suggestionRow.dataset.suggestionsBound = 'true';
  suggestionRow.addEventListener('click', (event) => {
    const suggestionButton = event.target.closest('.studio-suggestion-chip');
    if (!suggestionButton) return;
    const suggestion = suggestionButton.textContent.trim();
    promptInput.value = promptInput.value.trim() ? `${promptInput.value.trim()}\n${suggestion}` : suggestion;
    promptInput.focus();
    promptInput.style.height = 'auto';
    const maxHeight = Number(promptInput.getAttribute('data-max-height')) || 360;
    promptInput.style.height = `${Math.min(maxHeight, promptInput.scrollHeight)}px`;
    if (actionButton) actionButton.disabled = false;
  });
}

async function initStudioSharedView() {
  const shareToken = new URLSearchParams(window.location.search).get('share');
  if (!shareToken) return;

  try {
    const response = await fetch(`${getApiBaseUrl()}/v1/studio/shares/${encodeURIComponent(shareToken)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Share link could not be loaded.');

    const isReadOnly = payload.permission === 'read-only';
    const title = document.getElementById('studioNavTitle');
    const permissionBadge = document.getElementById('studioSharePermissionBadge');
    if (title) title.textContent = payload.project_name || 'Shared project';
    if (permissionBadge) {
      permissionBadge.hidden = false;
      permissionBadge.textContent = isReadOnly ? 'Read-only' : 'Read & write';
      permissionBadge.dataset.permission = payload.permission || 'read-only';
      permissionBadge.setAttribute('aria-label', `Share access: ${permissionBadge.textContent}`);
    }
    document.body.dataset.sharePermission = payload.permission || 'read-only';
    document.body.setAttribute('aria-label', isReadOnly ? 'Read-only shared project' : 'Read-write shared project');

    if (Array.isArray(payload.project_files)) {
      projectFiles = payload.project_files;
      if (typeof renderFileExplorer === 'function') renderFileExplorer();
    }

    if (isReadOnly) {
      const editableControls = [
        '#studioWebsiteNameEdit',
        '#studioTitleInput',
        '#studioPromptInput',
        '#studioActionButton',
        '#studioVoiceButton',
        '#studioContextButton',
        '#addFileBtn',
        '#collapseAllButton',
        '#downloadZipBtn',
        '#studioSharePermission',
        '#studioCreateShareButton'
      ];
      editableControls.forEach((selector) => {
        const control = document.querySelector(selector);
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
          control.disabled = true;
          control.setAttribute('aria-disabled', 'true');
        }
      });
      const titleLabel = document.querySelector('.studio-website-name__label');
      titleLabel?.setAttribute('aria-label', 'Shared project name, read-only');
      const prompt = document.getElementById('studioPromptInput');
      if (prompt) prompt.placeholder = 'Read-only shared project';
    }
  } catch (error) {
    document.body.dataset.sharePermission = 'error';
    const title = document.getElementById('studioNavTitle');
    if (title) title.textContent = 'Shared project unavailable';
  }
}

function init() {
  if (window.location.pathname.endsWith('/index.html') || window.location.pathname === '/') {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    window.setTimeout(() => window.scrollTo(0, 0), 0);
    window.addEventListener('pageshow', () => window.scrollTo(0, 0), { once: true });
  }
  initServiceDrawer();
  initStudioProjectDirectory();
  initMainSiteAuthNavigation();
  initHumanLanguageDocs();
  initApiAccessForm();
  initAdminSidebar();

  const promptInput = document.getElementById('promptInput');
  const askButton = document.getElementById('askButton');
  const demoResponse = document.getElementById('demoResponse');
  const contactForm = document.getElementById('contactForm');
  const formMessage = document.getElementById('formMessage');
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const authMessage = document.getElementById('authMessage');
  const emailVerificationPanel = document.getElementById('emailVerificationPanel');
  const emailVerificationCode = document.getElementById('emailVerificationCode');
  const verifyEmailButton = document.getElementById('verifyEmailButton');
  const resendEmailVerificationButton = document.getElementById('resendEmailVerificationButton');
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
        const data = await request('/v1/ai/chat', {
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
      setFormMessage(formMessage, 'Sending...', 'loading');
      try {
        const data = await request('/v1/contact', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const successMessage = data.emailStatus === 'sent'
          ? 'Email sent successfully.'
          : (data.message || 'Thanks for reaching out.');
        setFormMessage(formMessage, successMessage, 'success');
        contactForm.reset();
      } catch (error) {
        setFormMessage(formMessage, error.message, 'error');
      }
    });
  }

  if (loginForm && authMessage) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (loginForm.dataset.submitting === 'true') return;
      const payload = Object.fromEntries(new FormData(loginForm).entries());
      const submitButton = loginForm.querySelector('button[type="submit"]');
      const originalButtonText = submitButton?.textContent || 'Login';
      const abortController = new AbortController();
      const timeoutId = window.setTimeout(() => abortController.abort(), 30000);
      loginForm.dataset.submitting = 'true';
      loginForm.setAttribute('aria-busy', 'true');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Signing in…';
      }
      authMessage.className = 'demo-response form-status is-loading';
      authMessage.textContent = 'Signing in...';
      try {
        const data = await request('/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal: abortController.signal
        });
        state.token = data.token;
        localStorage.setItem('kieltechToken', data.token);
        authMessage.className = 'demo-response form-status is-success';
        authMessage.textContent = `Welcome back, ${data.user.name}!`;
        const returnTo = new URLSearchParams(window.location.search).get('return_to');
        window.location.href = returnTo && /^[-a-zA-Z0-9_/]+\.html(?:[?#].*)?$/.test(returnTo) ? returnTo : 'index.html';
      } catch (error) {
        const errorMessage = error.message || '';
        authMessage.className = 'demo-response form-status is-error';
        if (error.status === 403 && /verification|required|verify your email/i.test(errorMessage)) {
          showLoginVerification(error.email || payload.identifier || payload.email || '');
          authMessage.textContent = 'A new verification code was sent. Enter it to continue.';
        } else if (error.code === 'password_sign_in_unavailable') {
          authMessage.innerHTML = 'This account doesn&#39;t support password sign-in. <a class="text-link" href="#googleSignInButton">Sign in with Google</a> instead, or set up a password in Settings once you&#39;re logged in.';
        } else if (/not registered/i.test(errorMessage)) {
          authMessage.innerHTML = 'This email is not registered. <a class="text-link" href="signup.html">Create an account</a> first.';
        } else if (/email domain does not exist/i.test(errorMessage)) {
          authMessage.textContent = 'That email domain does not exist. Check the address and try again.';
        } else if (/valid email/i.test(errorMessage)) {
          authMessage.textContent = 'Enter a valid email address.';
        } else if (/servers are facing|Unable to reach the server|backend is unavailable/i.test(errorMessage)) {
          authMessage.textContent = 'The servers are facing some issues right now. Please try again.';
        } else if (error.name === 'AbortError') {
          authMessage.textContent = 'Sign-in timed out. Please check your connection and try again.';
        } else {
          authMessage.textContent = errorMessage;
        }
      } finally {
        window.clearTimeout(timeoutId);
        delete loginForm.dataset.submitting;
        loginForm.removeAttribute('aria-busy');
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
        }
      }
    });
  }

  const forgotPasswordButton = document.getElementById('forgotPasswordButton');
  const forgotPasswordPanel = document.getElementById('forgotPasswordPanel');
  const forgotPasswordEmail = document.getElementById('forgotPasswordEmail');
  const forgotPasswordSubmit = document.getElementById('forgotPasswordSubmit');
  const forgotPasswordCancel = document.getElementById('forgotPasswordCancel');
  const forgotPasswordMessage = document.getElementById('forgotPasswordMessage');
  forgotPasswordButton?.addEventListener('click', () => {
    forgotPasswordPanel?.classList.remove('hidden');
    forgotPasswordEmail?.focus();
  });
  forgotPasswordCancel?.addEventListener('click', () => forgotPasswordPanel?.classList.add('hidden'));
  forgotPasswordSubmit?.addEventListener('click', async () => {
    const email = forgotPasswordEmail?.value.trim() || '';
    if (!email) {
      if (forgotPasswordMessage) forgotPasswordMessage.textContent = 'Enter your account email.';
      return;
    }
    forgotPasswordSubmit.disabled = true;
    if (forgotPasswordMessage) forgotPasswordMessage.textContent = 'Checking your email...';
    try {
      const data = await request('/v1/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) });
      if (forgotPasswordMessage) forgotPasswordMessage.textContent = data.message || 'A reset link was sent to your email.';
    } catch (error) {
      if (forgotPasswordMessage) forgotPasswordMessage.textContent = error.message || 'Unable to request a reset link.';
    } finally {
      forgotPasswordSubmit.disabled = false;
    }
  });

  const loginEmailVerificationPanel = document.getElementById('loginEmailVerificationPanel');
  const loginEmailVerificationCode = document.getElementById('loginEmailVerificationCode');
  const verifyLoginEmailButton = document.getElementById('verifyLoginEmailButton');
  const resendLoginEmailButton = document.getElementById('resendLoginEmailButton');
  const loginEmailVerificationStatus = document.getElementById('loginEmailVerificationStatus');
  let pendingLoginIdentifier = '';

  const showLoginVerification = (identifier) => {
    pendingLoginIdentifier = identifier;
    loginEmailVerificationPanel?.classList.remove('hidden');
    if (loginEmailVerificationPanel) loginEmailVerificationPanel.hidden = false;
    document.body.classList.add('has-signup-verification-modal');
    loginEmailVerificationCode?.focus();
  };

  const verifyLoginEmail = async () => {
    const code = loginEmailVerificationCode?.value.trim();
    if (!pendingLoginIdentifier || !/^\d{6}$/.test(code || '')) {
      const message = 'Enter the six-digit verification code from your email.';
      authMessage.textContent = message;
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = message;
      return;
    }
    verifyLoginEmailButton.disabled = true;
    if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = 'Verifying your email...';
    try {
      const email = pendingLoginIdentifier.includes('@') ? pendingLoginIdentifier : '';
      const data = await request('/v1/auth/email/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
      state.token = data.token;
      localStorage.setItem('kieltechToken', data.token);
      authMessage.textContent = 'Email verified. Signing you in...';
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = 'Email verified. Signing you in...';
      loginEmailVerificationPanel.classList.add('hidden');
      loginEmailVerificationPanel.hidden = true;
      document.body.classList.remove('has-signup-verification-modal');
      window.setTimeout(() => { window.location.href = new URLSearchParams(window.location.search).get('return_to') || 'index.html'; }, 700);
    } catch (error) {
      const message = error.message || 'Email verification failed.';
      authMessage.textContent = message;
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = message;
    } finally {
      verifyLoginEmailButton.disabled = false;
    }
  };

  verifyLoginEmailButton?.addEventListener('click', verifyLoginEmail);
  loginEmailVerificationCode?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyLoginEmail();
    }
  });
  resendLoginEmailButton?.addEventListener('click', async () => {
    if (!pendingLoginIdentifier.includes('@')) {
      const message = 'Enter your email address to resend the verification code.';
      authMessage.textContent = message;
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = message;
      return;
    }
    resendLoginEmailButton.disabled = true;
    if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = 'Sending a new verification email...';
    try {
      const data = await request('/v1/auth/email/resend', { method: 'POST', body: JSON.stringify({ email: pendingLoginIdentifier }) });
      const message = data.message || 'A new verification code was sent.';
      authMessage.textContent = message;
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = message;
    } catch (error) {
      const message = error.message || 'The verification email could not be sent.';
      authMessage.textContent = message;
      if (loginEmailVerificationStatus) loginEmailVerificationStatus.textContent = message;
    } finally {
      resendLoginEmailButton.disabled = false;
    }
  });

  if (signupForm && authMessage) {
    const referralCode = new URLSearchParams(window.location.search).get('ref');
    if (referralCode && signupForm.elements.referral_code) signupForm.elements.referral_code.value = referralCode;
    let pendingSignupEmail = '';
    const showEmailVerification = () => {
      emailVerificationPanel.classList.remove('hidden');
      emailVerificationPanel.hidden = false;
      document.body.classList.add('has-signup-verification-modal');
      emailVerificationCode?.focus();
    };
    const emailVerificationStatus = document.getElementById('emailVerificationStatus');

    const verifySignupEmail = async () => {
      const email = signupForm.elements.email?.value.trim();
      const code = emailVerificationCode?.value.trim();
      if (!email || !/^\d{6}$/.test(code || '')) {
        const message = 'Enter the six-digit verification code from your email.';
        authMessage.textContent = message;
        if (emailVerificationStatus) emailVerificationStatus.textContent = message;
        return;
      }
      verifyEmailButton.disabled = true;
      if (emailVerificationStatus) emailVerificationStatus.textContent = 'Verifying your email...';
      try {
        const data = await request('/v1/auth/email/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
        if (data.token) {
          state.token = data.token;
          localStorage.setItem('kieltechToken', data.token);
        }
        authMessage.textContent = data.message || 'Email verified. Signing you in...';
        if (emailVerificationStatus) emailVerificationStatus.textContent = data.message || 'Email verified. Signing you in...';
        emailVerificationPanel.hidden = true;
        emailVerificationPanel.classList.add('hidden');
        document.body.classList.remove('has-signup-verification-modal');
        const accountCreditModal = document.getElementById('accountCreditModal');
        const continueAfterCredit = () => {
          accountCreditModal?.classList.add('hidden');
          accountCreditModal?.setAttribute('hidden', '');
          document.body.classList.remove('has-signup-verification-modal');
          window.location.href = new URLSearchParams(window.location.search).get('return_to') || 'index.html';
        };
        if (accountCreditModal) {
          const referralBonus = document.getElementById('accountCreditReferralBonus');
          if (referralBonus) referralBonus.hidden = !data.referral_bonus_awarded;
          accountCreditModal.classList.remove('hidden');
          accountCreditModal.removeAttribute('hidden');
          document.body.classList.add('has-signup-verification-modal');
          accountCreditModal.querySelector('[data-account-credit-dismiss]')?.addEventListener('click', continueAfterCredit, { once: true });
          document.getElementById('accountCreditContinue')?.addEventListener('click', continueAfterCredit, { once: true });
        } else {
          continueAfterCredit();
        }
      } catch (error) {
        const message = error.message || 'Email verification failed. Request a new code.';
        authMessage.textContent = message;
        if (emailVerificationStatus) emailVerificationStatus.textContent = message;
      } finally {
        verifyEmailButton.disabled = false;
      }
    };

    verifyEmailButton?.addEventListener('click', verifySignupEmail);
    emailVerificationCode?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        verifySignupEmail();
      }
    });
    resendEmailVerificationButton?.addEventListener('click', async () => {
      const email = pendingSignupEmail || signupForm.elements.email?.value.trim();
      if (!email) {
        const message = 'Enter your email address first.';
        authMessage.textContent = message;
        if (emailVerificationStatus) emailVerificationStatus.textContent = message;
        return;
      }
      resendEmailVerificationButton.disabled = true;
      if (emailVerificationStatus) emailVerificationStatus.textContent = 'Sending a new verification email...';
      try {
        const data = await request('/v1/auth/email/resend', { method: 'POST', body: JSON.stringify({ email }) });
        const message = data.message || 'A new verification email was sent.';
        authMessage.textContent = message;
        if (emailVerificationStatus) emailVerificationStatus.textContent = message;
      } catch (error) {
        const message = error.message || 'The verification email could not be sent.';
        authMessage.textContent = message;
        if (emailVerificationStatus) emailVerificationStatus.textContent = message;
      } finally {
        resendEmailVerificationButton.disabled = false;
      }
    });
    const verificationParams = new URLSearchParams(window.location.search);
    if (verificationParams.get('verify') === '1') {
      if (verificationParams.get('email')) signupForm.elements.email.value = verificationParams.get('email');
      pendingSignupEmail = verificationParams.get('email')?.trim() || '';
      if (verificationParams.get('code')) emailVerificationCode.value = verificationParams.get('code');
      showEmailVerification();
      if (verificationParams.get('code')) verifySignupEmail();
    }

    signupForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(signupForm).entries());
      let deviceFingerprint = localStorage.getItem('kieltechDeviceFingerprint');
      if (!deviceFingerprint) {
        deviceFingerprint = (window.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem('kieltechDeviceFingerprint', deviceFingerprint);
      }
      payload.device_fingerprint = deviceFingerprint;
      authMessage.textContent = 'Creating account...';
      try {
        const data = await request('/v1/auth/signup', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        pendingSignupEmail = data.email || payload.email;
        authMessage.textContent = data.message || 'Account created. Check your email to verify it.';
        showEmailVerification();
      } catch (error) {
        const errorMessage = error.message || '';
        authMessage.textContent = /too many signup attempts/i.test(errorMessage)
          ? 'Too many signup attempts from this network. Please try again later.'
          : /device has already been used|pending signup/i.test(errorMessage)
          ? 'This device already has an account or pending signup. Please log in or verify the existing signup.'
          : /username already taken/i.test(errorMessage)
          ? 'That username is already taken. Choose another username.'
          : /servers are facing|Unable to reach the server|backend is unavailable/i.test(errorMessage)
          ? 'The servers are facing some issues right now. Please try again.'
          : errorMessage;
      }
    });
  }

  if (downloadList) {
    loadDownloads();
  }

  if (dashboardPanel) {
    loadDashboard();
  }

  if (document.getElementById('dashboardContent')) {
    renderDashboardCards();
  }

  if (document.getElementById('billingPanel')) {
    loadBillingPanel();
  }

  initAdminCustomersPage();
  initAdminEnterprisePage();
  initAdminEmailPage();

  initBillingPage();
  initSettingsPage();
  initWebDevelopmentExperience();

  const isTokenPage = window.location.pathname.includes('/tokens') || window.location.pathname.includes('/dashboard/tokens') || window.location.pathname.endsWith('/tokens.html');
  if (isTokenPage) {
    initTokenManager();
  }
}

async function loadDownloads() {
  const downloadList = document.getElementById('downloadList');
  if (!downloadList) return;

  try {
    const data = await request('/v1/downloads');
    const ratingsData = await request('/v1/ratings');
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
      const sizeText = download.file_size ? `Size: ${formatBytes(download.file_size)}` : '';
      const checksumText = download.file_sha256 ? `SHA256: ${download.file_sha256}` : '';
      card.innerHTML = `
        <h3>${download.title}</h3>
        <p>${download.description}</p>
        <p class="demo-response">Downloads: ${formatCompactNumber(download.downloads_count)}</p>
        <p class="demo-response">Average rating: ${average}</p>
        <p class="demo-response">${sizeText} ${checksumText}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-download-id="${download.id}">Download product</button>
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
        button.textContent = 'Preparing download...';
        try {
          const data = await request(`/v1/downloads/${id}`, { method: 'POST' });
          const fileUrl = `${getApiBaseUrl()}${data.download.file_url}`;
          window.location.href = fileUrl;
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
          await request('/v1/ratings', {
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

function formatBytes(bytes, decimals = 1) {
  if (!bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatCompactNumber(value) {
  if (value === null || value === undefined) return '0';
  if (value < 1000) return String(value);
  const units = ['K', 'M', 'B'];
  let unitIndex = -1;
  let num = value;
  while (num >= 1000 && unitIndex < units.length - 1) {
    num /= 1000;
    unitIndex += 1;
  }
  return `${parseFloat(num.toFixed(1))}${units[unitIndex]}`;
}

function formatCurrency(value, currency = 'USD') {
  const numericValue = Number(value || 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: numericValue >= 1 ? 2 : 4,
    maximumFractionDigits: numericValue >= 1 ? 2 : 6,
  }).format(numericValue);
}

function toMinorUnits(value) {
  return Math.round(Number(value || 0) * 100);
}

function getRateLimitTier(balance, accountStatus) {
  const numericBalance = Number(balance || 0);
  const normalizedStatus = String(accountStatus || 'free_tier').toLowerCase();

  if (numericBalance >= 1501) {
    return {
      name: 'Ultra',
      min: 1501,
      max: '∞',
      rpm: 5000,
      nextTier: null,
      nextAmount: 0,
      progressPercent: 100,
      badge: normalizedStatus === 'active_paid' ? 'Active paid' : 'Ultra',
    };
  }

  if (numericBalance >= 501) {
    return {
      name: 'Elite',
      min: 501,
      max: 1500,
      rpm: 1000,
      nextTier: 'Ultra',
      nextAmount: Math.max(0, 1501 - numericBalance),
      progressPercent: Math.min(100, Math.round((numericBalance / 1501) * 100)),
      badge: normalizedStatus === 'active_paid' ? 'Active paid' : 'Elite',
    };
  }

  if (numericBalance >= 101) {
    return {
      name: 'Pro',
      min: 101,
      max: 500,
      rpm: 300,
      nextTier: 'Elite',
      nextAmount: Math.max(0, 501 - numericBalance),
      progressPercent: Math.min(100, Math.round((numericBalance / 501) * 100)),
      badge: normalizedStatus === 'active_paid' ? 'Active paid' : 'Pro',
    };
  }

  return {
    name: 'Standard',
    min: 1,
    max: 100,
    rpm: 60,
    nextTier: 'Pro',
    nextAmount: Math.max(1, 101 - numericBalance),
    progressPercent: Math.min(100, Math.round((numericBalance / 101) * 100)),
    badge: normalizedStatus === 'active_paid' ? 'Active paid' : 'Standard',
  };
}

function getTierDefinitions() {
  return [
    { name: 'Standard', min: 1, max: 100, rpm: 60, range: '$1 - $100', benefit: 'Up to 60 RPM' },
    { name: 'Pro', min: 101, max: 500, rpm: 300, range: '$101 - $500', benefit: 'Up to 300 RPM' },
    { name: 'Elite', min: 501, max: 1500, rpm: 1000, range: '$501 - $1,500', benefit: 'Up to 1,000 RPM' },
    { name: 'Ultra', min: 1501, max: 5000, rpm: 5000, range: '$1,501+', benefit: 'Up to 5,000 RPM' },
    { name: 'Enterprise / Dedicated', min: 5001, max: null, rpm: 'Custom', range: 'Custom', benefit: 'Dedicated RunPod GPU clusters, fine-tuning, and SLAs' },
  ];
}

function getTierForAmount(amount, selectedTierName) {
  const tierDefinitions = getTierDefinitions();
  const numericAmount = Number(amount || 0);
  const requestedTier = tierDefinitions.find((tier) => tier.name === selectedTierName) || tierDefinitions[0];
  if (!numericAmount) {
    return requestedTier;
  }

  const matchingTier = tierDefinitions.find((tier) => numericAmount >= tier.min && (tier.max === null || numericAmount <= tier.max));
  if (matchingTier) {
    return matchingTier;
  }

  if (requestedTier.max !== null && numericAmount > requestedTier.max) {
    const nextTierIndex = tierDefinitions.findIndex((tier) => tier.name === requestedTier.name) + 1;
    if (nextTierIndex >= 0 && nextTierIndex < tierDefinitions.length) {
      return tierDefinitions[nextTierIndex];
    }
  }

  return requestedTier;
}

function renderBillingTierCards(selectedTierName = 'Standard') {
  const container = document.getElementById('billingTierGrid');
  if (!container) return;

  const selectedTier = getTierDefinitions().find((tier) => tier.name === selectedTierName) || getTierDefinitions()[0];
  container.innerHTML = getTierDefinitions().map((tier) => {
    const rpmLabel = typeof tier.rpm === 'number' ? `${tier.rpm.toLocaleString()} RPM` : tier.rpm;
    const isSelected = tier.name === selectedTier.name;
    return `
      <button class="billing-tier-card ${isSelected ? 'is-selected' : ''}" type="button" data-tier-name="${escapeHtml(tier.name)}" aria-pressed="${isSelected}">
        <div class="billing-tier-card__header">
          <div>
            <div class="billing-tier-card__eyebrow">Wallet tier</div>
            <strong>${escapeHtml(tier.name)}</strong>
          </div>
          <span class="billing-tier-card__selection">${isSelected ? 'Selected' : 'Choose tier'}</span>
        </div>
        <div>
          <span class="billing-tier-card__price-label">Top-up range</span>
          <div class="billing-tier-card__price">${escapeHtml(tier.range)}</div>
        </div>
        <div class="billing-tier-card__limit"><span>Request limit</span><strong>${escapeHtml(rpmLabel)}</strong></div>
      </button>
    `;
  }).join('');

  container.querySelectorAll('[data-tier-name]').forEach((button) => {
    button.addEventListener('click', () => {
      const tierName = button.getAttribute('data-tier-name');
      const tier = getTierDefinitions().find((item) => item.name === tierName);
      const amountInput = document.getElementById('billingAmountInput');
      if (tier && tier.name !== 'Enterprise / Dedicated' && amountInput) {
        const currentAmount = Number(amountInput.value || 0);
        amountInput.value = String(Math.max(tier.min, tier.max === null ? currentAmount : Math.min(currentAmount, tier.max)));
        amountInput.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      renderBillingTierCards(tierName);
      updateBillingSelectionSummary(tierName);
    });
  });
}

function updateBillingSelectionSummary(selectedTierName = 'Standard') {
  const badge = document.getElementById('selectedTierBadge');
  const rpmLabel = document.getElementById('selectedTierRpm');
  const note = document.getElementById('selectedTierNote');
  const amountField = document.getElementById('billingAmountField');
  const billingSummary = document.querySelector('.billing-summary-card');
  const enterpriseContactForm = document.getElementById('billingEnterpriseContactForm');
  const initializeButton = document.getElementById('billingInitializeButton');
  const enterpriseSalesLink = document.getElementById('enterpriseSalesLink');
  if (!badge || !rpmLabel || !note) return;

  const tier = getTierDefinitions().find((item) => item.name === selectedTierName) || getTierDefinitions()[0];
  badge.textContent = tier.name;
  rpmLabel.textContent = typeof tier.rpm === 'number' ? `${tier.rpm} RPM` : tier.rpm;

  if (tier.name === 'Enterprise / Dedicated') {
    note.textContent = 'Custom fine-tuning, dedicated RunPod GPU nodes, and SLA-backed infrastructure are available for enterprise workloads.';
    amountField?.classList.add('hidden');
    billingSummary?.classList.add('hidden');
    enterpriseContactForm?.classList.add('is-visible');
    initializeButton?.classList.add('hidden');
    enterpriseSalesLink?.classList.remove('hidden');
  } else {
    note.textContent = `Balances in the ${tier.name} tier support ${tier.range.toLowerCase()} before the next tier unlocks.`;
    amountField?.classList.remove('hidden');
    billingSummary?.classList.remove('hidden');
    enterpriseContactForm?.classList.remove('is-visible');
    initializeButton?.classList.remove('hidden');
    enterpriseSalesLink?.classList.add('hidden');
  }
}

function openTierOverflowModal() {
  const modal = document.getElementById('tierOverflowModal');
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTierOverflowModal() {
  const modal = document.getElementById('tierOverflowModal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  modal.hidden = true;
}

async function getAdminWebDevelopmentRequests() {
  const response = await fetch(`${getApiBaseUrl()}/v1/admin/web-development/requests`, {
    credentials: 'include'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Unable to load web-development requests');
  }
  return Array.isArray(payload.requests) ? payload.requests : [];
}

async function updateAdminWebDevelopmentRequest(requestId, reviewStatus, status) {
  const response = await fetch(`${getApiBaseUrl()}/v1/admin/web-development/requests/${requestId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      review_status: reviewStatus,
      review_note: `${reviewStatus === 'approved' ? 'Approved' : 'Rejected'} from the admin dashboard`,
      status,
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Unable to update web-development request');
  }
  return payload;
}

async function loadDashboard() {
  const dashboardPanel = document.getElementById('dashboardPanel');
  if (!dashboardPanel) return;

  if (!state.token) {
    dashboardPanel.innerHTML = '<div class="card"><h3>Access required</h3><p>Please <a href="login.html" class="text-link">log in</a> to view your dashboard.</p></div>';
    return;
  }

  try {
    const profile = await request('/v1/auth/me');
    const [wallet, usage] = await Promise.all([
      request(`/v1/billing/wallet?email=${encodeURIComponent(profile.user.email)}`),
      request(`/v1/billing/usage?email=${encodeURIComponent(profile.user.email)}`),
    ]);
    const stats = await request('/v1/admin/stats').catch(() => null);
    const moderation = profile.user.is_admin ? await request('/v1/admin/moderation').catch(() => null) : null;
    const webDevelopmentRequests = profile.user.is_admin ? await getAdminWebDevelopmentRequests().catch(() => []) : [];

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

    const webDevelopmentMarkup = profile.user.is_admin ? `
      <div class="card">
        <h3>Web-development requests</h3>
        <div class="list-stack">
          ${webDevelopmentRequests.length ? webDevelopmentRequests.map((item) => `
            <div class="list-item">
              <div>
                <strong>${escapeHtml(item.project_name || 'Untitled request')}</strong>
                <p class="demo-response">${escapeHtml(item.email || '')} • ${escapeHtml(item.review_status || 'pending')} / ${escapeHtml(item.status || 'reviewing')}</p>
              </div>
              <div class="hero-actions">
                <button class="btn btn-primary" data-web-dev-action="approve" data-id="${item.id}" data-review-status="approved" data-status="queued">Approve</button>
                <button class="btn btn-secondary" data-web-dev-action="reject" data-id="${item.id}" data-review-status="rejected" data-status="failed">Reject</button>
                <button class="btn btn-secondary" data-web-dev-action="queue" data-id="${item.id}" data-review-status="approved" data-status="queued">Queue</button>
              </div>
            </div>
          `).join('') : '<div class="demo-response">No web-development requests pending review.</div>'}
        </div>
      </div>
    ` : '';

    const enterpriseBadge = wallet?.is_enterprise_dedicated || profile.user.is_enterprise_dedicated ? 'Enterprise access active' : 'Member access';

    dashboardPanel.innerHTML = `
      <div class="dashboard-shell">
        <div class="card dashboard-hero">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>Welcome back, ${profile.user.name}</h2>
            <p class="hero-copy">Your account is connected to the KielTech dashboard with secure access to downloads, ratings, and moderation tools.</p>
          </div>
          <div class="pill">${profile.user.role === 'owner' ? 'Owner access active' : profile.user.is_admin ? 'Admin access active' : enterpriseBadge}</div>
        </div>
        ${statCards}
        <div class="card">
          <h3>Account details</h3>
          <p class="demo-response">Email: ${profile.user.email}</p>
          <p class="demo-response">Role: ${profile.user.role === 'owner' ? 'Owner' : profile.user.is_admin ? 'Administrator' : 'Member'}</p>
          <p class="demo-response">Usage: ${usage.current_usage || 0}/${usage.included_limit || 1000} requests</p>
          <p class="demo-response">Enterprise status: ${wallet?.is_enterprise_dedicated || profile.user.is_enterprise_dedicated ? 'Dedicated bypass enabled' : 'Standard access'}</p>
        </div>
        ${moderationMarkup}
        ${webDevelopmentMarkup}
      </div>
    `;

    dashboardPanel.querySelectorAll('[data-admin-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const type = button.getAttribute('data-admin-action');
        const id = button.getAttribute('data-id');
        const action = button.getAttribute('data-action');
        try {
          await request(`/v1/admin/moderation/${type}/${id}`, {
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

    dashboardPanel.querySelectorAll('[data-web-dev-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const requestId = button.getAttribute('data-id');
        const reviewStatus = button.getAttribute('data-review-status');
        const status = button.getAttribute('data-status');
        if (!requestId || !reviewStatus || !status) return;

        try {
          await updateAdminWebDevelopmentRequest(requestId, reviewStatus, status);
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

function getStoredTheme() {
  try {
    return localStorage.getItem('kieltech-theme');
  } catch (error) {
    return null;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem('kieltech-theme', theme);
  } catch (error) {
    // Ignore storage failures and keep the UI state working.
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme) {
  return theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system';
}

function ensureThemeOverrides() {
  let style = document.getElementById('kieltechThemeOverrides');
  if (style) return style;
  style = document.createElement('style');
  style.id = 'kieltechThemeOverrides';
  style.textContent = `
    html[data-theme='light'] body:not(.studio-app) {
      --page-bg: #f3f7fb !important;
      --page-surface: #ffffff !important;
      --surface: #ffffff !important;
      --border: rgba(30, 64, 90, .16) !important;
      --text: #172b3d !important;
      --muted: #526a7d !important;
      color-scheme: light;
    }
    html[data-theme='light'] body:not(.studio-app) .api-page,
    html[data-theme='light'] body:not(.studio-app) .platform-page,
    html[data-theme='light'] body:not(.studio-app) .status-page,
    html[data-theme='light'] body:not(.studio-app) .models-page,
    html[data-theme='light'] body:not(.studio-app) .model-status-page,
    html[data-theme='light'] body:not(.studio-app) .pricing-page,
    html[data-theme='light'] body:not(.studio-app) .referral-page,
    html[data-theme='light'] body:not(.studio-app) .billing-page {
      background: #f3f7fb !important;
      color: #172b3d !important;
    }
    html[data-theme='light'] body:not(.studio-app) .api-page .api-hero,
    html[data-theme='light'] body:not(.studio-app) .hero-card,
    html[data-theme='light'] body:not(.studio-app) .product-card,
    html[data-theme='light'] body:not(.studio-app) .dashboard-card,
    html[data-theme='light'] body:not(.studio-app) .api-form-card,
    html[data-theme='light'] body:not(.studio-app) .demo-card,
    html[data-theme='light'] body:not(.studio-app) .panel,
    html[data-theme='light'] body:not(.studio-app) .surface,
    html[data-theme='light'] body:not(.studio-app) .platform-page .platform-card,
    html[data-theme='light'] body:not(.studio-app) .models-page .model-card,
    html[data-theme='light'] body:not(.studio-app) .model-status-page .status-card,
    html[data-theme='light'] body:not(.studio-app) .pricing-page .pricing-card,
    html[data-theme='light'] body:not(.studio-app) .referral-page .referral-share-panel,
    html[data-theme='light'] body:not(.studio-app) .referral-page .referral-aside-panel,
    html[data-theme='light'] body:not(.studio-app) .referral-page .referral-stat,
    html[data-theme='light'] body:not(.studio-app) .referral-page .referral-list-panel,
    html[data-theme='light'] body:not(.studio-app) .billing-page .card,
    html[data-theme='light'] body:not(.studio-app) .billing-page .billing-card {
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 16px 36px rgba(30, 64, 90, .1) !important;
    }
    html[data-theme='light'] body.model-status-page .model-card,
    html[data-theme='light'] body.model-status-page .summary,
    html[data-theme='light'] body.model-status-page .search,
    html[data-theme='light'] body.model-status-page .provider-chip,
    html[data-theme='light'] body.model-status-page .metric,
    html[data-theme='light'] body.model-status-page .view-switch {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body.model-status-page .search input {
      color: #172b3d !important;
    }
    html[data-theme='light'] body.model-status-page .search input::placeholder {
      color: #718596 !important;
    }
    html[data-theme='light'] body.model-status-page .model-title,
    html[data-theme='light'] body.model-status-page .model-title span,
    html[data-theme='light'] body.model-status-page .summary strong,
    html[data-theme='light'] body.model-status-page .stat-value,
    html[data-theme='light'] body.model-status-page .summary b {
      color: #172b3d !important;
    }
    html[data-theme='light'] body.model-status-page .subtitle,
    html[data-theme='light'] body.model-status-page .stat-label,
    html[data-theme='light'] body.model-status-page .summary .subtitle,
    html[data-theme='light'] body.model-status-page .legend span,
    html[data-theme='light'] body.model-status-page .provider-chip {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.model-status-page .provider-chip.is-active,
    html[data-theme='light'] body.model-status-page .metric.is-active {
      color: #17627d !important;
      background: #e2f3fa !important;
      border-color: rgba(8, 126, 164, .28) !important;
    }
    html[data-theme='light'] body.model-status-page .view-switch button {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.model-status-page .view-switch button.is-active {
      color: #073b55 !important;
      background: #e2f3fa !important;
    }
    html[data-theme='light'] body.referral-page .referral-share-panel,
    html[data-theme='light'] body.referral-page .referral-aside-panel,
    html[data-theme='light'] body.referral-page .referral-stat,
    html[data-theme='light'] body.referral-page .referral-list-panel {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body.referral-page .referral-code-title h2,
    html[data-theme='light'] body.referral-page .referral-list-panel h2,
    html[data-theme='light'] body.referral-page .referral-aside-panel h2,
    html[data-theme='light'] body.referral-page .referral-stat strong,
    html[data-theme='light'] body.referral-page .referral-aside-panel strong {
      color: #172b3d !important;
    }
    html[data-theme='light'] body.referral-page .referral-heading p,
    html[data-theme='light'] body.referral-page .referral-share-panel__top,
    html[data-theme='light'] body.referral-page .referral-stat__label,
    html[data-theme='light'] body.referral-page .referral-stat small,
    html[data-theme='light'] body.referral-page .referral-list,
    html[data-theme='light'] body.referral-page .referral-aside-panel p,
    html[data-theme='light'] body.referral-page .referral-aside-panel li {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.referral-page .referral-share-panel__link {
      color: #24536d !important;
      background: #f6fafc !important;
      border-color: rgba(30, 64, 90, .16) !important;
    }
    html[data-theme='light'] body.referral-page .referral-copy-button {
      color: #24536d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .24) !important;
    }
    html[data-theme='light'] body.referral-page .referral-copy-button:hover {
      color: #073b55 !important;
      background: #e2f3fa !important;
      border-color: #087ea4 !important;
    }
    html[data-theme='light'] body.referral-page .referral-aside-panel hr {
      border-top-color: rgba(30, 64, 90, .16) !important;
    }
    html[data-theme='light'] body.api-page .api-section--alt,
    html[data-theme='light'] body.api-page .api-panel,
    html[data-theme='light'] body.api-page .api-card,
    html[data-theme='light'] body.api-page .api-doc-panel,
    html[data-theme='light'] body.api-page .api-code,
    html[data-theme='light'] body.api-page .api-field input,
    html[data-theme='light'] body.api-page .api-field textarea,
    html[data-theme='light'] body.api-page .api-field select {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body.api-page .api-section--alt {
      background: #eaf2f7 !important;
    }
    html[data-theme='light'] body.api-page .api-card h3,
    html[data-theme='light'] body.api-page .api-panel h3,
    html[data-theme='light'] body.api-page .api-code,
    html[data-theme='light'] body.api-page .api-field,
    html[data-theme='light'] body.api-page .api-tab,
    html[data-theme='light'] body.api-page .api-badge {
      color: #172b3d !important;
    }
    html[data-theme='light'] body.api-page .api-card p,
    html[data-theme='light'] body.api-page .api-meta,
    html[data-theme='light'] body.api-page .api-meta span,
    html[data-theme='light'] body.api-page .api-heading p:not(.eyebrow),
    html[data-theme='light'] body.api-page .api-note {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.api-page .api-pill,
    html[data-theme='light'] body.api-page .api-status,
    html[data-theme='light'] body.api-page .api-badge {
      color: #17627d !important;
      background: #e2f3fa !important;
      border-color: rgba(8, 126, 164, .24) !important;
    }
    html[data-theme='light'] body.api-page .api-tabs,
    html[data-theme='light'] body.api-page .api-tab.is-active {
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
    }
    html[data-theme='light'] body.api-page .api-tab.is-active {
      color: #073b55 !important;
      box-shadow: inset 0 -2px 0 #087ea4 !important;
    }
    html[data-theme='light'] body.api-page .api-link {
      color: #087ea4 !important;
    }
    html[data-theme='light'] body.api-page .api-link-grid,
    html[data-theme='light'] body.api-page .api-nav-link,
    html[data-theme='light'] body.api-page .api-cta {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body.api-page .api-nav-link {
      color: #17627d !important;
    }
    html[data-theme='light'] body.api-page .api-nav-link small,
    html[data-theme='light'] body.api-page .api-cta p {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.api-page .api-nav-link:hover {
      color: #073b55 !important;
      background: #e2f3fa !important;
      border-color: #087ea4 !important;
    }
    html[data-theme='light'] body.billing-page .billing-controls-card,
    html[data-theme='light'] body.billing-page .billing-stat-card,
    html[data-theme='light'] body.billing-page .billing-summary-card,
    html[data-theme='light'] body.billing-page .enterprise-passkey-card,
    html[data-theme='light'] body.billing-page .overage-policy-card,
    html[data-theme='light'] body.billing-page .billing-enterprise-form,
    html[data-theme='light'] body.billing-page .billing-tier-card,
    html[data-theme='light'] body.billing-page .billing-rate-button {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body.billing-page .billing-controls-card h2,
    html[data-theme='light'] body.billing-page .billing-controls-card h3,
    html[data-theme='light'] body.billing-page .billing-stat-card h3,
    html[data-theme='light'] body.billing-page .enterprise-passkey-card h3,
    html[data-theme='light'] body.billing-page .overage-policy-card h3,
    html[data-theme='light'] body.billing-page .billing-enterprise-form h3 {
      color: #172b3d !important;
    }
    html[data-theme='light'] body.billing-page .billing-controls-card p,
    html[data-theme='light'] body.billing-page .billing-stat-card .demo-response,
    html[data-theme='light'] body.billing-page .enterprise-passkey-card .demo-response,
    html[data-theme='light'] body.billing-page .overage-policy-card__description,
    html[data-theme='light'] body.billing-page .billing-enterprise-form__intro,
    html[data-theme='light'] body.billing-page .billing-field,
    html[data-theme='light'] body.billing-page .playground-label,
    html[data-theme='light'] body.billing-page .billing-rate-selector__label {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.billing-page .billing-controls-card input,
    html[data-theme='light'] body.billing-page .billing-enterprise-form input,
    html[data-theme='light'] body.billing-page .billing-enterprise-form select,
    html[data-theme='light'] body.billing-page .billing-enterprise-form textarea,
    html[data-theme='light'] body.billing-page .billing-rate-button {
      color: #172b3d !important;
      background: #f6fafc !important;
      border-color: rgba(30, 64, 90, .22) !important;
    }
    html[data-theme='light'] body.billing-page .overage-policy-card__toggle,
    html[data-theme='light'] body.billing-page .overage-policy-card__notice {
      color: #526a7d !important;
      background: #f6fafc !important;
      border-color: rgba(30, 64, 90, .16) !important;
    }
    html[data-theme='light'] body.billing-page .overage-policy-card__notice strong,
    html[data-theme='light'] body.billing-page .billing-enterprise-form__eyebrow,
    html[data-theme='light'] body.billing-page .overage-policy-card__eyebrow {
      color: #087ea4 !important;
    }
    html[data-theme='light'] body.billing-page .billing-rate-button:hover,
    html[data-theme='light'] body.billing-page .billing-rate-button.is-selected {
      color: #073b55 !important;
      background: #e2f3fa !important;
      border-color: #087ea4 !important;
    }
    html[data-theme='light'] body.billing-page .modal__content {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .18) !important;
    }
    html[data-theme='light'] body.billing-page .modal__subtitle,
    html[data-theme='light'] body.billing-page .modal-security-note {
      color: #526a7d !important;
    }
    html[data-theme='light'] body.billing-page .modal__content .billing-field input {
      color: #172b3d !important;
      background: #f6fafc !important;
      border-color: rgba(30, 64, 90, .22) !important;
    }
    html[data-theme='light'] body:has(.billing-page) .overage-policy-card__toggle {
      color: #172b3d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .22) !important;
      box-shadow: 0 4px 12px rgba(30, 64, 90, .08) !important;
    }
    html[data-theme='light'] body:has(.billing-page) .overage-policy-card__toggle input {
      width: 1.15rem;
      height: 1.15rem;
      accent-color: #087ea4;
    }
    html[data-theme='light'] body:has(.billing-page) .overage-policy-card__notice {
      color: #526a7d !important;
      background: #fff8df !important;
      border-color: rgba(180, 130, 0, .25) !important;
    }
    html[data-theme='light'] body:not(.studio-app) h1,
    html[data-theme='light'] body:not(.studio-app) h2,
    html[data-theme='light'] body:not(.studio-app) h3,
    html[data-theme='light'] body:not(.studio-app) h4,
    html[data-theme='light'] body:not(.studio-app) strong {
      color: #172b3d !important;
    }
    html[data-theme='light'] body:not(.studio-app) .api-page h1,
    html[data-theme='light'] body:not(.studio-app) .api-page h2,
    html[data-theme='light'] body:not(.studio-app) .api-page h3,
    html[data-theme='light'] body:not(.studio-app) .platform-page h1,
    html[data-theme='light'] body:not(.studio-app) .platform-page h2,
    html[data-theme='light'] body:not(.studio-app) .platform-page h3,
    html[data-theme='light'] body:not(.studio-app) .models-page h1,
    html[data-theme='light'] body:not(.studio-app) .models-page h2,
    html[data-theme='light'] body:not(.studio-app) .models-page h3,
    html[data-theme='light'] body:not(.studio-app) .model-status-page h1,
    html[data-theme='light'] body:not(.studio-app) .model-status-page h2,
    html[data-theme='light'] body:not(.studio-app) .model-status-page h3,
    html[data-theme='light'] body:not(.studio-app) .status-page h1,
    html[data-theme='light'] body:not(.studio-app) .status-page h2,
    html[data-theme='light'] body:not(.studio-app) .status-page h3,
    html[data-theme='light'] body:not(.studio-app) .pricing-page h1,
    html[data-theme='light'] body:not(.studio-app) .pricing-page h2,
    html[data-theme='light'] body:not(.studio-app) .pricing-page h3,
    html[data-theme='light'] body:not(.studio-app) .referral-page h1,
    html[data-theme='light'] body:not(.studio-app) .referral-page h2,
    html[data-theme='light'] body:not(.studio-app) .referral-page h3,
    html[data-theme='light'] body:not(.studio-app) .billing-page h1,
    html[data-theme='light'] body:not(.studio-app) .billing-page h2,
    html[data-theme='light'] body:not(.studio-app) .billing-page h3 {
      color: #172b3d !important;
    }
    html[data-theme='light'] body:not(.studio-app) .status-page .status-section--alt {
      background: #eaf2f7 !important;
      border-color: rgba(30, 64, 90, .12) !important;
    }
    html[data-theme='light'] body:not(.studio-app) .status-page .status-summary,
    html[data-theme='light'] body:not(.studio-app) .status-page .status-card {
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .16) !important;
      box-shadow: 0 14px 30px rgba(30, 64, 90, .1) !important;
    }
    html[data-theme='light'] body:not(.studio-app) p:not(.eyebrow),
    html[data-theme='light'] body:not(.studio-app) li,
    html[data-theme='light'] body:not(.studio-app) td,
    html[data-theme='light'] body:not(.studio-app) th,
    html[data-theme='light'] body:not(.studio-app) label,
    html[data-theme='light'] body:not(.studio-app) small,
    html[data-theme='light'] body:not(.studio-app) .subtitle,
    html[data-theme='light'] body:not(.studio-app) .muted,
    html[data-theme='light'] body:not(.studio-app) .demo-response {
      color: #526a7d !important;
    }
    html[data-theme='light'] body:not(.studio-app) .eyebrow,
    html[data-theme='light'] body:not(.studio-app) .status-label,
    html[data-theme='light'] body:not(.studio-app) .pill,
    html[data-theme='light'] body:not(.studio-app) .token-badge {
      color: #087ea4 !important;
    }
    html[data-theme='light'] body:not(.studio-app) a:not(.btn):not(.nav-pill) {
      color: #087ea4;
    }
    html[data-theme='light'] body:not(.studio-app) .btn-secondary,
    html[data-theme='light'] body:not(.studio-app) .nav-pill--secondary,
    html[data-theme='light'] body:not(.studio-app) button:not(.btn-primary):not(.btn-danger):not(.theme-toggle):not(.service-drawer-toggle) {
      color: #24536d !important;
      background: #ffffff !important;
      border-color: rgba(30, 64, 90, .24) !important;
    }
    html[data-theme='light'] body:not(.studio-app) .btn-secondary:hover,
    html[data-theme='light'] body:not(.studio-app) .nav-pill--secondary:hover,
    html[data-theme='light'] body:not(.studio-app) button:not(.btn-primary):not(.btn-danger):not(.theme-toggle):not(.service-drawer-toggle):hover {
      color: #073b55 !important;
      background: #e2f3fa !important;
      border-color: #087ea4 !important;
    }
    html[data-theme='light'] body:not(.studio-app) table {
      color: #526a7d !important;
      border-color: rgba(30, 64, 90, .16) !important;
    }
    html[data-theme='light'] body:not(.studio-app) input,
    html[data-theme='light'] body:not(.studio-app) textarea,
    html[data-theme='light'] body:not(.studio-app) select,
    html[data-theme='light'] body:not(.studio-app) .code-block,
    html[data-theme='light'] body:not(.studio-app) pre {
      background: #f6fafc !important;
      color: #172b3d !important;
      border-color: rgba(30, 64, 90, .22) !important;
    }
    html[data-theme='light'] body:not(.studio-app) .nav,
    html[data-theme='light'] body:not(.studio-app) .hero-small,
    html[data-theme='light'] body:not(.studio-app) .tokens-topbar {
      border-color: rgba(30, 64, 90, .16) !important;
    }
  `;
  document.head.appendChild(style);
  return style;
}

function applyTheme(theme) {
  const resolvedTheme = resolveTheme(theme);
  const effectiveTheme = resolvedTheme === 'system' ? getSystemTheme() : resolvedTheme;
  const isLight = effectiveTheme === 'light';

  ensureThemeOverrides();
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  document.documentElement.style.colorScheme = isLight ? 'light' : 'dark';
  document.body?.setAttribute('data-theme', effectiveTheme);
  document.body.classList.toggle('light-mode', isLight);
  document.body.classList.toggle('dark-mode', !isLight);
  document.body.dataset.themePreference = resolvedTheme;

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    const themeIcon = isLight
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.985 12.486A9 9 0 1 1 11.514 3.015a.75.75 0 0 0 9.471 9.471Z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>';
    const iconClass = isLight ? 'theme-toggle__icon theme-toggle__icon--light' : 'theme-toggle__icon';
    toggle.innerHTML = `<span class="${iconClass}" aria-hidden="true">${themeIcon}</span>`;
    toggle.setAttribute('aria-label', `Switch to ${isLight ? 'dark' : 'light'} theme. Current theme: ${resolvedTheme}.`);
    toggle.setAttribute('title', `Switch to ${isLight ? 'dark' : 'light'} theme`);
  }

  const menu = document.getElementById('themeMenu');
  if (menu) {
    menu.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.classList.toggle('is-active', option.getAttribute('data-theme-option') === resolvedTheme);
    });
  }
}

function initTheme() {
  const savedTheme = getStoredTheme();
  const preferredTheme = savedTheme ? resolveTheme(savedTheme) : 'system';
  applyTheme(preferredTheme);
}

function bindThemeToggle() {
  let toggle = document.getElementById('themeToggle');
  if (!toggle) {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    toggle = document.createElement('button');
    toggle.id = 'themeToggle';
    toggle.className = 'theme-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Choose theme');
    toggle.textContent = 'Theme';
    nav.appendChild(toggle);
  }

  let menu = document.getElementById('themeMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'themeMenu';
    menu.className = 'theme-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button class="theme-menu__option" type="button" data-theme-option="light" role="menuitem">Light</button>
      <button class="theme-menu__option" type="button" data-theme-option="dark" role="menuitem">Dark</button>
      <button class="theme-menu__option" type="button" data-theme-option="system" role="menuitem">System</button>
    `;

    const navActions = toggle.closest('.nav-actions');
    if (navActions) {
      navActions.appendChild(menu);
    } else {
      toggle.parentNode.appendChild(menu);
    }
  }

  applyTheme(resolveTheme(getStoredTheme()));

  const closeMenu = () => menu.classList.remove('is-open');

  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');

  const toggleTheme = () => {
    const nextTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    saveTheme(nextTheme);
    applyTheme(nextTheme);
    closeMenu();
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTheme();
  });

  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      menu.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      menu.querySelector('.is-active')?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleTheme();
    }
  });

  menu.querySelectorAll('[data-theme-option]').forEach((option) => {
    option.addEventListener('click', () => {
      const nextTheme = option.getAttribute('data-theme-option');
      saveTheme(nextTheme);
      applyTheme(nextTheme);
      closeMenu();
      toggle.setAttribute('aria-expanded', 'false');
    });
    option.addEventListener('keydown', (event) => {
      const options = Array.from(menu.querySelectorAll('[data-theme-option]'));
      const index = options.indexOf(option);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
      } else if (event.key === 'Escape') {
        closeMenu();
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  });

  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && event.target !== toggle) {
      closeMenu();
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  if (window.matchMedia) {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      const currentTheme = resolveTheme(getStoredTheme());
      if (currentTheme === 'system') {
        applyTheme('system');
      }
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', handleSystemThemeChange);
    else mediaQuery.addListener(handleSystemThemeChange);
  }
}

async function initModelsPage() {
  if (!document.body.classList.contains('models-page') || !state.token) return;
  try {
    const summary = await request('/v1/models/summary');
    const plan = document.getElementById('modelsCurrentPlan');
    const available = document.getElementById('modelsAvailableCount');
    const locked = document.getElementById('modelsLockedCount');
    if (plan) plan.textContent = summary.plan || 'Free';
    if (available) available.textContent = `${Number(summary.available_models || 0).toLocaleString()} models`;
    if (locked) locked.textContent = `${Number(summary.locked_models || 0).toLocaleString()} models`;
  } catch (error) {
    console.warn('Unable to load live model summary:', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initCookieConsent();
  initTheme();
  bindThemeToggle();
  initStudioWebsiteNameEditor();
  initStudioProjectManagement();
  initStudioModelSelector();
  initStudioPublishWorkflow();
  initStudioSharePanel();
  initStudioSuggestionChips();
  initStudioSharedView();
  init();
  initModelsPage();
  renderHumanInstallers();
});

function updateFileChangeList(files = []) {
  const listContainer = document.getElementById('studioFileChangeList');
  const countBadge = document.querySelector('.studio-file-changes__count');
  
  if (!listContainer) return;
  
  // Clear existing items
  listContainer.innerHTML = '';
  
  // Update count badge
  if (countBadge) {
    countBadge.textContent = files.length;
  }

  // Render every file item without truncation limits
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'studio-file-change-item';
    item.innerHTML = `
      <span class="studio-file-change-item__name" title="${file}">${file}</span>
      <span class="studio-file-change-item__status">✔</span>
    `;
    listContainer.appendChild(item);
  });
}

/* Additional studio helpers: simple prompt enable/disable and resizer logic */
document.addEventListener('DOMContentLoaded', () => {
  // Input Enable/Disable Logic
  const promptInput = document.getElementById('studioPromptInput');
  const actionButton = document.getElementById('studioActionButton');

  if (promptInput && actionButton) {
    promptInput.addEventListener('input', () => {
      const hasText = promptInput.value.trim().length > 0;
      if (!actionButton.classList.contains('is-generating')) {
        actionButton.disabled = !hasText;
      }
    });

    actionButton.addEventListener('click', () => {
      // Toggle generating state on click
      const isGenerating = actionButton.classList.toggle('is-generating');
      if (isGenerating) {
        actionButton.disabled = false;
      } else {
        actionButton.disabled = promptInput.value.trim().length === 0;
      }
    });
  }

  // Resizable Panel Logic
  const resizer = document.getElementById('studioResizer');
  const leftPanel = document.querySelector('.studio-left-panel');
  let isResizing = false;

  if (resizer && leftPanel) {
    const startResizing = () => {
      isResizing = true;
      document.body.classList.add('is-resizing');
    };

    const stopResizing = () => {
      if (isResizing) {
        isResizing = false;
        document.body.classList.remove('is-resizing');
      }
    };

    const handleMouseMove = (e) => {
      if (!isResizing) return;
      const containerOffsetLeft = leftPanel.parentElement.getBoundingClientRect().left;
      let newWidth = e.clientX - containerOffsetLeft;

      const minWidth = 260;
      const maxWidth = Math.min(550, window.innerWidth * 0.45);

      if (newWidth < minWidth) newWidth = minWidth;
      if (newWidth > maxWidth) newWidth = maxWidth;

      leftPanel.style.width = `${newWidth}px`;
    };

    resizer.addEventListener('mousedown', startResizing);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);

    resizer.addEventListener('touchstart', startResizing);
    window.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) handleMouseMove(e.touches[0]);
    });
    window.addEventListener('touchend', stopResizing);
  }
});


document.addEventListener('DOMContentLoaded', () => {
  const resizer = document.getElementById('resizerSidebar');
  const leftPanel = document.querySelector('.studio-left-panel');
  const layout = document.querySelector('.studio-layout');

  if (!resizer || !leftPanel || !layout) return;

  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.classList.add('is-resizing');
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  });

  function handleMouseMove(e) {
    if (!isResizing) return;

    const layoutRect = layout.getBoundingClientRect();
    // Calculate new width relative to layout left edge
    let newWidth = e.clientX - layoutRect.left;

    // Snapping thresholds: collapse completely if dragged near 0px
    if (newWidth < 60) {
      newWidth = 0;
    } else {
      // Respect min/max bounds when expanding
      newWidth = Math.max(220, Math.min(newWidth, layoutRect.width - 200));
    }

    leftPanel.style.setProperty('--studio-left-panel-width', `${newWidth}px`);
    leftPanel.style.width = `${newWidth}px`;
    
    // Toggle class when hidden so layout can expand full width
    if (newWidth === 0) {
      leftPanel.classList.add('is-collapsed');
    } else {
      leftPanel.classList.remove('is-collapsed');
    }
  }

  function handleMouseUp() {
    isResizing = false;
    document.body.classList.remove('is-resizing');
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }
});

function analyzeWorkspaceDiagnostics() {
  const files = [];

  const collectFiles = (entries) => {
    entries.forEach((entry) => {
      if (entry.type === 'file') {
        files.push(entry);
      } else if (entry.type === 'folder' && Array.isArray(entry.children)) {
        collectFiles(entry.children);
      }
    });
  };

  collectFiles(projectFiles);

  let errors = 0;
  let warnings = 0;
  const issues = [];
  const addIssue = (level, file, message) => {
    issues.push({ level, message: `${file.name}: ${message}` });
  };

  files.forEach((file) => {
    const content = String(file.content || '');
    const fileName = String(file.name || '').toLowerCase();
    const extension = fileName.split('.').pop() || '';

    if (!content.trim()) {
      warnings += 1;
      addIssue('warning', file, 'File is empty.');
      return;
    }

    if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(extension)) {
      const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const suspiciousPatterns = [
        /\bfunction\b[^\n]*\{[^\n]*\breturn\b[^\n]*;/,
        /\bconsole\.log\b/i,
        /\bdebugger\b/i,
        /\bTODO\b/i,
        /\bFIXME\b/i,
        /\bvar\b/i
      ];

      suspiciousPatterns.forEach((pattern) => {
        if (pattern.test(stripped)) {
          warnings += 1;
          addIssue('warning', file, `Suspicious code pattern detected: ${pattern}`);
        }
      });

      const deprecatedPatterns = [
        { pattern: /document\.write\s*\(/i, name: 'document.write()' },
        { pattern: /window\.event\b/i, name: 'window.event' },
        { pattern: /keypress/i, name: 'keypress event' },
        { pattern: /navigator\.getUserMedia\s*\(/i, name: 'navigator.getUserMedia()' }
      ];
      deprecatedPatterns.forEach(({ pattern, name }) => {
        if (pattern.test(stripped)) {
          warnings += 1;
          addIssue('deprecation', file, `Deprecated browser API or event detected: ${name}`);
        }
      });

      const braceBalance = (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length;
      if (braceBalance !== 0) {
        errors += 1;
        addIssue('error', file, 'Unbalanced braces detected.');
      }

      if (/\bthrow\s+new\s+Error\b/i.test(stripped)) {
        warnings += 1;
        addIssue('warning', file, 'Explicit error throw detected.');
      }

      try {
        new Function(stripped);
      } catch (error) {
        errors += 1;
        addIssue('error', file, `JavaScript syntax error: ${error.message}`);
      }
    }

    if (extension === 'json') {
      try {
        JSON.parse(content);
      } catch (error) {
        errors += 1;
        addIssue('error', file, `Invalid JSON: ${error.message}`);
      }
    }

    if (extension === 'html') {
      const scriptCount = (content.match(/<script\b[^>]*>/gi) || []).length;
      const scriptCloseCount = (content.match(/<\/script>/gi) || []).length;
      if (scriptCount !== scriptCloseCount) {
        errors += 1;
        addIssue('error', file, 'Unmatched script tags.');
      }

      const styleCount = (content.match(/<style\b[^>]*>/gi) || []).length;
      const styleCloseCount = (content.match(/<\/style>/gi) || []).length;
      if (styleCount !== styleCloseCount) {
        errors += 1;
        addIssue('error', file, 'Unmatched style tags.');
      }

      const htmlForNesting = content
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
      const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
      const optionalEndTags = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rp', 'rt', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
      const tagStack = [];
      let mismatchedTags = false;
      const blockTags = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
      for (const match of htmlForNesting.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
        const tagName = match[1].toLowerCase();
        const token = match[0];
        if (voidTags.has(tagName)) continue;
        if (token.startsWith('</')) {
          const openIndex = tagStack.lastIndexOf(tagName);
          if (openIndex < 0) {
            if (!optionalEndTags.has(tagName)) mismatchedTags = true;
            continue;
          }
          if (tagStack.slice(openIndex + 1).some((openTag) => !optionalEndTags.has(openTag))) mismatchedTags = true;
          tagStack.length = openIndex;
          continue;
        }
        if (/\/\s*>$/.test(token)) continue;
        if (tagName === 'p' && tagStack.includes('p')) {
          tagStack.length = tagStack.lastIndexOf('p');
        } else if (blockTags.has(tagName) && tagStack.includes('p')) {
          tagStack.length = tagStack.lastIndexOf('p');
        } else if (optionalEndTags.has(tagName) && tagStack.includes(tagName)) {
          tagStack.length = tagStack.lastIndexOf(tagName);
        }
        tagStack.push(tagName);
      }
      if (tagStack.some((tagName) => !optionalEndTags.has(tagName))) mismatchedTags = true;
      if (mismatchedTags) {
        warnings += 1;
        addIssue('warning', file, 'HTML opening and closing tags may not match.');
      }
    }

    if (extension === 'css') {
      const openBraceCount = (content.match(/\{/g) || []).length;
      const closeBraceCount = (content.match(/\}/g) || []).length;
      if (Math.abs(openBraceCount - closeBraceCount) > 1) {
        errors += 1;
        addIssue('error', file, 'Unbalanced CSS braces detected.');
      }
      if (/TODO|FIXME/i.test(content)) {
        warnings += 1;
        addIssue('warning', file, 'TODO or FIXME marker found.');
      }
    }
  });

  return { errors: Math.min(errors, 9), warnings: Math.min(warnings, 9), issues };
}

function updateDiagnostics(errorsCount, warningsCount) {
  const errorEl = document.getElementById('errorCount');
  const warningEl = document.getElementById('warningCount');

  if (errorEl) errorEl.textContent = String(errorsCount ?? 0);
  if (warningEl) warningEl.textContent = String(warningsCount ?? 0);
}

function refreshDiagnostics() {
  const analysis = analyzeWorkspaceDiagnostics();
  analysis.issues.forEach((issue) => {
    const key = `${issue.level}:${issue.message}`;
    if (reportedStaticDiagnosticKeys.has(key)) return;
    reportedStaticDiagnosticKeys.add(key);
    appendPreviewConsoleEntry(issue.level, issue.message);
  });
  updateDiagnostics(analysis.errors + runtimeDiagnosticState.errors, analysis.warnings + runtimeDiagnosticState.warnings);
}

function recordRuntimeDiagnostic(kind) {
  if (kind === 'error') {
    runtimeDiagnosticState.errors += 1;
  } else if (kind === 'warning') {
    runtimeDiagnosticState.warnings += 1;
  }
  refreshDiagnostics();
}

function getPreviewConsoleStorageKey() {
  const projectId = localStorage.getItem('kieltech-studio-project-id') || 'default-project';
  previewConsoleUiState.lastProjectKey = String(projectId);
  return `kieltech-studio-preview-console-v1:${projectId}`;
}

function sanitizeConsoleValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    let text = value;
    const secretPatterns = [
      /(api[_-]?key|token|secret|password|passwd|cookie|authorization|bearer|session)[^\n]{0,40}[:=]\s*([^\s,;]+)/gi,
      /(sk-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z\-_]{20,}|ghp_[A-Za-z0-9]{20,})/g,
      /(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g
    ];
    secretPatterns.forEach((pattern) => {
      text = text.replace(pattern, (match, label, secret) => {
        if (secret) return `${label}: [REDACTED]`;
        return '[REDACTED]';
      });
    });
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function formatConsoleTimestamp(timestamp) {
  const date = new Date(timestamp || Date.now());
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getConsoleEntrySignature(entry) {
  return `${entry.level}|${entry.kind || 'log'}|${entry.message}|${entry.source || ''}`;
}

function updatePreviewConsoleStatusLabel() {
  const statusEl = document.getElementById('previewConsoleStatus');
  if (!statusEl) return;
  statusEl.textContent = previewConsoleUiState.paused ? 'Paused' : previewConsoleUiState.status;
  statusEl.dataset.state = previewConsoleUiState.paused ? 'paused' : previewConsoleUiState.status;
}

function renderPreviewConsoleEntries() {
  const output = document.getElementById('previewConsoleOutput');
  if (!output) return;

  const search = (previewConsoleUiState.search || '').trim().toLowerCase();
  const visibleEntries = previewConsoleEntries.filter((entry) => {
    const matchesLevel = previewConsoleUiState.filter === 'all' || entry.level === previewConsoleUiState.filter;
    const haystack = [entry.message, entry.source || '', entry.kind || '', entry.details || ''].join(' ').toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    return matchesLevel && matchesSearch;
  });

  output.innerHTML = '';
  if (!visibleEntries.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'studio-console-empty';
    emptyState.textContent = previewConsoleUiState.search ? 'No logs match your search.' : 'No logs yet.';
    output.appendChild(emptyState);
    return;
  }

  visibleEntries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `studio-console-entry studio-console-entry--${entry.level}`;

    const meta = document.createElement('div');
    meta.className = 'studio-console-entry__meta';
    const levelLabel = document.createElement('span');
    levelLabel.className = 'studio-console-entry__level';
    levelLabel.textContent = (entry.level || 'info').toUpperCase();
    const time = document.createElement('span');
    time.className = 'studio-console-entry__time';
    time.textContent = formatConsoleTimestamp(entry.createdAt);
    const source = document.createElement('span');
    source.className = 'studio-console-entry__source';
    source.textContent = entry.source || 'runtime';
    meta.append(levelLabel, time, source);

    const message = document.createElement('div');
    message.className = 'studio-console-entry__message';
    message.textContent = entry.count > 1 ? `${entry.message} (repeated ${entry.count} times)` : entry.message;

    row.append(meta, message);

    if (entry.details) {
      const details = document.createElement('div');
      details.className = 'studio-console-entry__details';
      details.textContent = entry.details;
      row.append(details);
    }

    output.appendChild(row);
  });

  output.scrollTop = output.scrollHeight;
}

function persistPreviewConsoleEntries() {
  try {
    localStorage.setItem(getPreviewConsoleStorageKey(), JSON.stringify(previewConsoleEntries.slice(-500)));
  } catch (error) {
    // Keep the console usable when browser storage is unavailable.
  }
}

function appendPreviewConsoleEntry(level, message, options = {}) {
  const output = document.getElementById('previewConsoleOutput');
  if (!output || previewConsoleUiState.paused) return;

  const normalizedLevel = ['error', 'warning', 'info', 'debug', 'deprecation', 'network', 'log'].includes(level) ? level : 'log';
  const entryMessage = sanitizeConsoleValue(message);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level: normalizedLevel,
    kind: options.kind || 'console',
    message: entryMessage,
    source: options.source || '',
    details: options.details ? sanitizeConsoleValue(options.details) : '',
    createdAt: options.createdAt || Date.now(),
    count: 1
  };

  const lastEntry = previewConsoleEntries[previewConsoleEntries.length - 1];
  if (lastEntry && getConsoleEntrySignature(lastEntry) === getConsoleEntrySignature(entry)) {
    lastEntry.count += 1;
    lastEntry.createdAt = entry.createdAt;
    lastEntry.details = lastEntry.details || entry.details;
  } else {
    previewConsoleEntries.push(entry);
  }

  previewConsoleEntries = previewConsoleEntries.slice(-500);
  persistPreviewConsoleEntries();
  renderPreviewConsoleEntries();

  const counters = { error: 0, warning: 0 };
  previewConsoleEntries.forEach((log) => {
    if (log.level === 'error') counters.error += log.count;
    if (log.level === 'warning' || log.level === 'deprecation') counters.warning += log.count;
  });
  updateDiagnostics(counters.error, counters.warning);
}

function restorePreviewConsole() {
  const output = document.getElementById('previewConsoleOutput');
  if (!output) return;
  try {
    const storedEntries = JSON.parse(localStorage.getItem(getPreviewConsoleStorageKey()) || '[]');
    previewConsoleEntries = Array.isArray(storedEntries) ? storedEntries.slice(-500) : [];
  } catch (error) {
    previewConsoleEntries = [];
  }
  if (!previewConsoleEntries.length) {
    output.innerHTML = '<div class="studio-console-empty">Preview console ready.</div>';
    return;
  }
  renderPreviewConsoleEntries();
}

function attachPreviewDiagnostics(iframe) {
  if (!iframe) return;

  let iframeWindow;
  try {
    iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
  } catch (error) {
    return;
  }

  const formatPreviewDiagnostic = (values) => values.map((value) => {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }).join(' ');

  const trackRuntimeIssue = (kind, message, source = '', details = '') => {
    if (message) appendPreviewConsoleEntry(kind === 'error' ? 'error' : 'warning', message, { source, details, kind: 'runtime' });
    recordRuntimeDiagnostic(kind);
  };

  try {
    iframeWindow.addEventListener('error', (event) => trackRuntimeIssue('error', event.message || 'Runtime error', event.filename || 'window', event.error?.stack || ''));
    iframeWindow.addEventListener('unhandledrejection', (event) => trackRuntimeIssue('error', formatPreviewDiagnostic([event.reason || 'Unhandled promise rejection']), 'promise rejection', event.reason?.stack || ''));
  } catch (error) {
    return;
  }

  const originalConsoleError = iframeWindow.console.error.bind(iframeWindow.console);
  iframeWindow.console.error = (...args) => {
    trackRuntimeIssue('error', formatPreviewDiagnostic(args), 'console.error', args.map(sanitizeConsoleValue).join(' '));
    return originalConsoleError(...args);
  };

  const originalConsoleWarn = iframeWindow.console.warn.bind(iframeWindow.console);
  iframeWindow.console.warn = (...args) => {
    trackRuntimeIssue('warning', formatPreviewDiagnostic(args), 'console.warn', args.map(sanitizeConsoleValue).join(' '));
    return originalConsoleWarn(...args);
  };

  const originalConsoleInfo = iframeWindow.console.info?.bind(iframeWindow.console) || null;
  iframeWindow.console.info = (...args) => {
    appendPreviewConsoleEntry('info', formatPreviewDiagnostic(args), { source: 'console.info', details: args.map(sanitizeConsoleValue).join(' '), kind: 'runtime' });
    return originalConsoleInfo ? originalConsoleInfo(...args) : undefined;
  };

  const originalConsoleLog = iframeWindow.console.log?.bind(iframeWindow.console) || null;
  iframeWindow.console.log = (...args) => {
    appendPreviewConsoleEntry('log', formatPreviewDiagnostic(args), { source: 'console.log', details: args.map(sanitizeConsoleValue).join(' '), kind: 'runtime' });
    return originalConsoleLog ? originalConsoleLog(...args) : undefined;
  };

  iframeWindow.console.debug = (...args) => {
    appendPreviewConsoleEntry('debug', formatPreviewDiagnostic(args), { source: 'console.debug', details: args.map(sanitizeConsoleValue).join(' '), kind: 'runtime' });
  };
  iframeWindow.console.deprecation = (...args) => {
    appendPreviewConsoleEntry('deprecation', formatPreviewDiagnostic(args), { source: 'console.deprecation', details: args.map(sanitizeConsoleValue).join(' '), kind: 'runtime' });
  };
}

function isStudioPreviewUrl(appUrl = '') {
  const value = String(appUrl || '').trim();
  return !value || /(^|\/|\\)web-development-studio\.html?($|[#?])/i.test(value) || /(^|\/|\\)studio($|[#?])/i.test(value);
}

function loadAppPreview(appUrl = 'about:blank') {
  const previewContainer = document.getElementById('previewView');
  if (!previewContainer) return;

  const safeUrl = isStudioPreviewUrl(appUrl) ? 'about:blank' : ( /^https?:\/\//i.test(appUrl) || appUrl === 'about:blank' ? appUrl : `http://${appUrl}` );
  const frame = previewContainer.querySelector('#appPreviewIframe');
  if (frame) {
    frame.src = safeUrl;
    frame.addEventListener('load', () => attachPreviewDiagnostics(frame), { once: true });
    return;
  }
}

function createSafePreviewBlankDocument() {
  return `<!doctype html><html><body><h1>Preview ready</h1></body></html>`;
}

function createPreviewAssetResolver() {
  const files = getWorkspaceFiles().filter((file) => isPreviewSafeFile(file.path));
  const findFile = (rawPath, currentPath) => {
    const target = String(rawPath || '').trim();
    if (!target || target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;
    let pathname;
    try {
      const basePath = String(currentPath || activePreviewPagePath || 'index.html').split('/').map(encodeURIComponent).join('/');
      pathname = decodeURIComponent(new URL(target, `http://preview.local/${basePath}`).pathname);
    } catch (error) {
      return null;
    }
    const normalized = pathname.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').reduce((parts, part) => {
      if (part === '..') parts.pop();
      else parts.push(part);
      return parts;
    }, []).join('/');
    return files.find((file) => file.path === normalized)
      || files.find((file) => file.path.toLowerCase() === normalized.toLowerCase())
      || null;
  };
  const mimeTypes = {
    '.avif': 'image/avif', '.css': 'text/css', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
    '.mjs': 'text/javascript', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
    '.otf': 'font/otf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
    '.txt': 'text/plain', '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml'
  };
  const reportMissing = (url, fromPath) => {
    appendPreviewConsoleEntry('warning', `Preview asset not found: ${url}`, {
      source: 'asset', details: `Referenced by ${fromPath || activePreviewPagePath || 'preview'}`, kind: 'runtime'
    });
    recordRuntimeDiagnostic('warning');
  };
  const rewriteCss = (css, cssPath, depth = 0, visited = new Set()) => String(css || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
    const value = String(url || '').trim();
    if (!value || /^(?:#|data:|blob:|https?:|\/\/|javascript:)/i.test(value)) return match;
    const file = findFile(value, cssPath);
    if (!file) {
      reportMissing(value, cssPath);
      return 'url("data:,")';
    }
    return `url("${toDataUrl(file, depth + 1, visited)}")`;
  }).replace(/@import\s+(?!url\()(['"])([^'"]+)\1/gi, (match, quote, url) => {
    const file = findFile(url, cssPath);
    if (!file || !/\.css$/i.test(file.path)) {
      if (!file) reportMissing(url, cssPath);
      return file ? match : '@import url("data:,")';
    }
    return `@import url("${toDataUrl(file, depth + 1, visited)}")`;
  });
  const toDataUrl = (file, depth = 0, visited = new Set()) => {
    const content = String(file.content || '');
    if (/^data:[^,]*,/i.test(content)) return content;
    const extension = `.${String(file.path).split('.').pop()}`.toLowerCase();
    const mime = mimeTypes[extension] || 'application/octet-stream';
    if (extension === '.css') {
      if (depth > 6 || visited.has(file.path)) return 'data:text/css;charset=utf-8,';
      const nextVisited = new Set(visited);
      nextVisited.add(file.path);
      return `data:text/css;charset=utf-8,${encodeURIComponent(rewriteCss(content, file.path, depth, nextVisited))}`;
    }
    return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  };
  return {
    findFile,
    toDataUrl,
    rewriteCss,
    compileCss() {
      return files.filter((file) => /\.css$/i.test(file.path))
        .map((file) => `/* ${file.path} */\n${rewriteCss(file.content, file.path)}`)
        .join('\n\n');
    },
    rewriteDocument(doc, pagePath) {
      let hasLocalStylesheet = false;
      let hasLocalScript = false;
      doc.querySelectorAll('link[href]').forEach((link) => {
        const file = findFile(link.getAttribute('href'), pagePath);
        if (!file) return;
        if (link.relList.contains('stylesheet') && /\.css$/i.test(file.path)) {
          link.remove();
          hasLocalStylesheet = true;
        } else {
          link.href = toDataUrl(file);
        }
      });
      doc.querySelectorAll('script[src]').forEach((script) => {
        const file = findFile(script.getAttribute('src'), pagePath);
        if (!file) return;
        if (script.type === 'module') {
          script.src = toDataUrl(file);
        } else {
          script.textContent = String(file.content || '');
          script.removeAttribute('src');
        }
        hasLocalScript = true;
      });
      doc.querySelectorAll('[src], [poster], [data], [style]').forEach((element) => {
        for (const attribute of ['src', 'poster', 'data']) {
          if (!element.hasAttribute(attribute) || element.tagName === 'SCRIPT') continue;
          const value = element.getAttribute(attribute);
          const file = findFile(value, pagePath);
          if (file) element.setAttribute(attribute, toDataUrl(file));
          else if (value && !/^(?:#|data:|blob:|https?:|\/\/|javascript:)/i.test(value)) {
            reportMissing(value, pagePath);
            element.setAttribute(attribute, 'data:,');
          }
        }
        if (element.hasAttribute('style')) element.setAttribute('style', rewriteCss(element.getAttribute('style'), pagePath));
      });
      doc.querySelectorAll('[srcset]').forEach((element) => {
        const rewritten = element.getAttribute('srcset').split(',').map((candidate) => {
          const parts = candidate.trim().split(/\s+/, 2);
          const file = findFile(parts[0], pagePath);
          if (!file) return candidate.trim();
          return `${toDataUrl(file)}${parts[1] ? ` ${parts[1]}` : ''}`;
        }).join(', ');
        element.setAttribute('srcset', rewritten);
      });
      doc.querySelectorAll('style').forEach((style) => {
        style.textContent = rewriteCss(style.textContent, pagePath);
      });
      return { hasLocalStylesheet, hasLocalScript };
    }
  };
}
function navigatePreviewWorkspacePath(target) {
  const nextTarget = String(target || '');
  if (!nextTarget || /(^|\/|\\)web-development-studio\.html?($|[#?])/i.test(nextTarget) || /(^|\/|\\)studio($|[#?])/i.test(nextTarget)) {
    return false;
  }
  const nextPagePath = resolvePreviewPagePath(nextTarget);
  if (!nextPagePath) {
    appendPreviewConsoleEntry('warning', 'Preview route is not available in this workspace: ' + nextTarget.slice(0, 180), { source: 'navigation', details: nextTarget, kind: 'runtime' });
    recordRuntimeDiagnostic('warning');
    return false;
  }
  if (nextPagePath === activePreviewPagePath) return true;
  activePreviewPagePath = nextPagePath;
  saveWorkspaceState();
  refreshPreviewFromWorkspace();
  return true;
}

function renderPreviewContent(htmlContent, cssContent = '', jsContent = '') {
  const previewView = document.getElementById('previewView');
  const loadingIndicator = document.getElementById('previewLoadingIndicator');
  const iframe = document.getElementById('appPreviewIframe');
  if (!previewView || !iframe) return;

  const rawHtml = String(htmlContent || createSafePreviewBlankDocument());
  const looksLikeStudioShell = /studio-ai-panel-header|studio-preview-shell|appPreviewIframe|studio-nav__title|studioModelSelector/i.test(rawHtml);
  const fallbackHtml = createSafePreviewBlankDocument();
  const parsedHtml = new DOMParser().parseFromString(looksLikeStudioShell ? fallbackHtml : rawHtml, 'text/html');
  const previewAssets = createPreviewAssetResolver();
  const previewPagePath = activePreviewPagePath || getDefaultPreviewPagePath();
  const rewrittenResources = previewAssets.rewriteDocument(parsedHtml, previewPagePath);
  parsedHtml.querySelectorAll('base').forEach((base) => base.remove());
  const safeHead = parsedHtml.head?.innerHTML || '';
  const safeHtml = parsedHtml.body?.innerHTML || (looksLikeStudioShell ? fallbackHtml : rawHtml);
  const projectCss = previewAssets.compileCss();
  const safeCss = projectCss || previewAssets.rewriteCss(String(cssContent || ''), previewPagePath);
  const safeJs = (rewrittenResources.hasLocalScript ? '' : String(jsContent || '')).replace(/<\/script/gi, '<\\/script');
  const previewBasePath = previewPagePath.includes('/') ? previewPagePath.slice(0, previewPagePath.lastIndexOf('/') + 1) : '';
  const previewFrame = document.getElementById('previewDeviceFrame');
  const initialPreviewDpr = previewFrame?.classList.contains('is-desktop') ? 1 : getPreviewEmulationSettings().dpr;
  const previewRuntimeScript = `<script>
    (function () {
      const sendConsole = (level, values) => {
        const message = values.map((value) => {
          try { return typeof value === 'string' ? value : JSON.stringify(value); }
          catch (error) { return String(value); }
        }).join(' ');
        parent.postMessage({ type: 'studio-preview-console', level, message }, '*');
      };
      ['log', 'info', 'debug', 'warn', 'error'].forEach((level) => {
        const original = console[level]?.bind(console);
        console[level] = (...values) => {
          sendConsole(level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'log', values);
          original?.(...values);
        };
      });
      console.deprecation = (...values) => sendConsole('deprecation', values);
      window.addEventListener('error', (event) => {
        sendConsole('error', [event.message || 'Runtime error']);
      });
      window.addEventListener('unhandledrejection', (event) => {
        sendConsole('error', [event.reason || 'Unhandled promise rejection']);
      });
      const applyEmulatedDpr = (value) => {
        const dpr = Math.max(1, Math.min(3, Number(value) || 1));
        window.__KIELTECH_EMULATED_DPR = dpr;
        document.documentElement.dataset.emulatedDpr = String(dpr);
        document.documentElement.style.setProperty('--studio-emulated-dpr', String(dpr));
        try {
          Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr });
        } catch (error) {
          sendConsole('warning', ['The browser does not allow overriding devicePixelRatio; use window.__KIELTECH_EMULATED_DPR instead.']);
        }
        window.dispatchEvent(new CustomEvent('studio:emulationchange', { detail: { dpr } }));
      };
      applyEmulatedDpr(${initialPreviewDpr});
      window.addEventListener('message', (event) => {
        if (event.data?.type !== 'studio-preview-emulation') return;
        applyEmulatedDpr(event.data.dpr);
      });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.startsWith('/v1/')) return nativeFetch(input, init);
        const requestId = Math.random().toString(36).slice(2);
        return new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            window.removeEventListener('message', receiveResponse);
            reject(new Error('Preview API request timed out.'));
          }, 15000);
          const receiveResponse = (event) => {
            if (event.data?.type !== 'studio-preview-api-response' || event.data.requestId !== requestId) return;
            window.clearTimeout(timeout);
            window.removeEventListener('message', receiveResponse);
            if (event.data.error) {
              reject(new Error(event.data.error));
              return;
            }
            resolve(new Response(JSON.stringify(event.data.body), { status: event.data.status, headers: { 'Content-Type': 'application/json' } }));
          };
          window.addEventListener('message', receiveResponse);
          parent.postMessage({ type: 'studio-preview-api-request', requestId, url, init: { method: init.method || 'GET', headers: init.headers || {}, body: init.body || null } }, '*');
        });
      };
    })();
    (function () {
      const reportRoute = (value) => {
        if (value == null) return;
        const nextUrl = new URL(String(value), window.location.href);
        if (nextUrl.origin !== 'http://preview.invalid' || nextUrl.pathname === window.location.pathname) return;
        parent.postMessage({ type: 'studio-preview-navigate', path: nextUrl.pathname + nextUrl.search + nextUrl.hash }, '*');
      };
      ['pushState', 'replaceState'].forEach((method) => {
        const original = history[method].bind(history);
        history[method] = (state, title, url) => {
          const result = original(state, title, url);
          reportRoute(url);
          return result;
        };
      });
      window.addEventListener('popstate', () => reportRoute(window.location.pathname));
      window.addEventListener('hashchange', () => {
        parent.postMessage({ type: 'studio-preview-hash', hash: window.location.hash }, '*');
      });
    })();
    document.addEventListener('click', function (event) {
      const anchorTarget = event.target.closest('a[href]');
      const explicitNavTarget = event.target.closest('[data-preview-nav], [data-href], [data-url], [onclick]');
      const target = anchorTarget || explicitNavTarget;
      if (!target) return;

      const rawPath = (
        target.getAttribute('data-preview-nav') ||
        target.getAttribute('data-href') ||
        target.getAttribute('data-url') ||
        (target.getAttribute('onclick') || '').match(/(?:location(?:\\.href)?|window\\.location(?:\\.href)?|window\\.open)\\s*\\(?\\s*[=,(]?\\s*["']([^"']+)["']/i)?.[1] ||
        target.getAttribute('href') ||
        ''
      ).trim();

      const normalizedPath = rawPath.split(/[?#]/, 1)[0].toLowerCase();
      const finalPathSegment = normalizedPath.split('/').filter(Boolean).pop() || '';
      if (!rawPath || ['about:blank', 'javascript:', 'mailto:', 'tel:'].some((prefix) => rawPath.toLowerCase().startsWith(prefix)) || rawPath.startsWith('#')) return;
      if (finalPathSegment === 'web-development-studio.html' || finalPathSegment === 'web-development-studio.htm' || finalPathSegment === 'studio') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const buttonLike = target.closest('button, input[type="button"], input[type="submit"], [role="button"]');
      if (buttonLike && !target.hasAttribute('data-preview-nav') && !target.hasAttribute('data-href') && !target.hasAttribute('data-url') && !target.hasAttribute('onclick') && !anchorTarget) {
        return;
      }

      const hasExplicitScheme = /^[a-z]+:/i.test(rawPath);
      if (rawPath.startsWith('//') || /\\s/.test(rawPath)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (hasExplicitScheme) {
        if (!/^https?:/i.test(rawPath)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (target.getAttribute('target') === '_blank') target.setAttribute('target', '_self');
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ type: 'studio-preview-navigate', path: rawPath }, '*');
    }, true);
    document.addEventListener('pointermove', (event) => {
      const target = event.target;
      document.documentElement.style.cursor = target instanceof Element && target.closest('a[href]') ? 'pointer' : 'auto';
    }, true);
    document.addEventListener('submit', function (event) {
      if (!(event.target instanceof HTMLFormElement)) return;
      event.preventDefault();
    }, true);
  <\/script>`;

  loadingIndicator?.classList.remove('is-hidden');
  const safeDocument = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <base href="http://preview.invalid/${previewBasePath}" />
      ${safeHead}
      <style>${safeCss}</style>
    </head>
    <body>
      ${safeHtml}
      ${previewRuntimeScript}
      <script>${safeJs}</script>
    </body>
  </html>`;

  iframe.srcdoc = safeDocument;

  const hideLoader = () => {
    loadingIndicator?.classList.add('is-hidden');
  };

  iframe.addEventListener('load', () => {
    hideLoader();
    try {
      const contentDocument = iframe.contentDocument;
      const htmlText = contentDocument?.documentElement?.outerHTML || '';
      if (/studio-ai-panel-header|studio-preview-shell|appPreviewIframe|studio-nav__title|studioModelSelector/i.test(htmlText)) {
        iframe.srcdoc = createSafePreviewBlankDocument();
      }
    } catch (error) {
      // Ignore sandbox restrictions while preserving a safe fallback preview.
    }
  }, { once: true });
  window.setTimeout(hideLoader, 900);
}

let studioPreviewEmulationSettings = { width: 375, height: 812, dpr: 2, scale: 1 };

function getPreviewEmulationSettings() {
  return { ...studioPreviewEmulationSettings };
}

function setPreviewEmulationDpr(dpr) {
  const iframe = document.getElementById('appPreviewIframe');
  iframe?.contentWindow?.postMessage({ type: 'studio-preview-emulation', dpr }, '*');
}

function setStudioPreviewDevice(settings = {}) {
  const viewport = ['mobile', 'tablet', 'desktop'].includes(settings.viewport) ? settings.viewport : 'desktop';
  const dimensions = viewport === 'mobile'
    ? { width: 375, height: 812 }
    : viewport === 'tablet'
      ? { width: 768, height: 1024 }
      : null;

  if (dimensions) {
    studioPreviewEmulationSettings = {
      width: settings.width ?? dimensions.width,
      height: settings.height ?? dimensions.height,
      dpr: settings.dpr ?? 2,
      scale: (settings.scale ?? 100) / 100
    };
  }

  document.querySelectorAll('.studio-viewport-btn').forEach((button) => {
    const active = button.dataset.viewport === viewport;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  setPreviewViewport('100%', viewport);
  return { viewport, ...getPreviewEmulationSettings() };
}

function setPreviewViewport(width, viewport = 'desktop') {
  const frame = document.getElementById('previewDeviceFrame');
  if (!frame) return;

  frame.classList.remove('is-mobile', 'is-tablet', 'is-desktop');
  frame.dataset.viewport = viewport;

  if (viewport === 'mobile') {
    const settings = getPreviewEmulationSettings();
    frame.classList.add('is-mobile');
    frame.style.width = `${settings.width}px`;
    frame.style.maxWidth = 'none';
    frame.style.height = `${settings.height}px`;
    frame.style.boxSizing = 'content-box';
    frame.dataset.dpr = String(settings.dpr);
    frame.style.setProperty('--emulated-dpr', String(settings.dpr));
    setPreviewEmulationDpr(settings.dpr);
    updatePreviewDeviceScale();
    return;
  }

  if (viewport === 'tablet') {
    const settings = getPreviewEmulationSettings();
    frame.classList.add('is-tablet');
    frame.style.width = `${settings.width}px`;
    frame.style.maxWidth = 'none';
    frame.style.height = `${settings.height}px`;
    frame.style.boxSizing = 'content-box';
    frame.dataset.dpr = String(settings.dpr);
    frame.style.setProperty('--emulated-dpr', String(settings.dpr));
    setPreviewEmulationDpr(settings.dpr);
    updatePreviewDeviceScale();
    return;
  }

  frame.classList.add('is-desktop');
  frame.style.width = '100%';
  frame.style.maxWidth = '100%';
  frame.style.height = '100%';
  frame.style.zoom = '1';
  frame.style.transform = 'none';
  frame.style.margin = '0';
  frame.style.boxSizing = '';
  frame.dataset.dpr = '1';
  frame.style.setProperty('--emulated-dpr', '1');
  setPreviewEmulationDpr(1);
}

function updatePreviewDeviceScale() {
  const shell = document.querySelector('.studio-preview-shell');
  const frame = document.getElementById('previewDeviceFrame');
  if (!shell || !frame || frame.classList.contains('is-desktop')) return;

  const frameWidth = frame.offsetWidth;
  const frameHeight = frame.offsetHeight;
  const availableWidth = Math.max(0, shell.clientWidth - 32);
  const availableHeight = Math.max(0, shell.clientHeight - 32);
  const requestedScale = getPreviewEmulationSettings().scale;
  const scale = Math.max(0.1, Math.min(requestedScale, availableWidth / frameWidth, availableHeight / frameHeight));
  frame.style.zoom = '1';
  frame.style.transform = `scale(${scale})`;
  frame.style.transformOrigin = 'center center';
  frame.style.margin = `${(frameHeight * (1 - scale)) / 2}px ${(frameWidth * (1 - scale)) / 2}px`;
}

function getWorkspaceFiles(entries = projectFiles, parentPath = '') {
  return entries.flatMap((entry) => {
    const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (entry.type === 'folder' && Array.isArray(entry.children)) {
      return getWorkspaceFiles(entry.children, entryPath);
    }
    return entry.type === 'file' ? [{ ...entry, path: entryPath }] : [];
  });
}

function isPreviewSafeFile(filePath) {
  const fileName = String(filePath || '').split('/').pop()?.toLowerCase() || '';
  return !(
    fileName === '.env' ||
    fileName.startsWith('.env.') ||
    fileName.endsWith('.pem') ||
    fileName.endsWith('.key') ||
    fileName === 'credentials.json' ||
    fileName === 'service-account.json'
  );
}

function isStudioShellHtml(filePath, content = '') {
  const normalizedPath = String(filePath || '').toLowerCase();
  if (normalizedPath.endsWith('web-development-studio.html') || normalizedPath.includes('studio-shell')) {
    return true;
  }
  const normalizedContent = String(content || '');
  return /studio-ai-panel-header|studio-preview-shell|appPreviewIframe|studio-nav__title|studioModelSelector/i.test(normalizedContent);
}

function getPreviewPageFiles() {
  return getWorkspaceFiles()
    .filter((file) => /\.html?$/i.test(file.path))
    .filter((file) => !isStudioShellHtml(file.path, file.content || ''));
}

function getDefaultPreviewPagePath(htmlFiles = getPreviewPageFiles()) {
  return htmlFiles.find((file) => /(^|\/)index\.html?$/i.test(file.path))?.path || htmlFiles[0]?.path || '';
}

function resolvePreviewPagePath(rawPath, currentPagePath = activePreviewPagePath) {
  const target = String(rawPath || '').trim();
  if (!target) return '';

  let pathname;
  try {
    const currentPath = String(currentPagePath || '').split('/').map(encodeURIComponent).join('/');
    pathname = new URL(target, `http://preview.local/${currentPath}`).pathname;
    pathname = decodeURIComponent(pathname);
  } catch (error) {
    return '';
  }

  const parts = [];
  pathname.replace(/\\/g, '/').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      parts.pop();
      return;
    }
    parts.push(part);
  });

  const candidate = parts.join('/');
  const htmlFiles = getPreviewPageFiles();
  if (!candidate) return getDefaultPreviewPagePath(htmlFiles);

  const findPage = (path) => htmlFiles.find((file) => file.path === path)?.path
    || htmlFiles.find((file) => file.path.toLowerCase() === path.toLowerCase())?.path
    || '';
  const exactMatch = findPage(candidate);
  if (exactMatch) return exactMatch;
  if (/\.html?$/i.test(candidate)) return '';

  const routeCandidates = candidate.endsWith('/')
    ? [`${candidate}index.html`, `${candidate}index.htm`]
    : [`${candidate}.html`, `${candidate}.htm`, `${candidate}/index.html`, `${candidate}/index.htm`];
  for (const routeCandidate of routeCandidates) {
    const match = findPage(routeCandidate);
    if (match) return match;
  }
  return '';
}
function compileWorkspacePreview(pagePath = activePreviewPagePath) {
  const files = getWorkspaceFiles();
  const htmlFiles = getPreviewPageFiles();
  const entryFile = htmlFiles.find((file) => file.path === pagePath)
    || htmlFiles.find((file) => /(^|\/)index\.html?$/i.test(file.path))
    || htmlFiles[0];

  if (!entryFile) {
    return {
      html: '<!doctype html><html><body><h1>Preview ready</h1></body></html>',
      css: '',
      js: ''
    };
  }

  const css = files
    .filter((file) => /\.css$/i.test(file.path) && !isStudioShellHtml(file.path, file.content || ''))
    .map((file) => `/* ${file.path} */\n${file.content || ''}`)
    .join('\n\n');
  const js = files
    .filter((file) => /\.js$/i.test(file.path) && !isStudioShellHtml(file.path, file.content || ''))
    .map((file) => `// ${file.path}\n${file.content || ''}`)
    .join('\n\n');

  const parsedEntry = new DOMParser().parseFromString(entryFile.content || '', 'text/html');
  const entryHtml = parsedEntry.body?.innerHTML || entryFile.content || '';
  return { html: /studio-ai-panel-header|studio-preview-shell|appPreviewIframe|studio-nav__title|studioModelSelector/i.test(entryHtml) ? '<!doctype html><html><body><h1>Preview ready</h1></body></html>' : entryHtml, css, js };
}

function refreshPreviewFromWorkspace() {
  const localPreview = compileWorkspacePreview();
  renderPreviewContent(localPreview.html, localPreview.css, localPreview.js);

  const htmlFiles = getPreviewPageFiles();
  const pagePath = htmlFiles.some((file) => file.path === activePreviewPagePath)
    ? activePreviewPagePath
    : getDefaultPreviewPagePath(htmlFiles);
  activePreviewPagePath = pagePath;
  if (!pagePath) return;

  const requestVersion = ++previewRequestVersion;
  const projectId = localStorage.getItem('kieltech-studio-project-id') || `studio-${Date.now()}`;
  localStorage.setItem('kieltech-studio-project-id', projectId);
  request(`/v1/studio/projects/${encodeURIComponent(projectId)}/preview`, {
    method: 'POST',
    body: JSON.stringify({
      page_path: pagePath,
      files: getWorkspaceFiles()
        .filter((file) => isPreviewSafeFile(file.path))
        .map((file) => ({ path: file.path, content: String(file.content || '') }))
    })
  }).then((backendPreview) => {
    if (requestVersion !== previewRequestVersion || backendPreview.page_path !== activePreviewPagePath) return;
    const backendHtml = typeof backendPreview.html === 'string' ? backendPreview.html.trim() : '';
    const backendCss = typeof backendPreview.css === 'string' ? backendPreview.css : '';
    const backendJs = typeof backendPreview.js === 'string' ? backendPreview.js : '';
    if (!backendHtml && !backendCss && !backendJs) return;
    renderPreviewContent(backendHtml, backendCss, backendJs);
  }).catch(() => {
    // The local compilation remains visible when the preview API is unavailable.
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restoreWorkspaceState();
  loadServerStudioProjectState().then((serverState) => {
    if (serverState && Array.isArray(serverState.files)) {
      projectFiles = serverState.files.map((file) => ({
        name: file.path,
        type: 'file',
        status: 'synced',
        content: String(file.content || '')
      }));
      const title = document.getElementById('studioNavTitle');
      if (title && serverState.project_name) title.textContent = serverState.project_name;
      localStorage.setItem('kieltech-studio-project-name', serverState.project_name || 'KielTech Studio project');
      renderFileExplorer();
      renderEditor();
      refreshPreviewFromWorkspace();
      setStudioSaveStatus('Saved to your account', 'saved');
    } else {
      setStudioSaveStatus('Not saved to an account yet', 'unsaved');
    }
    studioWorkspaceReady = true;
  }).catch((error) => {
    console.warn('Unable to restore server workspace:', error);
    setStudioSaveStatus('Could not load cloud project', 'error');
    studioWorkspaceReady = true;
  });
  renderFileExplorer();
  setupFileExplorerInteractions();
  setupCodeEditorInteractions();
  selectDefaultCodeFile();
  renderEditor();

  const editorTextarea = document.getElementById('studioEditorTextarea');
  const downloadCodeButton = document.getElementById('downloadCodeButton');
  const downloadZipButton = document.getElementById('downloadZipBtn');
  const previewLoadingIndicator = document.getElementById('previewLoadingIndicator');
  const refreshPreviewBtn = document.getElementById('refreshPreviewBtn');
  const fullscreenPreviewBtn = document.getElementById('fullscreenPreviewBtn');

  window.addEventListener('message', (event) => {
    const previewFrame = document.getElementById('appPreviewIframe');
    if (event.source && event.source !== previewFrame?.contentWindow) return;
    if (event.data?.type === 'studio-preview-navigate') {
      navigatePreviewWorkspacePath(event.data.path);
      return;
    }
    if (event.data?.type === 'studio-preview-hash') {
      const iframeWindow = previewFrame?.contentWindow;
      try {
        iframeWindow?.history.replaceState(iframeWindow.history.state, '', `#${String(event.data.hash || '').replace(/^#/, '')}`);
      } catch (error) {
        appendPreviewConsoleEntry('warning', 'Could not update the preview fragment.', { source: 'navigation', details: error.message, kind: 'runtime' });
      }
      return;
    }
    if (event.data?.type === 'studio-preview-console') {
      appendPreviewConsoleEntry(event.data.level || 'log', String(event.data.message || ''), {
        source: event.data.source || 'console',
        details: event.data.message || '',
        kind: 'runtime'
      });
      recordRuntimeDiagnostic(event.data.level === 'error' ? 'error' : ['warning', 'deprecation'].includes(event.data.level) ? 'warning' : 'log');
      return;
    }
    if (event.data?.type === 'studio-preview-network') {
      const level = event.data.status >= 400 ? 'error' : 'info';
      appendPreviewConsoleEntry(level, `${event.data.method} ${event.data.url} (${event.data.status}) ${event.data.duration}ms`, {
        source: 'network',
        details: event.data.error ? `Error: ${event.data.error}` : `Status ${event.data.status} in ${event.data.duration}ms`,
        kind: 'network'
      });
      return;
    }
    if (event.data?.type === 'studio-preview-api-request') {
      request(event.data.url, {
        method: event.data.init?.method || 'GET',
        headers: event.data.init?.headers || {},
        body: event.data.init?.body || undefined
      }).then((body) => {
        event.source?.postMessage({ type: 'studio-preview-api-response', requestId: event.data.requestId, status: 200, body }, '*');
      }).catch((error) => {
        event.source?.postMessage({ type: 'studio-preview-api-response', requestId: event.data.requestId, status: 500, error: error.message }, '*');
      });
    }
  });

  const clearConsoleEntries = (kind = 'all') => {
    if (kind === 'all') {
      previewConsoleEntries = [];
      localStorage.removeItem(getPreviewConsoleStorageKey());
    } else {
      previewConsoleEntries = previewConsoleEntries.filter((entry) => {
        if (kind === 'error') return entry.level !== 'error';
        if (kind === 'warning') return entry.level !== 'warning' && entry.level !== 'deprecation';
        return true;
      });
      persistPreviewConsoleEntries();
    }
    runtimeDiagnosticState = { errors: 0, warnings: 0 };
    refreshDiagnostics();
    renderPreviewConsoleEntries();
  };

  document.getElementById('clearPreviewConsoleBtn')?.addEventListener('click', () => clearConsoleEntries('all'));
  document.getElementById('clearPreviewConsoleErrorsBtn')?.addEventListener('click', () => clearConsoleEntries('error'));
  document.getElementById('clearPreviewConsoleWarningsBtn')?.addEventListener('click', () => clearConsoleEntries('warning'));
  document.getElementById('pausePreviewConsoleBtn')?.addEventListener('click', () => {
    previewConsoleUiState.paused = !previewConsoleUiState.paused;
    updatePreviewConsoleStatusLabel();
    const button = document.getElementById('pausePreviewConsoleBtn');
    if (button) button.textContent = previewConsoleUiState.paused ? 'Resume' : 'Pause';
  });
  document.getElementById('exportPreviewConsoleBtn')?.addEventListener('click', () => {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), entries: previewConsoleEntries }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = 'kieltech-preview-console.json';
    downloadLink.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById('previewConsoleSearchInput')?.addEventListener('input', (event) => {
    previewConsoleUiState.search = event.target.value || '';
    renderPreviewConsoleEntries();
  });
  document.querySelectorAll('[data-console-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      previewConsoleUiState.filter = button.dataset.consoleFilter || 'all';
      document.querySelectorAll('[data-console-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
      renderPreviewConsoleEntries();
    });
  });

  updatePreviewConsoleStatusLabel();
  restorePreviewConsole();

  const consolePanel = document.querySelector('.studio-preview-console');
  const toggleConsole = () => {
    if (!consolePanel) return;
    const button = document.getElementById('togglePreviewConsoleBtn');
    const isCollapsed = consolePanel.classList.toggle('is-collapsed');
    button?.setAttribute('aria-expanded', String(!isCollapsed));
    button?.setAttribute('aria-label', isCollapsed ? 'Open console' : 'Close console');
    button?.setAttribute('title', isCollapsed ? 'Open console' : 'Close console');
  };

  consolePanel?.addEventListener('click', (event) => {
    if (event.target.closest('#clearPreviewConsoleBtn')) return;
    if (event.target.closest('#togglePreviewConsoleBtn')) return;
    if (event.target.closest('.studio-preview-console__header')) return;
    if (consolePanel.classList.contains('is-collapsed')) {
      toggleConsole();
    }
  });

  document.querySelector('.studio-preview-console__header')?.addEventListener('click', (event) => {
    if (event.target.closest('#clearPreviewConsoleBtn')) return;
    if (event.target.closest('#togglePreviewConsoleBtn')) return;
    toggleConsole();
  });

  document.getElementById('togglePreviewConsoleBtn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleConsole();
  });

  const reloadPreviewFrame = () => {
    const iframe = document.getElementById('appPreviewIframe');
    if (!iframe) return;

    previewLoadingIndicator?.classList.remove('is-hidden');

    const workspacePreview = compileWorkspacePreview();
    renderPreviewContent(workspacePreview.html, workspacePreview.css, workspacePreview.js);
  };

  refreshPreviewBtn?.addEventListener('click', () => {
    reloadPreviewFrame();
  });

  fullscreenPreviewBtn?.addEventListener('click', () => {
    const previewContainer = document.getElementById('previewView');
    if (!previewContainer) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    previewContainer.requestFullscreen?.();
  });

  const setAllFoldersOpen = (isOpen) => {
    const updateEntries = (entries) => entries.map((entry) => entry.type === 'folder'
      ? { ...entry, open: isOpen, children: Array.isArray(entry.children) ? updateEntries(entry.children) : entry.children }
      : entry);
    projectFiles = updateEntries(projectFiles);
    renderFileExplorer();
    saveWorkspaceState();
  };
  const fileSearchToggle = document.getElementById('fileSearchBtn');
  const fileSearchWrapper = document.getElementById('studioFileSearchWrapper');
  const fileSearchInput = document.getElementById('fileSearchInput');
  const newFileButton = document.getElementById('addFileBtn');
  const collapseAllButton = document.getElementById('collapseAllButton');
  const explorerDropdown = document.getElementById('studioExplorerDropdown');
  const deleteDialog = document.getElementById('studioDeleteEntryDialog');
  const deleteDialogName = document.getElementById('studioDeleteEntryName');
  const deleteDialogConfirm = document.getElementById('studioDeleteEntryConfirm');
  const deleteDialogCancel = document.getElementById('studioDeleteEntryCancel');
  let pendingDeletePath = '';
  const renameDialog = document.getElementById('studioRenameEntryDialog');
  const renameDialogName = document.getElementById('studioRenameEntryName');
  const renameDialogInput = document.getElementById('studioRenameEntryInput');
  const renameDialogConfirm = document.getElementById('studioRenameEntryConfirm');
  const renameDialogCancel = document.getElementById('studioRenameEntryCancel');
  let pendingRenamePath = '';
  const createEntryForm = document.getElementById('studioCreateEntryForm');
  const createEntryName = document.getElementById('studioCreateEntryName');
  const createEntryParent = document.getElementById('studioCreateEntryParent');
  let createEntryType = 'file';
  fileSearchToggle?.addEventListener('click', () => {
    if (!fileSearchWrapper) return;
    fileSearchWrapper.classList.toggle('is-active');
    if (fileSearchWrapper.classList.contains('is-active')) {
      fileSearchInput?.focus();
    }
  });

  collapseAllButton?.addEventListener('click', () => setAllFoldersOpen(false));

  fileSearchInput?.addEventListener('input', (event) => {
    filterExplorer(event.target.value);
  });

  newFileButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    explorerDropdown?.toggleAttribute('hidden');
  });

  const fileTreeActions = document.getElementById('studioFileList');
  const openCreateEntryForm = (type, parentPath = '') => {
    createEntryType = type;
    if (!createEntryForm || !createEntryParent) return;
    createEntryParent.innerHTML = '<option value="">Project root</option>';
    getFolderEntries().forEach(({ path }) => {
      createEntryParent.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`);
    });
    createEntryParent.value = parentPath;
    explorerDropdown?.setAttribute('hidden', '');
    createEntryForm.hidden = false;
    createEntryName.value = '';
    createEntryName.placeholder = type === 'folder' ? 'new-folder' : 'new-file.txt';
    createEntryName.focus();
  };

  explorerDropdown?.querySelectorAll('[data-create-kind]').forEach((button) => {
    button.onclick = () => openCreateEntryForm(button.getAttribute('data-create-kind') || 'file');
  });

  fileTreeActions?.addEventListener('click', (event) => {
    const menuButton = event.target.closest('.studio-file-menu-button');
    if (menuButton) {
      event.stopPropagation();
      const menu = menuButton.parentElement.querySelector('.studio-file-context-menu');
      document.querySelectorAll('.studio-file-context-menu').forEach((item) => {
        if (item !== menu) item.hidden = true;
      });
      menu.hidden = !menu.hidden;
      menuButton.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) {
        const buttonRect = menuButton.getBoundingClientRect();
        menu.classList.add('studio-file-context-menu--floating');
        menu.style.position = 'fixed';
        const menuWidth = 168;
        const menuHeight = 180;
        const left = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, buttonRect.right - 8));
        const top = Math.min(window.innerHeight - menuHeight - 12, Math.max(12, buttonRect.bottom + 10));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
      } else {
        menu.classList.remove('studio-file-context-menu--floating');
        menu.style.position = '';
        menu.style.left = '';
        menu.style.top = '';
      }
      return;
    }
    const actionButton = event.target.closest('[data-context-action]');
    if (!actionButton) return;
    const item = actionButton.closest('.studio-file-item');
    const action = actionButton.dataset.contextAction;
    const entryPath = item?.dataset.entryPath || '';
    const entryName = item?.dataset.filename || '';
    if (!item || !entryPath) return;
    item.querySelector('.studio-file-context-menu').hidden = true;
    if (action === 'new-file' || action === 'new-folder') {
      openCreateEntryForm(action === 'new-folder' ? 'folder' : 'file', entryPath);
    } else if (action === 'copy') {
      const sourceEntry = findEntryByPath(entryPath) || findFileEntry(entryName, getEntryParentPath(entryPath)) || null;
      const sourcePath = entryPath;
      const source = sourceEntry || { name: entryName, type: item.classList.contains('folder') ? 'folder' : 'file', path: sourcePath, children: item.classList.contains('folder') ? [] : undefined };
      studioClipboard = { entry: cloneEntryTree(source), path: sourcePath };
      showToast(`${source.name} copied`);
    } else if (action === 'paste') {
      const targetParentPath = item.classList.contains('folder') ? entryPath : getEntryParentPath(entryPath);
      pasteFromAvailableClipboard(targetParentPath);
    } else if (action === 'rename') {
      pendingRenamePath = entryPath;
      if (renameDialogName) renameDialogName.textContent = entryPath;
      if (renameDialogInput) {
        renameDialogInput.value = entryName;
        renameDialogInput.focus();
        renameDialogInput.select();
      }
      if (renameDialog) {
        renameDialog.classList.add('studio-dialog--floating');
        renameDialog.hidden = false;
      }
    } else if (action === 'delete') {
      pendingDeletePath = entryPath;
      if (deleteDialogName) deleteDialogName.textContent = entryPath;
      if (deleteDialog) {
        deleteDialog.classList.add('studio-dialog--floating');
        deleteDialog.hidden = false;
      }
    } else if (action === 'copy-path') {
      navigator.clipboard?.writeText(entryPath);
    }
  });

  createEntryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = createEntryName?.value.trim();
    if (!name) {
      showToast('Enter a name for the new item.');
      return;
    }
    const created = addEntryToFolder(name, createEntryType, createEntryParent?.value || '');
    if (!created) return;
    createEntryForm.hidden = true;
    renderFileExplorer();
    saveWorkspaceState();
    syncSharedWorkspace();
    if (created.type === 'file') {
      const parentValue = createEntryParent?.value || '';
      const parentFolderName = parentValue ? parentValue.split('/').pop() : '';
      selectFileByName(name, parentFolderName);
    }
  });

  document.getElementById('studioCreateEntryCancel')?.addEventListener('click', () => {
    createEntryForm.hidden = true;
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (explorerDropdown && target && typeof target !== 'string' && !explorerDropdown.contains(target) && target !== newFileButton) {
      explorerDropdown.setAttribute('hidden', '');
    }
    if (target && typeof target.closest === 'function' && !target.closest('.studio-file-context-menu, .studio-file-menu-button')) {
      document.querySelectorAll('.studio-file-context-menu').forEach((menu) => { menu.hidden = true; });
      document.querySelectorAll('.studio-file-menu-button').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    }
  });

  document.addEventListener('keydown', (event) => {
    const isCodeViewActive = document.getElementById('codeView')?.classList.contains('active');
    if (!isCodeViewActive) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, [contenteditable="true"]')) return;

    const isCopyShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'c';
    const isPasteShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v';
    if (!isCopyShortcut && !isPasteShortcut) return;

    event.preventDefault();

    const resolvedSelection = selectedExplorerEntryPath || (activeEditorFolderName ? `${activeEditorFolderName}/${activeEditorFileName || ''}` : activeEditorFileName || '');
    const selectedEntry = resolvedSelection ? findEntryByPath(resolvedSelection) : null;

    if (isCopyShortcut) {
      if (!selectedEntry) {
        showToast('Select a file or folder to copy.');
        return;
      }
      studioClipboard = { entry: cloneEntryTree(selectedEntry), path: resolvedSelection };
      showToast(`${selectedEntry.name} copied`);
      return;
    }

    const targetPath = selectedEntry && selectedEntry.type === 'folder'
      ? selectedEntry.name && resolvedSelection
        ? resolvedSelection
        : ''
      : selectedEntry
        ? getEntryParentPath(resolvedSelection)
        : activeEditorFolderName || '';

    pasteFromAvailableClipboard(targetPath);
  });

  document.addEventListener('paste', (event) => {
    if (!document.getElementById('codeView')?.classList.contains('active')) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, [contenteditable="true"]')) return;
    const targetParentPath = selectedExplorerEntryPath && findEntryByPath(selectedExplorerEntryPath)?.type === 'folder'
      ? selectedExplorerEntryPath
      : activeEditorFolderName || '';
    const clipboardFiles = event.clipboardData?.files;
    if (clipboardFiles?.length) {
      event.preventDefault();
      importExternalClipboardFiles(clipboardFiles, targetParentPath);
      return;
    }
    if (event.clipboardData?.getData('text/plain')) {
      event.preventDefault();
      pasteExternalClipboard(targetParentPath, event.clipboardData.getData('text/plain'));
    }
  });

  deleteDialogConfirm?.addEventListener('click', () => {
    if (!pendingDeletePath) return;
    deleteEntry(pendingDeletePath);
    pendingDeletePath = '';
    if (deleteDialog) {
      deleteDialog.classList.remove('studio-dialog--floating');
      deleteDialog.hidden = true;
    }
    renderFileExplorer();
    renderEditor();
    saveWorkspaceState();
    syncSharedWorkspace();
  });

  deleteDialogCancel?.addEventListener('click', () => {
    pendingDeletePath = '';
    if (deleteDialog) {
      deleteDialog.classList.remove('studio-dialog--floating');
      deleteDialog.hidden = true;
    }
  });

  renameDialogConfirm?.addEventListener('click', () => {
    const nextName = renameDialogInput?.value.trim();
    const oldName = pendingRenamePath.split('/').pop();
    if (nextName && nextName !== oldName && renameEntry(pendingRenamePath, nextName)) {
      renderFileExplorer();
      renderEditor();
      saveWorkspaceState();
      syncSharedWorkspace();
    }
    pendingRenamePath = '';
    if (renameDialog) {
      renameDialog.classList.remove('studio-dialog--floating');
      renameDialog.hidden = true;
    }
  });

  renameDialogCancel?.addEventListener('click', () => {
    pendingRenamePath = '';
    if (renameDialog) {
      renameDialog.classList.remove('studio-dialog--floating');
      renameDialog.hidden = true;
    }
  });

  editorTextarea?.addEventListener('input', (event) => {
    const value = event.target.value;
    updateFileContent(value);
    const highlight = document.getElementById('studioEditorHighlight');
    if (highlight) {
      highlight.innerHTML = syntaxHighlight(value);
    }
    refreshPreviewFromWorkspace();
    previewLoadingIndicator?.classList.remove('is-hidden');
    updateDiagnostics(0, 0, 1);
  });

  document.getElementById('codeViewerContainer')?.addEventListener('input', (event) => {
    const editor = event.target.closest('.studio-code-editor-input');
    if (!editor) return;
    updateFileContent(editor.value);
    const highlight = editor.parentElement?.querySelector('.studio-code-highlight-layer');
    const gutter = editor.closest('.studio-code-editor-shell')?.querySelector('.studio-code-editor-gutter');
    if (highlight) highlight.innerHTML = syntaxHighlight(editor.value) || '&nbsp;';
    if (gutter) gutter.innerHTML = editor.value.split('\n').map((_, index) => `<span class="studio-editor-line-number">${index + 1}</span>`).join('');
    refreshPreviewFromWorkspace();
    previewLoadingIndicator?.classList.remove('is-hidden');
    updateDiagnostics(0, 0, 1);
  });

  document.getElementById('codeViewerContainer')?.addEventListener('scroll', (event) => {
    const editor = event.target.closest('.studio-code-editor-input');
    if (!editor) return;
    const highlight = editor.parentElement?.querySelector('.studio-code-highlight-layer');
    const gutter = editor.closest('.studio-code-editor-shell')?.querySelector('.studio-code-editor-gutter');
    if (highlight) {
      highlight.scrollTop = editor.scrollTop;
      highlight.scrollLeft = editor.scrollLeft;
    }
    if (gutter) gutter.scrollTop = editor.scrollTop;
  }, true);

  document.querySelector('.studio-editor-tabs')?.addEventListener('click', (event) => {
    handleEditorTabClick(event);
  });

  const triggerDownload = async () => {
    const zipUrl = await buildZipAndDownload();
    if (!zipUrl) return;
    const link = document.createElement('a');
    link.href = zipUrl;
    const projectName = (document.getElementById('studioNavTitle')?.textContent || 'kieltech-studio-code').trim();
    const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    link.download = `${safeName}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(zipUrl);
  };

  downloadCodeButton?.addEventListener('click', triggerDownload);
  downloadZipButton?.addEventListener('click', triggerDownload);

  const tabPreviewBtn = document.getElementById('tabPreviewBtn');
  const tabCodeBtn = document.getElementById('tabCodeBtn');
  const previewView = document.getElementById('previewView');
  const codeView = document.getElementById('codeView');
  const viewportButtons = Array.from(document.querySelectorAll('.studio-viewport-btn'));

  if (tabPreviewBtn && tabCodeBtn && previewView && codeView) {
    const ensureStudioToolbarAlwaysVisible = () => {
      const toolbar = document.getElementById('studioSubToolbar');
      if (toolbar) {
        toolbar.style.display = 'flex';
        toolbar.style.visibility = 'visible';
        toolbar.style.opacity = '1';
      }
      tabPreviewBtn.style.display = 'flex';
      tabCodeBtn.style.display = 'flex';
      tabPreviewBtn.style.visibility = 'visible';
      tabCodeBtn.style.visibility = 'visible';
      tabPreviewBtn.style.opacity = '1';
      tabCodeBtn.style.opacity = '1';
    };

    const applyStudioViewMode = (mode) => {
      const isPreview = mode === 'preview';
      tabPreviewBtn.classList.toggle('active', isPreview);
      tabCodeBtn.classList.toggle('active', !isPreview);
      previewView.classList.toggle('active', isPreview);
      codeView.classList.toggle('active', !isPreview);
      ensureStudioToolbarAlwaysVisible();
    };

    tabPreviewBtn.addEventListener('click', () => {
      applyStudioViewMode('preview');
      window.requestAnimationFrame(() => {
        refreshPreviewFromWorkspace();
        const iframe = document.getElementById('appPreviewIframe');
        if (iframe && !iframe.srcdoc && (!iframe.src || iframe.src === 'about:blank')) {
          const workspacePreview = compileWorkspacePreview();
          renderPreviewContent(workspacePreview.html, workspacePreview.css, workspacePreview.js);
        }
      });
    });

    tabCodeBtn.addEventListener('click', () => {
      applyStudioViewMode('code');
      if (!openEditorTabNames.length || !activeEditorFileName) {
        selectDefaultCodeFile();
      }
    });
  }

  viewportButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const viewport = button.dataset.viewport || 'desktop';
      const presets = viewport === 'mobile'
        ? { width: 375, height: 812 }
        : viewport === 'tablet'
          ? { width: 768, height: 1024 }
          : {};
      setStudioPreviewDevice({ viewport, ...presets });
    });
  });

  const previewShell = document.querySelector('.studio-preview-shell');
  const previewIframe = document.getElementById('appPreviewIframe');
  previewIframe?.addEventListener('load', () => {
    const frame = document.getElementById('previewDeviceFrame');
    if (frame && !frame.classList.contains('is-desktop')) {
      setPreviewEmulationDpr(getPreviewEmulationSettings().dpr);
    }
  });
  previewIframe?.addEventListener('pointerleave', () => {
    previewIframe.style.cursor = 'auto';
  });
  if (previewShell && window.ResizeObserver) {
    const previewResizeObserver = new ResizeObserver(() => updatePreviewDeviceScale());
    previewResizeObserver.observe(previewShell);
  }

  setStudioPreviewDevice({ viewport: 'desktop' });
  refreshPreviewFromWorkspace();
  refreshDiagnostics();

  const promptInput = document.getElementById('studioPromptInput');
  const sendButton = document.getElementById('studioActionButton');
  const chatHistory = document.querySelector('.studio-chat-history') || document.querySelector('.studio-left-scroll-area');
  const scrollArea = document.querySelector('.studio-left-scroll-area');

  if (!promptInput || !sendButton || !chatHistory) return;

  let studioAutoScrollEnabled = true;
  let studioProgrammaticScroll = false;
  let studioScrollResetTimer = null;

  const isStudioGenerationActive = () => sendButton.classList.contains('is-generating');

  const isStudioScrollAtBottom = () => {
    if (!scrollArea) return true;
    return scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 24;
  };

  const scrollStudioToLatest = () => {
    if (!scrollArea || !isStudioGenerationActive() || !studioAutoScrollEnabled) return;
    const align = () => {
      if (!scrollArea || !isStudioGenerationActive() || !studioAutoScrollEnabled) return;
      studioProgrammaticScroll = true;
      scrollArea.scrollTop = scrollArea.scrollHeight;
      window.setTimeout(() => { studioProgrammaticScroll = false; }, 80);
    };
    align();
    window.requestAnimationFrame(align);
    window.setTimeout(align, 120);
    window.clearTimeout(studioScrollResetTimer);
    studioScrollResetTimer = window.setTimeout(() => {
      studioProgrammaticScroll = false;
    }, 180);
  };

  const pauseStudioAutoScroll = () => {
    if (!isStudioGenerationActive()) return;
    studioAutoScrollEnabled = false;
  };

  scrollArea?.addEventListener('wheel', pauseStudioAutoScroll, { passive: true });
  scrollArea?.addEventListener('touchstart', pauseStudioAutoScroll, { passive: true });
  scrollArea?.addEventListener('scroll', () => {
    if (studioProgrammaticScroll || !isStudioGenerationActive()) return;
    studioAutoScrollEnabled = isStudioScrollAtBottom();
  }, { passive: true });
  if (scrollArea && window.MutationObserver) {
    const studioScrollObserver = new MutationObserver(scrollStudioToLatest);
    studioScrollObserver.observe(scrollArea, { childList: true, characterData: true, subtree: true });
    if (window.ResizeObserver) {
      const studioResizeObserver = new ResizeObserver(scrollStudioToLatest);
      studioResizeObserver.observe(scrollArea);
      studioResizeObserver.observe(chatHistory);
    }
  }

  let isGenerating = false;
  let aiResponseTimeout = null;
  let pendingEditedMessage = false;
  const chatSessionsBaseStorageKey = 'kieltech-studio-chat-sessions-v1';
  let chatSessionsProjectId = new URLSearchParams(window.location.search).get('project_id')
    || localStorage.getItem('kieltech-server-studio-project-id')
    || '';
  let chatSessionsStorageKey = `${chatSessionsBaseStorageKey}:${chatSessionsProjectId || 'unassigned'}`;
  let chatSessions = [];
  let activeChatSessionId = '';

  const saveChatSessions = () => {
    localStorage.setItem(chatSessionsStorageKey, JSON.stringify({ chatSessions, activeChatSessionId }));
  };

  const serverChatRequest = (path, options = {}) => {
    if (!state.token) return Promise.reject(new Error('Authentication required.'));
    return request(path, options);
  };

  const toServerChatSession = (session) => {
    const localSession = chatSessions.find((candidate) => candidate.id === session.id);
    const localMessages = localSession?.messages || [];
    const matchedLocalMessages = new Set();
    return {
      ...session,
      messages: (session.messages || []).map((message) => {
        const text = message.text || message.content || '';
        const localIndex = localMessages.findIndex((candidate, index) =>
          !matchedLocalMessages.has(index) && candidate.role === message.role && candidate.text === text
        );
        const localMessage = localIndex >= 0 ? localMessages[localIndex] : null;
        if (localIndex >= 0) matchedLocalMessages.add(localIndex);
        const metadataSource = message.workspaceTask === true ? message : localMessage;
        const workflowMetadata = metadataSource?.workspaceTask === true && Array.isArray(metadataSource.workflowEntries)
          ? {
              workspaceTask: true,
              workflowEntries: metadataSource.workflowEntries,
              featureChecklist: Array.isArray(metadataSource.featureChecklist) ? metadataSource.featureChecklist : [],
              verificationStatus: metadataSource.verificationStatus || 'pending',
              verificationResults: Array.isArray(metadataSource.verificationResults) ? metadataSource.verificationResults : []
            }
          : {};
        return {
          role: message.role,
          text,
          author: message.author || '',
          ...workflowMetadata
        };
      })
    };
  };

  const ensureServerChatSession = async (session) => {
    if (!session || !state.token) return null;
    return serverChatRequest('/v1/studio/chat-sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: session.id,
        title: session.title || 'New chat',
        project_id: chatSessionsProjectId || null
      })
    });
  };

  const syncChatSessionsFromServer = async () => {
    if (!state.token) return;
    try {
      const projectQuery = chatSessionsProjectId ? `?project_id=${encodeURIComponent(chatSessionsProjectId)}` : '';
      let payload = await serverChatRequest(`/v1/studio/chat-sessions${projectQuery}`);
      if (!Array.isArray(payload.sessions) || !payload.sessions.length) {
        for (const session of chatSessions) {
          await ensureServerChatSession(session);
          for (const message of session.messages || []) {
            await serverChatRequest(`/v1/studio/chat-sessions/${encodeURIComponent(session.id)}/messages`, {
              method: 'POST',
              body: JSON.stringify({
                role: message.role,
                content: message.text,
                author: message.author || '',
                metadata: message.workspaceTask === true && Array.isArray(message.workflowEntries)
                  ? {
                      workspaceTask: true,
                      workflowEntries: message.workflowEntries,
                      featureChecklist: message.featureChecklist || [],
                      verificationStatus: message.verificationStatus || 'pending',
                      verificationResults: message.verificationResults || []
                    }
                  : {}
              })
            });
          }
        }
        payload = await serverChatRequest(`/v1/studio/chat-sessions${projectQuery}`);
      }
      if (!Array.isArray(payload.sessions) || !payload.sessions.length) return;
      const previousActiveId = activeChatSessionId;
      chatSessions = payload.sessions.map(toServerChatSession);
      activeChatSessionId = chatSessions.some((session) => session.id === previousActiveId)
        ? previousActiveId
        : chatSessions[0].id;
      saveChatSessions();
      renderChatSessionMenu();
      renderChatSessionMessages();
    } catch (error) {
      console.warn('Unable to sync Studio chat sessions:', error);
    }
  };

  const createChatSession = () => ({
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New chat',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const isLegacyMockChatText = (text = '') => {
    const normalized = String(text || '').trim();
    return normalized.includes('I have processed your request:')
      || normalized.includes('Converted messages into distinct container cards.')
      || normalized.includes('Layout Updated')
      || normalized.includes('Structured user and AI message containers.')
      || normalized.includes('Styled the AI responses separately from user prompts.');
  };

  const loadChatSessions = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(chatSessionsStorageKey) || '{}');
      const rawSessions = Array.isArray(stored) ? stored : (Array.isArray(stored.chatSessions) ? stored.chatSessions : []);
      chatSessions = rawSessions
        .map((session) => ({
          ...session,
          messages: Array.isArray(session.messages)
            ? session.messages
              .filter((message) => !isLegacyMockChatText(message?.text || '') && message?.kind !== 'thinking')
              .filter((message, index, messages) => message.role !== 'assistant' || messages.findIndex((candidate) => candidate.role === 'assistant' && candidate.text === message.text) === index)
              .filter((message, index, messages) => index === 0 || message.role !== messages[index - 1].role || message.text !== messages[index - 1].text)
            : []
        }))
        .filter((session) => (session.messages || []).length > 0 || session.id === (stored?.activeChatSessionId || ''));

      if (!chatSessions.length) {
        const freshSession = createChatSession();
        chatSessions = [freshSession];
      }
      activeChatSessionId = stored?.activeChatSessionId || chatSessions[0]?.id || '';
    } catch (error) {
      console.warn('Unable to load studio chat sessions', error);
      chatSessions = [];
      activeChatSessionId = '';
    }

    if (!chatSessions.length) {
      const firstSession = createChatSession();
      chatSessions = [firstSession];
      activeChatSessionId = firstSession.id;
    }
    if (!chatSessions.some((session) => session.id === activeChatSessionId)) {
      activeChatSessionId = chatSessions[0].id;
    }
    saveChatSessions();
  };

  const getActiveChatSession = () => chatSessions.find((session) => session.id === activeChatSessionId) || chatSessions[0];

  const renderChatSessionMenu = () => {
    const menuList = document.getElementById('studioChatMenuList');
    const activeTitle = document.getElementById('studioActiveChatTitle');
    const activeSession = getActiveChatSession();
    if (activeTitle) {
      activeTitle.textContent = activeSession?.title || 'New chat';
      activeTitle.title = activeSession?.title || 'Active chat session';
    }
    if (!menuList) return;
    menuList.innerHTML = chatSessions
      .slice()
      .sort((left, right) => {
        if (left.id === activeChatSessionId) return -1;
        if (right.id === activeChatSessionId) return 1;
        return new Date(right.updatedAt) - new Date(left.updatedAt);
      })
      .map((session) => `
        <div class="studio-chat-session-item${session.id === activeChatSessionId ? ' is-active' : ''}" data-chat-session-id="${escapeHtml(session.id)}">
          <button type="button" class="studio-chat-menu__item" data-chat-select="true">${escapeHtml(session.title || 'New chat')}</button>
          <button type="button" class="studio-chat-session-actions" data-chat-action="toggle" aria-label="Actions for ${escapeHtml(session.title || 'New chat')}" title="Chat actions">
            <span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>
          </button>
          <span class="studio-chat-session-action-menu" hidden>
            <button type="button" data-chat-action="rename">Rename</button>
            <button type="button" data-chat-action="delete">Delete</button>
          </span>
        </div>`)
      .join('');
  };

  const renderStudioWorkflowStep = (entry, state, seenExplanations) => {
    const summary = entry.summary || entry.title || 'Workspace step completed.';
    const summaryLower = summary.toLocaleLowerCase();
    const paths = Array.isArray(entry.paths)
      ? entry.paths.filter((path) => typeof path === 'string' && !summaryLower.includes(path.toLocaleLowerCase()))
      : [];
    const explanation = typeof entry.explanation === 'string' ? entry.explanation.trim() : '';
    const explanationKey = explanation.replace(/\s+/g, ' ').toLocaleLowerCase();
    const showExplanation = explanation && !seenExplanations.has(explanationKey);
    if (showExplanation) seenExplanations.add(explanationKey);
    const icon = state === 'error' ? 'error' : state === 'done' ? 'check_circle' : 'progress_activity';
    return `<div class="studio-copilot-activity__step is-${escapeHtml(state)}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><div class="studio-copilot-activity__step-content"><span>${escapeHtml(summary)}</span>${paths.length ? `<div class="studio-copilot-activity__paths">${paths.map((path) => `<code>${escapeHtml(path)}</code>`).join('')}</div>` : ''}${showExplanation ? `<p class="studio-copilot-activity__explanation">${escapeHtml(explanation)}</p>` : ''}</div></div>`;
  };

  const renderStudioFeatureChecklist = (features = []) => features.length
    ? `<div class="studio-copilot-activity__features"><strong>Feature checklist</strong>${features.map((item) => `<div class="studio-copilot-activity__feature"><span class="studio-copilot-activity__feature-status is-${escapeHtml(item.status)}">${escapeHtml(String(item.status || '').replaceAll('_', ' '))}</span><div><b>${escapeHtml(item.feature || 'Feature')}</b>${(item.evidence || []).map((evidence) => `<div class="studio-copilot-activity__evidence"><code>${escapeHtml(evidence.path || '')}</code><span>${escapeHtml(evidence.excerpt || '')}</span></div>`).join('')}<small>${escapeHtml(item.assessment || 'Source excerpts matched; runtime behavior is not proven.')}</small></div></div>`).join('')}</div>`
    : '';

  const renderStudioVerificationResults = (results = []) => results.length
    ? `<div class="studio-copilot-activity__verification"><strong>Verification checks</strong>${results.map((item) => `<div class="studio-copilot-activity__check is-${escapeHtml(item.status || 'unavailable')}"><span class="material-symbols-outlined" aria-hidden="true">${item.status === 'passed' ? 'check_circle' : item.status === 'failed' ? 'error' : 'pending'}</span><div><b>${escapeHtml(String(item.check || 'check').replaceAll('_', ' '))}</b><span>${escapeHtml(item.detail || item.status || 'Not run')}</span></div></div>`).join('')}</div>`
    : '';

  const renderChatSessionMessages = () => {
    const session = getActiveChatSession();
    if (!session) return;
    chatHistory.innerHTML = '';
    session.messages.forEach((message) => {
      if (message.role === 'user') {
        chatHistory.appendChild(createUserCard(message.text));
        return;
      }
      const aiCard = document.createElement('div');
      aiCard.className = 'studio-card studio-card--ai';
      aiCard.innerHTML = `<div class="studio-card__body">${parseMarkdown(message.text || '')}</div>`;
      if (message.workspaceTask === true && Array.isArray(message.workflowEntries)) {
        const activity = document.createElement('details');
        activity.className = 'studio-copilot-activity';
        const hasIssues = message.workflowEntries.some((entry) => entry.state === 'error');
        const changedFiles = [...new Set(message.workflowEntries.flatMap((entry) => Array.isArray(entry.files) ? entry.files : []).filter(Boolean))];
        const verificationStatus = message.verificationStatus || 'pending';
        const activityLabel = hasIssues
          ? 'Completed with issues'
          : !changedFiles.length
            ? 'Reviewed — no files changed'
            : verificationStatus === 'passed'
              ? 'Completed'
              : verificationStatus === 'failed'
                ? 'Implemented — checks failed'
                : verificationStatus === 'unavailable'
                  ? 'Implemented — checks unavailable'
                  : 'Implemented — verification pending';
        const seenExplanations = new Set();
        if (verificationStatus === 'passed' && changedFiles.length && !hasIssues) activity.classList.add('is-complete');
        else if (verificationStatus === 'failed' || hasIssues) activity.classList.add('is-error');
        else activity.classList.add(changedFiles.length ? 'is-pending' : 'is-review');
        activity.innerHTML = `
          <summary><span>${activityLabel}</span></summary>
          <div class="studio-copilot-activity__content">
            <div class="studio-copilot-activity__steps">${message.workflowEntries.length
              ? message.workflowEntries.map((entry) => renderStudioWorkflowStep(entry, entry.state === 'error' ? 'error' : 'done', seenExplanations)).join('')
              : '<span class="studio-copilot-activity__empty">Workspace task completed.</span>'}</div>
            ${renderStudioFeatureChecklist(message.featureChecklist || [])}
            ${renderStudioVerificationResults(message.verificationResults || [])}
            ${changedFiles.length
              ? `<div class="studio-copilot-activity__files"><strong>Changed project paths</strong>${changedFiles.map((path) => `<div class="studio-copilot-activity__file"><span class="material-symbols-outlined" aria-hidden="true">description</span><span>${escapeHtml(path)}</span></div>`).join('')}</div>`
              : ''}
          </div>`;
        aiCard.insertBefore(activity, aiCard.firstChild);
      }
      chatHistory.appendChild(aiCard);
    });
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  };

  const clearSessionActionHistory = () => {
    const actionHistory = document.getElementById('studioActionHistoryList');
    if (actionHistory) actionHistory.innerHTML = '';
    const buildControls = document.getElementById('studioBuildControls');
    if (buildControls) buildControls.hidden = true;
  };

  const persistChatMessage = (role, text, author = '', metadata = {}) => {
    const session = getActiveChatSession();
    if (!session) return;
    const lastMessage = session.messages[session.messages.length - 1];
    if (lastMessage && lastMessage.role === role && lastMessage.text === text) {
      if (Object.keys(metadata).length) {
        Object.assign(lastMessage, metadata);
        session.updatedAt = new Date().toISOString();
        saveChatSessions();
        renderChatSessionMessages();
      }
      return;
    }
    session.messages.push({ role, text, author, ...metadata });
    if (role === 'user' && session.title === 'New chat') session.title = text.split(/\s+/).slice(0, 8).join(' ').slice(0, 64);
    session.updatedAt = new Date().toISOString();
    saveChatSessions();
    renderChatSessionMenu();
    const serverPersistence = ensureServerChatSession(session).then(() => serverChatRequest(`/v1/studio/chat-sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role, content: text, author, metadata })
    })).catch((error) => {
      console.warn('Unable to persist Studio chat message:', error);
    });
    const projectId = localStorage.getItem('kieltech-server-studio-project-id');
    if (projectId && role !== 'system') {
      fetch(`${getApiBaseUrl()}/v1/studio/projects/${encodeURIComponent(projectId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
        },
        body: JSON.stringify({ role, content: text, author })
      }).catch(() => {});
    }
    return serverPersistence;
  };

  window.KieltechStudioChat = {
    persist: persistChatMessage,
    render: renderChatSessionMessages,
    switchProject: (projectId) => {
      if (chatSessionsProjectId === projectId) return;
      chatSessionsProjectId = projectId || '';
      chatSessionsStorageKey = `${chatSessionsBaseStorageKey}:${chatSessionsProjectId || 'unassigned'}`;
      loadChatSessions();
      renderChatSessionMenu();
      renderChatSessionMessages();
      syncChatSessionsFromServer();
    },
    getRecentAssistantText: () => {
      const session = getActiveChatSession();
      return [...(session?.messages || [])].reverse().find((message) => message.role === 'assistant' && message.kind !== 'thinking')?.text || '';
    }
  };

  const closeChatMenu = () => {
    const menu = document.getElementById('studioChatMenu');
    const button = document.getElementById('studioNewChatButton');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  };

  const chatMenu = document.getElementById('studioChatMenu');
  const newChatButton = document.getElementById('studioNewChatButton');
  const startNewChatButton = document.getElementById('studioStartNewChat');
  const sessionDialog = document.createElement('div');
  sessionDialog.className = 'studio-chat-session-dialog';
  sessionDialog.hidden = true;
  sessionDialog.innerHTML = `
    <div class="studio-chat-session-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="studioChatSessionDialogTitle">
      <h2 id="studioChatSessionDialogTitle"></h2>
      <p id="studioChatSessionDialogMessage"></p>
      <input id="studioChatSessionDialogInput" type="text" maxlength="80" autocomplete="off" />
      <div class="studio-chat-session-dialog__actions">
        <button type="button" data-session-dialog-action="cancel">Cancel</button>
        <button type="button" class="is-primary" data-session-dialog-action="confirm">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(sessionDialog);
  const sessionDialogTitle = sessionDialog.querySelector('#studioChatSessionDialogTitle');
  const sessionDialogMessage = sessionDialog.querySelector('#studioChatSessionDialogMessage');
  const sessionDialogInput = sessionDialog.querySelector('#studioChatSessionDialogInput');
  let sessionDialogMode = '';
  let sessionDialogId = '';
  const closeSessionDialog = () => {
    sessionDialog.hidden = true;
    sessionDialogMode = '';
    sessionDialogId = '';
  };
  const openSessionDialog = (mode, sessionId) => {
    const session = chatSessions.find((item) => item.id === sessionId);
    if (!session) return;
    sessionDialogMode = mode;
    sessionDialogId = sessionId;
    sessionDialogTitle.textContent = mode === 'rename' ? 'Rename chat' : 'Delete chat';
    sessionDialogMessage.textContent = mode === 'rename' ? 'Choose a new title for this chat session.' : `Delete "${session.title}" and its saved messages?`;
    sessionDialogInput.hidden = mode !== 'rename';
    sessionDialogInput.value = session.title === 'New chat' ? '' : session.title;
    sessionDialog.querySelector('[data-session-dialog-action="confirm"]').textContent = mode === 'rename' ? 'Rename' : 'Delete';
    sessionDialog.querySelector('[data-session-dialog-action="confirm"]').classList.toggle('is-danger', mode === 'delete');
    sessionDialog.hidden = false;
    if (mode === 'rename') sessionDialogInput.focus();
  };
  sessionDialog.addEventListener('click', (event) => {
    const action = event.target.closest('[data-session-dialog-action]')?.dataset.sessionDialogAction;
    if (action === 'cancel') closeSessionDialog();
    if (action !== 'confirm') return;
    const session = chatSessions.find((item) => item.id === sessionDialogId);
    if (!session) return;
    if (sessionDialogMode === 'rename') {
      const nextTitle = sessionDialogInput.value.trim();
      if (!nextTitle) return sessionDialogInput.focus();
      session.title = nextTitle;
      serverChatRequest(`/v1/studio/chat-sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: nextTitle })
      }).catch(() => {});
    } else {
      chatSessions = chatSessions.filter((item) => item.id !== sessionDialogId);
      if (!chatSessions.length) chatSessions = [createChatSession()];
      if (activeChatSessionId === sessionDialogId) activeChatSessionId = chatSessions[0].id;
      serverChatRequest(`/v1/studio/chat-sessions/${encodeURIComponent(sessionDialogId)}`, { method: 'DELETE' }).catch(() => {});
      ensureServerChatSession(chatSessions[0]).catch(() => {});
      clearSessionActionHistory();
      renderChatSessionMessages();
    }
    saveChatSessions();
    renderChatSessionMenu();
    closeSessionDialog();
  });
  sessionDialogInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sessionDialog.querySelector('[data-session-dialog-action="confirm"]').click();
    if (event.key === 'Escape') closeSessionDialog();
  });
  loadChatSessions();
  syncChatSessionsFromServer();
  renderChatSessionMenu();
  newChatButton?.setAttribute('aria-expanded', 'false');
  newChatButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (chatMenu) chatMenu.hidden = !chatMenu.hidden;
    newChatButton.setAttribute('aria-expanded', String(!chatMenu?.hidden));
  });
  startNewChatButton?.addEventListener('click', async () => {
    if (isGenerating) {
      window.clearTimeout(aiResponseTimeout);
      isGenerating = false;
      updateButtonState();
    }
    const newSession = createChatSession();
    chatSessions.unshift(newSession);
    activeChatSessionId = newSession.id;
    ensureServerChatSession(newSession).catch(() => {});
    promptInput.value = '';
    clearSessionActionHistory();
    saveChatSessions();
    renderChatSessionMenu();
    renderChatSessionMessages();
    closeChatMenu();
    updateButtonState();
  });
  chatMenu?.addEventListener('click', (event) => {
    const sessionItem = event.target.closest('[data-chat-session-id]');
    if (!sessionItem) return;
    const action = event.target.closest('[data-chat-action]')?.dataset.chatAction;
    if (action === 'toggle') {
      const actionMenu = sessionItem.querySelector('.studio-chat-session-action-menu');
      const shouldOpen = actionMenu.hidden;
      chatMenu.querySelectorAll('.studio-chat-session-action-menu').forEach((menu) => {
        menu.hidden = true;
        menu.style.left = '';
        menu.style.top = '';
      });
      if (shouldOpen) {
        actionMenu.hidden = false;
        const menuRect = sessionItem.getBoundingClientRect();
        const left = Math.min(window.innerWidth - 160, Math.max(12, menuRect.right - 112));
        const top = Math.min(window.innerHeight - 120, Math.max(12, menuRect.bottom + 8));
        actionMenu.style.position = 'fixed';
        actionMenu.style.left = `${left}px`;
        actionMenu.style.top = `${top}px`;
        actionMenu.style.right = 'auto';
      } else {
        actionMenu.hidden = true;
      }
      return;
    }
    if (action === 'rename' || action === 'delete') {
      openSessionDialog(action, sessionItem.dataset.chatSessionId);
      return;
    }
    if (!event.target.closest('[data-chat-select]')) return;
    activeChatSessionId = sessionItem.dataset.chatSessionId;
    clearSessionActionHistory();
    saveChatSessions();
    renderChatSessionMenu();
    renderChatSessionMessages();
    closeChatMenu();
  });
  document.addEventListener('click', (event) => {
    if (!chatMenu?.contains(event.target) && event.target !== newChatButton) closeChatMenu();
  });
  const editWarning = document.getElementById('studioEditWarning');
  const editWarningDismiss = document.getElementById('studioEditWarningDismiss');
  const editWarningContinue = document.getElementById('studioEditWarningContinue');
  const editWarningCancel = document.getElementById('studioEditWarningCancel');
  const editWarningDismissKey = 'kieltech-studio-edit-warning-dismissed';
  const isEditWarningDismissed = () => localStorage.getItem(editWarningDismissKey) === 'true';

  if (editWarningDismiss) {
    editWarningDismiss.checked = isEditWarningDismissed();
    editWarningDismiss.addEventListener('change', () => {
      localStorage.setItem(editWarningDismissKey, editWarningDismiss.checked ? 'true' : 'false');
    });
  }

  const closeEditWarning = () => {
    if (editWarning) editWarning.hidden = true;
  };

  editWarningContinue?.addEventListener('click', () => {
    closeEditWarning();
    pendingEditedMessage = false;
    sendMessage();
  });
  editWarningCancel?.addEventListener('click', closeEditWarning);
  editWarning?.querySelector('[data-edit-warning-close]')?.addEventListener('click', closeEditWarning);

  const showEditWarning = () => {
    if (!editWarning || isEditWarningDismissed()) return false;
    editWarning.hidden = false;
    editWarningContinue?.focus();
    return true;
  };

  const clearEditedMessageDownstream = (row) => {
    const card = row?.querySelector('.studio-card--user');
    if (!card) return;

    try {
      const snapshot = card.dataset.workspaceSnapshot;
      if (snapshot) {
        const restoredFiles = JSON.parse(snapshot);
        if (Array.isArray(restoredFiles)) {
          projectFiles = restoredFiles;
          renderFileExplorer();
          renderEditor();
          saveWorkspaceState();
          refreshDiagnostics();
        }
      }
    } catch (error) {
      console.warn('Unable to restore workspace before editing message', error);
    }

    let current = row;
    while (current) {
      const next = current.nextElementSibling;
      current.remove();
      current = next;
    }
  };

  // Simple Markdown & Formatting Parser
  function parseMarkdown(text) {
    const prepared = prepareMarkdownCodeBlocks(text);
    const preparedTables = prepareMarkdownTables(prepared.source);
    const normalizedSource = preparedTables.source.replace(/\d+>\s*(?=[-*])/g, '\n').replace(/\s*\d+>\s*/g, '\n').replace(/^\s*#{1,6}\s*(?:overview of the output|summary)\s*$/gim, '');
    let html = escapeHtml(normalizedSource);
    html = renderSimpleMath(html);

    // Headings
    html = html.replace(/^\s*###\s*(.+)$/gim, '<h3>$1</h3>');
    html = html.replace(/^\s*##\s*(.+)$/gim, '<h2>$1</h2>');
    html = html.replace(/^\s*#\s*(.+)$/gim, '<h1>$1</h1>');
    html = html.replace(/<(h[1-3])>(?:[#*]+\s*)+([\s\S]*?)<\/\1>/gi, '<$1>$2</$1>');

    // Bold text
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = enhanceMarkdownHtml(html);
    html = renderBareMath(html);
    html = renderScienceNotation(html);

    // Let the AI choose ordered or unordered lists and preserve that choice.
    html = html.replace(/^\s*[-*]\s+(.+)$/gim, '<li class="bulleted">$1</li>');
    html = html.replace(/^\s*\d+[.)]\s+(.+)$/gim, '<li class="numbered">$1</li>');
    html = html.replace(/<\/li>\n(?=<li)/g, '</li>\n');
    html = html.replace(/((?:<li class="bulleted">[\s\S]*?<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.replace(/((?:<li class="numbered">[\s\S]*?<\/li>\n?)+)/g, '<ol>$1</ol>');
    html = html.replace(/<\/ul>\s*<ul>/g, '').replace(/<\/ol>\s*<ol>/g, '');

    // Paragraph breaks
    html = html.replace(/\n\n/g, '<br><br>');

    return restoreMarkdownTables(restoreMarkdownCodeBlocks(html, prepared.blocks, prepared.inlineBlocks), preparedTables.tables);
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[m]);
  }

  function renderSimpleMath(html) {
    const expression = (value) => value
      .replace(/\\mathbb\{R\}/g, 'ℝ').replace(/\\mathbb\{N\}/g, 'ℕ').replace(/\\mathbb\{Z\}/g, 'ℤ').replace(/\\mathbb\{Q\}/g, 'ℚ').replace(/\\mathbb\{C\}/g, 'ℂ')
      .replace(/\\text\{([^{}]+)\}/g, '<span class="kiel-chat-math__text">$1</span>')
      .replace(/\\sqrt\{([^{}]+)\}/g, '<span class="kiel-chat-math__sqrt">√<span>($1)</span></span>')
      .replace(/\\sqrt\[(\d+)\]\{([^{}]+)\}/g, '<span class="kiel-chat-math__root"><sup>$1</sup>√<span>($2)</span></span>')
      .replace(/\\(?:dfrac|tfrac|frac)\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="kiel-chat-math__fraction"><span>$1</span><span>$2</span></span>')
      .replace(/\\left|\\right/g, '')
      .replace(/\\[,:;]/g, ' ')
      .replace(/\\sum(?=[^A-Za-z]|$)/g, '∑')
      .replace(/\\prod(?=[^A-Za-z]|$)/g, '∏')
      .replace(/\\int(?=[^A-Za-z]|$)/g, '∫')
      .replace(/\\infty\b/g, '∞')
      .replace(/\\rightarrow\b|\\to\b/g, '→')
      .replace(/\\Rightarrow\b/g, '⇒')
      .replace(/\\in(?=[^A-Za-z]|$)/g, '∈')
      .replace(/\\notin(?=[^A-Za-z]|$)/g, '∉')
      .replace(/\\subseteq\b/g, '⊆')
      .replace(/\\subset\b/g, '⊂')
      .replace(/\\cup\b/g, '∪')
      .replace(/\\cap\b/g, '∩')
      .replace(/\\pm\b/g, '±')
      .replace(/\\pi\b/g, 'π')
      .replace(/\\circ\b/g, '°')
      .replace(/\\theta\b/g, 'θ')
      .replace(/\\alpha\b/g, 'α')
      .replace(/\\beta\b/g, 'β')
      .replace(/\\gamma\b/g, 'γ')
      .replace(/\\delta\b/g, 'δ')
      .replace(/\\lambda\b/g, 'λ')
      .replace(/\\mu\b/g, 'μ')
      .replace(/\\sigma\b/g, 'σ')
      .replace(/\\omega\b/g, 'ω')
      .replace(/\\times\b/g, '×')
      .replace(/\\cdot\b/g, '·')
      .replace(/\\ne\b|\\neq\b/g, '≠')
      .replace(/\\leq\b/g, '≤')
      .replace(/\\geq\b/g, '≥')
      .replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>')
      .replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>')
      .replace(/\^([A-Za-z0-9°])/g, '<sup>$1</sup>');
    return html
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, value) => `<span class="kiel-chat-math kiel-chat-math--display">${expression(value.trim())}</span>`)
      .replace(/\\\((.*?)\\\)/g, (_, value) => `<span class="kiel-chat-math">${expression(value.trim())}</span>`)
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, value) => `<span class="kiel-chat-math kiel-chat-math--display">${expression(value.trim())}</span>`)
      .replace(/\$([^$\n]+)\$/g, (_, value) => `<span class="kiel-chat-math">${expression(value.trim())}</span>`);
  }

  async function streamStudioAiResponse(targetBody, promptText) {
    const workspaceTools = [
      {
        type: 'function',
        function: {
          name: 'create_file',
          description: 'Create a new file in the workspace with the given path and contents.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path like src/app.js or notes.txt' },
              content: { type: 'string', description: 'The full file contents to write.' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_file',
          description: 'Overwrite the contents of an existing file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read an existing file to inspect or reference its contents.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file from the workspace.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files in the workspace so the agent can choose the right target.',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      }
    ];

    const response = await fetch(`${getApiBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: studioSelectedModel,
        prompt: promptText,
        system_instructions: 'You are a coding agent for the KielTech Studio. Use the available tools for every file action. If the request is to create, edit, remove, list, or read a file, do not explain manual steps; execute the tool immediately. Only provide explanatory text when the request is informational and does not require workspace changes.',
        temperature: 0.5,
        max_tokens: 900,
        stream: false,
        tools: workspaceTools,
        tool_choice: 'auto'
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || payload.error || `AI request failed with status ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const toolCalls = payload?.response?.tool_calls || payload?.tool_calls || payload?.choices?.[0]?.message?.tool_calls || payload?.message?.tool_calls || [];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      let finalToolCalls = toolCalls.map((toolCall) => {
        const fn = toolCall?.function || {};
        const parsedArgs = typeof fn.arguments === 'string'
          ? (() => {
              try {
                return JSON.parse(fn.arguments);
              } catch (error) {
                return { raw: fn.arguments };
              }
            })()
          : (fn.arguments || {});
        return {
          tool: (fn.name || toolCall?.name || 'tool_call').toLowerCase(),
          path: parsedArgs.path || parsedArgs.file || parsedArgs.target || '',
          content: typeof parsedArgs.content === 'string' ? parsedArgs.content : (parsedArgs.code || parsedArgs.text || ''),
          summary: fn.name || 'Tool response'
        };
      });

      const normalizedPrompt = String(promptText || '').toLowerCase();
      const namedFiles = ['styles.css', 'script.js'].filter((fileName) => normalizedPrompt.includes(fileName));
      if (namedFiles.length === 2 && finalToolCalls.length < 2) {
        const sourceContent = finalToolCalls[0]?.content || '';
        finalToolCalls = namedFiles.map((fileName) => ({
          tool: findEntryByPath(fileName) ? 'update_file' : 'create_file',
          path: fileName,
          content: sourceContent || (fileName === 'styles.css' ? '/* Styles added by the studio agent. */\n' : '// Script added by the studio agent.\n'),
          summary: `Updated ${fileName} for the requested website`
        }));
      }

      const toolRouter = window.KieltechStudioToolRouter || {};
      const appliedFiles = [];
      finalToolCalls.forEach((finalToolCall) => {
        const toolApplied = typeof toolRouter.execStudioToolCallFromPrompt === 'function'
          ? toolRouter.execStudioToolCallFromPrompt(finalToolCall, promptText)
          : false;
        if (toolApplied) appliedFiles.push(finalToolCall.path);
      });
      const summaryText = appliedFiles.length
        ? `## Changes applied\n\nUpdated ${appliedFiles.length} file${appliedFiles.length === 1 ? '' : 's'}:\n\n${appliedFiles.map((file) => `- ${file}`).join('\n')}\n\nThe requested files were added or updated and the workspace preview was refreshed.`
        : 'The AI selected workspace tools, but no file changes were applied.';
      targetBody.innerHTML = parseMarkdown(summaryText);
      return summaryText;
    }

    const reply = payload?.response?.output?.text || payload?.response?.text || payload?.reply || payload?.output || payload?.message || payload?.choices?.[0]?.message?.content || 'The AI did not return any text.';
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
    targetBody.innerHTML = parseMarkdown(text);
    return text.trim() || 'The AI did not return any text.';
  }

  function createUserCard(text) {
    const row = document.createElement('div');
    const card = document.createElement('div');
    const isLong = text.length > 420 || text.split('\n').length > 1;
    row.className = 'studio-user-message-row';
    card.className = `studio-card studio-card--user${isLong ? ' studio-card--user-long' : ''}`;
    card.dataset.messageText = text;
    card.dataset.workspaceSnapshot = JSON.stringify(projectFiles);
    card.innerHTML = `
      <div class="studio-card__body${isLong ? ' studio-card__body--collapsed' : ''}">${escapeHtml(text)}</div>
    `;
    const actions = document.createElement('div');
    actions.className = 'studio-user-message-actions';
    actions.innerHTML = `
      <button class="studio-user-message-edit" type="button" aria-label="Edit message" title="Edit message"><span class="material-symbols-outlined">edit</span></button>
      <button class="studio-user-message-copy" type="button" aria-label="Copy message" title="Copy message"><span class="material-symbols-outlined">content_copy</span></button>
      ${isLong ? '<button class="studio-user-message-toggle" type="button" aria-label="Expand message" title="Expand message" aria-expanded="false"><span class="material-symbols-outlined">expand_more</span></button>' : ''}
    `;
    row.append(card, actions);
    return row;
  }

  renderChatSessionMessages();

  // Convert existing HTML static elements to .studio-card structure
  function upgradeExistingMessages() {
    const oldMessages = chatHistory.querySelectorAll('.studio-message');
    oldMessages.forEach((msg) => {
      const isUser = msg.classList.contains('studio-message--user') || msg.querySelector('.studio-message__author')?.textContent.trim() === 'User';
      const bodyText = msg.querySelector('.studio-message__body')?.innerText || msg.innerText;

      const card = isUser ? createUserCard(bodyText) : document.createElement('div');
      if (!isUser) {
        card.className = 'studio-card studio-card--ai';
        card.innerHTML = `<div class="studio-card__body">${parseMarkdown(bodyText)}</div>`;
      }
      msg.replaceWith(card);
    });
  }

  const fitPromptInputHeight = () => {
    if (!promptInput) return;
    promptInput.style.maxHeight = '120px';
    promptInput.setAttribute('data-max-height', '120');
    promptInput.style.height = 'auto';
    const max = Number(promptInput.getAttribute('data-max-height')) || 180;
    const nextHeight = Math.max(42, Math.min(max, promptInput.scrollHeight));
    promptInput.style.height = `${nextHeight}px`;
  };

  // Button state logic
  function updateButtonState() {
    if (isGenerating) {
      sendButton.disabled = false;
      sendButton.classList.add('is-generating');
      sendButton.innerHTML = '<span class="icon-stop">■</span>';
      return;
    }

    sendButton.classList.remove('is-generating');
    sendButton.innerHTML = '<span class="studio-send-arrow" aria-hidden="true">&#8593;</span>';
    const hasText = promptInput.value.trim().length > 0;
    sendButton.disabled = !hasText;
    fitPromptInputHeight();
  }

  function sendMessage() {
    if (window.location.pathname.includes('web-development-studio')) return;
    const text = promptInput.value.trim();
    if (!text || isGenerating) return;

    if (pendingEditedMessage && showEditWarning()) return;
    if (editWarning) editWarning.hidden = true;
    pendingEditedMessage = false;

    // Append User Message (In a card container)
    const userCard = createUserCard(text);
    chatHistory.appendChild(userCard);
    persistChatMessage('user', text);

    promptInput.value = '';
    fitPromptInputHeight();
    isGenerating = true;
    updateButtonState();
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;

    // Use the live backend for AI responses and stream the chunks as they arrive.
    (async () => {
      const aiMsg = document.createElement('div');
      aiMsg.className = 'studio-ai-response';
      aiMsg.innerHTML = `
        <div class="studio-ai-response__author">${escapeHtml(studioModelDisplayNames[studioSelectedModel] || studioSelectedModel)}</div>
        <div class="studio-ai-response__body"></div>
      `;
      const bodyEl = aiMsg.querySelector('.studio-ai-response__body');
      chatHistory.appendChild(aiMsg);

      try {
        const streamedText = await streamStudioAiResponse(bodyEl, text);
        persistChatMessage('assistant', streamedText, studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
        loadAppPreview('about:blank');
      } catch (error) {
        const fallbackText = `## Request failed\n\nThe AI studio could not reach the live backend.\n\n**Details:** ${error?.message || 'Unknown error'}`;
        bodyEl.innerHTML = parseMarkdown(fallbackText);
        persistChatMessage('assistant', fallbackText, studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
      } finally {
        isGenerating = false;
        updateButtonState();
        if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
      }
    })();
  }

  // Event Listeners
  sendButton.addEventListener('click', (event) => {
    if (window.location.pathname.includes('web-development-studio') && sendButton.classList.contains('is-generating')) return;
    if (!pendingEditedMessage || isEditWarningDismissed()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showEditWarning();
  }, true);
  if (!window.location.pathname.includes('web-development-studio')) {
    sendButton.addEventListener('click', sendMessage);
  }
  chatHistory.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    const row = event.target.closest('.studio-user-message-row');
    const card = row?.querySelector('.studio-card--user') || event.target.closest('.studio-card--user');
    if (!button || !card) return;
    const messageText = card.dataset.messageText || card.querySelector('.studio-card__body')?.textContent || '';

    if (button.classList.contains('studio-user-message-toggle')) {
      const body = card.querySelector('.studio-card__body');
      const expanded = button.getAttribute('aria-expanded') === 'true';
      body?.classList.toggle('studio-card__body--collapsed', expanded);
      button.setAttribute('aria-expanded', String(!expanded));
      button.setAttribute('aria-label', expanded ? 'Expand message' : 'Collapse message');
      button.title = expanded ? 'Expand message' : 'Collapse message';
      const icon = button.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = expanded ? 'expand_more' : 'expand_less';
      return;
    }

    if (button.classList.contains('studio-user-message-edit')) {
      clearEditedMessageDownstream(row);
      pendingEditedMessage = true;
      if (editWarning) editWarning.hidden = true;
      promptInput.value = messageText;
      promptInput.focus();
      updateButtonState();
      return;
    }

    if (button.classList.contains('studio-user-message-copy')) {
      try {
        await navigator.clipboard.writeText(messageText);
        button.setAttribute('aria-label', 'Message copied');
        button.title = 'Message copied';
      } catch (error) {
        button.setAttribute('aria-label', 'Copy failed');
        button.title = 'Copy failed';
      }
    }
  });
  promptInput.addEventListener('input', updateButtonState);
  if (!window.location.pathname.includes('web-development-studio')) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // Run initial setup
  upgradeExistingMessages();
  updateButtonState();
});

// Simple Markdown Formatter for AI responses
function parseMarkdown(text) {
  const prepared = prepareMarkdownCodeBlocks(text);
  const preparedTables = prepareMarkdownTables(prepared.source);
  const normalizedSource = preparedTables.source.replace(/\d+>\s*(?=[-*])/g, '\n').replace(/\s*\d+>\s*/g, '\n').replace(/^\s*#{1,6}\s*(?:overview of the output|summary)\s*$/gim, '');
  let html = escapeHtml(normalizedSource);
  html = renderSimpleMath(html);

  // Headings & Subheadings
  html = html.replace(/^\s*###\s*(.+)$/gim, '<h3>$1</h3>');
  html = html.replace(/^\s*##\s*(.+)$/gim, '<h2>$1</h2>');
  html = html.replace(/^\s*#\s*(.+)$/gim, '<h1>$1</h1>');
  html = html.replace(/<(h[1-3])>(?:[#*]+\s*)+([\s\S]*?)<\/\1>/gi, '<$1>$2</$1>');
  html = html.replace(/<(h[1-3])>([\s\S]*?)\d+>\s*<\/\1>/gi, '<$1>$2</$1>');

  // Bold text
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = enhanceMarkdownHtml(html);
  html = renderBareMath(html);
  html = renderScienceNotation(html);

  // Preserve ordered and unordered list semantics.
  html = html.replace(/^\s*[-*]\s+(.+)$/gim, '<li class="bulleted">$1</li>');
  html = html.replace(/^\d+\.\s+(.*$)/gim, '<li class="numbered">$1</li>');
  html = html.replace(/<\/li>\n(?=<li)/g, '</li>\n');

  // Wrap consecutive list items in their matching list element.
  html = html.replace(/((?:<li class="bulleted">[\s\S]*?<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/((?:<li class="numbered">[\s\S]*?<\/li>\n?)+)/g, '<ol>$1</ol>');
  html = html.replace(/<\/ul>\s*<ul>/g, '').replace(/<\/ol>\s*<ol>/g, '');

  // Convert double linebreaks to paragraph spaces
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/(<\/h[1-3]>)<br><br>/gi, '$1');

  return restoreMarkdownTables(restoreMarkdownCodeBlocks(html, prepared.blocks, prepared.inlineBlocks), preparedTables.tables);
}

function sendMessage() {
  const text = promptInput.value.trim();
  if (!text || isGenerating) return;

  // 1. User Container Card
  const userCard = document.createElement('div');
  userCard.className = 'studio-card studio-card--user';
  userCard.dataset.messageText = text;
  userCard.innerHTML = `
    <div class="studio-card__body">${escapeHtml(text)}</div>
  `;
  chatHistory.appendChild(userCard);

  promptInput.value = '';
  isGenerating = true;
  updateButtonState();

  if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;

  // 2. AI Container Card with Markdown Support using the real backend stream.
  (async () => {
    const aiCard = document.createElement('div');
    aiCard.className = 'studio-card studio-card--ai';
    aiCard.innerHTML = `
      <div class="studio-card__body"></div>
    `;
    const bodyEl = aiCard.querySelector('.studio-card__body');
    chatHistory.appendChild(aiCard);

    try {
      const streamedText = await streamStudioAiResponse(bodyEl, text);
      // Persist the completed reply for later reopening of the chat.
      persistChatMessage('assistant', streamedText, studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
    } catch (error) {
      const errorText = `## Request failed\n\nThe AI studio could not reach the live backend.\n\n**Details:** ${error?.message || 'Unknown error'}`;
      bodyEl.innerHTML = parseMarkdown(errorText);
      persistChatMessage('assistant', errorText, studioModelDisplayNames[studioSelectedModel] || studioSelectedModel);
    } finally {
      isGenerating = false;
      updateButtonState();
      if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
    }
  })();
}

function initStudioPublishWorkflow() {
  const publishButton = document.getElementById('studioPublishButton');
  const modal = document.getElementById('studioPublishModal');
  const closeButton = document.getElementById('studioPublishClose');
  const cancelButton = document.getElementById('studioPublishCancel');
  const confirmButton = document.getElementById('studioPublishConfirm');
  const previewButton = document.getElementById('studioPublishPreview');
  const validation = document.getElementById('studioPublishValidation');
  const settings = document.getElementById('studioPublishSettings');
  const progress = document.getElementById('studioPublishProgress');
  const progressBar = document.getElementById('studioPublishProgressBar');
  const progressText = document.getElementById('studioPublishProgressText');
  const result = document.getElementById('studioPublishResult');
  const nameInput = document.getElementById('studioPublishName');
  const customDomainInput = document.getElementById('studioPublishCustomDomain');
  const customDomainWrap = document.getElementById('studioPublishCustomDomainWrap');
  const targetOptions = Array.from(document.querySelectorAll('.studio-publish-target-option'));
  const targetSelect = document.getElementById('studioPublishTarget');
  if (!publishButton || !modal || !confirmButton) return;

  let publishTimer = null;

  const syncPublishTargetUI = () => {
    const value = targetSelect?.value || 'kieltech-preview';
    const isCustomDomain = value === 'custom-domain';
    targetOptions.forEach((option) => {
      option.classList.toggle('is-active', option.dataset.targetValue === value);
    });
    if (customDomainWrap) customDomainWrap.hidden = !isCustomDomain;
    if (targetSelect) targetSelect.value = value;
  };

  targetOptions.forEach((button) => {
    button.addEventListener('click', () => {
      if (!targetSelect) return;
      targetSelect.value = button.dataset.targetValue || 'kieltech-preview';
      syncPublishTargetUI();
    });
  });
  targetSelect?.addEventListener('change', syncPublishTargetUI);

  const normalizeCustomDomain = (value) => {
    if (!value) return '';
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9.-]/g, '');
  };

  const closeModal = () => {
    if (publishTimer) {
      window.clearInterval(publishTimer);
      publishTimer = null;
    }
    modal.hidden = true;
    cancelButton.textContent = 'Cancel';
    confirmButton.hidden = false;
    confirmButton.disabled = false;
  };

  const normalizePackageName = (value) => String(value || 'kieltech-site')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'kieltech-site';

  const validateWorkspace = () => {
    const files = getWorkspaceFiles();
    const htmlFiles = files.filter((file) => /\.html?$/i.test(file.path));
    const hasEntry = htmlFiles.some((file) => /(^|\/)index\.html?$/i.test(file.path));
    const errors = [];
    const warnings = [];

    if (!files.length) {
      errors.push('Your workspace has no files.');
    }
    if (!hasEntry) {
      errors.push('Add an index.html file before publishing.');
    }
    if (!nameInput.value.trim()) {
      errors.push('Enter a website name.');
    }
    if (files.length > 300) {
      warnings.push('Large workspace detected; the deployment package may be bigger than expected.');
    }

    const localReferencePattern = /(?:src|href)=["']([^"']+)["']/gi;
    const seenRefs = new Set();

    files.forEach((file) => {
      if (!/\.html?$/i.test(file.path) || !file.content) return;
      const matches = [...String(file.content).matchAll(localReferencePattern)];
      matches.forEach((match) => {
        const ref = match[1].trim();
        if (!ref || ref.startsWith('#') || /^https?:\/\//i.test(ref) || /^data:/i.test(ref) || /^mailto:/i.test(ref) || /^javascript:/i.test(ref)) {
          return;
        }
        const normalized = ref.split('?')[0].split('#')[0];
        if (!normalized || normalized === '/' || normalized.startsWith('http')) return;
        if (seenRefs.has(normalized)) return;
        seenRefs.add(normalized);
        const targetExists = files.some((candidate) => candidate.path === normalized || candidate.path === normalized.replace(/^\.\//, ''));
        if (!targetExists) {
          warnings.push(`Reference not found in workspace: ${normalized}`);
        }
      });
    });

    return { files, errors, warnings };
  };

  const createPublishZip = async (projectName, files) => {
    if (!window.JSZip) {
      throw new Error('The packaging library is not available.');
    }

    const zip = new JSZip();
    const safeProjectName = normalizePackageName(projectName);
    const manifest = {
      project_name: projectName,
      generated_at: new Date().toISOString(),
      deployment_target: document.getElementById('studioPublishTarget')?.value || 'kieltech-preview',
      files: files.map((file) => ({
        path: String(file.path || '').replace(/^\/+/, ''),
        type: file.type || 'file',
        size: Number((file.content || '').length || 0)
      }))
    };

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    files.forEach((file) => {
      const filePath = String(file.path || '').replace(/^\/+/, '');
      if (!filePath) return;
      zip.file(filePath, file.content || '');
    });

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    return {
      blob,
      filename: `${safeProjectName}-publish-package.zip`
    };
  };

  const openModal = () => {
    const projectName = document.getElementById('studioNavTitle')?.textContent?.trim() || 'Untitled website';
    nameInput.value = projectName === 'Website name' || projectName === 'Untitled' ? 'Untitled website' : projectName;
    if (customDomainInput) customDomainInput.value = '';
    if (targetSelect) targetSelect.value = 'kieltech-preview';
    syncPublishTargetUI();
    validation.innerHTML = '<strong>Deployment checks</strong><span>Project validation runs before the deployment request is submitted.</span>';
    settings.hidden = false;
    progress.hidden = true;
    result.hidden = true;
    confirmButton.hidden = false;
    confirmButton.disabled = false;
    confirmButton.textContent = 'Validate & deploy';
    cancelButton.textContent = 'Cancel';
    modal.hidden = false;
  };

  publishButton.addEventListener('click', openModal);
  closeButton?.addEventListener('click', closeModal);
  cancelButton?.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  confirmButton.addEventListener('click', async () => {
    const check = validateWorkspace();
    if (check.errors.length) {
      validation.innerHTML = `<strong>Cannot publish yet</strong><ul>${check.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>`;
      return;
    }

    const websiteName = nameInput.value.trim();
    const deploymentTarget = document.getElementById('studioPublishTarget')?.value || 'kieltech-preview';
    const customDomain = normalizeCustomDomain(customDomainInput?.value || '');

    if (deploymentTarget === 'custom-domain' && !customDomain) {
      validation.innerHTML = '<strong>Custom domain required</strong><ul><li>Enter the exact custom domain for this deployment.</li></ul>';
      confirmButton.disabled = false;
      settings.hidden = false;
      progress.hidden = true;
      return;
    }

    let projectId;
    try {
      await flushStudioServerSave();
      projectId = await ensureServerStudioProject(websiteName);
      const preflight = await request(`/v1/studio/projects/${encodeURIComponent(projectId)}/deployments/preview`, {
        method: 'POST',
        body: JSON.stringify({ website_name: websiteName, deployment_target: deploymentTarget })
      });
      if (!preflight.ready) {
        validation.innerHTML = `<strong>Deployment checks found blockers</strong><ul>${(preflight.blockers || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
        return;
      }
    } catch (error) {
      validation.innerHTML = `<strong>Could not verify deployment readiness</strong><ul><li>${escapeHtml(error.message || 'The server preflight failed.')}</li></ul>`;
      return;
    }

    confirmButton.disabled = true;
    settings.hidden = true;
    progress.hidden = false;
    result.hidden = true;
    validation.innerHTML = '<strong>Deployment in progress</strong><span>Validating the project and preparing the publish request.</span>';

    const steps = [
      'Authenticating deployment request...',
      'Validating project files...',
      'Creating deployment record...',
      'Publishing to the target host...'
    ];

    let percent = 0;
    publishTimer = window.setInterval(() => {
      percent += 25;
      progressBar.style.width = `${percent}%`;
      progressText.textContent = steps[Math.min((percent / 25) - 1, steps.length - 1)];
    }, 350);

    try {
      const payload = {
        website_name: websiteName,
        deployment_target: deploymentTarget,
        custom_domain: customDomain || `${websiteName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.kieltech.app`,
        files: check.files.map((file) => ({
          path: String(file.path || '').replace(/^\/+/, ''),
          content: String(file.content || '')
        }))
      };

      const deploymentResponse = await request(`/v1/studio/projects/${encodeURIComponent(projectId)}/deployments`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      window.clearInterval(publishTimer);
      publishTimer = null;
      progressBar.style.width = '100%';
      progressText.textContent = `Deployment ${deploymentResponse.status || 'queued'}.`;
      const canonicalUrl = deploymentResponse.canonical_url || deploymentResponse.url || 'https://preview.kieltech.app';
      const providerUrl = deploymentResponse.provider_url || deploymentResponse.url || canonicalUrl;
      const deploymentLabel = deploymentTarget === 'custom-domain' ? 'Custom domain' : 'Production host';
      result.innerHTML = `
        <strong>${escapeHtml(websiteName)} deployment request queued</strong>
        <p class="studio-publish-result__meta">A versioned deployment record was created with status “${escapeHtml(deploymentResponse.status || 'queued')}”. This does not confirm that a live website was deployed; deployment execution and live status updates are not connected in this backend.</p>
        <div class="studio-publish-result__details">
          <span>Status: ${escapeHtml(deploymentResponse.status || 'queued')}</span>
          <span>Deployment target: ${escapeHtml(deploymentResponse.deployment_target || deploymentLabel)}</span>
          <span>Provider URL: <a href="${escapeHtml(providerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(providerUrl)}</a></span>
          <span>Intended URL: <a href="${escapeHtml(canonicalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(canonicalUrl)}</a></span>
        </div>
      `;
      result.hidden = false;
      confirmButton.hidden = true;
      cancelButton.textContent = 'Close';

      if (check.warnings.length) {
        validation.innerHTML = `<strong>Deployment accepted with warnings</strong><ul>${check.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`;
      }
    } catch (error) {
      if (publishTimer) {
        window.clearInterval(publishTimer);
        publishTimer = null;
      }
      progressText.textContent = 'Publish request failed.';
      validation.innerHTML = `<strong>Publishing failed</strong><ul><li>${escapeHtml(error?.message || 'Unable to submit the deployment request.')}</li></ul>`;
      confirmButton.disabled = false;
      confirmButton.hidden = false;
      confirmButton.textContent = 'Retry deployment';
      settings.hidden = false;
    }
  });

  previewButton?.addEventListener('click', async () => {
    const check = validateWorkspace();
    const websiteName = nameInput.value.trim();
    if (check.errors.length) {
      validation.innerHTML = `<strong>Deployment preview blocked</strong><ul>${check.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>`;
      return;
    }
    previewButton.disabled = true;
    validation.innerHTML = '<strong>Checking the saved project</strong><span>Validating files, local assets, and deployment configuration without submitting a deployment.</span>';
    try {
      await flushStudioServerSave();
      const projectId = await ensureServerStudioProject(websiteName);
      const payload = await request(`/v1/studio/projects/${encodeURIComponent(projectId)}/deployments/preview`, {
        method: 'POST',
        body: JSON.stringify({ website_name: websiteName, deployment_target: targetSelect?.value || 'kieltech-preview' })
      });
      const checks = (payload.checks || []).map((item) => `<li><b>${escapeHtml(item.name)}:</b> ${escapeHtml(item.status)} — ${escapeHtml(item.detail || '')}</li>`).join('');
      validation.innerHTML = `<strong>${payload.ready ? 'Deployment preflight complete' : 'Deployment preview blocked'}</strong>${payload.ready ? `<span>${Number(payload.file_count || 0)} files · ${Number(payload.total_bytes || 0).toLocaleString()} bytes. No deployment was submitted.</span>` : ''}<ul>${checks}${(payload.blockers || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    } catch (error) {
      validation.innerHTML = `<strong>Deployment preflight failed</strong><ul><li>${escapeHtml(error.message || 'Unable to validate the saved project.')}</li></ul>`;
    } finally {
      previewButton.disabled = false;
    }
  });
}

function getCookieValue(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));
  if (item) return decodeURIComponent(item.slice(prefix.length));
  try {
    return localStorage.getItem(name) || '';
  } catch (error) {
    console.warn('Unable to read saved cookie consent:', error);
    return '';
  }
}

function setCookieValue(name, value, maxAgeSeconds = 31536000) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
  try {
    localStorage.setItem(name, value);
  } catch (error) {
    console.warn('Unable to save cookie consent in local storage:', error);
  }
}

function initCookieConsent() {
  if (document.body.classList.contains('studio-app') || getCookieValue('kieltech_cookie_consent')) return;

  const banner = document.createElement('aside');
  banner.className = 'cookie-consent';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-labelledby', 'cookieConsentTitle');
  banner.setAttribute('aria-describedby', 'cookieConsentSummary');
  banner.innerHTML = `
    <div class="cookie-consent__copy">
      <strong id="cookieConsentTitle">Cookies and local storage</strong>
      <p id="cookieConsentSummary">KielTech uses essential first-party storage for secure sessions, account preferences, and site functionality. We do not load optional analytics or advertising cookies without your choice.</p>
    </div>
    <div class="cookie-consent__actions">
      <button type="button" class="cookie-consent__button cookie-consent__button--reject" data-cookie-choice="rejected">Reject</button>
      <button type="button" class="cookie-consent__button cookie-consent__button--accept" data-cookie-choice="accepted">Accept</button>
    </div>`;

  document.body.appendChild(banner);
  banner.querySelectorAll('[data-cookie-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      setCookieValue('kieltech_cookie_consent', button.dataset.cookieChoice);
      banner.remove();
    });
  });
}

function enhanceMarkdownHtml(html) {
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\^([A-Za-z0-9]+)\^/g, '<sup>$1</sup>');
  html = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)(?=\s|$)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  html = html.replace(/\[!NOTE\]\s*([^\n]+)/gi, '<div class="kiel-chat-callout">$1</div>');
  html = html.replace(/\[!WARNING\]\s*([^\n]+)/gi, '<div class="kiel-chat-callout kiel-chat-callout--warning">$1</div>');
  html = html.replace(/\[!TIP\]\s*([^\n]+)/gi, '<div class="kiel-chat-callout kiel-chat-callout--tip">$1</div>');
  html = html.replace(/^\s*([^\n:<]+):[ \t]+([^\n]+)$/gim, '<dl class="kiel-chat-definition"><dt>$1</dt><dd>$2</dd></dl>');
  html = html.replace(/\[kbd:([^\]]+)\]/gi, '<kbd>$1</kbd>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/(?<![\\*])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/^\s*---+\s*$/gim, '<hr>');
  html = html.replace(/((?:^|\n)\s*&gt;\s?.+(?:\n\s*&gt;\s?.+)*)/gim, (block) => `<blockquote>${block.replace(/^\s*&gt;\s?/gim, '').replace(/\n/g, '<br>')}</blockquote>`);
  html = html.replace(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gim, (_, state, text) => `<li class="kiel-chat-task${state.toLowerCase() === 'x' ? ' is-complete' : ''}"><input type="checkbox" disabled${state.toLowerCase() === 'x' ? ' checked' : ''}>${text}</li>`);
  html = html.replace(/((?:<li class="kiel-chat-task[^>]*>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>');
  return html;
}

function renderBareMath(html) {
  html = html.replace(/\\+begin\{(?:pmatrix|bmatrix|matrix)\}([\s\S]*?)\\+end\{(?:pmatrix|bmatrix|matrix)\}/g, (_, value) => {
    const rows = value.split(/\\\\|\n/).map((row) => row.trim()).filter(Boolean);
    return `<table class="kiel-chat-matrix" role="presentation">${rows.map((row) => `<tr>${row.split(/&(?:amp;)?/).map((cell) => `<td>${cell.replace(/\\+$/, '').trim()}</td>`).join('')}</tr>`).join('')}</table>`;
  });
  html = html.replace(/\\+mathbf\{([^{}]+)\}/g, '<strong>$1</strong>');
  html = html.replace(/\\(?:mathrm|text)\{([^{}]+)\}/g, '$1');
  html = html.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="kiel-chat-math__fraction"><span>$1</span><span>$2</span></span>');
  html = html.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
  html = html.replace(/\^([+-]?\d+|[A-Za-z])/g, '<sup>$1</sup>');
  return html;
}

function renderScienceNotation(html) {
  html = html.replace(/ε_0/g, 'ε₀').replace(/μ_0/g, 'μ₀');
  const physics = [
    ['\\hbar', 'ℏ'], ['\\nabla', '∇'], ['\\partial', '∂'], ['\\Delta', 'Δ'], ['\\Omega', 'Ω'],
    ['\\Phi', 'Φ'], ['\\Psi', 'Ψ'], ['\\chi', 'χ'], ['\\rho', 'ρ'], ['\\nu', 'ν'],
    ['\\epsilon', 'ε'], ['\\varepsilon', 'ϵ'], ['\\ell', 'ℓ'], ['\\Re', 'ℜ'], ['\\Im', 'ℑ'],
    ['\\cross', '×'], ['\\perp', '⊥'], ['\\angle', '∠'], ['\\degree', '°'], ['\\propto', '∝'],
    ['\\approx', '≈'], ['\\equiv', '≡'], ['\\epsilon_0', 'ε₀'], ['\\mu_0', 'μ₀'], ['k_B', 'kᵦ'],
    ['m_e', 'mₑ'], ['m_p', 'mₚ'], ['eV', 'eV'], ['Hz', 'Hz'], ['N', 'N'],
    ['J', 'J'], ['W', 'W'], ['Pa', 'Pa'], ['C', 'C'], ['T', 'T']
  ];
  physics.forEach(([source, target]) => {
    html = html.replace(new RegExp(source.replace(/[\\]/g, '\\\\') + '(?![A-Za-z])', 'g'), `<span class="kiel-chat-science">${target}</span>`);
  });
  html = html.replace(/(<span class="kiel-chat-science">)ε(<\/span>)_0/g, '$1ε₀$2').replace(/(<span class="kiel-chat-science">)μ(<\/span>)_0/g, '$1μ₀$2');
  html = html.replace(/\\vec\{([^{}]+)\}/g, '<span class="kiel-chat-vector">$1</span>');
  html = html.replace(/\\mathbf\{([^{}]+)\}/g, '<strong>$1</strong>');
  html = html.replace(/\\mathrm\{([^{}]+)\}/g, '<span class="kiel-chat-unit">$1</span>');
  html = html.replace(/\\unit\{([^{}]+)\}/g, '<span class="kiel-chat-unit">$1</span>');

  const chemistry = (value) => value
    .replace(/\\rightarrow|\\to|-&gt;|=&gt;/g, '<span class="kiel-chat-reaction">→</span>')
    .replace(/\\rightleftharpoons/g, '<span class="kiel-chat-reaction">⇌</span>')
    .replace(/\\leftrightarrow|&lt;-&gt;/g, '<span class="kiel-chat-reaction">↔</span>')
    .replace(/\\uparrow/g, '↑').replace(/\\downarrow/g, '↓')
    .replace(/\\Delta/g, 'Δ').replace(/\\cdot/g, '·')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>')
    .replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>')
    .replace(/\^([+-]\d*|\d+[+-])/g, '<sup>$1</sup>')
    .replace(/_([A-Za-z0-9]+)/g, '<sub>$1</sub>')
    .replace(/([A-Z][a-z]?)(\d+)/g, '$1<sub>$2</sub>')
    .replace(/\)(\d+)/g, ')<sub>$1</sub>');
  html = html.replace(/\\ce\{([^{}]+)\}/g, (_, value) => `<span class="kiel-chat-chem">${chemistry(value)}</span>`);
  html = html.replace(/\\chem\{([^{}]+)\}/g, (_, value) => `<span class="kiel-chat-chem">${chemistry(value)}</span>`);
  html = html.replace(/\b(pH|pKa|Ka|Kb|Ksp|mol|M|atm|ppm)\b/g, '<span class="kiel-chat-unit">$1</span>');
  return html;
}

function renderSimpleMath(html) {
  const expression = (value) => value
    .replace(/\\mathbb\{R\}/g, 'ℝ').replace(/\\mathbb\{N\}/g, 'ℕ').replace(/\\mathbb\{Z\}/g, 'ℤ').replace(/\\mathbb\{Q\}/g, 'ℚ').replace(/\\mathbb\{C\}/g, 'ℂ')
    .replace(/\\text\{([^{}]+)\}/g, '<span class="kiel-chat-math__text">$1</span>')
    .replace(/\\sqrt\{([^{}]+)\}/g, '<span class="kiel-chat-math__sqrt">√<span>($1)</span></span>')
    .replace(/\\sqrt\[(\d+)\]\{([^{}]+)\}/g, '<span class="kiel-chat-math__root"><sup>$1</sup>√<span>($2)</span></span>')
    .replace(/\\(?:dfrac|tfrac|frac)\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="kiel-chat-math__fraction"><span>$1</span><span>$2</span></span>')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[,:;]/g, ' ')
    .replace(/\\sum(?=[^A-Za-z]|$)/g, '∑')
    .replace(/\\prod(?=[^A-Za-z]|$)/g, '∏')
    .replace(/\\int(?=[^A-Za-z]|$)/g, '∫')
    .replace(/\\infty\b/g, '∞')
    .replace(/\\rightarrow\b|\\to\b/g, '→')
    .replace(/\\Rightarrow\b/g, '⇒')
    .replace(/\\in(?=[^A-Za-z]|$)/g, '∈')
    .replace(/\\notin(?=[^A-Za-z]|$)/g, '∉')
    .replace(/\\subseteq\b/g, '⊆')
    .replace(/\\subset\b/g, '⊂')
    .replace(/\\cup\b/g, '∪')
    .replace(/\\cap\b/g, '∩')
    .replace(/\\pm\b/g, '±')
    .replace(/\\pi\b/g, 'π')
    .replace(/\\theta\b/g, 'θ')
    .replace(/\\alpha\b/g, 'α')
    .replace(/\\beta\b/g, 'β')
    .replace(/\\gamma\b/g, 'γ')
    .replace(/\\delta\b/g, 'δ')
    .replace(/\\lambda\b/g, 'λ')
    .replace(/\\mu\b/g, 'μ')
    .replace(/\\sigma\b/g, 'σ')
    .replace(/\\omega\b/g, 'ω')
    .replace(/\\times\b/g, '×')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\equiv\b/g, '≡')
    .replace(/\\circ\b/g, '°')
    .replace(/\\degree\b/g, '°')
    .replace(/\\ne\b|\\neq\b/g, '≠')
    .replace(/\\leq\b/g, '≤')
    .replace(/\\geq\b/g, '≥')
    .replace(/\\sin\b/g, '<span class="kiel-chat-math__operator">sin</span>')
    .replace(/\\cos\b/g, '<span class="kiel-chat-math__operator">cos</span>')
    .replace(/\\tan\b/g, '<span class="kiel-chat-math__operator">tan</span>')
    .replace(/\\log\b/g, '<span class="kiel-chat-math__operator">log</span>')
    .replace(/\\ln\b/g, '<span class="kiel-chat-math__operator">ln</span>')
    .replace(/\\exp\b/g, '<span class="kiel-chat-math__operator">exp</span>')
    .replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>')
    .replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>')
    .replace(/\^([A-Za-z0-9°])/g, '<sup>$1</sup>');
  return html
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, value) => `<span class="kiel-chat-math kiel-chat-math--display">${expression(value.trim())}</span>`)
    .replace(/\\\((.*?)\\\)/g, (_, value) => `<span class="kiel-chat-math">${expression(value.trim())}</span>`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, value) => `<span class="kiel-chat-math kiel-chat-math--display">${expression(value.trim())}</span>`)
    .replace(/\$([^$\n]+)\$/g, (_, value) => `<span class="kiel-chat-math">${expression(value.trim())}</span>`);
}