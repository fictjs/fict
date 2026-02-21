import { createElement } from './dom'
import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  handleError,
  pushRoot,
  popRoot,
  registerSuspenseHandler,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import { createSignal } from './signal'
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
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PromiseLike<unknown>).then === 'function'

export function Suspense(props: SuspenseProps): FictNode {
  const streamHooks = __fictGetSSRStreamHooks()
  const pending = createSignal(0)
  let resolvedOnce = false
  let epoch = 0
  const hostRoot = getCurrentRoot()
  const markerOwnerDocument = hostRoot?.ownerDocument ?? document

  const toFallback = (err?: unknown) =>
    typeof props.fallback === 'function'
      ? (props.fallback as (e?: unknown) => FictNode)(err)
      : props.fallback

  const renderView = (view: FictNode | null) => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
    if (activeNodes.length) {
      removeNodes(activeNodes)
      activeNodes = []
    }

    if (view == null || view === false) {
      return
    }

    const root = createRootContext(hostRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let boundaryPushed = false
    try {
      if (streamBoundaryId) {
        __fictPushSSRBoundary(streamBoundaryId)
        boundaryPushed = true
      }
      const output = createElement(view)
      nodes = toNodeArray(output, markerOwnerDocument)
      // Suspended view: child threw a suspense token and was handled upstream.
      // Avoid replacing existing fallback content; tear down this attempt.
      const suspendedAttempt =
        root.suspended ||
        (nodes.length > 0 &&
          nodes.every(node => node instanceof Comment && (node as Comment).data === 'fict:suspend'))
      if (suspendedAttempt) {
        popRoot(prev)
        destroyRoot(root)
        return
      }
      const parentNode = endMarker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, endMarker)
      }
    } catch (err) {
      popRoot(prev)
      destroyRoot(root)
      if (!handleError(err, { source: 'render' }, hostRoot)) {
        throw err
      }
      return
    } finally {
      if (boundaryPushed) {
        __fictPopSSRBoundary(streamBoundaryId ?? undefined)
      }
    }
    popRoot(prev)
    flushOnMount(root)

    cleanup = () => {
      destroyRoot(root)
      removeNodes(nodes)
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

  registerSuspenseHandler(token => {
    const tokenEpoch = epoch
    if (!streamPending && streamBoundaryId && streamHooks?.boundaryPending) {
      streamPending = true
      streamHooks.boundaryPending(streamBoundaryId)
    }
    pending(pending() + 1)
    // Directly render fallback instead of using switchView to avoid
    // triggering the effect which would cause duplicate renders
    renderView(toFallback())

    const thenable = (token as SuspenseToken).then
      ? (token as SuspenseToken)
      : isThenable(token)
        ? token
        : null

    if (thenable) {
      thenable.then(
        () => {
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
            if (streamPending && streamBoundaryId && streamHooks?.boundaryResolved) {
              streamPending = false
              streamHooks.boundaryResolved(streamBoundaryId)
            }
            onResolveMaybe()
          }
        },
        err => {
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
        },
      )
      return true
    }

    return false
  })

  // Initial render - render children directly
  // Note: This will be called synchronously during component creation.
  // If children suspend, the handler above will be called and switch to fallback.
  renderView(props.children ?? null)

  if (props.resetKeys !== undefined) {
    const isGetter =
      typeof props.resetKeys === 'function' && (props.resetKeys as () => unknown).length === 0
    const getter = isGetter ? (props.resetKeys as () => unknown) : undefined
    let prev = isGetter ? getter!() : props.resetKeys
    createEffect(() => {
      const next = getter ? getter() : props.resetKeys
      if (prev !== next) {
        prev = next
        epoch++
        pending(0)
        // Directly render children instead of using switchView
        renderView(props.children ?? null)
        if (streamPending && streamBoundaryId && streamHooks?.boundaryResolved) {
          streamPending = false
          streamHooks.boundaryResolved(streamBoundaryId)
        }
      }
    })
  }

  return fragment
}
