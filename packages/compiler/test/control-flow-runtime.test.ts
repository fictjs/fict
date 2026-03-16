import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileAndRunHook<T>(source: string, exportName: string): T {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)

  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in compiler runtime test: ${id}`)
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

describe('control flow runtime regressions', () => {
  beforeEach(() => {
    runtimeInternal.__fictResetContext()
  })

  afterEach(() => {
    runtimeInternal.__fictResetContext()
  })

  it('preserves mutable loop accumulators inside reactive hooks', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(4)
          let total = 0

          for (let i = 0; i < n; i++) {
            if (i === 1) {
              continue
            }
            total += i
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(5)
  })

  it('keeps partial while-loop control flow inline when memoization would be incomplete', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(3)
          let total = 0
          let i = 0

          while (i < n) {
            total += 1
            i++
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(3)
  })

  it('initializes reactive declarations correctly inside state-machine fallback blocks', () => {
    const output = transformCommonJS(
      `
        import { $state } from 'fict'

        export function useRun() {
          let x = $state(0)
          let step = 0

          const flag = () => {
            step += 1
            return step <= 2
          }

          while (flag()) {
            try {
              if (flag()) {
                continue
              }
            } finally {
              x = x + 1
            }

            break
          }

          return x
        }
      `,
    )

    expect(output).toContain('x = (0, _internal.__fictUseSignal)')
    expect(output).not.toContain('x((0, _internal.__fictUseSignal)')
  })
})
