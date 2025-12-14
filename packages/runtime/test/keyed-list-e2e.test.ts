import { describe, it, expect, beforeEach } from 'vitest'

import { createEffect } from '../src/effect'
import { createKeyedList } from '../src/list-helpers'
import { createSignal } from '../src/signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Keyed List E2E', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('complete workflow: create, update, reorder, add, remove', async () => {
    interface Todo {
      id: number
      text: string
    }

    const todos = createSignal<Todo[]>([
      { id: 1, text: 'wake up' },
      { id: 2, text: 'hydrate' },
      { id: 3, text: 'ship code' },
    ])

    const listBinding = createKeyedList(
      () => todos(),
      todo => todo.id,
      (todoSig, _indexSig) => {
        const li = document.createElement('li')
        li.setAttribute('data-id', String(todoSig().id))

        const span = document.createElement('span')
        span.className = 'text'

        createEffect(() => {
          span.textContent = todoSig().text
        })

        li.appendChild(span)
        return [li]
      },
    )

    container.appendChild(listBinding.marker)

    await tick()

    const readIds = () =>
      Array.from(container.querySelectorAll('li')).map(li => Number(li.getAttribute('data-id')))

    const readTexts = () =>
      Array.from(container.querySelectorAll('li')).map(li => li.textContent?.trim())

    // Initial render
    expect(readIds()).toEqual([1, 2, 3])
    expect(readTexts()).toEqual(['wake up', 'hydrate', 'ship code'])

    // Test reorder (rotate)
    todos([
      { id: 2, text: 'hydrate' },
      { id: 3, text: 'ship code' },
      { id: 1, text: 'wake up' },
    ])

    await tick()

    expect(readIds()).toEqual([2, 3, 1])
    expect(readTexts()).toEqual(['hydrate', 'ship code', 'wake up'])

    // Test add (prepend)
    todos([
      { id: 0, text: 'stretch' },
      { id: 2, text: 'hydrate' },
      { id: 3, text: 'ship code' },
      { id: 1, text: 'wake up' },
    ])

    await tick()

    expect(readIds()).toEqual([0, 2, 3, 1])
    expect(readTexts()[0]).toBe('stretch')

    // Test remove (drop second)
    todos([
      { id: 0, text: 'stretch' },
      { id: 3, text: 'ship code' },
      { id: 1, text: 'wake up' },
    ])

    await tick()

    expect(readIds()).toEqual([0, 3, 1])

    // Verify final state
    expect(readIds()).toEqual([0, 3, 1])
    expect(readTexts()).toEqual(['stretch', 'ship code', 'wake up'])

    // Clean up
    listBinding.dispose()
  })

  it('preserves DOM nodes during reorder', async () => {
    const items = createSignal([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Charlie' },
    ])

    const listBinding = createKeyedList(
      () => items(),
      item => item.id,
      itemSig => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        return [div]
      },
    )

    container.appendChild(listBinding.marker)

    await tick()

    // Save references to DOM nodes
    const firstNode = container.children[0]
    const secondNode = container.children[1]
    const thirdNode = container.children[2]

    // Reverse order
    items([
      { id: 3, name: 'Charlie' },
      { id: 2, name: 'Bob' },
      { id: 1, name: 'Alice' },
    ])

    await tick()

    // Check that DOM nodes are the same objects, just reordered
    expect(container.children[0]).toBe(thirdNode)
    expect(container.children[1]).toBe(secondNode)
    expect(container.children[2]).toBe(firstNode)

    listBinding.dispose()
  })

  it('updates item properties', async () => {
    const items = createSignal([{ id: 1, name: 'Alice' }])

    const listBinding = createKeyedList(
      () => items(),
      item => item.id,
      itemSig => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        return [div]
      },
    )

    container.appendChild(listBinding.marker)

    await tick()

    expect(container.children[0].textContent).toBe('Alice')

    // Update the name property
    items([{ id: 1, name: 'Bob' }])

    await tick()

    expect(container.children[0].textContent).toBe('Bob')

    listBinding.dispose()
  })

  it('handles empty list', async () => {
    const items = createSignal<{ id: number; name: string }[]>([])

    const listBinding = createKeyedList(
      () => items(),
      item => item.id,
      itemSig => {
        const div = document.createElement('div')
        createEffect(() => {
          div.textContent = itemSig().name
        })
        return [div]
      },
    )

    container.appendChild(listBinding.marker)

    await tick()

    expect(container.children.length).toBe(0)

    // Add items to empty list
    items([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])

    await tick()

    expect(container.children.length).toBe(2)

    // Clear list
    items([])

    await tick()

    expect(container.children.length).toBe(0)

    listBinding.dispose()
  })
})
