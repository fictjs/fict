import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('optimizer semantics safety', () => {
  it('keeps logical AND with true in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x && true
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*&&\s*true/)
  })

  it('keeps logical OR with false in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x || false
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\|\|\s*false/)
  })

  it('keeps additive identity in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x + 0
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\+\s*0/)
  })

  it('preserves conditional test evaluation when branches are identical in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return check(x) ? 1 : 1
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/check\(x\)/)
    expect(output).toMatch(/\?\s*1\s*:\s*1/)
  })

  it('allows algebraic simplification in full mode', () => {
    const output = transform(
      `
        function foo(x) {
          const k = 1
          const result = true && x
          return result + k
        }
      `,
      { optimizeLevel: 'full' },
    )

    expect(output).not.toMatch(/true\s*&&/)
    expect(output).toMatch(/return\s+x/)
  })
})
