import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  __fictProp,
  __fictPropsRest,
  prop,
  bindText,
  createElement,
  createSignal,
  mergeProps,
  render,
  spread,
} from '../src/index'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Props proxy', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('unwraps marked getters and stays reactive', async () => {
    let count: ReturnType<typeof createSignal>

    const Child = (props: Record<string, unknown>) => {
      const span = document.createElement('span')
      const text = document.createTextNode('')
      span.appendChild(text)
      bindText(text, () => String(props.count))
      return span
    }

    const Parent = () => {
      count = createSignal(0)
      return {
        type: Child,
        props: { count: __fictProp(() => count()) },
        key: undefined,
      }
    }

    const dispose = render(
      () => createElement({ type: Parent, props: null, key: undefined }),
      container,
    )

    expect(container.textContent).toBe('0')

    count(count() + 1)
    await tick()

    expect(container.textContent).toBe('1')
    dispose()
  })

  it('does not auto-call unmarked functions', () => {
    let received: unknown
    let called = false
    const handler = () => {
      called = true
    }

    const Child = (props: Record<string, unknown>) => {
      received = props.onClick
      return document.createElement('div')
    }

    const dispose = render(
      () => createElement({ type: Child, props: { onClick: handler }, key: undefined }),
      container,
    )

    expect(received).toBe(handler)
    expect(called).toBe(false)
    dispose()
  })

  it('spreads reactive props from proxy', async () => {
    let count: ReturnType<typeof createSignal>

    const Child = (props: Record<string, unknown>) => {
      const div = document.createElement('div')
      spread(div, props)
      return div
    }

    const Parent = () => {
      count = createSignal(0)
      return {
        type: Child,
        props: { title: __fictProp(() => `Count: ${count()}`) },
        key: undefined,
      }
    }

    const dispose = render(
      () => createElement({ type: Parent, props: null, key: undefined }),
      container,
    )

    const div = container.querySelector('div')!
    expect(div.getAttribute('title')).toBe('Count: 0')

    count(count() + 1)
    await tick()

    expect(div.getAttribute('title')).toBe('Count: 1')
    dispose()
  })

  it('preserves reactivity through props rest helper', () => {
    const count = createSignal(0)
    const base = { count: __fictProp(() => count()) }

    const proxied = __fictPropsRest(base, [])
    expect(proxied.count).toBe(0)

    count(count() + 1)
    expect(proxied.count).toBe(1)
  })

  it('merges props while preserving getters and override order', () => {
    const a = createSignal(0)
    const b = createSignal(10)

    const merged = mergeProps(
      { foo: __fictProp(() => a()) },
      { bar: 1 },
      { foo: __fictProp(() => b()) },
    )

    expect(merged.foo).toBe(10) // last wins
    expect(merged.bar).toBe(1)

    b(b() + 5)
    expect(merged.foo).toBe(15)
  })

  it('allows manual wrapping via public prop alias for dynamic objects', () => {
    let count = createSignal(1)
    const dyn = () => ({ value: prop(() => count()) })
    const merged = mergeProps(dyn())

    expect(merged.value).toBe(1)
    count(count() + 1)
    expect(merged.value).toBe(2)
  })
})
