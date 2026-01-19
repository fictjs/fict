import { describe, it, expect } from 'vitest'

import * as plus from '../src/plus'
import * as fict from '../src'
import * as slim from '../src/slim'

describe('fict/plus exports', () => {
  it('exposes resource and lazy', () => {
    expect(plus.resource).toBeTypeOf('function')
    expect(plus.lazy).toBeTypeOf('function')
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
