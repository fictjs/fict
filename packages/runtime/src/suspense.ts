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
  const currentView = createSignal<FictNode | null>(props.children ?? null)
  const pending = createSignal(0)
  let resolvedOnce = false
  let epoch = 0
  const hostRoot = getCurrentRoot()

  const toFallback = (err?: unknown) =>
    typeof props.fallback === 'function'
      ? (props.fallback as (e?: unknown) => FictNode)(err)
      : props.fallback

  const switchView = (view: FictNode | null) => {
    currentView(view)
    renderView(view)
  }

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
    try {
      const output = createElement(view)
      nodes = toNodeArray(output)
      // Suspended view: child threw a suspense token and was handled upstream.
      // Avoid replacing existing fallback content; tear down this attempt.
      const suspendedAttempt =
        nodes.length > 0 &&
        nodes.every(node => node instanceof Comment && (node as Comment).data === 'fict:suspend')
      if (suspendedAttempt) {
        popRoot(prev)
        destroyRoot(root)
        return
      }
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
    } catch (err) {
      popRoot(prev)
      flushOnMount(root)
      destroyRoot(root)
      handleError(err, { source: 'render' })
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

  const fragment = document.createDocumentFragment()
  const marker = document.createComment('fict:suspense')
  fragment.appendChild(marker)
  let cleanup: (() => void) | undefined
  let activeNodes: Node[] = []

  const onResolveMaybe = () => {
    if (!resolvedOnce) {
      resolvedOnce = true
      props.onResolve?.()
    }
  }

  registerSuspenseHandler(token => {
    const tokenEpoch = epoch
    pending(pending() + 1)
    switchView(toFallback())

    const thenable = (token as SuspenseToken).then
      ? (token as SuspenseToken)
      : isThenable(token)
        ? token
        : null

    if (thenable) {
      thenable.then(
        () => {
          if (epoch !== tokenEpoch) return
          pending(Math.max(0, pending() - 1))
          if (pending() === 0) {
            switchView(props.children ?? null)
            onResolveMaybe()
          }
        },
        err => {
          if (epoch !== tokenEpoch) return
          pending(Math.max(0, pending() - 1))
          props.onReject?.(err)
          handleError(err, { source: 'render' }, hostRoot)
        },
      )
      return true
    }

    return false
  })

  createEffect(() => {
    renderView(currentView())
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
        epoch++
        pending(0)
        switchView(props.children ?? null)
      }
    })
  }

  return fragment
}
