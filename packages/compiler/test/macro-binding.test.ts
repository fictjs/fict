import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('macro binding recognition', () => {
  it('does not transform a local $state binding that shadows the imported macro', () => {
    const output = transform(`
      import { $state } from 'fict'
      function App() {
        const $state = (x: number) => x
        let count = $state(0)
        return count
      }
    `)

    expect(output).not.toContain('__fictUseSignal')
    expect(output).toContain('let count = $state(0)')
    expect(output).toContain('return count')
  })

  it('allows a local $state function without a fict import', () => {
    const output = transform(`
      function App() {
        const $state = (x: number) => x
        return $state(1)
      }
    `)

    expect(output).not.toContain('__fictUseSignal')
    expect(output).toContain('return $state(1)')
  })

  it('does not add memo devtools options to a local createMemo helper', () => {
    const output = transform(`
      function createMemo<T>(fn: () => T): T {
        return fn()
      }
      function App() {
        let x = createMemo(() => 1)
        return x
      }
    `)

    expect(output).toContain('let x = createMemo(() => 1)')
    expect(output).not.toContain('devToolsSource')
  })

  it('does not report R004 for a local helper that shadows a fict import', () => {
    expect(() =>
      transform(`
        import { createEffect } from 'fict'
        function App(flag: boolean) {
          const createEffect = (fn: () => void) => fn()
          if (flag) {
            createEffect(() => {})
          }
          return null
        }
      `),
    ).not.toThrow()
  })

  it('keeps imported macro aliases active', () => {
    const output = transform(`
      import { $state as state, createMemo as memo } from 'fict'
      function App() {
        let count = state(1)
        const doubled = memo(() => count * 2)
        return doubled()
      }
    `)

    expect(output).toContain('__fictUseSignal')
    expect(output).toContain('memo(() => count() * 2')
    expect(output).toContain('devToolsSource')
  })

  it('does not match local $state calls through an imported alias', () => {
    const output = transform(`
      import { $state as macro } from 'fict'
      function $state(value: number) {
        return value + 1
      }
      export function App() {
        const local = $state(1)
        let count = macro(10)
        return [local, count]
      }
    `)

    expect(output).toContain('const local = $state(1)')
    expect(output).toContain('__fictUseSignal')
  })

  it('does not match local $effect calls through an imported alias', () => {
    const output = transform(`
      import { $effect as macroEffect } from 'fict'
      const calls: string[] = []
      function $effect(fn: () => void) {
        calls.push('local')
        fn()
      }
      export function App() {
        $effect(() => calls.push('default'))
        macroEffect(() => calls.push('alias'))
        return calls.length
      }
    `)

    expect(output).toContain('$effect(() => calls.push')
    expect(output).toContain('__fictUseEffect')
  })

  it('does not match local memo helpers through imported aliases', () => {
    const output = transform(`
      import { $memo as macroMemo, createMemo as macroCreateMemo } from 'fict'
      function $memo<T>(fn: () => T): T {
        return fn()
      }
      function createMemo<T>(fn: () => T): T {
        return fn()
      }
      export function App() {
        const localMemo = $memo(() => 1)
        const localCreate = createMemo(() => 2)
        const importedMemo = macroMemo(() => localMemo + localCreate)
        const importedCreate = macroCreateMemo(() => importedMemo())
        return importedCreate()
      }
    `)

    expect(output).toContain('const localMemo = $memo(() => 1)')
    expect(output).toContain('const localCreate = createMemo(() => 2)')
    expect(output).toContain('devToolsSource')
  })

  it('tracks namespace $memo runtime calls as memo accessors', () => {
    const output = transform(`
      import { $state } from 'fict'
      import * as F from 'fict'
      function App() {
        let count = $state(1)
        const double = F.$memo(() => count * 2)
        return <div>{double}</div>
      }
    `)

    expect(output).toContain('const double = F.$memo(() => count() * 2')
    expect(output).not.toMatch(/const double = __fictUseMemo[\s\S]*F\.\$memo/)
    expect(output).toMatch(/\(\)\s*=>\s*double\(\)/)
  })

  it('rejects namespace $state macro calls from fict', () => {
    expect(() =>
      transform(`
        import * as F from 'fict'
        function App() {
          let count = F.$state(0)
          return count
        }
      `),
    ).toThrow(/\$state\(\) cannot be called through a namespace import from "fict"/)
  })

  it('rejects namespace $effect macro calls from fict slim aliases', () => {
    expect(() =>
      transform(`
        import * as Slim from 'fict/slim'
        function App() {
          Slim.$effect(() => {})
          return null
        }
      `),
    ).toThrow(/\$effect\(\) cannot be called through a namespace import from "fict\/slim"/)
  })

  it('rejects computed namespace macro calls', () => {
    expect(() =>
      transform(`
        import * as F from 'fict'
        function App() {
          let count = F['$state'](0)
          return count
        }
      `),
    ).toThrow(/import \{ \$state \} from 'fict'/)
  })

  it('does not reject local objects that shadow a fict namespace import', () => {
    const output = transform(`
      import * as F from 'fict'
      function App() {
        const F = { $state: (value: number) => value }
        let count = F.$state(0)
        return count
      }
    `)

    expect(output).toContain('.$state(0)')
    expect(output).not.toContain('__fictUseSignal')
  })

  it('does not reject non-macro members on a fict namespace import', () => {
    const output = transform(`
      import * as F from 'fict'
      function App() {
        return F.createSignal(0)
      }
    `)

    expect(output).toContain('F.createSignal(0)')
  })
})
