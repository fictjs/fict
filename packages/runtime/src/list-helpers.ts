/**
 * List Helpers for Compiler-Generated Fine-Grained Updates
 *
 * These helpers are used by the compiler to generate efficient keyed list rendering.
 * They provide low-level primitives for DOM node manipulation without rebuilding.
 */

import { createSignal, type Signal } from './signal'
import { createVersionedSignal } from './versioned-signal'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  popRoot,
  pushRoot,
  type RootContext,
} from './lifecycle'
import { createEffect } from './effect'

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
  /** Cleanup function */
  dispose: () => void
}

/**
 * Binding handle returned by createKeyedList for compiler-generated code
 */
export interface KeyedListBinding {
  /** Start marker comment node */
  startMarker: Comment
  /** End marker comment node */
  endMarker: Comment
  /** Cleanup function */
  dispose: () => void
}

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
    // Only move if not already in correct position
    if (node.nextSibling !== anchor) {
      parent.insertBefore(node, anchor)
    }
    anchor = node
  }
}

/**
 * Remove an array of nodes from the DOM
 *
 * @param nodes - Array of nodes to remove
 */
export function removeNodes(nodes: Node[]): void {
  for (const node of nodes) {
    node.parentNode?.removeChild(node)
  }
}

/**
 * Insert nodes before an anchor node
 *
 * @param parent - Parent node
 * @param nodes - Nodes to insert
 * @param anchor - Node to insert before
 */
export function insertNodesBefore(parent: Node, nodes: Node[], anchor: Node | null): void {
  for (const node of nodes) {
    parent.insertBefore(node, anchor)
  }
}

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
    const next = cursor.nextSibling
    cursor.parentNode?.removeChild(cursor)
    if (cursor === block.end) {
      break
    }
    cursor = next
  }
}

function createVersionedSignalAccessor<T>(initialValue: T): Signal<T> {
  const versioned = createVersionedSignal(initialValue)
  function accessor(value?: T): T | void {
    if (arguments.length === 0) {
      return versioned.read()
    }
    versioned.write(value as T)
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
  const blocks = new Map<string | number, KeyedBlock<T>>()

  const dispose = () => {
    // Clean up all blocks
    for (const block of blocks.values()) {
      destroyRoot(block.root)
      removeNodes(block.nodes)
    }
    blocks.clear()

    // Remove markers
    startMarker.parentNode?.removeChild(startMarker)
    endMarker.parentNode?.removeChild(endMarker)
  }

  return {
    startMarker,
    endMarker,
    blocks,
    dispose,
  }
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
  render: (item: Signal<T>, index: Signal<number>) => Node[],
): KeyedBlock<T> {
  const itemSig = createVersionedSignalAccessor(item)
  const indexSig = createSignal<number>(index)
  const root = createRootContext()
  const prev = pushRoot(root)

  let nodes: Node[] = []
  try {
    nodes = render(itemSig, indexSig)
  } finally {
    popRoot(prev)
    flushOnMount(root)
  }

  return {
    key,
    nodes,
    root,
    item: itemSig,
    index: indexSig,
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Convert a single node or array to a flat array of nodes
 */
export function toNodeArray(node: Node | Node[]): Node[] {
  if (Array.isArray(node)) {
    return node
  }
  if (node instanceof DocumentFragment) {
    return Array.from(node.childNodes)
  }
  return [node]
}

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
  renderItem: (itemSig: Signal<T>, indexSig: Signal<number>) => Node[],
): KeyedListBinding {
  const container = createKeyedListContainer<T>()
  let pendingItems: T[] | null = null
  let disposed = false

  const performDiff = () => {
    if (disposed) return

    const newItems = pendingItems || getItems()
    pendingItems = null

    const oldBlocks = container.blocks
    const newBlocks = new Map<string | number, KeyedBlock<T>>()
    const parent = container.endMarker.parentNode

    // If parent doesn't exist yet, store items and retry in microtask
    if (!parent) {
      pendingItems = newItems
      queueMicrotask(performDiff)
      return
    }

    // Phase 1: Build new blocks map (reuse or create)
    newItems.forEach((item, index) => {
      const key = keyFn(item, index)
      let block = oldBlocks.get(key)

      if (block) {
        // Reuse existing block - update signals
        block.item(item)
        block.index(index)

        // If newBlocks already has this key (duplicate key case), clean up the previous block
        const existingBlock = newBlocks.get(key)
        if (existingBlock) {
          destroyRoot(existingBlock.root)
          removeNodes(existingBlock.nodes)
        }

        newBlocks.set(key, block)
        oldBlocks.delete(key)
      } else {
        // If newBlocks already has this key (duplicate key case), clean up the previous block
        const existingBlock = newBlocks.get(key)
        if (existingBlock) {
          destroyRoot(existingBlock.root)
          removeNodes(existingBlock.nodes)
        }

        // Create new block
        block = createKeyedBlock(key, item, index, renderItem)
        newBlocks.set(key, block)
      }
    })

    // Phase 2: Remove old blocks that are no longer in the list
    for (const block of oldBlocks.values()) {
      destroyRoot(block.root)
      removeNodes(block.nodes)
    }

    // Phase 3: Insert and reorder DOM nodes to match new order
    if (newBlocks.size > 0) {
      let anchor: Node | null = getFirstNodeAfter(container.startMarker)

      for (const key of Array.from(newBlocks.keys())) {
        const block = newBlocks.get(key)!
        const firstNode = block.nodes[0]

        // Skip blocks with no nodes
        if (!firstNode) continue

        // Check if block's nodes are in the DOM
        if (!firstNode.parentNode) {
          // New block - insert it
          insertNodesBefore(parent, block.nodes, anchor)
        } else if (firstNode !== anchor) {
          // Existing block in wrong position - move it
          moveNodesBefore(parent, block.nodes, anchor)
        }

        // Move anchor to after this block's last node
        const lastNode = block.nodes[block.nodes.length - 1]
        anchor = lastNode ? lastNode.nextSibling : anchor
      }
    }

    // Update container.blocks (clear and repopulate instead of reassigning)
    container.blocks.clear()
    for (const [key, block] of newBlocks) {
      container.blocks.set(key, block)
    }
  }

  const effectDispose = createEffect(performDiff)

  return {
    startMarker: container.startMarker,
    endMarker: container.endMarker,
    dispose: () => {
      disposed = true
      effectDispose?.()
      container.dispose()
    },
  }
}
