/**
 * Tests for the testEffect function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testEffect, cleanup, waitForCondition } from '../src/index'
import { createEffect, createMemo } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('testEffect', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('basic usage', () => {
    it('resolves when done is called', async () => {
      const result = await testEffect<string>(done => {
        done('completed')
      })

      expect(result).toBe('completed')
    })

    it('resolves with undefined when done is called without argument', async () => {
      const result = await testEffect(done => {
        done(undefined)
      })

      expect(result).toBeUndefined()
    })

    it('rejects on error', async () => {
      await expect(
        testEffect(() => {
          throw new Error('Test error')
        }),
      ).rejects.toThrow('Test error')
    })
  })

  describe('error handling', () => {
    it('rejects when an effect throws during an update', async () => {
      await expect(
        testEffect<void>(done => {
          const count = createSignal(0)

          createEffect(() => {
            if (count() > 0) {
              throw new Error('Effect update error')
            }
          })

          count(1)
          done(undefined)
        }),
      ).rejects.toThrow('Effect update error')
    })
  })

  describe('with reactive primitives', () => {
    it('tests signal updates', async () => {
      const result = await testEffect<number>(done => {
        const count = createSignal(0)

        createEffect(() => {
          const value = count()
          if (value === 3) {
            done(value)
          }
        })

        // Update the signal
        count(1)
        count(2)
        count(3)
      })

      expect(result).toBe(3)
    })

    it('tests memo updates', async () => {
      const result = await testEffect<number>(done => {
        const count = createSignal(2)
        const doubled = createMemo(() => count() * 2)

        createEffect(() => {
          const value = doubled()
          if (value === 10) {
            done(value)
          }
        })

        count(5)
      })

      expect(result).toBe(10)
    })

    it('tests chained updates', async () => {
      const result = await testEffect<number>(done => {
        const a = createSignal(1)
        const b = createMemo(() => a() * 2)
        const c = createMemo(() => b() + 1)

        createEffect(() => {
          const value = c()
          if (value === 7) {
            done(value)
          }
        })

        // Update a to trigger chain: a=3 -> b=6 -> c=7
        a(3)
      })

      expect(result).toBe(7) // 3*2+1
    })
  })

  describe('async scenarios', () => {
    it('handles async updates', async () => {
      const result = await testEffect<string>(done => {
        const data = createSignal<string | null>(null)

        createEffect(() => {
          const value = data()
          if (value !== null) {
            done(value)
          }
        })

        // Simulate async data fetch
        setTimeout(() => {
          data('fetched data')
        }, 10)
      })

      expect(result).toBe('fetched data')
    })

    it('handles multiple async updates', async () => {
      const updates: number[] = []

      await testEffect<void>(done => {
        const count = createSignal(0)

        createEffect(() => {
          const value = count()
          updates.push(value)
          if (updates.length === 4) {
            done(undefined)
          }
        })

        setTimeout(() => count(1), 5)
        setTimeout(() => count(2), 10)
        setTimeout(() => count(3), 15)
      })

      expect(updates).toEqual([0, 1, 2, 3])
    })

    it('handles promise-based async', async () => {
      const fetchData = () =>
        new Promise<string>(resolve => {
          setTimeout(() => resolve('resolved'), 10)
        })

      const result = await testEffect<string>(done => {
        const data = createSignal<string | null>(null)

        createEffect(() => {
          const value = data()
          if (value !== null) {
            done(value)
          }
        })

        fetchData().then(value => data(value))
      })

      expect(result).toBe('resolved')
    })
  })

  describe('effect cleanup', () => {
    it('cleans up effects when done is called', async () => {
      let cleanedUp = false

      await testEffect(done => {
        const count = createSignal(0)

        createEffect(() => {
          count() // Track dependency
          return () => {
            cleanedUp = true
          }
        })

        done(undefined)
      })

      // Allow microtask for cleanup
      await tick()
      await tick()

      // Cleanup should have run
      expect(cleanedUp).toBe(true)
    })
  })

  describe('complex scenarios', () => {
    it('tests conditional effects', async () => {
      const result = await testEffect<string>(done => {
        const enabled = createSignal(false)
        const message = createSignal('')

        createEffect(() => {
          if (enabled()) {
            const msg = message()
            if (msg === 'final') {
              done(msg)
            }
          }
        })

        enabled(true)
        message('intermediate')
        message('final')
      })

      expect(result).toBe('final')
    })

    it('tests effect ordering', async () => {
      const order: string[] = []

      await testEffect(done => {
        const trigger = createSignal(0)

        createEffect(() => {
          trigger()
          order.push('first')
        })

        createEffect(() => {
          trigger()
          order.push('second')
          if (order.length >= 4) {
            done(undefined)
          }
        })

        trigger(1)
      })

      // Initial run + one update
      expect(order).toEqual(['first', 'second', 'first', 'second'])
    })
  })
})

describe('waitForCondition', () => {
  it('resolves when condition becomes true', async () => {
    let flag = false

    setTimeout(() => {
      flag = true
    }, 50)

    await waitForCondition(() => flag, { timeout: 200 })

    expect(flag).toBe(true)
  })

  it('rejects on timeout', async () => {
    await expect(waitForCondition(() => false, { timeout: 50, interval: 10 })).rejects.toThrow(
      'waitForCondition timed out after 50ms',
    )
  })

  it('uses custom interval', async () => {
    let checkCount = 0
    const condition = () => {
      checkCount++
      return checkCount >= 3
    }

    await waitForCondition(condition, { timeout: 500, interval: 20 })

    expect(checkCount).toBeGreaterThanOrEqual(3)
  })

  it('resolves immediately if condition is already true', async () => {
    const startTime = Date.now()

    await waitForCondition(() => true)

    const elapsed = Date.now() - startTime
    expect(elapsed).toBeLessThan(50)
  })
})
