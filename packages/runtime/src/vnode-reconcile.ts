import { isNodeLike } from './dom-guards'
import {
  abandonPendingHydrationRepair,
  claimVNodeRange,
  finalizePendingHydrationRepair,
  getPendingHydrationRepairToken,
  isHydratingActive,
  suppressHydrationClaimsForPendingRepair,
  withHydrationRange,
} from './hydration'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  flushDeferredMounts,
  getCurrentRoot,
  withRootContext,
  type RootContext,
} from './lifecycle'
import { removeNodes, toNodeArray } from './node-ops'
import { __fictProp, createPropsProxy } from './props'
import reconcileArrays from './reconcile'
import { batch } from './scheduler'
import { effectScope, setActiveSub, signal, type Signal } from './signal'
import type { FictNode, FictVNode } from './types'

// Components need stable prop accessors, while intrinsic elements need the raw
// current prop set (including additions/removals and event getter markers).
const propSources = new WeakMap<object, () => Record<string, unknown>>()
export const vnodePropSource = (props: object | null) => props && propSources.get(props)

function liveProps(read: () => FictVNode): Record<string, unknown> {
  const source = () => read().props ?? {}
  const getters = new Map<PropertyKey, () => unknown>()
  const getter = (key: PropertyKey) => {
    let value = getters.get(key)
    if (!value) {
      value = __fictProp(() => Reflect.get(createPropsProxy(source()), key))
      getters.set(key, value)
    }
    return value
  }
  const props = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_, key) => getter(key),
    has: (_, key) => key in source(),
    ownKeys: () => Reflect.ownKeys(source()),
    getOwnPropertyDescriptor: (_, key) =>
      Object.prototype.hasOwnProperty.call(source(), key)
        ? { configurable: true, enumerable: true, get: getter(key) }
        : undefined,
  })
  propSources.set(props, source)
  return props
}

interface Block {
  vnode?: FictVNode
  value?: Signal<FictVNode>
  root?: RootContext
  start?: Comment
  end?: Comment
  nodes: Node[]
  mounted?: boolean
}

export interface VNodePlan {
  blocks: Block[]
  created: Block[]
  updates: [Block, FictVNode][]
  committed?: boolean
}

function currentNodes(block: Block): Node[] {
  if (!block.start?.parentNode || !block.end) return block.nodes
  const nodes: Node[] = []
  for (let node: Node | null = block.start; node; node = node.nextSibling) {
    nodes.push(node)
    if (node === block.end) return nodes
  }
  return block.nodes
}

function disposeBlock(block: Block): void {
  const nodes = currentNodes(block)
  try {
    if (block.root) destroyRoot(block.root)
  } finally {
    removeNodes(nodes)
  }
}

function disposeBlocks(blocks: Block[]): void {
  let failure: { error: unknown } | undefined
  for (const block of blocks) {
    try {
      disposeBlock(block)
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}

function sameIdentity(a: FictVNode, b: FictVNode): boolean {
  return (
    a.type === b.type &&
    a.key === b.key &&
    a.__fictVNodeScope === b.__fictVNodeScope &&
    a.__fictVNodeSlot === b.__fictVNodeSlot &&
    (typeof a.type !== 'string' || a.props?.is === b.props?.is)
  )
}

/** A child range owns instances independently of its per-evaluation work. */
export function createVNodeReconciler(
  createElement: (node: FictNode) => Node,
  hostRoot: RootContext | undefined,
  owner: Document,
) {
  let blocks: Block[] = []
  let disposed = false
  const mount = (vnode: FictVNode): Block => {
    const root = createRootContext(hostRoot)
    const evaluationRoot = getCurrentRoot()
    root.ownerDocument = evaluationRoot?.ownerDocument ?? owner
    root.renderNamespace = evaluationRoot?.renderNamespace ?? root.renderNamespace
    const value = signal(vnode)
    const block: Block = { vnode, root, value, nodes: [] }
    root.mountBoundary = {
      parent: root.mountBoundary,
      deferred: new Set(),
      shouldDefer: () => !block.mounted,
    }
    const previous = setActiveSub(undefined)
    try {
      withRootContext(root, () => {
        const scope = effectScope(() => {
          const range = isHydratingActive() ? claimVNodeRange() : null
          const repair = range ? null : getPendingHydrationRepairToken()
          const restore = suppressHydrationClaimsForPendingRepair(repair)
          block.start = range?.start ?? owner.createComment('fict:vnode-start')
          block.end = range?.end ?? owner.createComment('fict:vnode-end')
          try {
            const render = () => createElement({ ...vnode, props: liveProps(value) })
            const content = range
              ? withHydrationRange(range.start.nextSibling, range.end, owner, render)
              : render()
            block.nodes = [block.start, ...toNodeArray(content, owner), block.end]
            if (!range) {
              const fragment = owner.createDocumentFragment()
              fragment.append(...block.nodes)
              restore()
              finalizePendingHydrationRepair(repair, fragment)
            }
          } catch (error) {
            restore()
            abandonPendingHydrationRepair(repair)
            throw error
          } finally {
            restore()
          }
        })
        root.cleanups.push(scope)
      })
    } catch (error) {
      disposeBlock(block)
      throw error
    } finally {
      setActiveSub(previous)
    }
    return block
  }

  return {
    prepare(value: FictNode): VNodePlan {
      const plan: VNodePlan = { blocks: [], created: [], updates: [] }
      const keyed = new Map<string | number, Block[]>()
      const sites = new Map<object, Map<number, { blocks: Block[]; next: number }>>()
      for (const block of blocks) {
        if (block.vnode?.key !== undefined) {
          const matches = keyed.get(block.vnode.key) ?? []
          matches.push(block)
          keyed.set(block.vnode.key, matches)
        } else if (block.vnode?.__fictVNodeScope && block.vnode.__fictVNodeSlot !== undefined) {
          const { __fictVNodeScope: scope, __fictVNodeSlot: slot } = block.vnode
          let slots = sites.get(scope)
          if (!slots) sites.set(scope, (slots = new Map()))
          let occurrence = slots.get(slot)
          if (!occurrence) slots.set(slot, (occurrence = { blocks: [], next: 0 }))
          occurrence.blocks.push(block)
        }
      }
      const used = new Set<Block>()
      const values: FictNode[] = []
      const hydrating = isHydratingActive()
      const text = (node: FictNode) => ['string', 'number', 'bigint'].includes(typeof node)
      const flatten = (node: FictNode): void => {
        if (Array.isArray(node)) {
          for (const child of node) flatten(child)
        } else if (node != null && typeof node !== 'boolean') {
          // The HTML parser merges adjacent text; claim the same runs.
          const previous = values[values.length - 1]
          if (hydrating && text(node) && text(previous)) {
            values[values.length - 1] = String(previous) + String(node)
          } else values.push(node)
        }
      }
      flatten(value)
      try {
        for (const [index, node] of values.entries()) {
          if (
            typeof node === 'object' &&
            node !== null &&
            'type' in node &&
            !isNodeLike(node, owner)
          ) {
            const vnode = node as FictVNode
            let candidate: Block | undefined
            if (vnode.key !== undefined) {
              candidate = keyed
                .get(vnode.key)
                ?.find(block => !used.has(block) && sameIdentity(block.vnode!, vnode))
            } else if (vnode.__fictVNodeScope && vnode.__fictVNodeSlot !== undefined) {
              // A conditional sibling must not change the identity of another
              // authored JSX site. Repeated occurrences of one site remain
              // positional, including unkeyed loops and dynamic component types.
              const occurrence = sites.get(vnode.__fictVNodeScope)?.get(vnode.__fictVNodeSlot)
              if (occurrence) candidate = occurrence.blocks[occurrence.next++]
            } else {
              candidate = blocks[index]
            }
            if (candidate?.vnode && !used.has(candidate) && sameIdentity(candidate.vnode, vnode)) {
              used.add(candidate)
              plan.blocks.push(candidate)
              plan.updates.push([candidate, vnode])
            } else {
              const block = mount(vnode)
              plan.blocks.push(block)
              plan.created.push(block)
            }
          } else {
            plan.blocks.push({ nodes: toNodeArray(createElement(node), owner) })
          }
        }
      } catch (error) {
        try {
          disposeBlocks(plan.created)
        } catch (cleanupError) {
          console.error('[fict] Failed to roll back a rejected VNode range.', cleanupError)
        }
        throw error
      }
      return plan
    },
    discard(plan: VNodePlan): void {
      if (!plan.committed) disposeBlocks(plan.created)
    },
    commit(plan: VNodePlan, marker: Comment, hydrating: boolean): void {
      if (disposed) {
        disposeBlocks(plan.created)
        return
      }
      batch(() => {
        const parent = marker.parentNode
        const previousNodes = blocks
          .flatMap(currentNodes)
          .filter(node => node.parentNode === parent)
        const retained = new Set(plan.blocks)
        const previous = blocks
        blocks = plan.blocks
        plan.committed = true
        let failure: { error: unknown } | undefined
        for (const block of previous) {
          try {
            if (!retained.has(block) && block.root) destroyRoot(block.root)
          } catch (error) {
            failure ??= { error }
          }
        }
        if (disposed) return
        for (const [block, vnode] of plan.updates) {
          block.vnode = vnode
          block.value!(vnode)
        }
        if (parent && !hydrating) {
          reconcileArrays(
            parent,
            [...previousNodes.filter(node => node.parentNode === parent), marker],
            [...blocks.flatMap(currentNodes), marker],
          )
        }
        for (const block of plan.created) {
          try {
            block.mounted = true
            flushDeferredMounts(block.root!.mountBoundary!)
            flushOnMount(block.root!)
          } catch (error) {
            failure ??= { error }
          }
        }
        if (failure) throw failure.error
      })
    },
    dispose(): void {
      const current = blocks
      blocks = []
      disposed = true
      disposeBlocks(current)
    },
  }
}
