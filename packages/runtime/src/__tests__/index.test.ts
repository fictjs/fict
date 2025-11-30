import { describe, it, expect } from 'vitest'

import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onDestroy,
  onMount,
  render,
  batch,
  untrack,
  createElement,
  Fragment,
  createRoot,
} from '..'

describe('fict-runtime', () => {
  it('runs effects when signals change', () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const seen: number[] = []

    createEffect(() => {
      seen.push(doubled())
    })

    expect(seen).toEqual([0])

    count(1)
    expect(seen).toEqual([0, 2])

    count(5)
    expect(seen).toEqual([0, 2, 10])
  })

  it('runs onCleanup before re-run', () => {
    const count = createSignal(0)
    const cleanups: number[] = []

    createEffect(() => {
      const current = count()
      onCleanup(() => cleanups.push(current))
    })

    count(1)
    count(2)

    expect(cleanups).toEqual([0, 1])
  })

  it('batches updates to avoid extra effect runs', () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => seen.push(count()))

    batch(() => {
      count(1)
      count(2)
    })

    expect(seen).toEqual([0, 2])
  })

  it('untrack prevents dependency collection', () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => {
      seen.push(count())
      untrack(() => count())
    })

    count(1)
    expect(seen).toEqual([0, 1])
  })

  it('mounts and cleans up via render lifecycle', () => {
    const container = document.createElement('div')
    let mounted = 0
    let destroyed = 0

    const teardown = render(() => {
      onMount(() => {
        mounted++
        return () => destroyed++
      })
      onDestroy(() => {
        destroyed++
      })
      const node = document.createElement('div')
      node.textContent = 'hello'
      return node
    }, container)

    expect(mounted).toBe(1)
    expect(container.textContent).toBe('hello')

    teardown()

    expect(destroyed).toBe(2)
    expect(container.textContent).toBe('')
  })

  it('supports createRoot utility', () => {
    let cleaned = 0
    const root = createRoot(() => {
      onDestroy(() => {
        cleaned++
      })
      return 42
    })

    expect(root.value).toBe(42)
    root.dispose()
    expect(cleaned).toBe(1)
  })

  it('creates fragments and keeps falsy numeric children', () => {
    const frag = createElement({
      type: Fragment,
      props: { children: [0, 'a'] },
      key: undefined,
    })

    expect(frag.childNodes).toHaveLength(2)
    expect((frag.childNodes[0] as Text).textContent).toBe('0')
  })
})
