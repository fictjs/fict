import { describe, expect, it } from 'vitest'

import { type FictCompilerOptions } from '../src/index'

import { transformFineGrained } from './test-utils'

const transform = (source: string, options?: FictCompilerOptions) => {
  return transformFineGrained(source, options)
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
