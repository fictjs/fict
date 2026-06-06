import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createElement, mergeProps, prop, render } from '../src/index'
import { createSignal, reactive } from '../src/advanced'
import {
  __fictProp,
  __fictPropsRest,
  bindText,
  spread,
  createPropsProxy,
  isReactive,
} from '../src/internal'

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

  it('exposes vnode keys through frozen, sealed, and non-extensible component props', () => {
    const sealed = Object.seal({ value: 'sealed' })
    const nonExtensible = { value: 'non-extensible' }
    Object.preventExtensions(nonExtensible)
    const variants: Array<{ props: Record<string, unknown>; value: string }> = [
      { props: Object.freeze({ value: 'frozen' }), value: 'frozen' },
      { props: sealed, value: 'sealed' },
      { props: nonExtensible, value: 'non-extensible' },
    ]

    for (const variant of variants) {
      let seen:
        | {
            key: unknown
            keys: PropertyKey[]
            descriptor: PropertyDescriptor | undefined
          }
        | undefined
      const vnodeKey = `${variant.value}-key`
      const Child = (props: Record<string, unknown>) => {
        seen = {
          key: props.key,
          keys: Reflect.ownKeys(props),
          descriptor: Object.getOwnPropertyDescriptor(props, 'key'),
        }
        return `${props.key}:${props.value}`
      }

      const node = createElement({ type: Child, props: variant.props, key: vnodeKey })

      expect(node.textContent).toBe(`${vnodeKey}:${variant.value}`)
      expect(seen?.key).toBe(vnodeKey)
      expect(seen?.keys).toEqual(expect.arrayContaining(['key', 'value']))
      expect(seen?.descriptor).toEqual({
        value: vnodeKey,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  })

  it('exposes vnode keys when raw props already own a non-configurable key', () => {
    const rawProps: Record<string, unknown> = { value: 'x' }
    Object.defineProperty(rawProps, 'key', {
      value: 'raw-key',
      enumerable: true,
      configurable: false,
      writable: false,
    })
    Object.preventExtensions(rawProps)

    let seen:
      | {
          key: unknown
          keys: PropertyKey[]
        }
      | undefined
    const Child = (props: Record<string, unknown>) => {
      seen = {
        key: props.key,
        keys: Reflect.ownKeys(props),
      }
      return `${props.key}:${props.value}`
    }

    const node = createElement({ type: Child, props: rawProps, key: 'vnode-key' })

    expect(node.textContent).toBe('vnode-key:x')
    expect(seen?.key).toBe('vnode-key')
    expect(seen?.keys.filter(key => key === 'key')).toHaveLength(1)
    expect(rawProps.key).toBe('raw-key')
  })

  it('marks plain zero-arg callback props as non-reactive', () => {
    const callback = () => 42
    const proxied = createPropsProxy({ callback })
    const resolved = proxied.callback as unknown

    expect(typeof resolved).toBe('function')
    expect(isReactive(resolved)).toBe(false)
    expect((resolved as () => number)()).toBe(42)
  })

  it('exposes prop getter descriptor values through props proxy', () => {
    const count = createSignal(1)
    const proxied = createPropsProxy({ value: __fictProp(() => count()) })

    expect(Object.getOwnPropertyDescriptor(proxied, 'value')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })

    count(2)

    expect(Object.getOwnPropertyDescriptors(proxied).value).toEqual({
      value: 2,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  })

  it('unwraps frozen prop-getter data properties without violating proxy invariants', () => {
    const count = createSignal(1)
    const raw = Object.freeze({ value: __fictProp(() => count()) })
    const proxied = createPropsProxy(raw)

    expect(proxied.value).toBe(1)
    expect(Object.getOwnPropertyDescriptor(proxied, 'value')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })

    count(2)

    expect(proxied.value).toBe(2)
    expect(Object.getOwnPropertyDescriptor(proxied, 'value')?.value).toBe(2)
  })

  it('unwraps non-configurable prop-getter data properties without invariant errors', () => {
    const count = createSignal(1)
    const raw: Record<string, unknown> = {}
    Object.defineProperty(raw, 'value', {
      value: __fictProp(() => count()),
      enumerable: true,
      configurable: false,
      writable: false,
    })
    const proxied = createPropsProxy(raw)

    expect(proxied.value).toBe(1)
    expect(Object.getOwnPropertyDescriptor(proxied, 'value')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })

    count(2)

    expect(proxied.value).toBe(2)
  })

  it('unwraps sealed prop-getter data properties without invariant errors', () => {
    const count = createSignal(1)
    const raw = Object.seal({ value: __fictProp(() => count()) })
    const proxied = createPropsProxy(raw)

    expect(proxied.value).toBe(1)

    count(2)

    expect(proxied.value).toBe(2)
  })

  it('unwraps prop getters returned by accessor props', () => {
    const count = createSignal(1)
    const raw = {
      get value() {
        return __fictProp(() => count())
      },
    }
    const proxied = createPropsProxy(raw)

    expect(proxied.value).toBe(1)
    expect(Object.getOwnPropertyDescriptor(proxied, 'value')?.get).toBeTypeOf('function')

    count(2)

    expect(proxied.value).toBe(2)
  })

  it('marks callback props without adding own symbols', () => {
    const callback = () => 42
    const proxied = createPropsProxy({ callback })
    const marker = Symbol.for('fict:non-reactive-fn')

    expect(Object.getOwnPropertySymbols(callback)).not.toContain(marker)
    expect(Object.getOwnPropertyDescriptor(proxied, 'callback')?.value).toBe(callback)

    const resolved = proxied.callback as unknown

    expect(resolved).toBe(callback)
    expect(isReactive(resolved)).toBe(false)
    expect(Object.getOwnPropertySymbols(callback)).not.toContain(marker)
  })

  it('preserves explicitly reactive getter props', () => {
    const getter = reactive(() => 42)
    const proxied = createPropsProxy({ getter })
    const resolved = proxied.getter as unknown

    expect(resolved).toBe(getter)
    expect(isReactive(resolved)).toBe(true)
    expect((resolved as () => number)()).toBe(42)
  })

  it('marks frozen zero-arg callback props as non-reactive', () => {
    const callback = Object.freeze(() => 42)
    const proxied = createPropsProxy({ callback })
    const resolved = proxied.callback as unknown

    expect(typeof resolved).toBe('function')
    expect(isReactive(resolved)).toBe(false)
    expect((resolved as () => number)()).toBe(42)
  })

  it('does not execute function children passed through component props', () => {
    let called = 0
    const slot = () => {
      called += 1
      return { type: 'span', props: { children: 'slot' } }
    }

    const Child = (props: Record<string, unknown>) => {
      return { type: 'section', props: { children: props.children }, key: undefined }
    }

    const dispose = render(
      () => createElement({ type: Child, props: { children: slot }, key: undefined }),
      container,
    )

    expect(called).toBe(0)
    expect(container.querySelector('section')).toBeTruthy()
    expect(container.querySelector('span')).toBeNull()
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

  it('mergeProps orders numeric and symbol keys like object spread', () => {
    const sym = Symbol('s')
    const a = { 2: 'two', [sym]: 'sym', a: 'a' }
    const b = { 1: 'one', b: 'b' }
    const merged = mergeProps(a, b)
    const native = { ...a, ...b }

    expect(Object.keys(merged)).toEqual(Object.keys(native))
    expect(Reflect.ownKeys(merged)).toEqual(Reflect.ownKeys(native))
    expect((merged as Record<string, unknown>)[2]).toBe('two')
    expect((merged as Record<string, unknown>)[1]).toBe('one')
    expect((merged as Record<symbol, unknown>)[sym]).toBe('sym')
  })

  it('mergeProps exposes spread props as data descriptors', () => {
    let reads = 0
    const source = {
      x: 1,
      get y() {
        reads++
        return 2
      },
    }
    const merged = createPropsProxy(mergeProps(source, { z: 3 }))

    const x = Object.getOwnPropertyDescriptor(merged, 'x')
    const y = Object.getOwnPropertyDescriptor(merged, 'y')

    expect(x).toEqual({ value: 1, writable: true, enumerable: true, configurable: true })
    expect(y).toEqual({ value: 2, writable: true, enumerable: true, configurable: true })
    expect(reads).toBeGreaterThan(0)
  })

  it('mergeProps ignores non-enumerable spread properties', () => {
    const hidden = {}
    const hiddenSymbol = Symbol('hidden')
    const visibleSymbol = Symbol('visible')
    Object.defineProperties(hidden, {
      secret: { value: 'x', enumerable: false },
      [hiddenSymbol]: { value: 'hidden-symbol', enumerable: false },
      [visibleSymbol]: { value: 'visible-symbol', enumerable: true },
    })

    const merged = mergeProps(hidden, { visible: 'y' })

    expect(Object.keys(merged)).toEqual(['visible'])
    expect(Reflect.ownKeys(merged)).toEqual(['visible', visibleSymbol])
    expect('secret' in merged).toBe(false)
    expect(hiddenSymbol in merged).toBe(false)
    expect((merged as Record<string, unknown>).secret).toBeUndefined()
    expect((merged as Record<symbol, unknown>)[hiddenSymbol]).toBeUndefined()
    expect((merged as Record<symbol, unknown>)[visibleSymbol]).toBe('visible-symbol')
    expect(Object.getOwnPropertyDescriptor(merged, 'secret')).toBeUndefined()
  })

  it('mergeProps re-checks enumerability for dynamic sources', () => {
    const source = createSignal<Record<string, unknown>>(
      Object.defineProperty({}, 'secret', { value: 'x', enumerable: false }),
    )
    const merged = createPropsProxy(
      mergeProps(
        __fictProp(() => source()),
        { visible: 'y' },
      ),
    )

    expect(Object.keys(merged)).toEqual(['visible'])
    expect((merged as Record<string, unknown>).secret).toBeUndefined()

    source({ secret: 'shown' })

    expect(Object.keys(merged)).toEqual(['secret', 'visible'])
    expect((merged as Record<string, unknown>).secret).toBe('shown')
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

    const merged = createPropsProxy(mergeProps(__fictProp(dynamicSource)))

    expect(merged.a).toBe(1)
    value(2)
    expect(merged.a).toBe(2)
  })

  it('handles multiple dynamic sources with override order', () => {
    const first = createSignal(1)
    const second = createSignal(10)

    const merged = createPropsProxy(
      mergeProps(
        __fictProp(() => ({ value: first() })),
        __fictProp(() => ({ value: second() })),
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

    const merged = createPropsProxy(mergeProps(__fictProp(dynamicSource)))

    expect(merged[sym]).toBe('initial')
    value('updated')
    expect(merged[sym]).toBe('updated')
  })

  it('spreads function objects returned by dynamic sources', () => {
    const sym = Symbol('fn')
    const first = Object.assign(() => 'first', { x: 1, [sym]: 'one' })
    const second = Object.assign(() => 'second', { x: 2, [sym]: 'two' })
    const source = createSignal<Record<string | symbol, unknown> | (() => string)>({ x: 0 })
    const merged = createPropsProxy(
      mergeProps(
        __fictProp(() => source()),
        { y: 3 },
      ),
    )

    expect(Object.keys(merged)).toEqual(['x', 'y'])
    expect(merged.x).toBe(0)

    source(first)

    expect(Object.keys(merged)).toEqual(['x', 'y'])
    expect(Reflect.ownKeys(merged)).toEqual(['x', 'y', sym])
    expect(merged.x).toBe(1)
    expect((merged as Record<symbol, unknown>)[sym]).toBe('one')

    source(second)

    expect(merged.x).toBe(2)
    expect((merged as Record<symbol, unknown>)[sym]).toBe('two')
    expect(merged.y).toBe(3)
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
      mergeProps(
        { static: 'value' },
        __fictProp(() => ({ dynamic: dynamic() })),
        { override: true },
      ),
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

  it('treats unmarked function sources as spread objects', () => {
    let calls = 0
    const source = Object.assign(
      () => {
        calls += 1
        return { foo: 'return' }
      },
      { foo: 'own' },
    )

    const merged = createPropsProxy(
      mergeProps(source as unknown as Record<string, unknown>, { bar: 'b' }),
    )

    expect(Object.keys(merged)).toEqual(['foo', 'bar'])
    expect(merged.foo).toBe('own')
    expect(merged.bar).toBe('b')
    expect(calls).toBe(0)
  })

  it('applies ToObject semantics to primitive sources', () => {
    const merged = mergeProps('ab', { x: 'x' }, 42, false, 1n, Symbol('s'))

    expect(Object.keys(merged)).toEqual(['0', '1', 'x'])
    expect(merged[0]).toBe('a')
    expect(merged[1]).toBe('b')
    expect(merged.x).toBe('x')

    const empty = mergeProps(42, true, 1n, Symbol('empty'))
    expect(Object.keys(empty)).toEqual([])
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

  it('copies enumerable __proto__ as an own data prop without changing rest prototype', () => {
    const payload = { polluted: true }
    const base = { ['__proto__']: payload, keep: 1, constructor: 'ctor', toString: 'text' }

    const rest = __fictPropsRest(base, ['keep'])

    expect(Object.prototype.hasOwnProperty.call(rest, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(rest)).toBe(Object.prototype)
    expect((rest as Record<string, unknown>).__proto__).toBe(payload)
    expect(rest.constructor).toBe('ctor')
    expect(rest.toString).toBe('text')
    expect(Object.keys(rest)).toEqual(['__proto__', 'constructor', 'toString'])
  })

  it('skips non-enumerable keys for props rest', () => {
    const visibleSymbol = Symbol('visible')
    const hiddenSymbol = Symbol('hidden')
    const base = Object.defineProperties(
      { visible: 1, [visibleSymbol]: 2 },
      {
        hidden: { value: 3, enumerable: false },
        [hiddenSymbol]: { value: 4, enumerable: false },
      },
    )

    const rest = __fictPropsRest(base, [])

    expect(Object.prototype.hasOwnProperty.call(rest, 'hidden')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(rest, hiddenSymbol)).toBe(false)
    expect(rest.visible).toBe(1)
    expect((rest as Record<symbol, unknown>)[visibleSymbol]).toBe(2)
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
