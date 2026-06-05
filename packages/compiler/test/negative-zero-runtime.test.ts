import { describe, expect, it } from 'vitest'

import { transformCommonJS } from './test-utils'

function compileModule(source: string): Record<string, unknown> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    optimize: true,
    optimizeLevel: 'full',
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      throw new Error(`Unexpected import in negative zero test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

describe('negative zero optimization regressions', () => {
  it('preserves direct negative zero constants', () => {
    const exports = compileModule(`
      export function probe() {
        const x = -0
        return Object.is(x, -0)
      }
    `)

    expect((exports.probe as () => boolean)()).toBe(true)
  })

  it('preserves negative zero through constant propagation', () => {
    const exports = compileModule(`
      export function probe() {
        const x = -0
        const y = x
        return Object.is(y, -0)
      }
    `)

    expect((exports.probe as () => boolean)()).toBe(true)
  })

  it('preserves reciprocal division behavior for negative zero', () => {
    const exports = compileModule(`
      export function probe() {
        const x = -0
        return 1 / x
      }
    `)

    expect((exports.probe as () => number)()).toBe(-Infinity)
  })

  it('preserves arithmetic that produces negative zero', () => {
    const exports = compileModule(`
      export function probe() {
        const x = 0 * -1
        return Object.is(x, -0)
      }
    `)

    expect((exports.probe as () => boolean)()).toBe(true)
  })

  it('does not preserve negative zero for arithmetic that produces positive zero', () => {
    const exports = compileModule(`
      export function probe() {
        const x = -0 + 0
        return Object.is(x, -0)
      }
    `)

    expect((exports.probe as () => boolean)()).toBe(false)
  })
})
