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

describe('Fragment Lowering', () => {
  it('compiles nested fragment as transparent container', () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        return (
          <div>
            <>
              <span>A</span>
              <span>B</span>
            </>
          </div>
        )
      }
    `
    const output = transform(source, { fineGrainedDom: true })

    // Should NOT fallback to VDOM (jsx/jsxs calls)
    // Should use fine-grained DOM operations
    expect(output).toContain('document.createElement("span")')
    expect(output).toContain('appendChild')
    expect(output).not.toContain('jsx(')
    expect(output).not.toContain('jsxs(')
  })

  it('compiles multiple nested fragments', () => {
    const source = `
      export function App() {
        return (
          <div>
            <>
              <span>A</span>
              <>
                <span>B</span>
              </>
            </>
          </div>
        )
      }
    `
    const output = transform(source, { fineGrainedDom: true })
    expect(output).toContain('document.createElement("span")')
    expect(output).not.toContain('jsx(')
  })
})
