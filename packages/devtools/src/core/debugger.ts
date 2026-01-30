/**
 * Fict DevTools Debugger
 *
 * Core debugging module that hooks into Fict's reactive system
 * and provides inspection capabilities.
 */

import { formatValueShort } from './serializer'
import {
  type ComponentState,
  type ComputedState,
  type DependencyGraph,
  type DependencyGraphNode,
  type DevToolsSettings,
  type EffectState,
  type FictDevtoolsHookEnhanced,
  MessageSource,
  NodeType,
  type RootState,
  type SignalState,
  type SourceLocation,
  type TimelineEvent,
  TimelineEventType,
} from './types'

// ============================================================================
// State Storage
// ============================================================================

const signals = new Map<number, SignalState>()
const computeds = new Map<number, ComputedState>()
const effects = new Map<number, EffectState>()
const components = new Map<number, ComponentState>()
const roots = new Map<number, RootState>()
const timeline: TimelineEvent[] = []

// Dependency tracking
const dependencies = new Map<number, Set<number>>() // subscriber -> dependencies
const observers = new Map<number, Set<number>>() // dependency -> observers

// ID generation
let nextTimelineId = 1
let batchGroupId: number | null = null
let flushGroupId: number | null = null

// Settings
const settings: DevToolsSettings = {
  maxTimelineEvents: 1000,
  recordTimeline: true,
  highPerfMode: false,
  highlightUpdates: true,
  theme: 'system',
  collapsedSections: [],
}

// Connection state
let isConnected = false
const panelPort: MessagePort | null = null
let broadcastChannel: BroadcastChannel | null = null

// ============================================================================
// Console Exposure
// ============================================================================

const CONSOLE_HISTORY_SIZE = 10

// Store history of selected nodes for console access
const consoleHistory = {
  signals: [] as unknown[],
  effects: [] as unknown[],
  components: [] as unknown[],
}

/**
 * Expose a node to the browser console for interactive debugging.
 * Creates $signal0-$signal9, $effect0-$effect9, $component0-$component9 variables.
 */
export function exposeToConsole(
  type: 'signal' | 'computed' | 'effect' | 'component',
  id: number,
): void {
  if (typeof window === 'undefined') return

  const global = window as unknown as {
    __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
    [key: string]: unknown
  }

  let node: unknown
  let history: unknown[]
  let prefix: string

  switch (type) {
    case 'signal':
    case 'computed': {
      const signal = type === 'signal' ? signals.get(id) : computeds.get(id)
      if (!signal) return

      // Create an interactive object
      const setter = global.__FICT_DEVTOOLS_SIGNALS__?.get(id)
      const isComputed = type === 'computed'

      node = {
        id: signal.id,
        name: signal.name,
        type: isComputed ? 'computed' : 'signal',
        get value() {
          return signal.value
        },
        set value(v: unknown) {
          if (!isComputed && setter) setter(v)
          else console.warn('[Fict DevTools] Cannot set value on computed')
        },
        previousValue: signal.previousValue,
        updateCount: signal.updateCount,
        observers: signal.observers,
        // Convenience methods
        set: isComputed
          ? undefined
          : (v: unknown) => {
              setter?.(v)
            },
        log: () =>
          console.log(`${isComputed ? 'Computed' : 'Signal'} "${signal.name}":`, signal.value),
        inspect: () => {
          console.group(`${isComputed ? 'Computed' : 'Signal'} "${signal.name}" (#${signal.id})`)
          console.log('Value:', signal.value)
          console.log('Previous:', signal.previousValue)
          console.log('Updates:', signal.updateCount)
          console.log('Observers:', signal.observers)
          if ('dependencies' in signal) {
            console.log('Dependencies:', (signal as ComputedState).dependencies)
          }
          console.groupEnd()
        },
      }
      history = consoleHistory.signals
      prefix = '$signal'
      break
    }

    case 'effect': {
      const effect = effects.get(id)
      if (!effect) return

      node = {
        id: effect.id,
        name: effect.name,
        runCount: effect.runCount,
        lastRunAt: effect.lastRunAt,
        lastRunDuration: effect.lastRunDuration,
        dependencies: effect.dependencies,
        isActive: effect.isActive,
        hasCleanup: effect.hasCleanup,
        // Convenience methods
        getDeps: () =>
          effect.dependencies.map(depId => {
            const sig = signals.get(depId)
            const comp = computeds.get(depId)
            return sig || comp || { id: depId, name: 'unknown' }
          }),
        inspect: () => {
          console.group(`Effect "${effect.name}" (#${effect.id})`)
          console.log('Active:', effect.isActive)
          console.log('Run count:', effect.runCount)
          console.log(
            'Last run:',
            effect.lastRunAt ? new Date(effect.lastRunAt).toISOString() : 'never',
          )
          console.log(
            'Duration:',
            effect.lastRunDuration ? `${effect.lastRunDuration}ms` : 'unknown',
          )
          console.log('Dependencies:', effect.dependencies)
          console.log('Has cleanup:', effect.hasCleanup)
          console.groupEnd()
        },
      }
      history = consoleHistory.effects
      prefix = '$effect'
      break
    }

    case 'component': {
      const component = components.get(id)
      if (!component) return

      node = {
        id: component.id,
        name: component.name,
        isMounted: component.isMounted,
        renderCount: component.renderCount,
        props: component.props,
        signals: component.signals,
        effects: component.effects,
        children: component.children,
        parentId: component.parentId,
        get elements() {
          return component.elements
        },
        // Convenience methods
        highlight: () => {
          if (component.elements?.[0]) {
            component.elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
            // Temporary highlight
            const el = component.elements[0]
            const originalOutline = el.style.outline
            const originalTransition = el.style.transition
            el.style.transition = 'outline 0.3s'
            el.style.outline = '3px solid #42b883'
            setTimeout(() => {
              el.style.outline = originalOutline
              el.style.transition = originalTransition
            }, 2000)
          } else {
            console.warn('[Fict DevTools] Component has no mounted elements')
          }
        },
        getSignals: () => component.signals.map(sid => signals.get(sid)).filter(Boolean),
        getEffects: () => component.effects.map(eid => effects.get(eid)).filter(Boolean),
        getChildren: () => component.children.map(cid => components.get(cid)).filter(Boolean),
        getParent: () => (component.parentId ? components.get(component.parentId) : null),
        inspect: () => {
          console.group(`Component "${component.name}" (#${component.id})`)
          console.log('Mounted:', component.isMounted)
          console.log('Render count:', component.renderCount)
          console.log('Props:', component.props)
          console.log('Signals:', component.signals.length)
          console.log('Effects:', component.effects.length)
          console.log('Children:', component.children.length)
          console.log('Elements:', component.elements)
          console.groupEnd()
        },
      }
      history = consoleHistory.components
      prefix = '$component'
      break
    }
  }

  // Update history (keep most recent at $xxx0)
  history.unshift(node)
  if (history.length > CONSOLE_HISTORY_SIZE) {
    history.pop()
  }

  // Expose to window
  history.forEach((item, index) => {
    global[`${prefix}${index}`] = item
  })

  // Print hint
  console.log(
    `%c[Fict DevTools]%c ${prefix}0 =`,
    'color: #42b883; font-weight: bold',
    'color: inherit',
    node,
  )
  console.log(
    `%c  Tip:%c Try ${prefix}0.inspect() or ${prefix}0.log()`,
    'color: #6b7280; font-style: italic',
    'color: #6b7280',
  )
}

// ============================================================================
// Timeline Recording
// ============================================================================

function recordEvent(
  type: TimelineEventType,
  nodeId?: number,
  nodeType?: NodeType,
  nodeName?: string,
  data?: Record<string, unknown>,
  duration?: number,
): void {
  if (!settings.recordTimeline || settings.highPerfMode) return

  const event: TimelineEvent = {
    id: nextTimelineId++,
    type,
    timestamp: performance.now(),
    nodeId,
    nodeType,
    nodeName,
    data,
    duration,
    groupId: batchGroupId ?? flushGroupId ?? undefined,
  }

  timeline.push(event)

  // Trim timeline if needed
  if (timeline.length > settings.maxTimelineEvents) {
    timeline.splice(0, timeline.length - settings.maxTimelineEvents)
  }

  // Send to panel
  sendToPanel('timeline:event', event)
}

// ============================================================================
// Communication
// ============================================================================

function sendToPanel(type: string, payload: unknown): void {
  if (!isConnected) return

  const message = { source: MessageSource.Hook, type, payload, timestamp: Date.now() }

  try {
    if (panelPort) {
      panelPort.postMessage(message)
    } else if (typeof window !== 'undefined') {
      // Send via window.postMessage for same-window communication
      window.postMessage(message, '*')
    }

    // Also send via BroadcastChannel for cross-tab communication (standalone mode)
    if (broadcastChannel) {
      broadcastChannel.postMessage(message)
    }
  } catch {
    // Ignore postMessage errors
  }
}

function handlePanelMessage(event: MessageEvent): void {
  if (event.data?.source !== MessageSource.Panel) return

  const { type, payload } = event.data

  switch (type) {
    case 'connect':
      isConnected = true
      sendInitialState()
      break

    case 'disconnect':
      isConnected = false
      break

    case 'request:signals':
      sendToPanel('response:signals', Array.from(signals.values()))
      break

    case 'request:computeds':
      sendToPanel('response:computeds', Array.from(computeds.values()))
      break

    case 'request:effects':
      sendToPanel('response:effects', Array.from(effects.values()))
      break

    case 'request:components':
      sendToPanel('response:components', Array.from(components.values()))
      break

    case 'request:roots':
      sendToPanel('response:roots', Array.from(roots.values()))
      break

    case 'request:timeline':
      sendToPanel('response:timeline', timeline.slice(-(payload?.limit || 100)))
      break

    case 'request:dependencyGraph':
      sendToPanel('response:dependencyGraph', buildDependencyGraph(payload?.nodeId))
      break

    case 'set:signalValue':
      hook.setSignalValue(payload.id, payload.value)
      break

    case 'set:settings':
      Object.assign(settings, payload)
      break

    case 'clear:timeline':
      timeline.length = 0
      nextTimelineId = 1
      break

    case 'expose:console':
      if (payload?.type && payload?.id !== undefined) {
        exposeToConsole(
          payload.type as 'signal' | 'computed' | 'effect' | 'component',
          payload.id as number,
        )
      }
      break
  }
}

function sendInitialState(): void {
  sendToPanel('state:init', {
    signals: Array.from(signals.values()),
    computeds: Array.from(computeds.values()),
    effects: Array.from(effects.values()),
    components: Array.from(components.values()),
    roots: Array.from(roots.values()),
    timeline: timeline.slice(-100),
    settings,
  })
}

// ============================================================================
// Dependency Graph Builder
// ============================================================================

function buildDependencyGraph(nodeId: number): DependencyGraph | null {
  if (!signals.has(nodeId) && !computeds.has(nodeId) && !effects.has(nodeId)) {
    return null
  }

  const nodes = new Map<number, DependencyGraphNode>()
  const edges: [number, number][] = []
  const visited = new Set<number>()

  // Get node info
  function getNodeInfo(
    id: number,
  ): { type: NodeType; name: string; value?: unknown; isDirty?: boolean } | null {
    if (signals.has(id)) {
      const s = signals.get(id)!
      return { type: NodeType.Signal, name: s.name || `Signal #${id}`, value: s.value }
    }
    if (computeds.has(id)) {
      const c = computeds.get(id)!
      return {
        type: NodeType.Computed,
        name: c.name || `Computed #${id}`,
        value: c.value,
        isDirty: c.isDirty,
      }
    }
    if (effects.has(id)) {
      const e = effects.get(id)!
      return { type: NodeType.Effect, name: e.name || `Effect #${id}` }
    }
    return null
  }

  // BFS to collect nodes and edges
  function traverse(startId: number, direction: 'sources' | 'observers', depth = 0): void {
    if (visited.has(startId) || depth > 10) return
    visited.add(startId)

    const info = getNodeInfo(startId)
    if (!info) return

    const nodeDeps = dependencies.get(startId)
    const nodeObs = observers.get(startId)

    const graphNode: DependencyGraphNode = {
      id: startId,
      type: info.type,
      name: info.name,
      depth,
      sources: nodeDeps ? Array.from(nodeDeps) : [],
      observers: nodeObs ? Array.from(nodeObs) : [],
      value: info.value,
      isDirty: info.isDirty,
    }

    nodes.set(startId, graphNode)

    if (direction === 'sources' && nodeDeps) {
      for (const depId of nodeDeps) {
        edges.push([depId, startId])
        traverse(depId, 'sources', depth + 1)
      }
    } else if (direction === 'observers' && nodeObs) {
      for (const obsId of nodeObs) {
        edges.push([startId, obsId])
        traverse(obsId, 'observers', depth + 1)
      }
    }
  }

  // Traverse both directions from the root node
  traverse(nodeId, 'sources', 0)
  visited.delete(nodeId) // Reset to traverse observers
  traverse(nodeId, 'observers', 0)

  return { rootId: nodeId, nodes, edges }
}

// ============================================================================
// Hook Implementation
// ============================================================================

const hook: FictDevtoolsHookEnhanced = {
  // Signal lifecycle
  registerSignal(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ): void {
    const state: SignalState = {
      id,
      type: NodeType.Signal,
      name: options?.name,
      value,
      updateCount: 0,
      createdAt: Date.now(),
      observers: [],
      source: options?.source ? { file: options.source, line: 0, column: 0 } : undefined,
      ownerId: options?.ownerId,
    }
    signals.set(id, state)
    observers.set(id, new Set())

    // Link signal to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.signals.includes(id)) {
        ownerComponent.signals.push(id)
      }
    }

    recordEvent(
      TimelineEventType.SignalCreate,
      id,
      NodeType.Signal,
      options?.name || `Signal #${id}`,
      {
        value: formatValueShort(value),
      },
    )

    sendToPanel('signal:register', state)
  },

  updateSignal(id: number, value: unknown, previousValue?: unknown): void {
    const state = signals.get(id)
    if (!state) return

    state.previousValue = previousValue ?? state.value
    state.value = value
    state.updateCount++
    state.lastUpdatedAt = Date.now()

    recordEvent(
      TimelineEventType.SignalUpdate,
      id,
      NodeType.Signal,
      state.name || `Signal #${id}`,
      {
        previousValue: formatValueShort(state.previousValue),
        newValue: formatValueShort(value),
      },
    )

    sendToPanel('signal:update', {
      id,
      value,
      previousValue: state.previousValue,
      updateCount: state.updateCount,
    })
  },

  disposeSignal(id: number): void {
    signals.delete(id)
    dependencies.delete(id)
    observers.delete(id)
    sendToPanel('signal:dispose', { id })
  },

  // Computed lifecycle
  registerComputed(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ): void {
    const state: ComputedState = {
      id,
      type: NodeType.Computed,
      name: options?.name,
      value,
      updateCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      observers: [],
      isDirty: true,
      source: options?.source ? { file: options.source, line: 0, column: 0 } : undefined,
      ownerId: options?.ownerId,
    }
    computeds.set(id, state)
    dependencies.set(id, new Set())
    observers.set(id, new Set())

    // Link computed to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.computeds.includes(id)) {
        ownerComponent.computeds.push(id)
      }
    }

    recordEvent(
      TimelineEventType.ComputedCreate,
      id,
      NodeType.Computed,
      options?.name || `Computed #${id}`,
    )

    sendToPanel('computed:register', state)
  },

  updateComputed(id: number, value: unknown, previousValue?: unknown): void {
    const state = computeds.get(id)
    if (!state) return

    state.previousValue = previousValue ?? state.value
    state.value = value
    state.updateCount++
    state.lastUpdatedAt = Date.now()
    state.isDirty = false

    recordEvent(
      TimelineEventType.ComputedUpdate,
      id,
      NodeType.Computed,
      state.name || `Computed #${id}`,
      {
        previousValue: formatValueShort(state.previousValue),
        newValue: formatValueShort(value),
      },
    )

    sendToPanel('computed:update', {
      id,
      value,
      previousValue: state.previousValue,
      updateCount: state.updateCount,
    })
  },

  disposeComputed(id: number): void {
    computeds.delete(id)
    dependencies.delete(id)
    observers.delete(id)
    sendToPanel('computed:dispose', { id })
  },

  // Effect lifecycle
  registerEffect(id: number, options?: { ownerId?: number; source?: string }): void {
    const state: EffectState = {
      id,
      type: NodeType.Effect,
      runCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      isActive: true,
      hasCleanup: false,
      source: options?.source ? { file: options.source, line: 0, column: 0 } : undefined,
      ownerId: options?.ownerId,
    }
    effects.set(id, state)
    dependencies.set(id, new Set())

    // Link effect to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.effects.includes(id)) {
        ownerComponent.effects.push(id)
      }
    }

    recordEvent(TimelineEventType.EffectCreate, id, NodeType.Effect, `Effect #${id}`)

    sendToPanel('effect:register', state)
  },

  effectRun(id: number, duration?: number): void {
    const state = effects.get(id)
    if (!state) return

    state.runCount++
    state.lastRunAt = Date.now()
    state.lastRunDuration = duration

    // Update dependencies
    const deps = dependencies.get(id)
    state.dependencies = deps ? Array.from(deps) : []

    recordEvent(
      TimelineEventType.EffectRun,
      id,
      NodeType.Effect,
      state.name || `Effect #${id}`,
      { runCount: state.runCount },
      duration,
    )

    sendToPanel('effect:run', {
      id,
      runCount: state.runCount,
      duration,
      dependencies: state.dependencies,
    })
  },

  effectCleanup(id: number): void {
    const state = effects.get(id)
    if (!state) return

    recordEvent(TimelineEventType.EffectCleanup, id, NodeType.Effect, state.name || `Effect #${id}`)

    sendToPanel('effect:cleanup', { id })
  },

  disposeEffect(id: number): void {
    const state = effects.get(id)
    if (state) {
      state.isActive = false
      recordEvent(
        TimelineEventType.EffectDispose,
        id,
        NodeType.Effect,
        state.name || `Effect #${id}`,
      )
    }

    effects.delete(id)
    dependencies.delete(id)
    sendToPanel('effect:dispose', { id })
  },

  // Component lifecycle
  registerComponent(id: number, name: string, parentId?: number, source?: SourceLocation): void {
    const state: ComponentState = {
      id,
      type: NodeType.Component,
      name,
      parentId,
      children: [],
      signals: [],
      computeds: [],
      effects: [],
      source,
      isMounted: false,
      renderCount: 0,
      createdAt: Date.now(),
    }
    components.set(id, state)

    // Update parent's children
    if (parentId !== undefined) {
      const parent = components.get(parentId)
      if (parent) {
        parent.children.push(id)
      }
    }

    sendToPanel('component:register', state)
  },

  componentMount(id: number, elements?: HTMLElement[]): void {
    const state = components.get(id)
    if (!state) return

    state.isMounted = true
    state.elements = elements

    recordEvent(TimelineEventType.ComponentMount, id, NodeType.Component, state.name)

    sendToPanel('component:mount', { id, elements: elements?.length })
  },

  componentUnmount(id: number): void {
    const state = components.get(id)
    if (!state) return

    state.isMounted = false
    state.elements = undefined

    recordEvent(TimelineEventType.ComponentUnmount, id, NodeType.Component, state.name)

    sendToPanel('component:unmount', { id })
  },

  componentRender(id: number): void {
    const state = components.get(id)
    if (!state) return

    state.renderCount++

    recordEvent(TimelineEventType.ComponentRender, id, NodeType.Component, state.name, {
      renderCount: state.renderCount,
    })

    sendToPanel('component:render', { id, renderCount: state.renderCount })
  },

  // Root lifecycle
  registerRoot(id: number, name?: string): void {
    const state: RootState = {
      id,
      type: NodeType.Root,
      name,
      children: [],
      isSuspended: false,
      hasErrorBoundary: false,
      createdAt: Date.now(),
    }
    roots.set(id, state)

    sendToPanel('root:register', state)
  },

  disposeRoot(id: number): void {
    roots.delete(id)
    sendToPanel('root:dispose', { id })
  },

  rootSuspend(id: number, suspended: boolean): void {
    const state = roots.get(id)
    if (!state) return

    state.isSuspended = suspended
    sendToPanel('root:suspend', { id, suspended })
  },

  // Dependency tracking
  trackDependency(subscriberId: number, dependencyId: number): void {
    // Add to subscriber's dependencies
    let subDeps = dependencies.get(subscriberId)
    if (!subDeps) {
      subDeps = new Set()
      dependencies.set(subscriberId, subDeps)
    }
    const isNewDep = !subDeps.has(dependencyId)
    subDeps.add(dependencyId)

    // Add to dependency's observers
    let depObs = observers.get(dependencyId)
    if (!depObs) {
      depObs = new Set()
      observers.set(dependencyId, depObs)
    }
    depObs.add(subscriberId)

    // Update state objects and notify panel
    const signal = signals.get(dependencyId)
    if (signal && !signal.observers.includes(subscriberId)) {
      signal.observers.push(subscriberId)
      // Notify panel of observer change
      if (isNewDep) {
        sendToPanel('signal:observers', { id: dependencyId, observers: signal.observers })
      }
    }

    const computed = computeds.get(dependencyId)
    if (computed && !computed.observers.includes(subscriberId)) {
      computed.observers.push(subscriberId)
      if (isNewDep) {
        sendToPanel('computed:observers', { id: dependencyId, observers: computed.observers })
      }
    }

    const subComputed = computeds.get(subscriberId)
    if (subComputed && !subComputed.dependencies.includes(dependencyId)) {
      subComputed.dependencies.push(dependencyId)
      if (isNewDep) {
        sendToPanel('computed:dependencies', {
          id: subscriberId,
          dependencies: subComputed.dependencies,
        })
      }
    }

    const effect = effects.get(subscriberId)
    if (effect && !effect.dependencies.includes(dependencyId)) {
      effect.dependencies.push(dependencyId)
      if (isNewDep) {
        sendToPanel('effect:dependencies', { id: subscriberId, dependencies: effect.dependencies })
      }
    }
  },

  untrackDependency(subscriberId: number, dependencyId: number): void {
    const subDeps = dependencies.get(subscriberId)
    if (subDeps) {
      subDeps.delete(dependencyId)
    }

    const depObs = observers.get(dependencyId)
    if (depObs) {
      depObs.delete(subscriberId)
    }

    // Update state objects
    const signal = signals.get(dependencyId)
    if (signal) {
      const idx = signal.observers.indexOf(subscriberId)
      if (idx !== -1) signal.observers.splice(idx, 1)
    }

    const computed = computeds.get(dependencyId)
    if (computed) {
      const idx = computed.observers.indexOf(subscriberId)
      if (idx !== -1) computed.observers.splice(idx, 1)
    }
  },

  // Batch/flush events
  batchStart(): void {
    batchGroupId = nextTimelineId
    recordEvent(TimelineEventType.BatchStart)
  },

  batchEnd(): void {
    recordEvent(TimelineEventType.BatchEnd)
    batchGroupId = null
  },

  flushStart(): void {
    flushGroupId = nextTimelineId
    recordEvent(TimelineEventType.FlushStart)
  },

  flushEnd(): void {
    recordEvent(TimelineEventType.FlushEnd)
    flushGroupId = null
  },

  // Error/warning
  cycleDetected(payload: { reason: string; detail?: Record<string, unknown> }): void {
    recordEvent(TimelineEventType.Warning, undefined, undefined, 'Cycle detected', payload)
    sendToPanel('warning:cycle', payload)
    console.warn('[Fict DevTools] Cycle detected:', payload)
  },

  error(error: unknown, componentId?: number): void {
    const message = error instanceof Error ? error.message : String(error)
    recordEvent(TimelineEventType.Error, componentId, NodeType.Component, message, {
      stack: error instanceof Error ? error.stack : undefined,
    })
    sendToPanel('error', { message, componentId })
  },

  warning(message: string, componentId?: number): void {
    recordEvent(TimelineEventType.Warning, componentId, NodeType.Component, message)
    sendToPanel('warning', { message, componentId })
  },

  // Inspection API
  getSignals(): SignalState[] {
    return Array.from(signals.values())
  },

  getComputeds(): ComputedState[] {
    return Array.from(computeds.values())
  },

  getEffects(): EffectState[] {
    return Array.from(effects.values())
  },

  getComponents(): ComponentState[] {
    return Array.from(components.values())
  },

  getRoots(): RootState[] {
    return Array.from(roots.values())
  },

  getTimeline(limit = 100): TimelineEvent[] {
    return timeline.slice(-limit)
  },

  getDependencyGraph(nodeId: number): DependencyGraph | null {
    return buildDependencyGraph(nodeId)
  },

  // State mutation
  setSignalValue(id: number, value: unknown): boolean {
    // Get the signal setter from the runtime
    // This requires access to the actual signal node
    const global = globalThis as typeof globalThis & {
      __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
    }

    const setter = global.__FICT_DEVTOOLS_SIGNALS__?.get(id)
    if (setter) {
      try {
        setter(value)
        return true
      } catch (e) {
        console.error('[Fict DevTools] Failed to set signal value:', e)
        return false
      }
    }
    return false
  },
}

// ============================================================================
// Initialization
// ============================================================================

export function attachDebugger(): void {
  if (typeof globalThis === 'undefined') return

  const global = globalThis as typeof globalThis & {
    __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHookEnhanced
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

  // Don't override if already attached
  if (global.__FICT_DEVTOOLS_HOOK__) return

  global.__FICT_DEVTOOLS_HOOK__ = hook
  global.__FICT_DEVTOOLS_STATE__ = {
    signals,
    computeds,
    effects,
    components,
    roots,
    timeline,
    settings,
  }

  // Listen for messages from panel
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handlePanelMessage)

    // Initialize BroadcastChannel for cross-tab communication (standalone mode)
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel('fict-devtools')
      broadcastChannel.onmessage = event => {
        handlePanelMessage({ data: event.data } as MessageEvent)
      }

      // Broadcast that hook is ready (for panels that connected before app loaded)
      broadcastChannel.postMessage({
        source: MessageSource.Hook,
        type: 'hook-ready',
        timestamp: Date.now(),
      })
    }
  }

  console.debug('[Fict DevTools] Debugger attached')
}

export function detachDebugger(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('message', handlePanelMessage)
  }

  // Close and cleanup BroadcastChannel
  if (broadcastChannel) {
    try {
      broadcastChannel.close()
    } catch {
      // Ignore errors during cleanup
    }
    broadcastChannel = null
  }

  // Reset connection state
  isConnected = false

  const global = globalThis as typeof globalThis & {
    __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHookEnhanced
    __FICT_DEVTOOLS_STATE__?: unknown
  }

  delete global.__FICT_DEVTOOLS_HOOK__
  delete global.__FICT_DEVTOOLS_STATE__
}

export { hook }
export default hook
