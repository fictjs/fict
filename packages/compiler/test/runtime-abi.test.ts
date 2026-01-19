import { describe, expect, it } from 'vitest'

import { RUNTIME_HELPERS } from '../src/constants'
import * as internal from '../../runtime/src/internal'

describe('runtime/internal ABI', () => {
  it('exports all compiler-required helpers', () => {
    const missing = Object.values(RUNTIME_HELPERS).filter(
      name => !(name in (internal as Record<string, unknown>)),
    )

    expect(missing).toEqual([])
  })
})
