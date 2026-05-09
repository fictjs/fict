import { describe, it, expect } from 'vitest'

import * as plus from '../src/plus'
import * as fict from '../src'
import * as slim from '../src/slim'

describe('fict/plus exports', () => {
  it('exposes resource, lazy, and compatibility aliases', () => {
    expect(plus.resource).toBeTypeOf('function')
    expect(plus.lazy).toBeTypeOf('function')
    expect(plus.$store).toBeTypeOf('function')
    expect(plus.$memo).toBeTypeOf('function')
  })
})

describe('fict main exports', () => {
  it('exposes untrack', () => {
    expect(fict.untrack).toBeTypeOf('function')
  })

  it('exposes transition scheduling helpers', () => {
    expect(fict.startTransition).toBeTypeOf('function')
    expect(fict.useTransition).toBeTypeOf('function')
    expect(fict.useDeferredValue).toBeTypeOf('function')
  })
})

describe('fict/slim exports', () => {
  it('exposes compiler macros only', () => {
    expect(slim.$state).toBeTypeOf('function')
    expect(slim.$effect).toBeTypeOf('function')
  })
})

describe('compiler macro diagnostics', () => {
  it('explains uncompiled macro calls in development', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    try {
      expect(() => fict.$state(0)).toThrow(
        '$state() is a Fict compile-time macro that ran at runtime because this file was not transformed',
      )
      expect(() => slim.$effect(() => {})).toThrow(
        '$effect() is a Fict compile-time macro that ran at runtime because this file was not transformed',
      )
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  it('uses a short uncompiled macro code in production', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      expect(() => fict.$state(0)).toThrow('FICT_E_UNCOMPILED')
      expect(() => slim.$effect(() => {})).toThrow('FICT_E_UNCOMPILED')
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})
