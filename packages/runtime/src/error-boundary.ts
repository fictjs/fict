import { createEffect } from './effect'
import { createElement } from './dom'
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
        let sibling = marker.previousSibling
        while (sibling) {
          const prevSibling = sibling.previousSibling
          parentNode.removeChild(sibling)
          sibling = prevSibling
        }
        insertNodesBefore(parentNode, nodes, marker)
      }
    } catch (err) {
      popRoot(prev)
      flushOnMount(root)
      destroyRoot(root)
      // Fall back immediately on render errors
      props.onError?.(err)
      renderValue(toView(err))
      return
    }
    popRoot(prev)
    flushOnMount(root)

    cleanup = () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
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
    const maybeGet =
      typeof props.resetKeys === 'function' && (props.resetKeys as () => unknown).length === 0
        ? (props.resetKeys as () => unknown)
        : undefined
    if (maybeGet) {
      createEffect(() => {
        void maybeGet()
        renderValue(toView(null))
      })
    }
  }

  return fragment
}
