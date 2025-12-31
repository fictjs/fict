import { enterRootGuard, exitRootGuard } from './cycle-guard'
import type { Cleanup, ErrorInfo, SuspenseToken } from './types'

type LifecycleFn = () => void | Cleanup

export interface RootContext {
  parent?: RootContext | undefined
  onMountCallbacks: LifecycleFn[]
  cleanups: Cleanup[]
  destroyCallbacks: Cleanup[]
  errorHandlers?: ErrorHandler[]
  suspenseHandlers?: SuspenseHandler[]
}

type ErrorHandler = (err: unknown, info?: ErrorInfo) => boolean | void
type SuspenseHandler = (token: SuspenseToken | PromiseLike<unknown>) => boolean | void

let currentRoot: RootContext | undefined
let currentEffectCleanups: Cleanup[] | undefined
const globalErrorHandlers = new WeakMap<RootContext, ErrorHandler[]>()
const globalSuspenseHandlers = new WeakMap<RootContext, SuspenseHandler[]>()

export function createRootContext(parent: RootContext | undefined = currentRoot): RootContext {
  return { parent, onMountCallbacks: [], cleanups: [], destroyCallbacks: [] }
}

export function pushRoot(root: RootContext): RootContext | undefined {
  if (!enterRootGuard(root)) {
    return currentRoot
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
    currentRoot.onMountCallbacks.push(fn)
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
  for (let i = 0; i < cbs.length; i++) {
    const cleanup = cbs[i]!()
    if (typeof cleanup === 'function') {
      root.cleanups.push(cleanup)
    }
  }
  cbs.length = 0
}

export function registerRootCleanup(fn: Cleanup): void {
  if (currentRoot) {
    currentRoot.cleanups.push(fn)
  }
}

export function clearRoot(root: RootContext): void {
  runCleanupList(root.cleanups)
  root.onMountCallbacks.length = 0
}

export function destroyRoot(root: RootContext): void {
  clearRoot(root)
  runCleanupList(root.destroyCallbacks)
  if (root.errorHandlers) {
    root.errorHandlers.length = 0
  }
  if (globalErrorHandlers.has(root)) {
    globalErrorHandlers.delete(root)
  }
  if (root.suspenseHandlers) {
    root.suspenseHandlers.length = 0
  }
  if (globalSuspenseHandlers.has(root)) {
    globalSuspenseHandlers.delete(root)
  }
}

export function createRoot<T>(fn: () => T): { dispose: () => void; value: T } {
  const root = createRootContext()
  const prev = pushRoot(root)
  let value: T
  try {
    value = fn()
  } finally {
    popRoot(prev)
  }
  flushOnMount(root)
  return {
    dispose: () => destroyRoot(root),
    value,
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

export function runCleanupList(list: Cleanup[]): void {
  let error: unknown
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
  list.length = 0
  if (error !== undefined) {
    if (!handleError(error, { source: 'cleanup' })) {
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
    throw new Error('registerErrorHandler must be called within a root')
  }
  if (!currentRoot.errorHandlers) {
    currentRoot.errorHandlers = []
  }
  currentRoot.errorHandlers.push(fn)
  const existing = globalErrorHandlers.get(currentRoot)
  if (existing) {
    existing.push(fn)
  } else {
    globalErrorHandlers.set(currentRoot, [fn])
  }
}

export function registerSuspenseHandler(fn: SuspenseHandler): void {
  if (!currentRoot) {
    throw new Error('registerSuspenseHandler must be called within a root')
  }
  if (!currentRoot.suspenseHandlers) {
    currentRoot.suspenseHandlers = []
  }
  currentRoot.suspenseHandlers.push(fn)
  const existing = globalSuspenseHandlers.get(currentRoot)
  if (existing) {
    existing.push(fn)
  } else {
    globalSuspenseHandlers.set(currentRoot, [fn])
  }
}

export function handleError(err: unknown, info?: ErrorInfo, startRoot?: RootContext): boolean {
  let root: RootContext | undefined = startRoot ?? currentRoot
  let error = err
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
        }
      }
    }
    root = root.parent
  }
  const globalForRoot = startRoot
    ? globalErrorHandlers.get(startRoot)
    : currentRoot
      ? globalErrorHandlers.get(currentRoot)
      : undefined
  if (globalForRoot && globalForRoot.length) {
    for (let i = globalForRoot.length - 1; i >= 0; i--) {
      const handler = globalForRoot[i]!
      try {
        const handled = handler(error, info)
        if (handled !== false) {
          return true
        }
      } catch (nextErr) {
        error = nextErr
      }
    }
  }
  throw error
}

export function handleSuspend(
  token: SuspenseToken | PromiseLike<unknown>,
  startRoot?: RootContext,
): boolean {
  let root: RootContext | undefined = startRoot ?? currentRoot
  while (root) {
    const handlers = root.suspenseHandlers
    if (handlers && handlers.length) {
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i]!
        const handled = handler(token)
        if (handled !== false) return true
      }
    }
    root = root.parent
  }
  const globalForRoot =
    startRoot && globalSuspenseHandlers.get(startRoot)
      ? globalSuspenseHandlers.get(startRoot)
      : currentRoot
        ? globalSuspenseHandlers.get(currentRoot)
        : undefined
  if (globalForRoot && globalForRoot.length) {
    for (let i = globalForRoot.length - 1; i >= 0; i--) {
      const handler = globalForRoot[i]!
      const handled = handler(token)
      if (handled !== false) return true
    }
  }
  return false
}
