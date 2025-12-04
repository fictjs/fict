import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createSignal } from '../signal'
import { createKeyedList } from '../list-helpers'
import { createEffect } from '../effect'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Keyed List Edge Cases', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  describe('Duplicate Keys', () => {
    it('handles duplicate keys by using last occurrence (Map behavior)', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
        { id: 1, name: 'Duplicate' }, // Same id as first
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          li.setAttribute('data-id', String(itemSig().id))
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      // Only 2 items because duplicate key overwrites in Map
      expect(listItems.length).toBe(2)

      // Last item with key=1 wins (Duplicate), plus key=2
      expect(listItems[0]!.textContent).toBe('Duplicate')
      expect(listItems[1]!.textContent).toBe('Second')

      listBinding.dispose()
    })

    it('handles all items having the same key (only last item rendered)', async () => {
      interface Item {
        id: number
        value: string
      }

      const items = createSignal<Item[]>([
        { id: 1, value: 'A' },
        { id: 1, value: 'B' },
        { id: 1, value: 'C' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().value
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      // Only 1 item because all have same key - last one wins
      expect(listItems.length).toBe(1)
      expect(listItems[0]!.textContent).toBe('C')

      // Update all items - still same key
      items([
        { id: 1, value: 'X' },
        { id: 1, value: 'Y' },
        { id: 1, value: 'Z' },
      ])
      await tick()

      const updatedItems = container.querySelectorAll('li')
      expect(updatedItems.length).toBe(1)
      expect(updatedItems[0]!.textContent).toBe('Z')

      listBinding.dispose()
    })
  })

  describe('Null and Undefined Keys', () => {
    it('handles items with null as key (Map treats as single key)', async () => {
      interface Item {
        id: number | null
        name: string
      }

      const items = createSignal<Item[]>([
        { id: null, name: 'Null Key 1' },
        { id: null, name: 'Null Key 2' },
        { id: 1, name: 'Valid Key' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id as any,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      // Only 2 items: last null key (Null Key 2) + valid key (Valid Key)
      expect(listItems.length).toBe(2)
      expect(listItems[0]!.textContent).toBe('Null Key 2')
      expect(listItems[1]!.textContent).toBe('Valid Key')

      listBinding.dispose()
    })

    it('handles items with undefined as key', async () => {
      interface Item {
        id: number | undefined
        name: string
      }

      const items = createSignal<Item[]>([
        { id: undefined, name: 'Undefined Key' },
        { id: 1, name: 'Valid Key' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(2)

      listBinding.dispose()
    })

    it('handles mix of null, undefined, and valid keys', async () => {
      interface Item {
        id: number | null | undefined
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Valid' },
        { id: null, name: 'Null' },
        { id: 2, name: 'Valid 2' },
        { id: undefined, name: 'Undefined' },
        { id: 3, name: 'Valid 3' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(5)

      // Update to remove null/undefined items
      items([
        { id: 1, name: 'Valid Updated' },
        { id: 2, name: 'Valid 2 Updated' },
        { id: 3, name: 'Valid 3 Updated' },
      ])
      await tick()

      const updatedItems = container.querySelectorAll('li')
      expect(updatedItems.length).toBe(3)
      expect(updatedItems[0]!.textContent).toBe('Valid Updated')

      listBinding.dispose()
    })
  })

  describe('Key Type Changes', () => {
    it('handles key changing from number to string', async () => {
      interface Item {
        id: number | string
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Number Key' },
        { id: 2, name: 'Number Key 2' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = `${itemSig().id}: ${itemSig().name}`
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(2)

      // Change keys to strings
      items([
        { id: '1', name: 'String Key' },
        { id: '2', name: 'String Key 2' },
      ])
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(2)
      expect(listItems[0]!.textContent).toBe('1: String Key')
      expect(listItems[1]!.textContent).toBe('2: String Key 2')

      listBinding.dispose()
    })

    it('handles mixed number and string keys', async () => {
      interface Item {
        id: number | string
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Number' },
        { id: '2', name: 'String' },
        { id: 3, name: 'Number 2' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(3)
      expect(listItems[0]!.textContent).toBe('Number')
      expect(listItems[1]!.textContent).toBe('String')
      expect(listItems[2]!.textContent).toBe('Number 2')

      listBinding.dispose()
    })
  })

  describe('Rapid Updates', () => {
    it('handles rapid consecutive updates', async () => {
      interface Item {
        id: number
        value: number
      }

      const items = createSignal<Item[]>([{ id: 1, value: 0 }])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = String(itemSig().value)
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      // Rapid updates
      for (let i = 1; i <= 10; i++) {
        items([{ id: 1, value: i }])
      }
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(1)
      expect(listItems[0]!.textContent).toBe('10')

      listBinding.dispose()
    })

    it('handles rapid add/remove cycles', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      // Rapid add/remove
      items([{ id: 1, name: 'Item 1' }])
      items([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ])
      items([{ id: 2, name: 'Item 2' }])
      items([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ])
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(2)
      expect(listItems[0]!.textContent).toBe('Item 1')
      expect(listItems[1]!.textContent).toBe('Item 2')

      listBinding.dispose()
    })

    it('handles synchronous batch updates', async () => {
      interface Item {
        id: number
        value: string
      }

      const items = createSignal<Item[]>([
        { id: 1, value: 'A' },
        { id: 2, value: 'B' },
        { id: 3, value: 'C' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().value
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      // Multiple operations in sync
      items([
        { id: 2, value: 'B' },
        { id: 3, value: 'C' },
        { id: 1, value: 'A' },
      ])
      items([
        { id: 3, value: 'C-updated' },
        { id: 1, value: 'A-updated' },
        { id: 2, value: 'B-updated' },
      ])
      items([
        { id: 1, value: 'Final-A' },
        { id: 2, value: 'Final-B' },
        { id: 3, value: 'Final-C' },
        { id: 4, value: 'Final-D' },
      ])
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(4)
      expect(listItems[0]!.textContent).toBe('Final-A')
      expect(listItems[1]!.textContent).toBe('Final-B')
      expect(listItems[2]!.textContent).toBe('Final-C')
      expect(listItems[3]!.textContent).toBe('Final-D')

      listBinding.dispose()
    })
  })

  describe('Large Scale Operations', () => {
    it('handles large lists (1000+ items)', async () => {
      interface Item {
        id: number
        value: number
      }

      const largeList = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        value: i * 2,
      }))
      const items = createSignal<Item[]>(largeList)

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          li.textContent = String(itemSig().value)
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(1000)

      // Remove half
      items(largeList.filter(item => item.id % 2 === 0))
      await tick()

      expect(container.querySelectorAll('li').length).toBe(500)

      listBinding.dispose()
    })

    it('handles massive reordering', async () => {
      interface Item {
        id: number
        value: number
      }

      const list = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        value: i,
      }))
      const items = createSignal<Item[]>(list)

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          li.setAttribute('data-id', String(itemSig().id))
          createEffect(() => {
            li.textContent = String(itemSig().value)
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const firstItem = container.querySelector('[data-id="0"]')
      const lastItem = container.querySelector('[data-id="99"]')

      // Reverse entire list
      items([...list].reverse())
      await tick()

      // Check that DOM nodes were reused
      expect(container.querySelector('[data-id="0"]')).toBe(firstItem)
      expect(container.querySelector('[data-id="99"]')).toBe(lastItem)

      // Check positions
      const listItems = container.querySelectorAll('li')
      expect(listItems[0]!.getAttribute('data-id')).toBe('99')
      expect(listItems[99]!.getAttribute('data-id')).toBe('0')

      listBinding.dispose()
    })
  })

  describe('Complex Mixed Operations', () => {
    it('handles simultaneous insert, update, delete, and reorder', async () => {
      interface Item {
        id: number
        name: string
        value: number
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'A', value: 10 },
        { id: 2, name: 'B', value: 20 },
        { id: 3, name: 'C', value: 30 },
        { id: 4, name: 'D', value: 40 },
        { id: 5, name: 'E', value: 50 },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          li.setAttribute('data-id', String(itemSig().id))
          createEffect(() => {
            li.textContent = `${itemSig().name}:${itemSig().value}`
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      // Complex operation:
      // - Remove id=2 (delete)
      // - Update id=3 name (update)
      // - Reorder: 5, 1, 3, 4 (reorder)
      // - Insert new id=6 (insert)
      items([
        { id: 5, name: 'E', value: 50 },
        { id: 1, name: 'A', value: 10 },
        { id: 3, name: 'C-UPDATED', value: 30 },
        { id: 4, name: 'D', value: 40 },
        { id: 6, name: 'F-NEW', value: 60 },
      ])
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(5)
      expect(listItems[0]!.getAttribute('data-id')).toBe('5')
      expect(listItems[1]!.getAttribute('data-id')).toBe('1')
      expect(listItems[2]!.getAttribute('data-id')).toBe('3')
      expect(listItems[2]!.textContent).toBe('C-UPDATED:30')
      expect(listItems[3]!.getAttribute('data-id')).toBe('4')
      expect(listItems[4]!.getAttribute('data-id')).toBe('6')
      expect(listItems[4]!.textContent).toBe('F-NEW:60')

      listBinding.dispose()
    })

    it('handles alternating pattern updates', async () => {
      interface Item {
        id: number
        odd: boolean
      }

      const items = createSignal<Item[]>(
        Array.from({ length: 10 }, (_, i) => ({
          id: i,
          odd: i % 2 === 1,
        })),
      )

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.className = itemSig().odd ? 'odd' : 'even'
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('.odd').length).toBe(5)
      expect(container.querySelectorAll('.even').length).toBe(5)

      // Remove all odd items
      items(items().filter(item => !item.odd))
      await tick()

      expect(container.querySelectorAll('.odd').length).toBe(0)
      expect(container.querySelectorAll('.even').length).toBe(5)

      listBinding.dispose()
    })
  })

  describe('Empty and Single Item Edge Cases', () => {
    it('handles transition from empty to single item', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(0)

      items([{ id: 1, name: 'Only Item' }])
      await tick()

      const listItems = container.querySelectorAll('li')
      expect(listItems.length).toBe(1)
      expect(listItems[0]!.textContent).toBe('Only Item')

      listBinding.dispose()
    })

    it('handles transition from single item to empty', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([{ id: 1, name: 'Only Item' }])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(1)

      items([])
      await tick()

      expect(container.querySelectorAll('li').length).toBe(0)

      listBinding.dispose()
    })

    it('handles repeated empty-to-single-to-empty cycles', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      for (let i = 0; i < 5; i++) {
        items([{ id: i, name: `Item ${i}` }])
        await tick()
        expect(container.querySelectorAll('li').length).toBe(1)

        items([])
        await tick()
        expect(container.querySelectorAll('li').length).toBe(0)
      }

      listBinding.dispose()
    })
  })

  describe('Memory and Cleanup', () => {
    it('properly removes DOM nodes when items are removed', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
        { id: 3, name: 'Item 3' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          li.setAttribute('data-id', String(itemSig().id))
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(3)

      // Save references to DOM nodes
      const node1 = container.querySelector('[data-id="1"]')
      const node2 = container.querySelector('[data-id="2"]')
      const node3 = container.querySelector('[data-id="3"]')

      expect(node1).toBeTruthy()
      expect(node2).toBeTruthy()
      expect(node3).toBeTruthy()

      // Remove all items
      items([])
      await tick()

      expect(container.querySelectorAll('li').length).toBe(0)

      // Verify nodes are removed from DOM
      expect(node1!.parentNode).toBeNull()
      expect(node2!.parentNode).toBeNull()
      expect(node3!.parentNode).toBeNull()

      listBinding.dispose()
    })

    it('cleans up DOM when list binding is disposed', async () => {
      interface Item {
        id: number
        name: string
      }

      const items = createSignal<Item[]>([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            li.textContent = itemSig().name
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      expect(container.querySelectorAll('li').length).toBe(2)

      const startMarkerParent = listBinding.startMarker.parentNode
      const endMarkerParent = listBinding.endMarker.parentNode

      listBinding.dispose()

      // After dispose, all nodes including markers should be removed
      expect(container.querySelectorAll('li').length).toBe(0)
      expect(listBinding.startMarker.parentNode).toBeNull()
      expect(listBinding.endMarker.parentNode).toBeNull()
    })

    it('properly handles effects cleanup through root context', async () => {
      interface Item {
        id: number
        value: number
      }

      const items = createSignal<Item[]>([
        { id: 1, value: 1 },
        { id: 2, value: 2 },
      ])

      let effectRunCount = 0

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const li = document.createElement('li')
          createEffect(() => {
            effectRunCount++
            li.textContent = String(itemSig().value)
          })
          return [li]
        },
      )

      container.appendChild(listBinding.startMarker)
      container.appendChild(listBinding.endMarker)
      await tick()

      const initialRunCount = effectRunCount
      expect(initialRunCount).toBe(2) // One effect per item

      // Update items - effects should run again
      items([
        { id: 1, value: 10 },
        { id: 2, value: 20 },
      ])
      await tick()

      expect(effectRunCount).toBe(4) // 2 initial + 2 updates

      // Remove one item
      items([{ id: 1, value: 10 }])
      await tick()

      const countAfterRemoval = effectRunCount

      // Update remaining item
      items([{ id: 1, value: 100 }])
      await tick()

      // Only the remaining item's effect should run
      expect(effectRunCount).toBe(countAfterRemoval + 1)

      listBinding.dispose()
    })
  })
})
