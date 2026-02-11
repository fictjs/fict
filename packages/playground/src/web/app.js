/* global document, window, URL, HTMLElement, clearTimeout, setTimeout, navigator, history, TextEncoder, fetch, console, getComputedStyle, matchMedia */

// ---- State ----
const state = {
  templates: [],
  session: null,
  currentFilePath: '',
  diagnostics: null,
  verification: null,
  authToken: '',
  artifacts: [],
  selectedArtifactPath: '',
  saveTimer: null,
  diagnosticsTimer: null,
  diagnosticsInFlight: false,
  diagnosticsQueued: false,
  previewRefreshNonce: 0,
  saving: false,
  busy: false,
  lastStatus: 'idle',
}

const elements = {}

// ---- CodeMirror state ----
let cm = null
let editorView = null
let langCompartment = null

// ---- Toast system ----
const toastContainer = (() => {
  const el = document.createElement('div')
  el.className = 'toast-container'
  document.body.appendChild(el)
  return el
})()

const TOAST_ICONS = {
  success: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="var(--ok)" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.5 9 13l5-6"/></svg>`,
  error: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="var(--danger)" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M7 7l6 6M13 7l-6 6"/></svg>`,
  warning: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="var(--warn)" stroke-width="2"><path d="M10 3 1.5 17.5h17z"/><path d="M10 8v4M10 14.5v.5"/></svg>`,
  info: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="var(--brand-2)" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.5v.5"/></svg>`,
}

function showToast(type, title, message, durationMs = 4000) {
  while (toastContainer.children.length >= 5) {
    toastContainer.firstChild.remove()
  }

  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.innerHTML = `
    ${TOAST_ICONS[type] || TOAST_ICONS.info}
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast-close" aria-label="Dismiss">&times;</button>
  `

  const dismiss = () => {
    el.classList.add('toast-exit')
    el.addEventListener('animationend', () => el.remove(), { once: true })
  }

  el.querySelector('.toast-close').addEventListener('click', dismiss)
  toastContainer.appendChild(el)

  if (durationMs > 0) {
    setTimeout(dismiss, durationMs)
  }

  return el
}

// ---- Modal system ----
function showModal({ title, body, inputLabel, inputDefault, confirmText, cancelText, danger }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'

    const hasInput = typeof inputLabel === 'string'
    const confirmStyle = danger ? ' style="background: var(--danger)"' : ''

    overlay.innerHTML = `
      <div class="modal-card">
        <h3>${escapeHtml(title)}</h3>
        ${body ? `<p>${escapeHtml(body)}</p>` : ''}
        ${hasInput ? `<label><span class="muted">${escapeHtml(inputLabel)}</span><input type="text" id="modal-input" value="${escapeAttr(inputDefault || '')}" /></label>` : ''}
        <div class="modal-actions">
          <button type="button" class="ghost" data-modal-action="cancel">${escapeHtml(cancelText || 'Cancel')}</button>
          <button type="button"${confirmStyle} data-modal-action="confirm">${escapeHtml(confirmText || 'OK')}</button>
        </div>
      </div>
    `

    const close = value => {
      document.removeEventListener('keydown', onKeydown)
      overlay.remove()
      resolve(value)
    }

    overlay
      .querySelector('[data-modal-action="cancel"]')
      .addEventListener('click', () => close(null))
    overlay.querySelector('[data-modal-action="confirm"]').addEventListener('click', () => {
      if (hasInput) {
        close(overlay.querySelector('#modal-input').value)
      } else {
        close(true)
      }
    })

    const onKeydown = event => {
      if (event.key === 'Escape') {
        close(null)
      }
      if (event.key === 'Enter' && hasInput) {
        close(overlay.querySelector('#modal-input').value)
      }
    }
    document.addEventListener('keydown', onKeydown)

    overlay.addEventListener('click', event => {
      if (event.target === overlay) close(null)
    })

    document.body.appendChild(overlay)

    if (hasInput) {
      const input = overlay.querySelector('#modal-input')
      input.focus()
      input.select()
    } else {
      overlay.querySelector('[data-modal-action="confirm"]').focus()
    }
  })
}

// ---- CodeMirror loading ----
// esm.sh's `codemirror` bundle does not re-export every low-level symbol
// (e.g. keymap, EditorState, Compartment), so load state/view modules directly.
async function loadCodeMirror() {
  const [cmMod, stateMod, viewMod, jsLangMod, cssLangMod, jsonLangMod] = await Promise.all([
    import('https://esm.sh/codemirror@6.0.1'),
    import('https://esm.sh/@codemirror/state@^6.0.0?target=es2022'),
    import('https://esm.sh/@codemirror/view@^6.0.0?target=es2022'),
    import('https://esm.sh/@codemirror/lang-javascript@6.2.3'),
    import('https://esm.sh/@codemirror/lang-css@6.3.1'),
    import('https://esm.sh/@codemirror/lang-json@6.0.1'),
  ])

  const modules = {
    EditorView: cmMod.EditorView ?? viewMod.EditorView,
    keymap: cmMod.keymap ?? viewMod.keymap,
    basicSetup: cmMod.basicSetup,
    EditorState: cmMod.EditorState ?? stateMod.EditorState,
    Compartment: cmMod.Compartment ?? stateMod.Compartment,
    javascript: jsLangMod.javascript,
    cssLang: cssLangMod.css,
    jsonLang: jsonLangMod.json,
  }

  if (
    !modules.EditorView ||
    !modules.keymap ||
    !modules.basicSetup ||
    !modules.EditorState ||
    !modules.Compartment
  ) {
    throw new Error('CodeMirror modules are incomplete')
  }

  return modules
}

// ---- Main ----
main().catch(error => {
  console.error(error)
  document.getElementById('app').innerHTML =
    `<pre>Failed to initialize playground: ${escapeHtml(String(error))}</pre>`
})

async function main() {
  renderLayout()
  bindStaticListeners()
  bindKeyboardShortcuts()
  bindResizeHandles()

  state.authToken = new URL(window.location.href).searchParams.get('token') || ''

  // Start loading CodeMirror immediately (non-blocking)
  const cmReady = loadCodeMirror()
    .then(modules => {
      cm = modules
    })
    .catch(err => {
      console.error('CodeMirror failed to load, falling back to textarea', err)
      showToast('warning', 'Editor loading failed', 'Using plain text editor as fallback.')
    })

  const templates = await fetchJson('/api/templates')
  state.templates = Array.isArray(templates.templates) ? templates.templates : []
  renderTemplateList()

  const shareToken = new URL(window.location.href).searchParams.get('share')
  if (shareToken) {
    await importSharedSession(shareToken)
  } else {
    const defaultTemplate = state.templates[0]
    await createSession(defaultTemplate ? defaultTemplate.id : 'counter')
  }

  // Wait for CodeMirror and initialize editor
  await cmReady
  initCodeMirrorEditor()
}

// ---- Layout ----
function renderLayout() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="layout">
      <header class="topbar">
        <div>
          <h1>Fict Playground Workbench</h1>
          <div class="meta" id="session-meta">No session</div>
        </div>
        <div class="topbar-actions">
          <button id="btn-run-diagnostics" title="Cmd+Enter">Run Diagnostics</button>
          <button id="btn-run-verify" title="Cmd+Shift+Enter">Verify (Full)</button>
          <button id="btn-share" class="ghost" title="Cmd+Shift+S">Share</button>
          <button id="btn-import" class="ghost">Import</button>
          <button id="btn-reset" class="ghost">New Session</button>
        </div>
      </header>
      <main class="board" id="board">
        <section class="panel" aria-label="controls">
          <div class="panel-header">
            <h2>Templates</h2>
          </div>
          <div id="template-list" class="template-list"></div>

          <div class="panel-header">
            <h3>Config</h3>
          </div>
          <div class="controls-grid">
            <label>
              <span class="muted">Profile</span>
              <select id="profile-select">
                <option value="app-default">App Default</option>
                <option value="ci-hard-gate">CI Hard Gate</option>
                <option value="migration">Migration</option>
              </select>
            </label>
            <div class="control-row">
              <div class="control-label">
                <span>strictGuarantee</span>
                <span class="muted">Enforce strict signal guarantees</span>
              </div>
              <button type="button" class="switch" data-config-key="strictGuarantee" aria-label="strictGuarantee"></button>
            </div>
            <div class="control-row">
              <div class="control-label">
                <span>strictReactivity</span>
                <span class="muted">Require explicit reactive bindings</span>
              </div>
              <button type="button" class="switch" data-config-key="strictReactivity" aria-label="strictReactivity"></button>
            </div>
            <div class="control-row">
              <div class="control-label">
                <span>lazyConditional</span>
                <span class="muted">Defer conditional branch evaluation</span>
              </div>
              <button type="button" class="switch" data-config-key="lazyConditional" aria-label="lazyConditional"></button>
            </div>
            <div class="control-row">
              <div class="control-label">
                <span>resumable</span>
                <span class="muted">Enable resumable component hydration</span>
              </div>
              <button type="button" class="switch" data-config-key="resumable" aria-label="resumable"></button>
            </div>
            <div class="control-row">
              <div class="control-label">
                <span>functionSplitting</span>
                <span class="muted">Split event handlers for lazy loading</span>
              </div>
              <button type="button" class="switch" data-config-key="functionSplitting" aria-label="functionSplitting"></button>
            </div>
            <div class="control-row">
              <div class="control-label">
                <span>devtools</span>
                <span class="muted">Enable devtools integration</span>
              </div>
              <button type="button" class="switch" data-config-key="devtools" aria-label="devtools"></button>
            </div>
          </div>

          <div class="panel-header">
            <h3>Files</h3>
            <div class="inline-row">
              <button id="btn-add-file" class="ghost" title="Cmd+N">Add</button>
            </div>
          </div>
          <div id="file-list" class="file-list"></div>
        </section>

        <div class="resize-handle" data-resize="left" aria-label="Resize left panel"></div>

        <section class="panel" aria-label="editor">
          <div class="editor-header">
            <div>
              <h2 id="editor-title">Editor</h2>
              <div class="muted" id="editor-path"></div>
            </div>
            <div class="editor-actions">
              <button id="btn-save-file" class="ghost" title="Cmd+S">Save</button>
            </div>
          </div>
          <div id="cm-editor-mount" class="cm-editor-mount"></div>
          <div id="editor-status" class="status">Idle</div>
        </section>

        <div class="resize-handle" data-resize="right" aria-label="Resize right panel"></div>

        <section class="panel" aria-label="preview diagnostics">
          <div class="panel-header">
            <h2>Preview</h2>
            <a id="preview-link" href="#" target="_blank" rel="noreferrer noopener">Open</a>
          </div>
          <iframe id="preview-frame" class="preview-frame" title="Playground preview"></iframe>

          <div class="tabs">
            <button id="tab-diagnostics" class="active">Diagnostics</button>
            <button id="tab-artifacts">Artifacts</button>
            <button id="tab-verify">Verify</button>
          </div>

          <div id="panel-diagnostics" class="tab-panel tab-visible">
            <div class="inline-row">
              <div id="diagnostics-summary" class="status">No diagnostics yet</div>
            </div>
            <div id="diagnostics-list" class="diagnostics-list"></div>
          </div>

          <div id="panel-artifacts" class="tab-panel">
            <div id="artifact-list" class="artifact-list"></div>
            <pre id="artifact-viewer" class="code-viewer"></pre>
          </div>

          <div id="panel-verify" class="tab-panel">
            <div id="verify-summary" class="status">No verification run yet</div>
            <pre id="verify-viewer" class="code-viewer"></pre>
          </div>
        </section>
      </main>
    </div>
  `

  elements.sessionMeta = byId('session-meta')
  elements.templateList = byId('template-list')
  elements.fileList = byId('file-list')
  elements.profileSelect = byId('profile-select')
  elements.editorTitle = byId('editor-title')
  elements.editorPath = byId('editor-path')
  elements.editorMount = byId('cm-editor-mount')
  elements.editorStatus = byId('editor-status')
  elements.previewFrame = byId('preview-frame')
  elements.previewLink = byId('preview-link')
  elements.diagnosticsSummary = byId('diagnostics-summary')
  elements.diagnosticsList = byId('diagnostics-list')
  elements.artifactList = byId('artifact-list')
  elements.artifactViewer = byId('artifact-viewer')
  elements.panelDiagnostics = byId('panel-diagnostics')
  elements.panelArtifacts = byId('panel-artifacts')
  elements.tabDiagnostics = byId('tab-diagnostics')
  elements.tabArtifacts = byId('tab-artifacts')
  elements.tabVerify = byId('tab-verify')
  elements.panelVerify = byId('panel-verify')
  elements.verifySummary = byId('verify-summary')
  elements.verifyViewer = byId('verify-viewer')
}

function bindStaticListeners() {
  byId('btn-run-diagnostics').addEventListener('click', () => {
    void runDiagnostics()
  })
  byId('btn-run-verify').addEventListener('click', () => {
    void runVerification()
  })

  byId('btn-share').addEventListener('click', () => {
    void shareSession()
  })

  byId('btn-import').addEventListener('click', () => {
    void promptImport()
  })

  byId('btn-reset').addEventListener('click', () => {
    const activeTemplate = state.session?.templateId ?? state.templates[0]?.id
    void createSession(activeTemplate)
  })

  byId('btn-add-file').addEventListener('click', () => {
    void addFile()
  })

  byId('btn-save-file').addEventListener('click', () => {
    void saveCurrentFile()
  })

  elements.profileSelect.addEventListener('change', () => {
    const value = elements.profileSelect.value
    void updateConfig({ profile: value })
  })

  document.addEventListener('click', async event => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const templateId =
      target.dataset.templateId || target.closest('[data-template-id]')?.dataset.templateId
    if (templateId) {
      if (state.session && state.lastStatus === 'dirty') {
        const proceed = await showModal({
          title: 'Unsaved changes',
          body: 'Switching templates will discard your current work. Continue?',
          confirmText: 'Switch',
          danger: true,
        })
        if (!proceed) return
      }
      void createSession(templateId)
      return
    }

    const filePath = target.dataset.filePath || target.closest('[data-file-path]')?.dataset.filePath
    if (
      filePath &&
      target.dataset.action !== 'delete-file' &&
      !target.closest('[data-action="delete-file"]')
    ) {
      selectFile(filePath)
      return
    }

    const deleteTarget = target.closest('[data-action="delete-file"]')
    if (deleteTarget) {
      const deletePath = deleteTarget.dataset.filePath
      if (deletePath) {
        event.stopPropagation()
        void deleteFile(deletePath)
      }
      return
    }

    const artifactPath =
      target.dataset.artifactPath || target.closest('[data-artifact-path]')?.dataset.artifactPath
    if (artifactPath) {
      selectArtifact(artifactPath)
      return
    }

    const configKey = target.dataset.configKey
    if (configKey && state.session) {
      const currentValue = !!state.session.config[configKey]
      void updateConfig({ [configKey]: !currentValue })
      return
    }

    const diagnosticIndexRaw =
      target.dataset.diagnosticIndex ||
      target.closest('[data-diagnostic-index]')?.dataset.diagnosticIndex
    if (diagnosticIndexRaw) {
      const index = Number(diagnosticIndexRaw)
      const diagnostic = state.diagnostics?.diagnostics?.[index]
      if (diagnostic?.filePath) {
        openDiagnostic(diagnostic)
      }
    }
  })

  elements.tabDiagnostics.addEventListener('click', () => setActiveTab('diagnostics'))
  elements.tabArtifacts.addEventListener('click', () => setActiveTab('artifacts'))
  elements.tabVerify.addEventListener('click', () => setActiveTab('verify'))
}

// ---- Keyboard shortcuts ----
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', event => {
    // Suppress shortcuts when modal is open
    if (document.querySelector('.modal-overlay')) return

    const mod = event.metaKey || event.ctrlKey

    if (mod && event.key === 's' && !event.shiftKey) {
      event.preventDefault()
      void saveCurrentFile()
      return
    }

    if (mod && event.key === 's' && event.shiftKey) {
      event.preventDefault()
      void shareSession()
      return
    }

    if (mod && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void runDiagnostics()
      return
    }

    if (mod && event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      void runVerification()
      return
    }

    if (mod && event.key === 'n') {
      event.preventDefault()
      void addFile()
    }
  })
}

// ---- Resize handles ----
function bindResizeHandles() {
  const board = document.getElementById('board')
  if (!board) return

  const handles = board.querySelectorAll('.resize-handle')
  const minPanelWidth = 200

  handles.forEach(handle => {
    let startX = 0
    let startWidths = [0, 0]

    const onPointerMove = event => {
      const dx = event.clientX - startX
      const cols = board.style.gridTemplateColumns.split(/\s+/)

      if (handle.dataset.resize === 'left') {
        const newLeft = Math.max(minPanelWidth, startWidths[0] + dx)
        cols[0] = `${newLeft}px`
      } else {
        const newRight = Math.max(minPanelWidth, startWidths[1] - dx)
        cols[4] = `${newRight}px`
      }

      board.style.gridTemplateColumns = cols.join(' ')
    }

    const onPointerUp = () => {
      handle.classList.remove('dragging')
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    handle.addEventListener('pointerdown', event => {
      event.preventDefault()
      startX = event.clientX

      const computedCols = getComputedStyle(board).gridTemplateColumns.split(/\s+/)
      startWidths = [parseFloat(computedCols[0]), parseFloat(computedCols[4])]

      board.style.gridTemplateColumns = computedCols
        .map((val, i) => {
          if (i === 0 || i === 4) return `${parseFloat(val)}px`
          if (i === 1 || i === 3) return '6px'
          return '1fr'
        })
        .join(' ')

      handle.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
    })
  })

  // Reset inline styles when crossing responsive breakpoint
  const mql = matchMedia('(max-width: 1280px)')
  mql.addEventListener('change', () => {
    board.style.gridTemplateColumns = ''
  })
}

// ---- CodeMirror editor ----
function langExtensionForPath(filePath) {
  if (!cm) return []
  if (/\.[jt]sx?$/.test(filePath)) {
    return [cm.javascript({ jsx: true, typescript: /\.tsx?$/.test(filePath) })]
  }
  if (filePath.endsWith('.css')) return [cm.cssLang()]
  if (filePath.endsWith('.json')) return [cm.jsonLang()]
  return []
}

function createFictTheme() {
  return cm.EditorView.theme(
    {
      '&': {
        fontSize: '13px',
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      },
      '.cm-content': {
        lineHeight: '1.52',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--panel-2)',
        borderRight: '1px solid var(--line)',
        color: 'var(--ink-muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(206, 75, 37, 0.08)',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(206, 75, 37, 0.04)',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: 'var(--brand)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'rgba(206, 75, 37, 0.12)',
      },
      '.cm-scroller': {
        overflow: 'auto',
      },
    },
    { dark: false },
  )
}

function initCodeMirrorEditor() {
  if (!cm || !elements.editorMount) return

  langCompartment = new cm.Compartment()
  const content = state.session?.files[state.currentFilePath] ?? ''

  editorView = new cm.EditorView({
    state: cm.EditorState.create({
      doc: content,
      extensions: [
        cm.basicSetup,
        createFictTheme(),
        langCompartment.of(langExtensionForPath(state.currentFilePath)),
        cm.EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onEditorContentChanged(update.state.doc.toString())
          }
        }),
        cm.keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void saveCurrentFile()
              return true
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              void runDiagnostics()
              return true
            },
          },
          {
            key: 'Mod-Shift-Enter',
            run: () => {
              void runVerification()
              return true
            },
          },
        ]),
      ],
    }),
    parent: elements.editorMount,
  })
}

function onEditorContentChanged(content) {
  const session = state.session
  const filePath = state.currentFilePath
  if (!session || !filePath) return

  session.files[filePath] = content
  invalidateVerification()
  updateEditorStatus('dirty')
  scheduleSave()
}

// ---- Session management ----
async function createSession(templateId) {
  if (!templateId) return
  setBusy(true)
  try {
    const response = await fetchJson('/api/sessions', {
      method: 'POST',
      body: { templateId },
    })
    state.diagnostics = null
    state.verification = null
    state.artifacts = []
    state.selectedArtifactPath = ''
    hydrateSession(response.session)
    setActiveTab('diagnostics')
    renderDiagnostics()
    renderArtifacts()
    renderVerification()
    updateEditorStatus('idle')
  } catch (error) {
    showToast('error', 'Session creation failed', String(error))
  } finally {
    setBusy(false)
  }
}

async function importSharedSession(token) {
  setBusy(true)
  try {
    const response = await fetchJson('/api/import', {
      method: 'POST',
      body: { token },
    })
    state.verification = null
    hydrateSession(response.session)
    await runDiagnostics()
  } catch (error) {
    showToast('error', 'Import failed', String(error))
    const defaultTemplate = state.templates[0]
    await createSession(defaultTemplate ? defaultTemplate.id : 'counter')
  } finally {
    setBusy(false)
  }
}

function hydrateSession(session) {
  const previousSession = state.session
  state.session = session
  if (
    !previousSession ||
    previousSession.id !== session.id ||
    previousSession.previewUrl !== session.previewUrl
  ) {
    state.previewRefreshNonce = 0
  }
  const filePaths = Object.keys(session.files || {}).sort((a, b) => a.localeCompare(b))
  if (!filePaths.includes(state.currentFilePath)) {
    state.currentFilePath = filePaths.includes(session.entryFile)
      ? session.entryFile
      : filePaths[0] || ''
  }

  renderTemplateList()
  renderSessionMeta()
  renderConfig()
  renderFileList()
  renderEditor()
  renderPreview()
  renderVerification()
}

function renderSessionMeta() {
  const session = state.session
  if (!session) {
    elements.sessionMeta.textContent = 'No session'
    return
  }

  const config = session.config
  elements.sessionMeta.textContent = `session ${session.id} \u00b7 ${session.templateId} \u00b7 profile=${config.profile} \u00b7 strictGuarantee=${config.strictGuarantee}`
}

function renderTemplateList() {
  const currentTemplate = state.session?.templateId
  elements.templateList.innerHTML = state.templates
    .map(template => {
      const activeClass = template.id === currentTemplate ? 'template-item active' : 'template-item'
      return `
        <article class="${activeClass}">
          <button type="button" data-template-id="${escapeAttr(template.id)}">
            <strong>${escapeHtml(template.name)}</strong>
            <div class="muted">${escapeHtml(template.description)}</div>
          </button>
        </article>
      `
    })
    .join('')
}

function renderConfig() {
  const session = state.session
  if (!session) return

  elements.profileSelect.value = session.config.profile

  const buttons = document.querySelectorAll('[data-config-key]')
  for (const button of buttons) {
    const key = button.getAttribute('data-config-key')
    if (!key) continue
    const enabled = !!session.config[key]
    button.classList.toggle('on', enabled)
    button.setAttribute('aria-pressed', String(enabled))
    button.textContent = enabled ? 'ON' : 'OFF'
  }
}

// ---- File type icons ----
function fileTypeIcon(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const colors = {
    tsx: '#3178c6',
    ts: '#3178c6',
    jsx: '#f7df1e',
    js: '#f7df1e',
    css: '#264de4',
    json: '#5b5b5b',
    html: '#e34c26',
  }
  const labels = {
    tsx: 'TSX',
    ts: 'TS',
    jsx: 'JSX',
    js: 'JS',
    css: 'CSS',
    json: '{}',
    html: 'HTML',
  }
  const color = colors[ext] || 'var(--ink-muted)'
  const label = labels[ext] || (ext ? ext.toUpperCase() : '?')

  return `<span class="file-type-badge" style="--badge-color: ${color}">${escapeHtml(label)}</span>`
}

function renderFileList() {
  const session = state.session
  if (!session) {
    elements.fileList.innerHTML = ''
    return
  }

  const filePaths = Object.keys(session.files).sort((a, b) => a.localeCompare(b))
  elements.fileList.innerHTML = filePaths
    .map(filePath => {
      const activeClass = filePath === state.currentFilePath ? 'file-item active' : 'file-item'
      return `
        <article class="${activeClass}">
          <button type="button" data-file-path="${escapeAttr(filePath)}">
            <span class="file-name-group">
              ${fileTypeIcon(filePath)}
              <span>${escapeHtml(filePath)}</span>
            </span>
            <span class="inline-row">
              <span class="muted">${estimateFileSize(session.files[filePath])}</span>
              <span data-action="delete-file" data-file-path="${escapeAttr(filePath)}" title="Delete file" class="file-delete-btn">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h11M5.5 4V2.5h5V4M6.5 7v4.5M9.5 7v4.5M3.5 4l.75 9.5h7.5L12.5 4"/></svg>
              </span>
            </span>
          </button>
        </article>
      `
    })
    .join('')
}

function renderEditor() {
  const session = state.session
  const filePath = state.currentFilePath

  if (!session || !filePath) {
    elements.editorTitle.textContent = 'Editor'
    elements.editorPath.textContent = ''
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: '' },
      })
    }
    return
  }

  elements.editorTitle.textContent = fileNameOf(filePath)
  elements.editorPath.textContent = filePath

  const content = session.files[filePath] ?? ''

  if (editorView) {
    // Skip if content is identical (prevents cursor jump on save)
    if (editorView.state.doc.toString() !== content) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: content },
      })
    }
    // Update language extension for new file type
    if (langCompartment && cm) {
      editorView.dispatch({
        effects: langCompartment.reconfigure(langExtensionForPath(filePath)),
      })
    }
  } else if (cm) {
    initCodeMirrorEditor()
  }
}

function renderPreview() {
  const session = state.session
  if (!session) {
    elements.previewFrame.src = 'about:blank'
    elements.previewLink.href = '#'
    return
  }

  elements.previewFrame.src = toPreviewFrameUrl(session.previewUrl)
  elements.previewLink.href = session.previewUrl
  elements.previewLink.textContent = session.previewUrl
}

function toPreviewFrameUrl(previewUrl) {
  if (!state.previewRefreshNonce) return previewUrl
  try {
    const url = new URL(previewUrl, window.location.href)
    url.searchParams.set('__refresh', String(state.previewRefreshNonce))
    return url.toString()
  } catch {
    const separator = previewUrl.includes('?') ? '&' : '?'
    return `${previewUrl}${separator}__refresh=${state.previewRefreshNonce}`
  }
}

function forcePreviewRefresh() {
  state.previewRefreshNonce = Date.now()
}

// ---- Diagnostics ----
async function runDiagnostics(options = {}) {
  if (!state.session) return

  const background = options.background === true

  if (state.diagnosticsTimer) {
    clearTimeout(state.diagnosticsTimer)
    state.diagnosticsTimer = null
  }

  if (state.diagnosticsInFlight) {
    state.diagnosticsQueued = true
    return
  }

  state.diagnosticsInFlight = true
  if (!background) {
    setBusy(true)
  }
  try {
    const result = await fetchJson(`/api/sessions/${state.session.id}/diagnostics`, {
      method: 'POST',
    })
    state.diagnostics = result
    state.artifacts = result.artifacts || []
    if (!state.selectedArtifactPath && state.artifacts.length > 0) {
      state.selectedArtifactPath = state.artifacts[0].filePath
    }
    renderDiagnostics()
    renderArtifacts()
  } catch (error) {
    showToast('error', 'Diagnostics failed', String(error))
  } finally {
    state.diagnosticsInFlight = false
    if (!background) {
      setBusy(false)
    }
    if (state.diagnosticsQueued) {
      state.diagnosticsQueued = false
      void runDiagnostics({ background: true })
    }
  }
}

function scheduleDiagnostics() {
  if (state.diagnosticsTimer) {
    clearTimeout(state.diagnosticsTimer)
  }

  state.diagnosticsTimer = setTimeout(() => {
    state.diagnosticsTimer = null
    void runDiagnostics({ background: true })
  }, 800)
}

// ---- Diagnostic severity icons ----
function diagnosticSeverityIcon(severity) {
  if (severity === 'error') {
    return `<svg class="diag-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--danger)" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>`
  }
  if (severity === 'warning') {
    return `<svg class="diag-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--warn)" stroke-width="1.5"><path d="M8 2 1 14h14z"/><path d="M8 6.5v3M8 11.5v.5"/></svg>`
  }
  return `<svg class="diag-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--brand-2)" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 7v4M8 5v.5"/></svg>`
}

async function runVerification() {
  if (!state.session) return

  setBusy(true)
  try {
    const result = await fetchJson(`/api/sessions/${state.session.id}/verify`, {
      method: 'POST',
    })

    state.verification = result
    state.diagnostics = result.diagnostics
    state.artifacts = result.diagnostics.artifacts || []
    if (!state.selectedArtifactPath && state.artifacts.length > 0) {
      state.selectedArtifactPath = state.artifacts[0].filePath
    }

    renderDiagnostics()
    renderArtifacts()
    renderVerification()
    setActiveTab('verify')
  } catch (error) {
    showToast('error', 'Verification failed', String(error))
  } finally {
    setBusy(false)
  }
}

function renderDiagnostics() {
  const diagnostics = state.diagnostics
  if (!diagnostics) {
    elements.diagnosticsSummary.className = 'status'
    elements.diagnosticsSummary.textContent = 'No diagnostics yet'
    elements.diagnosticsList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-muted)" stroke-width="1.5">
          <path d="M9 12l2 2 4-4"/>
          <circle cx="12" cy="12" r="10"/>
        </svg>
        <p>Run diagnostics to see compiler and TypeScript feedback.</p>
      </div>
    `
    return
  }

  const summary = diagnostics.summary
  const hasErrors = summary.errorCount > 0
  const hasWarnings = summary.warningCount > 0
  elements.diagnosticsSummary.className = hasErrors
    ? 'status error'
    : hasWarnings
      ? 'status warning'
      : 'status ok'
  elements.diagnosticsSummary.textContent = `${summary.errorCount} error(s), ${summary.warningCount} warning(s), ${summary.infoCount} info`

  if (!diagnostics.diagnostics.length) {
    elements.diagnosticsList.innerHTML = `
      <article class="diagnostic-item">
        <div class="title">No diagnostics</div>
        <div class="muted">Compiler and TypeScript checks are clean.</div>
      </article>
    `
    return
  }

  elements.diagnosticsList.innerHTML = diagnostics.diagnostics
    .map((diagnostic, index) => {
      const location = diagnostic.filePath
        ? `${diagnostic.filePath}${diagnostic.line ? `:${diagnostic.line}` : ''}${diagnostic.column ? `:${diagnostic.column}` : ''}`
        : 'global'
      return `
        <article class="diagnostic-item" data-severity="${escapeAttr(diagnostic.severity)}">
          <button type="button" data-diagnostic-index="${index}">
            <div class="diag-header">
              ${diagnosticSeverityIcon(diagnostic.severity)}
              <div class="title">[${escapeHtml(diagnostic.source)}:${escapeHtml(diagnostic.code)}] ${escapeHtml(diagnostic.message)}</div>
            </div>
            <div class="muted">${escapeHtml(diagnostic.severity)} \u00b7 ${escapeHtml(location)}</div>
          </button>
        </article>
      `
    })
    .join('')
}

function renderArtifacts() {
  const artifacts = state.artifacts

  if (artifacts.length === 0) {
    elements.artifactList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-muted)" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>No compiled artifacts yet. Run diagnostics to generate transformed output.</p>
      </div>
    `
    elements.artifactViewer.textContent = ''
    return
  }

  elements.artifactList.innerHTML = artifacts
    .map(artifact => {
      const active =
        artifact.filePath === state.selectedArtifactPath ? 'artifact-item active' : 'artifact-item'
      return `
        <article class="${active}">
          <button type="button" data-artifact-path="${escapeAttr(artifact.filePath)}">${escapeHtml(artifact.filePath)}</button>
        </article>
      `
    })
    .join('')

  const activeArtifact = artifacts.find(
    artifact => artifact.filePath === state.selectedArtifactPath,
  )
  elements.artifactViewer.textContent = activeArtifact
    ? activeArtifact.code
    : 'No transformed artifact selected.'
}

function selectArtifact(filePath) {
  state.selectedArtifactPath = filePath
  renderArtifacts()
}

function setActiveTab(tab) {
  const isDiagnostics = tab === 'diagnostics'
  const isArtifacts = tab === 'artifacts'
  const isVerify = tab === 'verify'

  elements.panelDiagnostics.classList.toggle('tab-visible', isDiagnostics)
  elements.panelArtifacts.classList.toggle('tab-visible', isArtifacts)
  elements.panelVerify.classList.toggle('tab-visible', isVerify)

  elements.tabDiagnostics.classList.toggle('active', isDiagnostics)
  elements.tabArtifacts.classList.toggle('active', isArtifacts)
  elements.tabVerify.classList.toggle('active', isVerify)
}

function invalidateVerification() {
  if (!state.verification) return
  state.verification = null
  renderVerification()
}

function renderVerification() {
  const verification = state.verification
  if (!verification) {
    elements.verifySummary.className = 'status'
    elements.verifySummary.textContent = 'No verification run yet'
    elements.verifyViewer.textContent = ''
    return
  }

  const summary = verification.summary
  const statusClass = summary.passed
    ? 'status ok'
    : summary.totalErrorCount > 0
      ? 'status error'
      : 'status warning'
  elements.verifySummary.className = statusClass
  elements.verifySummary.textContent = `passed=${summary.passed} \u00b7 errors=${summary.totalErrorCount} \u00b7 warnings=${summary.totalWarningCount} \u00b7 ${summary.durationMs}ms`

  const lines = [
    `Diagnostics: errors=${summary.diagnosticsErrorCount}, warnings=${summary.diagnosticsWarningCount}`,
    `Build: success=${verification.build.success}, errors=${summary.buildErrorCount}, warnings=${summary.buildWarningCount}, duration=${verification.build.durationMs}ms`,
    '',
    'Build output files:',
    ...verification.build.outputFiles.map(filePath => `- ${filePath}`),
    '',
  ]

  if (verification.build.warnings.length > 0) {
    lines.push('Build warnings:')
    lines.push(...verification.build.warnings.map(message => `- ${message}`))
    lines.push('')
  }

  if (verification.build.errors.length > 0) {
    lines.push('Build errors:')
    lines.push(...verification.build.errors.map(message => `- ${message}`))
  }

  elements.verifyViewer.textContent = lines.join('\n').trim()
}

// ---- File management ----
function selectFile(filePath) {
  if (!state.session) return
  state.currentFilePath = filePath
  renderFileList()
  renderEditor()
  updateEditorStatus('idle')
  if (editorView) editorView.focus()
}

async function addFile() {
  if (!state.session) return

  const filePath = await showModal({
    title: 'Add new file',
    inputLabel: 'File path (relative to session root)',
    inputDefault: 'src/NewFile.tsx',
    confirmText: 'Create',
  })
  if (!filePath) return

  const normalized = filePath.trim().replace(/^\.\//, '')
  if (!normalized) return

  const content = defaultContentForFile(normalized)
  await fetchJson(`/api/sessions/${state.session.id}/files`, {
    method: 'POST',
    body: {
      path: normalized,
      content,
    },
  })

  state.session.files[normalized] = content
  state.currentFilePath = normalized
  invalidateVerification()
  renderFileList()
  renderEditor()
  updateEditorStatus('dirty')
  await saveCurrentFile()
}

async function deleteFile(filePath) {
  if (!state.session) return

  const confirmDelete = await showModal({
    title: 'Delete file',
    body: `Are you sure you want to delete ${filePath}? This cannot be undone.`,
    confirmText: 'Delete',
    danger: true,
  })
  if (!confirmDelete) return

  const response = await fetchJson(`/api/sessions/${state.session.id}/files`, {
    method: 'DELETE',
    body: {
      path: filePath,
    },
  })

  hydrateSession(response.session)
  invalidateVerification()
  await runDiagnostics()
}

function scheduleSave() {
  if (!state.session || !state.currentFilePath) return

  if (state.saveTimer) {
    clearTimeout(state.saveTimer)
  }

  state.saveTimer = setTimeout(() => {
    void saveCurrentFile()
  }, 350)
}

async function saveCurrentFile() {
  if (!state.session || !state.currentFilePath) return

  if (state.saveTimer) {
    clearTimeout(state.saveTimer)
    state.saveTimer = null
  }

  const content = editorView
    ? editorView.state.doc.toString()
    : (state.session?.files[state.currentFilePath] ?? '')
  state.saving = true
  updateEditorStatus('saving')

  try {
    const response = await fetchJson(`/api/sessions/${state.session.id}/files`, {
      method: 'PUT',
      body: {
        path: state.currentFilePath,
        content,
      },
    })
    forcePreviewRefresh()
    hydrateSession(response.session)
    updateEditorStatus('saved')
    scheduleDiagnostics()
  } catch (error) {
    updateEditorStatus('error')
    showToast('error', 'Save failed', String(error))
  } finally {
    state.saving = false
  }
}

async function updateConfig(patch) {
  if (!state.session) return

  setBusy(true)
  try {
    const response = await fetchJson(`/api/sessions/${state.session.id}/config`, {
      method: 'POST',
      body: {
        config: patch,
      },
    })

    state.session = {
      ...state.session,
      ...response.session,
      files: state.session.files,
    }

    invalidateVerification()
    renderSessionMeta()
    renderConfig()
    renderPreview()
    await runDiagnostics()
  } catch (error) {
    showToast('error', 'Config update failed', String(error))
  } finally {
    setBusy(false)
  }
}

async function shareSession() {
  if (!state.session) return

  setButtonLoading('btn-share', true, 'Sharing...')
  try {
    const response = await fetchJson(`/api/sessions/${state.session.id}/share`, {
      method: 'POST',
    })

    const url = response.url
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      showToast('success', 'Share URL copied', 'The link has been copied to your clipboard.')
    } else {
      await showModal({
        title: 'Share URL',
        body: 'Copy the URL below to share this session.',
        inputLabel: 'Share URL',
        inputDefault: url,
        confirmText: 'Close',
      })
    }
  } catch (error) {
    showToast('error', 'Share failed', String(error))
  } finally {
    setButtonLoading('btn-share', false, 'Share')
  }
}

async function promptImport() {
  const token = await showModal({
    title: 'Import shared session',
    inputLabel: 'Paste share token or full URL',
    inputDefault: '',
    confirmText: 'Import',
  })
  if (!token) return

  const parsedToken = extractShareToken(token)
  if (!parsedToken) {
    showToast('warning', 'Invalid input', 'No share token found in the provided input.')
    return
  }

  await importSharedSession(parsedToken)
  const nextUrl = new URL(window.location.href)
  nextUrl.searchParams.set('share', parsedToken)
  history.replaceState({}, '', nextUrl)
}

function openDiagnostic(diagnostic) {
  if (!diagnostic.filePath || !state.session) return
  if (!state.session.files[diagnostic.filePath]) return

  selectFile(diagnostic.filePath)

  if (!editorView || !diagnostic.line) {
    if (editorView) editorView.focus()
    return
  }

  const lineNum = Math.min(diagnostic.line, editorView.state.doc.lines)
  const lineInfo = editorView.state.doc.line(lineNum)
  const col = Math.max(0, (diagnostic.column || 1) - 1)
  const pos = lineInfo.from + Math.min(col, lineInfo.length)

  editorView.dispatch({
    selection: { anchor: pos },
    effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }),
  })
  editorView.focus()
}

// ---- UI helpers ----
function updateEditorStatus(status) {
  state.lastStatus = status
  const map = {
    idle: { text: 'Idle', className: 'status' },
    dirty: { text: 'Unsaved changes', className: 'status warning' },
    saving: { text: 'Saving...', className: 'status warning' },
    saved: { text: 'Saved', className: 'status ok' },
    error: { text: 'Save failed', className: 'status error' },
  }

  const view = map[status] || map.idle
  elements.editorStatus.textContent = view.text
  elements.editorStatus.className = view.className
}

function setBusy(busy) {
  state.busy = busy
  document.body.style.cursor = busy ? 'progress' : ''

  const buttons = [
    { id: 'btn-run-diagnostics', label: 'Run Diagnostics' },
    { id: 'btn-run-verify', label: 'Verify (Full)' },
  ]

  for (const { id, label } of buttons) {
    const btn = document.getElementById(id)
    if (!btn) continue
    btn.disabled = busy
    if (busy) {
      btn.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`
    } else {
      btn.textContent = label
    }
  }
}

function setButtonLoading(buttonId, loading, label) {
  const btn = document.getElementById(buttonId)
  if (!btn) return
  btn.disabled = loading
  if (loading) {
    btn.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`
  } else {
    btn.textContent = label
  }
}

function defaultContentForFile(filePath) {
  if (filePath.endsWith('.tsx')) {
    return `export function NewComponent() {\n  return <section>New component</section>\n}\n`
  }

  if (filePath.endsWith('.ts')) {
    return `export const value = 1\n`
  }

  if (filePath.endsWith('.css')) {
    return `.new-style {\n  color: #ce4b25;\n}\n`
  }

  if (filePath.endsWith('.json')) {
    return `{\n  "ok": true\n}\n`
  }

  return ''
}

function estimateFileSize(content) {
  const bytes = new TextEncoder().encode(content || '').length
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileNameOf(filePath) {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || filePath
}

function byId(id) {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing element: ${id}`)
  }
  return element
}

async function fetchJson(url, options = {}) {
  const authHeader = state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = payload?.error || `${response.status} ${response.statusText}`
    throw new Error(detail)
  }

  return payload
}

function extractShareToken(input) {
  const trimmed = input.trim()
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    return url.searchParams.get('share') || ''
  } catch {
    return trimmed
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}
