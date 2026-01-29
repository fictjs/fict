/**
 * Fict DevTools Panel
 *
 * Main panel UI for the DevTools browser extension.
 * Displays signals, effects, components, timeline, and dependency graph.
 */

import {
  type ComponentState,
  type ComputedState,
  type DevToolsSettings,
  type EffectState,
  MessageSource,
  type NodeType,
  type PanelTab,
  type RootState,
  type SignalState,
  type TimelineEvent,
  TimelineEventType,
} from '../core/types'

// ============================================================================
// State
// ============================================================================

interface PanelState {
  isConnected: boolean
  fictDetected: boolean
  fictVersion?: string
  activeTab: PanelTab
  signals: Map<number, SignalState>
  computeds: Map<number, ComputedState>
  effects: Map<number, EffectState>
  components: Map<number, ComponentState>
  roots: Map<number, RootState>
  timeline: TimelineEvent[]
  selectedNodeId: number | null
  selectedNodeType: NodeType | null
  expandedIds: Set<number>
  searchQuery: string
  settings: DevToolsSettings
  lastUpdate: number
}

const state: PanelState = {
  isConnected: false,
  fictDetected: false,
  activeTab: 'signals',
  signals: new Map(),
  computeds: new Map(),
  effects: new Map(),
  components: new Map(),
  roots: new Map(),
  timeline: [],
  selectedNodeId: null,
  selectedNodeType: null,
  expandedIds: new Set(),
  searchQuery: '',
  settings: {
    maxTimelineEvents: 1000,
    recordTimeline: true,
    highPerfMode: false,
    highlightUpdates: true,
    theme: 'system',
    collapsedSections: [],
  },
  lastUpdate: 0,
}

let port: chrome.runtime.Port | null = null
let isStandaloneMode = false

// ============================================================================
// Utility Functions
// ============================================================================

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions)
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 1000) return 'just now'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return formatTime(timestamp)
}

function formatValue(value: unknown, maxLen = 100): string {
  try {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`
    if (typeof value === 'symbol') return String(value)
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'object') {
      const str = JSON.stringify(value)
      return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
    }
    return String(value)
  } catch {
    return '[Circular]'
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ============================================================================
// Communication
// ============================================================================

function connectToBackground(): void {
  // Check if Chrome extension APIs are available
  if (typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow?.tabId !== undefined) {
    // Chrome extension mode
    isStandaloneMode = false
    const tabId = chrome.devtools.inspectedWindow.tabId
    port = chrome.runtime.connect({ name: String(tabId) })

    port.onMessage.addListener(handleMessage)

    port.onDisconnect.addListener(() => {
      state.isConnected = false
      port = null
      render()

      // Try to reconnect
      setTimeout(connectToBackground, 1000)
    })
  } else {
    // Standalone Vite mode
    isStandaloneMode = true
    console.log('[Fict DevTools] Running in standalone mode')

    // In standalone mode, we communicate via BroadcastChannel for cross-tab communication
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('fict-devtools')
      channel.onmessage = event => {
        if (event.data?.source === MessageSource.Hook) {
          handleMessage(event.data)
        }
      }

      // Store channel reference for sending messages
      ;(window as Window & { __devtoolsChannel?: BroadcastChannel }).__devtoolsChannel = channel
    }

    state.isConnected = true
    state.fictDetected = true
  }

  // Request initial state
  sendToPage('connect')
}

function sendToPage(type: string, payload?: unknown): void {
  const message = {
    source: MessageSource.Panel,
    type,
    payload,
    timestamp: Date.now(),
  }

  if (port) {
    // Chrome extension mode - send via port
    port.postMessage(message)
  } else if (isStandaloneMode) {
    // Standalone mode - use BroadcastChannel for cross-tab communication
    const channel = (window as Window & { __devtoolsChannel?: BroadcastChannel }).__devtoolsChannel
    if (channel) {
      channel.postMessage(message)
    }

    // Also try opener/parent for backward compatibility
    const targetWindow = window.opener || window.parent
    if (targetWindow && targetWindow !== window) {
      targetWindow.postMessage(message, '*')
    }
  } else {
    // Fallback
    window.postMessage(message, '*')
  }
}

function handleMessage(message: Record<string, unknown>): void {
  const { type, payload } = message

  switch (type) {
    case 'fict-detected':
      state.fictDetected = true
      state.fictVersion = (payload as { version?: string })?.version
      state.isConnected = true
      render()
      break

    case 'state:init':
      handleInitialState(payload as InitialState)
      break

    case 'signal:register':
      state.signals.set((payload as SignalState).id, payload as SignalState)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'signal:update':
      updateSignal(payload as SignalUpdate)
      break

    case 'signal:dispose':
      state.signals.delete((payload as { id: number }).id)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'computed:register':
      state.computeds.set((payload as ComputedState).id, payload as ComputedState)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'computed:update':
      updateComputed(payload as ComputedUpdate)
      break

    case 'effect:register':
      state.effects.set((payload as EffectState).id, payload as EffectState)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'effect:run':
      updateEffect(payload as EffectUpdate)
      break

    case 'effect:dispose':
      state.effects.delete((payload as { id: number }).id)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'component:register':
      state.components.set((payload as ComponentState).id, payload as ComponentState)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'components') renderComponentsTab()
      break

    case 'component:mount':
    case 'component:unmount':
    case 'component:render':
      updateComponent(payload as ComponentUpdate)
      break

    case 'timeline:event':
      state.timeline.push(payload as TimelineEvent)
      if (state.timeline.length > state.settings.maxTimelineEvents) {
        state.timeline.shift()
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'timeline') renderTimelineTab()
      break

    case 'response:signals':
      state.signals.clear()
      for (const signal of payload as SignalState[]) {
        state.signals.set(signal.id, signal)
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'response:effects':
      state.effects.clear()
      for (const effect of payload as EffectState[]) {
        state.effects.set(effect.id, effect)
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'response:timeline':
      state.timeline = payload as TimelineEvent[]
      state.lastUpdate = Date.now()
      if (state.activeTab === 'timeline') renderTimelineTab()
      break

    case 'warning:cycle':
    case 'warning':
      console.warn('[Fict DevTools]', payload)
      break

    case 'error':
      console.error('[Fict DevTools]', payload)
      break
  }
}

// ============================================================================
// State Update Handlers
// ============================================================================

interface InitialState {
  signals: SignalState[]
  computeds: ComputedState[]
  effects: EffectState[]
  components: ComponentState[]
  roots: RootState[]
  timeline: TimelineEvent[]
  settings: DevToolsSettings
}

interface SignalUpdate {
  id: number
  value: unknown
  previousValue?: unknown
  updateCount: number
}

interface ComputedUpdate {
  id: number
  value: unknown
  previousValue?: unknown
  updateCount: number
}

interface EffectUpdate {
  id: number
  runCount: number
  duration?: number
  dependencies?: number[]
}

interface ComponentUpdate {
  id: number
  renderCount?: number
  isMounted?: boolean
}

function handleInitialState(data: InitialState): void {
  state.signals.clear()
  state.computeds.clear()
  state.effects.clear()
  state.components.clear()
  state.roots.clear()

  for (const signal of data.signals) {
    state.signals.set(signal.id, signal)
  }
  for (const computed of data.computeds) {
    state.computeds.set(computed.id, computed)
  }
  for (const effect of data.effects) {
    state.effects.set(effect.id, effect)
  }
  for (const component of data.components) {
    state.components.set(component.id, component)
  }
  for (const root of data.roots) {
    state.roots.set(root.id, root)
  }

  state.timeline = data.timeline || []
  state.settings = { ...state.settings, ...data.settings }
  state.isConnected = true
  state.lastUpdate = Date.now()

  render()
}

function updateSignal(update: SignalUpdate): void {
  const signal = state.signals.get(update.id)
  if (signal) {
    signal.previousValue = update.previousValue
    signal.value = update.value
    signal.updateCount = update.updateCount
    signal.lastUpdatedAt = Date.now()
  }
  state.lastUpdate = Date.now()

  if (state.activeTab === 'signals') {
    // Highlight updated row
    const row = document.querySelector(`[data-signal-id="${update.id}"]`)
    if (row && state.settings.highlightUpdates) {
      row.classList.add('updated')
      setTimeout(() => row.classList.remove('updated'), 500)
    }
    renderSignalsTab()
  }
}

function updateComputed(update: ComputedUpdate): void {
  const computed = state.computeds.get(update.id)
  if (computed) {
    computed.previousValue = update.previousValue
    computed.value = update.value
    computed.updateCount = update.updateCount
    computed.lastUpdatedAt = Date.now()
    computed.isDirty = false
  }
  state.lastUpdate = Date.now()
  if (state.activeTab === 'signals') renderSignalsTab()
}

function updateEffect(update: EffectUpdate): void {
  const effect = state.effects.get(update.id)
  if (effect) {
    effect.runCount = update.runCount
    effect.lastRunAt = Date.now()
    effect.lastRunDuration = update.duration
    if (update.dependencies) {
      effect.dependencies = update.dependencies
    }
  }
  state.lastUpdate = Date.now()

  if (state.activeTab === 'effects') {
    const row = document.querySelector(`[data-effect-id="${update.id}"]`)
    if (row && state.settings.highlightUpdates) {
      row.classList.add('updated')
      setTimeout(() => row.classList.remove('updated'), 500)
    }
    renderEffectsTab()
  }
}

function updateComponent(update: ComponentUpdate): void {
  const component = state.components.get(update.id)
  if (component) {
    if (update.renderCount !== undefined) {
      component.renderCount = update.renderCount
    }
    if (update.isMounted !== undefined) {
      component.isMounted = update.isMounted
    }
  }
  state.lastUpdate = Date.now()
  if (state.activeTab === 'components') renderComponentsTab()
}

// ============================================================================
// Rendering
// ============================================================================

function render(): void {
  const app = document.getElementById('app')
  if (!app) return

  app.innerHTML = `
    <div class="devtools-panel ${state.settings.theme}">
      ${renderHeader()}
      ${state.isConnected ? renderContent() : renderDisconnected()}
      ${renderFooter()}
    </div>
  `

  setupEventListeners()
}

function renderHeader(): string {
  return `
    <header class="panel-header">
      <div class="header-left">
        <h1 class="logo">
          <span class="logo-icon">⚡</span>
          Fict DevTools
          ${state.fictVersion ? `<span class="version">v${state.fictVersion}</span>` : ''}
        </h1>
      </div>
      <div class="header-right">
        <span class="connection-status ${state.isConnected ? 'connected' : 'disconnected'}">
          ${state.isConnected ? '● Connected' : '○ Disconnected'}
        </span>
      </div>
    </header>
    ${state.isConnected ? renderTabs() : ''}
  `
}

function renderTabs(): string {
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: 'signals', label: 'Signals', count: state.signals.size + state.computeds.size },
    { id: 'effects', label: 'Effects', count: state.effects.size },
    { id: 'components', label: 'Components', count: state.components.size },
    { id: 'timeline', label: 'Timeline', count: state.timeline.length },
    { id: 'settings', label: 'Settings' },
  ]

  return `
    <nav class="panel-tabs">
      ${tabs
        .map(
          tab => `
        <button
          class="tab ${state.activeTab === tab.id ? 'active' : ''}"
          data-tab="${tab.id}"
        >
          ${tab.label}
          ${tab.count !== undefined ? `<span class="badge">${tab.count}</span>` : ''}
        </button>
      `,
        )
        .join('')}
    </nav>
  `
}

function renderContent(): string {
  return `
    <main class="panel-content">
      ${renderSearch()}
      <div class="tab-content">
        ${renderActiveTab()}
      </div>
    </main>
  `
}

function renderSearch(): string {
  if (state.activeTab === 'settings' || state.activeTab === 'timeline') {
    return ''
  }

  return `
    <div class="search-bar">
      <input
        type="text"
        class="search-input"
        placeholder="Search..."
        value="${escapeHtml(state.searchQuery)}"
        id="search-input"
      />
      ${state.searchQuery ? '<button class="clear-search" id="clear-search">×</button>' : ''}
    </div>
  `
}

function renderActiveTab(): string {
  switch (state.activeTab) {
    case 'signals':
      return renderSignalsContent()
    case 'effects':
      return renderEffectsContent()
    case 'components':
      return renderComponentsContent()
    case 'timeline':
      return renderTimelineContent()
    case 'settings':
      return renderSettingsContent()
    default:
      return ''
  }
}

function renderSignalsContent(): string {
  const signals = Array.from(state.signals.values())
  const computeds = Array.from(state.computeds.values())

  const filteredSignals = filterItems(signals, state.searchQuery)
  const filteredComputeds = filterItems(computeds, state.searchQuery)

  if (filteredSignals.length === 0 && filteredComputeds.length === 0) {
    return '<div class="empty-message">No signals or computed values</div>'
  }

  return `
    <div class="signals-section">
      ${
        filteredSignals.length > 0
          ? `
        <div class="section-header">
          <h3>Signals (${filteredSignals.length})</h3>
        </div>
        <div class="signals-list">
          ${filteredSignals.map(renderSignalRow).join('')}
        </div>
      `
          : ''
      }

      ${
        filteredComputeds.length > 0
          ? `
        <div class="section-header">
          <h3>Computed (${filteredComputeds.length})</h3>
        </div>
        <div class="signals-list">
          ${filteredComputeds.map(renderComputedRow).join('')}
        </div>
      `
          : ''
      }
    </div>
  `
}

function renderSignalRow(signal: SignalState): string {
  return `
    <div
      class="signal-row ${state.selectedNodeId === signal.id ? 'selected' : ''}"
      data-signal-id="${signal.id}"
      data-node-type="signal"
    >
      <div class="signal-icon">📊</div>
      <div class="signal-info">
        <div class="signal-name">${escapeHtml(signal.name || `Signal #${signal.id}`)}</div>
        <div class="signal-value" title="${escapeHtml(formatValue(signal.value, 200))}">
          ${escapeHtml(formatValue(signal.value))}
        </div>
      </div>
      <div class="signal-meta">
        <span class="update-count" title="Update count">${signal.updateCount} updates</span>
        <span class="observers-count" title="Observers">${signal.observers.length} observers</span>
      </div>
      <div class="signal-time">
        ${signal.lastUpdatedAt ? formatRelativeTime(signal.lastUpdatedAt) : '-'}
      </div>
    </div>
  `
}

function renderComputedRow(computed: ComputedState): string {
  return `
    <div
      class="signal-row computed ${computed.isDirty ? 'dirty' : ''} ${state.selectedNodeId === computed.id ? 'selected' : ''}"
      data-computed-id="${computed.id}"
      data-node-type="computed"
    >
      <div class="signal-icon">🔄</div>
      <div class="signal-info">
        <div class="signal-name">${escapeHtml(computed.name || `Computed #${computed.id}`)}</div>
        <div class="signal-value" title="${escapeHtml(formatValue(computed.value, 200))}">
          ${escapeHtml(formatValue(computed.value))}
        </div>
      </div>
      <div class="signal-meta">
        <span class="update-count">${computed.updateCount} updates</span>
        <span class="deps-count">${computed.dependencies.length} deps</span>
      </div>
      <div class="signal-time">
        ${computed.lastUpdatedAt ? formatRelativeTime(computed.lastUpdatedAt) : '-'}
      </div>
    </div>
  `
}

function renderEffectsContent(): string {
  const effects = Array.from(state.effects.values())
  const filtered = filterItems(effects, state.searchQuery)

  if (filtered.length === 0) {
    return '<div class="empty-message">No effects registered</div>'
  }

  return `
    <div class="effects-list">
      ${filtered.map(renderEffectRow).join('')}
    </div>
  `
}

function renderEffectRow(effect: EffectState): string {
  return `
    <div
      class="effect-row ${effect.isActive ? 'active' : 'inactive'} ${state.selectedNodeId === effect.id ? 'selected' : ''}"
      data-effect-id="${effect.id}"
      data-node-type="effect"
    >
      <div class="effect-icon">${effect.isActive ? '⚡' : '○'}</div>
      <div class="effect-info">
        <div class="effect-name">${escapeHtml(effect.name || `Effect #${effect.id}`)}</div>
        <div class="effect-deps">
          ${effect.dependencies.length} dependencies
          ${effect.hasCleanup ? ' • has cleanup' : ''}
        </div>
      </div>
      <div class="effect-meta">
        <span class="run-count">${effect.runCount} runs</span>
        ${effect.lastRunDuration !== undefined ? `<span class="duration">${effect.lastRunDuration.toFixed(2)}ms</span>` : ''}
      </div>
      <div class="effect-time">
        ${effect.lastRunAt ? formatRelativeTime(effect.lastRunAt) : '-'}
      </div>
    </div>
  `
}

function renderComponentsContent(): string {
  const components = Array.from(state.components.values())
  const filtered = filterItems(components, state.searchQuery)

  if (filtered.length === 0) {
    return '<div class="empty-message">No components registered</div>'
  }

  // Build tree structure
  const roots = filtered.filter(c => !c.parentId)

  return `
    <div class="components-tree">
      ${roots.map(c => renderComponentNode(c, filtered)).join('')}
    </div>
  `
}

function renderComponentNode(
  component: ComponentState,
  allComponents: ComponentState[],
  depth = 0,
): string {
  const children = allComponents.filter(c => c.parentId === component.id)
  const hasChildren = children.length > 0
  const isExpanded = state.expandedIds.has(component.id)

  return `
    <div class="component-node" style="--depth: ${depth}">
      <div
        class="component-row ${component.isMounted ? 'mounted' : 'unmounted'} ${state.selectedNodeId === component.id ? 'selected' : ''}"
        data-component-id="${component.id}"
        data-node-type="component"
      >
        ${
          hasChildren
            ? `
          <button class="expand-btn ${isExpanded ? 'expanded' : ''}" data-expand="${component.id}">
            ${isExpanded ? '▼' : '▶'}
          </button>
        `
            : '<span class="expand-placeholder"></span>'
        }
        <span class="component-icon">${component.isMounted ? '🟢' : '⚪'}</span>
        <span class="component-name">${escapeHtml(component.name)}</span>
        <span class="component-meta">
          ${component.signals.length > 0 ? `${component.signals.length}S` : ''}
          ${component.effects.length > 0 ? `${component.effects.length}E` : ''}
          ${component.renderCount > 0 ? `• ${component.renderCount} renders` : ''}
        </span>
      </div>
      ${hasChildren && isExpanded ? `<div class="component-children">${children.map(c => renderComponentNode(c, allComponents, depth + 1)).join('')}</div>` : ''}
    </div>
  `
}

function renderTimelineContent(): string {
  if (state.timeline.length === 0) {
    return '<div class="empty-message">No timeline events recorded</div>'
  }

  const events = state.timeline.slice().reverse().slice(0, 200)

  return `
    <div class="timeline-controls">
      <button class="btn" id="clear-timeline">Clear</button>
      <label class="checkbox">
        <input type="checkbox" id="record-timeline" ${state.settings.recordTimeline ? 'checked' : ''}>
        Record events
      </label>
    </div>
    <div class="timeline-list">
      ${events.map(renderTimelineEvent).join('')}
    </div>
  `
}

function renderTimelineEvent(event: TimelineEvent): string {
  const icon = getTimelineEventIcon(event.type)
  const color = getTimelineEventColor(event.type)

  return `
    <div class="timeline-event" style="--event-color: ${color}">
      <div class="event-icon">${icon}</div>
      <div class="event-info">
        <div class="event-type">${formatEventType(event.type)}</div>
        ${event.nodeName ? `<div class="event-node">${escapeHtml(event.nodeName)}</div>` : ''}
        ${event.data ? `<div class="event-data">${escapeHtml(JSON.stringify(event.data))}</div>` : ''}
      </div>
      <div class="event-time">${formatTime(event.timestamp)}</div>
      ${event.duration !== undefined ? `<div class="event-duration">${event.duration.toFixed(2)}ms</div>` : ''}
    </div>
  `
}

function renderSettingsContent(): string {
  return `
    <div class="settings-section">
      <h3>Display</h3>
      <label class="setting-row">
        <span>Theme</span>
        <select id="setting-theme">
          <option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>System</option>
          <option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Light</option>
          <option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
        </select>
      </label>
      <label class="setting-row checkbox">
        <input type="checkbox" id="setting-highlight" ${state.settings.highlightUpdates ? 'checked' : ''}>
        <span>Highlight updates</span>
      </label>

      <h3>Performance</h3>
      <label class="setting-row checkbox">
        <input type="checkbox" id="setting-highperf" ${state.settings.highPerfMode ? 'checked' : ''}>
        <span>High-performance mode (reduces DevTools overhead)</span>
      </label>

      <h3>Timeline</h3>
      <label class="setting-row">
        <span>Max events</span>
        <input type="number" id="setting-max-events" value="${state.settings.maxTimelineEvents}" min="100" max="10000" step="100">
      </label>
    </div>
  `
}

function renderDisconnected(): string {
  return `
    <div class="disconnected-message">
      <div class="disconnected-icon">🔌</div>
      <h2>Not Connected</h2>
      <p>${state.fictDetected ? 'Connecting to Fict application...' : 'No Fict application detected on this page.'}</p>
      <p class="hint">Make sure your app is using Fict and DevTools hook is enabled.</p>
      <button class="btn primary" id="retry-connect">Retry Connection</button>
    </div>
  `
}

function renderFooter(): string {
  return `
    <footer class="panel-footer">
      <div class="footer-left">
        <button class="btn icon" id="refresh-btn" title="Refresh">🔄</button>
        ${state.activeTab === 'signals' ? '<button class="btn icon" id="inspect-btn" title="Inspect element">🎯</button>' : ''}
      </div>
      <div class="footer-right">
        <span class="last-update">
          ${state.lastUpdate ? `Updated ${formatRelativeTime(state.lastUpdate)}` : ''}
        </span>
      </div>
    </footer>
  `
}

// Tab-specific render functions
function renderSignalsTab(): void {
  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderSignalsContent()
    setupTabEventListeners()
  }
}

function renderEffectsTab(): void {
  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderEffectsContent()
    setupTabEventListeners()
  }
}

function renderComponentsTab(): void {
  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderComponentsContent()
    setupTabEventListeners()
  }
}

function renderTimelineTab(): void {
  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderTimelineContent()
    setupTabEventListeners()
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

function setupEventListeners(): void {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', e => {
      const target = e.currentTarget as HTMLElement
      const tabId = target.dataset.tab as PanelTab
      if (tabId && tabId !== state.activeTab) {
        state.activeTab = tabId
        render()
      }
    })
  })

  // Search
  const searchInput = document.getElementById('search-input') as HTMLInputElement
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      state.searchQuery = (e.target as HTMLInputElement).value
      renderActiveTabContent()
    })
  }

  const clearSearch = document.getElementById('clear-search')
  if (clearSearch) {
    clearSearch.addEventListener('click', () => {
      state.searchQuery = ''
      render()
    })
  }

  // Refresh button
  const refreshBtn = document.getElementById('refresh-btn')
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      sendToPage('request:signals')
      sendToPage('request:effects')
      sendToPage('request:components')
      sendToPage('request:timeline', { limit: 200 })
    })
  }

  // Retry connection
  const retryBtn = document.getElementById('retry-connect')
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      sendToPage('connect')
    })
  }

  setupTabEventListeners()
}

function setupTabEventListeners(): void {
  // Signal/Computed rows
  document.querySelectorAll('.signal-row, .effect-row, .component-row').forEach(row => {
    row.addEventListener('click', e => {
      const target = e.currentTarget as HTMLElement
      const nodeType = target.dataset.nodeType
      const id = parseInt(
        target.dataset.signalId ||
          target.dataset.computedId ||
          target.dataset.effectId ||
          target.dataset.componentId ||
          '0',
        10,
      )

      if (id) {
        state.selectedNodeId = id
        state.selectedNodeType = nodeType as NodeType
        // Remove previous selection
        document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'))
        target.classList.add('selected')
      }
    })
  })

  // Expand buttons
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      const id = parseInt(target.dataset.expand || '0', 10)
      if (id) {
        if (state.expandedIds.has(id)) {
          state.expandedIds.delete(id)
        } else {
          state.expandedIds.add(id)
        }
        renderComponentsTab()
      }
    })
  })

  // Timeline controls
  const clearTimeline = document.getElementById('clear-timeline')
  if (clearTimeline) {
    clearTimeline.addEventListener('click', () => {
      state.timeline = []
      sendToPage('clear:timeline')
      renderTimelineTab()
    })
  }

  const recordTimeline = document.getElementById('record-timeline') as HTMLInputElement
  if (recordTimeline) {
    recordTimeline.addEventListener('change', e => {
      state.settings.recordTimeline = (e.target as HTMLInputElement).checked
      sendToPage('set:settings', { recordTimeline: state.settings.recordTimeline })
    })
  }

  // Settings
  const themeSelect = document.getElementById('setting-theme') as HTMLSelectElement
  if (themeSelect) {
    themeSelect.addEventListener('change', e => {
      state.settings.theme = (e.target as HTMLSelectElement).value as 'light' | 'dark' | 'system'
      render()
    })
  }

  const highlightCheck = document.getElementById('setting-highlight') as HTMLInputElement
  if (highlightCheck) {
    highlightCheck.addEventListener('change', e => {
      state.settings.highlightUpdates = (e.target as HTMLInputElement).checked
    })
  }

  const highPerfCheck = document.getElementById('setting-highperf') as HTMLInputElement
  if (highPerfCheck) {
    highPerfCheck.addEventListener('change', e => {
      state.settings.highPerfMode = (e.target as HTMLInputElement).checked
      sendToPage('set:settings', { highPerfMode: state.settings.highPerfMode })
    })
  }

  const maxEventsInput = document.getElementById('setting-max-events') as HTMLInputElement
  if (maxEventsInput) {
    maxEventsInput.addEventListener('change', e => {
      state.settings.maxTimelineEvents = parseInt((e.target as HTMLInputElement).value, 10)
    })
  }
}

function renderActiveTabContent(): void {
  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderActiveTab()
    setupTabEventListeners()
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function filterItems<T extends { name?: string; id: number }>(items: T[], query: string): T[] {
  if (!query) return items
  const lower = query.toLowerCase()
  return items.filter(
    item =>
      (item.name && item.name.toLowerCase().includes(lower)) || String(item.id).includes(lower),
  )
}

function getTimelineEventIcon(type: TimelineEventType): string {
  switch (type) {
    case TimelineEventType.SignalCreate:
      return '📊'
    case TimelineEventType.SignalUpdate:
      return '✏️'
    case TimelineEventType.ComputedCreate:
      return '🔄'
    case TimelineEventType.ComputedUpdate:
      return '🔄'
    case TimelineEventType.EffectCreate:
      return '⚡'
    case TimelineEventType.EffectRun:
      return '▶️'
    case TimelineEventType.EffectCleanup:
      return '🧹'
    case TimelineEventType.EffectDispose:
      return '🗑️'
    case TimelineEventType.ComponentMount:
      return '🟢'
    case TimelineEventType.ComponentUnmount:
      return '⚪'
    case TimelineEventType.ComponentRender:
      return '🎨'
    case TimelineEventType.BatchStart:
      return '📦'
    case TimelineEventType.BatchEnd:
      return '📦'
    case TimelineEventType.FlushStart:
      return '💨'
    case TimelineEventType.FlushEnd:
      return '💨'
    case TimelineEventType.Error:
      return '❌'
    case TimelineEventType.Warning:
      return '⚠️'
    default:
      return '•'
  }
}

function getTimelineEventColor(type: TimelineEventType): string {
  switch (type) {
    case TimelineEventType.SignalCreate:
    case TimelineEventType.SignalUpdate:
      return '#42b883'
    case TimelineEventType.ComputedCreate:
    case TimelineEventType.ComputedUpdate:
      return '#3b82f6'
    case TimelineEventType.EffectCreate:
    case TimelineEventType.EffectRun:
    case TimelineEventType.EffectCleanup:
    case TimelineEventType.EffectDispose:
      return '#f59e0b'
    case TimelineEventType.ComponentMount:
    case TimelineEventType.ComponentUnmount:
    case TimelineEventType.ComponentRender:
      return '#8b5cf6'
    case TimelineEventType.BatchStart:
    case TimelineEventType.BatchEnd:
    case TimelineEventType.FlushStart:
    case TimelineEventType.FlushEnd:
      return '#6b7280'
    case TimelineEventType.Error:
      return '#ef4444'
    case TimelineEventType.Warning:
      return '#f59e0b'
    default:
      return '#9ca3af'
  }
}

function formatEventType(type: TimelineEventType): string {
  return type
    .replace(':', ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  // Listen for messages from background/hook
  window.addEventListener('message', event => {
    if (event.data?.source === MessageSource.Hook) {
      handleMessage(event.data)
    }
  })

  // Also listen for custom events (used by standalone mode)
  document.addEventListener('fict-devtools-message', ((event: CustomEvent) => {
    if (event.detail?.source === MessageSource.Hook) {
      handleMessage(event.detail)
    }
  }) as EventListener)

  // Connect to background (or setup standalone mode)
  connectToBackground()

  // Initial render
  render()

  // Periodic refresh of relative times
  setInterval(() => {
    if (state.isConnected) {
      // Just update footer time display
      const lastUpdate = document.querySelector('.last-update')
      if (lastUpdate && state.lastUpdate) {
        lastUpdate.textContent = `Updated ${formatRelativeTime(state.lastUpdate)}`
      }
    }
  }, 5000)
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

export {}
