import { describe, expect, it } from 'vitest'

import { batch, createEffect, createRoot, onCleanup, onDestroy, onMount } from '../src/index'
import { createSignal } from '../src/advanced'
import { getCurrentRoot, withRootContext } from '../src/lifecycle'

describe('registration after synchronous root disposal', () => {
  it('cleans an effect whose first execution disposes its mounting root', () => {
    const mount = createSignal(false)
    const source = createSignal(0)
    const calls: string[] = []
    let runs = 0
    let dispose = () => {}
    const owner = createRoot(() => {
      createEffect(() => {
        if (!mount()) return
        onMount(() => {
          createEffect(() => {
            source()
            runs++
            dispose()
            onCleanup(() => {
              calls.push('registered')
            })
            return () => {
              calls.push('returned')
            }
          })
        })
      })
    })
    dispose = owner.dispose

    batch(() => mount(true))
    expect(calls).toEqual(['returned', 'registered'])
    batch(() => source(1))
    expect(runs).toBe(1)
    dispose()
    expect(calls).toEqual(['returned', 'registered'])
  })

  it('immediately runs cleanup registered through an already disposed root context', () => {
    const owner = createRoot(() => getCurrentRoot()!)
    const calls: string[] = []
    owner.dispose()

    withRootContext(owner.value, () => {
      onCleanup(() => {
        calls.push('cleanup')
      })
      onDestroy(() => {
        calls.push('destroy')
      })
    })

    expect(calls).toEqual(['cleanup', 'destroy'])
    expect(owner.value.cleanups).toEqual([])
    expect(owner.value.destroyCallbacks).toEqual([])
  })
})
