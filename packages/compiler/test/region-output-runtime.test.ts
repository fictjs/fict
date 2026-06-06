import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileModule(source: string): Record<string, unknown> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
    optimize: true,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in region output test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

describe('region output runtime regressions', () => {
  it('preserves null and other falsy control-flow region outputs', () => {
    const exports = compileModule(`
      const nullValue = null
      const undefinedValue = undefined
      const zeroValue = 0
      const falseValue = false
      const emptyValue = ''
      const nanValue = NaN

      let outNull = nullValue
      let outUndefined = undefinedValue
      let outZero = zeroValue
      let outFalse = falseValue
      let outEmpty = emptyValue
      let outNaN = nanValue

      if (true) {
        var branchNull = outNull
        var branchUndefined = outUndefined
        var branchZero = outZero
        var branchFalse = outFalse
        var branchEmpty = outEmpty
        var branchNaN = outNaN
      }

      const format = value =>
        value === null ? 'null' : Number.isNaN(value) ? 'NaN' : String(value)

      export function useProbe() {
        return [
          outNull,
          outUndefined,
          outZero,
          outFalse,
          outEmpty,
          outNaN,
          branchNull,
          branchUndefined,
          branchZero,
          branchFalse,
          branchEmpty,
          branchNaN,
        ].map(format).join(',')
      }
    `)

    expect((exports.useProbe as () => unknown)()).toBe(
      'null,undefined,0,false,,NaN,null,undefined,0,false,,NaN',
    )
  })

  it('uses intrinsic undefined for missing region outputs when undefined is shadowed', () => {
    const source = `
      import { $state } from 'fict'

      const format = value => value === void 0 ? 'undefined' : String(value)

      export function useProbe() {
        const undefined = 'shadow'
        let flag = $state(false)
        let missing
        let explicit = void 0

        if (flag) {
          missing = 'yes'
          explicit = 'yes'
        }

        return format(missing) + ':' + format(explicit) + ':' + undefined
      }
    `
    const output = transformCommonJS(source, {
      dev: false,
      emitModuleMetadata: false,
      strictGuarantee: false,
      optimize: true,
    })
    expect(output).toMatch(/missing:\s*missing\s*!==\s*void 0\s*\?\s*missing\s*:\s*void 0/)
    expect(output).not.toMatch(/missing:\s*missing\s*!==\s*undefined\s*\?/)
    expect(output).not.toContain('let missing = undefined')

    const exports = compileModule(source)
    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('undefined:undefined:shadow')
  })

  it('snapshots mutable region outputs before later writes', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        const a = $state(1)
        let y = a()
        const z = y
        y = 2
        return String(z) + ':' + String(y)
      }
    `)

    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('1:2')
  })

  it('updates region-local mutable derived values as plain locals', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        const a = $state(1)
        let y = a()
        const post = y++
        const pre = ++y
        y--
        return String(post) + ':' + String(pre) + ':' + String(y)
      }
    `)

    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('1:3:2')
  })
})
