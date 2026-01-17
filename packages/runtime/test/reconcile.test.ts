/**
 * DOM Reconciliation Tests
 *
 * Tests for reconcileArrays and reconcileNodes functions.
 * Covers all 5 reconciliation strategies:
 * 1. Common prefix optimization
 * 2. Common suffix optimization
 * 3. Append (old array exhausted)
 * 4. Remove (new array exhausted)
 * 5. Swap/Map fallback for complex rearrangements
 */

import { describe, it, expect, beforeEach } from 'vitest'

import reconcileArrays, { reconcileNodes } from '../src/reconcile'

describe('reconcileArrays', () => {
  let parent: HTMLDivElement

  beforeEach(() => {
    parent = document.createElement('div')
  })

  // Helper to create text nodes
  const createNodes = (texts: string[]): Text[] => texts.map(t => document.createTextNode(t))

  // Helper to get text content of all children
  const getChildTexts = (el: HTMLElement): string[] =>
    Array.from(el.childNodes).map(n => n.textContent ?? '')

  // ============================================================================
  // Edge Cases
  // ============================================================================
  describe('Edge Cases', () => {
    it('handles empty old array (insert all new nodes)', () => {
      const oldNodes: Node[] = []
      const newNodes = createNodes(['a', 'b', 'c'])

      reconcileArrays(parent, oldNodes, newNodes)

      expect(getChildTexts(parent)).toEqual(['a', 'b', 'c'])
    })

    it('handles empty new array (remove all old nodes)', () => {
      const oldNodes = createNodes(['a', 'b', 'c'])
      oldNodes.forEach(n => parent.appendChild(n))
      const newNodes: Node[] = []

      reconcileArrays(parent, oldNodes, newNodes)

      expect(getChildTexts(parent)).toEqual([])
    })

    it('handles both arrays empty', () => {
      reconcileArrays(parent, [], [])
      expect(parent.childNodes.length).toBe(0)
    })

    it('handles single node unchanged', () => {
      const node = createNodes(['a'])[0]!
      parent.appendChild(node)

      reconcileArrays(parent, [node], [node])

      expect(getChildTexts(parent)).toEqual(['a'])
      expect(parent.firstChild).toBe(node)
    })

    it('handles single node replaced', () => {
      const oldNode = createNodes(['a'])[0]!
      parent.appendChild(oldNode)
      const newNode = createNodes(['b'])[0]!

      reconcileArrays(parent, [oldNode], [newNode])

      expect(getChildTexts(parent)).toEqual(['b'])
      expect(parent.firstChild).toBe(newNode)
    })
  })

  // ============================================================================
  // Step 1: Common Prefix Optimization
  // ============================================================================
  describe('Common Prefix Optimization', () => {
    it('skips matching nodes at start', () => {
      const a = createNodes(['a'])[0]!
      const b = createNodes(['b'])[0]!
      parent.appendChild(a)
      parent.appendChild(b)

      const c = createNodes(['c'])[0]!
      reconcileArrays(parent, [a, b], [a, c])

      expect(getChildTexts(parent)).toEqual(['a', 'c'])
      expect(parent.childNodes[0]).toBe(a) // Same reference
    })

    it('handles all nodes matching (no changes)', () => {
      const nodes = createNodes(['a', 'b', 'c'])
      nodes.forEach(n => parent.appendChild(n))

      reconcileArrays(parent, nodes, nodes)

      expect(getChildTexts(parent)).toEqual(['a', 'b', 'c'])
      nodes.forEach((n, i) => expect(parent.childNodes[i]).toBe(n))
    })
  })

  // ============================================================================
  // Step 2: Common Suffix Optimization
  // ============================================================================
  describe('Common Suffix Optimization', () => {
    it('skips matching nodes at end', () => {
      const a = createNodes(['a'])[0]!
      const b = createNodes(['b'])[0]!
      parent.appendChild(a)
      parent.appendChild(b)

      const c = createNodes(['c'])[0]!
      reconcileArrays(parent, [a, b], [c, b])

      expect(getChildTexts(parent)).toEqual(['c', 'b'])
      expect(parent.childNodes[1]).toBe(b) // Same reference
    })

    it('handles prefix and suffix together', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd', 'e'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, , , , e] = nodes

      const x = createNodes(['x'])[0]!
      reconcileArrays(parent, nodes, [a!, x, e!])

      expect(getChildTexts(parent)).toEqual(['a', 'x', 'e'])
      expect(parent.childNodes[0]).toBe(a)
      expect(parent.childNodes[2]).toBe(e)
    })
  })

  // ============================================================================
  // Step 3: Append Path
  // ============================================================================
  describe('Append Path', () => {
    it('appends new nodes at end', () => {
      const nodes = createNodes(['a', 'b'])
      nodes.forEach(n => parent.appendChild(n))

      const [a, b] = nodes
      const c = createNodes(['c'])[0]!
      const d = createNodes(['d'])[0]!

      reconcileArrays(parent, nodes, [a!, b!, c, d])

      expect(getChildTexts(parent)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('appends new nodes in middle', () => {
      const a = createNodes(['a'])[0]!
      const c = createNodes(['c'])[0]!
      parent.appendChild(a)
      parent.appendChild(c)

      const b = createNodes(['b'])[0]!

      reconcileArrays(parent, [a, c], [a, b, c])

      expect(getChildTexts(parent)).toEqual(['a', 'b', 'c'])
    })

    it('handles appending multiple nodes using DocumentFragment', () => {
      const a = createNodes(['a'])[0]!
      parent.appendChild(a)

      const newNodes = createNodes(['b', 'c', 'd', 'e'])

      reconcileArrays(parent, [a], [a, ...newNodes])

      expect(getChildTexts(parent)).toEqual(['a', 'b', 'c', 'd', 'e'])
    })
  })

  // ============================================================================
  // Step 4: Remove Path
  // ============================================================================
  describe('Remove Path', () => {
    it('removes nodes at end', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, b] = nodes

      reconcileArrays(parent, nodes, [a!, b!])

      expect(getChildTexts(parent)).toEqual(['a', 'b'])
    })

    it('removes nodes from middle', () => {
      const nodes = createNodes(['a', 'b', 'c'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, , c] = nodes

      reconcileArrays(parent, nodes, [a!, c!])

      expect(getChildTexts(parent)).toEqual(['a', 'c'])
    })

    it('removes all nodes between prefix and suffix', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd', 'e'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, , , , e] = nodes

      reconcileArrays(parent, nodes, [a!, e!])

      expect(getChildTexts(parent)).toEqual(['a', 'e'])
    })
  })

  // ============================================================================
  // Step 5a: Swap Backward Optimization
  // ============================================================================
  describe('Swap Backward Optimization', () => {
    it('handles simple swap', () => {
      const nodes = createNodes(['a', 'b'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, b] = nodes

      reconcileArrays(parent, nodes, [b!, a!])

      expect(getChildTexts(parent)).toEqual(['b', 'a'])
    })

    it('handles consecutive swaps', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, b, c, d] = nodes

      reconcileArrays(parent, nodes, [d!, c!, b!, a!])

      expect(getChildTexts(parent)).toEqual(['d', 'c', 'b', 'a'])
    })
  })

  // ============================================================================
  // Step 5b: Map Fallback for Complex Rearrangements
  // ============================================================================
  describe('Map Fallback', () => {
    it('handles complex reorder', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd', 'e'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, b, c, d, e] = nodes

      // Shuffle: [a, b, c, d, e] -> [e, a, c, b, d]
      reconcileArrays(parent, nodes, [e!, a!, c!, b!, d!])

      expect(getChildTexts(parent)).toEqual(['e', 'a', 'c', 'b', 'd'])
    })

    it('handles interleaved additions and removals', () => {
      const nodes = createNodes(['a', 'b', 'c'])
      nodes.forEach(n => parent.appendChild(n))
      const [, b] = nodes

      const x = createNodes(['x'])[0]!
      const y = createNodes(['y'])[0]!

      // [a, b, c] -> [x, b, y]
      reconcileArrays(parent, nodes, [x, b!, y])

      expect(getChildTexts(parent)).toEqual(['x', 'b', 'y'])
    })

    it('handles node moving from end to start', () => {
      const nodes = createNodes(['a', 'b', 'c', 'd'])
      nodes.forEach(n => parent.appendChild(n))
      const [a, b, c, d] = nodes

      // Move 'd' to front
      reconcileArrays(parent, nodes, [d!, a!, b!, c!])

      expect(getChildTexts(parent)).toEqual(['d', 'a', 'b', 'c'])
    })
  })

  // ============================================================================
  // Real-world Scenarios
  // ============================================================================
  describe('Real-world Scenarios', () => {
    it('simulates list item deletion in middle', () => {
      const items = createNodes(['item-1', 'item-2', 'item-3', 'item-4', 'item-5'])
      items.forEach(n => parent.appendChild(n))
      const [i1, i2, , i4, i5] = items

      // Delete item-3
      reconcileArrays(parent, items, [i1!, i2!, i4!, i5!])

      expect(getChildTexts(parent)).toEqual(['item-1', 'item-2', 'item-4', 'item-5'])
    })

    it('simulates list item reorder (drag & drop)', () => {
      const items = createNodes(['item-1', 'item-2', 'item-3'])
      items.forEach(n => parent.appendChild(n))
      const [i1, i2, i3] = items

      // Drag item-1 to end
      reconcileArrays(parent, items, [i2!, i3!, i1!])

      expect(getChildTexts(parent)).toEqual(['item-2', 'item-3', 'item-1'])
    })

    it('simulates paginated list refresh', () => {
      const page1 = createNodes(['a', 'b', 'c'])
      page1.forEach(n => parent.appendChild(n))

      const page2 = createNodes(['d', 'e', 'f'])

      // Replace entire page
      reconcileArrays(parent, page1, page2)

      expect(getChildTexts(parent)).toEqual(['d', 'e', 'f'])
    })

    it('simulates filtered list update', () => {
      const allItems = createNodes(['apple', 'banana', 'cherry', 'avocado'])
      allItems.forEach(n => parent.appendChild(n))
      const [apple, , , avocado] = allItems

      // Filter to items starting with 'a'
      reconcileArrays(parent, allItems, [apple!, avocado!])

      expect(getChildTexts(parent)).toEqual(['apple', 'avocado'])
    })
  })
})

describe('reconcileNodes', () => {
  let parent: HTMLDivElement

  beforeEach(() => {
    parent = document.createElement('div')
  })

  it('delegates to reconcileArrays', () => {
    const oldNodes = [document.createTextNode('old')]
    parent.appendChild(oldNodes[0]!)
    const newNodes = [document.createTextNode('new')]

    reconcileNodes(parent, oldNodes, newNodes)

    expect(parent.textContent).toBe('new')
  })
})
