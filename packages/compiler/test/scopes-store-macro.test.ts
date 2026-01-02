import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('scope analysis excludes $store macro callee', () => {
  it('does not treat $store as a dependency read', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ x: 1 })
        return store.x
      }
    `)

    // If $store were treated as a read dependency, we might see extra memoization on the call.
    // We only care that the transform succeeds and does not wrap the $store callee in memo.
    expect(output).toContain(`const store = $store`)
    expect(output).not.toContain(`__fictUseMemo(__fictCtx, () => $store`)
  })
})
