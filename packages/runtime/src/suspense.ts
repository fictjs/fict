import { isAsyncPending } from './async-state'
import { isReactive } from './binding'
import { createElement } from './dom'
import { isCommentLike } from './dom-guards'
import { createEffect } from './effect'
import {
  claimSuspenseRange,
  hydratedRangeFragment,
  withHydrationRange,
  withoutHydrationClaims,
  getPendingHydrationRepairToken,
  finalizePendingHydrationRepair,
} from './hydration'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  flushDeferredMounts,
  getCurrentRoot,
  handleError,
  handleSuspend,
  pushRoot,
  popRoot,
  registerRootCleanup,
  registerSuspenseHandler,
  withRootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import { resetKeysChanged } from './reset-keys'
import { createSignal, hasAsyncReadConsumer, registerAsyncSuspension, untrack } from './signal'
import { __fictGetCurrentSSRSession, __fictRunWithSSRSession } from './ssr-session'
import { __fictGetSSRStreamHooks, __fictPopSSRBoundary, __fictPushSSRBoundary } from './ssr-stream'
import type { BaseProps, FictNode, SuspenseToken } from './types'

export interface SuspenseProps extends BaseProps {
  fallback: FictNode | ((err?: unknown) => FictNode)
  onResolve?: () => void
  onReject?: (err: unknown) => void
  resetKeys?: unknown | (() => unknown)
}

export interface SuspenseHandle {
  token: SuspenseToken
  resolve: () => void
  reject: (err: unknown) => void
}

export function createSuspenseToken(): SuspenseHandle {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    token: {
      then: promise.then.bind(promise),
    },
    resolve,
    reject,
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as PromiseLike<unknown>).then === 'function'

export function Suspense(props: SuspenseProps): FictNode {
  const streamHooks = __fictGetSSRStreamHooks()
  const ssrSession = __fictGetCurrentSSRSession()
  const pending = createSignal(0)
  let resolvedOnce = false
  let epoch = 0
  const hostRoot = getCurrentRoot()
  const boundaryRoot = createRootContext(hostRoot)
  const markerOwnerDocument = hostRoot?.ownerDocument ?? document

  const toFallback = (err?: unknown) =>
    typeof props.fallback === 'function'
      ? (props.fallback as (e?: unknown) => FictNode)(err)
      : props.fallback

  const runInCapturedSSRSession = <T>(fn: () => T): T =>
    ssrSession ? __fictRunWithSSRSession(ssrSession, fn) : fn()

  const cleanupActive = () => {
    renderGeneration++
    const currentCleanup = cleanup
    const currentNodes = activeNodes
    cleanup = undefined
    activeNodes = []
    activeRoot = undefined
    try {
      currentCleanup?.()
    } finally {
      if (currentNodes.length) removeNodes(currentNodes)
    }
  }

  const cleanupParked = () => {
    const previous = parked
    parked = undefined
    previous?.cleanup()
  }

  const showGraphFallback = () => {
    if (renderingMain || disposed || parked) return
    if (!parked && cleanup && activeRoot) {
      const fragment = markerOwnerDocument.createDocumentFragment()
      const nodes = activeNodes
      parked = { cleanup, fragment, root: activeRoot }
      cleanup = undefined
      activeNodes = []
      activeRoot = undefined
      // Dynamic top-level bindings can have added nodes since initial rendering.
      // Keep the live marker range, then retain its fragment as that range evolves.
      if (nodes.some(node => node.parentNode === endMarker.parentNode)) {
        let cursor = startMarker.nextSibling
        while (cursor && cursor !== endMarker) {
          const next = cursor.nextSibling
          fragment.appendChild(cursor)
          cursor = next
        }
      } else {
        for (const node of nodes) fragment.appendChild(node)
      }
    }
    renderView(readFallback(), hostRoot)
  }

  const restoreGraphView = () => {
    if (!parked || disposed) return false
    const previous = parked
    const generation = renderGeneration + 1
    cleanupActive()
    if (disposed || generation !== renderGeneration || parked !== previous) {
      previous.cleanup()
      return true
    }
    if (untrack(() => pending()) > 0) {
      // Fallback cleanup can synchronously invalidate the retained view.
      renderView(readFallback(), hostRoot)
      return true
    }
    parked = undefined
    const parent = endMarker.parentNode as (ParentNode & Node) | null
    const nodes = Array.from(previous.fragment.childNodes)
    activeNodes = parent ? insertNodesBefore(parent, nodes, endMarker) : nodes
    cleanup = previous.cleanup
    activeRoot = previous.root
    previous.root.suspended = false
    flushOnMount(previous.root)
    flushDeferredMounts(mountBoundary)
    return true
  }

  const renderView = (view: FictNode | null, parentRoot = boundaryRoot) => {
    if (disposed) return
    const generation = renderGeneration + 1
    cleanupActive()

    if (disposed || generation !== renderGeneration) {
      return
    }
    if (view == null || view === false) {
      if (initialHydration) {
        initialHydration = false
        withHydrationRange(startMarker.nextSibling, endMarker, markerOwnerDocument, () => {})
      }
      return
    }
    const isCurrent = () => !disposed && generation === renderGeneration
    const isMain = parentRoot === boundaryRoot

    const root = createRootContext(parentRoot)
    // The boundary may replay after its caller's temporary render namespace
    // has been restored. Keep the namespace captured at boundary creation.
    root.renderNamespace = boundaryRoot.renderNamespace
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let boundaryPushed = false
    let didPopRoot = false
    let attemptDestroyed = false
    const restoreRoot = () => {
      if (didPopRoot) return
      popRoot(prev)
      didPopRoot = true
    }
    const destroyAttempt = () => {
      restoreRoot()
      if (attemptDestroyed) return
      attemptDestroyed = true
      try {
        destroyRoot(root)
      } finally {
        removeNodes(nodes)
      }
    }
    try {
      if (streamBoundaryId) {
        __fictPushSSRBoundary(streamBoundaryId)
        boundaryPushed = true
      }
      if (isMain) renderingMain++
      let output: ReturnType<typeof createElement>
      try {
        const hydrate = initialHydration
        initialHydration = false
        output = untrack(() =>
          hydrate
            ? withHydrationRange(startMarker.nextSibling, endMarker, markerOwnerDocument, () =>
                createElement(view),
              )
            : withoutHydrationClaims(() => createElement(view)),
        )
      } finally {
        if (isMain) renderingMain--
      }
      nodes = toNodeArray(output, markerOwnerDocument)
      if (!isCurrent()) {
        destroyAttempt()
        return
      }
      // Suspended view: child threw a suspense token and was handled upstream.
      // Avoid replacing existing fallback content; tear down this attempt.
      const suspendedAttempt =
        (isMain && graphTokens.size > 0) ||
        (root.suspended && !root.graphSuspended) ||
        (nodes.length > 0 &&
          nodes.every(
            node => isCommentLike(node, markerOwnerDocument) && node.data === 'fict:suspend',
          ))
      if (suspendedAttempt) {
        if (isMain && graphTokens.size) {
          restoreRoot()
          cleanup = destroyAttempt
          activeNodes = nodes
          activeRoot = root
          showGraphFallback()
          return
        }
        destroyAttempt()
        return
      }
      const parentNode = endMarker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, endMarker)
      }
      restoreRoot()
      flushOnMount(root)
      if (!isCurrent()) {
        destroyAttempt()
        return
      }
    } catch (err) {
      destroyAttempt()
      if (!handleError(err, { source: 'render' }, hostRoot)) {
        throw err
      }
      return
    } finally {
      if (boundaryPushed) {
        __fictPopSSRBoundary(streamBoundaryId ?? undefined)
      }
    }

    cleanup = destroyAttempt
    activeNodes = nodes
    activeRoot = isMain ? root : undefined
    if (isMain) flushDeferredMounts(mountBoundary)
  }

  const hydratedRange = claimSuspenseRange()
  const hydrationRepair = hydratedRange ? null : getPendingHydrationRepairToken()
  let initialHydration = !!hydratedRange
  const fragment = markerOwnerDocument.createDocumentFragment()
  const startMarker =
    hydratedRange?.start ?? markerOwnerDocument.createComment('fict:suspense-start')
  const endMarker = hydratedRange?.end ?? markerOwnerDocument.createComment('fict:suspense-end')
  if (!hydratedRange) {
    fragment.appendChild(startMarker)
    fragment.appendChild(endMarker)
  }
  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []
  let streamBoundaryId: string | null = null
  let streamPending = false
  let streamResolveScheduled = false
  let disposed = false
  let renderGeneration = 0
  let renderingMain = 0
  let activeRoot: ReturnType<typeof createRootContext> | undefined
  let parked:
    | {
        fragment: DocumentFragment
        root: ReturnType<typeof createRootContext>
        cleanup: () => void
      }
    | undefined
  const graphTokens = new Map<PromiseLike<unknown>, number>()
  const mountBoundary = {
    parent: hostRoot?.mountBoundary,
    deferred: new Set<ReturnType<typeof createRootContext>>(),
    shouldDefer: () => renderingMain > 0 || !!parked || untrack(() => pending()) > 0,
  }
  boundaryRoot.mountBoundary = mountBoundary

  if (streamHooks?.registerBoundary) {
    streamBoundaryId = streamHooks.registerBoundary(startMarker, endMarker) ?? null
    if (streamBoundaryId) {
      startMarker.data = `fict:suspense-start:${streamBoundaryId}`
      endMarker.data = `fict:suspense-end:${streamBoundaryId}`
    }
  }

  const onResolveMaybe = (): boolean => {
    if (resolvedOnce) return true
    resolvedOnce = true
    try {
      props.onResolve?.()
    } catch (resolveError) {
      const handled = handleError(resolveError, { source: 'render' }, hostRoot)
      if (!handled) {
        if (streamHooks?.onError) {
          streamHooks.onError(resolveError, streamBoundaryId ?? undefined)
          return false
        }
        throw resolveError
      }
    }
    return true
  }

  const isSettledInEpoch = (expectedEpoch: number) =>
    !disposed && epoch === expectedEpoch && untrack(() => pending()) === 0

  const scheduleStreamResolution = (expectedEpoch: number) => {
    const boundaryId = streamBoundaryId
    const resolveBoundary = streamHooks?.boundaryResolved
    if (streamResolveScheduled || !streamPending || !boundaryId || !resolveBoundary) return
    streamResolveScheduled = true
    // Signal writes from onResolve flush in a microtask. Let that work reveal
    // any new suspension before the stream is allowed to finalize.
    void Promise.resolve().then(() => {
      runInCapturedSSRSession(() => {
        streamResolveScheduled = false
        if (epoch !== expectedEpoch || untrack(() => pending()) !== 0 || !streamPending) {
          return
        }
        streamPending = false
        resolveBoundary(boundaryId)
      })
    })
  }

  const readFallback = (): FictNode => {
    try {
      return untrack(toFallback)
    } catch (err) {
      if (isThenable(err)) {
        if (!handleSuspend(err, hostRoot)) throw err
      } else if (!handleError(err, { source: 'render' }, hostRoot)) {
        throw err
      }
      return null
    }
  }

  let graphRevealScheduled = false
  let graphRevealEpoch = 0
  const scheduleGraphReveal = (expectedEpoch: number) => {
    graphRevealEpoch = expectedEpoch
    if (graphRevealScheduled) return
    graphRevealScheduled = true
    // Readiness wakeups precede publication's effect flush. Reveal only after
    // consumers have committed or registered the next pending generation.
    void Promise.resolve().then(() => {
      runInCapturedSSRSession(() => {
        graphRevealScheduled = false
        const expectedEpoch = graphRevealEpoch
        if (!isSettledInEpoch(expectedEpoch)) return
        if (!restoreGraphView()) return
        if (isSettledInEpoch(expectedEpoch) && onResolveMaybe()) {
          if (isSettledInEpoch(expectedEpoch)) scheduleStreamResolution(expectedEpoch)
        }
      })
    })
  }

  withRootContext(boundaryRoot, () => {
    registerSuspenseHandler(token => {
      if (disposed) return false
      const thenable = isThenable(token) ? token : null
      if (!thenable) return false

      const graphPending = isAsyncPending(token)
      if (graphPending) {
        if (!hasAsyncReadConsumer()) {
          throw new Error(
            '[fict] A pending async value needs a reactive render consumer. Read it in a binding or createAsyncEffect; synchronous component setup cannot resume after a thrown read.',
          )
        }
        const tokenEpoch = epoch
        const release = registerAsyncSuspension(thenable, () => {
          if (disposed || epoch !== tokenEpoch) return
          const count = (graphTokens.get(thenable) ?? 1) - 1
          if (count) graphTokens.set(thenable, count)
          else graphTokens.delete(thenable)
          pending(Math.max(0, untrack(() => pending()) - 1))
          scheduleGraphReveal(tokenEpoch)
        })
        if (!release) return true
        graphTokens.set(thenable, (graphTokens.get(thenable) ?? 0) + 1)
        pending(untrack(() => pending()) + 1)
        if (!streamPending && streamBoundaryId && streamHooks?.boundaryPending) {
          streamPending = true
          streamHooks.boundaryPending(streamBoundaryId)
        }
        // A pending consumer owns its continuation. A branch change or disposal
        // releases its wait even when the original transport never settles.
        void Promise.resolve(thenable).then(release, release)
        if (!renderingMain) showGraphFallback()
        return true
      }

      const tokenEpoch = epoch
      if (!streamPending && streamBoundaryId && streamHooks?.boundaryPending) {
        streamPending = true
        streamHooks.boundaryPending(streamBoundaryId)
      }
      pending(untrack(() => pending()) + 1)
      // Directly render fallback instead of using switchView to avoid
      // triggering the effect which would cause duplicate renders
      // The fallback is outside this boundary's capture scope. A fallback
      // which suspends must bubble to a parent Suspense instead of recursively
      // asking this boundary to render the same fallback again.
      cleanupParked()
      renderView(readFallback(), hostRoot)

      thenable.then(
        () => {
          const resume = () =>
            runInCapturedSSRSession(() => {
              if (disposed) return
              // This prevents stale token resolutions from affecting state after
              // a reset. The order is important: check epoch first, then update state.
              if (epoch !== tokenEpoch) {
                // Token is stale (from before a reset), ignore it completely
                return
              }
              // Use Math.max as a defensive measure - pending should never go below 0,
              // but this protects against edge cases where a token might resolve twice
              // or after the component has been reset.
              const newPending = Math.max(0, pending() - 1)
              pending(newPending)
              if (newPending === 0) {
                // Directly render children instead of using switchView
                renderView(props.children ?? null)
                // Rendering can immediately reveal another token. Only settle the
                // boundary after checking the live state produced by that render.
                if (isSettledInEpoch(tokenEpoch)) {
                  if (!onResolveMaybe()) return
                  // onResolve can synchronously flush a reset (for example through
                  // batch), which may register a new token before it returns.
                  // Do not include `disposed` here: an outer ErrorBoundary may have
                  // handled an onResolve error by disposing this boundary, while the
                  // existing stream boundary still needs to settle.
                  if (epoch !== tokenEpoch || untrack(() => pending()) !== 0) return
                  scheduleStreamResolution(tokenEpoch)
                }
              }
            })
          resume()
        },
        err => {
          runInCapturedSSRSession(() => {
            if (disposed) return
            // Same epoch check - ignore stale tokens
            if (epoch !== tokenEpoch) {
              return
            }
            const newPending = Math.max(0, pending() - 1)
            pending(newPending)
            let rejectionError = err
            try {
              props.onReject?.(err)
            } catch (callbackError) {
              rejectionError = callbackError
            }

            const handled = handleError(rejectionError, { source: 'render' }, hostRoot)
            if (!handled) {
              if (streamHooks?.onError) {
                streamHooks.onError(rejectionError, streamBoundaryId ?? undefined)
                return
              }
              throw rejectionError
            }
            if (
              newPending === 0 &&
              streamPending &&
              streamBoundaryId &&
              streamHooks?.boundaryResolved
            ) {
              streamPending = false
              streamHooks.boundaryResolved(streamBoundaryId)
            }
          })
        },
      )
      return true
    })
  })

  registerRootCleanup(() => {
    disposed = true
    try {
      if (streamBoundaryId && streamHooks?.boundaryAbandoned) {
        streamPending = false
        streamHooks.boundaryAbandoned(streamBoundaryId)
      }
    } finally {
      try {
        cleanupActive()
      } finally {
        try {
          graphTokens.clear()
          mountBoundary.deferred.clear()
          cleanupParked()
        } finally {
          destroyRoot(boundaryRoot)
        }
      }
    }
  })

  // Register ownership before rendering children, which can synchronously
  // suspend, fail, or destroy the host while this boundary is initializing.
  renderView(props.children ?? null)
  if (!parked) flushDeferredMounts(mountBoundary)

  if (props.resetKeys !== undefined) {
    const getter = isReactive(props.resetKeys) ? props.resetKeys : undefined
    let prev = getter ? getter() : props.resetKeys
    createEffect(() => {
      const next = getter ? getter() : props.resetKeys
      if (resetKeysChanged(prev, next)) {
        prev = next
        const resetEpoch = ++epoch
        graphTokens.clear()
        cleanupParked()
        pending(0)
        resolvedOnce = false
        // Directly render children instead of using switchView
        renderView(props.children ?? null)
        if (
          isSettledInEpoch(resetEpoch) &&
          streamPending &&
          streamBoundaryId &&
          streamHooks?.boundaryResolved
        ) {
          streamPending = false
          streamHooks.boundaryResolved(streamBoundaryId)
        }
      }
    })
  }

  return hydratedRange
    ? hydratedRangeFragment(startMarker, endMarker)
    : finalizePendingHydrationRepair(hydrationRepair, fragment)
}
