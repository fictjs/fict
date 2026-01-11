import { describe, it, expect } from 'vitest'

import * as plus from '../src/plus'
import * as fict from '../src'

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
