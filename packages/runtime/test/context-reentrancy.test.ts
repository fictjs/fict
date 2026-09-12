import { describe, expect, it } from 'vitest'

import { batch, createContext, createEffect, onCleanup, onMount, render } from '../src/index'
import { createSignal } from '../src/advanced'
import type { FictNode } from '../src/types'

describe('context provider reentrancy', () => {
  it.each(['render', 'mount'])(
    'disposes children that destroy the provider host during %s',
    phase => {
      const Context = createContext('default')
      const container = document.createElement('div')
      const source = createSignal(0)
      const children = createSignal<FictNode>('initial')
      let runs = 0
      let cleanups = 0
      const stop = render(
        () => ({
          type: Context.Provider,
          props: {
            value: 'provided',
            get children() {
              return children()
            },
          },
        }),
        container,
      )
      const Child = () => {
        createEffect(() => {
          source()
          runs++
        })
        onCleanup(() => {
          cleanups++
        })
        if (phase === 'render') stop()
        else onMount(() => stop())
        return { type: 'span', props: { children: 'child' } }
      }
      try {
        batch(() => children({ type: Child, props: {} }))
        expect(container.textContent).toBe('')
        expect(cleanups).toBe(1)
        batch(() => source(1))
        expect(runs).toBe(1)
      } finally {
        stop()
      }
    },
  )
})
