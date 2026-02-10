import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DependencyGraph } from '../src/core/types'
import { GraphRenderer } from '../src/panel/graph-renderer'

describe('graph renderer', () => {
  const mockContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockContext as unknown as CanvasRenderingContext2D,
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when graph references nodes missing from graph.nodes map', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
    })
    document.body.appendChild(container)

    const renderer = new GraphRenderer({ container })
    const graph: DependencyGraph = {
      rootId: 2,
      nodes: new Map([
        [
          2,
          {
            id: 2,
            type: 'computed',
            name: 'double',
            depth: 0,
            sources: [1, 999], // 999 is missing in nodes map
            observers: [3],
          },
        ],
        [
          1,
          {
            id: 1,
            type: 'signal',
            name: 'count',
            depth: 1,
            sources: [],
            observers: [2],
          },
        ],
      ]),
      edges: [
        [1, 2],
        [999, 2],
      ],
    }

    expect(() => renderer.setGraph(graph)).not.toThrow()
    renderer.destroy()
  })
})
