import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileAndRunHook<T>(source: string, exportName: string): T {
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
      throw new Error(`Unexpected import in hook binding test: ${id}`)
    },
    module,
    module.exports,
  )

  const hook = module.exports[exportName]
  if (typeof hook !== 'function') {
    throw new Error(`Expected export ${exportName} to be a function`)
  }

  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () => (hook as () => T)())
}

describe('hook binding regressions', () => {
  it('allows named function expressions assigned to hook bindings', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        const useF = function inner() {
          let count = $state(0)
          void count
          return typeof inner
        }

        export function useProbe() {
          return useF()
        }
      `,
      'useProbe',
    )

    expect(result).toBe('function')
  })

  it('allows exported named function expressions assigned to hook bindings', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export const useF = function inner() {
          let count = $state(0)
          void count
          return typeof inner
        }

        export function useProbe() {
          return useF()
        }
      `,
      'useProbe',
    )

    expect(result).toBe('function')
  })

  it('keeps members from plain local hooks opaque', () => {
    const result = compileAndRunHook<{
      objectCount: number
      arrayValue: number
      methodValue: number
    }>(
      `
        function usePlainObject() {
          return {
            count: 1,
            method() {
              return 4
            },
          }
        }

        function usePlainArray() {
          return [3]
        }

        export function useProbe() {
          const state = usePlainObject()
          state.count = 2
          state.count++

          const list = usePlainArray()

          return {
            objectCount: state.count,
            arrayValue: list[0],
            methodValue: state.method(),
          }
        }
      `,
      'useProbe',
    )

    expect(result).toEqual({
      objectCount: 3,
      arrayValue: 3,
      methodValue: 4,
    })
  })

  it('still lowers members from hooks with accessor metadata', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        function useReactive() {
          let count = $state(0)
          return { count }
        }

        export function useProbe() {
          const state = useReactive()
          state.count = 2
          return state.count
        }
      `,
      'useProbe',
    )

    expect(result).toBe(2)
  })
})
