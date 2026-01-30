/**
 * Fict DevTools Panel
 *
 * Main panel UI for the DevTools browser extension.
 * Displays signals, effects, components, timeline, and dependency graph.
 */

import {
  setPanelIntegration,
  dispatchPluginMessage,
  getPluginTabs,
  getPluginTimelineLayers,
  type PluginState,
} from '../core/plugin'
import type {
  DependencyGraph,
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
} from '../core/types'

import { GraphRenderer } from './graph-renderer'
import { filterItems as fuzzyFilterItems, highlightMatches } from './search'
import {
  renderTimeline,
  renderEventDetails,
  toggleLayer,
  toggleAllLayers,
  createDefaultLayers,
  type TimelineLayer,
} from './timeline-renderer'
import { VirtualList, shouldUseVirtualList } from './virtual-list'

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
let graphRenderer: GraphRenderer | null = null
let currentGraph: DependencyGraph | null = null
let signalsVirtualList: VirtualList<SignalState | ComputedState> | null = null
let effectsVirtualList: VirtualList<EffectState> | null = null
let timelineLayers: TimelineLayer[] = createDefaultLayers()
let selectedTimelineEvent: TimelineEvent | null = null

// Graph auto-refresh state
let graphAutoRefresh = true
let graphAutoRefreshNodeId: number | null = null
let graphRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
const GRAPH_REFRESH_DEBOUNCE_MS = 300

// Inline editing state
let editingSignalId: number | null = null

// Graph search state
let graphSearchQuery = ''

const VIRTUAL_LIST_THRESHOLD = 50
const SIGNAL_ROW_HEIGHT = 56
const EFFECT_ROW_HEIGHT = 56

// Plugin system notifications queue
const notificationQueue: { message: string; type: 'info' | 'warning' | 'error' }[] = []

// Initialize plugin integration
function initPluginIntegration(): void {
  setPanelIntegration({
    sendToPage,
    getState: (): PluginState => ({
      isConnected: state.isConnected,
      activeTab: state.activeTab,
      selectedNodeId: state.selectedNodeId,
      selectedNodeType: state.selectedNodeType as string | null,
      signalCount: state.signals.size,
      effectCount: state.effects.size,
      componentCount: state.components.size,
      timelineEventCount: state.timeline.length,
    }),
    notify: (message: string, type: 'info' | 'warning' | 'error' = 'info') => {
      notificationQueue.push({ message, type })
      showNotification(message, type)
    },
    addTimelineEvent: (event: TimelineEvent) => {
      state.timeline.push(event)
      if (state.timeline.length > state.settings.maxTimelineEvents) {
        state.timeline.shift()
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'timeline') renderTimelineTab()
    },
  })
}

// Show notification toast
function showNotification(message: string, type: 'info' | 'warning' | 'error'): void {
  const container = document.querySelector('.devtools-panel')
  if (!container) return

  const toast = document.createElement('div')
  toast.className = `notification-toast notification-${type}`
  toast.textContent = message

  container.appendChild(toast)

  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.classList.add('fade-out')
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

// ============================================================================
// Utility Functions
// ============================================================================

function resetPanelState(
  options: { keepConnection?: boolean; keepDetection?: boolean } = {},
): void {
  state.signals.clear()
  state.computeds.clear()
  state.effects.clear()
  state.components.clear()
  state.roots.clear()
  state.timeline = []
  state.selectedNodeId = null
  state.selectedNodeType = null
  state.expandedIds.clear()
  state.searchQuery = ''
  state.isConnected = options.keepConnection ? state.isConnected : false
  state.fictDetected = options.keepDetection ? state.fictDetected : false
  state.lastUpdate = Date.now()
  selectedTimelineEvent = null
  currentGraph = null
  graphAutoRefreshNodeId = null
  if (graphRenderer) {
    graphRenderer.setGraph(null)
  }
}

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

function escapeHtml(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value ?? '')
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightMatch(text: string, query: string): string {
  return highlightMatches(text, query)
}

function toDisplayName(name: unknown, fallback: string): string {
  if (typeof name === 'string') return name
  if (name == null) return fallback
  try {
    if (typeof name === 'object') {
      const json = JSON.stringify(name)
      if (json && json !== '{}') return json
    }
    return String(name)
  } catch {
    return fallback
  }
}

// ============================================================================
// Runtime Type Validation
// ============================================================================

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSignalState(value: unknown): value is SignalState {
  return typeof value === 'object' && value !== null && isValidId((value as SignalState).id)
}

function isComputedState(value: unknown): value is ComputedState {
  return typeof value === 'object' && value !== null && isValidId((value as ComputedState).id)
}

function isEffectState(value: unknown): value is EffectState {
  return typeof value === 'object' && value !== null && isValidId((value as EffectState).id)
}

function isComponentState(value: unknown): value is ComponentState {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidId((value as ComponentState).id) &&
    typeof (value as ComponentState).name === 'string'
  )
}

function hasId(value: unknown): value is { id: number } {
  return typeof value === 'object' && value !== null && isValidId((value as { id: number }).id)
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
  console.debug('[Fict DevTools Panel] sendToPage:', type, payload)

  const message = {
    source: MessageSource.Panel,
    type,
    payload,
    timestamp: Date.now(),
  }

  if (port) {
    // Chrome extension mode - send via port
    console.debug('[Fict DevTools Panel] Sending via port')
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

/**
 * Open a file in the user's code editor via Vite's __open-in-editor API
 */
function openInEditor(file: string, line: number, column: number): void {
  const location = `${file}:${line}:${column}`
  console.debug('[Fict DevTools Panel] Opening in editor:', location)

  fetch(`/__open-in-editor?file=${encodeURIComponent(location)}`).catch(err => {
    console.error('[Fict DevTools] Failed to open in editor:', err)
  })
}

function handleMessage(message: Record<string, unknown>): void {
  const { type, payload } = message

  // Dispatch to plugin handlers
  dispatchPluginMessage(type as string, payload)

  console.debug('[Fict DevTools Panel] handleMessage:', JSON.stringify(message))

  switch (type) {
    case 'page-navigating':
      // Page is reloading/navigating - clear state for fresh connection
      console.debug('[Fict DevTools Panel] Page navigating, clearing state')
      state.isConnected = false
      state.fictDetected = false
      state.fictVersion = undefined
      state.signals.clear()
      state.computeds.clear()
      state.effects.clear()
      state.components.clear()
      state.timeline = []
      state.selectedNodeId = null
      state.lastUpdate = Date.now()
      currentGraph = null
      graphAutoRefreshNodeId = null
      editingSignalId = null
      graphSearchQuery = ''
      render()
      break

    case 'fict-detected':
      console.debug('[Fict DevTools Panel] Fict detected, requesting initial state')
      resetPanelState({ keepConnection: true, keepDetection: true })
      state.fictDetected = true
      state.fictVersion = (payload as { version?: string })?.version
      state.isConnected = true
      render()
      // Request initial state after reconnection
      sendToPage('connect')
      break

    case 'hook-ready':
      // Hook just attached (app loaded after panel)
      // Re-send connect to trigger initial state
      console.debug('[Fict DevTools Panel] Hook ready, requesting state')
      state.isConnected = true
      state.fictDetected = true
      sendToPage('connect')
      render()
      break

    case 'disconnect':
    case 'hook:disconnect':
      resetPanelState()
      state.isConnected = false
      state.fictDetected = false
      render()
      break

    case 'state:init':
      handleInitialState(payload as InitialState)
      break

    case 'signal:register':
      if (!isSignalState(payload)) return
      state.signals.set(payload.id, payload)
      // Link signal to owner component
      if (payload.ownerId !== undefined) {
        const ownerComponent = state.components.get(payload.ownerId)
        if (ownerComponent && !ownerComponent.signals.includes(payload.id)) {
          ownerComponent.signals.push(payload.id)
        }
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'signal:update':
      if (!hasId(payload)) return
      updateSignal(payload as SignalUpdate)
      scheduleGraphRefresh()
      break

    case 'signal:dispose':
      if (!hasId(payload)) return
      state.signals.delete(payload.id)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'computed:register':
      if (!isComputedState(payload)) return
      state.computeds.set(payload.id, payload)
      // Link computed to owner component
      if (payload.ownerId !== undefined) {
        const ownerComponent = state.components.get(payload.ownerId)
        if (ownerComponent && !ownerComponent.computeds.includes(payload.id)) {
          ownerComponent.computeds.push(payload.id)
        }
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'computed:update':
      if (!hasId(payload)) return
      updateComputed(payload as ComputedUpdate)
      scheduleGraphRefresh()
      break

    case 'effect:register':
      if (!isEffectState(payload)) return
      state.effects.set(payload.id, payload)
      // Link effect to owner component
      if (payload.ownerId !== undefined) {
        const ownerComponent = state.components.get(payload.ownerId)
        if (ownerComponent && !ownerComponent.effects.includes(payload.id)) {
          ownerComponent.effects.push(payload.id)
        }
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'effect:run':
      if (!hasId(payload)) return
      updateEffect(payload as EffectUpdate)
      scheduleGraphRefresh()
      break

    case 'effect:dispose':
      if (!hasId(payload)) return
      state.effects.delete(payload.id)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'signal:observers': {
      if (!hasId(payload)) return
      const signal = state.signals.get(payload.id)
      if (signal && Array.isArray((payload as { observers: number[] }).observers)) {
        signal.observers = (payload as { observers: number[] }).observers
        state.lastUpdate = Date.now()
        if (state.activeTab === 'signals') renderSignalsTab()
      }
      break
    }

    case 'computed:observers': {
      if (!hasId(payload)) return
      const computed = state.computeds.get(payload.id)
      if (computed && Array.isArray((payload as { observers: number[] }).observers)) {
        computed.observers = (payload as { observers: number[] }).observers
        state.lastUpdate = Date.now()
        if (state.activeTab === 'signals') renderSignalsTab()
      }
      break
    }

    case 'computed:dependencies': {
      if (!hasId(payload)) return
      const computed = state.computeds.get(payload.id)
      if (computed && Array.isArray((payload as { dependencies: number[] }).dependencies)) {
        computed.dependencies = (payload as { dependencies: number[] }).dependencies
        state.lastUpdate = Date.now()
        if (state.activeTab === 'signals') renderSignalsTab()
      }
      break
    }

    case 'effect:dependencies': {
      if (!hasId(payload)) return
      const effect = state.effects.get(payload.id)
      if (effect && Array.isArray((payload as { dependencies: number[] }).dependencies)) {
        effect.dependencies = (payload as { dependencies: number[] }).dependencies
        state.lastUpdate = Date.now()
        if (state.activeTab === 'effects') renderEffectsTab()
      }
      break
    }

    case 'component:register':
      if (!isComponentState(payload)) return
      state.components.set(payload.id, payload)
      state.lastUpdate = Date.now()
      if (state.activeTab === 'components') renderComponentsTab()
      break

    case 'component:mount':
    case 'component:unmount':
    case 'component:render':
      if (!hasId(payload)) return
      updateComponent(payload as ComponentUpdate)
      break

    case 'timeline:event':
      if (!payload || typeof payload !== 'object') return
      state.timeline.push(payload as TimelineEvent)
      if (state.timeline.length > state.settings.maxTimelineEvents) {
        state.timeline.shift()
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'timeline') renderTimelineTab()
      break

    case 'response:signals':
      if (!Array.isArray(payload)) return
      state.signals.clear()
      for (const signal of payload) {
        if (isSignalState(signal)) {
          state.signals.set(signal.id, signal)
        }
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'signals') renderSignalsTab()
      break

    case 'response:effects':
      if (!Array.isArray(payload)) return
      state.effects.clear()
      for (const effect of payload) {
        if (isEffectState(effect)) {
          state.effects.set(effect.id, effect)
        }
      }
      state.lastUpdate = Date.now()
      if (state.activeTab === 'effects') renderEffectsTab()
      break

    case 'response:timeline':
      if (!Array.isArray(payload)) return
      state.timeline = payload as TimelineEvent[]
      state.lastUpdate = Date.now()
      if (state.activeTab === 'timeline') renderTimelineTab()
      break

    case 'response:dependencyGraph':
      currentGraph = payload as DependencyGraph | null
      if (state.activeTab === 'graph') {
        updateGraphRenderer()
        updateGraphDetails()
      }
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

  for (const signal of data.signals ?? []) {
    state.signals.set(signal.id, signal)
  }
  for (const computed of data.computeds ?? []) {
    state.computeds.set(computed.id, computed)
  }
  for (const effect of data.effects ?? []) {
    state.effects.set(effect.id, effect)
  }
  for (const component of data.components ?? []) {
    state.components.set(component.id, component)
  }
  for (const root of data.roots ?? []) {
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
  const builtinTabs: { id: PanelTab | string; label: string; count?: number; icon?: string }[] = [
    { id: 'signals', label: 'Signals', count: state.signals.size + state.computeds.size },
    { id: 'effects', label: 'Effects', count: state.effects.size },
    { id: 'components', label: 'Components', count: state.components.size },
    { id: 'timeline', label: 'Timeline', count: state.timeline.length },
    { id: 'graph', label: 'Graph' },
    { id: 'settings', label: 'Settings' },
  ]

  // Add plugin tabs
  const pluginTabs = getPluginTabs().map(tab => ({
    id: `plugin:${tab.id}`,
    label: tab.label,
    icon: tab.icon,
    count: typeof tab.badge === 'function' ? tab.badge() : tab.badge,
    isPlugin: true,
  }))

  const allTabs = [...builtinTabs, ...pluginTabs]

  return `
    <nav class="panel-tabs">
      ${allTabs
        .map(
          tab => `
        <button
          class="tab ${state.activeTab === tab.id ? 'active' : ''}"
          data-tab="${tab.id}"
        >
          ${tab.icon ? `<span class="tab-icon">${tab.icon}</span>` : ''}
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
  // Check if this is a plugin tab
  if (state.activeTab.startsWith('plugin:')) {
    const pluginTabId = state.activeTab.replace('plugin:', '')
    const pluginTab = getPluginTabs().find(t => t.id === pluginTabId)
    if (pluginTab) {
      return `<div class="plugin-tab-content" data-plugin-tab="${pluginTabId}">${pluginTab.render()}</div>`
    }
    return '<div class="empty-message">Plugin tab not found</div>'
  }

  switch (state.activeTab) {
    case 'signals':
      return renderSignalsContent()
    case 'effects':
      return renderEffectsContent()
    case 'components':
      return renderComponentsContent()
    case 'timeline':
      return renderTimelineContent()
    case 'graph':
      return renderGraphContent()
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
  const allItems: (SignalState | ComputedState)[] = [...filteredSignals, ...filteredComputeds]

  if (allItems.length === 0) {
    return '<div class="empty-message">No signals or computed values</div>'
  }

  // Use virtual list for large datasets
  if (shouldUseVirtualList(allItems.length, VIRTUAL_LIST_THRESHOLD)) {
    return `
      <div class="signals-section">
        <div class="section-header">
          <h3>Signals & Computed (${allItems.length})</h3>
          <span class="hint" style="font-size: 10px; color: var(--text-muted)">Virtual scroll enabled</span>
        </div>
        <div class="signals-virtual-list" id="signals-virtual-container" style="height: calc(100vh - 200px);"></div>
      </div>
    `
  }

  // Regular rendering for smaller lists
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
  const name = toDisplayName(signal.name, `Signal #${signal.id}`)
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)

  return `
    <div
      class="signal-row ${state.selectedNodeId === signal.id ? 'selected' : ''}"
      data-signal-id="${signal.id}"
      data-node-type="signal"
    >
      <div class="signal-icon">📊</div>
      <div class="signal-info">
        <div class="signal-name">${displayName}</div>
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
      <div class="row-actions">
        <button class="btn-icon expose-btn" data-expose-type="signal" data-expose-id="${signal.id}" title="Expose to console as $signal0">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${signal.id}" title="View dependency graph">⊛</button>
      </div>
    </div>
  `
}

function renderComputedRow(computed: ComputedState): string {
  const name = toDisplayName(computed.name, `Computed #${computed.id}`)
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)

  return `
    <div
      class="signal-row computed ${computed.isDirty ? 'dirty' : ''} ${state.selectedNodeId === computed.id ? 'selected' : ''}"
      data-computed-id="${computed.id}"
      data-node-type="computed"
    >
      <div class="signal-icon">🔄</div>
      <div class="signal-info">
        <div class="signal-name">${displayName}</div>
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
      <div class="row-actions">
        <button class="btn-icon expose-btn" data-expose-type="computed" data-expose-id="${computed.id}" title="Expose to console as $signal0">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${computed.id}" title="View dependency graph">⊛</button>
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

  // Use virtual list for large datasets
  if (shouldUseVirtualList(filtered.length, VIRTUAL_LIST_THRESHOLD)) {
    return `
      <div class="effects-section">
        <div class="section-header">
          <h3>Effects (${filtered.length})</h3>
          <span class="hint" style="font-size: 10px; color: var(--text-muted)">Virtual scroll enabled</span>
        </div>
        <div class="effects-virtual-list" id="effects-virtual-container" style="height: calc(100vh - 200px);"></div>
      </div>
    `
  }

  return `
    <div class="effects-list">
      ${filtered.map(renderEffectRow).join('')}
    </div>
  `
}

function renderEffectRow(effect: EffectState): string {
  const name = toDisplayName(effect.name, `Effect #${effect.id}`)
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)

  return `
    <div
      class="effect-row ${effect.isActive ? 'active' : 'inactive'} ${state.selectedNodeId === effect.id ? 'selected' : ''}"
      data-effect-id="${effect.id}"
      data-node-type="effect"
    >
      <div class="effect-icon">${effect.isActive ? '⚡' : '○'}</div>
      <div class="effect-info">
        <div class="effect-name">${displayName}</div>
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
      <div class="row-actions">
        <button class="btn-icon expose-btn" data-expose-type="effect" data-expose-id="${effect.id}" title="Expose to console as $effect0">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${effect.id}" title="View dependency graph">⊛</button>
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

  // Get selected component for details panel
  const selectedComponent =
    state.selectedNodeId !== null && state.selectedNodeType === 'component'
      ? state.components.get(state.selectedNodeId)
      : null

  return `
    <div class="components-container">
      <div class="components-tree-panel">
        <div class="components-tree">
          ${roots.map(c => renderComponentNode(c, filtered)).join('')}
        </div>
      </div>
      <div class="component-details-panel">
        ${
          selectedComponent
            ? renderComponentDetails(selectedComponent)
            : '<div class="hint" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Select a component to view details</div>'
        }
      </div>
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
  const displayName = state.searchQuery
    ? highlightMatch(component.name, state.searchQuery)
    : escapeHtml(component.name)

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
        <span class="component-name">${displayName}</span>
        <span class="component-meta">
          ${component.signals.length > 0 ? `${component.signals.length}S` : ''}
          ${component.effects.length > 0 ? `${component.effects.length}E` : ''}
          ${component.renderCount > 0 ? `• ${component.renderCount} renders` : ''}
        </span>
        <div class="row-actions">
          <button class="btn-icon expose-btn" data-expose-type="component" data-expose-id="${component.id}" title="Expose to console as $component0">$</button>
        </div>
      </div>
      ${hasChildren && isExpanded ? `<div class="component-children">${children.map(c => renderComponentNode(c, allComponents, depth + 1)).join('')}</div>` : ''}
    </div>
  `
}

function renderComponentDetails(component: ComponentState): string {
  // Get related signals, computeds, effects
  const componentSignals = component.signals
    .map(id => state.signals.get(id))
    .filter(Boolean) as SignalState[]
  const componentComputeds = component.computeds
    .map(id => state.computeds.get(id))
    .filter(Boolean) as ComputedState[]
  const componentEffects = component.effects
    .map(id => state.effects.get(id))
    .filter(Boolean) as EffectState[]

  const sourceFileName = component.source?.file?.split('/').pop() ?? ''

  return `
    <div class="component-details">
      <div class="details-header">
        <span class="component-icon">${component.isMounted ? '🟢' : '⚪'}</span>
        <h3>${escapeHtml(component.name)}</h3>
        <span class="component-status ${component.isMounted ? 'mounted' : 'unmounted'}">
          ${component.isMounted ? 'Mounted' : 'Unmounted'}
        </span>
      </div>

      ${
        component.source
          ? `
        <div class="detail-section">
          <h4>📍 Source</h4>
          <a href="#" class="source-link" 
             data-file="${escapeHtml(component.source.file)}" 
             data-line="${component.source.line}" 
             data-column="${component.source.column}">
            ${escapeHtml(sourceFileName)}:${component.source.line}
          </a>
        </div>
      `
          : ''
      }

      <div class="detail-section">
        <h4>📊 Statistics</h4>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-value">${component.renderCount}</span>
            <span class="stat-label">Renders</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${componentSignals.length + componentComputeds.length}</span>
            <span class="stat-label">Signals</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${componentEffects.length}</span>
            <span class="stat-label">Effects</span>
          </div>
        </div>
      </div>

      ${
        component.props && Object.keys(component.props).length > 0
          ? `
        <div class="detail-section">
          <h4>🔧 Props</h4>
          <div class="props-list">
            ${Object.entries(component.props)
              .map(
                ([key, value]) => `
              <div class="prop-item">
                <span class="prop-name">${escapeHtml(key)}</span>
                <span class="prop-value">${escapeHtml(formatValue(value, 50))}</span>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      ${
        componentSignals.length > 0
          ? `
        <div class="detail-section">
          <h4>📊 Signals (${componentSignals.length})</h4>
          <div class="reactive-list">
            ${componentSignals
              .map(
                signal => `
              <div class="reactive-item signal" data-signal-id="${signal.id}" data-node-type="signal">
                <span class="reactive-name">${escapeHtml(toDisplayName(signal.name, `Signal #${signal.id}`))}</span>
                <span class="reactive-value">${escapeHtml(formatValue(signal.value, 30))}</span>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      ${
        componentComputeds.length > 0
          ? `
        <div class="detail-section">
          <h4>🔄 Computed (${componentComputeds.length})</h4>
          <div class="reactive-list">
            ${componentComputeds
              .map(
                comp => `
              <div class="reactive-item computed" data-computed-id="${comp.id}" data-node-type="computed">
                <span class="reactive-name">${escapeHtml(toDisplayName(comp.name, `Computed #${comp.id}`))}</span>
                <span class="reactive-value">${escapeHtml(formatValue(comp.value, 30))}</span>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      ${
        componentEffects.length > 0
          ? `
        <div class="detail-section">
          <h4>⚡ Effects (${componentEffects.length})</h4>
          <div class="reactive-list">
            ${componentEffects
              .map(
                effect => `
              <div class="reactive-item effect" data-effect-id="${effect.id}" data-node-type="effect">
                <span class="reactive-name">${escapeHtml(toDisplayName(effect.name, `Effect #${effect.id}`))}</span>
                <span class="reactive-meta">${effect.runCount} runs</span>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }
    </div>
  `
}

function renderTimelineContent(): string {
  // Combine built-in layers with plugin layers
  const pluginLayers = getPluginTimelineLayers()
  const allLayers = [...timelineLayers, ...pluginLayers]

  if (state.timeline.length === 0) {
    return `
      <div class="timeline-controls" style="margin-bottom: 8px;">
        <button class="btn" id="clear-timeline">Clear</button>
        <label class="checkbox">
          <input type="checkbox" id="record-timeline" ${state.settings.recordTimeline ? 'checked' : ''}>
          Record events
        </label>
      </div>
      <div class="empty-message">No timeline events recorded</div>
    `
  }

  const events = state.timeline.slice().reverse()

  return `
    <div class="timeline-controls" style="margin-bottom: 8px;">
      <button class="btn" id="clear-timeline">Clear</button>
      <label class="checkbox">
        <input type="checkbox" id="record-timeline" ${state.settings.recordTimeline ? 'checked' : ''}>
        Record events
      </label>
      <span style="margin-left: auto; font-size: 11px; color: var(--text-muted)">${events.length} events</span>
    </div>
    ${renderTimeline(events, allLayers, selectedTimelineEvent?.id ?? null)}
  `
}

function updateTimelineEventDetails(): void {
  const detailsEl = document.getElementById('timeline-event-details')
  if (detailsEl) {
    detailsEl.innerHTML = renderEventDetails(selectedTimelineEvent, timelineLayers)
  }
}

function renderGraphContent(): string {
  const signals = Array.from(state.signals.values())
  const computeds = Array.from(state.computeds.values())
  const effects = Array.from(state.effects.values())

  return `
    <div class="graph-container">
      <div class="graph-sidebar">
        <div class="sidebar-header">
          <h3>Select Node</h3>
          <label class="checkbox auto-refresh-toggle" title="Auto-refresh graph when dependencies change">
            <input type="checkbox" id="graph-auto-refresh" ${graphAutoRefresh ? 'checked' : ''}>
            <span>Auto</span>
          </label>
        </div>
        <div class="node-selector">
          <input type="text" class="graph-search-input" id="graph-search-input" placeholder="Search nodes..." value="${escapeHtml(graphSearchQuery)}" />
          <select id="graph-node-type">
            <option value="signal">Signals (${signals.length})</option>
            <option value="computed">Computed (${computeds.length})</option>
            <option value="effect">Effects (${effects.length})</option>
          </select>
          <div class="node-list" id="graph-node-list">
            ${renderGraphNodeList('signal', signals)}
          </div>
        </div>
      </div>
      <div class="graph-canvas" id="graph-canvas"></div>
      <div class="graph-details" id="graph-details">
        ${currentGraph ? renderGraphDetails() : '<p class="hint">Select a node to view its dependency graph</p>'}
      </div>
    </div>
  `
}

function scheduleGraphRefresh(): void {
  if (!graphAutoRefresh || !graphAutoRefreshNodeId || state.activeTab !== 'graph') return

  if (graphRefreshDebounceTimer) {
    clearTimeout(graphRefreshDebounceTimer)
  }

  graphRefreshDebounceTimer = setTimeout(() => {
    graphRefreshDebounceTimer = null
    sendToPage('request:dependencyGraph', { nodeId: graphAutoRefreshNodeId })
  }, GRAPH_REFRESH_DEBOUNCE_MS)
}

function renderGraphNodeList(type: string, items: { id: number; name?: string }[]): string {
  if (items.length === 0) {
    return '<div class="empty-message" style="height: 60px">No items</div>'
  }

  return items
    .map(
      item => `
    <div
      class="node-list-item ${state.selectedNodeId === item.id ? 'selected' : ''}"
      data-graph-node-id="${item.id}"
      data-graph-node-type="${type}"
    >
      ${escapeHtml(toDisplayName(item.name, `${type} #${item.id}`))}
    </div>
  `,
    )
    .join('')
}

function renderGraphDetails(): string {
  if (!currentGraph) return ''

  const rootNode = currentGraph.nodes.get(currentGraph.rootId)
  if (!rootNode) return ''

  const sources = rootNode.sources.map(id => currentGraph!.nodes.get(id)).filter(Boolean)
  const observers = rootNode.observers.map(id => currentGraph!.nodes.get(id)).filter(Boolean)

  return `
    <div class="details-header">
      <span class="event-icon">${getNodeIcon(rootNode.type)}</span>
      <span class="event-type">${escapeHtml(toDisplayName(rootNode.name, `${rootNode.type} #${rootNode.id}`))}</span>
    </div>
    <div class="details-content">
      <div class="detail-row">
        <span class="label">Type</span>
        <span class="value">${rootNode.type}</span>
      </div>
      <div class="detail-row">
        <span class="label">ID</span>
        <span class="value">#${rootNode.id}</span>
      </div>
      ${
        rootNode.value !== undefined
          ? `
        <div class="detail-row">
          <span class="label">Value</span>
          <span class="value" title="${escapeHtml(formatValue(rootNode.value, 200))}">${escapeHtml(formatValue(rootNode.value, 50))}</span>
        </div>
      `
          : ''
      }
      ${
        rootNode.isDirty !== undefined
          ? `
        <div class="detail-row">
          <span class="label">Dirty</span>
          <span class="value">${rootNode.isDirty ? 'Yes' : 'No'}</span>
        </div>
      `
          : ''
      }
        <div class="detail-section">
          <span class="label">Dependencies (${sources.length})</span>
          <div class="data-preview" style="max-height: 100px">
          ${
            sources.length > 0
              ? sources.map(n => `• ${toDisplayName(n!.name, `${n!.type} #${n!.id}`)}`).join('\n')
              : 'None'
          }
          </div>
        </div>
        <div class="detail-section">
          <span class="label">Observers (${observers.length})</span>
          <div class="data-preview" style="max-height: 100px">
          ${
            observers.length > 0
              ? observers.map(n => `• ${toDisplayName(n!.name, `${n!.type} #${n!.id}`)}`).join('\n')
              : 'None'
          }
          </div>
        </div>
      </div>
  `
}

function getNodeIcon(type: NodeType | string): string {
  switch (type) {
    case 'signal':
      return '📊'
    case 'computed':
      return '🔄'
    case 'effect':
      return '⚡'
    case 'component':
      return '🧩'
    default:
      return '•'
  }
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
  // Cleanup existing virtual list
  if (signalsVirtualList) {
    signalsVirtualList.destroy()
    signalsVirtualList = null
  }

  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderSignalsContent()
    setupTabEventListeners()
    initSignalsVirtualList()
  }
}

function initSignalsVirtualList(): void {
  const container = document.getElementById('signals-virtual-container')
  if (!container) return

  const signals = Array.from(state.signals.values())
  const computeds = Array.from(state.computeds.values())
  const filteredSignals = filterItems(signals, state.searchQuery)
  const filteredComputeds = filterItems(computeds, state.searchQuery)
  const allItems: (SignalState | ComputedState)[] = [...filteredSignals, ...filteredComputeds]

  if (!shouldUseVirtualList(allItems.length, VIRTUAL_LIST_THRESHOLD)) return

  signalsVirtualList = new VirtualList({
    container,
    items: allItems,
    itemHeight: SIGNAL_ROW_HEIGHT,
    renderItem: item => {
      if ('isDirty' in item) {
        return renderComputedRowContent(item as ComputedState)
      }
      return renderSignalRowContent(item as SignalState)
    },
    onItemClick: (item, index, event) => {
      // Check if clicking on action buttons
      if ((event.target as HTMLElement).closest('.row-actions')) {
        const target = event.target as HTMLElement
        const btn = target.closest('button') as HTMLElement
        if (btn) {
          if (btn.classList.contains('expose-btn')) {
            const type = btn.dataset.exposeType
            const id = parseInt(btn.dataset.exposeId || '0', 10)
            if (type && id) {
              sendToPage('expose:console', { type, id })
            }
          } else if (btn.classList.contains('graph-btn')) {
            const id = parseInt(btn.dataset.graphId || '0', 10)
            if (id) {
              state.selectedNodeId = id
              state.activeTab = 'graph'
              render()
              sendToPage('request:dependencyGraph', { nodeId: id })
            }
          }
        }
        return
      }

      // Select the item
      state.selectedNodeId = item.id
      state.selectedNodeType = 'isDirty' in item ? 'computed' : ('signal' as NodeType)
      signalsVirtualList?.refresh()
    },
  })
}

function renderSignalRowContent(signal: SignalState): string {
  const name = toDisplayName(signal.name, `Signal #${signal.id}`)
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)
  const isSelected = state.selectedNodeId === signal.id
  const isEditing = editingSignalId === signal.id

  const valueDisplay = isEditing
    ? `<input type="text" class="signal-edit-input" id="signal-edit-input" data-signal-id="${signal.id}" value="${escapeHtml(formatValueForEdit(signal.value))}" autofocus />`
    : `<span class="signal-value-text">${escapeHtml(formatValue(signal.value))}</span>`

  return `
    <div class="signal-row ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''}" style="height: 100%; margin: 0;" data-signal-id="${signal.id}" data-node-type="signal">
      <div class="signal-icon">📊</div>
      <div class="signal-info">
        <div class="signal-name">${displayName}</div>
        <div class="signal-value" title="${escapeHtml(formatValue(signal.value, 200))}">
          ${valueDisplay}
        </div>
      </div>
      <div class="signal-meta">
        <span class="update-count">${signal.updateCount} updates</span>
        <span class="observers-count">${signal.observers.length} obs</span>
      </div>
      <div class="signal-time">
        ${signal.lastUpdatedAt ? formatRelativeTime(signal.lastUpdatedAt) : '-'}
      </div>
      <div class="row-actions" style="opacity: 1;">
        <button class="btn-icon edit-signal-btn" data-signal-id="${signal.id}" title="Edit value">${isEditing ? '✓' : '✏️'}</button>
        ${isEditing ? `<button class="btn-icon cancel-edit-btn" data-signal-id="${signal.id}" title="Cancel">✕</button>` : ''}
        <button class="btn-icon expose-btn" data-expose-type="signal" data-expose-id="${signal.id}" title="Expose to console">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${signal.id}" title="View graph">⊛</button>
      </div>
    </div>
  `
}

function formatValueForEdit(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseEditedValue(input: string): unknown {
  input = input.trim()
  if (input === 'null') return null
  if (input === 'undefined') return undefined
  if (input === 'true') return true
  if (input === 'false') return false
  // Try parsing as number
  if (/^-?\d+(\.\d+)?$/.test(input)) return Number(input)
  // Try parsing as JSON
  try {
    return JSON.parse(input)
  } catch {
    // Return as string
    return input
  }
}

function renderComputedRowContent(computed: ComputedState): string {
  const name = toDisplayName(computed.name, `Computed #${computed.id}`)
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)
  const isSelected = state.selectedNodeId === computed.id

  return `
    <div class="signal-row computed ${computed.isDirty ? 'dirty' : ''} ${isSelected ? 'selected' : ''}" style="height: 100%; margin: 0;">
      <div class="signal-icon">🔄</div>
      <div class="signal-info">
        <div class="signal-name">${displayName}</div>
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
      <div class="row-actions" style="opacity: 1;">
        <button class="btn-icon expose-btn" data-expose-type="computed" data-expose-id="${computed.id}" title="Expose to console">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${computed.id}" title="View graph">⊛</button>
      </div>
    </div>
  `
}

function renderEffectsTab(): void {
  // Cleanup existing virtual list
  if (effectsVirtualList) {
    effectsVirtualList.destroy()
    effectsVirtualList = null
  }

  const content = document.querySelector('.tab-content')
  if (content) {
    content.innerHTML = renderEffectsContent()
    setupTabEventListeners()
    initEffectsVirtualList()
  }
}

function initEffectsVirtualList(): void {
  const container = document.getElementById('effects-virtual-container')
  if (!container) return

  const effects = Array.from(state.effects.values())
  const filtered = filterItems(effects, state.searchQuery)

  if (!shouldUseVirtualList(filtered.length, VIRTUAL_LIST_THRESHOLD)) return

  effectsVirtualList = new VirtualList({
    container,
    items: filtered,
    itemHeight: EFFECT_ROW_HEIGHT,
    renderItem: effect => renderEffectRowContent(effect),
    onItemClick: (item, index, event) => {
      // Check if clicking on action buttons
      if ((event.target as HTMLElement).closest('.row-actions')) {
        const target = event.target as HTMLElement
        const btn = target.closest('button') as HTMLElement
        if (btn) {
          if (btn.classList.contains('expose-btn')) {
            const id = parseInt(btn.dataset.exposeId || '0', 10)
            if (id) {
              sendToPage('expose:console', { type: 'effect', id })
            }
          } else if (btn.classList.contains('graph-btn')) {
            const id = parseInt(btn.dataset.graphId || '0', 10)
            if (id) {
              state.selectedNodeId = id
              state.activeTab = 'graph'
              render()
              sendToPage('request:dependencyGraph', { nodeId: id })
            }
          }
        }
        return
      }

      // Select the item
      state.selectedNodeId = item.id
      state.selectedNodeType = 'effect' as NodeType
      effectsVirtualList?.refresh()
    },
  })
}

function renderEffectRowContent(effect: EffectState): string {
  const name = effect.name || `Effect #${effect.id}`
  const displayName = state.searchQuery ? highlightMatch(name, state.searchQuery) : escapeHtml(name)
  const isSelected = state.selectedNodeId === effect.id

  return `
    <div class="effect-row ${effect.isActive ? 'active' : 'inactive'} ${isSelected ? 'selected' : ''}" style="height: 100%; margin: 0;">
      <div class="effect-icon">${effect.isActive ? '⚡' : '○'}</div>
      <div class="effect-info">
        <div class="effect-name">${displayName}</div>
        <div class="effect-deps">
          ${effect.dependencies.length} deps
          ${effect.hasCleanup ? ' • cleanup' : ''}
        </div>
      </div>
      <div class="effect-meta">
        <span class="run-count">${effect.runCount} runs</span>
        ${effect.lastRunDuration !== undefined ? `<span class="duration">${effect.lastRunDuration.toFixed(1)}ms</span>` : ''}
      </div>
      <div class="effect-time">
        ${effect.lastRunAt ? formatRelativeTime(effect.lastRunAt) : '-'}
      </div>
      <div class="row-actions" style="opacity: 1;">
        <button class="btn-icon expose-btn" data-expose-type="effect" data-expose-id="${effect.id}" title="Expose to console">$</button>
        <button class="btn-icon graph-btn" data-graph-id="${effect.id}" title="View graph">⊛</button>
      </div>
    </div>
  `
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

function initGraphRenderer(): void {
  const container = document.getElementById('graph-canvas')
  if (!container || graphRenderer) return

  graphRenderer = new GraphRenderer({
    container,
    onNodeSelect(nodeId) {
      state.selectedNodeId = nodeId
      graphAutoRefreshNodeId = nodeId
      sendToPage('request:dependencyGraph', { nodeId })
    },
    onNodeHover() {
      // Could show tooltip or highlight related nodes
    },
  })

  // If we have a graph, set it
  if (currentGraph) {
    graphRenderer.setGraph(currentGraph)
  }
}

function updateGraphRenderer(): void {
  if (graphRenderer && currentGraph) {
    graphRenderer.setGraph(currentGraph)
  }
}

function updateGraphDetails(): void {
  const detailsEl = document.getElementById('graph-details')
  if (detailsEl) {
    detailsEl.innerHTML = currentGraph
      ? renderGraphDetails()
      : '<p class="hint">Select a node to view its dependency graph</p>'
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
        // Cleanup previous tab resources
        if (state.activeTab === 'graph' && graphRenderer) {
          graphRenderer.destroy()
          graphRenderer = null
        }

        state.activeTab = tabId
        render()

        // Initialize graph renderer when switching to graph tab
        if (tabId === 'graph') {
          setTimeout(initGraphRenderer, 0)
        }
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
  // Setup plugin tabs
  if (state.activeTab.startsWith('plugin:')) {
    const pluginTabId = state.activeTab.replace('plugin:', '')
    const pluginTab = getPluginTabs().find(t => t.id === pluginTabId)
    if (pluginTab?.setup) {
      const container = document.querySelector(
        `.plugin-tab-content[data-plugin-tab="${pluginTabId}"]`,
      )
      if (container) {
        pluginTab.setup(container as HTMLElement)
      }
    }
  }

  // Expose to console buttons
  document.querySelectorAll('.expose-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      const type = target.dataset.exposeType
      const id = parseInt(target.dataset.exposeId || '0', 10)
      if (type && id) {
        sendToPage('expose:console', { type, id })
      }
    })
  })

  // Edit signal buttons
  document.querySelectorAll('.edit-signal-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      const id = parseInt(target.dataset.signalId || '0', 10)
      if (id) {
        if (editingSignalId === id) {
          // Save the value
          const input = document.querySelector(`#signal-edit-input`) as HTMLInputElement
          if (input) {
            const newValue = parseEditedValue(input.value)
            sendToPage('set:signalValue', { id, value: newValue })
          }
          editingSignalId = null
        } else {
          // Enter edit mode
          editingSignalId = id
        }
        renderSignalsTab()
      }
    })
  })

  // Cancel edit buttons
  document.querySelectorAll('.cancel-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      editingSignalId = null
      renderSignalsTab()
    })
  })

  // Signal edit input keyboard handling
  const editInput = document.getElementById('signal-edit-input') as HTMLInputElement
  if (editInput) {
    editInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const id = parseInt(editInput.dataset.signalId || '0', 10)
        if (id) {
          const newValue = parseEditedValue(editInput.value)
          sendToPage('set:signalValue', { id, value: newValue })
          editingSignalId = null
          renderSignalsTab()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        editingSignalId = null
        renderSignalsTab()
      }
    })
    // Focus the input
    editInput.focus()
    editInput.select()
  }

  // Graph view buttons
  document.querySelectorAll('.graph-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      const id = parseInt(target.dataset.graphId || '0', 10)
      if (id) {
        state.selectedNodeId = id
        state.activeTab = 'graph'
        render()
        // Request dependency graph
        sendToPage('request:dependencyGraph', { nodeId: id })
      }
    })
  })

  // Signal/Computed rows
  document.querySelectorAll('.signal-row, .effect-row, .component-row').forEach(row => {
    row.addEventListener('click', e => {
      // Don't handle if clicking on action buttons
      if ((e.target as HTMLElement).closest('.row-actions')) return

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

        // Re-render component details panel if component is selected
        if (nodeType === 'component') {
          renderComponentsTab()
        }
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

  // Source link clicks (open in editor)
  document.querySelectorAll('.source-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault()
      const target = e.currentTarget as HTMLElement
      const file = target.dataset.file
      const line = target.dataset.line
      const column = target.dataset.column
      if (file && line) {
        openInEditor(file, parseInt(line, 10), parseInt(column || '1', 10))
      }
    })
  })

  // Reactive item clicks in component details (navigate to signals/effects tab)
  document.querySelectorAll('.reactive-item').forEach(item => {
    item.addEventListener('click', () => {
      const target = item as HTMLElement
      const nodeType = target.dataset.nodeType
      const id = parseInt(
        target.dataset.signalId || target.dataset.computedId || target.dataset.effectId || '0',
        10,
      )
      if (id && nodeType) {
        state.selectedNodeId = id
        state.selectedNodeType = nodeType as NodeType
        // Switch to appropriate tab
        if (nodeType === 'signal' || nodeType === 'computed') {
          state.activeTab = 'signals'
        } else if (nodeType === 'effect') {
          state.activeTab = 'effects'
        }
        render()
      }
    })
  })

  // Timeline controls
  const clearTimeline = document.getElementById('clear-timeline')
  if (clearTimeline) {
    clearTimeline.addEventListener('click', () => {
      state.timeline = []
      selectedTimelineEvent = null
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

  // Timeline layer toggles
  document.querySelectorAll('.layer-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', e => {
      const target = e.target as HTMLInputElement
      const layerId = target.dataset.layerId
      if (layerId) {
        timelineLayers = toggleLayer(timelineLayers, layerId, target.checked)
        renderTimelineTab()
      }
    })
  })

  // Toggle all layers button
  const toggleAllBtn = document.getElementById('toggle-all-layers')
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      const anyEnabled = timelineLayers.some(l => l.enabled)
      timelineLayers = toggleAllLayers(timelineLayers, !anyEnabled)
      renderTimelineTab()
    })
  }

  // Timeline event selection
  document.querySelectorAll('.event-item').forEach(item => {
    item.addEventListener('click', e => {
      const target = e.currentTarget as HTMLElement
      const eventId = parseInt(target.dataset.eventId || '0', 10)
      if (eventId) {
        // Find the event
        selectedTimelineEvent = state.timeline.find(ev => ev.id === eventId) || null
        // Update UI
        document
          .querySelectorAll('.event-item.selected')
          .forEach(el => el.classList.remove('selected'))
        target.classList.add('selected')
        updateTimelineEventDetails()
      }
    })
  })

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

  // Graph node type selector
  const graphNodeType = document.getElementById('graph-node-type') as HTMLSelectElement
  if (graphNodeType) {
    graphNodeType.addEventListener('change', e => {
      const type = (e.target as HTMLSelectElement).value
      const nodeList = document.getElementById('graph-node-list')
      if (nodeList) {
        let items: { id: number; name?: string }[] = []
        switch (type) {
          case 'signal':
            items = Array.from(state.signals.values())
            break
          case 'computed':
            items = Array.from(state.computeds.values())
            break
          case 'effect':
            items = Array.from(state.effects.values())
            break
        }
        nodeList.innerHTML = renderGraphNodeList(type, items)
        setupGraphNodeListeners()
      }
    })
  }

  // Graph node list items
  setupGraphNodeListeners()

  // Graph auto-refresh toggle
  const graphAutoRefreshEl = document.getElementById('graph-auto-refresh') as HTMLInputElement
  if (graphAutoRefreshEl) {
    graphAutoRefreshEl.addEventListener('change', e => {
      graphAutoRefresh = (e.target as HTMLInputElement).checked
    })
  }

  // Graph search input
  const graphSearchInput = document.getElementById('graph-search-input') as HTMLInputElement
  if (graphSearchInput) {
    graphSearchInput.addEventListener('input', e => {
      graphSearchQuery = (e.target as HTMLInputElement).value.toLowerCase()
      if (graphRenderer) {
        if (graphSearchQuery) {
          const matchingNodes = new Set<number>()
          graphRenderer.getNodes().forEach(node => {
            if (
              node.name.toLowerCase().includes(graphSearchQuery) ||
              node.type.toLowerCase().includes(graphSearchQuery)
            ) {
              matchingNodes.add(node.id)
            }
          })
          graphRenderer.setHighlightedNodes(matchingNodes)
        } else {
          graphRenderer.setHighlightedNodes(new Set())
        }
      }
    })
  }
}

function setupGraphNodeListeners(): void {
  document.querySelectorAll('.node-list-item').forEach(item => {
    item.addEventListener('click', e => {
      const target = e.currentTarget as HTMLElement
      const id = parseInt(target.dataset.graphNodeId || '0', 10)
      if (id) {
        // Update selection UI
        document
          .querySelectorAll('.node-list-item.selected')
          .forEach(el => el.classList.remove('selected'))
        target.classList.add('selected')

        state.selectedNodeId = id
        graphAutoRefreshNodeId = id
        sendToPage('request:dependencyGraph', { nodeId: id })
      }
    })
  })
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

function filterItems<T extends { name?: string; id: number; type?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!query.trim()) return items

  // Generate display names for items without names for better search
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const searchableItems = items.map(item => ({
    ...item,
    _searchName: toDisplayName(item.name, `${capitalize(item.type || 'Item')} #${item.id}`),
  }))

  const results = fuzzyFilterItems(searchableItems, query, {
    keys: ['_searchName'],
    threshold: 0.3,
  })
  return results as T[]
}

// Timeline event icon/color functions moved to timeline-renderer.ts

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  // Initialize plugin system
  initPluginIntegration()

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
