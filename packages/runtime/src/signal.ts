import { beginFlushGuard, beforeEffectRunGuard, endFlushGuard } from './cycle-guard'
import { getDevtoolsHook } from './devtools'

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
 * Signal node - mutable reactive value
 */
export interface SignalNode<T = unknown> extends BaseNode {
  /** Current committed value */
  currentValue: T
  /** Pending value to be committed */
  pendingValue: T
  /** Signals don't have dependencies */
  deps?: undefined
  depsTail?: undefined
  getter?: undefined
}

/**
 * Computed node - derived reactive value
 */
export interface ComputedNode<T = unknown> extends BaseNode {
  /** Current computed value */
  value: T
  /** First dependency link */
  deps: Link | undefined
  /** Last dependency link */
  depsTail: Link | undefined
  /** Getter function to compute the value */
  getter: (oldValue: T | undefined) => T
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
// Dual-priority queue for scheduler
const highPriorityQueue: EffectNode[] = []
const lowPriorityQueue: EffectNode[] = []
let isInTransition = false
const enqueueMicrotask =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn: () => void) => {
        Promise.resolve().then(fn)
      }
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
        if (link.nextSub !== undefined || link.prevSub !== undefined) {
          stack = { value: link, prev: stack }
        }
        link = dep.deps!
        sub = dep
        ++checkDepth
        continue
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
      if (link.nextSub !== undefined || link.prevSub !== undefined) {
        stack = { value: link, prev: stack }
      }
      link = dep.deps!
      sub = dep
      ++checkDepth
      continue
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

  // Reverse to maintain correct execution order
  effects.reverse()

  // Route effects to appropriate queue based on transition context
  const targetQueue = isInTransition ? lowPriorityQueue : highPriorityQueue
  for (const e of effects) {
    targetQueue.push(e)
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
  node.depsTail = undefined
  node.flags = 0
  purgeDeps(node)
  const sub = node.subs
  if (sub !== undefined) unlink(sub, node)
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
  if (current !== pending) {
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
    if (oldValue !== newValue) {
      c.value = newValue
      return true
    }
    return false
  } catch (e) {
    activeSub = prevSub
    c.flags &= ~Running
    throw e
  }
}
/**
 * Run an effect
 * @param e - The effect node
 */
function runEffect(e: EffectNode): void {
  const flags = e.flags
  if (flags & Dirty || (flags & Pending && e.deps && checkDirty(e.deps, e))) {
    ++cycle
    effectRunDevtools(e)
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
      throw err
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
  if (batchDepth > 0) {
    // If batching is active, defer until the batch completes
    scheduleFlush()
    endFlushGuard()
    return
  }
  const hasWork = highPriorityQueue.length > 0 || lowPriorityQueue.length > 0
  if (!hasWork) {
    flushScheduled = false
    endFlushGuard()
    return
  }
  flushScheduled = false

  // 1. Process all high-priority effects first
  while (highPriorityQueue.length > 0) {
    const e = highPriorityQueue.shift()!
    if (!beforeEffectRunGuard()) {
      endFlushGuard()
      return
    }
    runEffect(e)
  }

  // 2. Process low-priority effects, interruptible by high priority
  while (lowPriorityQueue.length > 0) {
    // Check if high priority work arrived during low priority execution
    if (highPriorityQueue.length > 0) {
      scheduleFlush()
      endFlushGuard()
      return
    }
    const e = lowPriorityQueue.shift()!
    if (!beforeEffectRunGuard()) {
      endFlushGuard()
      return
    }
    runEffect(e)
  }

  endFlushGuard()
}
// ============================================================================
// Signal - Inline optimized version
// ============================================================================
/**
 * Create a reactive signal
 * @param initialValue - The initial value
 * @returns A signal accessor function
 */
export function signal<T>(initialValue: T): SignalAccessor<T> {
  const s = {
    currentValue: initialValue,
    pendingValue: initialValue,
    subs: undefined,
    subsTail: undefined,
    flags: Mutable,
    __id: undefined as number | undefined,
  }
  registerSignalDevtools(initialValue, s)
  return signalOper.bind(s) as SignalAccessor<T>
}
function signalOper<T>(this: SignalNode<T>, value?: T): T | void {
  if (arguments.length > 0) {
    if (this.pendingValue !== value) {
      this.pendingValue = value as T
      this.flags = MutableDirty
      updateSignalDevtools(this, value)
      const subs = this.subs
      if (subs !== undefined) {
        propagate(subs)
        if (!batchDepth) scheduleFlush()
      }
    }
    return
  }

  const flags = this.flags
  if (flags & Dirty) {
    if (updateSignal(this)) {
      const subs = this.subs
      if (subs !== undefined) shallowPropagate(subs)
    }
  }

  let sub = activeSub
  while (sub !== undefined) {
    if (sub.flags & 3) {
      link(this, sub, cycle)
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
 * @returns A computed accessor function
 */
export function computed<T>(getter: (oldValue?: T) => T): ComputedAccessor<T> {
  const c: ComputedNode<T> = {
    value: undefined as unknown as T,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter,
  }
  const bound = (computedOper as (this: ComputedNode<T>) => T).bind(c)
  return bound as ComputedAccessor<T>
}
function computedOper<T>(this: ComputedNode<T>): T {
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
    this.flags = MutableRunning
    const prevSub = setActiveSub(this)
    try {
      this.value = this.getter(undefined)
    } finally {
      setActiveSub(prevSub)
      this.flags &= ~Running
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
 * @returns An effect disposer function
 */
export function effect(fn: () => void): EffectDisposer {
  const e = {
    fn,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: WatchingRunning,
    __id: undefined as number | undefined,
  }

  registerEffectDevtools(e)

  const prevSub = activeSub
  if (prevSub !== undefined) link(e, prevSub, 0)
  activeSub = e

  try {
    effectRunDevtools(e)
    fn()
  } finally {
    activeSub = prevSub
    e.flags &= ~Running
  }

  return effectOper.bind(e) as EffectDisposer
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

  try {
    fn()
  } finally {
    activeSub = prevSub
  }

  return effectScopeOper.bind(e) as EffectScopeDisposer
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
  ++batchDepth
}
/**
 * End a batch of updates and flush effects
 */
export function endBatch(): void {
  if (--batchDepth === 0) flush()
}
/**
 * Execute a function in a batch
 * @param fn - The function to execute
 * @returns The return value of the function
 */
export function batch<T>(fn: () => T): T {
  ++batchDepth
  try {
    return fn()
  } finally {
    if (--batchDepth === 0) flush()
  }
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
// Type detection - Fixed: using Function.name
/**
 * Check if a function is a signal accessor
 * @param fn - The function to check
 * @returns True if the function is a signal accessor
 */
export function isSignal(fn: unknown): fn is SignalAccessor<unknown> {
  return typeof fn === 'function' && fn.name === 'bound signalOper'
}
/**
 * Check if a function is a computed accessor
 * @param fn - The function to check
 * @returns True if the function is a computed accessor
 */
export function isComputed(fn: unknown): fn is ComputedAccessor<unknown> {
  return typeof fn === 'function' && fn.name === 'bound computedOper'
}
/**
 * Check if a function is an effect disposer
 * @param fn - The function to check
 * @returns True if the function is an effect disposer
 */
export function isEffect(fn: unknown): fn is EffectDisposer {
  return typeof fn === 'function' && fn.name === 'bound effectOper'
}
/**
 * Check if a function is an effect scope disposer
 * @param fn - The function to check
 * @returns True if the function is an effect scope disposer
 */
export function isEffectScope(fn: unknown): fn is EffectScopeDisposer {
  return typeof fn === 'function' && fn.name === 'bound effectScopeOper'
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
export const $state = signal as <T>(value: T) => T

let devtoolsSignalId = 0
let devtoolsEffectId = 0

interface DevtoolsIdentifiable {
  __id?: number
}

function registerSignalDevtools(value: unknown, node: SignalNode): number | undefined {
  const hook = getDevtoolsHook()
  if (!hook) return undefined
  const id = ++devtoolsSignalId
  hook.registerSignal(id, value)
  ;(node as SignalNode & DevtoolsIdentifiable).__id = id
  return id
}

function updateSignalDevtools(node: SignalNode, value: unknown): void {
  const hook = getDevtoolsHook()
  if (!hook) return
  const id = (node as SignalNode & DevtoolsIdentifiable).__id
  if (id) hook.updateSignal(id, value)
}

function registerEffectDevtools(node: EffectNode): number | undefined {
  const hook = getDevtoolsHook()
  if (!hook) return undefined
  const id = ++devtoolsEffectId
  hook.registerEffect(id)
  ;(node as EffectNode & DevtoolsIdentifiable).__id = id
  return id
}

function effectRunDevtools(node: EffectNode): void {
  const hook = getDevtoolsHook()
  if (!hook) return
  const id = (node as EffectNode & DevtoolsIdentifiable).__id
  if (id) hook.effectRun(id)
}
