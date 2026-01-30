import { describe, expect, it } from 'vitest'

import { createSignal } from '../src/advanced'
import { createPropsProxy, keyed } from '../src/props'

describe('keyed prop getters', () => {
  it('resolves dynamic keys from getter', () => {
    const obj = { a: 1, b: 2 }
    const key = createSignal('a')
    const getter = keyed(obj, () => key())

    expect(getter()).toBe(1)
    key('b')
    expect(getter()).toBe(2)
  })

  it('unwraps through props proxy', () => {
    const obj = { a: 10, b: 20 }
    const key = createSignal('a')
    const props = createPropsProxy({ value: keyed(obj, () => key()) })

    expect(props.value).toBe(10)
    key('b')
    expect(props.value).toBe(20)
  })

  it('matches obj[key] semantics for null/undefined targets', () => {
    const key = createSignal('a')
    const getterNull = keyed(null as unknown as Record<string, unknown>, () => key())
    const getterUndef = keyed(undefined as unknown as Record<string, unknown>, () => key())

    expect(() => getterNull()).toThrow(TypeError)
    expect(() => getterUndef()).toThrow(TypeError)
  })

  it('supports function targets', () => {
    function fn() {
      return 42
    }
    ;(fn as Record<string, unknown>).answer = 42
    const getter = keyed(fn as unknown as Record<string, unknown>, 'answer')
    expect(getter()).toBe(42)
  })
})
