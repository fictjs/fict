import { transformSync } from '@babel/core'
// @ts-expect-error CJS default export lacks types
import presetTypescript from '@babel/preset-typescript'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src/index'

describe('sourcemaps', () => {
  it('preserves mappings for generated reactive updates', () => {
    const input = `
import { $state } from 'fict'
export function Counter() {
  const count = $state(0)
  const inc = () => count(count() + 1)
  return <button onClick={inc}>{count()}</button>
}
`.trim()

    const filename = 'Counter.tsx'
    const result = transformSync(input, {
      filename,
      sourceMaps: true,
      sourceFileName: filename,
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        allowReturnOutsideFunction: true,
      },
      plugins: [[createFictPlugin, { sourcemap: true }]],
      presets: [[presetTypescript, { isTSX: true, allExtensions: true, allowDeclareFields: true }]],
      generatorOpts: { compact: false },
    })

    expect(result?.map).toBeTruthy()
    expect(result?.code).toBeTruthy()
    const map = new TraceMap(result!.map as any)

    const needle = 'count() + 1'
    const generated = result!.code!
    const index = generated.indexOf(needle)
    expect(index).toBeGreaterThan(0)

    const prefix = generated.slice(0, index)
    const lines = prefix.split('\n')
    const line = lines.length
    const column = lines[lines.length - 1]?.length ?? 0

    const original = originalPositionFor(map, { line, column })
    expect(original.source).toBe(filename)
    expect(original.line).toBe(3)
    expect(original.column).toBeGreaterThan(0)
  })
})
