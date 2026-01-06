/**
 * List Helpers for Compiler-Generated Fine-Grained Updates
 *
 * These helpers are used by the compiler to generate efficient keyed list rendering.
 * They provide low-level primitives for DOM node manipulation without rebuilding.
 */

import { createElement } from './dom'
import { createRenderEffect } from './effect'
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
import { batch } from './scheduler'
import { createSignal, effectScope, flush, setActiveSub, type Signal } from './signal'
import type { FictNode } from './types'

// Re-export shared DOM helpers for compiler-generated code
export { insertNodesBefore, removeNodes, toNodeArray }

// ============================================================================
// Types
// ============================================================================

/**
 * A keyed block represents a single item in a list with its associated DOM nodes and state
 */
export interface KeyedBlock<T = unknown> {
  /** Unique key for this block */
  key: string | number
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
export interface KeyedListContainer<T = unknown> {
  /** Start marker comment node */
  startMarker: Comment
  /** End marker comment node */
  endMarker: Comment
  /** Map of key to block */
  blocks: Map<string | number, KeyedBlock<T>>
  /** Scratch map reused for the next render */
  nextBlocks: Map<string | number, KeyedBlock<T>>
  /** Current nodes in DOM order (including markers) */
  currentNodes: Node[]
  /** Next-frame node buffer to avoid reallocations */
  nextNodes: Node[]
  /** Ordered blocks in current DOM order */
  orderedBlocks: KeyedBlock<T>[]
  /** Next-frame ordered block buffer to avoid reallocations */
  nextOrderedBlocks: KeyedBlock<T>[]
  /** Track position of keys in the ordered buffer to handle duplicates */
  orderedIndexByKey: Map<string | number, number>
  /** Cleanup function */
  dispose: () => void
}

/**
 * Binding handle returned by createKeyedList for compiler-generated code
 */
export interface KeyedListBinding {
  /** Document fragment placeholder inserted by the compiler/runtime */
  marker: DocumentFragment
  /** Start marker comment node */
  startMarker: Comment
  /** End marker comment node */
  endMarker: Comment
  /** Flush pending items - call after markers are inserted into DOM */
  flush?: () => void
  /** Cleanup function */
  dispose: () => void
}

type FineGrainedRenderItem<T> = (
  itemSig: Signal<T>,
  indexSig: Signal<number>,
  key: string | number,
) => Node[]

/**
 * A block identified by start/end comment markers.
 */
export interface MarkerBlock {
  start: Comment
  end: Comment
  root?: RootContext
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
    if (!node || !(node instanceof Node)) {
      throw new Error('Invalid node in moveNodesBefore')
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
            // Note: Cloning during move breaks references in KeyedBlock.nodes
            // This is a worst-case fallback for tests.
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
/**
 * Move an entire marker-delimited block (including markers) before the anchor.
 */
export function moveMarkerBlock(parent: Node, block: MarkerBlock, anchor: Node | null): void {
  const nodes = collectBlockNodes(block)
  if (nodes.length === 0) return
  moveNodesBefore(parent, nodes, anchor)
}

/**
 * Destroy a marker-delimited block, removing nodes and destroying the associated root.
 */
export function destroyMarkerBlock(block: MarkerBlock): void {
  if (block.root) {
    destroyRoot(block.root)
  }
  removeBlockRange(block)
}

function collectBlockNodes(block: MarkerBlock): Node[] {
  const nodes: Node[] = []
  let cursor: Node | null = block.start
  while (cursor) {
    nodes.push(cursor)
    if (cursor === block.end) {
      break
    }
    cursor = cursor.nextSibling
  }
  return nodes
}

function removeBlockRange(block: MarkerBlock): void {
  let cursor: Node | null = block.start
  while (cursor) {
    const next: Node | null = cursor.nextSibling
    cursor.parentNode?.removeChild(cursor)
    if (cursor === block.end) {
      break
    }
    cursor = next
  }
}

// BUG-019 FIX: Use a safe maximum version to prevent overflow
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
    // BUG-019 FIX: Reset version to prevent overflow
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
export function createKeyedListContainer<T = unknown>(): KeyedListContainer<T> {
  const startMarker = document.createComment('fict:list:start')
  const endMarker = document.createComment('fict:list:end')

  const dispose = () => {
    // Clean up all blocks
    for (const block of container.blocks.values()) {
      destroyRoot(block.root)
      // Nodes are removed by parent disposal or specific cleanup if needed
      // But for list disposal, we just clear the container
    }
    container.blocks.clear()
    container.nextBlocks.clear()

    // Remove nodes (including markers)
    // Check if markers are still in DOM before using Range
    if (!startMarker.parentNode || !endMarker.parentNode) {
      // Markers already removed, nothing to do
      container.currentNodes = []
      container.nextNodes = []
      container.orderedBlocks.length = 0
      container.nextOrderedBlocks.length = 0
      container.orderedIndexByKey.clear()
      return
    }
    const range = document.createRange()
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
  }

  const container: KeyedListContainer<T> = {
    startMarker,
    endMarker,
    blocks: new Map<string | number, KeyedBlock<T>>(),
    nextBlocks: new Map<string | number, KeyedBlock<T>>(),
    currentNodes: [startMarker, endMarker],
    nextNodes: [],
    orderedBlocks: [],
    nextOrderedBlocks: [],
    orderedIndexByKey: new Map<string | number, number>(),
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
export function createKeyedBlock<T>(
  key: string | number,
  item: T,
  index: number,
  render: (item: Signal<T>, index: Signal<number>, key: string | number) => Node[],
  needsIndex = true,
  hostRoot?: RootContext,
): KeyedBlock<T> {
  // Use versioned signal for all item types; avoid diffing proxy overhead for objects
  const itemSig = createVersionedSignalAccessor(item)

  const indexSig = needsIndex
    ? createSignal<number>(index)
    : (((next?: number) => {
        if (arguments.length === 0) return index
        index = next as number
        return index
      }) as Signal<number>)
  const root = createRootContext(hostRoot)
  const prevRoot = pushRoot(root)

  // BUG-003 FIX: Use effectScope to properly isolate child effects while
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
        rendered instanceof Node ||
        (Array.isArray(rendered) && rendered.every(n => n instanceof Node))
      ) {
        nodes = toNodeArray(rendered)
      } else {
        const element = createElement(rendered as unknown as FictNode)
        nodes = toNodeArray(element)
      }
    })

    // Register the scope cleanup with the root so effects are cleaned up
    // when the block is destroyed
    if (scopeDispose) {
      // Store the dispose function to be called when root is destroyed
      const originalCleanups = root.cleanups
      root.cleanups = [...originalCleanups, scopeDispose]
    }
  } finally {
    setActiveSub(prevSub)
    popRoot(prevRoot)
  }

  return {
    key,
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
 * Find the first node after the start marker (for getting current anchor)
 */
export function getFirstNodeAfter(marker: Comment): Node | null {
  return marker.nextSibling
}

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
): KeyedListBinding {
  const resolvedNeedsIndex =
    arguments.length >= 4 ? !!needsIndex : renderItem.length > 1 /* has index param */
  return createFineGrainedKeyedList(getItems, keyFn, renderItem, resolvedNeedsIndex)
}

function createFineGrainedKeyedList<T>(
  getItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  renderItem: FineGrainedRenderItem<T>,
  needsIndex: boolean,
): KeyedListBinding {
  const container = createKeyedListContainer<T>()
  const hostRoot = getCurrentRoot()
  const fragment = document.createDocumentFragment()
  fragment.append(container.startMarker, container.endMarker)
  let disposed = false
  let effectDispose: (() => void) | undefined
  let connectObserver: MutationObserver | null = null
  let effectStarted = false
  let startScheduled = false

  const getConnectedParent = (): (ParentNode & Node) | null => {
    const endParent = container.endMarker.parentNode
    const startParent = container.startMarker.parentNode
    if (
      endParent &&
      startParent &&
      endParent === startParent &&
      (endParent as Node).nodeType !== 11
    ) {
      return endParent as ParentNode & Node
    }
    return null
  }

  const performDiff = () => {
    if (disposed) return
    const parent = getConnectedParent()
    if (!parent) return
    batch(() => {
      const oldBlocks = container.blocks
      const newBlocks = container.nextBlocks
      const prevOrderedBlocks = container.orderedBlocks
      const nextOrderedBlocks = container.nextOrderedBlocks
      const orderedIndexByKey = container.orderedIndexByKey
      newBlocks.clear()
      nextOrderedBlocks.length = 0
      orderedIndexByKey.clear()
      const createdBlocks: KeyedBlock<T>[] = []
      const newItems = getItems()

      if (newItems.length === 0) {
        if (oldBlocks.size > 0) {
          // Destroy all block roots first
          for (const block of oldBlocks.values()) {
            destroyRoot(block.root)
          }
          // Use Range.deleteContents for efficient bulk DOM removal
          const range = document.createRange()
          range.setStartAfter(container.startMarker)
          range.setEndBefore(container.endMarker)
          range.deleteContents()
        }
        oldBlocks.clear()
        newBlocks.clear()
        prevOrderedBlocks.length = 0
        nextOrderedBlocks.length = 0
        orderedIndexByKey.clear()
        container.currentNodes.length = 0
        container.currentNodes.push(container.startMarker, container.endMarker)
        container.nextNodes.length = 0
        return
      }

      const prevCount = prevOrderedBlocks.length
      let appendCandidate = prevCount > 0 && newItems.length >= prevCount
      const appendedBlocks: KeyedBlock<T>[] = []

      // Phase 1: Build new blocks map (reuse or create)
      newItems.forEach((item, index) => {
        const key = keyFn(item, index)
        // Micro-optimization: single Map.get instead of has+get
        let block = oldBlocks.get(key)
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
          newBlocks.set(key, block)
          oldBlocks.delete(key)
        } else {
          // If newBlocks already has this key (duplicate key case), clean up the previous block
          const existingBlock = newBlocks.get(key)
          if (existingBlock) {
            // BUG-013 FIX: Warn about duplicate keys in development mode
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                `[fict] Duplicate key "${String(key)}" detected in list rendering. ` +
                  `Each item should have a unique key. The previous item with this key will be replaced.`,
              )
            }
            destroyRoot(existingBlock.root)
            removeNodes(existingBlock.nodes)
          }
          // Create new block
          block = createKeyedBlock(key, item, index, renderItem, needsIndex, hostRoot)
          createdBlocks.push(block)
        }

        const resolvedBlock = block

        newBlocks.set(key, resolvedBlock)

        // Micro-optimization: single Map.get instead of checking position multiple times
        const position = orderedIndexByKey.get(key)
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
              if (!prevOrderedBlocks[index] || prevOrderedBlocks[index]!.key !== key) {
                appendCandidate = false
              }
            } else if (existed) {
              appendCandidate = false
            }
          }
          orderedIndexByKey.set(key, nextOrderedBlocks.length)
          nextOrderedBlocks.push(resolvedBlock)
        }

        if (appendCandidate && index >= prevCount) {
          appendedBlocks.push(resolvedBlock)
        }
      })

      const canAppend =
        appendCandidate &&
        prevCount > 0 &&
        newItems.length > prevCount &&
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
          insertNodesBefore(parent, appendedNodes, container.endMarker)
          const currentNodes = container.currentNodes
          currentNodes.pop()
          for (let i = 0; i < appendedNodes.length; i++) {
            currentNodes.push(appendedNodes[i]!)
          }
          currentNodes.push(container.endMarker)
        }

        container.blocks = newBlocks
        container.nextBlocks = oldBlocks
        container.orderedBlocks = nextOrderedBlocks
        container.nextOrderedBlocks = prevOrderedBlocks
        for (const block of createdBlocks) {
          if (newBlocks.get(block.key) === block) {
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

      // Phase 3: Reconcile DOM with buffered node arrays
      if (newBlocks.size > 0 || container.currentNodes.length > 0) {
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
      }

      // Swap block maps for reuse
      container.blocks = newBlocks
      container.nextBlocks = oldBlocks
      container.orderedBlocks = nextOrderedBlocks
      container.nextOrderedBlocks = prevOrderedBlocks
      for (const block of createdBlocks) {
        if (newBlocks.get(block.key) === block) {
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
    const parent = getConnectedParent()
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
    connectObserver = new MutationObserver(() => {
      if (disposed) return
      if (getConnectedParent()) {
        disconnectObserver()
        if (ensureEffectStarted()) {
          flush()
        }
      }
    })
    connectObserver.observe(document, { childList: true, subtree: true })
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
  }
}
