import { describe, expect, it } from 'vitest'

import { transform, transformCommonJS } from './test-utils'

function compileAndLoad<TModule extends Record<string, unknown>>(
  source: string,
): { output: string; mod: TModule } {
  const output = transformCommonJS(source)
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      throw new Error(`Unexpected import in sparse array test: ${id}`)
    },
    module,
    module.exports,
  )
  return { output, mod: module.exports as TModule }
}

describe('sparse array literal semantics', () => {
  it('does not crash optimizing sparse arrays in reactive components', () => {
    expect(() =>
      transform(`
        import { $state } from 'fict'

        export function App() {
          let state = $state({ user: { name: 'a' } })
          const arr = [, 1]
          return <div>{state.user.name}{arr.length}</div>
        }
      `),
    ).not.toThrow()
  })

  it('preserves ordinary sparse array holes through transform and runtime', () => {
    const { output, mod } = compileAndLoad<{
      inspectSparse: () => {
        length: number
        has0: boolean
        value0: string
        keys: string
        mapped: string
        first: string
        second: number
        spreadHas0: boolean
        spreadKeys: string
        nestedHas0: boolean
        nestedKeys: string
      }
    }>(`
      export function inspectSparse() {
        const a = [, 1]
        const [first = 'missing', second] = a
        const spread = [...a]
        const nested = [[, 2]]
        return {
          length: a.length,
          has0: 0 in a,
          value0: String(a[0]),
          keys: Object.keys(a).join(','),
          mapped: a.map((x, i) => String(i) + String(x)).join('|'),
          first,
          second,
          spreadHas0: 0 in spread,
          spreadKeys: Object.keys(spread).join(','),
          nestedHas0: 0 in nested[0],
          nestedKeys: Object.keys(nested[0]).join(','),
        }
      }
    `)

    expect(output).toContain('[, 1]')
    expect(mod.inspectSparse()).toEqual({
      length: 2,
      has0: false,
      value0: 'undefined',
      keys: '1',
      mapped: '|11',
      first: 'missing',
      second: 1,
      spreadHas0: true,
      spreadKeys: '0,1',
      nestedHas0: false,
      nestedKeys: '1',
    })
  })

  it('keeps explicit undefined elements distinct from holes', () => {
    const { output, mod } = compileAndLoad<{
      inspectDenseUndefined: () => {
        has0: boolean
        keys: string
        mapped: string
      }
    }>(`
      export function inspectDenseUndefined() {
        const a = [undefined, 1]
        return {
          has0: 0 in a,
          keys: Object.keys(a).join(','),
          mapped: a.map((x, i) => String(i) + String(x)).join('|'),
        }
      }
    `)

    expect(output).toContain('[undefined, 1]')
    expect(mod.inspectDenseUndefined()).toEqual({
      has0: true,
      keys: '0,1',
      mapped: '0undefined|11',
    })
  })
})
