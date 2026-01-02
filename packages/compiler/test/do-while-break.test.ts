import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('loop break/continue fix verification', () => {
  describe('do-while', () => {
    it('should handle break inside do-while body', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let i = $state(0)
          do {
            if (i > 5) break
            i++
          } while (i < 10)
          return i
        }
      `
      expect(() => transform(source)).not.toThrow()
    })

    it('should handle continue inside do-while body (simple)', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let i = $state(0)
          do {
            i++
            if (i === 3) continue
          } while (i < 5)
          return i
        }
      `
      expect(() => transform(source)).not.toThrow()
    })
  })

  describe('while', () => {
    it('should handle break inside while body', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let i = $state(0)
          while (i < 10) {
            if (i > 5) break
            i++
          }
          return i
        }
      `
      expect(() => transform(source)).not.toThrow()
    })

    it('should handle continue inside while body', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let i = $state(0)
          while (i < 10) {
            i++
            if (i === 3) continue
          }
          return i
        }
      `
      expect(() => transform(source)).not.toThrow()
    })
  })

  describe('for', () => {
    it('should handle break inside for body', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let sum = $state(0)
          for (let i = 0; i < 10; i++) {
            if (i > 5) break
            sum += i
          }
          return sum
        }
      `
      expect(() => transform(source)).not.toThrow()
    })

    it('should handle continue inside for body', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let sum = $state(0)
          for (let i = 0; i < 10; i++) {
            if (i === 3) continue
            sum += i
          }
          return sum
        }
      `
      expect(() => transform(source)).not.toThrow()
    })
  })
})
