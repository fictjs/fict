import { createElement } from './dom'
import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  pushRoot,
  popRoot,
  registerErrorHandler,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './list-helpers'
import { createSignal } from './signal'
import type { BaseProps, FictNode } from './types'

interface ErrorBoundaryProps extends BaseProps {
  fallback: FictNode | ((err: unknown) => FictNode)
  onError?: (err: unknown) => void
  resetKeys?: unknown | (() => unknown)
}

export function ErrorBoundary(props: ErrorBoundaryProps): FictNode {
  const fragment = document.createDocumentFragment()
  const marker = document.createComment('fict:error-boundary')
  fragment.appendChild(marker)

  const currentView = createSignal<FictNode | null>(props.children ?? null)

  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []
  let renderingFallback = false

  const toView = (err: unknown | null): FictNode | null => {
    if (err != null) {
      return typeof props.fallback === 'function'
        ? (props.fallback as (e: unknown) => FictNode)(err)
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

    const root = createRootContext()
    const prev = pushRoot(root)
    let nodes: Node[] = []
    try {
      const output = createElement(value)
      nodes = toNodeArray(output)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
    } catch (err) {
      popRoot(prev)
      flushOnMount(root)
      destroyRoot(root)
      // Fall back immediately on render errors, avoid infinite recursion
      if (renderingFallback) {
        throw err
      }
      renderingFallback = true
      try {
        renderValue(toView(err))
      } finally {
        renderingFallback = false
      }
      props.onError?.(err)
      return
    }
    popRoot(prev)
    flushOnMount(root)

    cleanup = () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
    activeNodes = nodes
  }

  createEffect(() => {
    const value = currentView()
    renderValue(value)
  })

  registerErrorHandler(err => {
    renderValue(toView(err))
    props.onError?.(err)
    return true
  })

  if (props.resetKeys !== undefined) {
    const isGetter =
      typeof props.resetKeys === 'function' && (props.resetKeys as () => unknown).length === 0
    const getter = isGetter ? (props.resetKeys as () => unknown) : undefined
    let prev = isGetter ? getter!() : props.resetKeys
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
