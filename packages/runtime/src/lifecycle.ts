import { enterRootGuard, exitRootGuard } from './cycle-guard'
import { getDevtoolsHook } from './devtools'
import type { Cleanup, ErrorInfo, SuspenseToken } from './types'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

type LifecycleFn = () => void | Cleanup

export interface RootContext {
  parent?: RootContext | undefined
  ownerDocument?: Document | undefined
  onMountCallbacks?: LifecycleFn[]
  deferRefAssignments?: boolean | undefined
  deferredRefAssignments?: LifecycleFn[] | undefined
  cleanups: Cleanup[]
  destroyCallbacks: Cleanup[]
  errorHandlers?: ErrorHandler[]
  suspenseHandlers?: SuspenseHandler[]
  suspended?: boolean
}

export interface CreateRootOptions {
  inherit?: boolean
}

type ErrorHandler = (err: unknown, info?: ErrorInfo) => boolean | void
type SuspenseHandler = (token: SuspenseToken | PromiseLike<unknown>) => boolean | void

let currentRoot: RootContext | undefined
let currentEffectCleanups: Cleanup[] | undefined
const rootDevtoolsIds = new WeakMap<RootContext, number>()
let nextRootDevtoolsId = 0

function registerRootDevtools(root: RootContext): void {
  if (!isDev) return
  const hook = getDevtoolsHook()
  if (!hook?.registerRoot) return
  const id = ++nextRootDevtoolsId
  rootDevtoolsIds.set(root, id)
  hook.registerRoot(id)
}

function disposeRootDevtools(root: RootContext): void {
  if (!isDev) return
  const id = rootDevtoolsIds.get(root)
  if (id === undefined) return
  const hook = getDevtoolsHook()
  hook?.disposeRoot?.(id)
  rootDevtoolsIds.delete(root)
}

function setRootSuspendDevtools(root: RootContext, suspended: boolean): void {
  if (!isDev) return
  const id = rootDevtoolsIds.get(root)
  if (id === undefined) return
  const hook = getDevtoolsHook()
  hook?.rootSuspend?.(id, suspended)
}

export function createRootContext(parent?: RootContext): RootContext {
  const root = {
    parent,
    ownerDocument: parent?.ownerDocument,
    cleanups: [],
    destroyCallbacks: [],
    suspended: false,
  }
  registerRootDevtools(root)
  return root
}

export function pushRoot(root: RootContext): RootContext | undefined {
  if (!enterRootGuard(root)) {
    throw new Error('[fict] cycle protection triggered: root-reentry')
  }
  const prev = currentRoot
  currentRoot = root
  return prev
}

export function getCurrentRoot(): RootContext | undefined {
  return currentRoot
}

export function popRoot(prev: RootContext | undefined): void {
  if (currentRoot) {
    exitRootGuard(currentRoot)
  }
  currentRoot = prev
}

export function onMount(fn: LifecycleFn): void {
  if (currentRoot) {
    ;(currentRoot.onMountCallbacks ||= []).push(fn)
    return
  }
  runLifecycle(fn)
}

export function onDestroy(fn: LifecycleFn): void {
  if (currentRoot) {
    currentRoot.destroyCallbacks.push(() => runLifecycle(fn))
    return
  }
  runLifecycle(fn)
}

export function onCleanup(fn: Cleanup): void {
  registerEffectCleanup(fn)
}

export function flushOnMount(root: RootContext): void {
  const cbs = root.onMountCallbacks
  if (!cbs || cbs.length === 0) return
  try {
    withRootContext(root, () => {
      for (let i = 0; i < cbs.length; i++) {
        const cleanup = cbs[i]!()
        if (typeof cleanup === 'function') {
          root.cleanups.push(cleanup)
        }
      }
    })
  } finally {
    cbs.length = 0
  }
}

export function deferRootRefAssignments(root: RootContext): void {
  root.deferRefAssignments = true
  root.deferredRefAssignments = []
}

export function queueDeferredRefAssignment(fn: LifecycleFn): boolean {
  const root = currentRoot
  if (!root?.deferRefAssignments) return false
  ;(root.deferredRefAssignments ||= []).push(fn)
  return true
}

export function flushDeferredRefAssignments(root: RootContext): void {
  const cbs = root.deferredRefAssignments
  root.deferRefAssignments = false
  root.deferredRefAssignments = undefined
  if (!cbs || cbs.length === 0) return
  withRootContext(root, () => {
    for (let i = 0; i < cbs.length; i++) {
      cbs[i]?.()
    }
  })
}

export function withRootContext<T>(root: RootContext | undefined, fn: () => T): T {
  if (!root) return fn()
  const prevRoot = currentRoot
  currentRoot = root
  try {
    return fn()
  } finally {
    currentRoot = prevRoot
  }
}

export function registerRootCleanup(fn: Cleanup): void {
  if (currentRoot) {
    currentRoot.cleanups.push(fn)
  }
}

export function clearRoot(root: RootContext): void {
  runCleanupList(root.cleanups, root)
  if (root.onMountCallbacks) {
    root.onMountCallbacks.length = 0
  }
}

export function destroyRoot(root: RootContext): void {
  clearRoot(root)
  runCleanupList(root.destroyCallbacks, root)
  if (root.errorHandlers) {
    root.errorHandlers.length = 0
  }
  if (root.suspenseHandlers) {
    root.suspenseHandlers.length = 0
  }
  disposeRootDevtools(root)
}

export function createRoot<T>(
  fn: () => T,
  options?: CreateRootOptions,
): { dispose: () => void; value: T } {
  const parent = options?.inherit ? currentRoot : undefined
  const root = createRootContext(parent)
  const prev = pushRoot(root)
  let value: T
  let completed = false
  try {
    try {
      value = fn()
    } finally {
      popRoot(prev)
    }
    flushOnMount(root)
    completed = true
    return {
      dispose: () => destroyRoot(root),
      value,
    }
  } finally {
    if (!completed) {
      destroyRoot(root)
    }
  }
}

export function withEffectCleanups<T>(bucket: Cleanup[], fn: () => T): T {
  const prev = currentEffectCleanups
  currentEffectCleanups = bucket
  try {
    return fn()
  } finally {
    currentEffectCleanups = prev
  }
}

export function registerEffectCleanup(fn: Cleanup): void {
  if (currentEffectCleanups) {
    currentEffectCleanups.push(fn)
  } else {
    registerRootCleanup(fn)
  }
}

export function runCleanupList(list: Cleanup[], root?: RootContext): void {
  let error: unknown
  withRootContext(root, () => {
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        const cleanup = list[i]
        if (cleanup) cleanup()
      } catch (err) {
        if (error === undefined) {
          error = err
        }
      }
    }
  })
  list.length = 0
  if (error !== undefined) {
    if (!handleError(error, { source: 'cleanup' }, root)) {
      throw error
    }
  }
}

function runLifecycle(fn: LifecycleFn): void {
  const cleanup = fn()
  if (typeof cleanup === 'function') {
    cleanup()
  }
}

export function registerErrorHandler(fn: ErrorHandler): void {
  if (!currentRoot) {
    const message = isDev ? 'Needs root' : 'FICT:E_ROOT_HANDLER'
    throw new Error(message)
  }
  if (!currentRoot.errorHandlers) {
    currentRoot.errorHandlers = []
  }
  currentRoot.errorHandlers.push(fn)
}

export function registerSuspenseHandler(fn: SuspenseHandler): void {
  if (!currentRoot) {
    const message = isDev ? 'Needs root' : 'FICT:E_ROOT_SUSPENSE'
    throw new Error(message)
  }
  if (!currentRoot.suspenseHandlers) {
    currentRoot.suspenseHandlers = []
  }
  currentRoot.suspenseHandlers.push(fn)
}

export function handleError(err: unknown, info?: ErrorInfo, startRoot?: RootContext): boolean {
  let root: RootContext | undefined = startRoot ?? currentRoot
  let error = err
  let handlerFailed = false
  while (root) {
    const handlers = root.errorHandlers
    if (handlers && handlers.length) {
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i]!
        try {
          const handled = handler(error, info)
          if (handled !== false) {
            return true
          }
        } catch (nextErr) {
          error = nextErr
          handlerFailed = true
        }
      }
    }
    root = root.parent
  }
  // A boundary which fails while handling an error replaces the original
  // failure. Preserve that fallback/onError exception when no outer boundary
  // accepts it instead of making callers rethrow the stale original error.
  if (handlerFailed) throw error
  // With no handler failure, the caller (e.g., runCleanupList) can decide
  // whether to rethrow the original error from this boolean result.
  return false
}

export function handleSuspend(
  token: SuspenseToken | PromiseLike<unknown>,
  startRoot?: RootContext,
): boolean {
  let root: RootContext | undefined = startRoot ?? currentRoot
  const originRoot = root // Preserve reference to set suspended flag on success
  while (root) {
    const handlers = root.suspenseHandlers
    if (handlers && handlers.length) {
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i]!
        const handled = handler(token)
        if (handled !== false) {
          // Only set suspended = true when a handler actually handles the token
          if (originRoot) {
            originRoot.suspended = true
            setRootSuspendDevtools(originRoot, true)
          }
          return true
        }
      }
    }
    root = root.parent
  }
  return false
}
