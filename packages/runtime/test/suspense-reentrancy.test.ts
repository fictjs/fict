import { describe, expect, it } from 'vitest'

import { batch, createEffect, onCleanup, onMount, render, Suspense } from '../src/index'
import { createSignal, reactive } from '../src/advanced'

describe('suspense view reentrancy', () => {
  it.each(['render', 'mount'])(
    'disposes a view that destroys the boundary host during %s',
    phase => {
      const host = document.createElement('div')
      const source = createSignal(0)
      const version = createSignal(0)
      let runs = 0
      let cleanups = 0
      let stop = () => {}
      const Child = () => {
        const current = version()
        createEffect(() => {
          source()
          runs++
        })
        onCleanup(() => {
          cleanups++
        })
        if (current > 0) {
          if (phase === 'render') stop()
          else onMount(() => stop())
        }
        return { type: 'span', props: { children: String(current) } }
      }
      stop = render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            resetKeys: reactive(() => version()),
            children: { type: Child, props: {} },
          },
        }),
        host,
      )
      try {
        batch(() => version(1))
        expect(host.textContent).toBe('')
        expect(cleanups).toBe(2)
        batch(() => source(1))
        expect(runs).toBe(2)
      } finally {
        stop()
      }
    },
  )
})
