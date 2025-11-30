import type { Cleanup } from './types'

type LifecycleFn = () => void | Cleanup

interface RootContext {
  onMountCallbacks: LifecycleFn[]
  cleanups: Cleanup[]
}

let currentRoot: RootContext | undefined
let currentEffectCleanups: Cleanup[] | undefined

export function createRootContext(): RootContext {
  return { onMountCallbacks: [], cleanups: [] }
}

export function pushRoot(root: RootContext): RootContext | undefined {
  const prev = currentRoot
  currentRoot = root
  return prev
}

export function popRoot(prev: RootContext | undefined): void {
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
  registerRootCleanup(() => runLifecycle(fn))
}

export function onCleanup(fn: Cleanup): void {
  registerEffectCleanup(fn)
}

export function flushOnMount(root: RootContext): void {
  for (const cb of root.onMountCallbacks.splice(0)) {
    const cleanup = cb()
    if (typeof cleanup === 'function') {
      root.cleanups.push(cleanup)
    }
  }
}

export function registerRootCleanup(fn: Cleanup): void {
  if (currentRoot) {
    currentRoot.cleanups.push(fn)
  }
}

export function destroyRoot(root: RootContext): void {
  runCleanupList(root.cleanups)
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
    throw error
  }
}

function runLifecycle(fn: LifecycleFn): void {
  const cleanup = fn()
  if (typeof cleanup === 'function') {
    cleanup()
  }
}

export type { RootContext }
