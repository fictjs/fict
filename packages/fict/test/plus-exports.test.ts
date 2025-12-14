import { describe, it, expect } from 'vitest'

import * as plus from '../src/plus'

describe('fict/plus exports', () => {
  it('exposes untrack', () => {
    expect(plus.untrack).toBeTypeOf('function')
  })

  it('exposes transition scheduling helpers', () => {
    expect(plus.startTransition).toBeTypeOf('function')
    expect(plus.transition).toBe(plus.startTransition)
    expect(plus.useTransition).toBeTypeOf('function')
    expect(plus.useDeferredValue).toBeTypeOf('function')
  })
})
