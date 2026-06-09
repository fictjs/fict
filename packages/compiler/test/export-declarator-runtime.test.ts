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
      throw new Error(`Unexpected import in export declarator test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

describe('exported function declarator regressions', () => {
  it('preserves exported arrow function declarator semantics', () => {
    const exports = compileModule(`
      export const useF = () => this === undefined

      export function useProbe() {
        let newResult = 'unset'
        try {
          const Ctor = useF
          new Ctor()
          newResult = 'ok'
        } catch (error) {
          newResult = error instanceof TypeError ? 'TypeError' : 'other'
        }

        return {
          hasPrototype: Object.prototype.hasOwnProperty.call(useF, 'prototype'),
          newResult,
          lexicalThis: useF.call({ marker: true }),
        }
      }
    `)

    expect((exports.useProbe as () => unknown)()).toEqual({
      hasPrototype: false,
      newResult: 'TypeError',
      lexicalThis: true,
    })
  })

  it('preserves exported async arrows and generator function expressions', () => {
    const exports = compileModule(`
      export const useAsync = async () => 2,
        makeGen = function* () {
          yield 3
        }

      export function useProbe() {
        return {
          asyncIsPromise: useAsync() instanceof Promise,
          genValue: makeGen().next().value,
        }
      }
    `)

    expect((exports.useProbe as () => unknown)()).toEqual({
      asyncIsPromise: true,
      genValue: 3,
    })
  })

  it('preserves TDZ order in mixed exported declarators', () => {
    const exports = compileModule(`
      export const probeBefore = (() => {
          try {
            return typeof useF
          } catch (error) {
            return error instanceof ReferenceError ? 'ReferenceError' : 'other'
          }
        })(),
        useF = () => 1

      export function useProbe() {
        return probeBefore
      }
    `)

    expect((exports.useProbe as () => unknown)()).toBe('ReferenceError')
  })
})
