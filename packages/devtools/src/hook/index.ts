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
  value: unknown
  prevValue?: unknown
  updateCount: number
  createdAt: number
  lastUpdatedAt?: number
  dependencies: number[]
  dependents: number[]
}

/** Effect state tracked by devtools */
interface EffectState {
  id: number
  name?: string
  runCount: number
  createdAt: number
  lastRunAt?: number
  trackedSignals: number[]
  isActive: boolean
}

/** DevTools internal state */
interface DevToolsState {
  signals: Map<number, SignalState>
  effects: Map<number, EffectState>
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
  updateLog: [],
  maxLogEntries: 1000,
  isConnected: false,
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

  try {
    window.postMessage(
      {
        source: 'fict-devtools-hook',
        type,
        payload,
      },
      '*',
    )
  } catch {
    // Ignore postMessage errors
  }
}

/**
 * The DevTools hook implementation
 */
const hook: FictDevtoolsHook = {
  registerSignal(id: number, value: unknown): void {
    const signalState: SignalState = {
      id,
      value,
      updateCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      dependents: [],
    }

    state.signals.set(id, signalState)
    sendToPanel('signal:register', { id, value })
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

  registerEffect(id: number): void {
    const effectState: EffectState = {
      id,
      runCount: 0,
      createdAt: Date.now(),
      trackedSignals: [],
      isActive: true,
    }

    state.effects.set(id, effectState)
    sendToPanel('effect:register', { id })
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
  global.__FICT_DEVTOOLS_STATE__ = state

  // Listen for messages from panel
  if (typeof window !== 'undefined') {
    window.addEventListener('message', event => {
      if (event.data?.source !== 'fict-devtools-panel') return

      switch (event.data.type) {
        case 'connect':
          state.isConnected = true
          // Send initial state
          sendToPanel('state:init', {
            signals: getSignals(),
            effects: getEffects(),
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
    })
  }

  console.debug('[Fict DevTools] Hook attached')
}

// Auto-attach in development
if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  attachHook()
}
