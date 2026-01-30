/**
 * Fict DevTools Plugin System
 *
 * Provides a plugin API for extending DevTools functionality.
 * Plugins can register custom panels, timeline layers, inspector tabs, and more.
 */

import type { TimelineEvent, TimelineLayer } from './types'

// ============================================================================
// Plugin Types
// ============================================================================

/**
 * Plugin context passed to plugin setup function.
 * Provides access to DevTools APIs and state.
 */
export interface PluginContext {
  /** Add a custom tab to the panel */
  addTab(tab: CustomTab): () => void

  /** Add a custom timeline layer */
  addTimelineLayer(layer: TimelineLayer): () => void

  /** Add a custom timeline event */
  addTimelineEvent(event: Omit<TimelineEvent, 'id'>): void

  /** Show a notification in the panel */
  notify(message: string, type?: 'info' | 'warning' | 'error'): void

  /** Get current DevTools state */
  getState(): PluginState

  /** Subscribe to state changes */
  subscribe(callback: (state: PluginState) => void): () => void

  /** Register a custom inspector section */
  addInspectorSection(section: InspectorSection): () => void

  /** Send a message to the page */
  sendToPage(type: string, payload?: unknown): void

  /** Listen for messages from the page */
  onMessage(handler: MessageHandler): () => void

  /** Register custom actions for nodes */
  addNodeAction(action: NodeAction): () => void
}

/**
 * Plugin state exposed to plugins
 */
export interface PluginState {
  isConnected: boolean
  activeTab: string
  selectedNodeId: number | null
  selectedNodeType: string | null
  signalCount: number
  effectCount: number
  componentCount: number
  timelineEventCount: number
}

/**
 * Custom tab definition
 */
export interface CustomTab {
  /** Unique tab ID */
  id: string
  /** Display label */
  label: string
  /** Optional icon (emoji or SVG) */
  icon?: string
  /** Badge count (optional) */
  badge?: number | (() => number)
  /** Render function for tab content */
  render(): string
  /** Optional setup function called after render */
  setup?(container: HTMLElement): void
  /** Optional cleanup function */
  cleanup?(): void
}

/**
 * Custom inspector section
 */
export interface InspectorSection {
  /** Unique section ID */
  id: string
  /** Section title */
  title: string
  /** Node types this section applies to */
  nodeTypes: ('signal' | 'computed' | 'effect' | 'component')[]
  /** Render function for section content */
  render(nodeId: number, nodeType: string): string
  /** Optional setup function */
  setup?(container: HTMLElement, nodeId: number, nodeType: string): void
}

/**
 * Custom node action
 */
export interface NodeAction {
  /** Unique action ID */
  id: string
  /** Action label */
  label: string
  /** Action icon */
  icon?: string
  /** Node types this action applies to */
  nodeTypes: ('signal' | 'computed' | 'effect' | 'component')[]
  /** Handler function */
  handler(nodeId: number, nodeType: string): void
}

/**
 * Message handler type
 */
export type MessageHandler = (type: string, payload: unknown) => void

/**
 * Plugin definition
 */
export interface DevToolsPlugin {
  /** Unique plugin ID */
  id: string
  /** Plugin display name */
  name: string
  /** Plugin version */
  version?: string
  /** Setup function called when plugin is registered */
  setup(context: PluginContext): void | (() => void)
}

// ============================================================================
// Plugin Registry
// ============================================================================

interface RegisteredPlugin {
  plugin: DevToolsPlugin
  cleanup?: () => void
  tabs: Set<string>
  layers: Set<string>
  sections: Set<string>
  actions: Set<string>
  messageHandlers: Set<MessageHandler>
}

interface PluginRegistryState {
  plugins: Map<string, RegisteredPlugin>
  tabs: Map<string, CustomTab>
  timelineLayers: Map<string, TimelineLayer>
  inspectorSections: Map<string, InspectorSection>
  nodeActions: Map<string, NodeAction>
  messageHandlers: Set<MessageHandler>
  subscribers: Set<(state: PluginState) => void>
}

const registryState: PluginRegistryState = {
  plugins: new Map(),
  tabs: new Map(),
  timelineLayers: new Map(),
  inspectorSections: new Map(),
  nodeActions: new Map(),
  messageHandlers: new Set(),
  subscribers: new Set(),
}

// Event ID counter for plugin timeline events
let pluginEventId = 1000000

// Functions to be set by the panel
let sendToPageFn: ((type: string, payload?: unknown) => void) | null = null
let getStateFn: (() => PluginState) | null = null
let notifyFn: ((message: string, type?: 'info' | 'warning' | 'error') => void) | null = null
let addTimelineEventFn: ((event: TimelineEvent) => void) | null = null

/**
 * Set panel integration functions
 * Called by the panel to provide actual implementations
 */
export function setPanelIntegration(options: {
  sendToPage: (type: string, payload?: unknown) => void
  getState: () => PluginState
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void
  addTimelineEvent: (event: TimelineEvent) => void
}): void {
  sendToPageFn = options.sendToPage
  getStateFn = options.getState
  notifyFn = options.notify
  addTimelineEventFn = options.addTimelineEvent
}

/**
 * Create plugin context for a specific plugin
 */
function createPluginContext(pluginId: string): PluginContext {
  const registered = registryState.plugins.get(pluginId)
  if (!registered) {
    throw new Error(`Plugin ${pluginId} not found`)
  }

  return {
    addTab(tab: CustomTab) {
      if (registryState.tabs.has(tab.id)) {
        console.warn(`[Fict DevTools] Tab ${tab.id} already exists`)
        return () => {}
      }

      registryState.tabs.set(tab.id, tab)
      registered.tabs.add(tab.id)
      notifySubscribers()

      return () => {
        registryState.tabs.delete(tab.id)
        registered.tabs.delete(tab.id)
        notifySubscribers()
      }
    },

    addTimelineLayer(layer: TimelineLayer) {
      if (registryState.timelineLayers.has(layer.id)) {
        console.warn(`[Fict DevTools] Timeline layer ${layer.id} already exists`)
        return () => {}
      }

      const pluginLayer = { ...layer, source: 'plugin' as const }
      registryState.timelineLayers.set(layer.id, pluginLayer)
      registered.layers.add(layer.id)
      notifySubscribers()

      return () => {
        registryState.timelineLayers.delete(layer.id)
        registered.layers.delete(layer.id)
        notifySubscribers()
      }
    },

    addTimelineEvent(event: Omit<TimelineEvent, 'id'>) {
      if (addTimelineEventFn) {
        addTimelineEventFn({
          ...event,
          id: pluginEventId++,
        } as TimelineEvent)
      }
    },

    notify(message: string, type: 'info' | 'warning' | 'error' = 'info') {
      if (notifyFn) {
        notifyFn(message, type)
      } else {
        console.log(`[${pluginId}]`, message)
      }
    },

    getState() {
      if (getStateFn) {
        return getStateFn()
      }
      return {
        isConnected: false,
        activeTab: 'signals',
        selectedNodeId: null,
        selectedNodeType: null,
        signalCount: 0,
        effectCount: 0,
        componentCount: 0,
        timelineEventCount: 0,
      }
    },

    subscribe(callback: (state: PluginState) => void) {
      registryState.subscribers.add(callback)
      return () => {
        registryState.subscribers.delete(callback)
      }
    },

    addInspectorSection(section: InspectorSection) {
      if (registryState.inspectorSections.has(section.id)) {
        console.warn(`[Fict DevTools] Inspector section ${section.id} already exists`)
        return () => {}
      }

      registryState.inspectorSections.set(section.id, section)
      registered.sections.add(section.id)
      notifySubscribers()

      return () => {
        registryState.inspectorSections.delete(section.id)
        registered.sections.delete(section.id)
        notifySubscribers()
      }
    },

    sendToPage(type: string, payload?: unknown) {
      if (sendToPageFn) {
        sendToPageFn(type, payload)
      }
    },

    onMessage(handler: MessageHandler) {
      registryState.messageHandlers.add(handler)
      registered.messageHandlers.add(handler)

      return () => {
        registryState.messageHandlers.delete(handler)
        registered.messageHandlers.delete(handler)
      }
    },

    addNodeAction(action: NodeAction) {
      if (registryState.nodeActions.has(action.id)) {
        console.warn(`[Fict DevTools] Node action ${action.id} already exists`)
        return () => {}
      }

      registryState.nodeActions.set(action.id, action)
      registered.actions.add(action.id)
      notifySubscribers()

      return () => {
        registryState.nodeActions.delete(action.id)
        registered.actions.delete(action.id)
        notifySubscribers()
      }
    },
  }
}

/**
 * Notify all subscribers of state changes
 */
function notifySubscribers(): void {
  if (getStateFn) {
    const state = getStateFn()
    for (const subscriber of registryState.subscribers) {
      try {
        subscriber(state)
      } catch (e) {
        console.error('[Fict DevTools] Plugin subscriber error:', e)
      }
    }
  }
}

/**
 * Dispatch message to all plugin handlers
 */
export function dispatchPluginMessage(type: string, payload: unknown): void {
  for (const handler of registryState.messageHandlers) {
    try {
      handler(type, payload)
    } catch (e) {
      console.error('[Fict DevTools] Plugin message handler error:', e)
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a DevTools plugin
 */
export function registerPlugin(plugin: DevToolsPlugin): () => void {
  if (registryState.plugins.has(plugin.id)) {
    console.warn(`[Fict DevTools] Plugin ${plugin.id} is already registered`)
    return () => {}
  }

  const registered: RegisteredPlugin = {
    plugin,
    tabs: new Set(),
    layers: new Set(),
    sections: new Set(),
    actions: new Set(),
    messageHandlers: new Set(),
  }

  registryState.plugins.set(plugin.id, registered)

  // Create context and run setup
  const context = createPluginContext(plugin.id)
  try {
    const cleanup = plugin.setup(context)
    if (typeof cleanup === 'function') {
      registered.cleanup = cleanup
    }
    console.log(`[Fict DevTools] Plugin "${plugin.name}" registered`)
  } catch (e) {
    console.error(`[Fict DevTools] Plugin "${plugin.name}" setup failed:`, e)
    registryState.plugins.delete(plugin.id)
    throw e
  }

  return () => unregisterPlugin(plugin.id)
}

/**
 * Unregister a DevTools plugin
 */
export function unregisterPlugin(pluginId: string): void {
  const registered = registryState.plugins.get(pluginId)
  if (!registered) return

  // Run cleanup
  if (registered.cleanup) {
    try {
      registered.cleanup()
    } catch (e) {
      console.error(`[Fict DevTools] Plugin cleanup error:`, e)
    }
  }

  // Remove all registered items
  for (const tabId of registered.tabs) {
    const tab = registryState.tabs.get(tabId)
    if (tab?.cleanup) {
      try {
        tab.cleanup()
      } catch (e) {
        console.error(`[Fict DevTools] Tab cleanup error:`, e)
      }
    }
    registryState.tabs.delete(tabId)
  }

  for (const layerId of registered.layers) {
    registryState.timelineLayers.delete(layerId)
  }

  for (const sectionId of registered.sections) {
    registryState.inspectorSections.delete(sectionId)
  }

  for (const actionId of registered.actions) {
    registryState.nodeActions.delete(actionId)
  }

  for (const handler of registered.messageHandlers) {
    registryState.messageHandlers.delete(handler)
  }

  registryState.plugins.delete(pluginId)
  console.log(`[Fict DevTools] Plugin "${registered.plugin.name}" unregistered`)
  notifySubscribers()
}

/**
 * Get all registered plugins
 */
export function getPlugins(): DevToolsPlugin[] {
  return Array.from(registryState.plugins.values()).map(r => r.plugin)
}

/**
 * Get all custom tabs from plugins
 */
export function getPluginTabs(): CustomTab[] {
  return Array.from(registryState.tabs.values())
}

/**
 * Get all custom timeline layers from plugins
 */
export function getPluginTimelineLayers(): TimelineLayer[] {
  return Array.from(registryState.timelineLayers.values())
}

/**
 * Get all inspector sections for a node type
 */
export function getPluginInspectorSections(nodeType: string): InspectorSection[] {
  return Array.from(registryState.inspectorSections.values()).filter(s =>
    s.nodeTypes.includes(nodeType as any),
  )
}

/**
 * Get all node actions for a node type
 */
export function getPluginNodeActions(nodeType: string): NodeAction[] {
  return Array.from(registryState.nodeActions.values()).filter(a =>
    a.nodeTypes.includes(nodeType as any),
  )
}

/**
 * Check if a plugin is registered
 */
export function hasPlugin(pluginId: string): boolean {
  return registryState.plugins.has(pluginId)
}

/**
 * Get a plugin by ID
 */
export function getPlugin(pluginId: string): DevToolsPlugin | undefined {
  return registryState.plugins.get(pluginId)?.plugin
}

// ============================================================================
// Built-in Plugin Helpers
// ============================================================================

/**
 * Create a simple plugin with minimal boilerplate
 */
export function createPlugin(
  id: string,
  name: string,
  setup: (context: PluginContext) => void | (() => void),
): DevToolsPlugin {
  return { id, name, setup }
}

/**
 * Define a plugin (alias for createPlugin for API consistency)
 */
export const definePlugin = createPlugin
