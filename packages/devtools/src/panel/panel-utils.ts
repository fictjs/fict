import type { DependencyGraph, DependencyGraphNode } from '../core/types'

export type GraphSelectableNodeType = 'signal' | 'computed' | 'effect'

interface ComponentWithParent {
  parentId?: number | undefined
}

function parseNodeId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

export function collectComponentAncestorIds(
  components: Map<number, ComponentWithParent>,
  componentId: number,
): number[] {
  const ancestors: number[] = []
  const visited = new Set<number>()
  let current = components.get(componentId)

  while (current?.parentId !== undefined) {
    const parentId = current.parentId
    if (!Number.isFinite(parentId) || parentId <= 0 || visited.has(parentId)) break
    ancestors.push(parentId)
    visited.add(parentId)
    current = components.get(parentId)
  }

  return ancestors
}

export function toGraphSelectableNodeType(nodeType: unknown): GraphSelectableNodeType | null {
  if (nodeType === 'signal' || nodeType === 'computed' || nodeType === 'effect') {
    return nodeType
  }
  return null
}

export function inferGraphSelectableNodeType(
  nodeId: number,
  signals: Map<number, unknown>,
  computeds: Map<number, unknown>,
  effects: Map<number, unknown>,
): GraphSelectableNodeType | null {
  if (signals.has(nodeId)) return 'signal'
  if (computeds.has(nodeId)) return 'computed'
  if (effects.has(nodeId)) return 'effect'
  return null
}

export function formatComputedDisplayName(name: unknown, id: number): string {
  const fallback = `Computed #${id}`
  const suffix = `:${fallback}`

  if (typeof name !== 'string') return fallback
  const normalized = name.trim()
  if (!normalized || normalized === fallback) return fallback
  if (normalized.endsWith(suffix)) return normalized
  return `${normalized}${suffix}`
}

export function normalizeDependencyGraphPayload(payload: unknown): DependencyGraph | null {
  if (!payload || typeof payload !== 'object') return null

  const candidate = payload as {
    rootId?: unknown
    nodes?: unknown
    edges?: unknown
  }
  const rootId = parseNodeId(candidate.rootId)
  if (rootId === null) return null

  const nodes = new Map<number, DependencyGraphNode>()
  const rawNodes = candidate.nodes

  if (rawNodes instanceof Map) {
    for (const [rawId, rawNode] of rawNodes.entries()) {
      const id = parseNodeId(rawId)
      if (id !== null && rawNode && typeof rawNode === 'object') {
        nodes.set(id, rawNode as DependencyGraphNode)
      }
    }
  } else if (Array.isArray(rawNodes)) {
    for (const entry of rawNodes) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const id = parseNodeId(entry[0])
        const node = entry[1]
        if (id !== null && node && typeof node === 'object') {
          nodes.set(id, node as DependencyGraphNode)
        }
      }
    }
  } else if (rawNodes && typeof rawNodes === 'object') {
    for (const [rawId, rawNode] of Object.entries(rawNodes)) {
      const id = parseNodeId(rawId)
      if (id !== null && rawNode && typeof rawNode === 'object') {
        nodes.set(id, rawNode as DependencyGraphNode)
      }
    }
  }

  const edges: [number, number][] = []
  if (Array.isArray(candidate.edges)) {
    for (const edge of candidate.edges) {
      if (Array.isArray(edge) && edge.length >= 2) {
        const from = parseNodeId(edge[0])
        const to = parseNodeId(edge[1])
        if (from !== null && to !== null) {
          edges.push([from, to])
        }
      }
    }
  }

  return {
    rootId,
    nodes,
    edges,
  }
}
