import { describe, expect, it } from 'vitest'

import { batch, createRoot, onCleanup } from '../src/index'
import { createSignal } from '../src/advanced'
import { createEffect, createRenderBinding, createRenderTransaction } from '../src/effect'

describe('managed preparation and commit calls', () => {
  it('keeps ordinary callbacks argument-free and passes one prepared value to a binding', () => {
    const calls: [string, number, unknown?][] = []
    const owner = createRoot(() => {
      createEffect(function () {
        calls.push(['effect', arguments.length])
      })
      createRenderTransaction(function () {
        calls.push(['transaction', arguments.length])
      })
      createRenderBinding(
        () => undefined,
        function (value) {
          calls.push(['commit', arguments.length, value])
        },
      )
    })
    expect(calls).toEqual([
      ['effect', 0],
      ['transaction', 0],
      ['commit', 1, undefined],
    ])
    owner.dispose()
  })

  it('preserves prepared value identity, cleanup order and disposal', () => {
    const first = () => 'first'
    const second = () => 'second'
    const source = createSignal(first)
    const events: unknown[] = []
    const owner = createRoot(() => {
      createRenderBinding(
        () => {
          const value = source()
          events.push(['prepare', value])
          return value
        },
        value => {
          events.push(['commit', value])
          onCleanup(() => events.push(['registered', value]))
          return () => events.push(['returned', value])
        },
      )
    })
    batch(() => source(second))
    owner.dispose()
    batch(() => source(first))
    expect(events).toEqual([
      ['prepare', first],
      ['commit', first],
      ['prepare', second],
      ['returned', first],
      ['registered', first],
      ['commit', second],
      ['returned', second],
      ['registered', second],
    ])
  })
})
