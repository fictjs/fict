import { describe, it, expect, beforeEach } from 'vitest'

import {
  moveNodesBefore,
  removeNodes,
  insertNodesBefore,
  moveMarkerBlock,
  destroyMarkerBlock,
  createKeyedListContainer,
  createKeyedBlock,
  createKeyedList,
  toNodeArray,
  getFirstNodeAfter,
  isNodeBetweenMarkers,
} from '../list-helpers'
import { createSignal } from '../signal'
import { createEffect } from '../effect'
import { createRootContext, flushOnMount, onDestroy, popRoot, pushRoot } from '../lifecycle'

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

    it('moveMarkerBlock repositions marker ranges without recreating nodes', () => {
      const before = document.createElement('div')
      before.textContent = 'before'
      const after = document.createElement('div')
      after.textContent = 'after'
      const start = document.createComment('start')
      const child = document.createElement('span')
      child.textContent = 'X'
      const end = document.createComment('end')

      container.append(before, start, child, end, after)

      moveMarkerBlock(container, { start, end }, before)

      expect(container.firstChild).toBe(start)
      expect(container.childNodes[1]).toBe(child)
      expect(container.childNodes[2]).toBe(end)
    })

    it('destroyMarkerBlock removes nodes and flushes root', () => {
      const start = document.createComment('start')
      const text = document.createTextNode('payload')
      const end = document.createComment('end')
      container.append(start, text, end)

      const root = createRootContext()
      const prev = pushRoot(root)
      let destroyed = 0
      onDestroy(() => {
        destroyed++
      })
      popRoot(prev)
      flushOnMount(root)

      destroyMarkerBlock({ start, end, root })

      expect(container.contains(text)).toBe(false)
      expect(container.contains(start)).toBe(false)
      expect(container.contains(end)).toBe(false)
      expect(destroyed).toBe(1)
    })
  })

  describe('KeyedListContainer', () => {
    it('creates container with markers', () => {
      const listContainer = createKeyedListContainer()

      expect(listContainer.startMarker).toBeInstanceOf(Comment)
      expect(listContainer.endMarker).toBeInstanceOf(Comment)
      expect(listContainer.blocks).toBeInstanceOf(Map)
      expect(typeof listContainer.dispose).toBe('function')
    })

    it('dispose cleans up all blocks', () => {
      const listContainer = createKeyedListContainer<{ id: number; name: string }>()

      container.appendChild(listContainer.startMarker)
      container.appendChild(listContainer.endMarker)

      // Create some blocks
      const block1 = createKeyedBlock(1, { id: 1, name: 'Alice' }, 0, (itemSig, indexSig) => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        container.insertBefore(div, listContainer.endMarker)
        return [div]
      })

      const block2 = createKeyedBlock(2, { id: 2, name: 'Bob' }, 1, (itemSig, indexSig) => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        container.insertBefore(div, listContainer.endMarker)
        return [div]
      })

      listContainer.blocks.set(1, block1)
      listContainer.blocks.set(2, block2)

      expect(container.children.length).toBe(2)

      // Dispose
      listContainer.dispose()

      expect(listContainer.blocks.size).toBe(0)
      expect(container.children.length).toBe(0)
    })
  })

  describe('createKeyedBlock', () => {
    it('creates block with signals and nodes', async () => {
      const block = createKeyedBlock('key1', { id: 1, name: 'Alice' }, 0, (itemSig, indexSig) => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = `${itemSig().name}-${indexSig()}`
        })
        return [div]
      })

      expect(block.key).toBe('key1')
      expect(block.nodes.length).toBe(1)
      expect(block.nodes[0]).toBeInstanceOf(HTMLDivElement)
      expect((block.nodes[0] as HTMLDivElement).textContent).toBe('Alice-0')

      // Update signals
      block.item({ id: 1, name: 'Bob' })
      block.index(5)
      await tick()

      expect((block.nodes[0] as HTMLDivElement).textContent).toBe('Bob-5')
    })

    it('supports multiple nodes in a block', () => {
      const block = createKeyedBlock('key1', { id: 1, name: 'Alice' }, 0, (itemSig, indexSig) => {
        const div1 = document.createElement('div')
        const div2 = document.createElement('div')

        createEffect(() => {
          div1.textContent = itemSig().name
          div2.textContent = String(indexSig())
        })

        return [div1, div2]
      })

      expect(block.nodes.length).toBe(2)
      expect((block.nodes[0] as HTMLDivElement).textContent).toBe('Alice')
      expect((block.nodes[1] as HTMLDivElement).textContent).toBe('0')
    })

    it('bumps version when assigning same reference', async () => {
      const user = { id: 1, name: 'Alice' }
      const block = createKeyedBlock('key1', user, 0, itemSig => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        return [div]
      })

      const div = block.nodes[0] as HTMLDivElement
      expect(div.textContent).toBe('Alice')

      user.name = 'Carol'
      block.item(user)
      await tick()

      expect(div.textContent).toBe('Carol')
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

    it('getFirstNodeAfter returns next sibling', () => {
      const marker = document.createComment('marker')
      const div = document.createElement('div')

      container.appendChild(marker)
      container.appendChild(div)

      expect(getFirstNodeAfter(marker)).toBe(div)
    })

    it('getFirstNodeAfter returns null if no sibling', () => {
      const marker = document.createComment('marker')
      container.appendChild(marker)

      expect(getFirstNodeAfter(marker)).toBe(null)
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
        (itemSig, indexSig) => {
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

      let destroyCount = 0

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().name
          })
          // Track cleanup
          return [div]
        },
      )

      container.appendChild(listBinding.marker)

      await tick()

      expect(container.children.length).toBe(2)

      // Dispose
      listBinding.dispose()

      expect(container.children.length).toBe(0)
    })
  })
})
