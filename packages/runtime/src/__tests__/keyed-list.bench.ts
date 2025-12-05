// @vitest-environment jsdom

import { bench, describe } from 'vitest'

import { createList } from '../binding'
import { createElement } from '../dom'
import { createKeyedList } from '../list-helpers'
import { createSignal, type Signal } from '../signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

interface Item {
  id: number
  name: string
  value: number
}

function generateItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    value: Math.random() * 100,
  }))
}

describe('Keyed List Performance Benchmarks', () => {
  describe('Initial Render (1000 items)', () => {
    bench('keyed list - initial render', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - initial render', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      listBinding.dispose()
    })
  })

  describe('Prepend Item (to 1000 items)', () => {
    bench('keyed list - prepend', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Prepend new item
      items([{ id: -1, name: 'Prepended', value: 0 }, ...items()])
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - prepend', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Prepend new item
      items([{ id: -1, name: 'Prepended', value: 0 }, ...items()])
      await tick()

      listBinding.dispose()
    })
  })

  describe('Append Item (to 1000 items)', () => {
    bench('keyed list - append', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Append new item
      items([...items(), { id: 1000, name: 'Appended', value: 0 }])
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - append', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Append new item
      items([...items(), { id: 1000, name: 'Appended', value: 0 }])
      await tick()

      listBinding.dispose()
    })
  })

  describe('Remove Item (from middle of 1000 items)', () => {
    bench('keyed list - remove middle', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Remove middle item
      items(items().filter(item => item.id !== 500))
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - remove middle', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Remove middle item
      items(items().filter(item => item.id !== 500))
      await tick()

      listBinding.dispose()
    })
  })

  describe('Reorder/Swap Items (1000 items)', () => {
    bench('keyed list - reverse order', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Reverse order
      items([...items()].reverse())
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - reverse order', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(1000))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Reverse order
      items([...items()].reverse())
      await tick()

      listBinding.dispose()
    })
  })

  describe('Update Item Properties (100 items)', () => {
    bench('keyed list - update all properties', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(100))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          const span = document.createElement('span')

          // Reactive update
          const updateEffect = () => {
            span.textContent = `${itemSig().name}: ${itemSig().value.toFixed(2)}`
          }
          updateEffect()

          li.appendChild(span)
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Update all item properties
      items(
        items().map(item => ({
          ...item,
          name: `Updated ${item.name}`,
          value: item.value + 10,
        })),
      )
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - update all properties', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(100))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          const span = document.createElement('span')

          // Static content (non-keyed list recreates on update)
          span.textContent = `${item.name}: ${item.value.toFixed(2)}`

          li.appendChild(span)
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Update all item properties
      items(
        items().map(item => ({
          ...item,
          name: `Updated ${item.name}`,
          value: item.value + 10,
        })),
      )
      await tick()

      listBinding.dispose()
    })
  })

  describe('Mixed Operations (500 items)', () => {
    bench('keyed list - mixed operations', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(500))

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig: Signal<Item>, _indexSig: Signal<number>) => {
          const li = document.createElement('li')
          li.textContent = itemSig().name
          return [li]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Mixed: prepend, remove, append
      let current = items()
      current = [{ id: -1, name: 'Prepended', value: 0 }, ...current]
      current = current.filter(item => item.id !== 250)
      current = [...current, { id: 501, name: 'Appended', value: 0 }]
      items(current)
      await tick()

      listBinding.dispose()
    })

    bench('non-keyed list - mixed operations', async () => {
      const container = document.createElement('div')
      const items = createSignal(generateItems(500))

      const listBinding = createList(
        () => items(),
        item => {
          const li = document.createElement('li')
          li.textContent = item.name
          return li
        },
        createElement,
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Mixed: prepend, remove, append
      let current = items()
      current = [{ id: -1, name: 'Prepended', value: 0 }, ...current]
      current = current.filter(item => item.id !== 250)
      current = [...current, { id: 501, name: 'Appended', value: 0 }]
      items(current)
      await tick()

      listBinding.dispose()
    })
  })
})
