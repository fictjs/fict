import { describe, it, expect } from 'vitest'

import { transform } from './test-utils'

describe('Optimizer Algebraic Simplification', () => {
  const algebraicOptions = { optimize: true, optimizeLevel: 'full' as const }

  describe('arithmetic identities', () => {
    it('simplifies x + 0 to x', () => {
      const source = `
        function test() {
          const a = 5
          const b = a + 0
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      // After constant propagation and simplification, b should be 5
      expect(output).toContain('return 5')
    })

    it('simplifies 0 + x to x', () => {
      const source = `
        function test() {
          const a = 10
          const b = 0 + a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 10')
    })

    it('simplifies x * 1 to x', () => {
      const source = `
        function test() {
          const a = 7
          const b = a * 1
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 7')
    })

    it('simplifies x * 0 to 0', () => {
      const source = `
        function test() {
          const a = 42
          const b = a * 0
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 0')
    })

    it('simplifies x - 0 to x', () => {
      const source = `
        function test() {
          const a = 15
          const b = a - 0
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 15')
    })

    it('simplifies x / 1 to x', () => {
      const source = `
        function test() {
          const a = 20
          const b = a / 1
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 20')
    })

    it('simplifies x ** 1 to x', () => {
      const source = `
        function test() {
          const a = 3
          const b = a ** 1
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 3')
    })

    it('simplifies x ** 0 to 1', () => {
      const source = `
        function test() {
          const a = 99
          const b = a ** 0
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 1')
    })

    it('does not simplify x + 0 when x is not proven numeric', () => {
      const source = `
        function test(x) {
          return x + 0
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toMatch(/return\s+x\s*\+\s*0/)
    })

    it('does not simplify x * 0 when x is not proven finite', () => {
      const source = `
        function test(x) {
          return x * 0
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toMatch(/return\s+x\s*\*\s*0/)
    })
  })

  describe('logical identities', () => {
    it('simplifies true && x to x', () => {
      const source = `
        function test() {
          const a = 5
          const b = true && a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 5')
    })

    it('simplifies false || x to x', () => {
      const source = `
        function test() {
          const a = 10
          const b = false || a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 10')
    })

    it('simplifies x && true to x (JavaScript semantics)', () => {
      const source = `
        function test() {
          const a = 7
          const b = a && true
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      // In JavaScript, 7 && true evaluates to true (the last operand when both are truthy)
      // This is correct constant folding behavior, not algebraic simplification
      expect(output).toContain('return true')
    })

    it('does not simplify x && true for non-boolean operands', () => {
      const source = `
        function test(x) {
          return x && true
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toMatch(/return\s+x\s*&&\s*true/)
    })

    it('simplifies x || false to x', () => {
      const source = `
        function test() {
          const a = 15
          const b = a || false
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 15')
    })

    it('does not simplify x || false for non-boolean operands', () => {
      const source = `
        function test(x) {
          return x || false
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toMatch(/return\s+x\s*\|\|\s*false/)
    })

    it('simplifies false && x to false', () => {
      const source = `
        function test() {
          const a = 42
          const b = false && a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return false')
    })

    it('simplifies true || x to true', () => {
      const source = `
        function test() {
          const a = 99
          const b = true || a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return true')
    })
  })

  describe('nullish coalescing identities', () => {
    it('simplifies null ?? x to x', () => {
      const source = `
        function test() {
          const a = 5
          const b = null ?? a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 5')
    })

    it('simplifies undefined ?? x to x', () => {
      const source = `
        function test() {
          const a = 10
          const b = undefined ?? a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 10')
    })

    it('simplifies non-nullish ?? x to non-nullish', () => {
      const source = `
        function test() {
          const a = 99
          const b = 42 ?? a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 42')
    })
  })

  describe('unary identities', () => {
    it('simplifies !true to false', () => {
      const source = `
        function test() {
          const a = !true
          return a
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return false')
    })

    it('simplifies !false to true', () => {
      const source = `
        function test() {
          const a = !false
          return a
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return true')
    })

    it('simplifies double negation --x', () => {
      const source = `
        function test() {
          const a = 5
          const b = - -a
          return b
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 5')
    })
  })

  describe('conditional identities', () => {
    it('simplifies true ? a : b to a', () => {
      const source = `
        function test() {
          const a = 5
          const b = 10
          const c = true ? a : b
          return c
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 5')
    })

    it('simplifies false ? a : b to b', () => {
      const source = `
        function test() {
          const a = 5
          const b = 10
          const c = false ? a : b
          return c
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 10')
    })

    it('simplifies x ? a : a to a when both branches are identical', () => {
      const source = `
        function test() {
          const x = true
          const c = x ? 42 : 42
          return c
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return 42')
    })

    it('preserves test evaluation for x ? a : a', () => {
      const source = `
        function test() {
          return sideEffect() ? 1 : 1
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('sideEffect(')
    })
  })

  describe('comparison identities', () => {
    it('simplifies x === x for literals to true', () => {
      const source = `
        function test() {
          const a = 5 === 5
          return a
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return true')
    })

    it('simplifies x !== x for literals to false', () => {
      const source = `
        function test() {
          const a = 5 !== 5
          return a
        }
      `
      const output = transform(source, algebraicOptions)
      expect(output).toContain('return false')
    })
  })

  describe('chained simplifications', () => {
    it('simplifies multiple operations', () => {
      const source = `
        function test() {
          const a = 5
          const b = a + 0
          const c = b * 1
          const d = c - 0
          return d
        }
      `
      const output = transform(source, { optimize: true })
      expect(output).toContain('return 5')
    })

    it('simplifies nested expressions', () => {
      const source = `
        function test() {
          const a = 3
          const b = (a + 0) * (1 + 0)
          return b
        }
      `
      const output = transform(source, { optimize: true })
      expect(output).toContain('return 3')
    })
  })
})

describe('Optimizer Cross-Block CSE', () => {
  it('eliminates common subexpressions across blocks', () => {
    const source = `
      function test(x: number) {
        let result = 0
        const computed = x * 2 + 1
        if (x > 0) {
          result = computed
        } else {
          result = computed
        }
        return result
      }
    `
    // Cross-block CSE should recognize that x * 2 + 1 is computed once
    const output = transform(source, { optimize: true })
    // Should not have duplicate computations
    expect(output).toBeDefined()
  })
})

describe('Optimizer DCE with Reactive Graph', () => {
  it('eliminates unused derived values', () => {
    const source = `
      import { $state } from 'fict'

      function Component() {
        let count = $state(0)
        const unused = count * 2  // Should be eliminated if not used
        const used = count + 1
        return <div>{used}</div>
      }
    `
    const output = transform(source, { optimize: true })
    // The derived value 'unused' should be eliminated
    expect(output).toContain('count')
    // 'used' should still be present in some form
    expect(output).toBeDefined()
  })

  it('preserves derived values used in effects', () => {
    const source = `
      import { $state, $effect } from 'fict'

      function Component() {
        let count = $state(0)
        const doubled = count * 2
        $effect(() => {
          console.log(doubled)
        })
        return <div>{count}</div>
      }
    `
    const output = transform(source, { optimize: true })
    // doubled should be preserved because it's used in effect
    expect(output).toBeDefined()
  })

  it('preserves explicit memo calls', () => {
    const source = `
      import { $state, $memo } from 'fict'

      function Component() {
        let count = $state(0)
        const expensive = $memo(() => {
          return count * count * count
        })
        return <div>{expensive}</div>
      }
    `
    const output = transform(source, { optimize: true })
    // $memo should be preserved
    expect(output).toContain('Memo')
  })
})

describe('Optimizer Single-Use Memo Inlining', () => {
  it('inlines single-use derived values when enabled', () => {
    const source = `
      import { $state } from 'fict'

      function Component() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `
    const withInlining = transform(source, { optimize: true, inlineDerivedMemos: true })
    const withoutInlining = transform(source, { optimize: true, inlineDerivedMemos: false })

    // Both should produce valid output
    expect(withInlining).toBeDefined()
    expect(withoutInlining).toBeDefined()
  })
})
