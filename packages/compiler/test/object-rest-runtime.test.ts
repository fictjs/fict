import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileModuleWithOutput(source: string): {
  output: string
  exports: Record<string, unknown>
} {
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
      throw new Error(`Unexpected import in object rest test: ${id}`)
    },
    module,
    module.exports,
  )
  return { output, exports: module.exports }
}

function compileModule(source: string): Record<string, unknown> {
  return compileModuleWithOutput(source).exports
}

describe('object rest runtime regressions', () => {
  it('preserves user-defined _objectWithoutProperties calls', () => {
    const { output, exports } = compileModuleWithOutput(
      `
        function _objectWithoutProperties(value, keys) {
          return 'user:' + value + ':' + keys.length
        }

        export function useProbe() {
          return _objectWithoutProperties('x', ['a'])
        }
      `,
    )

    expect(output).toContain('_objectWithoutProperties("x", ["a"])')
    expect(output).not.toContain('__fictObjectRest("x"')
    expect((exports.useProbe as () => string)()).toBe('user:x:1')
  })

  it('preserves user-defined _objectWithoutPropertiesLoose calls', () => {
    const { output, exports } = compileModuleWithOutput(
      `
        function _objectWithoutPropertiesLoose(value, keys) {
          return 'loose:' + value + ':' + keys.length
        }

        export function useProbe() {
          return _objectWithoutPropertiesLoose('x', ['a', 'b'])
        }
      `,
    )

    expect(output).toContain('_objectWithoutPropertiesLoose("x", ["a", "b"])')
    expect(output).not.toContain('__fictObjectRest("x"')
    expect((exports.useProbe as () => string)()).toBe('loose:x:2')
  })

  it('preserves shadowed object rest helper names in nested scopes', () => {
    const { output, exports } = compileModuleWithOutput(
      `
        export function useProbe() {
          const _objectWithoutProperties = (value, keys) => {
            return 'nested:' + value + ':' + keys.length
          }
          return _objectWithoutProperties('x', ['a'])
        }
      `,
    )

    expect(output).not.toContain('__fictObjectRest("x"')
    expect((exports.useProbe as () => string)()).toBe('nested:x:1')
  })

  it('preserves user-defined _extends calls with object-rest-like arguments', () => {
    const { output, exports } = compileModuleWithOutput(
      `
        function _objectDestructuringEmpty(value) {
          return value
        }

        function _extends(target, source) {
          return 'extends:' + source.a
        }

        export function useProbe() {
          const obj = { a: 1 }
          return _extends({}, (_objectDestructuringEmpty(obj), obj))
        }
      `,
    )

    expect(output).toContain('_extends({}, (_objectDestructuringEmpty(obj), obj))')
    expect(output).not.toContain('__fictObjectRest(obj, [])')
    expect((exports.useProbe as () => string)()).toBe('extends:1')
  })

  it('copies only own enumerable properties for ordinary object rest', () => {
    const exports = compileModule(
      `
        export function useProbe() {
          const visibleSymbol = Symbol('visible')
          const hiddenSymbol = Symbol('hidden')
          let visibleGetterReads = 0
          let hiddenGetterReads = 0
          const obj = Object.defineProperties(
            {
              a: 1,
              visible: 2,
              get computed() {
                visibleGetterReads++
                return 3
              },
              [visibleSymbol]: 4,
            },
            {
              hidden: { value: 5, enumerable: false },
              [hiddenSymbol]: { value: 6, enumerable: false },
              hiddenGetter: {
                enumerable: false,
                get() {
                  hiddenGetterReads++
                  return 7
                },
              },
            }
          )

          const { a, ...rest } = obj
          return [
            Object.prototype.hasOwnProperty.call(rest, 'hidden'),
            Object.prototype.hasOwnProperty.call(rest, hiddenSymbol),
            Object.prototype.hasOwnProperty.call(rest, visibleSymbol),
            rest.visible,
            rest.computed,
            rest[visibleSymbol],
            visibleGetterReads,
            hiddenGetterReads,
          ].join(':')
        }
      `,
    )

    const result = (exports.useProbe as () => string)()
    expect(result).toBe('false:false:true:2:3:4:1:0')
  })

  it('does not hookify Babel helpers for computed object rest keys', () => {
    const { output, exports } = compileModuleWithOutput(
      `
        export function useComputedRest() {
          const s = Symbol('s')
          const obj = { [s]: 1, a: 2 }
          const { [s]: value, ...rest } = obj
          return [value, Object.getOwnPropertySymbols(rest).length, rest.a]
        }
      `,
    )

    expect(output).toContain('function _toPropertyKey')
    expect(output).not.toMatch(/function _toPropertyKey[\s\S]*__fictUseMemo/)
    expect((exports.useComputedRest as () => unknown[])()).toEqual([1, 0, 2])
  })
})
