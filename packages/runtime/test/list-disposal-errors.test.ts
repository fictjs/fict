import { describe, expect, it } from 'vitest'

import { batch, createEffect, onCleanup, onDestroy } from '../src/index'
import { createSignal } from '../src/advanced'
import { createKeyedList } from '../src/list-helpers'

describe('keyed list disposal errors', () => {
  it('removes all rows and stops every row effect when one destroy callback throws', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const source = createSignal(0)
    const calls: number[] = []
    let runs = 0
    const failure = new Error('row cleanup failed')
    const list = createKeyedList(
      () => [1, 2, 3],
      item => item,
      item => {
        const id = item()
        const node = document.createElement('span')
        createEffect(() => {
          source()
          runs++
          node.textContent = String(id)
        })
        onDestroy(() => {
          calls.push(id)
          if (id === 1) throw failure
        })
        return node
      },
    )
    container.append(list.marker)
    list.flush?.()

    try {
      expect(runs).toBe(3)
      expect(() => list.dispose()).toThrow(failure)
      expect(calls).toEqual([1, 2, 3])
      expect(container.childNodes).toHaveLength(0)
      batch(() => source(1))
      expect(runs).toBe(3)
      expect(() => list.dispose()).not.toThrow()
    } finally {
      list.dispose()
      container.remove()
    }
  })

  it.each([{ nextItems: [] }, { nextItems: [3, 4] }])(
    'commits removal and can update again after a cleanup error ($nextItems)',
    ({ nextItems }) => {
      const container = document.createElement('div')
      document.body.append(container)
      const items = createSignal([1, 2, 3])
      const source = createSignal(0)
      const destroyed: number[] = []
      const runs = new Map<number, number>()
      const failure = new Error('row cleanup failed')
      const list = createKeyedList(
        items,
        id => id,
        item => {
          const id = item()
          const node = document.createElement('span')
          createEffect(() => {
            source()
            runs.set(id, (runs.get(id) ?? 0) + 1)
            node.textContent = String(id)
          })
          onDestroy(() => {
            destroyed.push(id)
            if (id === 1) throw failure
          })
          return node
        },
      )
      container.append(list.marker)
      list.flush?.()
      try {
        expect(() => batch(() => items(nextItems))).toThrow(failure)
        expect(container.textContent).toBe(nextItems.join(''))
        expect(destroyed).toEqual(nextItems.length ? [1, 2] : [1, 2, 3])
        batch(() => source(1))
        expect(runs.get(1)).toBe(1)
        expect(runs.get(2)).toBe(1)
        batch(() => items([5]))
        expect(container.textContent).toBe('5')
      } finally {
        list.dispose()
        container.remove()
      }
    },
  )

  it('still disposes row roots when the list effect cleanup throws', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const failure = new Error('list effect cleanup failed')
    const destroyed: number[] = []
    const list = createKeyedList(
      () => {
        onCleanup(() => {
          throw failure
        })
        return [1, 2]
      },
      id => id,
      item => {
        const id = item()
        onDestroy(() => {
          destroyed.push(id)
        })
        return document.createElement('span')
      },
    )
    container.append(list.marker)
    list.flush?.()
    try {
      expect(() => list.dispose()).toThrow(failure)
      expect(destroyed).toEqual([1, 2])
      expect(container.childNodes).toHaveLength(0)
    } finally {
      list.dispose()
      container.remove()
    }
  })

  it('allows a row cleanup to dispose the enclosing list during removal', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const items = createSignal([1, 2, 3])
    const destroyed: number[] = []
    const list = createKeyedList(
      items,
      id => id,
      item => {
        const id = item()
        onDestroy(() => {
          destroyed.push(id)
          if (id === 1) list.dispose()
        })
        return document.createElement('span')
      },
    )
    container.append(list.marker)
    list.flush?.()
    try {
      expect(() => batch(() => items([3, 4]))).not.toThrow()
      expect(destroyed.sort()).toEqual([1, 2, 3, 4])
      expect(container.childNodes).toHaveLength(0)
    } finally {
      list.dispose()
      container.remove()
    }
  })
})
