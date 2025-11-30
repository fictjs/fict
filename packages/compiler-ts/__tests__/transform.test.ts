import { describe, expect, it } from 'vitest'
import ts from 'typescript'

import { createFictTransformer } from '../src'

function transform(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(null)],
    },
  })

  return result.outputText.trim()
}

describe('createFictTransformer', () => {
  it('rewrites $state, derived consts, and $effect', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'

      let count = $state(0)
      const doubled = count * 2

      $effect(() => {
        console.log(doubled)
      })

      const click = () => {
        count += 1
      }

      const view = () => <button onClick={() => count++}>{doubled}</button>
    `)

    expect(output).toContain(
      `import { createSignal as __fictSignal, createMemo as __fictMemo, createEffect as __fictEffect } from "fict-runtime";`,
    )
    expect(output).toContain(`let count = __fictSignal(0);`)
    expect(output).toContain(`const doubled = __fictMemo(() => count() * 2);`)
    expect(output).toContain(`__fictEffect(() => {`)
    expect(output).toContain(`console.log(doubled());`)
    expect(output).toContain(`count(count() + 1);`)
    expect(output).toContain(`onClick={() => count(count() + 1)}`)
    expect(output).toContain(`{doubled()}`)
    expect(output).not.toContain('$state')
  })

  it('converts shorthand properties using tracked identifiers', () => {
    const output = transform(`
      let count = $state(1)
      const payload = { count, other: count + 1 }
      const read = () => payload
    `)

    expect(output).toContain(`let count = __fictSignal(1);`)
    expect(output).toContain(
      `const payload = __fictMemo(() => ({ count: count(), other: count() + 1 }));`,
    )
    expect(output).toContain(`const read = () => payload();`)
    expect(output).not.toContain('$state')
  })
})
