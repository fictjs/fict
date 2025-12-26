import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('Scope Handling', () => {
  describe('Block-scoped variables should not leak', () => {
    it('should not expose const declared inside if block', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        let result

        if (count > 0) {
          const temp = count * 2
          result = temp + 1
        }
      `
      const output = transform(input)

      // temp should be memoized inside if block, not exposed outside
      expect(output).not.toContain('const temp = () =>')
      // temp is memoized as a standalone memo inside the if block
      expect(output).toContain('const temp = __fictUseMemo')
      // result is assigned but not in a region (only one output)
      expect(output).toMatch(/result/)
    })

    it('should not expose let declared inside if block', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        let result

        if (count > 0) {
          let temp = count * 2
          result = temp + 1
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const temp = () =>')
      expect(output).toMatch(/result/)
    })

    it('should not expose variables declared inside switch cases', () => {
      const input = `
        import { $state } from 'fict'
        let mode = $state('a')
        let result

        switch (mode) {
          case 'a':
            const tempA = mode + '1'
            result = tempA
            break
          case 'b':
            const tempB = mode + '2'
            result = tempB
            break
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const tempA = () =>')
      expect(output).not.toContain('const tempB = () =>')
      // Variables inside switch are memoized locally
      expect(output).toContain('const tempA = __fictUseMemo')
      expect(output).toContain('const tempB = __fictUseMemo')
    })

    it('should handle nested blocks correctly', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        let result

        if (count > 0) {
          const outer = count * 2
          if (outer > 10) {
            const inner = outer + 1
            result = inner
          }
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const outer = () =>')
      expect(output).not.toContain('const inner = () =>')
      // Nested blocks variables are memoized locally
      expect(output).toContain('const outer = __fictUseMemo')
    })
  })

  describe('Top-level variables should be exposed', () => {
    it('should expose top-level const declarations', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const doubled = count * 2
        const tripled = count * 3
      `
      const output = transform(input)

      expect(output).toContain('const doubled = ')
      expect(output).toContain('const tripled = ')
    })

    it('should expose let variables assigned in if blocks', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        let a
        let b

        if (count > 0) {
          a = count * 2
          b = count * 3
        }
      `
      const output = transform(input)

      expect(output).toContain('a: a != undefined')
      expect(output).toContain('b: b != undefined')
    })
  })

  describe('Name collision prevention', () => {
    it('should not conflict when same name exists in different scopes', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const value = 'outer'
        let result

        if (count > 0) {
          const value = 'inner'
          result = value + count
        }
      `
      const output = transform(input)

      // Outer 'value' should be preserved
      expect(output).toContain('const value = "outer"')
      // Inner 'value' should not generate a getter
      expect(output).not.toContain('() => __fictRegion')
    })
  })

  describe('Complex scenarios', () => {
    it('should handle mix of top-level and block-scoped variables', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const topLevel = count * 2
        let result

        if (count > 0) {
          const blockLevel = topLevel + 1
          result = blockLevel + count
        }
      `
      const output = transform(input)

      // topLevel should be exposed (top-level const)
      expect(output).toContain('const topLevel =')
      // blockLevel should NOT be exposed
      expect(output).not.toContain('const blockLevel = ()')
    })

    it('should handle for loop scope correctly', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3])
        let sum = 0

        for (const item of items) {
          const doubled = item * 2
          sum += doubled
        }
      `
      const output = transform(input)

      // Loop variables should not be exposed
      expect(output).not.toContain('const item = ()')
      expect(output).not.toContain('const doubled = ()')
    })
  })
})
