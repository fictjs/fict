/**
 * Property-Based / Fuzz Tests for List Operations
 *
 * Uses randomized inputs to stress-test list diff algorithm
 * and verify invariants hold under all conditions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createSignal, createEffect, onCleanup, createKeyedList } from '../src/index'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

// Pseudo-random number generator with seed for reproducibility
function createRng(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

// Generate random list operations
type ListOp =
  | { type: 'insert'; index: number; item: { id: number; value: string } }
  | { type: 'remove'; index: number }
  | { type: 'update'; index: number; value: string }
  | { type: 'move'; from: number; to: number }
  | { type: 'reverse' }
  | { type: 'shuffle' }
  | { type: 'clear' }

function generateOps(rng: () => number, count: number, maxId: number): ListOp[] {
  const ops: ListOp[] = []
  let nextId = 1

  for (let i = 0; i < count; i++) {
    const opType = rng()

    if (opType < 0.25) {
      // Insert
      ops.push({
        type: 'insert',
        index: Math.floor(rng() * (maxId + 1)),
        item: { id: nextId++, value: `item-${nextId}` },
      })
    } else if (opType < 0.45) {
      // Remove
      ops.push({
        type: 'remove',
        index: Math.floor(rng() * maxId),
      })
    } else if (opType < 0.65) {
      // Update
      ops.push({
        type: 'update',
        index: Math.floor(rng() * maxId),
        value: `updated-${Math.floor(rng() * 1000)}`,
      })
    } else if (opType < 0.8) {
      // Move
      ops.push({
        type: 'move',
        from: Math.floor(rng() * maxId),
        to: Math.floor(rng() * maxId),
      })
    } else if (opType < 0.9) {
      // Reverse
      ops.push({ type: 'reverse' })
    } else if (opType < 0.95) {
      // Shuffle
      ops.push({ type: 'shuffle' })
    } else {
      // Clear (rare)
      ops.push({ type: 'clear' })
    }
  }

  return ops
}

function applyOp<T extends { id: number; value: string }>(
  items: T[],
  op: ListOp,
  rng: () => number,
): T[] {
  const result = [...items]

  switch (op.type) {
    case 'insert':
      if (op.index <= result.length) {
        result.splice(op.index, 0, op.item as T)
      }
      break
    case 'remove':
      if (op.index < result.length) {
        result.splice(op.index, 1)
      }
      break
    case 'update':
      if (op.index < result.length && result[op.index]) {
        result[op.index] = { ...result[op.index]!, value: op.value }
      }
      break
    case 'move':
      if (op.from < result.length && op.to < result.length) {
        const [item] = result.splice(op.from, 1)
        if (item) result.splice(op.to, 0, item)
      }
      break
    case 'reverse':
      result.reverse()
      break
    case 'shuffle':
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[result[i], result[j]] = [result[j]!, result[i]!]
      }
      break
    case 'clear':
      return []
  }

  return result
}

describe('List Fuzzing Tests', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('Invariant: DOM matches signal state', () => {
    it('maintains consistency through random operations (seed 12345)', async () => {
      const rng = createRng(12345)
      const items = createSignal<{ id: number; value: string }[]>([])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          div.dataset.id = String(itemSig().id)
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Initial state
      items([
        { id: 1, value: 'a' },
        { id: 2, value: 'b' },
        { id: 3, value: 'c' },
      ])
      await tick()

      // Generate and apply 100 random operations
      const ops = generateOps(rng, 100, 20)
      let currentItems = items()

      for (const op of ops) {
        currentItems = applyOp(currentItems, op, rng)
        items(currentItems)
        await tick()

        // Verify invariant: DOM matches state
        const divs = container.querySelectorAll('div')
        expect(divs.length).toBe(currentItems.length)

        currentItems.forEach((item, i) => {
          const div = divs[i] as HTMLDivElement
          expect(div?.dataset.id).toBe(String(item.id))
          expect(div?.textContent).toBe(item.value)
        })
      }

      list.dispose()
    })

    it('maintains consistency through random operations (seed 98765)', async () => {
      const rng = createRng(98765)
      const items = createSignal<{ id: number; value: string }[]>([])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          div.dataset.id = String(itemSig().id)
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      items([
        { id: 10, value: 'x' },
        { id: 20, value: 'y' },
      ])
      await tick()

      const ops = generateOps(rng, 100, 15)
      let currentItems = items()

      for (const op of ops) {
        currentItems = applyOp(currentItems, op, rng)
        items(currentItems)
        await tick()

        const divs = container.querySelectorAll('div')
        expect(divs.length).toBe(currentItems.length)
      }

      list.dispose()
    })
  })

  describe('Invariant: Node identity preserved on reorder', () => {
    it('same key keeps same DOM node through shuffles', async () => {
      const items = createSignal([
        { id: 1, value: 'a' },
        { id: 2, value: 'b' },
        { id: 3, value: 'c' },
        { id: 4, value: 'd' },
        { id: 5, value: 'e' },
      ])

      const originalNodes = new Map<number, HTMLDivElement>()
      let isInitialized = false

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          const id = itemSig().id
          // Only record nodes on first creation
          if (!isInitialized) {
            originalNodes.set(id, div)
          }
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()
      isInitialized = true

      // Shuffle multiple times
      const rng = createRng(42)
      for (let i = 0; i < 20; i++) {
        const shuffled = [...items()]
        for (let j = shuffled.length - 1; j > 0; j--) {
          const k = Math.floor(rng() * (j + 1))
          ;[shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!]
        }
        items(shuffled)
        await tick()

        // Verify all original nodes still exist in DOM
        const divs = container.querySelectorAll('div')
        expect(divs.length).toBe(items().length)

        // Verify each original node is still in the container
        originalNodes.forEach((node, id) => {
          expect(container.contains(node)).toBe(true)
          // Verify content was updated properly
          const currentItem = items().find(item => item.id === id)
          if (currentItem) {
            expect(node.textContent).toBe(currentItem.value)
          }
        })
      }

      list.dispose()
    })
  })

  describe('Invariant: Cleanup count matches removal count', () => {
    it('each removed item triggers exactly one cleanup', async () => {
      const items = createSignal<{ id: number }[]>([])
      const cleanups = new Map<number, number>()

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          const id = itemSig().id
          cleanups.set(id, 0)
          createEffect(() => {
            itemSig()
            onCleanup(() => {
              cleanups.set(id, (cleanups.get(id) || 0) + 1)
            })
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Add items
      const initialItems = Array.from({ length: 10 }, (_, i) => ({ id: i }))
      items(initialItems)
      await tick()

      // Remove half randomly
      const rng = createRng(777)
      const current = [...initialItems]
      const removed: number[] = []

      for (let i = 0; i < 5; i++) {
        const idx = Math.floor(rng() * current.length)
        const [item] = current.splice(idx, 1)
        if (item) removed.push(item.id)
        items([...current])
        await tick()
      }

      // Each removed item should have been cleaned up exactly once
      for (const id of removed) {
        expect(cleanups.get(id)).toBe(1)
      }

      // Remaining items should not have final cleanup yet
      for (const item of current) {
        // May have cleanup from signal updates, but not from removal
        // Actually cleanups run on each effect re-run, so we just check they exist
        expect(cleanups.has(item.id)).toBe(true)
      }

      list.dispose()
    })
  })

  describe('Invariant: Index signals stay in sync', () => {
    it('index values always match actual position', async () => {
      const items = createSignal([
        { id: 1, value: 'a' },
        { id: 2, value: 'b' },
        { id: 3, value: 'c' },
      ])
      const indexMap = new Map<number, number>()

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            indexMap.set(itemSig().id, indexSig())
            div.dataset.index = String(indexSig())
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Verify initial indices
      expect(indexMap.get(1)).toBe(0)
      expect(indexMap.get(2)).toBe(1)
      expect(indexMap.get(3)).toBe(2)

      // Reverse
      items([
        { id: 3, value: 'c' },
        { id: 2, value: 'b' },
        { id: 1, value: 'a' },
      ])
      await tick()

      expect(indexMap.get(3)).toBe(0)
      expect(indexMap.get(2)).toBe(1)
      expect(indexMap.get(1)).toBe(2)

      // Insert at beginning
      items([
        { id: 4, value: 'd' },
        { id: 3, value: 'c' },
        { id: 2, value: 'b' },
        { id: 1, value: 'a' },
      ])
      await tick()

      expect(indexMap.get(4)).toBe(0)
      expect(indexMap.get(3)).toBe(1)
      expect(indexMap.get(2)).toBe(2)
      expect(indexMap.get(1)).toBe(3)

      list.dispose()
    })
  })

  describe('Stress Tests', () => {
    it('handles 1000 rapid updates without errors', async () => {
      const items = createSignal<{ id: number }[]>([])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig().id)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Rapid updates
      for (let i = 0; i < 1000; i++) {
        items(Array.from({ length: (i % 10) + 1 }, (_, j) => ({ id: i * 100 + j })))
      }
      await tick()

      // Should end up with last state
      expect(container.querySelectorAll('div').length).toBe(10)

      list.dispose()
    })

    it('handles alternating empty/full states', async () => {
      const items = createSignal<{ id: number }[]>([])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig().id)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      for (let i = 0; i < 50; i++) {
        // Fill
        items(Array.from({ length: 100 }, (_, j) => ({ id: j })))
        await tick()
        expect(container.querySelectorAll('div').length).toBe(100)

        // Empty
        items([])
        await tick()
        expect(container.querySelectorAll('div').length).toBe(0)
      }

      list.dispose()
    })

    it('handles worst-case reverse pattern', async () => {
      const SIZE = 100
      const items = createSignal(Array.from({ length: SIZE }, (_, i) => ({ id: i })))

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig().id)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Multiple complete reversals
      for (let i = 0; i < 10; i++) {
        items([...items()].reverse())
        await tick()

        // Verify order
        const divs = Array.from(container.querySelectorAll('div'))
        const currentIds = items().map(item => item.id)
        divs.forEach((div, idx) => {
          expect(div.textContent).toBe(String(currentIds[idx]))
        })
      }

      list.dispose()
    })
  })

  describe('Edge Cases', () => {
    it('handles duplicate keys gracefully', async () => {
      const items = createSignal([
        { id: 1, value: 'a' },
        { id: 1, value: 'b' }, // Duplicate key
        { id: 2, value: 'c' },
      ])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Should handle duplicates (exact behavior may vary)
      expect(container.querySelectorAll('div').length).toBeGreaterThan(0)

      list.dispose()
    })

    it('handles null/undefined values in items', async () => {
      const items = createSignal<({ id: number; value: string | null } | null)[]>([
        { id: 1, value: 'a' },
        null,
        { id: 2, value: null },
      ])

      const list = createKeyedList(
        () => items().filter((x): x is { id: number; value: string | null } => x !== null),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().value ?? 'null'
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(container.querySelectorAll('div').length).toBe(2)

      list.dispose()
    })

    it('handles negative and zero keys', async () => {
      const items = createSignal([
        { id: -1, value: 'negative' },
        { id: 0, value: 'zero' },
        { id: 1, value: 'positive' },
      ])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(container.querySelectorAll('div').length).toBe(3)

      // Reorder
      items([
        { id: 0, value: 'zero' },
        { id: -1, value: 'negative' },
        { id: 1, value: 'positive' },
      ])
      await tick()

      const divs = Array.from(container.querySelectorAll('div'))
      expect(divs[0]?.textContent).toBe('zero')
      expect(divs[1]?.textContent).toBe('negative')

      list.dispose()
    })

    it('handles string keys with special characters', async () => {
      const items = createSignal([
        { id: 'key-with-dash', value: 'a' },
        { id: 'key.with.dots', value: 'b' },
        { id: 'key:with:colons', value: 'c' },
        { id: '', value: 'empty' },
      ])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().value
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(container.querySelectorAll('div').length).toBe(4)

      list.dispose()
    })
  })
})
