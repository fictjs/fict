import { describe, expect, it } from 'vitest'

import { batch, createEffect, createRoot, onCleanup } from '../src/index'
import { createSignal } from '../src/advanced'
import { effectScope } from '../src/signal'
import { getCurrentRoot } from '../src/lifecycle'

describe('nested effect cleanup', () => {
  it.each([false, true])('cleans children when their parent re-runs (root: %s)', rooted => {
    const source = createSignal(0)
    const childSource = createSignal(0)
    const cleanups: number[] = []
    const seen: number[] = []
    const setup = () =>
      createEffect(() => {
        const generation = source()
        createEffect(() => {
          seen.push(childSource())
          onCleanup(() => {
            cleanups.push(generation)
          })
        })
      })
    const owner = rooted ? createRoot(setup) : undefined
    const stop = owner?.value ?? setup()

    try {
      batch(() => source(1))
      expect(cleanups).toEqual([0])
      batch(() => childSource(1))
      expect(seen).toEqual([0, 0, 1])
      expect(cleanups).toEqual([0, 1])
      stop()
      expect(cleanups).toEqual([0, 1, 1])
    } finally {
      stop()
      owner?.dispose()
    }
    expect(cleanups).toEqual([0, 1, 1])
  })

  it('runs managed cleanups when a raw effect scope is disposed', () => {
    const calls: string[] = []
    const stop = effectScope(() => {
      createEffect(() => () => {
        calls.push('cleanup')
      })
    })

    stop()
    stop()
    expect(calls).toEqual(['cleanup'])
  })

  it('finishes disposing sibling effects when a child cleanup throws', () => {
    const source = createSignal(0)
    const calls: string[] = []
    const failure = new Error('child cleanup failed')
    let runs = 0
    const stop = effectScope(() => {
      for (const name of ['first', 'second']) {
        createEffect(() => {
          source()
          runs++
          return () => {
            calls.push(name)
            if (name === 'first') throw failure
          }
        })
      }
    })

    expect(stop).toThrow(failure)
    expect(calls).toEqual(['first', 'second'])
    batch(() => source(1))
    expect(runs).toBe(2)
    expect(stop).not.toThrow()
    expect(calls).toEqual(['first', 'second'])
  })

  it('does not accumulate disposed child cleanups on a long-lived root', () => {
    const source = createSignal(0)
    let cleanups = 0
    const owner = createRoot(() => {
      createEffect(() => {
        source()
        createEffect(() => () => {
          cleanups++
        })
      })
      return getCurrentRoot()!
    })

    for (let i = 1; i <= 100; i++) batch(() => source(i))
    expect(cleanups).toBe(100)
    expect(owner.value.cleanups).toHaveLength(1)
    owner.dispose()
    expect(cleanups).toBe(101)
  })

  it('cleans managed children when scope construction throws', () => {
    let cleanups = 0
    const failure = new Error('scope initialization failed')
    expect(() =>
      effectScope(() => {
        createEffect(() => () => {
          cleanups++
        })
        throw failure
      }),
    ).toThrow(failure)
    expect(cleanups).toBe(1)
  })
})
