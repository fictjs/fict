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
  bindText,
  bindAttribute,
  bindProperty,
  insert,
  setCycleProtectionOptions,
} from '../src/index'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('fict runtime', () => {
  it('runs effects when signals change', async () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const seen: number[] = []

    createEffect(() => {
      seen.push(doubled())
    })

    expect(seen).toEqual([0])

    count(1)
    await tick()
    expect(seen).toEqual([0, 2])

    count(5)
    await tick()
    expect(seen).toEqual([0, 2, 10])
  })

  it('runs onCleanup before re-run', async () => {
    const count = createSignal(0)
    const cleanups: number[] = []

    createEffect(() => {
      const current = count()
      onCleanup(() => cleanups.push(current))
    })

    count(1)
    await tick()
    count(2)
    await tick()

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

  it('untrack prevents dependency collection', async () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => {
      seen.push(count())
      untrack(() => count())
    })

    count(1)
    await tick()
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

  it('updates DOM via effects', async () => {
    const container = document.createElement('div')
    const div = document.createElement('div')
    const count = createSignal(0)

    createEffect(() => {
      div.textContent = String(count())
    })

    container.appendChild(div)
    expect(div.textContent).toBe('0')

    count(2)
    await tick()
    expect(div.textContent).toBe('2')
  })

  it('bindText updates a text node reactively', async () => {
    const text = document.createTextNode('')
    const count = createSignal(1)
    bindText(text, () => count())
    expect(text.textContent).toBe('1')
    count(5)
    await tick()
    expect(text.textContent).toBe('5')
  })

  it('bindAttribute and bindProperty update DOM reactively', async () => {
    const el = document.createElement('input')
    const value = createSignal('a')
    const checked = createSignal(false)

    bindAttribute(el, 'data-value', () => value())
    bindProperty(el, 'checked', () => checked())

    expect(el.getAttribute('data-value')).toBe('a')
    expect(el.checked).toBe(false)

    value('b')
    checked(true)
    await tick()

    expect(el.getAttribute('data-value')).toBe('b')
    expect(el.checked).toBe(true)
  })

  it('insert swaps child nodes reactively', async () => {
    const parent = document.createElement('div')
    const toggle = createSignal(true)
    insert(parent, () => (toggle() ? 'yes' : document.createElement('span')))

    expect(parent.textContent).toBe('yes')
    toggle(false)
    await tick()
    expect(parent.firstChild instanceof HTMLElement).toBe(true)
  })

  it('runs lifecycles in nested components within render', () => {
    const container = document.createElement('div')
    const calls: string[] = []

    const Child = () => {
      onMount(() => calls.push('child-mount'))
      onDestroy(() => calls.push('child-destroy'))
      return document.createElement('span')
    }

    const dispose = render(() => {
      onMount(() => calls.push('root-mount'))
      onDestroy(() => calls.push('root-destroy'))
      return { type: Child, props: null, key: undefined }
    }, container)

    expect(calls).toEqual(['root-mount', 'child-mount'])
    dispose()
    expect(calls).toEqual(['root-mount', 'child-mount', 'child-destroy', 'root-destroy'])
  })

  it('exposes cycle protection configuration', () => {
    expect(typeof setCycleProtectionOptions).toBe('function')
  })
})
