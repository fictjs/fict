import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer } from '../index'

const transform = (source: string): string => {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer()],
    },
  })
  return result.outputText
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
    expect(output).toContain('n => (count() > n ? n : -n)')
  })
})
