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
      if (id === './numbers') return { value: 5 }
      throw new Error(`Unexpected import in non-finite numeric test: ${id}`)
    },
    module,
    module.exports,
  )
  return { output, mod: module.exports as TModule }
}

describe('non-finite numeric literal semantics', () => {
  it('does not read parameters named NaN or Infinity for folded constants', () => {
    const { output, mod } = compileAndLoad<{
      foldedNaN: (shadow: number) => number
      foldedInfinity: (shadow: number) => number
      foldedNegativeInfinity: (shadow: number) => number
    }>(`
      export function foldedNaN(NaN) {
        "use pure"
        const x = 0 / 0
        return x
      }

      export function foldedInfinity(Infinity) {
        "use pure"
        const x = 1 / 0
        return x
      }

      export function foldedNegativeInfinity(Infinity) {
        "use pure"
        const x = -1 / 0
        return x
      }
    `)

    expect(output).toContain('0 / 0')
    expect(output).toContain('1 / 0')
    expect(Number.isNaN(mod.foldedNaN(5))).toBe(true)
    expect(mod.foldedInfinity(5)).toBe(Infinity)
    expect(mod.foldedNegativeInfinity(5)).toBe(-Infinity)
  })

  it('does not read local, catch, or import bindings named like non-finite globals', () => {
    const { mod } = compileAndLoad<{
      localShadow: () => number
      catchShadow: () => number
      importShadow: () => number
    }>(`
      import { value as NaN } from './numbers'

      export function localShadow() {
        "use pure"
        const Infinity = 5
        const x = 1 / 0
        return x
      }

      export function catchShadow() {
        "use pure"
        try {
          throw 5
        } catch (NaN) {
          const x = 0 / 0
          return x
        }
      }

      export function importShadow() {
        "use pure"
        const x = 0 / 0
        return x
      }
    `)

    expect(mod.localShadow()).toBe(Infinity)
    expect(Number.isNaN(mod.catchShadow())).toBe(true)
    expect(Number.isNaN(mod.importShadow())).toBe(true)
  })

  it('keeps finite folded numbers as ordinary numeric literals', () => {
    const { output, mod } = compileAndLoad<{
      finite: (shadow: number) => number
    }>(`
      export function finite(NaN) {
        "use pure"
        const x = 6 / 2
        return x
      }
    `)

    expect(output).toContain('return 3')
    expect(mod.finite(5)).toBe(3)
  })
})
