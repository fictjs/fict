import { enterRootGuard, exitRootGuard } from './cycle-guard'
import { getSafeDevtoolsHook as getDevtoolsHook } from './devtools'
import { runOutsideComponentRender } from './render-phase'
import { getActiveSub, setActiveSub, untrack, type ReactiveNode } from './signal'
import type { Cleanup, ErrorInfo, SuspenseToken } from './types'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

type LifecycleFn = () => void | Cleanup
type MountPhase = 'flushing' | 'mounted'
const ROOT_MOUNT_PHASE = Symbol('fict:root-mount-phase')

export type RenderNamespaceContext =
  | 'html'
  | 'svg'
  | 'mathml'
  | 'mathmlTextIntegration'
  | 'mathmlAnnotationXml'
  | null

export interface RootContext {
  [ROOT_MOUNT_PHASE]?: MountPhase | undefined
  parent?: RootContext | undefined
  ownerDocument?: Document | undefined
  renderNamespace?: RenderNamespaceContext | undefined
  onMountCallbacks?: LifecycleFn[]
  deferRefAssignments?: boolean | undefined
  deferredRefAssignments?: LifecycleFn[] | undefined
  cleanups: Cleanup[]
  destroyCallbacks: Cleanup[]
  errorHandlers?: ErrorHandler[]
  suspenseHandlers?: SuspenseHandler[]
  suspended?: boolean
  destroying?: boolean
  destroyed?: boolean
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML'
const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'title', 'desc'])
const MATHML_TEXT_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])

/** Prefer the eventual host document over an inert template contents document. */
export function resolveParentOwnerDocument(
  parent: Node | null | undefined,
  fallback: Document,
): Document {
  const owner = parent?.nodeType === 9 ? (parent as Document) : parent?.ownerDocument
  if (!owner) return fallback
  return owner.defaultView == null && fallback.defaultView != null ? fallback : owner
}

/** Resolve the namespace inherited by children of an already-created DOM parent. */
export function resolveParentRenderNamespace(
  parent: Node | null | undefined,
  fallback: RenderNamespaceContext = null,
): RenderNamespaceContext {
  if (!parent || parent.nodeType !== 1) return fallback
  const element = parent as Element
  const localName = element.localName.toLowerCase()
  if (element.namespaceURI === SVG_NAMESPACE) {
    return SVG_HTML_INTEGRATION_POINTS.has(localName) ? 'html' : 'svg'
  }
  if (element.namespaceURI === MATHML_NAMESPACE) {
    if (MATHML_TEXT_INTEGRATION_POINTS.has(localName)) return 'mathmlTextIntegration'
    if (localName === 'annotation-xml') {
      const encoding = element.getAttribute('encoding')?.toLowerCase()
      if (encoding === 'text/html' || encoding === 'application/xhtml+xml') return 'html'
      return 'mathmlAnnotationXml'
    }
    return 'mathml'
  }
  return 'html'
}

export interface CreateRootOptions {
  inherit?: boolean
}

type ErrorHandler = (err: unknown, info?: ErrorInfo) => boolean | void
type SuspenseHandler = (token: SuspenseToken | PromiseLike<unknown>) => boolean | void

let currentRoot: RootContext | undefined
export interface EffectCleanupScope {
  cleanups: Cleanup[] | undefined
  /** A render effect with no dependencies or cleanup can finish immediately. */
  released?: boolean
}

let currentEffectCleanups: EffectCleanupScope | undefined
let currentEffectCleanupOwner: ReactiveNode | undefined
let currentEffectCleanupRoot: RootContext | undefined
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
    renderNamespace: parent?.renderNamespace,
    cleanups: [],
    destroyCallbacks: [],
    suspended: false,
    destroying: false,
    destroyed: false,
    [ROOT_MOUNT_PHASE]: undefined as MountPhase | undefined,
  }
  // Undefined means pending; the mount phase lives with its root, without a
  // second WeakMap entry for every mounted row.
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
  const root = currentRoot
  if (root) {
    if (root.destroying || root.destroyed) return
    ;(root.onMountCallbacks ||= []).push(fn)
    if (root[ROOT_MOUNT_PHASE] === 'mounted') flushOnMount(root)
    return
  }
  runLifecycle(fn)
}

export function onDestroy(fn: LifecycleFn): void {
  if (currentRoot) {
    const cleanup = () => runLifecycle(fn)
    if (currentRoot.destroyed) runCleanupList([cleanup], currentRoot)
    else currentRoot.destroyCallbacks.push(cleanup)
    return
  }
  runLifecycle(fn)
}

export function onCleanup(fn: Cleanup): void {
  registerEffectCleanup(fn)
}

export function flushOnMount(root: RootContext): void {
  if (root.destroying || root.destroyed) {
    if (root.onMountCallbacks) root.onMountCallbacks.length = 0
    return
  }
  if (root[ROOT_MOUNT_PHASE] === 'flushing') return
  const cbs = root.onMountCallbacks
  if (!cbs || cbs.length === 0) {
    root[ROOT_MOUNT_PHASE] = 'mounted'
    return
  }
  root[ROOT_MOUNT_PHASE] = 'flushing'
  try {
    withRootContext(root, () => {
      for (let i = 0; i < cbs.length; i++) {
        const cleanup = runOutsideComponentRender(() => untrack(cbs[i]!))
        if (typeof cleanup === 'function') {
          if (root.destroying || root.destroyed) untrack(cleanup)
          else root.cleanups.push(cleanup)
        }
      }
    })
  } finally {
    cbs.length = 0
    if (!root.destroying && !root.destroyed) root[ROOT_MOUNT_PHASE] = 'mounted'
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
    // A synchronous callback can destroy its owner before a newly created
    // effect registers its disposer. Never append work to a terminal root.
    if (currentRoot.destroyed) runCleanupList([fn], currentRoot)
    else currentRoot.cleanups.push(fn)
  }
}

export function clearRoot(root: RootContext): void {
  try {
    runCleanupList(root.cleanups, root)
  } finally {
    if (root.onMountCallbacks) {
      root.onMountCallbacks.length = 0
    }
  }
}

export function destroyRoot(root: RootContext): void {
  if (root.destroying || root.destroyed) return
  root.destroying = true
  let error: unknown
  let didThrow = false
  try {
    do {
      try {
        clearRoot(root)
      } catch (err) {
        if (!didThrow) {
          error = err
          didThrow = true
        }
      }

      try {
        runCleanupList(root.destroyCallbacks, root)
      } catch (err) {
        if (!didThrow) {
          error = err
          didThrow = true
        }
      }
    } while (root.cleanups.length > 0 || root.destroyCallbacks.length > 0)
  } finally {
    if (root.onMountCallbacks) {
      root.onMountCallbacks.length = 0
    }
    if (root.deferredRefAssignments) {
      root.deferredRefAssignments.length = 0
      root.deferredRefAssignments = undefined
    }
    if (root.deferRefAssignments) root.deferRefAssignments = false
    if (root.errorHandlers) {
      root.errorHandlers.length = 0
    }
    if (root.suspenseHandlers) {
      root.suspenseHandlers.length = 0
    }
    try {
      disposeRootDevtools(root)
    } finally {
      root.destroying = false
      root.destroyed = true
    }
  }

  if (didThrow) throw error
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
      value = untrack(fn)
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

export function withEffectCleanups<T>(bucket: EffectCleanupScope, fn: () => T): T {
  const prev = currentEffectCleanups
  const prevOwner = currentEffectCleanupOwner
  const prevRoot = currentEffectCleanupRoot
  currentEffectCleanups = bucket
  currentEffectCleanupOwner = getActiveSub()
  currentEffectCleanupRoot = currentRoot
  try {
    return fn()
  } finally {
    currentEffectCleanups = prev
    currentEffectCleanupOwner = prevOwner
    currentEffectCleanupRoot = prevRoot
  }
}

/** Attach only effects created in the same reactive owner and root. */
export function registerManagedEffectCleanup(fn: Cleanup): void {
  if (
    currentEffectCleanups &&
    currentEffectCleanupOwner === getActiveSub() &&
    currentEffectCleanupRoot === currentRoot
  ) {
    ;(currentEffectCleanups.cleanups ??= []).push(fn)
  } else {
    registerRootCleanup(fn)
  }
}

export function registerEffectCleanup(fn: Cleanup): void {
  if (currentEffectCleanups && currentEffectCleanupRoot === currentRoot) {
    ;(currentEffectCleanups.cleanups ??= []).push(fn)
  } else {
    registerRootCleanup(fn)
  }
}

export function runCleanupList(list: Cleanup[], root?: RootContext): void {
  if (list.length === 0) return
  let error: unknown
  let didThrow = false
  const prevEffectCleanups = currentEffectCleanups
  const prevRoot = currentRoot
  // Disposal can happen inside another effect's body. New cleanup registered
  // by a teardown belongs to the root being drained, not that caller's bucket.
  currentEffectCleanups = undefined
  currentRoot = root
  try {
    runOutsideComponentRender(() => {
      const prevSub = setActiveSub(undefined)
      try {
        while (list.length > 0) {
          try {
            list.pop()?.()
          } catch (err) {
            if (!didThrow) {
              error = err
              didThrow = true
            }
          }
        }
      } finally {
        setActiveSub(prevSub)
      }
    })
    if (didThrow && !handleError(error, { source: 'cleanup' }, root)) {
      throw error
    }
  } finally {
    currentRoot = prevRoot
    currentEffectCleanups = prevEffectCleanups
  }
}

function runLifecycle(fn: LifecycleFn): void {
  const cleanup = runOutsideComponentRender(fn)
  if (typeof cleanup === 'function') {
    runOutsideComponentRender(cleanup)
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
