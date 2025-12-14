import { Suspense, render } from '@fictjs/runtime'
import { describe, it, expect, vi } from 'vitest'

import { lazy } from '../src/lazy'

const tick = () => Promise.resolve()

describe('lazy', () => {
  it('suspends while loading and renders when ready', async () => {
    let resolveModule: ((m: { default: () => any }) => void) | undefined
    const loader = vi.fn(
      () =>
        new Promise<{ default: () => any }>(resolve => {
          resolveModule = resolve
        }),
    )

    const LazyComp = lazy(loader)
    const container = document.createElement('div')

    const dispose = render(
      () => ({
        type: Suspense as any,
        props: {
          fallback: 'loading',
          children: { type: LazyComp, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    resolveModule?.({ default: () => ({ type: 'span', props: { children: 'ready' } }) })
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    dispose()
  })
})
