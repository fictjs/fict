import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createElement, mergeProps, prop, render } from '../src/index'
import { createSignal } from '../src/advanced'
import { __fictProp, __fictPropsRest, bindText, spread, createPropsProxy } from '../src/internal'

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

    // mergeProps preserves getters - wrap in createPropsProxy to auto-unwrap
    const merged = createPropsProxy(
      mergeProps({ foo: __fictProp(() => a()) }, { bar: 1 }, { foo: __fictProp(() => b()) }),
    )

    expect(merged.foo).toBe(10) // last wins, createPropsProxy unwraps getter
    expect(merged.bar).toBe(1)

    b(b() + 5)
    expect(merged.foo).toBe(15)
  })

  it('allows manual wrapping via prop for dynamic objects', () => {
    let count = createSignal(1)
    const dyn = () => ({ value: prop(() => count()) })
    // mergeProps preserves getters - wrap in createPropsProxy to auto-unwrap
    const merged = createPropsProxy(mergeProps(dyn()))

    expect(merged.value).toBe(1)
    count(count() + 1)
    expect(merged.value).toBe(2)
  })

  it('mergeProps uses lazy lookup - only accessed props are evaluated', () => {
    let aCallCount = 0
    let bCallCount = 0

    const merged = createPropsProxy(
      mergeProps(
        {
          a: __fictProp(() => {
            aCallCount++
            return 'a'
          }),
        },
        {
          b: __fictProp(() => {
            bCallCount++
            return 'b'
          }),
        },
      ),
    )

    // Neither getter has been called yet (lazy)
    expect(aCallCount).toBe(0)
    expect(bCallCount).toBe(0)

    // Access only 'a' - createPropsProxy unwraps and calls getter
    expect(merged.a).toBe('a')
    expect(aCallCount).toBe(1)
    expect(bCallCount).toBe(0)

    // Access 'b'
    expect(merged.b).toBe('b')
    expect(aCallCount).toBe(1)
    expect(bCallCount).toBe(1)
  })

  it('mergeProps handles has() check correctly', () => {
    const merged = mergeProps({ a: 1 }, { b: 2 })

    expect('a' in merged).toBe(true)
    expect('b' in merged).toBe(true)
    expect('c' in merged).toBe(false)
  })

  it('mergeProps handles ownKeys() correctly', () => {
    const merged = mergeProps({ a: 1, b: 2 }, { c: 3 })

    const keys = Object.keys(merged)
    expect(keys).toContain('a')
    expect(keys).toContain('b')
    expect(keys).toContain('c')
    expect(keys.length).toBe(3)
  })
})

describe('prop', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('memoizes expensive computations', async () => {
    let computeCount = 0
    const base = createSignal(10)

    const memoized = prop(() => {
      computeCount++
      return base() * 2
    })

    // First access - computes
    expect(memoized()).toBe(20)
    expect(computeCount).toBe(1)

    // Second access - uses cached value
    expect(memoized()).toBe(20)
    expect(computeCount).toBe(1)

    // Update dependency - recomputes on next access
    base(20)
    expect(memoized()).toBe(40)
    expect(computeCount).toBe(2)

    // Access again - uses cached value
    expect(memoized()).toBe(40)
    expect(computeCount).toBe(2)
  })

  it('auto-unwraps prop when passed through props', async () => {
    const Child = (props: Record<string, unknown>) => {
      const span = document.createElement('span')
      const text = document.createTextNode('')
      span.appendChild(text)
      bindText(text, () => String(props.data))
      return span
    }

    const Parent = () => {
      const base = createSignal(1)
      const memoized = prop(() => base() * 10)
      return {
        type: Child,
        props: { data: memoized },
        key: undefined,
      }
    }

    const dispose = render(
      () => createElement({ type: Parent, props: null, key: undefined }),
      container,
    )

    expect(container.textContent).toBe('10')
    dispose()
  })

  it('handles nested prop getters with unwrap option', () => {
    const inner = createSignal(5)
    const outer = prop(() => prop(() => inner()))

    // Default unwrap: true - should unwrap nested getter
    expect(outer()).toBe(5)

    inner(10)
    expect(outer()).toBe(10)
  })

  it('preserves nested prop getters with unwrap: false', () => {
    const inner = createSignal(5)
    const innerProp = prop(() => inner())
    const outer = prop(() => innerProp, { unwrap: false })

    // With unwrap: false, outer returns the inner prop getter
    const result = outer()
    expect(typeof result).toBe('function')
  })

  it('handles already-prop-wrapped input idempotently', () => {
    const base = createSignal(1)
    const memoized = prop(() => base())
    const wrapped = prop(memoized)

    // Should return same reference when already wrapped
    expect(wrapped).toBe(memoized)
  })
})

describe('mergeProps advanced', () => {
  it('handles dynamic source functions', () => {
    const value = createSignal(1)
    const dynamicSource = () => ({ a: value() })

    const merged = createPropsProxy(mergeProps(dynamicSource))

    expect(merged.a).toBe(1)
    value(2)
    expect(merged.a).toBe(2)
  })

  it('handles multiple dynamic sources with override order', () => {
    const first = createSignal(1)
    const second = createSignal(10)

    const merged = createPropsProxy(
      mergeProps(
        () => ({ value: first() }),
        () => ({ value: second() }),
      ),
    )

    expect(merged.value).toBe(10) // Last wins
    second(20)
    expect(merged.value).toBe(20)
  })

  it('handles Symbol keys correctly', () => {
    const sym = Symbol('test')
    const merged = mergeProps({ [sym]: 'value' })

    expect(merged[sym]).toBe('value')
    expect(sym in merged).toBe(true)

    const keys = Reflect.ownKeys(merged)
    expect(keys).toContain(sym)
  })

  it('handles dynamic source with Symbol keys', () => {
    const sym = Symbol('dynamic')
    const value = createSignal('initial')
    const dynamicSource = () => ({ [sym]: value() })

    const merged = createPropsProxy(mergeProps(dynamicSource))

    expect(merged[sym]).toBe('initial')
    value('updated')
    expect(merged[sym]).toBe('updated')
  })

  it('preserves null/undefined values correctly', () => {
    const merged = mergeProps({ a: null, b: undefined, c: 0, d: '' })

    expect(merged.a).toBe(null)
    expect(merged.b).toBe(undefined)
    expect(merged.c).toBe(0)
    expect(merged.d).toBe('')
    expect('b' in merged).toBe(true)
  })

  it('handles mixed static and dynamic sources', () => {
    const dynamic = createSignal(100)

    const merged = createPropsProxy(
      mergeProps({ static: 'value' }, () => ({ dynamic: dynamic() }), { override: true }),
    )

    expect(merged.static).toBe('value')
    expect(merged.dynamic).toBe(100)
    expect(merged.override).toBe(true)

    dynamic(200)
    expect(merged.dynamic).toBe(200)
  })

  it('returns empty object when no valid sources', () => {
    const merged = mergeProps(null, undefined)
    expect(Object.keys(merged).length).toBe(0)
  })

  it('returns source directly for single static source', () => {
    const source = { a: 1, b: 2 }
    const merged = mergeProps(source)

    expect(merged).toBe(source)
  })
})

describe('__fictPropsRest advanced', () => {
  it('excludes multiple keys correctly', () => {
    const base = { a: 1, b: 2, c: 3, d: 4 }
    const rest = __fictPropsRest(base, ['a', 'c'])

    expect('a' in rest).toBe(false)
    expect('c' in rest).toBe(false)
    expect(rest.b).toBe(2)
    expect(rest.d).toBe(4)
  })

  it('preserves prop getters in rest object', () => {
    const count = createSignal(0)
    const base = {
      excluded: 'skip',
      count: __fictProp(() => count()),
    }

    const rest = __fictPropsRest(base, ['excluded'])

    expect('excluded' in rest).toBe(false)
    expect(rest.count).toBe(0)

    count(5)
    expect(rest.count).toBe(5)
  })

  it('handles Symbol keys in exclusion', () => {
    const sym = Symbol('excluded')
    const base = { [sym]: 'secret', visible: 'public' }

    const rest = __fictPropsRest(base, [sym])

    expect(sym in rest).toBe(false)
    expect(rest.visible).toBe('public')
  })

  it('handles empty exclusion list', () => {
    const base = { a: 1, b: 2 }
    const rest = __fictPropsRest(base, [])

    expect(rest.a).toBe(1)
    expect(rest.b).toBe(2)
  })

  it('unwraps props proxy before processing', () => {
    const count = createSignal(1)
    const base = createPropsProxy({ value: __fictProp(() => count()) })
    const rest = __fictPropsRest(base, [])

    expect(rest.value).toBe(1)
    count(2)
    expect(rest.value).toBe(2)
  })
})
