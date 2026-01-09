import { describe, it, expect, beforeEach } from 'vitest'

import { createEffect } from '../src/effect'
import { onMount } from '../src/lifecycle'
import {
  moveNodesBefore,
  removeNodes,
  insertNodesBefore,
  createKeyedList,
  toNodeArray,
  isNodeBetweenMarkers,
} from '../src/list-helpers'
import { createSignal } from '../src/signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('List Helpers', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  describe('DOM Manipulation', () => {
    it('moveNodesBefore moves nodes to correct position', () => {
      const div1 = document.createElement('div')
      div1.textContent = '1'
      const div2 = document.createElement('div')
      div2.textContent = '2'
      const div3 = document.createElement('div')
      div3.textContent = '3'

      container.appendChild(div1)
      container.appendChild(div2)
      container.appendChild(div3)

      expect(container.textContent).toBe('123')

      // Move div3 before div1
      moveNodesBefore(container, [div3], div1)
      expect(container.textContent).toBe('312')

      // Move div1 to the end
      moveNodesBefore(container, [div1], null)
      expect(container.textContent).toBe('321')
    })

    it('moveNodesBefore handles multiple nodes', () => {
      const div1 = document.createElement('div')
      div1.textContent = '1'
      const div2 = document.createElement('div')
      div2.textContent = '2'
      const div3 = document.createElement('div')
      div3.textContent = '3'

      container.appendChild(div1)
      container.appendChild(div2)
      container.appendChild(div3)

      // Move div2 and div3 before div1
      moveNodesBefore(container, [div2, div3], div1)
      expect(container.textContent).toBe('231')
    })

    it('moveNodesBefore skips if already in position', () => {
      const div1 = document.createElement('div')
      const div2 = document.createElement('div')
      container.appendChild(div1)
      container.appendChild(div2)

      // Try to move div1 before div2 (already in position)
      moveNodesBefore(container, [div1], div2)

      // Should not cause any DOM mutations
      expect(container.children[0]).toBe(div1)
      expect(container.children[1]).toBe(div2)
    })

    it('removeNodes removes all nodes from DOM', () => {
      const div1 = document.createElement('div')
      const div2 = document.createElement('div')
      container.appendChild(div1)
      container.appendChild(div2)

      expect(container.children.length).toBe(2)

      removeNodes([div1, div2])

      expect(container.children.length).toBe(0)
      expect(div1.parentNode).toBe(null)
      expect(div2.parentNode).toBe(null)
    })

    it('insertNodesBefore inserts nodes at correct position', () => {
      const anchor = document.createElement('div')
      anchor.textContent = 'anchor'
      container.appendChild(anchor)

      const div1 = document.createElement('div')
      div1.textContent = '1'
      const div2 = document.createElement('div')
      div2.textContent = '2'

      insertNodesBefore(container, [div1, div2], anchor)

      expect(container.textContent).toBe('12anchor')
    })
  })

  describe('Utilities', () => {
    it('toNodeArray converts single node', () => {
      const div = document.createElement('div')
      const result = toNodeArray(div)

      expect(result).toEqual([div])
    })

    it('toNodeArray returns array as-is', () => {
      const div1 = document.createElement('div')
      const div2 = document.createElement('div')
      const array = [div1, div2]

      const result = toNodeArray(array)

      expect(result).toBe(array)
    })

    it('toNodeArray converts DocumentFragment to array', () => {
      const frag = document.createDocumentFragment()
      const div1 = document.createElement('div')
      const div2 = document.createElement('div')
      frag.appendChild(div1)
      frag.appendChild(div2)

      const result = toNodeArray(frag)

      expect(result).toEqual([div1, div2])
    })

    it('isNodeBetweenMarkers detects node between markers', () => {
      const startMarker = document.createComment('start')
      const div1 = document.createElement('div')
      const div2 = document.createElement('div')
      const endMarker = document.createComment('end')

      container.appendChild(startMarker)
      container.appendChild(div1)
      container.appendChild(div2)
      container.appendChild(endMarker)

      expect(isNodeBetweenMarkers(div1, startMarker, endMarker)).toBe(true)
      expect(isNodeBetweenMarkers(div2, startMarker, endMarker)).toBe(true)
      expect(isNodeBetweenMarkers(startMarker, startMarker, endMarker)).toBe(false)
      expect(isNodeBetweenMarkers(endMarker, startMarker, endMarker)).toBe(false)
    })
  })

  describe('createKeyedList', () => {
    it('creates list with initial items', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe('Alice-0')
      expect(container.children[1].textContent).toBe('Bob-1')
    })

    it('updates items reactively', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      // Update item content
      items([
        { id: 1, name: 'Alice Updated' },
        { id: 2, name: 'Bob' },
      ])

      await tick()

      expect(container.children[0].textContent).toBe('Alice Updated-0')
      expect(container.children[1].textContent).toBe('Bob-1')
    })

    it('adds new items', async () => {
      const items = createSignal([{ id: 1, name: 'Alice' }])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      expect(container.children.length).toBe(1)

      // Add new item
      items([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      await tick()

      expect(container.children.length).toBe(2)
      expect(container.children[1].textContent).toBe('Bob-1')
    })

    it('removes items', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      expect(container.children.length).toBe(2)

      // Remove first item
      items([{ id: 2, name: 'Bob' }])

      await tick()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe('Bob-0')
    })

    it('reorders items correctly', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Charlie' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      const firstChild = container.children[0]
      const secondChild = container.children[1]
      const thirdChild = container.children[2]

      // Reverse order
      items([
        { id: 3, name: 'Charlie' },
        { id: 2, name: 'Bob' },
        { id: 1, name: 'Alice' },
      ])

      await tick()

      // Same DOM nodes, reordered
      expect(container.children[0]).toBe(thirdChild)
      expect(container.children[1]).toBe(secondChild)
      expect(container.children[2]).toBe(firstChild)

      // Content and indices updated
      expect(container.children[0].textContent).toBe('Charlie-0')
      expect(container.children[1].textContent).toBe('Bob-1')
      expect(container.children[2].textContent).toBe('Alice-2')
    })

    it('preserves DOM nodes during reorder', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = `${itemSig().name}-${indexSig()}`
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      const firstNode = container.children[0]
      const secondNode = container.children[1]

      // Swap order
      items([
        { id: 2, name: 'Bob' },
        { id: 1, name: 'Alice' },
      ])

      await tick()

      // Nodes are preserved, just moved
      expect(container.children[0]).toBe(secondNode)
      expect(container.children[1]).toBe(firstNode)
    })

    it('handles multiple nodes per item', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice', desc: 'Engineer' },
        { id: 2, name: 'Bob', desc: 'Designer' },
      ])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const dt = document.createElement('dt')
          const dd = document.createElement('dd')

          createEffect(() => {
            dt.textContent = itemSig().name
            dd.textContent = itemSig().desc
          })

          return [dt, dd]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      expect(container.children.length).toBe(4) // 2 items * 2 nodes each
      expect(container.children[0].textContent).toBe('Alice')
      expect(container.children[1].textContent).toBe('Engineer')
      expect(container.children[2].textContent).toBe('Bob')
      expect(container.children[3].textContent).toBe('Designer')
    })

    it('cleans up on dispose', async () => {
      const items = createSignal([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const _destroyCount = 0

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().name
          })
          // Track cleanup
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      listBinding.flush?.()

      await tick()

      expect(container.children.length).toBe(2)

      // Dispose
      listBinding.dispose()

      expect(container.children.length).toBe(0)
    })

    it('defers keyed list diffing until markers are mounted', async () => {
      const calls: number[] = []
      const items = createSignal([1, 2, 3])

      const list = createKeyedList(
        () => {
          calls.push(1)
          return items()
        },
        item => item,
        itemSig => {
          const text = document.createTextNode('')
          createEffect(() => {
            text.textContent = String(itemSig())
          })
          return [text]
        },
      )

      expect(calls.length).toBe(0)

      container.appendChild(list.marker)
      list.flush?.()
      await tick()
      expect(calls.length).toBe(1)

      items([3, 4])
      await tick()
      expect(calls.length).toBe(2)

      list.dispose()
    })

    it('runs keyed block onMount after DOM insertion', async () => {
      const mounts: boolean[] = []
      const items = createSignal([{ id: 1 }])

      const list = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const div = document.createElement('div')
          onMount(() => {
            mounts.push(div.isConnected)
          })
          createEffect(() => {
            div.textContent = String(itemSig().id)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      list.flush?.()
      await tick()

      expect(mounts).toEqual([true])

      list.dispose()
    })
  })
})
