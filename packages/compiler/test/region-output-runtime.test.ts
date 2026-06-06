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

  it('keeps computed-key destructuring declaration temps ordered in control flow', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useIfDestructure() {
        let enabled = $state(true)
        let key = 'a'
        let out = 'unset'

        if (enabled) {
          const { [key]: value } = { a: 'if' }
          out = value
        }

        return out
      }

      export function useLoopDestructure() {
        let remaining = $state(2)
        let key = 'a'
        let out = ''

        while (remaining) {
          const { [key]: value } = { a: 'loop' }
          out += value
          remaining--
        }

        return out
      }

      export function useSwitchDestructure() {
        let mode = $state('a')
        let key = 'a'
        let out = 'unset'

        switch (mode) {
          case 'a': {
            const { [key]: value } = { a: 'switch' }
            out = value
            break
          }
        }

        return out
      }

      export function useNestedBlockDestructure() {
        let enabled = $state(true)
        let key = 'a'
        let out = 'unset'

        if (enabled) {
          {
            const { [key]: value } = { a: 'nested' }
            out = value
          }
        }

        return out
      }

      export function useStaticAndAssignmentControls() {
        let enabled = $state(true)
        let key = 'a'
        let out = 'unset'

        if (enabled) {
          const { a: staticValue } = { a: 'static' }
          let assigned = ''
          ;({ [key]: assigned } = { a: 'assign' })
          out = staticValue + ':' + assigned
        }

        return out
      }
    `)

    const render = (name: string) => {
      const value = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
        (exports[name] as () => string | (() => string))(),
      )
      return typeof value === 'function' ? value() : value
    }

    expect(render('useIfDestructure')).toBe('if')
    expect(render('useLoopDestructure')).toBe('looploop')
    expect(render('useSwitchDestructure')).toBe('switch')
    expect(render('useNestedBlockDestructure')).toBe('nested')
    expect(render('useStaticAndAssignmentControls')).toBe('static:assign')
  })

  it('assigns region output accessors through mutable cells', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        const a = $state(1)
        let y = a()
        const assigned = (y = 2)
        const compound = (y += 3)
        const logicalAnd = (y &&= 8)
        const logicalOrSkip = (y ||= 9)
        const undefinedValue = (y = undefined)
        const nullishSet = (y ??= 6)
        return [
          assigned,
          compound,
          logicalAnd,
          logicalOrSkip,
          undefinedValue,
          nullishSet,
          y,
        ].map(value => String(value)).join(':')
      }
    `)

    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('2:5:8:8:undefined:6:6')
  })

  it('preserves member writes to mutable derived objects and arrays', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        const a = $state(1)

        let obj = { v: a(), count: a() }
        obj.v = 2
        const compound = (obj.count += 4)
        const updated = obj.count++
        const deleted = delete obj.v

        let arr = [a()]
        arr[0] = 3
        const arrCompound = (arr[0] += 4)
        const arrUpdated = arr[0]++

        return [
          deleted,
          'v' in obj,
          obj.v,
          compound,
          updated,
          obj.count,
          arrCompound,
          arrUpdated,
          arr[0],
        ].map(value => String(value)).join(':')
      }
    `)

    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('true:false:undefined:5:5:6:7:7:8')
  })

  it('keeps unmutated derived object reads intact', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export function useProbe() {
        const a = $state(1)
        const obj = { v: a() }
        const arr = [a()]
        return String(obj.v) + ':' + String(arr[0])
      }
    `)

    const result = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      (exports.useProbe as () => string)(),
    )

    expect(result).toBe('1:1')
  })
})
