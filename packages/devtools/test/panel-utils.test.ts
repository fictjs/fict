import { describe, expect, it } from 'vitest'

import {
  collectComponentAncestorIds,
  inferGraphSelectableNodeType,
  normalizeDependencyGraphPayload,
  toGraphSelectableNodeType,
} from '../src/panel/panel-utils'

describe('panel utils', () => {
  it('collects component ancestors from parent to root', () => {
    const components = new Map([
      [1, {}],
      [2, { parentId: 1 }],
      [3, { parentId: 2 }],
      [4, { parentId: 3 }],
    ])

    expect(collectComponentAncestorIds(components, 4)).toEqual([3, 2, 1])
  })

  it('normalizes dependency graph payload with string ids', () => {
    const graph = normalizeDependencyGraphPayload({
      rootId: '2',
      nodes: {
        '1': { id: 1, type: 'signal', name: 'count', depth: 1, sources: [], observers: [2] },
        '2': {
          id: 2,
          type: 'computed',
          name: 'double',
          depth: 0,
          sources: [1],
          observers: [3],
        },
        '3': { id: 3, type: 'effect', name: 'log', depth: 1, sources: [2], observers: [] },
      },
      edges: [
        ['1', '2'],
        ['2', '3'],
      ],
    })

    expect(graph).toBeTruthy()
    expect(graph?.rootId).toBe(2)
    expect(graph?.nodes.size).toBe(3)
    expect(graph?.nodes.get(2)?.type).toBe('computed')
    expect(graph?.edges).toEqual([
      [1, 2],
      [2, 3],
    ])
  })

  it('resolves graph selectable node types', () => {
    expect(toGraphSelectableNodeType('signal')).toBe('signal')
    expect(toGraphSelectableNodeType('computed')).toBe('computed')
    expect(toGraphSelectableNodeType('effect')).toBe('effect')
    expect(toGraphSelectableNodeType('component')).toBeNull()
  })

  it('infers graph node type by id from current stores', () => {
    const signals = new Map([[1, {}]])
    const computeds = new Map([[2, {}]])
    const effects = new Map([[3, {}]])

    expect(inferGraphSelectableNodeType(1, signals, computeds, effects)).toBe('signal')
    expect(inferGraphSelectableNodeType(2, signals, computeds, effects)).toBe('computed')
    expect(inferGraphSelectableNodeType(3, signals, computeds, effects)).toBe('effect')
    expect(inferGraphSelectableNodeType(999, signals, computeds, effects)).toBeNull()
  })
})
