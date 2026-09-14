import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, createRoot, render, Suspense } from '../src/index'
import { createAsyncMemo, createSignal, reactive } from '../src/advanced'
import { __fictProp, createPropsProxy } from '../src/internal'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('Initialized component call props', () => {
  let container: HTMLElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    container.remove()
  })
  it('initializes call props once, tracks updates and retains object identity', async () => {
    const count = createSignal(0)
    const calls: number[] = []
    const scope = createRoot(() => {
      const getter = __fictProp(() => {
        const value = count()
        calls.push(value)
        return { value }
      }, true)
      const props = createPropsProxy({ value: getter })
      expect(calls).toEqual([0])
      expect(props.value).toBe(props.value)
      return { getter, props }
    })
    try {
      count(1)
      await tick()
      expect(scope.value.props.value).toEqual({ value: 1 })
      expect(scope.value.props.value).toBe(scope.value.props.value)
      expect(calls).toEqual([0, 1])
    } finally {
      scope.dispose()
    }
    count(2)
    await tick()
    expect(scope.value.getter()).toEqual({ value: 1 })
    expect(calls).toEqual([0, 1])
  })

  it('retains an initially unavailable call prop for its rendering consumer', async () => {
    let resolve!: (value: string) => void
    const request = new Promise<string>(yes => {
      resolve = yes
    })
    const Child = (props: Record<string, unknown>) => ({
      type: 'span',
      props: { children: reactive(() => String(props.value)) },
    })
    const Parent = () => {
      const data = createAsyncMemo(() => request)
      return { type: Child, props: { value: __fictProp(() => data(), true) } }
    }
    const dispose = render(
      () =>
        createElement({
          type: Suspense as unknown as typeof Child,
          props: { fallback: 'loading', children: { type: Parent, props: {} } },
        }),
      container,
    )
    try {
      expect(container.textContent).toBe('loading')
      resolve('ready')
      for (let i = 0; i < 20; i++) await tick()
      expect(container.textContent).toBe('ready')
    } finally {
      dispose()
    }
  })
})
