import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('Debug loop lowering', () => {
  it('should handle for loop correctly', () => {
    const source = `
      function heavy(n: number) {
        let total = 0
        for (let i = 0; i < n; i++) {
          total += i
        }
        return total
      }
    `
    const output = transform(source, { optimize: true })
    expect(output).toContain('let i')
    expect(output).toContain('i < n')
    expect(output).toContain('total += i')
  })
})
