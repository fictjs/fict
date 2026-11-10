import { afterEach, expect, it, vi } from 'vitest'
import { batch, createEffect, createRoot } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

import { $store } from '../src/store'
import { resource } from '../src/resource'

afterEach(() => vi.restoreAllMocks())

it('does not subscribe an append-only writer to array internals or object iteration', () => {
  const source = createSignal(0)
  const store = $store({ entries: [] as number[], byKey: {} as Record<string, number> })
  let runs = 0
  const snapshots: number[][] = []
  const owner = createRoot(() => {
    createEffect(() => {
      snapshots.push([...store.entries])
      Object.keys(store.byKey)
    })
    createEffect(() => {
      const value = source()
      if (++runs > 20) return // Bound the original feedback loop.
      store.entries.push(value)
      store.byKey[`k${value}`] = value
    })
  })
  try {
    batch(() => source(1))
    expect(runs).toBe(2)
    expect([...store.entries]).toEqual([0, 1])
    expect(Object.keys(store.byKey)).toEqual(['k0', 'k1'])
    expect(snapshots.at(-1)).toEqual([0, 1])
  } finally {
    owner.dispose()
  }
})

it.each(['invalidate', 'mutate', 'refresh'] as const)(
  'does not subscribe a resource writer through %s',
  async operation => {
    const source = createSignal(0)
    const fetch = vi.fn(async () => 'fetched')
    const data = resource<string, number>({ fetch })
    let runs = 0
    const owner = createRoot(() => {
      const reader = data.read(1)
      createEffect(() => {
        source()
        if (++runs > 20) return
        if (operation === 'invalidate') data.invalidate(1)
        else if (operation === 'mutate') data.mutate(1, 'changed', { revalidate: true })
        else reader.refresh()
      })
      return reader
    })
    try {
      batch(() => source(1))
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(runs).toBe(2)
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(3)
      expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(owner.value.data).toBe('fetched')
    } finally {
      owner.dispose()
    }
  },
)

const mutations: [string, (array: number[], value: number) => unknown][] = [
  ['push', (array, value) => array.push(value)],
  ['pop', array => array.pop()],
  ['shift', array => array.shift()],
  ['unshift', (array, value) => array.unshift(value)],
  ['splice', (array, value) => array.splice(0, 1, value)],
  ['sort', array => array.sort((a, b) => b - a)],
  ['reverse', array => array.reverse()],
  ['fill', (array, value) => array.fill(value)],
  ['copyWithin', array => array.copyWithin(0, 1)],
]

it.each(mutations)(
  'does not track native array %s traversal but still notifies readers',
  (_name, mutate) => {
    const store = $store({ items: [1, 2, 3] })
    const source = createSignal(0)
    const after = createSignal(0)
    let runs = 0
    let observed: number[] = []
    const owner = createRoot(() => {
      createEffect(() => {
        observed = [...store.items]
      })
      createEffect(() => {
        if (++runs > 20) return
        mutate(store.items, source())
        after() // Tracking resumes after the mutation returns.
      })
    })
    try {
      batch(() => source(1))
      expect(runs).toBe(2)
      expect(observed).toEqual([...store.items])
      batch(() => after(1))
      expect(runs).toBe(3)
    } finally {
      owner.dispose()
    }
  },
)
