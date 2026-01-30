/**
 * Fict DevTools Bridge
 *
 * This module provides the runtime hooks that connect Fict's reactive system
 * to the DevTools browser extension for debugging and inspection.
 */

import type { FictDevtoolsHook } from '@fictjs/runtime'

/** Signal state tracked by devtools */
interface SignalState {
  id: number
  name?: string
  source?: string
  value: unknown
  prevValue?: unknown
  updateCount: number
  createdAt: number
  lastUpdatedAt?: number
  dependencies: number[]
  dependents: number[]
  ownerId?: number
}

/** Effect state tracked by devtools */
interface EffectState {
  id: number
  name?: string
  source?: string
  runCount: number

  createdAt: number
  lastRunAt?: number
  trackedSignals: number[]
  isActive: boolean
  ownerId?: number
}

interface ComponentState {
  id: number
  name: string
  parentId?: number
  children: number[]
  signals: number[]
  computeds: number[]
  effects: number[]
  createdAt: number
  isMounted: boolean
}

/** DevTools internal state */
interface DevToolsState {
  signals: Map<number, SignalState>
  effects: Map<number, EffectState>
  components: Map<number, ComponentState>
  updateLog: {
    timestamp: number
    type: 'signal' | 'effect'
    id: number
    data?: unknown
  }[]
  maxLogEntries: number
  isConnected: boolean
}

const state: DevToolsState = {
  signals: new Map(),
  effects: new Map(),
  components: new Map(),
  updateLog: [],
  maxLogEntries: 1000,
  isConnected: false,
}

function attachToComponent(
  ownerId: number,
  payload: { signalId?: number; computedId?: number; effectId?: number },
): void {
  const comp = state.components.get(ownerId)
  if (!comp) return
  if (payload.signalId !== undefined && !comp.signals.includes(payload.signalId)) {
    comp.signals.push(payload.signalId)
  }
  if (payload.computedId !== undefined && !comp.computeds.includes(payload.computedId)) {
    comp.computeds.push(payload.computedId)
  }
  if (payload.effectId !== undefined && !comp.effects.includes(payload.effectId)) {
    comp.effects.push(payload.effectId)
  }
}

/**
 * Log an update for "why did this update" tracking
 */
function logUpdate(type: 'signal' | 'effect', id: number, data?: unknown): void {
  state.updateLog.push({
    timestamp: Date.now(),
    type,
    id,
    data,
  })

  // Trim log if too long
  if (state.updateLog.length > state.maxLogEntries) {
    state.updateLog = state.updateLog.slice(-state.maxLogEntries)
  }
}

/**
 * Send message to DevTools panel
 */
function sendToPanel(type: string, payload: unknown): void {
  if (!state.isConnected) return

  const message = {
    source: 'fict-devtools-hook',
    type,
    payload,
  }

  // Try BroadcastChannel first (standalone mode)
  const global = (typeof globalThis !== 'undefined' ? globalThis : window) as any
  if (global.__FICT_DEVTOOLS_CHANNEL__) {
    global.__FICT_DEVTOOLS_CHANNEL__.postMessage(message)
  }

  // Also try window.postMessage (extension/iframe mode)
  try {
    window.postMessage(message, '*')
  } catch {
    // Ignore postMessage errors
  }
}

/**
 * The DevTools hook implementation
 */
const hook: FictDevtoolsHook = {
  registerSignal(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ): void {
    const signalState: SignalState = {
      id,
      value,
      name: options?.name,
      source: options?.source,
      ownerId: options?.ownerId,
      updateCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      dependents: [],
    }

    state.signals.set(id, signalState)
    if (options?.ownerId) attachToComponent(options.ownerId, { signalId: id })
    sendToPanel('signal:register', {
      id,
      value,
      name: options?.name,
      source: options?.source,
      ownerId: options?.ownerId,
    })
  },

  updateSignal(id: number, value: unknown): void {
    const signalState = state.signals.get(id)
    if (signalState) {
      signalState.prevValue = signalState.value
      signalState.value = value
      signalState.updateCount++
      signalState.lastUpdatedAt = Date.now()
    }

    logUpdate('signal', id, { prevValue: signalState?.prevValue, newValue: value })
    sendToPanel('signal:update', { id, value, prevValue: signalState?.prevValue })
  },

  registerComputed(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number; hasValue?: boolean },
  ): void {
    // Computed is treated as a specialized signal in this simple devtools
    const signalState: SignalState = {
      id,
      value: options?.hasValue === false ? undefined : value,
      name: options?.name,
      source: options?.source,
      ownerId: options?.ownerId,
      updateCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      dependents: [],
    }

    // We treat computed as signals in the state map for now, or we could add a computeds map
    // The panel expects 'computeds' probably?
    // Looking at panel/index.ts state: signals, computeds, effects.
    // But DevToolsState in this file only has signals/effects maps?
    // Line 39: signals: Map<number, SignalState>
    // Line 40: effects: Map<number, EffectState>
    // It seems this hook implementation treats computeds as signals or ignores them?
    // Wait, if I registerComputed, I should probably store it.
    // If DevToolsState interface doesn't have computeds, I should add it or use signals map.
    // Let's check DevToolsState interface in this file at line 38.
    // "signals: Map<number, SignalState>", "effects: Map<number, EffectState>". No computeds.
    // So current implementation reuses signals map or doesn't support computeds separately?
    // Given Fict runtime distinguishes them, I should probably reuse signals map for now to allow them to show up.

    state.signals.set(id, signalState)
    if (options?.ownerId) attachToComponent(options.ownerId, { computedId: id })
    sendToPanel('computed:register', {
      id,
      value,
      name: options?.name,
      source: options?.source,
      ownerId: options?.ownerId,
      hasValue: options?.hasValue,
    })
  },

  updateComputed(id: number, value: unknown): void {
    const signalState = state.signals.get(id)
    if (signalState) {
      signalState.prevValue = signalState.value
      signalState.value = value
      signalState.updateCount++
      signalState.lastUpdatedAt = Date.now()
    }

    logUpdate('signal', id, { prevValue: signalState?.prevValue, newValue: value })
    sendToPanel('computed:update', { id, value, prevValue: signalState?.prevValue })
  },

  registerEffect(id: number, options?: { ownerId?: number; source?: string }): void {
    const effectState: EffectState = {
      id,
      runCount: 0,
      createdAt: Date.now(),
      trackedSignals: [],
      isActive: true,
      ownerId: options?.ownerId,
      source: options?.source,
    }

    state.effects.set(id, effectState)
    if (options?.ownerId) attachToComponent(options.ownerId, { effectId: id })
    sendToPanel('effect:register', { id, ownerId: options?.ownerId, source: options?.source })
  },

  effectRun(id: number): void {
    const effectState = state.effects.get(id)
    if (effectState) {
      effectState.runCount++
      effectState.lastRunAt = Date.now()
    }

    logUpdate('effect', id)
    sendToPanel('effect:run', { id, runCount: effectState?.runCount })
  },

  cycleDetected(payload: { reason: string; detail?: Record<string, unknown> }): void {
    console.warn('[Fict DevTools] Cycle detected:', payload)
    sendToPanel('cycle:detected', payload)
  },

  registerComponent(id: number, name: string, parentId?: number): void {
    const component: ComponentState = {
      id,
      name,
      parentId,
      children: [],
      signals: [],
      computeds: [],
      effects: [],
      createdAt: Date.now(),
      isMounted: true,
    }
    state.components.set(id, component)
    if (parentId !== undefined) {
      const parent = state.components.get(parentId)
      if (parent) parent.children.push(id)
    }
    sendToPanel('component:register', component)
  },

  componentMount(id: number): void {
    const comp = state.components.get(id)
    if (comp) comp.isMounted = true
    sendToPanel('component:mount', { id })
  },

  componentUnmount(id: number): void {
    const comp = state.components.get(id)
    if (comp) comp.isMounted = false
    sendToPanel('component:unmount', { id })
  },
}

/**
 * Get all tracked signals (for panel inspection)
 */
export function getSignals(): SignalState[] {
  return Array.from(state.signals.values())
}

/**
 * Get all tracked effects (for panel inspection)
 */
export function getEffects(): EffectState[] {
  return Array.from(state.effects.values())
}

/**
 * Get all tracked components (for panel inspection)
 */
export function getComponents(): ComponentState[] {
  return Array.from(state.components.values())
}

/**
 * Get update log for "why did this update" analysis
 */
export function getUpdateLog(): typeof state.updateLog {
  return state.updateLog
}

/**
 * Clear all devtools state
 */
export function clearState(): void {
  state.signals.clear()
  state.effects.clear()
  state.updateLog = []
}

/**
 * Attach the DevTools hook to the global object
 */
export function attachHook(): void {
  if (typeof globalThis === 'undefined') return

  const global = globalThis as typeof globalThis & {
    __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHook
    __FICT_DEVTOOLS_STATE__?: DevToolsState
  }

  // Don't override if already attached
  if (global.__FICT_DEVTOOLS_HOOK__) return

  global.__FICT_DEVTOOLS_HOOK__ = hook
  // Setup BroadcastChannel for standalone mode
  let channel: BroadcastChannel | undefined
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('fict-devtools')
    channel.onmessage = event => {
      if (event.data?.source !== 'fict-devtools-panel') return
      handleHookMessage(event.data)
    }
  }

  // Listen for window messages (fallback/iframe)
  if (typeof window !== 'undefined') {
    window.addEventListener('message', event => {
      if (event.data?.source !== 'fict-devtools-panel') return
      handleHookMessage(event.data)
    })
  }

  // Store channel on global for sendToPanel to access
  ;(global as any).__FICT_DEVTOOLS_CHANNEL__ = channel

  function handleHookMessage(data: any) {
    switch (data.type) {
      case 'connect':
        state.isConnected = true
        // Send initial state
        sendToPanel('state:init', {
          signals: getSignals(),
          effects: getEffects(),
          components: getComponents(),
        })
        break

      case 'disconnect':
        state.isConnected = false
        break

      case 'request:signals':
        sendToPanel('response:signals', getSignals())
        break

      case 'request:effects':
        sendToPanel('response:effects', getEffects())
        break

      case 'request:updateLog':
        sendToPanel('response:updateLog', getUpdateLog())
        break
    }
  }

  console.debug('[Fict DevTools] Hook attached')
}

// Auto-attach in development
if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  attachHook()
}
