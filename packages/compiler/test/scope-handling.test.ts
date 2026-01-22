import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('Scope Handling', () => {
  describe('Block-scoped variables should not leak', () => {
    it('should not expose const declared inside if block', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let result

          if (count > 0) {
            const temp = count * 2
            result = temp + 1
          }
          return result
        }
      `
      const output = transform(input)

      // temp should be memoized inside if block, not exposed outside
      expect(output).not.toContain('const temp = () =>')
      // result is assigned but not in a region (only one output)
      expect(output).toMatch(/result/)
    })

    it('should not expose let declared inside if block', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let result

          if (count > 0) {
            let temp = count * 2
            result = temp + 1
          }
          return result
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const temp = () =>')
      expect(output).toMatch(/result/)
    })

    it('should not expose variables declared inside switch cases', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
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
          return result
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const tempA = () =>')
      expect(output).not.toContain('const tempB = () =>')
    })

    it('should handle nested blocks correctly', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let result

          if (count > 0) {
            const outer = count * 2
            if (outer > 10) {
              const inner = outer + 1
              result = inner
            }
          }
          return result
        }
      `
      const output = transform(input)

      expect(output).not.toContain('const outer = () =>')
      expect(output).not.toContain('const inner = () =>')
    })
  })

  describe('Top-level variables should be exposed', () => {
    it('inlines top-level derived const declarations by default', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          const tripled = count * 3
          return doubled + tripled
        }
      `
      const output = transform(input)

      expect(output).toContain('count() * 2')
      expect(output).toContain('count() * 3')
    })

    it('should expose let variables assigned in if blocks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let a
          let b

          if (count > 0) {
            a = count * 2
            b = count * 3
          }
          return a ?? b
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
        function Component() {
          let count = $state(0)
          const value = 'outer'
          let result

          if (count > 0) {
            const value = 'inner'
            result = value + count
          }
          return result
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
        function Component() {
          let count = $state(0)
          const topLevel = count * 2
          let result

          if (count > 0) {
            const blockLevel = topLevel + 1
            result = blockLevel + count
          }
          return result
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
        function Component() {
          let items = $state([1, 2, 3])
          let sum = 0

          for (const item of items) {
            const doubled = item * 2
            sum += doubled
          }
          return sum
        }
      `
      const output = transform(input)

      // Loop variables should not be exposed
      expect(output).not.toContain('const item = ()')
      expect(output).toContain('const doubled = () =>')
    })
  })
})
