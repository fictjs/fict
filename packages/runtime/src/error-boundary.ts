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
  const toFallback = (err: unknown): FictNode =>
    typeof props.fallback === 'function'
      ? (props.fallback as (e: unknown, reset?: () => void) => FictNode)(err, reset)
      : props.fallback

  const renderValue = (
    value: FictNode | null,
    parentRoot: RootContext | undefined = boundaryRoot,
  ) => {
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

    const root = createRootContext(parentRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let didPopRoot = false
    const restoreRoot = () => {
      if (didPopRoot) return
      popRoot(prev)
      didPopRoot = true
    }
    try {
      const output = untrack(() => createElement(value))
      nodes = toNodeArray(output, markerOwnerDocument)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, marker)
      }
      nodes.forEach(node => setEventErrorRoot(node, root))
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
      captureError(err)
      return
    }

    cleanup = () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
    activeNodes = nodes
  }

  const captureError = (err: unknown) => {
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
  }

  reset = () => {
    renderingFallback = false
    renderValue(props.children ?? null)
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
