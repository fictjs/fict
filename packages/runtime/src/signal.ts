import { beginFlushGuard, beforeEffectRunGuard, endFlushGuard } from './cycle-guard'
import { getDevtoolsHook } from './devtools'
import { __fictGetCurrentComponentId } from './hooks'
import {
  getCurrentRoot,
  handleError,
  handleSuspend,
  registerRootCleanup,
  withRootContext,
  type RootContext,
} from './lifecycle'
import type { SuspenseToken } from './types'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Reactive node that can be either a signal, computed, effect, or effect scope
 */
export type ReactiveNode =
  | SignalNode<unknown>
  | ComputedNode<unknown>
  | EffectNode
  | EffectScopeNode
  | SubscriberNode

/**
 * Link between a dependency and a subscriber in the reactive graph
 */
export interface Link {
  /** Version/cycle when this link was created */
  version: number
  /** The dependency being tracked */
  dep: ReactiveNode
  /** The subscriber tracking this dependency */
  sub: ReactiveNode
  /** Previous dependency link in the subscriber's dependency list */
  prevDep: Link | undefined
  /** Next dependency link in the subscriber's dependency list */
  nextDep: Link | undefined
  /** Previous subscriber link in the dependency's subscriber list */
  prevSub: Link | undefined
  /** Next subscriber link in the dependency's subscriber list */
  nextSub: Link | undefined
}

/**
 * Stack frame for traversing the reactive graph
 */
export interface StackFrame {
  /** The link value at this stack level */
  value: Link | undefined
  /** Previous stack frame */
  prev: StackFrame | undefined
}

/**
 * Base interface for all reactive nodes
 */
export interface BaseNode {
  /** First subscriber link */
  subs: Link | undefined
  /** Last subscriber link */
  subsTail: Link | undefined
  /** Reactive flags (Mutable, Watching, Running, etc.) */
  flags: number
}

/**
 * Options for creating a signal
 */
export interface SignalOptions<T> {
  /** Custom equality check */
  equals?: false | ((prev: T, next: T) => boolean)
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
}

/**
 * Options for creating a memo
 */
export interface MemoOptions<T> {
  /** Custom equality check */
  equals?: false | ((prev: T, next: T) => boolean)
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
  /** Internal memo created by compiler runtime plumbing (hidden from DevTools) */
  internal?: boolean
}

/**
 * Options for creating an effect
 */
export interface EffectOptions {
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
}

/**
 * Signal node - mutable reactive value
 */
export interface SignalNode<T = unknown> extends BaseNode {
  /** Current committed value */
  currentValue: T
  /** Pending value to be committed */
  pendingValue: T
  /** Previous committed value (for cleanup reads) */
  prevValue?: T
  /** Flush id when prevValue was recorded */
  prevFlushId?: number
  /** Signals don't have dependencies */
  deps?: undefined
  depsTail?: undefined
  getter?: undefined
  /** DevTools ID */
  __id?: number | undefined
  /** Equality check */
  equals?: false | ((prev: T, next: T) => boolean)
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
}

/**
 * Computed node - derived reactive value
 */
export interface ComputedNode<T = unknown> extends BaseNode {
  /** Current computed value */
  value: T
  /** Previous computed value (for cleanup reads) */
  prevValue?: T
  /** Flush id when prevValue was recorded */
  prevFlushId?: number
  /** First dependency link */
  deps: Link | undefined
  /** Last dependency link */
  depsTail: Link | undefined
  /** Getter function to compute the value */
  getter: (oldValue: T | undefined) => T
  /** DevTools ID */
  __id?: number | undefined
  /** Equality check */
  equals?: false | ((prev: T, next: T) => boolean)
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
  /** Hide this computed from DevTools (used by compiler-internal memos) */
  devToolsInternal?: boolean
}

/**
 * Effect node - side effect that runs when dependencies change
 */
export interface EffectNode extends BaseNode {
  /** Effect function to execute */
  fn: () => void
  /** First dependency link */
  deps: Link | undefined
  /** Last dependency link */
  depsTail: Link | undefined
  /** Optional cleanup runner to be called before checkDirty */
  runCleanup?: () => void
  /** Root context for error/suspense handling */
  root?: RootContext
  /** Debug name */
  name?: string
  /** Source location */
  devToolsSource?: string
  /** Devtools ID */
  __id?: number | undefined
  /** Queue priority for a pending scheduler entry */
  queuedPriority?: 1 | 2 | undefined
}

/**
 * Effect scope node - manages multiple effects
 */
export interface EffectScopeNode extends BaseNode {
  /** First dependency link */
  deps: Link | undefined
  /** Last dependency link */
  depsTail: Link | undefined
}

/**
 * Subscriber node used in trigger
 */
export interface SubscriberNode {
  /** First dependency link */
  deps: Link | undefined
  /** Last dependency link */
  depsTail: Link | undefined
  /** Reactive flags */
  flags: number
  subs?: undefined
  subsTail?: undefined
}

/**
 * Signal accessor - function to get/set signal value
 */
export interface SignalAccessor<T> {
  (): T
  (value: T): void
}

/**
 * Computed accessor - function to get computed value
 */
export type ComputedAccessor<T> = () => T

/**
 * Effect disposer - function to dispose an effect
 */
export type EffectDisposer = () => void

/**
 * Effect scope disposer - function to dispose an effect scope
 */
export type EffectScopeDisposer = () => void

/**
 * Options for creating a custom reactive system
 */
export interface ReactiveSystemOptions {
  /** Update function for reactive nodes */
  update: (node: ReactiveNode) => boolean
  /** Notify function when a subscriber needs to be notified */
  notify: (sub: ReactiveNode) => void
  /** Callback when a dependency becomes unwatched */
  unwatched: (dep: ReactiveNode) => void
}

/**
 * Custom reactive system methods
 */
export interface ReactiveSystem {
  /** Link a dependency to a subscriber */
  link: typeof link
  /** Unlink a dependency from a subscriber */
  unlink: (lnk: Link, sub?: ReactiveNode) => Link | undefined
  /** Propagate changes through the reactive graph */
  propagate: (firstLink: Link) => void
  /** Check if a node is dirty */
  checkDirty: (firstLink: Link, sub: ReactiveNode) => boolean
  /** Shallow propagate changes */
  shallowPropagate: (firstLink: Link) => void
}

// ============================================================================
// Flags
// ============================================================================
const Mutable = 1
const Watching = 2
const Running = 4
const Recursed = 8
const Dirty = 16
const Pending = 32
// Pre-computed combinations
const MutableDirty = 17
const MutablePending = 33
const MutableRunning = 5
const WatchingRunning = 6
// Global state
let cycle = 0
let batchDepth = 0
let activeSub: ReactiveNode | undefined
let flushScheduled = false
let currentFlushId = 0
let activeCleanupFlushId = 0
// Dual-priority queue for scheduler
const highPriorityQueue: EffectNode[] = []
const lowPriorityQueue: EffectNode[] = []
const QueuedLow = 1
const QueuedHigh = 2
let isInTransition = false
const enqueueMicrotask =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn: () => void) => {
        Promise.resolve().then(fn)
      }
// Flag to indicate cleanup is running - signal reads should return currentValue without updating
let inCleanup = false
// This ensures type detection works correctly even after minification
const SIGNAL_MARKER = Symbol.for('fict:signal')
const COMPUTED_MARKER = Symbol.for('fict:computed')
const EFFECT_MARKER = Symbol.for('fict:effect')
const EFFECT_SCOPE_MARKER = Symbol.for('fict:effectScope')
export const ReactiveFlags = {
  None: 0,
  Mutable,
  Watching,
  RecursedCheck: Running,
  Recursed,
  Dirty,
  Pending,
}
// ============================================================================
// createReactiveSystem - Support for custom systems
// ============================================================================
/**
 * Create a custom reactive system with custom update, notify, and unwatched handlers
 * @param options - Reactive system options
 * @returns Custom reactive system methods
 */
export function createReactiveSystem({
  update,
  notify: notifyFn,
  unwatched: unwatchedFn,
}: ReactiveSystemOptions): ReactiveSystem {
  function customPropagate(firstLink: Link): void {
    let link = firstLink
    let next = link.nextSub
    let stack: StackFrame | undefined

    top: for (;;) {
      const sub = link.sub
      let flags = sub.flags

      if (!(flags & 60)) {
        sub.flags = flags | Pending
      } else if (!(flags & 12)) {
        flags = 0
      } else if (!(flags & Running)) {
        sub.flags = (flags & ~Recursed) | Pending
      } else if (!(flags & 48)) {
        let vlink = sub.depsTail
        let valid = false
        while (vlink !== undefined) {
          if (vlink === link) {
            valid = true
            break
          }
          vlink = vlink.prevDep
        }
        if (valid) {
          sub.flags = flags | 40
          flags &= Mutable
        } else {
          flags = 0
        }
      } else {
        flags = 0
      }

      if (flags & Watching) notifyFn(sub)

      if (flags & Mutable) {
        const subSubs = sub.subs
        if (subSubs !== undefined) {
          const nextSub = subSubs.nextSub
          if (nextSub !== undefined) {
            stack = { value: next, prev: stack }
            next = nextSub
          }
          link = subSubs
          continue
        }
      }

      if (next !== undefined) {
        link = next
        next = link.nextSub
        continue
      }

      while (stack !== undefined) {
        link = stack.value!
        stack = stack.prev
        if (link !== undefined) {
          next = link.nextSub
          continue top
        }
      }
      break
    }
  }
  function customCheckDirty(firstLink: Link, sub: ReactiveNode): boolean {
    let link = firstLink
    let stack: StackFrame | undefined
    let checkDepth = 0
    let dirty = false

    top: for (;;) {
      const dep = link.dep
      const depFlags = dep.flags

      if (sub.flags & Dirty) {
        dirty = true
      } else if ((depFlags & MutableDirty) === MutableDirty) {
        if (update(dep)) {
          const subs = dep.subs
          if (subs !== undefined && subs.nextSub !== undefined) {
            customShallowPropagate(subs)
          }
          dirty = true
        }
      } else if ((depFlags & MutablePending) === MutablePending) {
        if (!dep.deps) {
          const nextDep = link.nextDep
          if (nextDep !== undefined) {
            link = nextDep
            continue
          }
        } else {
          if (link.nextSub !== undefined || link.prevSub !== undefined) {
            stack = { value: link, prev: stack }
          }
          link = dep.deps
          sub = dep
          ++checkDepth
          continue
        }
      }

      if (!dirty) {
        const nextDep = link.nextDep
        if (nextDep !== undefined) {
          link = nextDep
          continue
        }
      }

      while (checkDepth-- > 0) {
        const firstSub = sub.subs!
        const hasMultipleSubs = firstSub.nextSub !== undefined

        if (hasMultipleSubs) {
          link = stack!.value!
          stack = stack!.prev
        } else link = firstSub

        if (dirty) {
          if (update(sub)) {
            if (hasMultipleSubs) customShallowPropagate(firstSub)
            sub = link.sub
            continue
          }
          dirty = false
        } else {
          sub.flags &= ~Pending
        }

        sub = link.sub
        const nextDep = link.nextDep
        if (nextDep !== undefined) {
          link = nextDep
          continue top
        }
      }

      return dirty
    }
  }
  function customShallowPropagate(firstLink: Link): void {
    let link: Link | undefined = firstLink
    do {
      const sub = link.sub
      const flags = sub.flags
      if ((flags & 48) === Pending) {
        sub.flags = flags | Dirty
        if ((flags & 6) === Watching) notifyFn(sub)
      }
      link = link.nextSub
    } while (link !== undefined)
  }
  function customUnlink(lnk: Link, sub: ReactiveNode = lnk.sub): Link | undefined {
    const dep = lnk.dep
    const prevDep = lnk.prevDep
    const nextDep = lnk.nextDep
    const nextSub = lnk.nextSub
    const prevSub = lnk.prevSub

    if (nextDep !== undefined) nextDep.prevDep = prevDep
    else sub.depsTail = prevDep
    if (prevDep !== undefined) prevDep.nextDep = nextDep
    else sub.deps = nextDep

    if (nextSub !== undefined) nextSub.prevSub = prevSub
    else dep.subsTail = prevSub
    if (prevSub !== undefined) prevSub.nextSub = nextSub
    else if ((dep.subs = nextSub) === undefined) unwatchedFn(dep)

    return nextDep
  }
  return {
    link,
    unlink: customUnlink,
    propagate: customPropagate,
    checkDirty: customCheckDirty,
    shallowPropagate: customShallowPropagate,
  }
}
// ============================================================================
// Core functions
// ============================================================================
/**
 * Create a link between a dependency and a subscriber
 * @param dep - The dependency node
 * @param sub - The subscriber node
 * @param version - The cycle version
 */
function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
  const prevDep = sub.depsTail
  if (prevDep !== undefined && prevDep.dep === dep) return

  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
  if (nextDep !== undefined && nextDep.dep === dep) {
    nextDep.version = version
    sub.depsTail = nextDep
    return
  }

  const prevSub = dep.subsTail
  if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) return

  const newLink = { version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined }
  sub.depsTail = newLink
  dep.subsTail = newLink

  if (nextDep !== undefined) nextDep.prevDep = newLink
  if (prevDep !== undefined) prevDep.nextDep = newLink
  else sub.deps = newLink
  if (prevSub !== undefined) prevSub.nextSub = newLink
  else dep.subs = newLink

  // Track dependency for devtools
  if (isDev) trackDependencyDevtools(dep, sub)
}
/**
 * Remove a link between a dependency and a subscriber
 * @param lnk - The link to remove
 * @param sub - The subscriber node (defaults to lnk.sub)
 * @returns The next dependency link
 */
function unlink(lnk: Link, sub: ReactiveNode = lnk.sub): Link | undefined {
  const dep = lnk.dep
  const prevDep = lnk.prevDep
  const nextDep = lnk.nextDep
  const nextSub = lnk.nextSub
  const prevSub = lnk.prevSub

  if (nextDep !== undefined) nextDep.prevDep = prevDep
  else sub.depsTail = prevDep
  if (prevDep !== undefined) prevDep.nextDep = nextDep
  else sub.deps = nextDep

  if (nextSub !== undefined) nextSub.prevSub = prevSub
  else dep.subsTail = prevSub
  if (prevSub !== undefined) prevSub.nextSub = nextSub
  else if ((dep.subs = nextSub) === undefined) unwatched(dep)

  // Notify devtools that dependency edge is removed
  if (isDev) untrackDependencyDevtools(dep, sub)

  return nextDep
}
/**
 * Handle when a dependency becomes unwatched
 * @param dep - The dependency node
 */
function unwatched(dep: ReactiveNode): void {
  if (!(dep.flags & Mutable)) {
    disposeNode(dep)
  } else if ('getter' in dep && dep.getter !== undefined) {
    dep.depsTail = undefined
    dep.flags = MutableDirty
    purgeDeps(dep)
  }
}
/**
 * Propagate changes through the reactive graph
 * @param firstLink - The first link to propagate from
 */
function propagate(firstLink: Link): void {
  let link = firstLink
  let next = link.nextSub
  let stack: StackFrame | undefined

  top: for (;;) {
    const sub = link.sub
    let flags = sub.flags
    if (flags & Pending) {
      promoteQueuedEffect(sub)
    }

    if (!(flags & 60)) {
      sub.flags = flags | Pending
    } else if (!(flags & 12)) {
      flags = 0
    } else if (!(flags & Running)) {
      sub.flags = (flags & ~Recursed) | Pending
    } else if (!(flags & 48)) {
      let vlink = sub.depsTail
      let valid = false
      while (vlink !== undefined) {
        if (vlink === link) {
          valid = true
          break
        }
        vlink = vlink.prevDep
      }
      if (valid) {
        sub.flags = flags | 40
        flags &= Mutable
      } else {
        flags = 0
      }
    } else {
      flags = 0
    }

    if (flags & Watching) notify(sub)

    if (flags & Mutable) {
      const subSubs = sub.subs
      if (subSubs !== undefined) {
        const nextSub = subSubs.nextSub
        if (nextSub !== undefined) {
          stack = { value: next, prev: stack }
          next = nextSub
        }
        link = subSubs
        continue
      }
    }

    if (next !== undefined) {
      link = next
      next = link.nextSub
      continue
    }

    while (stack !== undefined) {
      link = stack.value!
      stack = stack.prev
      if (link !== undefined) {
        next = link.nextSub
        continue top
      }
    }
    break
  }
}
/**
 * Check if a node is dirty by traversing its dependencies
 * @param firstLink - The first link to check
 * @param sub - The subscriber node
 * @returns True if the node is dirty
 */
function checkDirty(firstLink: Link, sub: ReactiveNode): boolean {
  let link = firstLink
  let stack: StackFrame | undefined
  let checkDepth = 0
  let dirty = false

  top: for (;;) {
    const dep = link.dep
    const depFlags = dep.flags

    if (sub.flags & Dirty) {
      dirty = true
    } else if ((depFlags & MutableDirty) === MutableDirty) {
      if (update(dep)) {
        const subs = dep.subs
        if (subs !== undefined && subs.nextSub !== undefined) shallowPropagate(subs)
        dirty = true
      }
    } else if ((depFlags & MutablePending) === MutablePending) {
      if (!dep.deps) {
        // No dependencies to check, skip this node
        const nextDep = link.nextDep
        if (nextDep !== undefined) {
          link = nextDep
          continue
        }
      } else {
        if (link.nextSub !== undefined || link.prevSub !== undefined) {
          stack = { value: link, prev: stack }
        }
        link = dep.deps
        sub = dep
        ++checkDepth
        continue
      }
    }

    if (!dirty) {
      const nextDep = link.nextDep
      if (nextDep !== undefined) {
        link = nextDep
        continue
      }
    }

    while (checkDepth-- > 0) {
      const firstSub = sub.subs!
      const hasMultipleSubs = firstSub.nextSub !== undefined

      if (hasMultipleSubs) {
        link = stack!.value!
        stack = stack!.prev
      } else {
        link = firstSub
      }

      if (dirty) {
        if (update(sub)) {
          if (hasMultipleSubs) shallowPropagate(firstSub)
          sub = link.sub
          continue
        }
        dirty = false
      } else {
        sub.flags &= ~Pending
      }

      sub = link.sub
      const nextDep = link.nextDep
      if (nextDep !== undefined) {
        link = nextDep
        continue top
      }
    }

    return dirty
  }
}
/**
 * Shallow propagate changes without traversing deeply
 * @param firstLink - The first link to propagate from
 */
function shallowPropagate(firstLink: Link): void {
  let link: Link | undefined = firstLink
  do {
    const sub = link.sub
    const flags = sub.flags
    if ((flags & 48) === Pending) {
      promoteQueuedEffect(sub)
      sub.flags = flags | Dirty
      if ((flags & 6) === Watching) notify(sub)
    }
    link = link.nextSub
  } while (link !== undefined)
}
/**
 * Update a reactive node (signal or computed)
 * @param node - The node to update
 * @returns True if the value changed
 */
function update(node: ReactiveNode): boolean {
  return 'getter' in node && node.getter !== undefined
    ? updateComputed(node as ComputedNode)
    : updateSignal(node as SignalNode)
}

function valuesDiffer<T>(
  node: { equals?: false | ((prev: T, next: T) => boolean) },
  prev: T,
  next: T,
): boolean {
  if (node.equals === false) return true
  if (typeof node.equals === 'function') return !node.equals(prev, next)
  return prev !== next
}
/**
 * Notify an effect and add it to the queue
 * @param effect - The effect to notify
 */
function notify(effect: ReactiveNode): void {
  effect.flags &= ~Watching
  const effects: EffectNode[] = []

  for (;;) {
    effects.push(effect as EffectNode)
    const nextLink = effect.subs
    if (nextLink === undefined) break
    effect = nextLink.sub
    if (effect === undefined || !(effect.flags & Watching)) break
    effect.flags &= ~Watching
  }

  // Route effects to appropriate queue based on transition context
  const targetPriority = isInTransition ? QueuedLow : QueuedHigh
  for (let i = effects.length - 1; i >= 0; i--) {
    queueEffect(effects[i]!, targetPriority)
  }
}

function queueEffect(effect: EffectNode, priority: 1 | 2): void {
  if (priority === QueuedHigh) {
    if (effect.queuedPriority === QueuedHigh) return
    effect.queuedPriority = QueuedHigh
    highPriorityQueue.push(effect)
    return
  }

  if (effect.queuedPriority !== undefined) return
  effect.queuedPriority = QueuedLow
  lowPriorityQueue.push(effect)
}

function promoteQueuedEffect(node: ReactiveNode): void {
  if (isInTransition) return
  const effect = node as EffectNode
  if (effect.queuedPriority === QueuedLow) {
    queueEffect(effect, QueuedHigh)
  }
}
/**
 * Purge all dependencies from a subscriber
 * @param sub - The subscriber node
 */
function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (dep !== undefined) dep = unlink(dep, sub)
}
/**
 * Dispose a reactive node
 * @param node - The node to dispose
 */
function disposeNode(node: ReactiveNode): void {
  if (isDev) {
    if ('fn' in node && typeof node.fn === 'function') {
      disposeEffectDevtools(node as EffectNode)
    } else if ('getter' in node && typeof node.getter === 'function') {
      disposeComputedDevtools(node as ComputedNode)
    } else if ('currentValue' in node) {
      disposeSignalDevtools(node as SignalNode)
    }
  }

  node.depsTail = undefined
  node.flags = 0
  purgeDeps(node)
  let sub = node.subs
  while (sub !== undefined) {
    const next = sub.nextSub
    unlink(sub)
    sub = next
  }
}
/**
 * Update a signal node
 * @param s - The signal node
 * @returns True if the value changed
 */
function updateSignal(s: SignalNode): boolean {
  s.flags = Mutable
  const current = s.currentValue
  const pending = s.pendingValue
  if (valuesDiffer(s, current, pending)) {
    s.prevValue = current
    s.prevFlushId = currentFlushId
    s.currentValue = pending
    return true
  }
  return false
}
/**
 * Update a computed node
 * @param c - The computed node
 * @returns True if the value changed
 */
function updateComputed<T>(c: ComputedNode<T>): boolean {
  ++cycle
  const oldValue = c.value
  c.depsTail = undefined
  c.flags = MutableRunning
  const prevSub = activeSub
  activeSub = c

  try {
    const newValue = c.getter(oldValue)
    activeSub = prevSub
    c.flags &= ~Running
    purgeDeps(c)
    if (valuesDiffer(c, oldValue, newValue)) {
      c.prevValue = oldValue
      c.prevFlushId = currentFlushId
      c.value = newValue
      if (isDev) updateComputedDevtools(c, newValue)
      return true
    }
    return false
  } catch (e) {
    activeSub = prevSub
    c.flags &= ~Running
    // Keep dependency graph consistent even when getter throws.
    // Without this, stale old deps can remain subscribed.
    purgeDeps(c)
    throw e
  }
}
/**
 * Run an effect
 * @param e - The effect node
 */
function runEffect(e: EffectNode): void {
  const flags = e.flags
  const runCleanup = () => {
    if (!e.runCleanup) return
    if (isDev) effectCleanupDevtools(e)
    inCleanup = true
    activeCleanupFlushId = currentFlushId
    try {
      withRootContext(e.root, () => {
        e.runCleanup!()
      })
    } finally {
      activeCleanupFlushId = 0
      inCleanup = false
    }
  }
  if (flags & Dirty) {
    // Run cleanup before re-run; values are still the previous commit.
    runCleanup()
    ++cycle
    e.depsTail = undefined
    e.flags = WatchingRunning
    const prevSub = activeSub
    activeSub = e
    try {
      e.fn()
      activeSub = prevSub
      e.flags = Watching
      purgeDeps(e)
    } catch (err) {
      activeSub = prevSub
      e.flags = Watching
      // Keep dependency graph consistent even when effect throws.
      // Without this, stale old deps can remain subscribed.
      purgeDeps(e)
      throw err
    }
  } else if (flags & Pending && e.deps) {
    let isDirty: boolean
    try {
      isDirty = checkDirty(e.deps, e)
    } catch (err) {
      if (handleSuspend(err as SuspenseToken, e.root)) {
        if (e.flags !== 0) {
          e.flags = Watching
        }
        return
      }
      if (handleError(err, { source: 'effect' }, e.root)) {
        if (e.flags !== 0) {
          e.flags = Watching
        }
        return
      }
      throw err
    }
    if (isDirty) {
      // Only run cleanup if the effect will actually re-run.
      // Cleanup reads should observe previous values for this flush.
      runCleanup()
      ++cycle
      e.depsTail = undefined
      e.flags = WatchingRunning
      const prevSub = activeSub
      activeSub = e
      try {
        e.fn()
        activeSub = prevSub
        e.flags = Watching
        purgeDeps(e)
      } catch (err) {
        activeSub = prevSub
        e.flags = Watching
        // Keep dependency graph consistent even when effect throws.
        // Without this, stale old deps can remain subscribed.
        purgeDeps(e)
        throw err
      }
    } else {
      e.flags = Watching
    }
  } else {
    e.flags = Watching
  }
}
/**
 * Schedule a flush in a microtask to coalesce synchronous writes
 */
export function scheduleFlush(): void {
  const hasWork = highPriorityQueue.length > 0 || lowPriorityQueue.length > 0
  if (flushScheduled || !hasWork) return
  if (batchDepth > 0) return
  flushScheduled = true
  enqueueMicrotask(() => {
    flush()
  })
}
/**
 * Flush all queued effects with priority-based scheduling
 * High priority effects execute first; low priority can be interrupted
 */
function flush(): void {
  beginFlushGuard()
  let flushReported = false
  const finishFlush = () => {
    if (flushReported && isDev) {
      flushEndDevtools()
    }
    endFlushGuard()
  }
  if (batchDepth > 0) {
    // If batching is active, defer until the batch completes
    scheduleFlush()
    finishFlush()
    return
  }
  const hasWork = highPriorityQueue.length > 0 || lowPriorityQueue.length > 0
  if (!hasWork) {
    flushScheduled = false
    finishFlush()
    return
  }
  currentFlushId++
  flushScheduled = false
  if (isDev) {
    flushStartDevtools()
    flushReported = true
  }

  // 1. Process all high-priority effects first
  let highIndex = 0
  while (highIndex < highPriorityQueue.length) {
    const e = highPriorityQueue[highIndex]!
    if (e.queuedPriority !== QueuedHigh) {
      highIndex++
      continue
    }
    if (!beforeEffectRunGuard()) {
      // fix: When cycle guard fails, drop the current queues to avoid microtask spin.
      // Dev mode will throw inside beforeEffectRunGuard; this branch is for prod warnings.
      for (let i = 0; i < highPriorityQueue.length; i++) {
        const queued = highPriorityQueue[i]
        if (queued && queued.flags !== 0) {
          queued.flags = Watching
          queued.queuedPriority = undefined
        }
      }
      for (let i = 0; i < lowPriorityQueue.length; i++) {
        const queued = lowPriorityQueue[i]
        if (queued && queued.flags !== 0) {
          queued.flags = Watching
          queued.queuedPriority = undefined
        }
      }
      highPriorityQueue.length = 0
      lowPriorityQueue.length = 0
      flushScheduled = false
      finishFlush()
      return
    }
    highIndex++
    e.queuedPriority = undefined
    runEffect(e)
  }
  highPriorityQueue.length = 0

  // 2. Process low-priority effects, interruptible by high priority
  let lowIndex = 0
  while (lowIndex < lowPriorityQueue.length) {
    // Check if high priority work arrived during low priority execution
    if (highPriorityQueue.length > 0) {
      if (lowIndex > 0) {
        lowPriorityQueue.copyWithin(0, lowIndex)
        lowPriorityQueue.length -= lowIndex
      }
      scheduleFlush()
      finishFlush()
      return
    }
    const e = lowPriorityQueue[lowIndex]!
    if (e.queuedPriority !== QueuedLow) {
      lowIndex++
      continue
    }
    if (!beforeEffectRunGuard()) {
      // fix: When cycle guard fails, drop the current queues to avoid microtask spin.
      // Dev mode will throw inside beforeEffectRunGuard; this branch is for prod warnings.
      for (let i = 0; i < highPriorityQueue.length; i++) {
        const queued = highPriorityQueue[i]
        if (queued && queued.flags !== 0) {
          queued.flags = Watching
          queued.queuedPriority = undefined
        }
      }
      for (let i = 0; i < lowPriorityQueue.length; i++) {
        const queued = lowPriorityQueue[i]
        if (queued && queued.flags !== 0) {
          queued.flags = Watching
          queued.queuedPriority = undefined
        }
      }
      highPriorityQueue.length = 0
      lowPriorityQueue.length = 0
      flushScheduled = false
      finishFlush()
      return
    }
    lowIndex++
    e.queuedPriority = undefined
    runEffect(e)
  }
  lowPriorityQueue.length = 0

  finishFlush()
}
// ============================================================================
// Signal - Inline optimized version
// ============================================================================
/**
 * Create a reactive signal
 * @param initialValue - The initial value
 * @returns A signal accessor function
 */
export function signal<T>(initialValue: T, options?: SignalOptions<T>): SignalAccessor<T> {
  const s: SignalNode<T> = {
    currentValue: initialValue,
    pendingValue: initialValue,
    subs: undefined,
    subsTail: undefined,
    flags: Mutable,
    __id: undefined as number | undefined,
  }
  if (options?.equals !== undefined) s.equals = options.equals
  if (options?.name !== undefined) s.name = options.name
  if (options?.devToolsSource !== undefined) s.devToolsSource = options.devToolsSource
  if (isDev) registerSignalDevtools(s)
  const accessor = signalOper.bind(s as any) as SignalAccessor<T> & Record<symbol, boolean>
  accessor[SIGNAL_MARKER] = true
  return accessor as SignalAccessor<T>
}
function signalOper<T>(this: SignalNode<T>, value?: T): T | void {
  if (arguments.length > 0) {
    const next = value as T
    const prev = this.pendingValue
    if (valuesDiffer(this, prev as T, next)) {
      this.pendingValue = next
      this.flags = MutableDirty
      if (isDev) updateSignalDevtools(this, next)
      const subs = this.subs
      if (subs !== undefined) {
        propagate(subs)
        if (!batchDepth) scheduleFlush()
      }
    }
    return
  }

  const flags = this.flags
  // During cleanup, don't update signal - return currentValue as-is
  if (flags & Dirty && !inCleanup) {
    if (updateSignal(this as any)) {
      const subs = this.subs
      if (subs !== undefined) shallowPropagate(subs)
    }
  }
  if (inCleanup) {
    if (this.prevFlushId === activeCleanupFlushId) {
      return this.prevValue as T
    }
    return this.currentValue
  }

  let sub = activeSub
  while (sub !== undefined) {
    if (sub.flags & 3) {
      link(this as any, sub, cycle)
      break
    }
    const subSubs = sub.subs
    sub = subSubs !== undefined ? subSubs.sub : undefined
  }

  return this.currentValue
}
// ============================================================================
// Computed
// ============================================================================
/**
 * Create a computed reactive value
 * @param getter - The getter function
 * @param options - Computed options
 * @returns A computed accessor function
 */
export function computed<T>(
  getter: (oldValue?: T) => T,
  options?: MemoOptions<T>,
): ComputedAccessor<T> {
  const c: ComputedNode<T> = {
    value: undefined as unknown as T,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter,
    __id: undefined as number | undefined,
  }
  if (options?.equals !== undefined) c.equals = options.equals
  if (options?.name !== undefined) c.name = options.name
  if (options?.devToolsSource !== undefined) c.devToolsSource = options.devToolsSource
  if (options?.internal === true) c.devToolsInternal = true
  if (isDev) registerComputedDevtools(c)
  const bound = (computedOper as (this: ComputedNode<T>) => T).bind(
    c as any,
  ) as ComputedAccessor<T> & Record<symbol, boolean>
  bound[COMPUTED_MARKER] = true
  return bound as ComputedAccessor<T>
}
function computedOper<T>(this: ComputedNode<T>): T {
  // fix: During cleanup, return previous value for this flush without triggering updates.
  // This ensures cleanup functions observe the pre-commit state for this effect.
  if (inCleanup) {
    if (this.prevFlushId === activeCleanupFlushId) {
      return this.prevValue as T
    }
    return this.value
  }

  const flags = this.flags

  if (flags & Dirty) {
    if (updateComputed(this)) {
      const subs = this.subs
      if (subs !== undefined) shallowPropagate(subs)
    }
  } else if (flags & Pending) {
    if (this.deps && checkDirty(this.deps, this)) {
      if (updateComputed(this)) {
        const subs = this.subs
        if (subs !== undefined) shallowPropagate(subs)
      }
    } else {
      this.flags = flags & ~Pending
    }
  } else if (!flags) {
    this.depsTail = undefined
    this.flags = MutableRunning
    const prevSub = setActiveSub(this)
    try {
      this.value = this.getter(undefined)
      if (isDev) updateComputedDevtools(this, this.value)
    } catch (err) {
      // Initial evaluation failed: remove partially tracked dependencies
      // and allow a future read to retry from a clean slate.
      this.flags = 0
      purgeDeps(this)
      throw err
    } finally {
      setActiveSub(prevSub)
      if (this.flags & Running) {
        this.flags &= ~Running
      }
    }
  }

  if (activeSub !== undefined) link(this, activeSub, cycle)
  return this.value
}
// ============================================================================
// Effect
// ============================================================================
/**
 * Create a reactive effect
 * @param fn - The effect function
 * @param options - Effect options
 * @returns An effect disposer function
 */
export function effect(fn: () => void, options?: EffectOptions): EffectDisposer {
  const e: EffectNode = {
    fn,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: WatchingRunning,
    ...(options?.name !== undefined ? { name: options.name } : {}),
    ...(options?.devToolsSource !== undefined ? { devToolsSource: options.devToolsSource } : {}),
    __id: undefined as number | undefined,
  }
  const root = getCurrentRoot()
  if (root) {
    e.root = root
  }

  if (isDev) registerEffectDevtools(e)
  e.fn = wrapEffectFnWithDevtoolsTiming(e, fn)

  const prevSub = activeSub
  if (prevSub !== undefined) link(e, prevSub, 0)
  activeSub = e

  let didThrow = false
  let thrown: unknown
  try {
    e.fn()
  } catch (err) {
    didThrow = true
    thrown = err
  } finally {
    activeSub = prevSub
    if (didThrow) {
      // Initial execution failed: fully detach partially collected graph links.
      disposeNode(e)
    } else {
      e.flags &= ~Running
    }
  }
  if (didThrow) throw thrown

  const disposer = effectOper.bind(e) as EffectDisposer & Record<symbol, boolean>
  disposer[EFFECT_MARKER] = true
  return disposer as EffectDisposer
}

/**
 * Create a reactive effect with a custom cleanup runner
 * The cleanup runner is called BEFORE signal values are committed, allowing
 * cleanup functions to access the previous values of signals.
 * @param fn - The effect function
 * @param cleanupRunner - Function to run cleanups before signal value commit
 * @param root - Root context for error/suspense handling (defaults to current root)
 * @returns An effect disposer function
 */
export function effectWithCleanup(
  fn: () => void,
  cleanupRunner: () => void,
  root?: RootContext,
  options?: EffectOptions,
): EffectDisposer {
  const e: EffectNode = {
    fn,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: WatchingRunning,
    runCleanup: cleanupRunner,
    ...(options?.name !== undefined ? { name: options.name } : {}),
    ...(options?.devToolsSource !== undefined ? { devToolsSource: options.devToolsSource } : {}),
    __id: undefined as number | undefined,
  }
  const resolvedRoot = root ?? getCurrentRoot()
  if (resolvedRoot) {
    e.root = resolvedRoot
  }

  if (isDev) registerEffectDevtools(e)
  e.fn = wrapEffectFnWithDevtoolsTiming(e, fn)

  const prevSub = activeSub
  if (prevSub !== undefined) link(e, prevSub, 0)
  activeSub = e

  let didThrow = false
  let thrown: unknown
  try {
    e.fn()
  } catch (err) {
    didThrow = true
    thrown = err
  } finally {
    activeSub = prevSub
    if (didThrow) {
      // Initial execution failed: fully detach partially collected graph links.
      disposeNode(e)
    } else {
      e.flags &= ~Running
    }
  }
  if (didThrow) throw thrown

  const disposer = effectOper.bind(e) as EffectDisposer & Record<symbol, boolean>
  disposer[EFFECT_MARKER] = true
  return disposer as EffectDisposer
}

function effectOper(this: EffectNode): void {
  disposeNode(this)
}
// ============================================================================
// Effect Scope
// ============================================================================
/**
 * Create a reactive effect scope
 * @param fn - The scope function
 * @returns An effect scope disposer function
 */
export function effectScope(fn: () => void): EffectScopeDisposer {
  const e = { deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, flags: 0 }

  const prevSub = activeSub
  if (prevSub !== undefined) link(e, prevSub, 0)
  activeSub = e

  let didThrow = false
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    didThrow = true
    thrown = err
  } finally {
    activeSub = prevSub
    if (didThrow) {
      // Scope construction failed: detach nested effects/memos linked to this scope.
      disposeNode(e)
    }
  }
  if (didThrow) throw thrown

  const disposer = effectScopeOper.bind(e) as EffectScopeDisposer & Record<symbol, boolean>
  disposer[EFFECT_SCOPE_MARKER] = true
  return disposer as EffectScopeDisposer
}
function effectScopeOper(this: EffectScopeNode): void {
  disposeNode(this)
}
// ============================================================================
// Trigger
// ============================================================================
/**
 * Trigger a reactive computation without creating a persistent subscription
 * @param fn - The function to run
 */
export function trigger(fn: () => void): void {
  const sub: SubscriberNode = { deps: undefined, depsTail: undefined, flags: Watching }
  const prevSub = activeSub
  activeSub = sub as ReactiveNode

  try {
    fn()
  } finally {
    activeSub = prevSub
    let lnk = sub.deps
    while (lnk !== undefined) {
      const dep = lnk.dep
      lnk = unlink(lnk, sub)
      const subs = dep.subs
      if (subs !== undefined) {
        sub.flags = 0
        propagate(subs)
        shallowPropagate(subs)
      }
    }
    if (!batchDepth) scheduleFlush()
  }
}
// ============================================================================
// Batch processing & Utility API
// ============================================================================
/**
 * Start a batch of updates
 */
export function startBatch(): void {
  const enteringOuterBatch = batchDepth === 0
  ++batchDepth
  if (enteringOuterBatch && isDev) {
    batchStartDevtools()
  }
}
/**
 * End a batch of updates and flush effects
 */
export function endBatch(): void {
  if (batchDepth === 0) return
  --batchDepth
  if (batchDepth === 0) {
    if (isDev) {
      batchEndDevtools()
    }
    flush()
  }
}
/**
 * Execute a function in a batch
 * @param fn - The function to execute
 * @returns The return value of the function
 */
export function batch<T>(fn: () => T): T {
  const enteringOuterBatch = batchDepth === 0
  ++batchDepth
  if (enteringOuterBatch && isDev) {
    batchStartDevtools()
  }
  let result!: T
  let error: unknown
  try {
    result = fn()
  } catch (e) {
    error = e
  } finally {
    --batchDepth
    if (batchDepth === 0) {
      if (isDev) {
        batchEndDevtools()
      }
      try {
        flush()
      } catch (flushErr) {
        if (error === undefined) {
          error = flushErr
        }
      }
    }
  }
  if (error !== undefined) {
    throw error
  }
  return result
}
/**
 * Get the current active subscriber
 * @returns The active subscriber or undefined
 */
export function getActiveSub(): ReactiveNode | undefined {
  return activeSub
}
/**
 * Set the active subscriber
 * @param sub - The new active subscriber
 * @returns The previous active subscriber
 */
export function setActiveSub(sub: ReactiveNode | undefined): ReactiveNode | undefined {
  const prev = activeSub
  activeSub = sub
  return prev
}
/**
 * Get the current batch depth
 * @returns The current batch depth
 */
export function getBatchDepth(): number {
  return batchDepth
}
/**
 * Reset all global reactive state for test isolation.
 * ONLY use this in test setup/teardown - never in production code.
 * This clears effect queues, resets batch depth, and clears pending flushes.
 */
export function __resetReactiveState(): void {
  for (const effect of highPriorityQueue) {
    if (effect) effect.queuedPriority = undefined
  }
  for (const effect of lowPriorityQueue) {
    if (effect) effect.queuedPriority = undefined
  }
  highPriorityQueue.length = 0
  lowPriorityQueue.length = 0
  batchDepth = 0
  activeSub = undefined
  flushScheduled = false
  isInTransition = false
  inCleanup = false
  cycle = 0
  currentFlushId = 0
  activeCleanupFlushId = 0
  clearDevtoolsSignalSetters()
}
/**
 * Execute a function without tracking dependencies
 * @param fn - The function to execute
 * @returns The return value of the function
 */
export function untrack<T>(fn: () => T): T {
  const prev = activeSub
  activeSub = undefined
  try {
    return fn()
  } finally {
    activeSub = prev
  }
}
/**
 * Peek at a reactive value without tracking it as a dependency
 * @param accessor - The accessor function
 * @returns The value
 */
export function peek<T>(accessor: () => T): T {
  return untrack(accessor)
}
// This ensures correct detection even after minification
/**
 * Check if a function is a signal accessor
 * @param fn - The function to check
 * @returns True if the function is a signal accessor
 */
export function isSignal(fn: unknown): fn is SignalAccessor<unknown> {
  return (
    typeof fn === 'function' && (fn as unknown as Record<symbol, boolean>)[SIGNAL_MARKER] === true
  )
}
/**
 * Check if a function is a computed accessor
 * @param fn - The function to check
 * @returns True if the function is a computed accessor
 */
export function isComputed(fn: unknown): fn is ComputedAccessor<unknown> {
  return (
    typeof fn === 'function' && (fn as unknown as Record<symbol, boolean>)[COMPUTED_MARKER] === true
  )
}
/**
 * Check if a function is an effect disposer
 * @param fn - The function to check
 * @returns True if the function is an effect disposer
 */
export function isEffect(fn: unknown): fn is EffectDisposer {
  return (
    typeof fn === 'function' && (fn as unknown as Record<symbol, boolean>)[EFFECT_MARKER] === true
  )
}
/**
 * Check if a function is an effect scope disposer
 * @param fn - The function to check
 * @returns True if the function is an effect scope disposer
 */
export function isEffectScope(fn: unknown): fn is EffectScopeDisposer {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<symbol, boolean>)[EFFECT_SCOPE_MARKER] === true
  )
}
// ============================================================================
// Transition Context (for priority scheduling)
// ============================================================================
/**
 * Set the transition context
 * @param value - Whether we're inside a transition
 * @returns The previous transition context value
 */
export function setTransitionContext(value: boolean): boolean {
  const prev = isInTransition
  isInTransition = value
  return prev
}
/**
 * Get the current transition context
 * @returns True if currently inside a transition
 */
export function getTransitionContext(): boolean {
  return isInTransition
}
// Export aliases for API compatibility
export { signal as createSignal }
export type { SignalAccessor as Signal }

export { flush, link, unlink, propagate, checkDirty, shallowPropagate }
export default {
  signal,
  computed,
  effect,
  effectScope,
  trigger,
  batch,
  startBatch,
  endBatch,
  flush,
  untrack,
  peek,
  isSignal,
  isComputed,
  isEffect,
  isEffectScope,
  getActiveSub,
  setActiveSub,
  getBatchDepth,
  link,
  unlink,
  propagate,
  checkDirty,
  shallowPropagate,
  createReactiveSystem,
  ReactiveFlags,
}

interface DevtoolsIdentifiable {
  __id?: number
}

let registerSignalDevtools: <T>(node: SignalNode<T>) => number | undefined = () => undefined
let updateSignalDevtools: <T>(node: SignalNode<T>, value: unknown) => void = () => {}
let disposeSignalDevtools: <T>(node: SignalNode<T>) => void = () => {}
let registerComputedDevtools: <T>(node: ComputedNode<T>) => number | undefined = () => undefined
let updateComputedDevtools: <T>(node: ComputedNode<T>, value: unknown) => void = () => {}
let disposeComputedDevtools: <T>(node: ComputedNode<T>) => void = () => {}
let registerEffectDevtools: (node: EffectNode) => number | undefined = () => undefined
let effectRunDevtools: (node: EffectNode, duration?: number) => void = () => {}
let wrapEffectFnWithDevtoolsTiming: (node: EffectNode, fn: () => void) => () => void = (
  _node,
  fn,
) => fn
let effectCleanupDevtools: (node: EffectNode) => void = () => {}
let disposeEffectDevtools: (node: EffectNode) => void = () => {}
let trackDependencyDevtools: (dep: ReactiveNode, sub: ReactiveNode) => void = () => {}
let untrackDependencyDevtools: (dep: ReactiveNode, sub: ReactiveNode) => void = () => {}
let batchStartDevtools: () => void = () => {}
let batchEndDevtools: () => void = () => {}
let flushStartDevtools: () => void = () => {}
let flushEndDevtools: () => void = () => {}
let clearDevtoolsSignalSetters: () => void = () => {}

// Keep this as a direct conditional expression (instead of `if (isDev)`) so
// bundlers can eliminate the entire devtools setup block when `__DEV__` is
// defined as `false` in production builds.
if (
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
) {
  // Unified ID counter for all reactive nodes (signal/computed/effect)
  // to prevent ID collisions when storing in single devtools maps
  let nextDevtoolsId = 0
  const getSignalSetterMap = () => {
    if (typeof globalThis === 'undefined') return undefined
    const global = globalThis as typeof globalThis & {
      __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
    }
    if (!global.__FICT_DEVTOOLS_SIGNALS__) {
      global.__FICT_DEVTOOLS_SIGNALS__ = new Map<number, (value: unknown) => void>()
    }
    return global.__FICT_DEVTOOLS_SIGNALS__
  }

  const getExistingSignalSetterMap = () => {
    if (typeof globalThis === 'undefined') return undefined
    return (
      globalThis as typeof globalThis & {
        __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
      }
    ).__FICT_DEVTOOLS_SIGNALS__
  }

  registerSignalDevtools = node => {
    const hook = getDevtoolsHook()
    if (!hook) return undefined
    const id = ++nextDevtoolsId
    const options: { name?: string; source?: string } = {}
    if (node.name !== undefined) options.name = node.name
    if (node.devToolsSource !== undefined) options.source = node.devToolsSource
    const ownerId = __fictGetCurrentComponentId()
    if (ownerId !== undefined) (options as any).ownerId = ownerId
    hook.registerSignal(id, node.currentValue, options)
    ;(node as SignalNode & DevtoolsIdentifiable).__id = id
    getSignalSetterMap()?.set(id, value => {
      signalOper.call(node as SignalNode<unknown>, value)
    })
    return id
  }

  updateSignalDevtools = (node, value) => {
    const hook = getDevtoolsHook()
    if (!hook) return
    const id = (node as SignalNode & DevtoolsIdentifiable).__id
    if (id) hook.updateSignal(id, value)
  }

  disposeSignalDevtools = node => {
    const identifiable = node as SignalNode & DevtoolsIdentifiable
    const id = identifiable.__id
    if (!id) return
    const hook = getDevtoolsHook()
    hook?.disposeSignal?.(id)
    getExistingSignalSetterMap()?.delete(id)
    delete identifiable.__id
  }

  registerComputedDevtools = node => {
    const hook = getDevtoolsHook()
    if (!hook) return undefined
    if (node.devToolsInternal) return undefined
    const id = ++nextDevtoolsId
    const options: { name?: string; source?: string } = {}
    if (node.name !== undefined) options.name = node.name
    if (node.devToolsSource !== undefined) options.source = node.devToolsSource
    const ownerId = __fictGetCurrentComponentId()
    if (ownerId !== undefined) (options as any).ownerId = ownerId
    ;(options as any).hasValue = false
    hook.registerComputed(id, node.value, options)
    ;(node as ComputedNode & DevtoolsIdentifiable).__id = id
    return id
  }

  updateComputedDevtools = (node, value) => {
    const hook = getDevtoolsHook()
    if (!hook) return
    const id = (node as ComputedNode & DevtoolsIdentifiable).__id
    if (id) hook.updateComputed(id, value)
  }

  disposeComputedDevtools = node => {
    const identifiable = node as ComputedNode & DevtoolsIdentifiable
    const id = identifiable.__id
    if (!id) return
    const hook = getDevtoolsHook()
    hook?.disposeComputed?.(id)
    delete identifiable.__id
  }

  registerEffectDevtools = node => {
    const hook = getDevtoolsHook()
    if (!hook) return undefined
    const id = ++nextDevtoolsId
    const options: { ownerId?: number; source?: string } = {}
    const ownerId = __fictGetCurrentComponentId()
    if (ownerId !== undefined) options.ownerId = ownerId
    if (node.devToolsSource !== undefined) options.source = node.devToolsSource
    hook.registerEffect(id, Object.keys(options).length > 0 ? options : undefined)
    ;(node as EffectNode & DevtoolsIdentifiable).__id = id
    return id
  }

  effectRunDevtools = (node, duration) => {
    const hook = getDevtoolsHook()
    if (!hook) return
    const id = (node as EffectNode & DevtoolsIdentifiable).__id
    if (id) hook.effectRun(id, duration)
  }

  wrapEffectFnWithDevtoolsTiming = (node, fn) => {
    return () => {
      const startedAt = performance.now()
      try {
        fn()
      } finally {
        effectRunDevtools(node, performance.now() - startedAt)
      }
    }
  }

  effectCleanupDevtools = node => {
    const hook = getDevtoolsHook()
    if (!hook) return
    const id = (node as EffectNode & DevtoolsIdentifiable).__id
    if (id) hook.effectCleanup?.(id)
  }

  disposeEffectDevtools = node => {
    const identifiable = node as EffectNode & DevtoolsIdentifiable
    const id = identifiable.__id
    if (!id) return
    const hook = getDevtoolsHook()
    hook?.disposeEffect?.(id)
    delete identifiable.__id
  }

  trackDependencyDevtools = (dep, sub) => {
    const hook = getDevtoolsHook()
    if (!hook?.trackDependency) return
    const depId = (dep as ReactiveNode & DevtoolsIdentifiable).__id
    const subId = (sub as ReactiveNode & DevtoolsIdentifiable).__id
    if (depId && subId) hook.trackDependency(subId, depId)
  }

  untrackDependencyDevtools = (dep, sub) => {
    const hook = getDevtoolsHook()
    if (!hook?.untrackDependency) return
    const depId = (dep as ReactiveNode & DevtoolsIdentifiable).__id
    const subId = (sub as ReactiveNode & DevtoolsIdentifiable).__id
    if (depId && subId) hook.untrackDependency(subId, depId)
  }

  batchStartDevtools = () => {
    const hook = getDevtoolsHook()
    hook?.batchStart?.()
  }

  batchEndDevtools = () => {
    const hook = getDevtoolsHook()
    hook?.batchEnd?.()
  }

  flushStartDevtools = () => {
    const hook = getDevtoolsHook()
    hook?.flushStart?.()
  }

  flushEndDevtools = () => {
    const hook = getDevtoolsHook()
    hook?.flushEnd?.()
  }

  clearDevtoolsSignalSetters = () => {
    getExistingSignalSetterMap()?.clear()
  }
}

// ============================================================================
// Selector
// ============================================================================
/**
 * Create a selector signal that efficiently updates only when the selected key matches.
 * Useful for large lists where only one item is selected.
 *
 * @param source - The source signal returning the current key
 * @param equalityFn - Optional equality function
 * @returns A selector function that takes a key and returns a boolean signal accessor
 */
export function createSelector<T>(
  source: () => T,
  equalityFn: (a: T, b: T) => boolean = (a, b) => a === b,
): (key: T) => boolean {
  let current = source()
  const observers = new Map<T, SignalAccessor<boolean>>()

  const dispose = effect(() => {
    const next = source()
    if (equalityFn(current, next)) return

    const prevSig = observers.get(current)
    if (prevSig) prevSig(false)

    const nextSig = observers.get(next)
    if (nextSig) nextSig(true)

    current = next
  })
  registerRootCleanup(() => {
    dispose()
    observers.clear()
  })

  return (key: T) => {
    let sig = observers.get(key)
    if (!sig) {
      sig = signal(equalityFn(key, current))
      observers.set(key, sig)
      registerRootCleanup(() => observers.delete(key))
    }
    return sig()
  }
}
