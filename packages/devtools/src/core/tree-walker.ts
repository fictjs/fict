/**
 * Component Tree Walker
 *
 * Walks the component/owner tree to build a hierarchical view
 * for the DevTools component inspector.
 */

import { type ComponentState, type RootState } from './types'

// ============================================================================
// Types
// ============================================================================

export interface TreeNode {
  id: number
  type: 'root' | 'component' | 'element'
  name: string
  depth: number
  parentId?: number
  children: TreeNode[]
  /** For components: associated signals, effects, etc. */
  signals?: number[]
  effects?: number[]
  computeds?: number[]
  /** DOM elements */
  elements?: number
  /** Is expanded in UI */
  isExpanded?: boolean
  /** Is currently selected */
  isSelected?: boolean
  /** Is matching a search filter */
  isMatching?: boolean
  /** Has matching children (for filter) */
  hasMatchingChildren?: boolean
  /** Source location */
  source?: { file: string; line: number; column: number }
  /** Render count */
  renderCount?: number
  /** Is mounted */
  isMounted?: boolean
}

export interface TreeWalkerOptions {
  /** Maximum depth to traverse */
  maxDepth?: number
  /** Filter string for search */
  filter?: string
  /** Include unmounted components */
  includeUnmounted?: boolean
  /** Expanded node IDs */
  expandedIds?: Set<number>
}

export interface WalkResult {
  tree: TreeNode[]
  nodeCount: number
  rootCount: number
  componentCount: number
}

// ============================================================================
// Tree Walker Implementation
// ============================================================================

/**
 * Build the component tree from DevTools state
 */
export function walkTree(
  roots: Map<number, RootState>,
  components: Map<number, ComponentState>,
  options: TreeWalkerOptions = {},
): WalkResult {
  const { maxDepth = 50, filter, includeUnmounted = false, expandedIds } = options

  const result: TreeNode[] = []
  let nodeCount = 0
  let rootCount = 0
  let componentCount = 0

  const filterLower = filter?.toLowerCase()

  // Process each root
  for (const [_id, root] of roots) {
    const rootNode = walkRoot(root, components, {
      depth: 0,
      maxDepth,
      filter: filterLower,
      includeUnmounted,
      expandedIds,
      visited: new Set<number>(),
    })

    if (rootNode) {
      result.push(rootNode)
      nodeCount += countNodes(rootNode)
      rootCount++
    }
  }

  // Count components
  for (const rootNode of result) {
    componentCount += countComponents(rootNode)
  }

  return {
    tree: result,
    nodeCount,
    rootCount,
    componentCount,
  }
}

/**
 * Walk a root context and its children
 */
function walkRoot(
  root: RootState,
  components: Map<number, ComponentState>,
  ctx: WalkContext,
): TreeNode | null {
  const node: TreeNode = {
    id: root.id,
    type: 'root',
    name: root.name || 'Root',
    depth: ctx.depth,
    children: [],
  }

  // Walk child components
  for (const childId of root.children) {
    const child = components.get(childId)
    if (child) {
      const childNode = walkComponent(child, components, {
        ...ctx,
        depth: ctx.depth + 1,
        parentId: root.id,
      })
      if (childNode) {
        node.children.push(childNode)
      }
    }
  }

  // Apply filter
  if (ctx.filter) {
    const matchesFilter = matchesSearch(node.name, ctx.filter)
    node.isMatching = matchesFilter
    node.hasMatchingChildren = node.children.some(c => c.isMatching || c.hasMatchingChildren)

    // Hide if neither matches nor has matching children
    if (!matchesFilter && !node.hasMatchingChildren) {
      return null
    }
  }

  return node
}

/**
 * Walk a component and its children
 */
function walkComponent(
  component: ComponentState,
  components: Map<number, ComponentState>,
  ctx: WalkContext,
): TreeNode | null {
  // Check for circular reference in the current recursion path to prevent infinite loops.
  // We use a "stack-based" approach: add on entry, remove on exit.
  // This allows the same component to appear in different branches (if data is malformed),
  // while still preventing true cycles (A -> B -> A).
  if (ctx.visited.has(component.id)) {
    return null
  }

  // Check if we should include unmounted components
  if (!ctx.includeUnmounted && !component.isMounted) {
    return null
  }

  // Check depth limit
  if (ctx.depth > ctx.maxDepth) {
    return null
  }

  // Add to visited stack for this recursion path
  ctx.visited.add(component.id)

  try {
    const node: TreeNode = {
      id: component.id,
      type: 'component',
      name: component.name,
      depth: ctx.depth,
      parentId: ctx.parentId,
      children: [],
      signals: component.signals,
      effects: component.effects,
      computeds: component.computeds,
      elements: component.elements?.length,
      source: component.source,
      renderCount: component.renderCount,
      isMounted: component.isMounted,
    }

    // Set expansion state
    if (ctx.expandedIds) {
      node.isExpanded = ctx.expandedIds.has(component.id)
    }

    // Walk child components
    for (const childId of component.children) {
      const child = components.get(childId)
      if (child) {
        const childNode = walkComponent(child, components, {
          ...ctx,
          depth: ctx.depth + 1,
          parentId: component.id,
        })
        if (childNode) {
          node.children.push(childNode)
        }
      }
    }

    // Apply filter
    if (ctx.filter) {
      const matchesFilter = matchesSearch(node.name, ctx.filter)
      node.isMatching = matchesFilter
      node.hasMatchingChildren = node.children.some(c => c.isMatching || c.hasMatchingChildren)

      // Hide if neither matches nor has matching children
      if (!matchesFilter && !node.hasMatchingChildren) {
        return null
      }
    }

    return node
  } finally {
    // Remove from visited stack when backtracking
    ctx.visited.delete(component.id)
  }
}

interface WalkContext {
  depth: number
  maxDepth: number
  filter?: string
  includeUnmounted: boolean
  expandedIds?: Set<number>
  parentId?: number
  /** Visited component IDs to prevent infinite loops from circular references */
  visited: Set<number>
}

// ============================================================================
// Search/Filter
// ============================================================================

/**
 * Check if a name matches the search filter
 */
function matchesSearch(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter)
}

/**
 * Find nodes matching a search query
 */
export function findNodes(tree: TreeNode[], query: string): TreeNode[] {
  const results: TreeNode[] = []
  const queryLower = query.toLowerCase()

  function search(nodes: TreeNode[]): void {
    for (const node of nodes) {
      if (matchesSearch(node.name, queryLower)) {
        results.push(node)
      }
      if (node.children.length > 0) {
        search(node.children)
      }
    }
  }

  search(tree)
  return results
}

/**
 * Find a node by ID
 */
export function findNodeById(tree: TreeNode[], id: number): TreeNode | null {
  function search(nodes: TreeNode[]): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) {
        return node
      }
      if (node.children.length > 0) {
        const found = search(node.children)
        if (found) return found
      }
    }
    return null
  }

  return search(tree)
}

/**
 * Get the path from root to a node
 */
export function getNodePath(tree: TreeNode[], targetId: number): TreeNode[] {
  const path: TreeNode[] = []

  function search(nodes: TreeNode[]): boolean {
    for (const node of nodes) {
      path.push(node)
      if (node.id === targetId) {
        return true
      }
      if (node.children.length > 0 && search(node.children)) {
        return true
      }
      path.pop()
    }
    return false
  }

  search(tree)
  return path
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Count total nodes in a tree
 */
function countNodes(node: TreeNode): number {
  let count = 1
  for (const child of node.children) {
    count += countNodes(child)
  }
  return count
}

/**
 * Count components in a tree
 */
function countComponents(node: TreeNode): number {
  let count = node.type === 'component' ? 1 : 0
  for (const child of node.children) {
    count += countComponents(child)
  }
  return count
}

/**
 * Flatten tree to array for virtual scrolling
 */
export function flattenTree(tree: TreeNode[], expandedIds: Set<number>): TreeNode[] {
  const result: TreeNode[] = []

  function flatten(nodes: TreeNode[]): void {
    for (const node of nodes) {
      result.push(node)
      if (node.children.length > 0 && expandedIds.has(node.id)) {
        flatten(node.children)
      }
    }
  }

  flatten(tree)
  return result
}

/**
 * Get all node IDs in a tree
 */
export function getAllNodeIds(tree: TreeNode[]): Set<number> {
  const ids = new Set<number>()

  function collect(nodes: TreeNode[]): void {
    for (const node of nodes) {
      ids.add(node.id)
      if (node.children.length > 0) {
        collect(node.children)
      }
    }
  }

  collect(tree)
  return ids
}

/**
 * Expand all ancestors of a node
 */
export function expandToNode(tree: TreeNode[], targetId: number): Set<number> {
  const expanded = new Set<number>()
  const path = getNodePath(tree, targetId)

  // Add all nodes except the target itself
  for (let i = 0; i < path.length - 1; i++) {
    expanded.add(path[i]!.id)
  }

  return expanded
}

/**
 * Collapse all nodes except roots
 */
export function collapseAll(tree: TreeNode[]): Set<number> {
  const expanded = new Set<number>()
  // Keep only root nodes expanded
  for (const node of tree) {
    if (node.type === 'root') {
      expanded.add(node.id)
    }
  }
  return expanded
}

/**
 * Expand all nodes
 */
export function expandAll(tree: TreeNode[]): Set<number> {
  return getAllNodeIds(tree)
}

export default {
  walkTree,
  findNodes,
  findNodeById,
  getNodePath,
  flattenTree,
  getAllNodeIds,
  expandToNode,
  collapseAll,
  expandAll,
}
