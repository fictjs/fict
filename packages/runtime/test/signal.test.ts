import { describe, it, expect } from 'vitest'

import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSuspenseToken,
  onCleanup,
  render,
} from '../src/index'
import { createRenderEffect, createSelector, createSignal } from '../src/advanced'
import {
  getCurrentRoot,
  registerErrorHandler,
  registerSuspenseHandler,
  type RootContext,
} from '../src/lifecycle'
import {
  __resetReactiveState,
  batch as rawBatch,
  computed as rawComputed,
  effect as rawEffect,
  effectScope as rawEffectScope,
  effectWithCleanup as rawEffectWithCleanup,
  signal as rawSignal,
} from '../src/signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('signal runtime robustness', () => {
  it('reruns owned and rootless effects with their exact creation root', () => {
    const ownedSource = createSignal(0)
    const rootlessSource = createSignal(0)
    const ownedRuns: Array<RootContext | undefined> = []
    const rootlessRuns: Array<RootContext | undefined> = []
    let ownerRoot: RootContext | undefined
    let foreignRoot: RootContext | undefined

    const owner = createRoot(() => {
      ownerRoot = getCurrentRoot()
      createEffect(() => {
        ownedSource()
        ownedRuns.push(getCurrentRoot())
      })
    })
    const stopRootless = createEffect(() => {
      rootlessSource()
      rootlessRuns.push(getCurrentRoot())
    })

    const foreign = createRoot(() => {
      foreignRoot = getCurrentRoot()
      batch(() => {
        ownedSource(1)
        rootlessSource(1)
      })
    })

    expect(foreignRoot).not.toBe(ownerRoot)
    expect(ownedRuns).toEqual([ownerRoot, ownerRoot])
    expect(rootlessRuns).toEqual([undefined, undefined])

    stopRootless()
    foreign.dispose()
    owner.dispose()
  })

  it('does not route rootless cleanup errors through an ambient root', () => {
    const error = new Error('rootless cleanup failed')
    let handled = 0
    let caught: unknown
    const stop = createEffect(() => () => {
      throw error
    })

    const foreign = createRoot(() => {
      registerErrorHandler(() => {
        handled++
        return true
      })
      try {
        stop()
      } catch (err) {
        caught = err
      }
    })

    expect(handled).toBe(0)
    expect(caught).toBe(error)
    foreign.dispose()
  })

  it('runs pending dependency error handlers in the effect owner root', () => {
    const source = createSignal(false)
    const error = new Error('memo update failed')
    let ownerRoot: RootContext | undefined
    let handlerRoot: RootContext | undefined

    const owner = createRoot(() => {
      ownerRoot = getCurrentRoot()
      registerErrorHandler(err => {
        expect(err).toBe(error)
        handlerRoot = getCurrentRoot()
        return true
      })
      const derived = createMemo(() => {
        if (source()) throw error
        return 0
      })
      createEffect(() => {
        derived()
      })
    })

    const foreign = createRoot(() => {
      batch(() => source(true))
    })

    expect(handlerRoot).toBe(ownerRoot)
    foreign.dispose()
    owner.dispose()
  })

  it('does not route rootless suspension through an ambient root', () => {
    const source = createSignal(false)
    const { token, resolve } = createSuspenseToken()
    let handled = 0
    let caught: unknown
    const stop = createEffect(() => {
      if (source()) throw token
    })

    const foreign = createRoot(() => {
      registerSuspenseHandler(() => {
        handled++
        return true
      })
      try {
        batch(() => source(true))
      } catch (err) {
        caught = err
      }
    })

    expect(handled).toBe(0)
    expect(caught).toBe(token)

    stop()
    resolve()
    foreign.dispose()
  })

  for (const [name, create] of [
    ['createEffect', createEffect],
    ['createRenderEffect', createRenderEffect],
  ] as const) {
    it(`${name} cleanup can dispose its own effect without recursion`, () => {
      let cleanupRuns = 0
      let stop = () => {}
      const root = createRoot(() => {
        stop = create(() => {
          return () => {
            cleanupRuns++
            stop()
          }
        })
      })

      expect(() => stop()).not.toThrow()
      expect(cleanupRuns).toBe(1)
      expect(() => stop()).not.toThrow()

      root.dispose()
      expect(cleanupRuns).toBe(1)
    })

    it(`${name} drains registered cleanup when initial execution fails`, () => {
      const error = new Error('initial effect failed')
      let cleanupRuns = 0

      expect(() =>
        create(() => {
          onCleanup(() => {
            cleanupRuns++
          })
          throw error
        }),
      ).toThrow(error)
      expect(cleanupRuns).toBe(1)
    })

    it(`${name} does not rerun after its cleanup disposes the effect`, async () => {
      const value = createSignal(0)
      let effectRuns = 0
      let cleanupRuns = 0
      let stop = () => {}

      stop = create(() => {
        value()
        effectRuns++
        onCleanup(() => {
          cleanupRuns++
          stop()
        })
      })

      value(1)
      await tick()
      expect(effectRuns).toBe(1)
      expect(cleanupRuns).toBe(1)

      value(2)
      await tick()
      expect(effectRuns).toBe(1)
      expect(cleanupRuns).toBe(1)
    })

    it(`${name} drains in-flight cleanup and dependencies when the effect stops itself`, async () => {
      const trigger = createSignal(0)
      const tail = createSignal(0)
      let effectRuns = 0
      let cleanupRuns = 0
      let stop = () => {}

      stop = create(() => {
        const current = trigger()
        effectRuns++
        if (current === 1) {
          onCleanup(() => {
            cleanupRuns++
          })
          stop()
          tail()
        }
      })

      trigger(1)
      await tick()
      expect(effectRuns).toBe(2)
      expect(cleanupRuns).toBe(1)

      tail(1)
      trigger(2)
      await tick()
      expect(effectRuns).toBe(2)
      expect(cleanupRuns).toBe(1)
    })

    it(`${name} stays disposed when it was queued before stop`, async () => {
      const value = createSignal(0)
      let effectRuns = 0
      let cleanupRuns = 0

      const stop = create(() => {
        value()
        effectRuns++
        onCleanup(() => {
          cleanupRuns++
        })
      })

      value(1)
      stop()
      expect(cleanupRuns).toBe(1)

      await tick()
      expect(effectRuns).toBe(1)

      value(2)
      await tick()
      expect(effectRuns).toBe(1)
      expect(cleanupRuns).toBe(1)
    })

    it(`${name} stays disposed when memo validation stops the pending effect`, async () => {
      const source = createSignal(0)
      let effectRuns = 0
      let stop = () => {}
      const stable = createMemo(() => {
        const current = source()
        if (current === 1) stop()
        return 0
      })

      stop = create(() => {
        stable()
        effectRuns++
      })

      source(1)
      await tick()
      expect(effectRuns).toBe(1)

      source(2)
      await tick()
      expect(effectRuns).toBe(1)
    })

    it(`${name} drains cleanup registered before a handled error disposes its owner`, async () => {
      const value = createSignal(0)
      const error = new Error('effect failed')
      let effectRuns = 0
      let cleanupRuns = 0
      let disposeOwner = () => {}

      const root = createRoot(() => {
        registerErrorHandler(caught => {
          expect(caught).toBe(error)
          disposeOwner()
          return true
        })
        create(() => {
          const current = value()
          effectRuns++
          if (current === 1) {
            onCleanup(() => {
              cleanupRuns++
            })
            throw error
          }
        })
      })
      disposeOwner = root.dispose

      value(1)
      await tick()
      expect(effectRuns).toBe(2)
      expect(cleanupRuns).toBe(1)

      value(2)
      await tick()
      expect(effectRuns).toBe(2)
      expect(cleanupRuns).toBe(1)
    })
  }

  it('scopes onCleanup callbacks to render effect reruns and disposal', async () => {
    const value = createSignal(0)
    const order: string[] = []

    const dispose = createRenderEffect(() => {
      const current = value()
      onCleanup(() => order.push(`registered-${current}`))
      return () => order.push(`returned-${current}`)
    })

    value(1)
    await tick()
    expect(order).toEqual(['returned-0', 'registered-0'])

    dispose()
    expect(order).toEqual(['returned-0', 'registered-0', 'returned-1', 'registered-1'])
  })

  it('coalesces batched writes across chained memos and effects', () => {
    const sourceA = createSignal(0)
    const sourceB = createSignal(0)
    const runs = { a: 0, b: 0, c: 0 }

    const a = createMemo(() => {
      runs.a++
      return sourceA() + sourceB()
    })
    const b = createMemo(() => {
      runs.b++
      return a() * 2
    })
    const c = createMemo(() => {
      runs.c++
      return b() - sourceA()
    })

    const seen: number[] = []
    createEffect(() => {
      seen.push(c())
    })

    expect(seen).toEqual([0])
    expect(runs).toEqual({ a: 1, b: 1, c: 1 })

    batch(() => {
      sourceA(1)
      sourceB(2)
      expect(seen).toEqual([0])
      sourceA(3)
      sourceB(4)
      expect(seen).toEqual([0])
    })

    expect(seen).toEqual([0, 11])
    expect(runs).toEqual({ a: 2, b: 2, c: 2 })
  })

  it('runs stacked cleanups in last-in-first-out order', async () => {
    const value = createSignal(0)
    const order: string[] = []

    const dispose = createEffect(() => {
      const current = value()
      onCleanup(() => order.push(`late-${current}`))
      onCleanup(() => order.push(`early-${current}`))
    })

    value(1)
    await tick()
    value(2)
    await tick()
    dispose()

    expect(order).toEqual(['early-0', 'late-0', 'early-1', 'late-1', 'early-2', 'late-2'])
  })

  it('keeps computed values stable during cleanup', async () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const seen: number[] = []

    const dispose = createEffect(() => {
      const current = doubled()
      onCleanup(() => {
        // Cleanup should observe the previous computed value, not the new pending one.
        seen.push(doubled())
      })
      return current
    })

    count(1)
    await tick()
    count(2)
    await tick()
    dispose()

    expect(seen).toEqual([0, 2, 4])
  })

  it('keeps the previous computed snapshot when cleanup disposes its root', async () => {
    const count = createSignal(0)
    const seen: number[] = []
    let disposeOwner = () => {}

    const owner = createRoot(() => {
      const value = createMemo(() => count())
      createEffect(() => {
        value()
        onCleanup(() => {
          disposeOwner()
          seen.push(value())
        })
      })
    })
    disposeOwner = owner.dispose

    count(1)
    await tick()

    expect(seen).toEqual([0])
    owner.dispose()
  })

  it('does not run cleanup when memo value is unchanged', async () => {
    const count = createSignal(0)
    const stepped = createMemo(() => Math.floor(count() / 2))
    const cleanups: number[] = []

    createEffect(() => {
      const current = stepped()
      onCleanup(() => cleanups.push(current))
    })

    count(1)
    await tick()
    expect(cleanups).toEqual([])

    count(2)
    await tick()
    expect(cleanups).toEqual([0])
  })

  it('handles updates triggered inside effects', async () => {
    const signal1 = createSignal(0)
    const signal2 = createSignal(0)
    const logs: string[] = []

    createEffect(() => {
      const val = signal1()
      logs.push(`effect1: ${val}`)
      if (val === 1) {
        signal2(10)
      }
    })

    createEffect(() => {
      logs.push(`effect2: ${signal2()}`)
    })

    // Initial run: both effects execute
    expect(logs).toEqual(['effect1: 0', 'effect2: 0'])

    // Update signal1 to 1
    signal1(1)

    // Before microtask: no effects have run yet
    expect(logs).toEqual(['effect1: 0', 'effect2: 0'])

    // First microtask: effect1 runs and triggers signal2 update
    await tick()
    expect(logs).toContain('effect1: 1')

    // Second microtask: effect2 runs with updated signal2 value
    await tick()
    expect(logs).toContain('effect2: 10')

    // Verify complete execution order
    expect(logs).toEqual(['effect1: 0', 'effect2: 0', 'effect1: 1', 'effect2: 10'])
  })

  it('handles mixed batch and microtask updates', async () => {
    const signal1 = createSignal(0)
    const signal2 = createSignal(0)
    let runs = 0

    createEffect(() => {
      signal1()
      signal2()
      runs++
    })

    // Initial run
    expect(runs).toBe(1)

    // Schedule microtask with signal1
    signal1(1)

    // Immediately batch signal2 (should flush synchronously)
    batch(() => {
      signal2(2)
    })

    // After batch: both signals updated, effect ran once more
    expect(runs).toBe(2)

    // Wait for microtask
    await tick()

    // Microtask should find queue empty, no additional runs
    expect(runs).toBe(2)
  })

  it('coalesces multiple synchronous updates in microtask', async () => {
    const count = createSignal(0)
    let effectRuns = 0

    createEffect(() => {
      count()
      effectRuns++
    })

    // Initial run
    expect(effectRuns).toBe(1)

    // Multiple synchronous updates
    count(1)
    count(2)
    count(3)

    // Before microtask: no new runs
    expect(effectRuns).toBe(1)

    // After microtask: only one batched run
    await tick()
    expect(effectRuns).toBe(2)
  })

  it('flushes pending updates even when batch throws', () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => {
      seen.push(count())
    })

    expect(seen).toEqual([0])

    expect(() =>
      batch(() => {
        count(1)
        throw new Error('boom')
      }),
    ).toThrow('boom')

    expect(seen).toEqual([0, 1])
  })

  it.each([undefined, null, false, 0, ''])('preserves a falsy batch exception: %s', thrown => {
    let didCatch = false
    let caught: unknown = Symbol('not caught')

    try {
      batch(() => {
        throw thrown
      })
    } catch (error) {
      didCatch = true
      caught = error
    }

    expect(didCatch).toBe(true)
    expect(caught).toBe(thrown)
  })

  it('keeps a thrown undefined when the final batch flush also fails', () => {
    const value = createSignal(0)
    const flushError = new Error('flush failed')
    const stop = createEffect(() => {
      if (value() === 1) throw flushError
    })
    let didCatch = false
    let caught: unknown = Symbol('not caught')

    try {
      batch(() => {
        value(1)
        throw undefined
      })
    } catch (error) {
      didCatch = true
      caught = error
    }

    expect(didCatch).toBe(true)
    expect(caught).toBeUndefined()
    stop()
  })

  it('preserves undefined thrown by a final batch flush', () => {
    const value = createSignal(0)
    const stop = createEffect(() => {
      if (value() === 1) throw undefined
    })
    let didCatch = false
    let caught: unknown = Symbol('not caught')

    try {
      batch(() => {
        value(1)
      })
    } catch (error) {
      didCatch = true
      caught = error
    }

    expect(didCatch).toBe(true)
    expect(caught).toBeUndefined()
    stop()
  })

  it('preserves thrown undefined through nested batches', () => {
    let didCatch = false
    let caught: unknown = Symbol('not caught')

    try {
      batch(() =>
        batch(() => {
          throw undefined
        }),
      )
    } catch (error) {
      didCatch = true
      caught = error
    }

    expect(didCatch).toBe(true)
    expect(caught).toBeUndefined()
  })

  it('cleans up selector effects with the owning root', async () => {
    const selected = createSignal(1)
    let select: ((key: number) => boolean) | undefined
    const container = document.createElement('div')
    document.body.appendChild(container)

    const dispose = render(() => {
      select = createSelector(() => selected())
      // Prime selector entries
      select!(1)
      select!(2)
      return document.createTextNode('')
    }, container)

    expect(select!(1)).toBe(true)
    expect(select!(2)).toBe(false)

    dispose()
    selected(2)
    await tick()

    // Selector should no longer respond after disposal
    expect(select!(1)).toBe(true)
    expect(select!(2)).toBe(false)

    container.remove()
  })

  it('updates every registered key with a custom selector equality', async () => {
    const selected = createSignal('A')
    let select: ((key: string) => boolean) | undefined
    const owner = createRoot(() => {
      select = createSelector(
        () => selected(),
        (left, right) => left.toLowerCase() === right.toLowerCase(),
      )
    })

    expect(select!('a')).toBe(true)
    expect(select!('b')).toBe(false)

    selected('B')
    await tick()

    expect(select!('a')).toBe(false)
    expect(select!('b')).toBe(true)
    owner.dispose()
  })

  it('keeps a shared selector observer alive until its last root is disposed', async () => {
    const selected = createSignal('a')
    let select: ((key: string) => boolean) | undefined
    const selectorOwner = createRoot(() => {
      select = createSelector(() => selected())
    })
    let firstValue = false
    let secondValue = false
    let secondRuns = 0

    const firstOwner = createRoot(() => {
      createEffect(() => {
        firstValue = select!('a')
      })
    })
    const secondOwner = createRoot(() => {
      createEffect(() => {
        secondRuns++
        secondValue = select!('a')
      })
    })

    expect(firstValue).toBe(true)
    expect(secondValue).toBe(true)
    expect(secondRuns).toBe(1)

    firstOwner.dispose()
    selected('b')
    await tick()

    expect(secondValue).toBe(false)
    expect(secondRuns).toBe(2)

    secondOwner.dispose()
    selectorOwner.dispose()
  })

  it('removes stale dependencies when low-level effects throw during re-run', () => {
    const mode = rawSignal(false)
    const active = rawSignal(0)
    const stale = rawSignal(0)
    let runs = 0
    let shouldThrow = true

    const dispose = rawEffect(() => {
      runs++
      if (mode()) {
        active()
        if (shouldThrow) {
          shouldThrow = false
          throw new Error('boom')
        }
        return
      }
      stale()
    })

    expect(runs).toBe(1)

    expect(() =>
      rawBatch(() => {
        mode(true)
      }),
    ).toThrow('boom')
    expect(runs).toBe(2)

    // Clear queue state left by the thrown flush so we only observe dependency behavior.
    __resetReactiveState()

    rawBatch(() => {
      stale(1)
    })
    expect(runs).toBe(2)

    rawBatch(() => {
      active(1)
    })
    expect(runs).toBe(3)

    dispose()
  })

  it('does not retain dependencies when low-level effect throws on initial run', () => {
    const source = rawSignal(0)
    let runs = 0

    expect(() =>
      rawEffect(() => {
        runs++
        source()
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(runs).toBe(1)

    __resetReactiveState()

    expect(() =>
      rawBatch(() => {
        source(1)
      }),
    ).not.toThrow()
    expect(runs).toBe(1)
  })

  it('does not retain dependencies when effectWithCleanup throws on initial run', () => {
    const source = rawSignal(0)
    let runs = 0
    let cleanupRuns = 0

    expect(() =>
      rawEffectWithCleanup(
        () => {
          runs++
          source()
          throw new Error('boom')
        },
        () => {
          cleanupRuns++
        },
      ),
    ).toThrow('boom')
    expect(runs).toBe(1)
    expect(cleanupRuns).toBe(0)

    __resetReactiveState()

    expect(() =>
      rawBatch(() => {
        source(1)
      }),
    ).not.toThrow()
    expect(runs).toBe(1)
    expect(cleanupRuns).toBe(0)
  })

  it('disposes partially created effect scopes when initialization throws', () => {
    const source = rawSignal(0)
    let innerRuns = 0

    expect(() =>
      rawEffectScope(() => {
        rawEffect(() => {
          innerRuns++
          source()
        })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(innerRuns).toBe(1)

    __resetReactiveState()

    expect(() =>
      rawBatch(() => {
        source(1)
      }),
    ).not.toThrow()
    // The inner effect must be disposed with the failed scope.
    expect(innerRuns).toBe(1)
  })

  it('retries computed after initial throw and drops stale dependencies', () => {
    const mode = rawSignal(true)
    const active = rawSignal(0)
    const stale = rawSignal(0)
    let runs = 0

    const derived = rawComputed(() => {
      runs++
      if (mode()) {
        active()
        throw new Error('boom')
      }
      return stale()
    })

    expect(() => derived()).toThrow('boom')
    expect(runs).toBe(1)

    rawBatch(() => {
      mode(false)
    })
    expect(derived()).toBe(0)
    expect(runs).toBe(2)

    rawBatch(() => {
      active(1)
    })
    // active should no longer be subscribed after the successful retry.
    expect(derived()).toBe(0)
    expect(runs).toBe(2)

    rawBatch(() => {
      stale(1)
    })
    expect(derived()).toBe(1)
    expect(runs).toBe(3)
  })

  it('removes stale dependencies when computed throws during update', async () => {
    const mode = createSignal(false)
    const active = createSignal(0)
    const stale = createSignal(0)
    let runs = 0
    let errors = 0

    const root = createRoot(() => {
      registerErrorHandler(() => {
        errors++
        return true
      })
      const derived = createMemo(() => {
        if (mode()) {
          active()
          throw new Error('boom')
        }
        return stale()
      })

      return createEffect(() => {
        runs++
        derived()
      })
    })

    expect(runs).toBe(1)

    mode(true)
    await tick()
    expect(runs).toBe(1)
    expect(errors).toBe(1)

    stale(1)
    await tick()
    expect(runs).toBe(1)
    expect(errors).toBe(1)

    active(1)
    await tick()
    expect(runs).toBe(1)
    expect(errors).toBe(2)

    root.dispose()
  })
})
