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

  it('exports callable compiler helpers with function shape', () => {
    const runtime = internal as Record<string, unknown>
    const uniqueHelpers = new Set(Object.values(RUNTIME_HELPERS))
    uniqueHelpers.delete('Fragment')

    for (const helperName of uniqueHelpers) {
      expect(typeof runtime[helperName]).toBe('function')
    }
  })

  it('keeps signal/memo/effect helper contracts usable', () => {
    const count = internal.createSignal(1)
    expect(typeof count).toBe('function')
    expect(count()).toBe(1)

    const doubled = internal.createMemo(() => count() * 2)
    expect(doubled()).toBe(2)

    count(3)
    expect(doubled()).toBe(6)

    const dispose = internal.createEffect(() => {
      void doubled()
    })
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
