import { describe, expect, it } from 'vitest'

import { transformCommonJS } from './test-utils'

function compileAndLoad<TModule extends Record<string, unknown>>(
  source: string,
): { output: string; mod: TModule } {
  const output = transformCommonJS(source)
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      throw new Error(`Unexpected import in synthesized undefined test: ${id}`)
    },
    module,
    module.exports,
  )
  return { output, mod: module.exports as TModule }
}

describe('synthesized undefined semantics', () => {
  it('does not read a parameter named undefined for missing initializers', () => {
    const { output, mod } = compileAndLoad<{
      missingInitializer: (undefinedValue: number) => unknown
    }>(`
      export function missingInitializer(undefined) {
        let x
        return x
      }
    `)

    expect(output).toContain('void 0')
    expect(mod.missingInitializer(5)).toBeUndefined()
  })

  it('does not read local or catch bindings named undefined for synthesized values', () => {
    const { mod } = compileAndLoad<{
      localShadow: () => unknown
      catchShadow: () => unknown
    }>(`
      export function localShadow() {
        const undefined = 5
        let x
        return x
      }

      export function catchShadow() {
        try {
          throw 5
        } catch (undefined) {
          let x
          return x
        }
      }
    `)

    expect(mod.localShadow()).toBeUndefined()
    expect(mod.catchShadow()).toBeUndefined()
  })

  it('uses intrinsic undefined for destructuring defaults', () => {
    const { mod } = compileAndLoad<{
      destructuringDefaults: (undefinedValue: number) => [string, string]
    }>(`
      export function destructuringDefaults(undefined) {
        const [first = 'array'] = []
        const { value = 'object' } = {}
        return [first, value]
      }
    `)

    expect(mod.destructuringDefaults(5)).toEqual(['array', 'object'])
  })

  it('preserves source-authored undefined identifier reads', () => {
    const { output, mod } = compileAndLoad<{
      readUserBinding: (undefinedValue: number) => number
    }>(`
      export function readUserBinding(undefined) {
        return undefined
      }
    `)

    expect(output).toContain('return undefined')
    expect(mod.readUserBinding(5)).toBe(5)
  })
})
