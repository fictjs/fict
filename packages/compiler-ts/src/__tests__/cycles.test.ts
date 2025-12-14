import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer, type FictCompilerOptions } from '../index'

const transform = (source: string, options?: FictCompilerOptions) => {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: 'fict-runtime',
    },
    transformers: {
      before: [createFictTransformer(null, options)],
    },
  })
  return result.outputText
}

describe('Error/Cycle Protection', () => {
  it('detects simple cycle: a -> b -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + b
      const b = count + a
    `
    // Should throw compiler error
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects self-reference: a -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + a
    `
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects long cycle: a -> b -> c -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + b
      const b = c + 1
      const c = a + 1
    `
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('allows linear dependencies: a -> b -> c', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + 1
      const b = a + 1
      const c = b + 1
      console.log(c)
    `
    const output = transform(source)
    expect(output).toContain('const c =')
    expect(output).not.toContain('const c = c')
  })
})
