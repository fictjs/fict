import { describe, expect, it } from 'vitest'

import { batch, createEffect, onDestroy } from '../src/index'
import { createSignal } from '../src/advanced'
import { createKeyedList } from '../src/list-helpers'
import { withHydration } from '../src/hydration'
import { __fictEnterHydration, __fictExitHydration } from '../src/resume'

describe('keyed list update rollback', () => {
  it('releases earlier blocks when initial hydration fails partway through', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const destroyed: number[] = []
    const failure = new Error('hydration render failed')
    __fictEnterHydration()
    const list = createKeyedList(
      () => [1, 2],
      id => id,
      item => {
        const id = item()
        onDestroy(() => {
          destroyed.push(id)
        })
        if (id === 2) throw failure
        return document.createElement('span')
      },
    )
    host.append(list.marker)
    try {
      expect(() => withHydration(host, () => list.flush?.())).toThrow(failure)
      expect(destroyed.sort()).toEqual([1, 2])
    } finally {
      __fictExitHydration()
      list.dispose()
      host.remove()
    }
  })
  it.each(['key', 'render'])(
    'releases staged blocks and preserves retained rows after a %s failure',
    phase => {
      const host = document.createElement('div')
      document.body.append(host)
      const items = createSignal([1, 2])
      const source = createSignal(0)
      const runs = new Map<number, number>()
      const destroyed: number[] = []
      const failure = new Error('rejected row')
      const list = createKeyedList(
        items,
        id => {
          if (phase === 'key' && id === 4) throw failure
          return id
        },
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
          })
          if (phase === 'render' && id === 4) throw failure
          return node
        },
      )
      host.append(list.marker)
      list.flush?.()
      const first = host.querySelector('span')
      try {
        expect(() => batch(() => items([1, 3, 4]))).toThrow(failure)
        expect(host.textContent).toBe('12')
        expect(destroyed).toContain(3)
        batch(() => source(1))
        expect(runs.get(3)).toBe(1)
        batch(() => items([1, 5]))
        expect(host.textContent).toBe('15')
        expect(host.querySelector('span')).toBe(first)
      } finally {
        list.dispose()
        host.remove()
      }
    },
  )
})
