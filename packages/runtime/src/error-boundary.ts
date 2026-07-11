import { isReactive, setEventErrorRoot } from './binding'
import { createElement } from './dom'
import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  pushRoot,
  popRoot,
  registerErrorHandler,
  registerRootCleanup,
  type RootContext,
  withRootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import { resetKeysChanged } from './reset-keys'
import { untrack } from './signal'
import { __fictGetSSRStreamHooks, __fictPopSSRBoundary, __fictPushSSRBoundary } from './ssr-stream'
import type { BaseProps, FictNode } from './types'

interface ErrorBoundaryProps extends BaseProps {
  fallback: FictNode | ((err: unknown, reset?: () => void) => FictNode)
  onError?: (err: unknown) => void
  resetKeys?: unknown | (() => unknown)
}

export function ErrorBoundary(props: ErrorBoundaryProps): FictNode {
  const streamHooks = __fictGetSSRStreamHooks()
  const hostRoot = getCurrentRoot()
  const boundaryRoot = createRootContext(hostRoot)
  const markerOwnerDocument = hostRoot?.ownerDocument ?? document
  const fragment = markerOwnerDocument.createDocumentFragment()
  const startMarker = markerOwnerDocument.createComment('fict:error-boundary-start')
  const marker = markerOwnerDocument.createComment('fict:error-boundary')
  fragment.append(startMarker, marker)

  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []
  let renderingFallback = false
  let disposing = false
  let disposed = false
  let renderGeneration = 0
  let streamBoundaryId: string | null = null
  let streamPending = false

  if (streamHooks?.registerErrorBoundary) {
    streamBoundaryId = streamHooks.registerErrorBoundary(startMarker, marker) ?? null
    if (streamBoundaryId) {
      startMarker.data = `fict:suspense-start:${streamBoundaryId}`
      marker.data = `fict:suspense-end:${streamBoundaryId}`
    }
  }

  let reset = () => {}
  const toFallback = (err: unknown): FictNode =>
    typeof props.fallback === 'function'
      ? (props.fallback as (e: unknown, reset?: () => void) => FictNode)(err, reset)
      : props.fallback

  const renderValue = (
    value: FictNode | null,
    parentRoot: RootContext | undefined = boundaryRoot,
  ) => {
    if (disposing || disposed) return
    const generation = ++renderGeneration
    const previousCleanup = cleanup
    const previousNodes = activeNodes
    cleanup = undefined
    activeNodes = []
    try {
      previousCleanup?.()
    } finally {
      removeNodes(previousNodes)
    }

    // Cleanup may synchronously report an error and install a fallback. Do not
    // let the render which triggered that cleanup replace the newer attempt.
    if (generation !== renderGeneration) return

    if (value == null || value === false) {
      return
    }

    const root = createRootContext(parentRoot)
    // Delayed fallbacks must use the boundary call-site namespace, not the
    // host root's namespace after component invocation has returned.
    root.renderNamespace = boundaryRoot.renderNamespace
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let streamBoundaryPushed = false
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
    const popStreamBoundary = () => {
      if (!streamBoundaryPushed) return
      streamBoundaryPushed = false
      __fictPopSSRBoundary(streamBoundaryId ?? undefined)
    }
    try {
      if (streamBoundaryId) {
        __fictPushSSRBoundary(streamBoundaryId)
        streamBoundaryPushed = true
      }
      const output = untrack(() => createElement(value))
      nodes = toNodeArray(output, markerOwnerDocument)
      if (generation !== renderGeneration) {
        destroyAttempt()
        return
      }
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, marker)
      }
      nodes.forEach(node => setEventErrorRoot(node, root))
      restoreRoot()
      flushOnMount(root)
      if (generation !== renderGeneration) {
        destroyAttempt()
        return
      }
    } catch (err) {
      popStreamBoundary()
      destroyAttempt()
      // Fall back immediately on render errors, avoid infinite recursion
      if (renderingFallback || generation !== renderGeneration) {
        throw err
      }
      captureError(err)
      return
    } finally {
      popStreamBoundary()
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

  const captureError = (err: unknown) => {
    if (disposed) return
    if (disposing) {
      untrack(() => props.onError?.(err))
      return
    }
    if (!streamPending && streamBoundaryId && streamHooks?.boundaryPending) {
      streamPending = true
      streamHooks.boundaryPending(streamBoundaryId)
    }
    renderingFallback = true
    let rendered = false
    let fallbackError: unknown
    try {
      // The fallback subtree belongs to the parent scope. Errors from the
      // fallback itself must reach an outer boundary, not this boundary.
      renderValue(
        untrack(() => toFallback(err)),
        hostRoot,
      )
      rendered = true
    } catch (nextErr) {
      fallbackError = nextErr
    }

    // A successfully mounted fallback is protected by its parent root. Keep
    // the synchronous guard set only when fallback rendering failed.
    if (rendered) renderingFallback = false
    untrack(() => props.onError?.(err))
    if (!rendered) throw fallbackError
    if (streamPending && streamBoundaryId && streamHooks?.boundaryResolved) {
      streamPending = false
      streamHooks.boundaryResolved(streamBoundaryId)
    }
  }

  reset = () => {
    if (disposing || disposed) return
    renderingFallback = false
    renderValue(props.children ?? null)
  }

  registerRootCleanup(() => {
    disposing = true
    renderGeneration++
    try {
      if (streamBoundaryId && streamHooks?.boundaryAbandoned) {
        streamPending = false
        streamHooks.boundaryAbandoned(streamBoundaryId)
      }
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }
      destroyRoot(boundaryRoot)
    } finally {
      disposing = false
      disposed = true
    }
  })

  // Register ownership before the initial render. A successful fallback can
  // still be followed by a throwing `onError`; in that case construction
  // aborts and the host root must be able to tear the fallback subtree down.
  renderValue(props.children ?? null)

  withRootContext(boundaryRoot, () => {
    registerErrorHandler(err => {
      if (renderingFallback) return false
      captureError(err)
      return true
    })
  })

  if (props.resetKeys !== undefined) {
    const getter = isReactive(props.resetKeys) ? props.resetKeys : undefined
    let prev = getter ? getter() : props.resetKeys
    createEffect(() => {
      const next = getter ? getter() : props.resetKeys
      if (resetKeysChanged(prev, next)) {
        prev = next
        renderingFallback = false
        renderValue(props.children ?? null)
      } else {
        prev = next
      }
    })
  }

  return fragment
}
