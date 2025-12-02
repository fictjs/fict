import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer } from '../index'

function transform(source: string, options?: Parameters<typeof createFictTransformer>[1]): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(undefined, options)],
    },
  })
  return result.outputText
}

describe('Spec rule coverage', () => {
  it('throws when $state is used without importing from fict', () => {
    const input = `
      let count = $state(0)
    `
    expect(() => transform(input)).toThrow('must be imported from "fict"')
  })

  it('throws when $state is declared inside conditional blocks', () => {
    const input = `
      import { $state } from 'fict'
      if (true) {
        const count = $state(0)
      }
    `
    expect(() => transform(input)).toThrow('top-level scope')
  })

  it('supports props destructuring with tracked getters', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ name, age = 18 }) {
        const label = \`\${name} (\${age})\`
        return <div>{label}</div>
      }
    `
    const output = transform(input)
    expect(output).toContain('function Greeting(__props')
    expect(output).toContain('__props_1.name')
    expect(output).toContain('__props_1.age')
    expect(output).toContain('__fictMemo(() => `')
    expect(output).toContain('() => label()')
  })

  it('does not leak prop getter tracking outside the function', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ name }) {
        return <div>{name}</div>
      }
      const name = 'foo'
      console.log(name)
    `
    const output = transform(input)
    expect(output).toContain("const name = 'foo'")
    expect(output).not.toContain('console.log(name())')
  })

  it('preserves nested default values in destructured props', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ profile: { name } = { name: 'Anon' } }) {
        return <div>{name}</div>
      }
    `
    const output = transform(input)
    expect(output).toContain("=== undefined ? { name: 'Anon' } : __props_1.profile")
  })

  it('emits warnings for deep mutations and dynamic property access', () => {
    const warnings: any[] = []
    const input = `
      import { $state } from 'fict'
      const key = 'city'
      let user = $state({ addr: { city: 'Paris' } })
      user.addr[key] = 'London'
    `
    transform(input, {
      onWarn: warning => warnings.push(warning),
    })

    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
  })

  it('detects cyclic derived dependencies', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = b + source
      const b = a + 1
    `
    expect(() => transform(input, { dev: true })).toThrow(/cyclic derived dependency/i)
  })

  it('keeps module-level derived values as memos even for event usage', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(1)
      export const doubled = count * 2
      export const click = () => console.log(doubled)
    `
    const output = transform(input)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })
})
