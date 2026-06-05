import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileModule(source: string): Record<string, unknown> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    optimize: true,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in class static order test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

function runHook<T>(hook: unknown): T {
  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () => (hook as () => T)())
}

describe('class static side-effect order regressions', () => {
  it('preserves static field and static block evaluation order', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        let count = $state(0)
        const log = []
        log.push('before')
        class C {
          static x = log.push('field')
          static {
            log.push('block')
          }
        }
        log.push('after')
        return log.join(',')
      }
    `)

    expect(runHook<string>(exports.useProbe)).toBe('before,field,block,after')
  })

  it('preserves extends expression order for unused local classes', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        let count = $state(0)
        const log = []
        function Base() {
          log.push('extends')
          return class {}
        }
        log.push('before')
        class C extends Base() {}
        log.push('after')
        return log.join(',')
      }
    `)

    expect(runHook<string>(exports.useProbe)).toBe('before,extends,after')
  })
})
