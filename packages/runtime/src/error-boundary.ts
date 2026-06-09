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
  withRootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import type { BaseProps, FictNode } from './types'

interface ErrorBoundaryProps extends BaseProps {
  fallback: FictNode | ((err: unknown, reset?: () => void) => FictNode)
  onError?: (err: unknown) => void
  resetKeys?: unknown | (() => unknown)
}

export function ErrorBoundary(props: ErrorBoundaryProps): FictNode {
  const hostRoot = getCurrentRoot()
  const boundaryRoot = createRootContext(hostRoot)
  const markerOwnerDocument = hostRoot?.ownerDocument ?? document
  const fragment = markerOwnerDocument.createDocumentFragment()
  const marker = markerOwnerDocument.createComment('fict:error-boundary')
  fragment.appendChild(marker)

  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []
  let renderingFallback = false

  let reset = () => {}
  const toView = (err: unknown | null): FictNode | null => {
    if (err != null) {
      return typeof props.fallback === 'function'
        ? (props.fallback as (e: unknown, reset?: () => void) => FictNode)(err, reset)
        : props.fallback
    }
    return props.children ?? null
  }

  const renderValue = (value: FictNode | null) => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
    if (activeNodes.length) {
      removeNodes(activeNodes)
      activeNodes = []
    }

    if (value == null || value === false) {
      return
    }

    const root = createRootContext(boundaryRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let didPopRoot = false
    const restoreRoot = () => {
      if (didPopRoot) return
      popRoot(prev)
      didPopRoot = true
    }
    try {
      const output = createElement(value)
      nodes = toNodeArray(output, markerOwnerDocument)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, marker)
      }
      nodes.forEach(node => setEventErrorRoot(node, boundaryRoot))
      restoreRoot()
      flushOnMount(root)
    } catch (err) {
      restoreRoot()
      destroyRoot(root)
      removeNodes(nodes)
      // Fall back immediately on render errors, avoid infinite recursion
      if (renderingFallback) {
        throw err
      }
      // nested errors. If fallback rendering also throws, we should NOT reset
      // the flag until we're sure no more recursion is happening.
      renderingFallback = true
      try {
        renderValue(toView(err))
        // Only reset if successful - if renderValue threw, we want to keep
        // renderingFallback = true to prevent infinite recursion
        renderingFallback = false
        props.onError?.(err)
      } catch (fallbackErr) {
        // Fallback rendering failed - keep renderingFallback = true
        // to prevent further attempts, then rethrow
        // If fallback fails, report both errors
        props.onError?.(err)
        throw fallbackErr
      }
      return
    }

    cleanup = () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
    activeNodes = nodes
  }

  reset = () => {
    renderingFallback = false
    renderValue(toView(null))
  }

  renderValue(props.children ?? null)

  registerRootCleanup(() => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
    destroyRoot(boundaryRoot)
  })

  withRootContext(boundaryRoot, () => {
    registerErrorHandler(err => {
      renderValue(toView(err))
      props.onError?.(err)
      return true
    })
  })

  if (props.resetKeys !== undefined) {
    const getter = isReactive(props.resetKeys) ? props.resetKeys : undefined
    let prev = getter ? getter() : props.resetKeys
    createEffect(() => {
      const next = getter ? getter() : props.resetKeys
      if (prev !== next) {
        prev = next
        renderValue(toView(null))
      }
    })
  }

  return fragment
}
