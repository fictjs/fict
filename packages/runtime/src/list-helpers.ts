/**
 * List Helpers for Compiler-Generated Fine-Grained Updates
 *
 * These helpers are used by the compiler to generate efficient keyed list rendering.
 * They provide low-level primitives for DOM node manipulation without rebuilding.
 */

import { createElement, createElementInNamespace } from './dom'
import { isNodeLike } from './dom-guards'
import { createRenderEffect } from './effect'
import { isHydratingActive, withHydrationRange } from './hydration'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  popRoot,
  pushRoot,
  type RootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import reconcileArrays from './reconcile'
import { __fictIsHydrating, __fictIsSSR } from './resume'
import { batch } from './scheduler'
import { createSignal, effectScope, flush, setActiveSub, type Signal } from './signal'
import type { FictNode } from './types'

type ListNamespaceContext = 'svg' | 'mathml' | null | undefined
type ListKey = string | number
type InternalListKey = ListKey | DuplicateListKey

interface DuplicateListKey {
  readonly key: ListKey
  readonly occurrence: number
}

// Re-export shared DOM helpers for compiler-generated code
export { insertNodesBefore, removeNodes, toNodeArray }

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

const isShadowRoot = (node: Node): node is ShadowRoot =>
  typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot

// ============================================================================
// Types
// ============================================================================

/**
 * A keyed block represents a single item in a list with its associated DOM nodes and state
 */
interface KeyedBlock<T = unknown> {
  /** Unique key for this block */
  key: ListKey
  /** Internal key used for nth-occurrence matching when public keys duplicate */
  identityKey: InternalListKey
  /** DOM nodes belonging to this block */
  nodes: Node[]
  /** Root context for lifecycle management */
  root: RootContext
  /** Signal containing the current item value */
  item: Signal<T>
  /** Signal containing the current index */
  index: Signal<number>
  /** Last raw item value assigned to this block */
  rawItem: T
  /** Last raw index value assigned to this block */
  rawIndex: number
}

/**
 * Container for managing keyed list blocks
 */
interface KeyedListContainer<T = unknown> {
  /** Start marker comment node */
  startMarker: Comment
  /** End marker comment node */
  endMarker: Comment
  /** Map of key to block */
  blocks: Map<InternalListKey, KeyedBlock<T>>
  /** Scratch map reused for the next render */
  nextBlocks: Map<InternalListKey, KeyedBlock<T>>
  /** Current nodes in DOM order (including markers) */
  currentNodes: Node[]
  /** Next-frame node buffer to avoid reallocations */
  nextNodes: Node[]
  /** Ordered blocks in current DOM order */
  orderedBlocks: KeyedBlock<T>[]
  /** Next-frame ordered block buffer to avoid reallocations */
  nextOrderedBlocks: KeyedBlock<T>[]
  /** Track position of keys in the ordered buffer to handle duplicates */
  orderedIndexByKey: Map<InternalListKey, number>
  /** Stable identities for duplicate key occurrences beyond the first */
  duplicateKeyIdentities: Map<ListKey, DuplicateListKey[]>
  /** Cleanup function */
  dispose: () => void
}

/**
 * Binding handle returned by createKeyedList for compiler-generated code
 */
export interface KeyedListBinding {
  /** Document fragment placeholder inserted by the compiler/runtime */
  marker: Comment | DocumentFragment
  /** Start marker comment node */
  startMarker: Comment
  /** End marker comment node */
  endMarker: Comment
  /** Flush pending items - call after markers are inserted into DOM */
  flush?: () => void
  /** Cleanup function */
  dispose: () => void
  /** Internal: number of duplicate-key identity entries currently retained */
  __duplicateKeyIdentitySize?: () => number
}

type FineGrainedRenderItem<T> = (
  itemSig: Signal<T>,
  indexSig: Signal<number>,
  key: ListKey,
) => Node[]

interface ListEntry<T> {
  item: T
  index: number
}

interface ResolvedListKey {
  key: ListKey
  identityKey: InternalListKey
  occurrence: number
}

function collectListEntries<T>(items: T[], skipHoles: boolean): ListEntry<T>[] {
  const entries: ListEntry<T>[] = []
  for (let index = 0; index < items.length; index++) {
    if (skipHoles && !(index in items)) continue
    entries.push({ item: items[index]!, index })
  }
  return entries
}

function resolveListKey<T>(
  container: KeyedListContainer<T>,
  keyFn: (item: T, index: number) => ListKey,
  item: T,
  index: number,
  keyOccurrences: Map<ListKey, number>,
): ResolvedListKey {
  const key = keyFn(item, index)
  const occurrence = keyOccurrences.get(key) ?? 0
  keyOccurrences.set(key, occurrence + 1)
  if (occurrence === 0) {
    return { key, identityKey: key, occurrence }
  }

  // Invariant: identities is append-only with identities[i].occurrence === i + 1,
  // and its objects must stay reference-stable across renders because existing
  // blocks are keyed by them. Slots are addressed purely by occurrence, so a
  // partially-populated map left behind by an abandoned stable-order scan is
  // reused or extended deterministically on the next resolve — do not clear it
  // mid-pass. pruneDuplicateKeyIdentities trims departed keys after a completed
  // diff; the discard-all paths clear the whole map.
  let identities = container.duplicateKeyIdentities.get(key)
  if (!identities) {
    identities = []
    container.duplicateKeyIdentities.set(key, identities)
  }
  while (identities.length < occurrence) {
    identities.push({ key, occurrence: identities.length + 1 })
  }

  return { key, identityKey: identities[occurrence - 1]!, occurrence }
}

/**
 * Drop identity slots for keys that left the list (and excess occurrence
 * slots for keys that shrank) after a completed diff. Without pruning the
 * map grows for the lifetime of the list as duplicated keys churn. Slots
 * still referenced by live blocks are exactly the ones kept: a key present
 * `c` times uses identities[0..c-2].
 */
function pruneDuplicateKeyIdentities<T>(
  container: KeyedListContainer<T>,
  keyOccurrences: Map<ListKey, number>,
): void {
  const identitiesByKey = container.duplicateKeyIdentities
  if (identitiesByKey.size === 0) return
  for (const [key, identities] of identitiesByKey) {
    const occurrences = keyOccurrences.get(key) ?? 0
    if (occurrences <= 1) {
      identitiesByKey.delete(key)
    } else if (identities.length > occurrences - 1) {
      identities.length = occurrences - 1
    }
  }
}

function warnDuplicateListKey(key: ListKey, phase: 'hydration' | 'rendering'): void {
  if (!isDev) return
  console.warn(
    `[fict] Duplicate key "${String(key)}" detected in list ${phase}. ` +
      `Each item should have a unique key. Duplicate items will be matched by occurrence.`,
  )
}

// ============================================================================
// DOM Manipulation Primitives
// ============================================================================

/**
 * Move nodes to a position before the anchor node.
 * This is optimized to avoid unnecessary DOM operations.
 *
 * @param parent - Parent node to move nodes within
 * @param nodes - Array of nodes to move
 * @param anchor - Node to insert before (or null for end)
 */
export function moveNodesBefore(parent: Node, nodes: Node[], anchor: Node | null): void {
  // Insert in reverse order to maintain correct sequence
  // This way each node becomes the new anchor for the next
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (!isNodeLike(node, parent.ownerDocument ?? undefined)) {
      const message = isDev ? 'Invalid node in moveNodesBefore' : 'FICT:E_NODE'
      throw new Error(message)
    }
    // Only move if not already in correct position
    if (node.nextSibling !== anchor) {
      if (node.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
        parent.ownerDocument.adoptNode(node)
      }
      try {
        parent.insertBefore(node, anchor)
      } catch (e: any) {
        if (parent.ownerDocument) {
          try {
            const clone = parent.ownerDocument.importNode(node, true)
            parent.insertBefore(clone, anchor)
            // Update the nodes array with the clone to maintain correct references.
            // This ensures future operations (like removal or reordering) work correctly.
            nodes[i] = clone
            if (isDev) {
              console.warn(
                `[fict] Node cloning fallback triggered during list reordering. ` +
                  `This may indicate cross-document node insertion. ` +
                  `The node reference has been updated to the clone.`,
              )
            }
            anchor = clone
            continue
          } catch {
            // Clone fallback failed
          }
        }
        throw e
      }
    }
    anchor = node
  }
}

/**
 * Remove an array of nodes from the DOM
 *
 * @param nodes - Array of nodes to remove
 */
// Number.MAX_SAFE_INTEGER is 2^53 - 1, but we reset earlier to avoid any precision issues
const MAX_SAFE_VERSION = 0x1fffffffffffff // 2^53 - 1

export function createVersionedSignalAccessor<T>(initialValue: T): Signal<T> {
  let current = initialValue
  let version = 0
  const track = createSignal(version)

  function accessor(value?: T): T | void {
    if (arguments.length === 0) {
      track()
      return current
    }
    current = value as T
    // This is safe because we only care about version changes, not absolute values
    version = version >= MAX_SAFE_VERSION ? 1 : version + 1
    track(version)
  }

  return accessor as Signal<T>
}

// ============================================================================
// Keyed List Container
// ============================================================================

/**
 * Create a container for managing a keyed list.
 * This sets up the marker nodes and provides cleanup.
 *
 * @returns Container object with markers, blocks map, and dispose function
 */
function createKeyedListContainer<T = unknown>(
  startOverride?: Comment,
  endOverride?: Comment,
  defaultOwnerDocument?: Document,
): KeyedListContainer<T> {
  const markerOwnerDocument =
    startOverride?.ownerDocument ?? endOverride?.ownerDocument ?? defaultOwnerDocument ?? document
  const startMarker = startOverride ?? markerOwnerDocument.createComment('fict:list:start')
  const endMarker = endOverride ?? markerOwnerDocument.createComment('fict:list:end')

  const dispose = () => {
    // Clean up all blocks
    for (const block of container.blocks.values()) {
      destroyRoot(block.root)
      // Nodes are removed by parent disposal or specific cleanup if needed
      // But for list disposal, we just clear the container
    }
    container.blocks.clear()
    container.nextBlocks.clear()
    container.duplicateKeyIdentities.clear()

    // Remove nodes (including markers)
    // Check if markers are still in DOM before using Range
    if (!startMarker.parentNode || !endMarker.parentNode) {
      // Markers already removed, nothing to do
      container.currentNodes = []
      container.nextNodes = []
      container.orderedBlocks.length = 0
      container.nextOrderedBlocks.length = 0
      container.orderedIndexByKey.clear()
      container.duplicateKeyIdentities.clear()
      return
    }
    const rangeOwnerDocument =
      startMarker.ownerDocument ?? endMarker.ownerDocument ?? markerOwnerDocument
    const range = rangeOwnerDocument.createRange()
    range.setStartBefore(startMarker)
    range.setEndAfter(endMarker)
    range.deleteContents()

    // Clear cache
    container.currentNodes = []
    container.nextNodes = []
    container.nextBlocks.clear()
    container.orderedBlocks.length = 0
    container.nextOrderedBlocks.length = 0
    container.orderedIndexByKey.clear()
    container.duplicateKeyIdentities.clear()
  }

  const container: KeyedListContainer<T> = {
    startMarker,
    endMarker,
    blocks: new Map<InternalListKey, KeyedBlock<T>>(),
    nextBlocks: new Map<InternalListKey, KeyedBlock<T>>(),
    currentNodes: [startMarker, endMarker],
    nextNodes: [],
    orderedBlocks: [],
    nextOrderedBlocks: [],
    orderedIndexByKey: new Map<InternalListKey, number>(),
    duplicateKeyIdentities: new Map<ListKey, DuplicateListKey[]>(),
    dispose,
  }

  return container
}

// ============================================================================
// Block Creation Helpers
// ============================================================================

/**
 * Create a new keyed block with the given render function
 *
 * @param key - Unique key for this block
 * @param item - Initial item value
 * @param index - Initial index
 * @param render - Function that creates the DOM nodes and sets up bindings
 * @returns New KeyedBlock
 */
function createKeyedBlock<T>(
  key: ListKey,
  identityKey: InternalListKey,
  item: T,
  index: number,
  render: (item: Signal<T>, index: Signal<number>, key: ListKey) => Node[],
  needsIndex = true,
  hostRoot?: RootContext,
  namespace?: ListNamespaceContext,
): KeyedBlock<T> {
  // Use versioned signal for all item types; avoid diffing proxy overhead for objects
  const itemSig = createVersionedSignalAccessor(item)

  const indexSig = needsIndex
    ? createSignal<number>(index)
    : (function indexSignal(next?: number) {
        if (arguments.length === 0) return index
        index = next as number
        return index
      } as Signal<number>)
  const root = createRootContext(hostRoot)
  const nodeOwnerDocument = root.ownerDocument ?? hostRoot?.ownerDocument ?? document
  const prevRoot = pushRoot(root)
  // maintaining proper cleanup chain. The scope will be disposed when
  // the root is destroyed, ensuring nested effects are properly cleaned up.
  let nodes: Node[] = []
  let scopeDispose: (() => void) | undefined

  // First, isolate from parent effect to prevent child effects from being
  // purged when the outer effect (e.g., performDiff) re-runs
  const prevSub = setActiveSub(undefined)

  try {
    // Create an effectScope that will track all effects created during render
    scopeDispose = effectScope(() => {
      const rendered = render(itemSig, indexSig, key)
      // If render returns real DOM nodes/arrays, preserve them to avoid
      // reparenting side-effects (tests may pre-insert them).
      if (
        isNodeLike(rendered, nodeOwnerDocument) ||
        (Array.isArray(rendered) && rendered.every(n => isNodeLike(n, nodeOwnerDocument)))
      ) {
        nodes = toNodeArray(rendered, nodeOwnerDocument)
      } else {
        const element =
          namespace === 'svg' || namespace === 'mathml'
            ? createElementInNamespace(rendered as unknown as FictNode, namespace)
            : createElement(rendered as unknown as FictNode)
        nodes = toNodeArray(element, nodeOwnerDocument)
      }
    })

    // Register the scope cleanup with the root so effects are cleaned up
    // when the block is destroyed
    if (scopeDispose) {
      root.cleanups.push(scopeDispose)
    }
  } finally {
    setActiveSub(prevSub)
    popRoot(prevRoot)
  }

  return {
    key,
    identityKey,
    nodes,
    root,
    item: itemSig,
    index: indexSig,
    rawItem: item,
    rawIndex: index,
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a node is between two markers
 */
export function isNodeBetweenMarkers(
  node: Node,
  startMarker: Comment,
  endMarker: Comment,
): boolean {
  let current: Node | null = startMarker.nextSibling
  while (current && current !== endMarker) {
    if (current === node) return true
    current = current.nextSibling
  }
  return false
}

function reorderBySwap<T>(
  parent: ParentNode & Node,
  first: KeyedBlock<T>,
  second: KeyedBlock<T>,
): boolean {
  if (first === second) return false
  const firstNodes = first.nodes
  const secondNodes = second.nodes
  if (firstNodes.length === 0 || secondNodes.length === 0) return false
  const lastFirst = firstNodes[firstNodes.length - 1]!
  const lastSecond = secondNodes[secondNodes.length - 1]!
  const afterFirst = lastFirst.nextSibling
  const afterSecond = lastSecond.nextSibling
  moveNodesBefore(parent, firstNodes, afterSecond)
  moveNodesBefore(parent, secondNodes, afterFirst)
  return true
}

function getLISIndices(sequence: number[]): number[] {
  const predecessors = new Array<number>(sequence.length)
  const result: number[] = []

  for (let i = 0; i < sequence.length; i++) {
    const value = sequence[i]!
    if (value < 0) {
      predecessors[i] = -1
      continue
    }

    let low = 0
    let high = result.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (sequence[result[mid]!]! < value) {
        low = mid + 1
      } else {
        high = mid
      }
    }

    predecessors[i] = low > 0 ? result[low - 1]! : -1
    if (low === result.length) {
      result.push(i)
    } else {
      result[low] = i
    }
  }

  const lis: number[] = new Array(result.length)
  let k = result.length > 0 ? result[result.length - 1]! : -1
  for (let i = result.length - 1; i >= 0; i--) {
    lis[i] = k
    k = predecessors[k]!
  }
  return lis
}

function reorderByLIS<T>(
  parent: ParentNode & Node,
  endMarker: Comment,
  prev: KeyedBlock<T>[],
  next: KeyedBlock<T>[],
): boolean {
  const positions = new Map<KeyedBlock<T>, number>()
  for (let i = 0; i < prev.length; i++) {
    positions.set(prev[i]!, i)
  }

  const sequence = new Array<number>(next.length)
  for (let i = 0; i < next.length; i++) {
    const position = positions.get(next[i]!)
    if (position === undefined) return false
    sequence[i] = position
  }

  const lisIndices = getLISIndices(sequence)
  if (lisIndices.length === sequence.length) return true

  const inLIS = new Array<boolean>(sequence.length).fill(false)
  for (let i = 0; i < lisIndices.length; i++) {
    inLIS[lisIndices[i]!] = true
  }

  let anchor: Node | null = endMarker
  let moved = false
  for (let i = next.length - 1; i >= 0; i--) {
    const block = next[i]!
    const nodes = block.nodes
    if (nodes.length === 0) continue
    if (inLIS[i]) {
      anchor = nodes[0]!
      continue
    }
    moveNodesBefore(parent, nodes, anchor)
    anchor = nodes[0]!
    moved = true
  }

  return moved
}

// ============================================================================
// High-Level List Binding (for compiler-generated code)
// ============================================================================

/**
 * Create a keyed list binding with automatic diffing and DOM updates.
 * This is used by compiler-generated code for efficient list rendering.
 *
 * @param getItems - Function that returns the current array of items
 * @param keyFn - Function to extract unique key from each item
 * @param renderItem - Function that creates DOM nodes for each item
 * @returns Binding handle with markers and dispose function
 */
export function createKeyedList<T>(
  getItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  renderItem: FineGrainedRenderItem<T>,
  needsIndex?: boolean,
  startMarker?: Comment,
  endMarker?: Comment,
  skipHoles?: boolean,
  namespace?: ListNamespaceContext,
): KeyedListBinding {
  const resolvedNeedsIndex =
    arguments.length >= 4 ? !!needsIndex : renderItem.length > 1 /* has index param */
  return createFineGrainedKeyedList(
    getItems,
    keyFn,
    renderItem,
    resolvedNeedsIndex,
    startMarker,
    endMarker,
    !!skipHoles,
    namespace,
  )
}

function createFineGrainedKeyedList<T>(
  getItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  renderItem: FineGrainedRenderItem<T>,
  needsIndex: boolean,
  startOverride?: Comment,
  endOverride?: Comment,
  skipHoles = false,
  namespace?: ListNamespaceContext,
): KeyedListBinding {
  const hostRoot = getCurrentRoot()
  const container = createKeyedListContainer<T>(
    startOverride,
    endOverride,
    hostRoot?.ownerDocument ?? document,
  )
  const markerOwnerDocument =
    container.startMarker.ownerDocument ?? hostRoot?.ownerDocument ?? document
  const useProvided = !!(startOverride && endOverride)
  const fragment = useProvided
    ? container.startMarker
    : markerOwnerDocument.createDocumentFragment()
  if (!useProvided) {
    ;(fragment as DocumentFragment).append(container.startMarker, container.endMarker)
  }
  let disposed = false
  let effectDispose: (() => void) | undefined
  let connectObserver: MutationObserver | null = null
  let effectStarted = false
  let startScheduled = false
  let initialHydrating = __fictIsHydrating()

  const collectBetween = (): Node[] => {
    const nodes: Node[] = []
    let cursor = container.startMarker.nextSibling
    while (cursor && cursor !== container.endMarker) {
      nodes.push(cursor)
      cursor = cursor.nextSibling
    }
    return nodes
  }

  const getConnectedParent = (): (ParentNode & Node) | null => {
    const endParent = container.endMarker.parentNode
    const startParent = container.startMarker.parentNode
    if (endParent && startParent && endParent === startParent) {
      const parentNode = endParent as ParentNode & Node
      if (parentNode.nodeType === 11) {
        if (isShadowRoot(parentNode)) {
          const host = parentNode.host
          if ('isConnected' in host && !host.isConnected) return null
        }
        return parentNode
      }
      if ('isConnected' in parentNode && !parentNode.isConnected) return null
      return parentNode
    }
    return null
  }

  const performDiff = () => {
    if (disposed) return
    // During SSR, render synchronously without waiting for DOM connection
    const isSSR = __fictIsSSR()
    const parent = isSSR
      ? (container.startMarker.parentNode as (ParentNode & Node) | null)
      : getConnectedParent()
    if (!parent) return
    batch(() => {
      const oldBlocks = container.blocks
      const newBlocks = container.nextBlocks
      const prevOrderedBlocks = container.orderedBlocks
      const nextOrderedBlocks = container.nextOrderedBlocks
      const orderedIndexByKey = container.orderedIndexByKey
      const newItems = getItems()
      const newEntries = collectListEntries(newItems, skipHoles)
      const newCount = newEntries.length

      if (initialHydrating && isHydratingActive()) {
        initialHydrating = false
        newBlocks.clear()
        nextOrderedBlocks.length = 0
        orderedIndexByKey.clear()
        const hydrateKeyOccurrences = new Map<ListKey, number>()

        if (newCount === 0) {
          oldBlocks.clear()
          prevOrderedBlocks.length = 0
          container.currentNodes = [container.startMarker, container.endMarker]
          container.nextNodes.length = 0
          return
        }

        const createdBlocks: KeyedBlock<T>[] = []
        withHydrationRange(
          container.startMarker.nextSibling,
          container.endMarker,
          parent.ownerDocument ?? markerOwnerDocument,
          () => {
            for (let entryIndex = 0; entryIndex < newEntries.length; entryIndex++) {
              const { item, index } = newEntries[entryIndex]!
              const { key, identityKey, occurrence } = resolveListKey(
                container,
                keyFn,
                item,
                index,
                hydrateKeyOccurrences,
              )
              if (occurrence > 0) {
                warnDuplicateListKey(key, 'hydration')
              }
              const block = createKeyedBlock<T>(
                key,
                identityKey,
                item,
                index,
                renderItem,
                needsIndex,
                hostRoot,
                namespace,
              )
              createdBlocks.push(block)
              newBlocks.set(identityKey, block)
              orderedIndexByKey.set(identityKey, nextOrderedBlocks.length)
              nextOrderedBlocks.push(block)
            }
          },
        )

        container.blocks = newBlocks
        container.nextBlocks = oldBlocks
        container.orderedBlocks = nextOrderedBlocks
        container.nextOrderedBlocks = prevOrderedBlocks
        oldBlocks.clear()
        prevOrderedBlocks.length = 0
        container.currentNodes = [container.startMarker, ...collectBetween(), container.endMarker]
        container.nextNodes.length = 0

        for (const block of createdBlocks) {
          if (newBlocks.get(block.identityKey) === block) {
            flushOnMount(block.root)
          }
        }

        return
      }

      if (newCount === 0) {
        if (oldBlocks.size > 0) {
          // Destroy all block roots first
          for (const block of oldBlocks.values()) {
            destroyRoot(block.root)
          }
          // Use Range.deleteContents for efficient bulk DOM removal
          const range = (parent.ownerDocument ?? markerOwnerDocument).createRange()
          range.setStartAfter(container.startMarker)
          range.setEndBefore(container.endMarker)
          range.deleteContents()
        }
        oldBlocks.clear()
        newBlocks.clear()
        prevOrderedBlocks.length = 0
        nextOrderedBlocks.length = 0
        orderedIndexByKey.clear()
        container.duplicateKeyIdentities.clear()
        container.currentNodes.length = 0
        container.currentNodes.push(container.startMarker, container.endMarker)
        container.nextNodes.length = 0
        return
      }

      const prevCount = prevOrderedBlocks.length
      if (prevCount > 0 && newCount === prevCount && orderedIndexByKey.size === prevCount) {
        let stableOrder = true
        const stableKeyOccurrences = new Map<ListKey, number>()
        for (let i = 0; i < prevCount; i++) {
          const { item, index } = newEntries[i]!
          const { key, identityKey, occurrence } = resolveListKey(
            container,
            keyFn,
            item,
            index,
            stableKeyOccurrences,
          )
          if (occurrence > 0) {
            warnDuplicateListKey(key, 'rendering')
          }
          if (prevOrderedBlocks[i]!.identityKey !== identityKey) {
            stableOrder = false
            break
          }
        }
        if (stableOrder) {
          for (let i = 0; i < prevCount; i++) {
            const { item, index } = newEntries[i]!
            const block = prevOrderedBlocks[i]!
            if (block.rawItem !== item) {
              block.rawItem = item
              block.item(item)
            }
            if (needsIndex && block.rawIndex !== index) {
              block.rawIndex = index
              block.index(index)
            }
          }
          return
        }
      }

      newBlocks.clear()
      nextOrderedBlocks.length = 0
      orderedIndexByKey.clear()
      const createdBlocks: KeyedBlock<T>[] = []
      let appendCandidate = prevCount > 0 && newCount >= prevCount
      const appendedBlocks: KeyedBlock<T>[] = []
      let mismatchCount = 0
      let mismatchFirst = -1
      let mismatchSecond = -1
      let hasDuplicateKey = false
      const keyOccurrences = new Map<ListKey, number>()

      // Phase 1: Build new blocks map (reuse or create)
      newEntries.forEach(({ item, index }) => {
        const { key, identityKey, occurrence } = resolveListKey(
          container,
          keyFn,
          item,
          index,
          keyOccurrences,
        )
        if (occurrence > 0) {
          warnDuplicateListKey(key, 'rendering')
          hasDuplicateKey = true
        }
        // Micro-optimization: single Map.get instead of has+get
        let block = oldBlocks.get(identityKey)
        const existed = block !== undefined

        if (block) {
          if (block.rawItem !== item) {
            block.rawItem = item
            block.item(item)
          }
          if (needsIndex && block.rawIndex !== index) {
            block.rawIndex = index
            block.index(index)
          }
        }

        if (block) {
          // Reusing existing block from oldBlocks
          newBlocks.set(identityKey, block)
          oldBlocks.delete(identityKey)
        } else {
          // Create new block
          block = createKeyedBlock<T>(
            key,
            identityKey,
            item,
            index,
            renderItem,
            needsIndex,
            hostRoot,
            namespace,
          )
          createdBlocks.push(block)
        }

        const resolvedBlock = block

        newBlocks.set(identityKey, resolvedBlock)

        // Micro-optimization: single Map.get instead of checking position multiple times
        const position = orderedIndexByKey.get(identityKey)
        if (position !== undefined) {
          appendCandidate = false
          const prior = nextOrderedBlocks[position]
          if (prior && prior !== resolvedBlock) {
            destroyRoot(prior.root)
            removeNodes(prior.nodes)
          }
          nextOrderedBlocks[position] = resolvedBlock
        } else {
          if (appendCandidate) {
            if (index < prevCount) {
              if (
                !prevOrderedBlocks[index] ||
                prevOrderedBlocks[index]!.identityKey !== identityKey
              ) {
                appendCandidate = false
              }
            } else if (existed) {
              appendCandidate = false
            }
          }
          const nextIndex = nextOrderedBlocks.length
          orderedIndexByKey.set(identityKey, nextIndex)
          nextOrderedBlocks.push(resolvedBlock)
          if (
            mismatchCount < 3 &&
            (nextIndex >= prevCount || prevOrderedBlocks[nextIndex] !== resolvedBlock)
          ) {
            if (mismatchCount === 0) {
              mismatchFirst = nextIndex
            } else if (mismatchCount === 1) {
              mismatchSecond = nextIndex
            }
            mismatchCount++
          }
        }

        if (appendCandidate && index >= prevCount) {
          appendedBlocks.push(resolvedBlock)
        }
      })

      const canAppend =
        appendCandidate &&
        prevCount > 0 &&
        newCount > prevCount &&
        oldBlocks.size === 0 &&
        appendedBlocks.length > 0
      if (canAppend) {
        const appendedNodes: Node[] = []
        for (const block of appendedBlocks) {
          for (let i = 0; i < block.nodes.length; i++) {
            appendedNodes.push(block.nodes[i]!)
          }
        }
        if (appendedNodes.length > 0) {
          const insertedNodes = insertNodesBefore(parent, appendedNodes, container.endMarker)
          let insertedOffset = 0
          for (const block of appendedBlocks) {
            const nextBlockNodes = insertedNodes.slice(
              insertedOffset,
              insertedOffset + block.nodes.length,
            )
            if (nextBlockNodes.length === block.nodes.length) {
              block.nodes = nextBlockNodes
            }
            insertedOffset += block.nodes.length
          }
          const currentNodes = container.currentNodes
          currentNodes.pop()
          for (let i = 0; i < insertedNodes.length; i++) {
            currentNodes.push(insertedNodes[i]!)
          }
          currentNodes.push(container.endMarker)
        }

        container.blocks = newBlocks
        container.nextBlocks = oldBlocks
        container.orderedBlocks = nextOrderedBlocks
        container.nextOrderedBlocks = prevOrderedBlocks
        for (const block of createdBlocks) {
          if (newBlocks.get(block.identityKey) === block) {
            flushOnMount(block.root)
          }
        }
        return
      }

      // Phase 2: Remove old blocks that are no longer in the list
      if (oldBlocks.size > 0) {
        for (const block of oldBlocks.values()) {
          destroyRoot(block.root)
          removeNodes(block.nodes)
        }
        oldBlocks.clear()
      }

      const canReorderInPlace =
        createdBlocks.length === 0 &&
        oldBlocks.size === 0 &&
        nextOrderedBlocks.length === prevOrderedBlocks.length

      let skipReconcile = false
      let updateNodeBuffer = true

      if (canReorderInPlace && nextOrderedBlocks.length > 0 && !hasDuplicateKey) {
        if (mismatchCount === 0) {
          skipReconcile = true
          updateNodeBuffer = false
        } else if (
          mismatchCount === 2 &&
          prevOrderedBlocks[mismatchFirst] === nextOrderedBlocks[mismatchSecond] &&
          prevOrderedBlocks[mismatchSecond] === nextOrderedBlocks[mismatchFirst]
        ) {
          if (
            reorderBySwap(
              parent,
              prevOrderedBlocks[mismatchFirst]!,
              prevOrderedBlocks[mismatchSecond]!,
            )
          ) {
            skipReconcile = true
          }
        } else if (
          reorderByLIS(parent, container.endMarker, prevOrderedBlocks, nextOrderedBlocks)
        ) {
          skipReconcile = true
        }
      }

      // Phase 3: Reconcile DOM with buffered node arrays
      if (!skipReconcile && (newBlocks.size > 0 || container.currentNodes.length > 0)) {
        const prevNodes = container.currentNodes
        const nextNodes = container.nextNodes
        nextNodes.length = 0
        nextNodes.push(container.startMarker)

        for (let i = 0; i < nextOrderedBlocks.length; i++) {
          const nodes = nextOrderedBlocks[i]!.nodes
          for (let j = 0; j < nodes.length; j++) {
            nextNodes.push(nodes[j]!)
          }
        }

        nextNodes.push(container.endMarker)

        reconcileArrays(parent, prevNodes, nextNodes)

        // Swap buffers to reuse arrays on next diff
        container.currentNodes = nextNodes
        container.nextNodes = prevNodes
      } else if (skipReconcile && updateNodeBuffer) {
        const prevNodes = container.currentNodes
        const nextNodes = container.nextNodes
        nextNodes.length = 0
        nextNodes.push(container.startMarker)
        for (let i = 0; i < nextOrderedBlocks.length; i++) {
          const nodes = nextOrderedBlocks[i]!.nodes
          for (let j = 0; j < nodes.length; j++) {
            nextNodes.push(nodes[j]!)
          }
        }
        nextNodes.push(container.endMarker)
        container.currentNodes = nextNodes
        container.nextNodes = prevNodes
      }

      // Swap block maps for reuse
      container.blocks = newBlocks
      container.nextBlocks = oldBlocks
      container.orderedBlocks = nextOrderedBlocks
      container.nextOrderedBlocks = prevOrderedBlocks
      pruneDuplicateKeyIdentities(container, keyOccurrences)
      for (const block of createdBlocks) {
        if (newBlocks.get(block.identityKey) === block) {
          flushOnMount(block.root)
        }
      }
    })
  }

  const disconnectObserver = () => {
    connectObserver?.disconnect()
    connectObserver = null
  }

  const ensureEffectStarted = (): boolean => {
    if (disposed || effectStarted) return effectStarted
    // During SSR, render synchronously without waiting for DOM connection
    const isSSR = __fictIsSSR()
    const parent = isSSR
      ? (container.startMarker.parentNode as (ParentNode & Node) | null)
      : getConnectedParent()
    if (!parent) return false
    const start = () => {
      effectDispose = createRenderEffect(performDiff)
      effectStarted = true
    }
    if (hostRoot) {
      const prev = pushRoot(hostRoot)
      try {
        start()
      } finally {
        popRoot(prev)
      }
    } else {
      start()
    }
    return true
  }

  const waitForConnection = () => {
    if (connectObserver || typeof MutationObserver === 'undefined') return
    const root = container.startMarker.getRootNode?.() ?? markerOwnerDocument
    const shadowRoot =
      root && root.nodeType === 11 && isShadowRoot(root as Node) ? (root as ShadowRoot) : null
    connectObserver = new MutationObserver(() => {
      if (disposed) return
      if (getConnectedParent()) {
        disconnectObserver()
        if (ensureEffectStarted()) {
          flush()
        }
      }
    })
    connectObserver.observe(markerOwnerDocument, { childList: true, subtree: true })
    if (root && root.nodeType === 11) {
      connectObserver.observe(root as Node, { childList: true, subtree: true })
    }
    if (shadowRoot) {
      connectObserver.observe(shadowRoot, { childList: true, subtree: true })
    }
  }

  const scheduleStart = () => {
    if (startScheduled || disposed || effectStarted) return
    startScheduled = true
    const run = () => {
      startScheduled = false
      if (!ensureEffectStarted()) {
        waitForConnection()
      }
    }
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(run)
    } else {
      Promise.resolve()
        .then(run)
        .catch(() => undefined)
    }
  }

  scheduleStart()

  return {
    get marker() {
      scheduleStart()
      return fragment
    },
    startMarker: container.startMarker,
    endMarker: container.endMarker,
    // Flush pending items - call after markers are inserted into DOM
    flush: () => {
      if (disposed) return
      scheduleStart()
      if (ensureEffectStarted()) {
        flush()
      } else {
        waitForConnection()
      }
    },
    dispose: () => {
      disposed = true
      effectDispose?.()
      disconnectObserver()
      container.dispose()
    },
    __duplicateKeyIdentitySize: () => container.duplicateKeyIdentities.size,
  }
}
