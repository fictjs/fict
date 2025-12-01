import ts from 'typescript'
import { describe, it, expect } from 'vitest'

import { createFictTransformer } from '../index'

function transform(source: string): string {
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

describe('Rule D Verification', () => {
  it('groups related derived values into a single region', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      let heading
      let extra

      if (count > 0) {
        const noun = count > 1 ? 'Videos' : 'Video'
        heading = \`\${count} \${noun}\`
        extra = count * 10
      }
    `
    const output = transform(input)
    console.log(output)

    // Should contain the region marker
    expect(output).toContain('__fictRegion')
    // Should return an object with heading and extra (not noun - it's a local variable)
    expect(output).toContain('return { heading, extra }')
    // Should expose getters for external variables only
    expect(output).toMatch(/const heading = \(\) => __fictRegion_\d+\(\)\.heading/)
    expect(output).toMatch(/const extra = \(\) => __fictRegion_\d+\(\)\.extra/)
    // Should NOT expose noun - it's an internal variable
    expect(output).not.toContain('const noun = ()')
  })
})
