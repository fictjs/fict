import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transform, transformCommonJS } from './test-utils'

function compileAndRun<T>(source: string, exportName: string): T {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
  })
  const module: { exports: Record<string, unknown> } = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in optimizer semantics test: ${id}`)
    },
    module,
    module.exports,
  )
  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
    (module.exports[exportName] as () => T)(),
  )
}

describe('optimizer semantics safety', () => {
  it('keeps logical AND with true in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x && true
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*&&\s*true/)
  })

  it('keeps logical OR with false in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x || false
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\|\|\s*false/)
  })

  it('keeps additive identity in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x + 0
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\+\s*0/)
  })

  it('keeps multiplicative zero in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x * 0
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\*\s*0/)
  })

  it('keeps multiplicative identity in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x * 1
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\*\s*1/)
  })

  it('keeps subtraction identity in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x - 0
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*-\s*0/)
  })

  it('keeps division identity in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return x / 1
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/return\s+x\s*\/\s*1/)
  })

  it('preserves conditional test evaluation when branches are identical in safe mode', () => {
    const output = transform(
      `
        function foo(x) {
          return check(x) ? 1 : 1
        }
      `,
      { optimizeLevel: 'safe' },
    )

    expect(output).toMatch(/check\(x\)/)
    expect(output).toMatch(/\?\s*1\s*:\s*1/)
  })

  it('allows algebraic simplification in full mode', () => {
    const output = transform(
      `
        function foo(x) {
          const k = 1
          const result = true && x
          return result + k
        }
      `,
      { optimizeLevel: 'full' },
    )

    expect(output).not.toMatch(/true\s*&&/)
    expect(output).toMatch(/return\s+x/)
  })

  it('keeps optimizing constants when lexical names repeat in sibling scopes', () => {
    const blockOutput = transform(
      `
        export function f(p, q) {
          const a = 2
          const b = a + 3
          {
            const x = p
            void x
          }
          {
            const x = q
            void x
          }
          return b
        }
      `,
      { optimize: true, dev: false },
    )

    expect(blockOutput).toMatch(/return\s+5/)
  })

  it('does not constant-fold a value mutated through a closure call', () => {
    // `bump()` writes `x`, so `x + 1` must not fold using the stale `x = 1`.
    expect(
      compileAndRun<number>(
        `
          export function probe() {
            const bump = () => {
              x = 5
            }
            let x = 1
            bump()
            const z = x + 1
            return z
          }
        `,
        'probe',
      ),
    ).toBe(6)
  })

  it('does not CSE a member read across a write to the same member under "use pure"', () => {
    expect(
      compileAndRun<number[]>(
        `
          "use pure"
          export function probe() {
            const obj = { x: 1 }
            const a = obj.x
            obj.x = 99
            const b = obj.x
            return [a, b]
          }
        `,
        'probe',
      ),
    ).toEqual([1, 99])
  })

  it('does not CSE a member read across a member write through an alias', () => {
    expect(
      compileAndRun<number[]>(
        `
          "use pure"
          export function probe() {
            const obj = { x: 1 }
            const alias = obj
            const a = obj.x
            alias.x = 99
            const b = obj.x
            return [a, b]
          }
        `,
        'probe',
      ),
    ).toEqual([1, 99])
  })

  it('does not drop calls to a module-scope binding that shadows a builtin', () => {
    // `String` is a user function with side effects, not the pure builtin, so
    // the call must survive DCE.
    const constArrow = transform(
      `
        const String = v => {
          sideEffect(v)
          return 'x'
        }
        export function f() {
          const unused = String(5)
          return 1
        }
      `,
      { dev: false, optimize: true },
    )
    expect(constArrow).toMatch(/String\(5\)/)

    const funcDecl = transform(
      `
        function Number(v) {
          sideEffect(v)
          return 0
        }
        export function f() {
          const unused = Number(5)
          return 1
        }
      `,
      { dev: false, optimize: true },
    )
    expect(funcDecl).toMatch(/Number\(5\)/)

    // A genuine builtin call is still pure and removable.
    const genuine = transform(
      `
        export function f() {
          const unused = String(5)
          return 1
        }
      `,
      { dev: false, optimize: true },
    )
    expect(genuine).not.toMatch(/const unused\b/)
  })

  it('does not constant-fold an object member mutated through a closure call', () => {
    expect(
      compileAndRun<number>(
        `
          export function probe() {
            const o = { a: 1 }
            const bump = () => {
              o.a = 9
            }
            bump()
            return o.a
          }
        `,
        'probe',
      ),
    ).toBe(9)
  })
})
