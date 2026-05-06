/**
 * Compatibility bridge for legacy `@fictjs/devtools/hook` consumers.
 *
 * The authoritative runtime hook implementation now lives in `core/debugger`.
 * This module re-exports a compatible surface to avoid drift.
 */

import type { FictDevtoolsHook } from '@fictjs/runtime/advanced'

import { attachDebugger, detachDebugger, hook as coreHook } from '../core/debugger'
import type {
  ComponentState,
  ComputedState,
  DevToolsSettings,
  EffectState,
  RootState,
  SignalState,
  TimelineEvent,
} from '../core/types'

interface LegacyUpdateLogEntry {
  timestamp: number
  type: 'signal' | 'effect'
  id: number
  data?: unknown
}

type GlobalWithDevtoolsState = typeof globalThis & {
  __FICT_DEVTOOLS_STATE__?: {
    signals: Map<number, SignalState>
    computeds: Map<number, ComputedState>
    effects: Map<number, EffectState>
    components: Map<number, ComponentState>
    roots: Map<number, RootState>
    timeline: TimelineEvent[]
    settings: DevToolsSettings
  }
}

function getDebuggerState() {
  return (globalThis as GlobalWithDevtoolsState).__FICT_DEVTOOLS_STATE__
}

function toLegacyUpdateLog(timeline: TimelineEvent[]): LegacyUpdateLogEntry[] {
  const updates: LegacyUpdateLogEntry[] = []
  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i]
    if (!event || event.nodeId === undefined) continue
    if (
      event.type === 'signal:update' ||
      event.type === 'computed:update' ||
      event.type === 'signal:create' ||
      event.type === 'computed:create'
    ) {
      updates.push({
        timestamp: event.timestamp,
        type: 'signal',
        id: event.nodeId,
        data: event.data,
      })
      continue
    }
    if (event.type === 'effect:run' || event.type === 'effect:create') {
      updates.push({
        timestamp: event.timestamp,
        type: 'effect',
        id: event.nodeId,
        data: event.data,
      })
    }
  }
  return updates
}

export const hook: FictDevtoolsHook = coreHook as unknown as FictDevtoolsHook

export function getSignals(): SignalState[] {
  return Array.from(getDebuggerState()?.signals.values() ?? [])
}

export function getEffects(): EffectState[] {
  return Array.from(getDebuggerState()?.effects.values() ?? [])
}

export function getComponents(): ComponentState[] {
  return Array.from(getDebuggerState()?.components.values() ?? [])
}

export function getUpdateLog(): LegacyUpdateLogEntry[] {
  return toLegacyUpdateLog(getDebuggerState()?.timeline ?? [])
}

export function clearState(): void {
  const state = getDebuggerState()
  if (!state) return
  state.signals.clear()
  state.computeds.clear()
  state.effects.clear()
  state.components.clear()
  state.roots.clear()
  state.timeline.length = 0
}

export function attachHook(): void {
  attachDebugger()
}

export function detachHook(): void {
  detachDebugger()
}

if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  attachHook()
}
