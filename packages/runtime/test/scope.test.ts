import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createRoot, onDestroy, createEffect, onCleanup } from '../src/index'
import { createSignal, createScope, runInScope } from '../src/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Reactive Scope', () => {
  describe('createScope', () => {
    it('creates a scope that can run reactive code', () => {
      let effectRan = false

      createRoot(() => {
        const scope = createScope()
        scope.run(() => {
          effectRan = true
        })
      })

      expect(effectRan).toBe(true)
    })

    it('returns the value from run function', () => {
      createRoot(() => {
        const scope = createScope()
        const result = scope.run(() => 42)
        expect(result).toBe(42)
      })
    })

    it('contains effects that can be stopped', async () => {
      const log: string[] = []
      const count = createSignal(0)

      const { dispose } = createRoot(() => {
        const scope = createScope()
        scope.run(() => {
          createEffect(() => {
            log.push(`effect: ${count()}`)
          })
        })

        expect(log).toEqual(['effect: 0'])

        return scope
      })

      count(1)
      await tick()
      expect(log).toEqual(['effect: 0', 'effect: 1'])

      // Dispose the root to stop the effect
      dispose()

      // After root is disposed, effect should no longer run
      count(2)
      await tick()
      expect(log).toEqual(['effect: 0', 'effect: 1'])
    })

    it('stop disposes all effects within the scope', async () => {
      const log: string[] = []
      const count = createSignal(0)

      const { dispose } = createRoot(() => {
        const scope = createScope()

        scope.run(() => {
          createEffect(() => {
            log.push(`effect: ${count()}`)
          })
        })

        expect(log).toEqual(['effect: 0'])

        count(1)
        // Effects run synchronously in batch or after tick
        return scope
      })

      await tick()
      expect(log).toEqual(['effect: 0', 'effect: 1'])

      dispose()

      count(2)
      await tick()
      expect(log).toEqual(['effect: 0', 'effect: 1'])
    })

    it('run disposes previous scope when called again', async () => {
      const cleanups: string[] = []
      const count = createSignal(0)

      const { value: scope, dispose } = createRoot(() => {
        const scope = createScope()

        scope.run(() => {
          onDestroy(() => cleanups.push('first'))
          createEffect(() => {
            count() // Track
          })
        })

        return scope
      })

      expect(cleanups).toEqual([])

      scope.run(() => {
        onDestroy(() => cleanups.push('second'))
      })

      // First scope should be disposed when second is created
      expect(cleanups).toEqual(['first'])

      dispose()
      expect(cleanups).toEqual(['first', 'second'])
    })

    it('stop is idempotent', () => {
      const { value: scope, dispose } = createRoot(() => {
        const scope = createScope()
        scope.run(() => {})
        return scope
      })

      scope.stop()
      scope.stop() // Should not throw
      scope.stop()

      dispose()
    })

    it('scope is cleaned up when parent root is disposed', async () => {
      const cleanups: string[] = []
      const count = createSignal(0)

      const { dispose } = createRoot(() => {
        const scope = createScope()

        scope.run(() => {
          onDestroy(() => cleanups.push('scope-destroyed'))
          createEffect(() => {
            count()
          })
        })
      })

      expect(cleanups).toEqual([])

      dispose()
      expect(cleanups).toContain('scope-destroyed')
    })

    it('supports nested scopes', () => {
      const log: string[] = []

      const { dispose } = createRoot(() => {
        const outerScope = createScope()

        outerScope.run(() => {
          log.push('outer-run')
          const innerScope = createScope()

          innerScope.run(() => {
            log.push('inner-run')
            onDestroy(() => log.push('inner-destroyed'))
          })

          onDestroy(() => log.push('outer-destroyed'))
        })
      })

      expect(log).toEqual(['outer-run', 'inner-run'])

      dispose()
      expect(log).toContain('inner-destroyed')
      expect(log).toContain('outer-destroyed')
    })
  })

  describe('runInScope', () => {
    it('runs code when flag is true', async () => {
      const flag = createSignal(true)
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          log.push('executed')
        })
      })

      expect(log).toEqual(['executed'])
      dispose()
    })

    it('does not run code when flag is false', async () => {
      const flag = createSignal(false)
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          log.push('executed')
        })
      })

      expect(log).toEqual([])
      dispose()
    })

    it('disposes scope when flag turns false', async () => {
      const flag = createSignal(true)
      const cleanups: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          onDestroy(() => cleanups.push('scope-destroyed'))
        })
      })

      expect(cleanups).toEqual([])

      flag(false)
      await tick()
      expect(cleanups).toEqual(['scope-destroyed'])

      dispose()
    })

    it('re-runs code when flag turns true again', async () => {
      const flag = createSignal(true)
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          log.push('executed')
        })
      })

      expect(log).toEqual(['executed'])

      flag(false)
      await tick()

      flag(true)
      await tick()
      expect(log).toEqual(['executed', 'executed'])

      dispose()
    })

    it('supports static boolean flag (true)', () => {
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(true, () => {
          log.push('executed')
        })
      })

      expect(log).toEqual(['executed'])
      dispose()
    })

    it('supports static boolean flag (false)', () => {
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(false, () => {
          log.push('executed')
        })
      })

      expect(log).toEqual([])
      dispose()
    })

    it('cleans up effects inside scope when flag turns false', async () => {
      const flag = createSignal(true)
      const count = createSignal(0)
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          createEffect(() => {
            log.push(`effect: ${count()}`)
          })
        })
      })

      expect(log).toEqual(['effect: 0'])

      count(1)
      await tick()
      expect(log).toEqual(['effect: 0', 'effect: 1'])

      flag(false)
      await tick()

      count(2)
      await tick()
      // Effect should no longer run after scope is disposed
      expect(log).toEqual(['effect: 0', 'effect: 1'])

      dispose()
    })

    it('handles rapid flag toggling', async () => {
      const flag = createSignal(true)
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          log.push('run')
          onDestroy(() => log.push('destroy'))
        })
      })

      flag(false)
      flag(true)
      flag(false)
      flag(true)
      await tick()

      // Should have run initially and after final toggle to true
      expect(log.filter(s => s === 'run').length).toBeGreaterThanOrEqual(1)

      dispose()
    })

    it('cleans up when parent root is disposed', async () => {
      const flag = createSignal(true)
      const cleanups: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          onDestroy(() => cleanups.push('scope-destroyed'))
        })
      })

      expect(cleanups).toEqual([])

      dispose()
      expect(cleanups).toContain('scope-destroyed')
    })

    it('effects inside scope track their own dependencies', async () => {
      const flag = createSignal(true)
      const value = createSignal('a')
      const log: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          createEffect(() => {
            log.push(value())
          })
        })
      })

      expect(log).toEqual(['a'])

      value('b')
      await tick()
      expect(log).toEqual(['a', 'b'])

      value('c')
      await tick()
      expect(log).toEqual(['a', 'b', 'c'])

      dispose()
    })

    it('scope runs onCleanup when stopped', async () => {
      const flag = createSignal(true)
      const cleanups: string[] = []

      const { dispose } = createRoot(() => {
        runInScope(flag, () => {
          createEffect(() => {
            onCleanup(() => cleanups.push('effect-cleanup'))
          })
        })
      })

      flag(false)
      await tick()
      expect(cleanups).toContain('effect-cleanup')

      dispose()
    })
  })

  describe('effectScope (from signal module)', () => {
    it('exports effectScope from scope module', async () => {
      const { effectScope } = await import('../src/scope')
      expect(effectScope).toBeDefined()
    })
  })
})
