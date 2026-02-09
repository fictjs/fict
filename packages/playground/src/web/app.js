/* global document, window, URL, HTMLElement, alert, prompt, confirm, clearTimeout, setTimeout, navigator, history, TextEncoder, fetch, console */

const state = {
  templates: [],
  session: null,
  currentFilePath: '',
  diagnostics: null,
  artifacts: [],
  selectedArtifactPath: '',
  saveTimer: null,
  saving: false,
  busy: false,
  lastStatus: 'idle',
}

const elements = {}

main().catch(error => {
  console.error(error)
  document.getElementById('app').innerHTML =
    `<pre>Failed to initialize playground: ${escapeHtml(String(error))}</pre>`
})

async function main() {
  renderLayout()
  bindStaticListeners()

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
}

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
          <button id="btn-run-diagnostics">Run Diagnostics</button>
          <button id="btn-share" class="ghost">Share</button>
          <button id="btn-import" class="ghost">Import</button>
          <button id="btn-reset" class="ghost">New Session</button>
        </div>
      </header>
      <main class="board">
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
              <span>strictGuarantee</span>
              <button type="button" class="switch" data-config-key="strictGuarantee" aria-label="strictGuarantee"></button>
            </div>
            <div class="control-row">
              <span>strictReactivity</span>
              <button type="button" class="switch" data-config-key="strictReactivity" aria-label="strictReactivity"></button>
            </div>
            <div class="control-row">
              <span>lazyConditional</span>
              <button type="button" class="switch" data-config-key="lazyConditional" aria-label="lazyConditional"></button>
            </div>
            <div class="control-row">
              <span>resumable</span>
              <button type="button" class="switch" data-config-key="resumable" aria-label="resumable"></button>
            </div>
            <div class="control-row">
              <span>functionSplitting</span>
              <button type="button" class="switch" data-config-key="functionSplitting" aria-label="functionSplitting"></button>
            </div>
            <div class="control-row">
              <span>devtools</span>
              <button type="button" class="switch" data-config-key="devtools" aria-label="devtools"></button>
            </div>
          </div>

          <div class="panel-header">
            <h3>Files</h3>
            <div class="inline-row">
              <button id="btn-add-file" class="ghost">Add</button>
            </div>
          </div>
          <div id="file-list" class="file-list"></div>
        </section>

        <section class="panel" aria-label="editor">
          <div class="editor-header">
            <div>
              <h2 id="editor-title">Editor</h2>
              <div class="muted" id="editor-path"></div>
            </div>
            <div class="editor-actions">
              <button id="btn-save-file" class="ghost">Save</button>
            </div>
          </div>
          <textarea id="code-editor" spellcheck="false"></textarea>
          <div id="editor-status" class="status">Idle</div>
        </section>

        <section class="panel" aria-label="preview diagnostics">
          <div class="panel-header">
            <h2>Preview</h2>
            <a id="preview-link" href="#" target="_blank" rel="noreferrer noopener">Open</a>
          </div>
          <iframe id="preview-frame" class="preview-frame" title="Playground preview"></iframe>

          <div class="tabs">
            <button id="tab-diagnostics" class="active">Diagnostics</button>
            <button id="tab-artifacts">Artifacts</button>
          </div>

          <div id="panel-diagnostics">
            <div class="inline-row">
              <div id="diagnostics-summary" class="status">No diagnostics yet</div>
            </div>
            <div id="diagnostics-list" class="diagnostics-list"></div>
          </div>

          <div id="panel-artifacts" hidden>
            <div id="artifact-list" class="artifact-list"></div>
            <pre id="artifact-viewer" class="code-viewer"></pre>
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
  elements.codeEditor = byId('code-editor')
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
}

function bindStaticListeners() {
  byId('btn-run-diagnostics').addEventListener('click', () => {
    void runDiagnostics()
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

  elements.codeEditor.addEventListener('input', () => {
    const session = state.session
    const filePath = state.currentFilePath
    if (!session || !filePath) return

    session.files[filePath] = elements.codeEditor.value
    updateEditorStatus('dirty')
    scheduleSave()
  })

  elements.profileSelect.addEventListener('change', () => {
    const value = elements.profileSelect.value
    void updateConfig({ profile: value })
  })

  document.addEventListener('click', event => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const templateId = target.dataset.templateId
    if (templateId) {
      void createSession(templateId)
      return
    }

    const filePath = target.dataset.filePath
    if (filePath && target.dataset.action !== 'delete-file') {
      selectFile(filePath)
      return
    }

    if (target.dataset.action === 'delete-file' && filePath) {
      event.stopPropagation()
      void deleteFile(filePath)
      return
    }

    const artifactPath = target.dataset.artifactPath
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

    const diagnosticIndexRaw = target.dataset.diagnosticIndex
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
}

async function createSession(templateId) {
  if (!templateId) return
  setBusy(true)
  try {
    const response = await fetchJson('/api/sessions', {
      method: 'POST',
      body: { templateId },
    })
    state.diagnostics = null
    state.artifacts = []
    state.selectedArtifactPath = ''
    hydrateSession(response.session)
    setActiveTab('diagnostics')
    renderDiagnostics()
    renderArtifacts()
    updateEditorStatus('idle')
  } catch (error) {
    alert(`Failed to create session: ${String(error)}`)
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
    hydrateSession(response.session)
    await runDiagnostics()
  } catch (error) {
    alert(`Failed to import session: ${String(error)}`)
    const defaultTemplate = state.templates[0]
    await createSession(defaultTemplate ? defaultTemplate.id : 'counter')
  } finally {
    setBusy(false)
  }
}

function hydrateSession(session) {
  state.session = session
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
}

function renderSessionMeta() {
  const session = state.session
  if (!session) {
    elements.sessionMeta.textContent = 'No session'
    return
  }

  const config = session.config
  elements.sessionMeta.textContent = `session ${session.id} · ${session.templateId} · profile=${config.profile} · strictGuarantee=${config.strictGuarantee}`
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
            <span>${escapeHtml(filePath)}</span>
            <span class="inline-row">
              <span class="muted">${estimateFileSize(session.files[filePath])}</span>
              <span data-action="delete-file" data-file-path="${escapeAttr(filePath)}" title="Delete file">🗑</span>
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
    elements.codeEditor.value = ''
    elements.codeEditor.disabled = true
    return
  }

  elements.editorTitle.textContent = fileNameOf(filePath)
  elements.editorPath.textContent = filePath
  elements.codeEditor.disabled = false
  elements.codeEditor.value = session.files[filePath] ?? ''
}

function renderPreview() {
  const session = state.session
  if (!session) {
    elements.previewFrame.src = 'about:blank'
    elements.previewLink.href = '#'
    return
  }

  elements.previewFrame.src = session.previewUrl
  elements.previewLink.href = session.previewUrl
  elements.previewLink.textContent = session.previewUrl
}

async function runDiagnostics() {
  if (!state.session) return

  setBusy(true)
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
    alert(`Diagnostics failed: ${String(error)}`)
  } finally {
    setBusy(false)
  }
}

function renderDiagnostics() {
  const diagnostics = state.diagnostics
  if (!diagnostics) {
    elements.diagnosticsSummary.className = 'status'
    elements.diagnosticsSummary.textContent = 'No diagnostics yet'
    elements.diagnosticsList.innerHTML = ''
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
    elements.diagnosticsList.innerHTML = `<article class="diagnostic-item"><div class="title">No diagnostics</div><div class="muted">Compiler and TypeScript checks are clean.</div></article>`
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
            <div class="title">[${escapeHtml(diagnostic.source)}:${escapeHtml(diagnostic.code)}] ${escapeHtml(diagnostic.message)}</div>
            <div class="muted">${escapeHtml(diagnostic.severity)} · ${escapeHtml(location)}</div>
          </button>
        </article>
      `
    })
    .join('')
}

function renderArtifacts() {
  const artifacts = state.artifacts
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
  elements.panelDiagnostics.hidden = !isDiagnostics
  elements.panelArtifacts.hidden = isDiagnostics
  elements.tabDiagnostics.classList.toggle('active', isDiagnostics)
  elements.tabArtifacts.classList.toggle('active', !isDiagnostics)
}

function selectFile(filePath) {
  if (!state.session) return
  state.currentFilePath = filePath
  renderFileList()
  renderEditor()
  updateEditorStatus('idle')
}

async function addFile() {
  if (!state.session) return
  const filePath = prompt('New file path (relative to session root):', 'src/NewFile.tsx')
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
  renderFileList()
  renderEditor()
  updateEditorStatus('dirty')
  await saveCurrentFile()
}

async function deleteFile(filePath) {
  if (!state.session) return

  const confirmDelete = confirm(`Delete file ${filePath}?`)
  if (!confirmDelete) return

  const response = await fetchJson(`/api/sessions/${state.session.id}/files`, {
    method: 'DELETE',
    body: {
      path: filePath,
    },
  })

  hydrateSession(response.session)
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

  const content = elements.codeEditor.value
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
    hydrateSession(response.session)
    updateEditorStatus('saved')
    await runDiagnostics()
  } catch (error) {
    updateEditorStatus('error')
    alert(`Save failed: ${String(error)}`)
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

    renderSessionMeta()
    renderConfig()
    renderPreview()
    await runDiagnostics()
  } catch (error) {
    alert(`Config update failed: ${String(error)}`)
  } finally {
    setBusy(false)
  }
}

async function shareSession() {
  if (!state.session) return

  const response = await fetchJson(`/api/sessions/${state.session.id}/share`, {
    method: 'POST',
  })

  const url = response.url
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url)
    alert(`Share URL copied to clipboard:\n${url}`)
    return
  }

  prompt('Copy this share URL:', url)
}

async function promptImport() {
  const token = prompt('Paste share token or full share URL:')
  if (!token) return

  const parsedToken = extractShareToken(token)
  if (!parsedToken) {
    alert('No share token found in input.')
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

  if (!diagnostic.line) {
    elements.codeEditor.focus()
    return
  }

  const offset = lineColumnToOffset(
    elements.codeEditor.value,
    diagnostic.line,
    diagnostic.column || 1,
  )
  elements.codeEditor.focus()
  elements.codeEditor.setSelectionRange(offset, offset)
}

function lineColumnToOffset(text, line, column) {
  const lines = text.split('\n')
  let offset = 0

  for (let index = 0; index < line - 1 && index < lines.length; index += 1) {
    offset += lines[index].length + 1
  }

  return offset + Math.max(0, column - 1)
}

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
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
