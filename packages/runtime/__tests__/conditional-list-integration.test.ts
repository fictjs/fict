import { describe, it, expect, beforeEach } from 'vitest'

import { createConditional } from '../src/binding'
import { createElement } from '../src/dom'
import { createEffect } from '../src/effect'
import { createKeyedList } from '../src/list-helpers'
import { createSignal } from '../src/signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Conditional + Keyed List Integration', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('renders list conditionally with show flag', async () => {
    interface Item {
      id: number
      name: string
    }

    const show = createSignal(true)
    const items = createSignal<Item[]>([
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
    ])

    // Conditional wrapper around list
    const conditionalBinding = createConditional(
      () => show(),
      () => {
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // List should be visible
    const ul = container.querySelector('ul')
    expect(ul).toBeTruthy()
    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(2)
    expect(listItems[0]!.textContent).toBe('Apple')

    // Hide list
    show(false)
    await tick()

    expect(container.querySelector('ul')).toBeNull()
    expect(container.querySelectorAll('li').length).toBe(0)

    // Show list again
    show(true)
    await tick()

    const newListItems = container.querySelectorAll('li')
    expect(newListItems.length).toBe(2)
    expect(newListItems[0]!.textContent).toBe('Apple')

    conditionalBinding.dispose()
  })

  it('updates list items while conditional is true', async () => {
    interface Item {
      id: number
      name: string
    }

    const show = createSignal(true)
    const items = createSignal<Item[]>([
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
    ])

    const conditionalBinding = createConditional(
      () => show(),
      () => {
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // Update items while visible
    items([
      { id: 2, name: 'Banana' },
      { id: 1, name: 'Red Apple' }, // Updated
      { id: 3, name: 'Orange' }, // New
    ])
    await tick()

    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(3)
    expect(listItems[0]!.textContent).toBe('Banana')
    expect(listItems[1]!.textContent).toBe('Red Apple')
    expect(listItems[2]!.textContent).toBe('Orange')

    conditionalBinding.dispose()
  })

  it('handles conditional with fallback (ternary)', async () => {
    interface Item {
      id: number
      name: string
    }

    const hasItems = createSignal(true)
    const items = createSignal<Item[]>([
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
    ])

    const conditionalBinding = createConditional(
      () => hasItems(),
      () => {
        // True branch: show list
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
      () => {
        // False branch: show empty message
        const p = document.createElement('p')
        p.textContent = 'No items available'
        return p
      },
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // Should show list
    expect(container.querySelector('ul')).toBeTruthy()
    expect(container.querySelector('p')).toBeNull()

    // Switch to fallback
    hasItems(false)
    await tick()

    expect(container.querySelector('ul')).toBeNull()
    expect(container.querySelector('p')).toBeTruthy()
    expect(container.querySelector('p')!.textContent).toBe('No items available')

    // Switch back to list
    hasItems(true)
    await tick()

    expect(container.querySelector('ul')).toBeTruthy()
    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(2)

    conditionalBinding.dispose()
  })

  it('handles list inside conditional that toggles rapidly', async () => {
    interface Item {
      id: number
      name: string
    }

    const show = createSignal(true)
    const items = createSignal<Item[]>([{ id: 1, name: 'Apple' }])

    const conditionalBinding = createConditional(
      () => show(),
      () => {
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // Rapid toggles
    show(false)
    await tick()
    show(true)
    await tick()
    show(false)
    await tick()
    show(true)
    await tick()

    // Should be visible and stable
    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(1)
    expect(listItems[0]!.textContent).toBe('Apple')

    conditionalBinding.dispose()
  })

  it('preserves list state across conditional show/hide', async () => {
    interface Item {
      id: number
      name: string
    }

    const show = createSignal(true)
    const items = createSignal<Item[]>([
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
    ])

    const conditionalBinding = createConditional(
      () => show(),
      () => {
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // Update items
    items([
      { id: 2, name: 'Banana' },
      { id: 3, name: 'Orange' },
    ])
    await tick()

    expect(container.querySelectorAll('li').length).toBe(2)

    // Hide
    show(false)
    await tick()
    expect(container.querySelectorAll('li').length).toBe(0)

    // Update items while hidden
    items([
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
      { id: 3, name: 'Orange' },
    ])
    await tick()

    // Show again - should reflect latest state
    show(true)
    await tick()

    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(3)
    expect(listItems[0]!.textContent).toBe('Apple')
    expect(listItems[1]!.textContent).toBe('Banana')
    expect(listItems[2]!.textContent).toBe('Orange')

    conditionalBinding.dispose()
  })

  it('handles empty list in conditional', async () => {
    interface Item {
      id: number
      name: string
    }

    const show = createSignal(true)
    const items = createSignal<Item[]>([])

    const conditionalBinding = createConditional(
      () => show(),
      () => {
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

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)

        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    // Empty list should still render container
    expect(container.querySelector('ul')).toBeTruthy()
    expect(container.querySelectorAll('li').length).toBe(0)

    // Add items
    items([{ id: 1, name: 'Apple' }])
    await tick()

    expect(container.querySelectorAll('li').length).toBe(1)

    conditionalBinding.dispose()
  })
})
