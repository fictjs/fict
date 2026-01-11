import { describe, expect, it } from 'vitest'

import { createEffect } from '../src/index'
import { createStore } from '../src/internal'
import { createDiffingSignal } from '../src/store'

const tick = () => Promise.resolve()

describe('createStore iteration tracking', () => {
  it('tracks ownKeys/for-in when keys change', async () => {
    const [state, setState] = createStore<{ foo?: string; bar?: string }>({ foo: 'a' })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(state))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    setState(s => {
      ;(s as any).bar = 'b'
    })
    await tick()
    expect(seen[seen.length - 1]).toContain('bar')

    setState(s => {
      delete (s as any).foo
    })
    await tick()
    expect(seen[seen.length - 1]).toEqual(['bar'])
  })
})

describe('createStore reconciliation', () => {
  it('handles array shrink when reconciling', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2, 3, 4, 5] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3, 4, 5])

    // Shrink the array
    setState(() => ({ items: [1, 2] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2])
    expect(state.items.length).toBe(2)
  })

  it('handles array expand when reconciling', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2])

    // Expand the array
    setState(() => ({ items: [1, 2, 3, 4, 5] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3, 4, 5])
    expect(state.items.length).toBe(5)
  })

  it('handles array element updates during reconciliation', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2, 3] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3])

    // Update middle element
    setState(() => ({ items: [1, 99, 3] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 99, 3])
  })

  it('allows replacing nested objects with primitives', async () => {
    const [state, setState] = createStore<{ value: { nested: number } | number }>({
      value: { nested: 42 },
    })
    let observedValue: any

    createEffect(() => {
      observedValue = state.value
    })

    await tick()
    expect((observedValue as any).nested).toBe(42)

    // Replace nested object with primitive value
    setState(() => ({ value: 100 }))
    await tick()
    expect(state.value).toBe(100)
  })

  it('throws when replacing store with primitive', () => {
    const [, setState] = createStore<{ value: number }>({ value: 1 })

    expect(() => setState(() => 1 as any)).toThrow(
      '[Fict] Cannot replace store with primitive value',
    )
  })
})

describe('createDiffingSignal reactivity', () => {
  it('tracks key iteration updates', async () => {
    const [read, write] = createDiffingSignal<{ foo?: number; bar?: number }>({ foo: 1 })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    write({ foo: 1, bar: 2 })
    await tick()
    expect(seen[seen.length - 1]).toContain('bar')
  })

  it('tracks "in" checks for key presence', async () => {
    const [read, write] = createDiffingSignal<{ foo?: number; bar?: number }>({ foo: 1 })
    const seen: boolean[] = []

    createEffect(() => {
      seen.push('bar' in read())
    })

    await tick()
    expect(seen[seen.length - 1]).toBe(false)

    write({ foo: 1, bar: 2 })
    await tick()
    expect(seen[seen.length - 1]).toBe(true)
  })
})
