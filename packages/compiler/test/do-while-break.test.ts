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

    it('rejects continue in reactive do-while bodies before a return', () => {
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
      expect(() => transform(source)).toThrow(/Unsafe reactive loop return/)
    })
  })

  describe('while', () => {
    it('rejects break in reactive while bodies before a return', () => {
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
      expect(() => transform(source)).toThrow(/Unsafe reactive loop return/)
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
    it('rejects break in reactive for bodies before a return', () => {
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
      expect(() => transform(source)).toThrow(/Unsafe reactive loop return/)
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
