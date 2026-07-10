import { isReactive } from './binding'
import { createElement } from './dom'
import { isCommentLike } from './dom-guards'
import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
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
import { createSignal, untrack } from './signal'
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
    const currentCleanup = cleanup
    cleanup = undefined
    try {
      currentCleanup?.()
    } finally {
      if (activeNodes.length) {
        removeNodes(activeNodes)
        activeNodes = []
      }
    }
  }

  const renderView = (view: FictNode | null, parentRoot = boundaryRoot) => {
    if (disposed) return
    cleanupActive()

    if (view == null || view === false) {
      return
    }

    const root = createRootContext(parentRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let boundaryPushed = false
    let didPopRoot = false
    const restoreRoot = () => {
      if (didPopRoot) return
      popRoot(prev)
      didPopRoot = true
    }
    try {
      if (streamBoundaryId) {
        __fictPushSSRBoundary(streamBoundaryId)
        boundaryPushed = true
      }
      const output = untrack(() => createElement(view))
      nodes = toNodeArray(output, markerOwnerDocument)
      // Suspended view: child threw a suspense token and was handled upstream.
      // Avoid replacing existing fallback content; tear down this attempt.
      const suspendedAttempt =
        root.suspended ||
        (nodes.length > 0 &&
          nodes.every(
            node => isCommentLike(node, markerOwnerDocument) && node.data === 'fict:suspend',
          ))
      if (suspendedAttempt) {
        restoreRoot()
        destroyRoot(root)
        return
      }
      const parentNode = endMarker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, endMarker)
      }
      restoreRoot()
      flushOnMount(root)
    } catch (err) {
      restoreRoot()
      destroyRoot(root)
      removeNodes(nodes)
      if (!handleError(err, { source: 'render' }, hostRoot)) {
        throw err
      }
      return
    } finally {
      if (boundaryPushed) {
        __fictPopSSRBoundary(streamBoundaryId ?? undefined)
      }
    }

    cleanup = () => {
      try {
        destroyRoot(root)
      } finally {
        removeNodes(nodes)
      }
    }
    activeNodes = nodes
  }

  const fragment = markerOwnerDocument.createDocumentFragment()
  const startMarker = markerOwnerDocument.createComment('fict:suspense-start')
  const endMarker = markerOwnerDocument.createComment('fict:suspense-end')
  fragment.appendChild(startMarker)
  fragment.appendChild(endMarker)
  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []
  let streamBoundaryId: string | null = null
  let streamPending = false
  let disposed = false

  if (streamHooks?.registerBoundary) {
    streamBoundaryId = streamHooks.registerBoundary(startMarker, endMarker) ?? null
    if (streamBoundaryId) {
      startMarker.data = `fict:suspense-start:${streamBoundaryId}`
      endMarker.data = `fict:suspense-end:${streamBoundaryId}`
    }
  }

  const onResolveMaybe = () => {
    if (!resolvedOnce) {
      resolvedOnce = true
      props.onResolve?.()
    }
  }

  const isSettledInEpoch = (expectedEpoch: number) =>
    !disposed && epoch === expectedEpoch && untrack(() => pending()) === 0

  withRootContext(boundaryRoot, () => {
    registerSuspenseHandler(token => {
      if (disposed) return false
      const thenable = isThenable(token) ? token : null
      if (!thenable) return false

      const tokenEpoch = epoch
      if (!streamPending && streamBoundaryId && streamHooks?.boundaryPending) {
        streamPending = true
        streamHooks.boundaryPending(streamBoundaryId)
      }
      pending(untrack(() => pending()) + 1)
      // Directly render fallback instead of using switchView to avoid
      // triggering the effect which would cause duplicate renders
      let fallback: FictNode
      try {
        fallback = untrack(toFallback)
      } catch (err) {
        if (isThenable(err)) {
          if (!handleSuspend(err, hostRoot)) throw err
        } else if (!handleError(err, { source: 'render' }, hostRoot)) {
          throw err
        }
        fallback = null
      }
      // The fallback is outside this boundary's capture scope. A fallback
      // which suspends must bubble to a parent Suspense instead of recursively
      // asking this boundary to render the same fallback again.
      renderView(fallback, hostRoot)

      thenable.then(
        () => {
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
                if (streamPending && streamBoundaryId && streamHooks?.boundaryResolved) {
                  streamPending = false
                  streamHooks.boundaryResolved(streamBoundaryId)
                }
                onResolveMaybe()
              }
            }
          })
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

  // Initial render - render children directly
  // Note: This will be called synchronously during component creation.
  // If children suspend, the handler above will be called and switch to fallback.
  renderView(props.children ?? null)

  registerRootCleanup(() => {
    disposed = true
    cleanupActive()
    destroyRoot(boundaryRoot)
  })

  if (props.resetKeys !== undefined) {
    const getter = isReactive(props.resetKeys) ? props.resetKeys : undefined
    let prev = getter ? getter() : props.resetKeys
    createEffect(() => {
      const next = getter ? getter() : props.resetKeys
      if (resetKeysChanged(prev, next)) {
        prev = next
        const resetEpoch = ++epoch
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

  return fragment
}
