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
})
