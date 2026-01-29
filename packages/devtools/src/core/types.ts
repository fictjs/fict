/**
 * Fict DevTools Core Types
 *
 * Type definitions for the DevTools debugging system
 */

// ============================================================================
// Node Types
// ============================================================================

export const enum NodeType {
  Signal = 'signal',
  Computed = 'computed',
  Effect = 'effect',
  EffectScope = 'effect-scope',
  Root = 'root',
  Component = 'component',
}

export const enum NodeFlag {
  None = 0,
  Mutable = 1,
  Watching = 2,
  Running = 4,
  Recursed = 8,
  Dirty = 16,
  Pending = 32,
}

// ============================================================================
// Signal State
// ============================================================================

export interface SignalState {
  id: number
  type: NodeType.Signal
  name?: string
  value: unknown
  pendingValue?: unknown
  previousValue?: unknown
  updateCount: number
  createdAt: number
  lastUpdatedAt?: number
  /** IDs of nodes that depend on this signal */
  observers: number[]
  /** Source location info */
  source?: SourceLocation
  /** Component that owns this signal */
  ownerId?: number
}

// ============================================================================
// Computed State
// ============================================================================

export interface ComputedState {
  id: number
  type: NodeType.Computed
  name?: string
  value: unknown
  previousValue?: unknown
  updateCount: number
  createdAt: number
  lastUpdatedAt?: number
  /** IDs of nodes this computed depends on */
  dependencies: number[]
  /** IDs of nodes that depend on this computed */
  observers: number[]
  /** Is the value stale/dirty */
  isDirty: boolean
  /** Source location info */
  source?: SourceLocation
  /** Component that owns this computed */
  ownerId?: number
}

// ============================================================================
// Effect State
// ============================================================================

export interface EffectState {
  id: number
  type: NodeType.Effect
  name?: string
  runCount: number
  createdAt: number
  lastRunAt?: number
  /** Duration of last run in ms */
  lastRunDuration?: number
  /** IDs of signals/computed this effect depends on */
  dependencies: number[]
  /** Is the effect currently active */
  isActive: boolean
  /** Has cleanup function */
  hasCleanup: boolean
  /** Source location info */
  source?: SourceLocation
  /** Component that owns this effect */
  ownerId?: number
}

// ============================================================================
// Component/Owner State
// ============================================================================

export interface ComponentState {
  id: number
  type: NodeType.Component
  name: string
  /** Parent component ID */
  parentId?: number
  /** Child component IDs */
  children: number[]
  /** Props passed to component */
  props?: Record<string, unknown>
  /** Signals owned by this component */
  signals: number[]
  /** Computed values owned by this component */
  computeds: number[]
  /** Effects owned by this component */
  effects: number[]
  /** Root context this component belongs to */
  rootId?: number
  /** DOM elements rendered by this component */
  elements?: HTMLElement[]
  /** Source file location */
  source?: SourceLocation
  /** Is component currently mounted */
  isMounted: boolean
  /** Render count */
  renderCount: number
  /** Creation timestamp */
  createdAt: number
}

// ============================================================================
// Root Context State
// ============================================================================

export interface RootState {
  id: number
  type: NodeType.Root
  name?: string
  /** Child component IDs */
  children: number[]
  /** Is currently suspended */
  isSuspended: boolean
  /** Has error boundary */
  hasErrorBoundary: boolean
  /** Creation timestamp */
  createdAt: number
}

// ============================================================================
// Source Location
// ============================================================================

export interface SourceLocation {
  file: string
  line: number
  column: number
}

// ============================================================================
// Dependency Graph
// ============================================================================

export interface DependencyGraphNode {
  id: number
  type: NodeType
  name: string
  /** Depth from the inspected node */
  depth: number
  /** IDs of nodes this depends on (sources) */
  sources: number[]
  /** IDs of nodes that depend on this (observers) */
  observers: number[]
  /** Current value (for signals/computed) */
  value?: unknown
  /** Is currently dirty/pending */
  isDirty?: boolean
}

export interface DependencyGraph {
  /** The node being inspected */
  rootId: number
  /** All nodes in the graph */
  nodes: Map<number, DependencyGraphNode>
  /** Edges: [from, to][] */
  edges: [number, number][]
}

// ============================================================================
// Timeline Events
// ============================================================================

export const enum TimelineEventType {
  SignalCreate = 'signal:create',
  SignalUpdate = 'signal:update',
  ComputedCreate = 'computed:create',
  ComputedUpdate = 'computed:update',
  EffectCreate = 'effect:create',
  EffectRun = 'effect:run',
  EffectCleanup = 'effect:cleanup',
  EffectDispose = 'effect:dispose',
  ComponentMount = 'component:mount',
  ComponentUnmount = 'component:unmount',
  ComponentRender = 'component:render',
  BatchStart = 'batch:start',
  BatchEnd = 'batch:end',
  FlushStart = 'flush:start',
  FlushEnd = 'flush:end',
  Error = 'error',
  Warning = 'warning',
}

export interface TimelineEvent {
  id: number
  type: TimelineEventType
  timestamp: number
  /** Related node ID */
  nodeId?: number
  /** Node type */
  nodeType?: NodeType
  /** Node name */
  nodeName?: string
  /** Additional event data */
  data?: Record<string, unknown>
  /** Duration for events with start/end */
  duration?: number
  /** Group ID for related events */
  groupId?: number
}

// ============================================================================
// Inspector State
// ============================================================================

export interface InspectorState {
  /** Currently selected node ID */
  selectedId: number | null
  /** Selected node type */
  selectedType: NodeType | null
  /** Expanded tree paths */
  expandedPaths: Set<string>
}

// ============================================================================
// DevTools Hook Interface (Enhanced)
// ============================================================================

export interface FictDevtoolsHookEnhanced {
  // Signal lifecycle
  registerSignal(id: number, value: unknown, name?: string, source?: SourceLocation): void
  updateSignal(id: number, value: unknown, previousValue?: unknown): void
  disposeSignal(id: number): void

  // Computed lifecycle
  registerComputed(id: number, name?: string, source?: SourceLocation): void
  updateComputed(id: number, value: unknown, previousValue?: unknown): void
  disposeComputed(id: number): void

  // Effect lifecycle
  registerEffect(id: number, name?: string, hasCleanup?: boolean, source?: SourceLocation): void
  effectRun(id: number, duration?: number): void
  effectCleanup(id: number): void
  disposeEffect(id: number): void

  // Component lifecycle
  registerComponent(id: number, name: string, parentId?: number, source?: SourceLocation): void
  componentMount(id: number, elements?: HTMLElement[]): void
  componentUnmount(id: number): void
  componentRender(id: number): void

  // Root lifecycle
  registerRoot(id: number, name?: string): void
  disposeRoot(id: number): void
  rootSuspend(id: number, suspended: boolean): void

  // Dependency tracking
  trackDependency(subscriberId: number, dependencyId: number): void
  untrackDependency(subscriberId: number, dependencyId: number): void

  // Batch/flush events
  batchStart(): void
  batchEnd(): void
  flushStart(): void
  flushEnd(): void

  // Error/warning
  cycleDetected(payload: { reason: string; detail?: Record<string, unknown> }): void
  error(error: unknown, componentId?: number): void
  warning(message: string, componentId?: number): void

  // Inspection API
  getSignals(): SignalState[]
  getComputeds(): ComputedState[]
  getEffects(): EffectState[]
  getComponents(): ComponentState[]
  getRoots(): RootState[]
  getTimeline(limit?: number): TimelineEvent[]
  getDependencyGraph(nodeId: number): DependencyGraph | null

  // State mutation (for editing values in devtools)
  setSignalValue(id: number, value: unknown): boolean
}

// ============================================================================
// Message Types (for communication)
// ============================================================================

export const enum MessageSource {
  Hook = 'fict-devtools-hook',
  Panel = 'fict-devtools-panel',
  Content = 'fict-devtools-content',
  Background = 'fict-devtools-background',
}

export interface DevToolsMessage<T = unknown> {
  source: MessageSource
  type: string
  payload?: T
  tabId?: number
  timestamp?: number
}

// ============================================================================
// Panel State
// ============================================================================

export type PanelTab = 'signals' | 'effects' | 'components' | 'timeline' | 'graph' | 'settings'

export interface PanelState {
  isConnected: boolean
  activeTab: PanelTab
  signals: Map<number, SignalState>
  computeds: Map<number, ComputedState>
  effects: Map<number, EffectState>
  components: Map<number, ComponentState>
  roots: Map<number, RootState>
  timeline: TimelineEvent[]
  inspector: InspectorState
  settings: DevToolsSettings
}

// ============================================================================
// Settings
// ============================================================================

export interface DevToolsSettings {
  /** Maximum timeline events to keep */
  maxTimelineEvents: number
  /** Enable timeline recording */
  recordTimeline: boolean
  /** Enable high-performance mode (reduces overhead) */
  highPerfMode: boolean
  /** Highlight updates in UI */
  highlightUpdates: boolean
  /** Theme: 'light' | 'dark' | 'system' */
  theme: 'light' | 'dark' | 'system'
  /** Collapsed sections */
  collapsedSections: string[]
}

// ============================================================================
// Serialization
// ============================================================================

export interface SerializedValue {
  type:
    | 'primitive'
    | 'object'
    | 'array'
    | 'function'
    | 'symbol'
    | 'bigint'
    | 'date'
    | 'regexp'
    | 'map'
    | 'set'
    | 'error'
    | 'circular'
    | 'undefined'
    | 'null'
  value: unknown
  /** For objects/arrays, the keys/indices */
  keys?: string[]
  /** Display text for complex values */
  displayText?: string
  /** Is the value expandable */
  expandable?: boolean
  /** Constructor name for objects */
  constructorName?: string
}
