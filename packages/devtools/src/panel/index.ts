/**
 * Fict DevTools Panel
 *
 * This is the main panel UI for the Fict DevTools browser extension.
 * It displays the reactive signal tree, effect tracking, and provides
 * debugging capabilities.
 */

// Make this file a module
export {}

interface SignalData {
  id: number
  name?: string
  value: unknown
  updateCount: number
  createdAt: number
  lastUpdatedAt?: number
}

interface EffectData {
  id: number
  name?: string
  runCount: number
  createdAt: number
  lastRunAt?: number
  isActive: boolean
}

interface DevToolsState {
  signals: SignalData[]
  effects: EffectData[]
  isConnected: boolean
  lastUpdate: number
}

const state: DevToolsState = {
  signals: [],
  effects: [],
  isConnected: false,
  lastUpdate: 0,
}

/**
 * Format a timestamp for display
 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

/**
 * Safely stringify a value for display
 */
function formatValue(value: unknown): string {
  try {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'function') return '[Function]'
    if (typeof value === 'object') {
      const str = JSON.stringify(value, null, 2)
      return str.length > 100 ? str.slice(0, 100) + '...' : str
    }
    return String(value)
  } catch {
    return '[Circular]'
  }
}

/**
 * Create a signal row element
 */
function createSignalRow(signal: SignalData): HTMLElement {
  const row = document.createElement('div')
  row.className = 'signal-row'
  row.innerHTML = `
    <div class="signal-id">#${signal.id}</div>
    <div class="signal-value">${formatValue(signal.value)}</div>
    <div class="signal-updates">${signal.updateCount} updates</div>
    <div class="signal-time">${signal.lastUpdatedAt ? formatTime(signal.lastUpdatedAt) : '-'}</div>
  `
  return row
}

/**
 * Create an effect row element
 */
function createEffectRow(effect: EffectData): HTMLElement {
  const row = document.createElement('div')
  row.className = `effect-row ${effect.isActive ? 'active' : 'inactive'}`
  row.innerHTML = `
    <div class="effect-id">#${effect.id}</div>
    <div class="effect-status">${effect.isActive ? '●' : '○'}</div>
    <div class="effect-runs">${effect.runCount} runs</div>
    <div class="effect-time">${effect.lastRunAt ? formatTime(effect.lastRunAt) : '-'}</div>
  `
  return row
}

/**
 * Render the panel UI
 */
function render(): void {
  const app = document.getElementById('app')
  if (!app) return

  app.innerHTML = `
    <div class="devtools-panel">
      <header class="panel-header">
        <h1>Fict DevTools</h1>
        <span class="connection-status ${state.isConnected ? 'connected' : 'disconnected'}">
          ${state.isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      <nav class="panel-tabs">
        <button class="tab active" data-tab="signals">Signals (${state.signals.length})</button>
        <button class="tab" data-tab="effects">Effects (${state.effects.length})</button>
      </nav>

      <main class="panel-content">
        <section id="signals-tab" class="tab-content active">
          <div class="signals-header">
            <span>ID</span>
            <span>Value</span>
            <span>Updates</span>
            <span>Last Updated</span>
          </div>
          <div id="signals-list" class="signals-list"></div>
        </section>

        <section id="effects-tab" class="tab-content">
          <div class="effects-header">
            <span>ID</span>
            <span>Status</span>
            <span>Runs</span>
            <span>Last Run</span>
          </div>
          <div id="effects-list" class="effects-list"></div>
        </section>
      </main>

      <footer class="panel-footer">
        <button id="refresh-btn" class="btn">Refresh</button>
        <button id="clear-btn" class="btn">Clear</button>
        <span class="last-update">Last update: ${state.lastUpdate ? formatTime(state.lastUpdate) : 'Never'}</span>
      </footer>
    </div>
  `

  // Render signals
  const signalsList = document.getElementById('signals-list')
  if (signalsList) {
    state.signals.forEach(signal => {
      signalsList.appendChild(createSignalRow(signal))
    })

    if (state.signals.length === 0) {
      signalsList.innerHTML = '<div class="empty-message">No signals registered yet</div>'
    }
  }

  // Render effects
  const effectsList = document.getElementById('effects-list')
  if (effectsList) {
    state.effects.forEach(effect => {
      effectsList.appendChild(createEffectRow(effect))
    })

    if (state.effects.length === 0) {
      effectsList.innerHTML = '<div class="empty-message">No effects registered yet</div>'
    }
  }

  // Add event listeners
  setupEventListeners()
}

/**
 * Set up event listeners for the panel
 */
function setupEventListeners(): void {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', e => {
      const target = e.target as HTMLElement
      const tabId = target.dataset.tab
      if (!tabId) return

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))

      target.classList.add('active')
      document.getElementById(`${tabId}-tab`)?.classList.add('active')
    })
  })

  // Refresh button
  document.getElementById('refresh-btn')?.addEventListener('click', () => {
    sendToPage('request:signals')
    sendToPage('request:effects')
  })

  // Clear button
  document.getElementById('clear-btn')?.addEventListener('click', () => {
    state.signals = []
    state.effects = []
    render()
  })
}

/**
 * Send message to page content script
 */
function sendToPage(type: string, payload?: unknown): void {
  window.postMessage(
    {
      source: 'fict-devtools-panel',
      type,
      payload,
    },
    '*',
  )
}

/**
 * Handle messages from the page hook
 */
function handleMessage(event: MessageEvent): void {
  if (event.data?.source !== 'fict-devtools-hook') return

  const { type, payload } = event.data

  switch (type) {
    case 'state:init':
      state.signals = payload.signals || []
      state.effects = payload.effects || []
      state.isConnected = true
      state.lastUpdate = Date.now()
      render()
      break

    case 'response:signals':
      state.signals = payload || []
      state.lastUpdate = Date.now()
      render()
      break

    case 'response:effects':
      state.effects = payload || []
      state.lastUpdate = Date.now()
      render()
      break

    case 'signal:register':
      state.signals.push({
        id: payload.id,
        value: payload.value,
        updateCount: 0,
        createdAt: Date.now(),
      })
      state.lastUpdate = Date.now()
      render()
      break

    case 'signal:update': {
      const signal = state.signals.find(s => s.id === payload.id)
      if (signal) {
        signal.value = payload.value
        signal.updateCount++
        signal.lastUpdatedAt = Date.now()
        state.lastUpdate = Date.now()
        render()
      }
      break
    }

    case 'effect:register':
      state.effects.push({
        id: payload.id,
        runCount: 0,
        createdAt: Date.now(),
        isActive: true,
      })
      state.lastUpdate = Date.now()
      render()
      break

    case 'effect:run': {
      const effect = state.effects.find(e => e.id === payload.id)
      if (effect) {
        effect.runCount = payload.runCount
        effect.lastRunAt = Date.now()
        state.lastUpdate = Date.now()
        render()
      }
      break
    }

    case 'cycle:detected':
      console.warn('[DevTools] Cycle detected:', payload)
      break
  }
}

/**
 * Initialize the DevTools panel
 */
function init(): void {
  // Listen for messages from page
  window.addEventListener('message', handleMessage)

  // Connect to page
  sendToPage('connect')

  // Initial render
  render()

  // Re-render periodically to show relative times
  setInterval(() => {
    if (state.isConnected) {
      render()
    }
  }, 5000)
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
