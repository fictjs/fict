import { afterEach, describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileModule<TModule extends Record<string, unknown>>(
  source: string,
): {
  output: string
  mod: TModule
} {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in component heuristic test: ${id}`)
    },
    module,
    module.exports,
  )
  return { output, mod: module.exports as TModule }
}

describe('component name heuristic runtime regressions', () => {
  afterEach(() => {
    runtimeInternal.__fictResetContext()
  })

  it('keeps ordinary helpers callable outside render regardless of name shape', () => {
    for (const name of [
      'helper',
      '_helper',
      '$helper',
      'Helper',
      '_toPropertyKey',
      '_toPrimitive',
    ]) {
      const { output, mod } = compileModule<{
        caller: () => number
      }>(`
        export function ${name}(x: number) {
          const y = x + 1
          return y
        }

        export function caller() {
          return ${name}(1)
        }
      `)

      expect(output).not.toContain('__fictUseContext')
      expect(output).not.toContain('__fictUseMemo')
      expect(mod.caller()).toBe(2)
    }
  })

  it('still uses component hook lowering for uppercase reactive component functions', () => {
    const { output } = compileModule(`
      import { $state } from 'fict'

      export function Helper() {
        let count = $state(1)
        return count
      }
    `)

    expect(output).toContain('__fictUseSignal')
    expect(output).toContain('__fictUseContext')
  })
})
