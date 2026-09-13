import { describe, expect, expectTypeOf, it } from 'vitest'

import { $async } from '../src'
import { $async as slimAsync } from '../src/slim'

describe('explicit async compiler macro', () => {
  it('has resolved value types for promises, streams, undefined and functions', () => {
    const promised = () => $async(() => Promise.resolve(42))
    const streamed = () =>
      $async(() =>
        (async function* () {
          yield 'value'
        })(),
      )
    const empty = () => $async(() => Promise.resolve(undefined))
    const callable = () => $async(() => Promise.resolve((n: number) => n + 1))
    expectTypeOf(promised).returns.toEqualTypeOf<number>()
    expectTypeOf(streamed).returns.toEqualTypeOf<string>()
    expectTypeOf(empty).returns.toEqualTypeOf<undefined>()
    expectTypeOf(callable).returns.toEqualTypeOf<(n: number) => number>()
    const context = () =>
      slimAsync<number>(state => {
        expectTypeOf(state.signal).toEqualTypeOf<AbortSignal>()
        if (state.hasValue) expectTypeOf(state.previous).toEqualTypeOf<number>()
        else expectTypeOf(state.previous).toEqualTypeOf<undefined>()
        return Promise.resolve(1)
      })
    expectTypeOf(context).returns.toEqualTypeOf<number>()
  })

  it('fails clearly if either entrypoint runs without compilation', () => {
    const prior = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'development'
      for (const macro of [$async, slimAsync]) {
        expect(() => macro(() => 1)).toThrow('$async() is a Fict compile-time macro')
      }
      process.env.NODE_ENV = 'production'
      expect(() => $async(() => 1)).toThrow('FICT_E_UNCOMPILED')
    } finally {
      process.env.NODE_ENV = prior
    }
  })
})
