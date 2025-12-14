import { describe, expect, it } from 'vitest'

import { transformFineGrained } from './test-utils'

const transform = (source: string): string => {
  return transformFineGrained(source)
}

describe('Condition hoisting respects function scope', () => {
  it('does not hoist conditions inside arrow function bodies', () => {
    const input = `
      import { $state } from 'fict'
      const count = $state(0)
      const handler = () => (count > 0 ? 'yes' : 'no')
    `
    const output = transform(input)
    // Should not generate hoisted __fictCond for the inner arrow
    expect(output).not.toMatch(/__fictCond_\d+ = count\(\) > 0/)
    // Inner ternary should still reference count() directly
    expect(output).toContain("count() > 0 ? 'yes' : 'no'")
  })

  it('hoists region-level conditions but not nested callbacks', () => {
    const input = `
      import { $state } from 'fict'
      const count = $state(0)
      const label = count > 0 ? 'pos' : 'neg'
      const list = [1,2,3].map(n => (count > n ? n : -n))
    `
    const output = transform(input)
    // Region-level condition should be hoisted
    expect(output).toMatch(/const __fictCond_\d+ = count\(\) > 0/)
    // Nested callback condition should remain inline
    expect(output).toMatch(/n =>\s*\(?count\(\) > n \? n : -n\)?/)
  })
})
