import { transformSync } from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src'
import { transform } from './test-utils'

describe('semantic validation', () => {
  it('throws when $state is declared inside a loop', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        for (let i = 0; i < 10; i++) {
          const x = $state(i)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside loops/)
  })

  it('throws when $state is declared inside a conditional', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        if (true) {
          const x = $state(0)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside loops or conditionals/)
  })

  it('throws when $state is declared outside the immediate function body', () => {
    const cases = [
      `
        import { $state } from 'fict'
        function App() {
          try {
            const x = $state(0)
            return x
          } finally {}
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          try {
            throw 1
          } catch (error) {
            const x = $state(0)
            return x
          }
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          try {} finally {
            const x = $state(0)
          }
          return null
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          {
            const x = $state(0)
          }
          return null
        }
      `,
    ]

    for (const source of cases) {
      expect(() => transform(source)).toThrow(/top level|loops or conditionals/)
    }
  })

  it('throws when $state is declared inside a nested function (closure)', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const handleClick = () => {
          const x = $state(0)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside nested functions/)
  })

  it('allows $state inside reactive scope callback but rejects nested functions within it', () => {
    const okSource = `
      import { $state } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      renderHook(() => {
        const x = $state(0)
        return x
      })
    `
    expect(() => transform(okSource, { reactiveScopes: ['renderHook'] })).not.toThrow()

    const badSource = `
      import { $state } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      renderHook(() => {
        function inner() {
          const x = $state(0)
          return x
        }
        return inner()
      })
    `
    expect(() => transform(badSource, { reactiveScopes: ['renderHook'] })).toThrow(
      /cannot be declared inside nested functions/,
    )
  })

  it('throws when $effect is used in a loop inside reactive scope callback', () => {
    const source = `
      import { $state, $effect } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      renderHook(() => {
        for (let i = 0; i < 2; i++) {
          $effect(() => console.log(i))
        }
      })
    `
    expect(() => transform(source, { reactiveScopes: ['renderHook'] })).toThrow(
      /cannot be called inside loops/,
    )
  })

  it('throws when $effect is called outside the immediate function body', () => {
    const cases = [
      `
        import { $effect } from 'fict'
        function App() {
          try {
            $effect(() => {})
          } finally {}
          return null
        }
      `,
      `
        import { $effect } from 'fict'
        function App() {
          try {
            throw 1
          } catch (error) {
            $effect(() => {})
          }
          return null
        }
      `,
      `
        import { $effect } from 'fict'
        function App() {
          try {} finally {
            $effect(() => {})
          }
          return null
        }
      `,
      `
        import { $effect } from 'fict'
        function App() {
          {
            $effect(() => {})
          }
          return null
        }
      `,
    ]

    for (const source of cases) {
      expect(() => transform(source)).toThrow(/top level|loops or conditionals/)
    }
  })

  it('throws when reactive scope is invoked via alias (not supported)', () => {
    const source = `
      import { $state } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      const rh = renderHook
      rh(() => {
        const x = $state(0)
        return x
      })
    `
    expect(() => transform(source, { reactiveScopes: ['renderHook'] })).toThrow(
      /component or hook function body/,
    )
  })

  it('throws when reactive scope callback is not the first argument', () => {
    const source = `
      import { $state } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      renderHook('label', () => {
        const x = $state(0)
        return x
      })
    `
    expect(() => transform(source, { reactiveScopes: ['renderHook'] })).toThrow(
      /component or hook function body/,
    )
  })

  it('allows wrapped reactive scope callbacks when using the raw compiler plugin', () => {
    const source = `
      import { $state } from 'fict'
      import { renderHook } from '@fictjs/testing-library'
      renderHook((() => {
        const x = $state(0)
        return x
      }))
    `

    expect(() =>
      transformSync(source, {
        filename: 'wrapped-render-hook.tsx',
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        },
        plugins: [
          [syntaxJsx, {}],
          [
            createFictPlugin,
            { emitModuleMetadata: false, strictGuarantee: false, reactiveScopes: ['renderHook'] },
          ],
        ],
        generatorOpts: {
          compact: false,
        },
      }),
    ).not.toThrow()
  })

  it('throws when $effect is used inside a loop', () => {
    const source = `
      import { $state, $effect } from 'fict'
      function App() {
        for(let i=0; i<5; i++) {
          $effect(() => console.log(i))
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be called inside loops/)
  })

  it('throws when destructuring $state result', () => {
    // Rule: const { x } = $state(...) is illegal
    const source = `
      import { $state } from 'fict'
      function App() {
        const { x } = $state({ x: 1 })
      }
     `
    expect(() => transform(source)).toThrow(/Destructuring \$state is not supported/)
  })

  it('throws when $state assignment target is not an identifier', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const [x] = $state(0)
        return x
      }
    `
    expect(() => transform(source)).toThrow(/Destructuring \$state is not supported/)
  })

  it('throws when $state is not assigned directly to a variable', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = { count: $state(0) }
        return state.count
      }
    `
    expect(() => transform(source)).toThrow(/assigned directly to a variable/)
  })

  it('throws when $state is used in array literal', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const arr = [$state(0)]
        return arr[0]
      }
    `
    expect(() => transform(source)).toThrow(/assigned directly to a variable/)
  })

  it('throws when $state is used as function argument', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        console.log($state(0))
        return null
      }
    `
    expect(() => transform(source)).toThrow(/assigned directly to a variable/)
  })

  it('throws when assigning to $state call result', () => {
    const source = `
      import { $state } from 'fict'
      let count = $state(0)
      $state(1) = 2
    `
    // Babel throws a syntax error for invalid left-hand side assignment
    expect(() => transform(source)).toThrow(/Invalid left-hand side|must assign to an identifier/)
  })

  it('supports destructuring assignment statements', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        ;[count] = [1]
        return count
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('throws when derived is reassigned inside a branch', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        const doubled = count * 2

        if (count > 0) {
          doubled = 3
        }
        return doubled
      }
    `
    expect(() => transform(source)).toThrow()
  })

  it('throws when writing to a destructured state alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ count: 0 })
        const { count } = state
        count++
        return count
      }
    `
    expect(() => transform(source)).toThrow(/destructured state alias/)
  })

  it('throws when destructuring assignment writes to a destructured state alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ count: 0 })
        const { count } = state
        ;({ count } = { count: 2 })
        return count
      }
    `
    expect(() => transform(source)).toThrow(/destructured state alias/)
  })

  it('allows alias reassignment when state-like name is shadowed by a parameter', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        function inner(count) {
          let x = count
          x = 1
          return x
        }
        return <button>{inner(2)}</button>
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('allows reassignment of shadowed derived names', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        const doubled = count * 2
        function inner() {
          let doubled = 1
          doubled = 2
          return doubled
        }
        return <button>{inner()}</button>
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('does not warn state escape for shadowed local arguments', () => {
    const source = `
      import { $state } from 'fict'
      function consume(value) {
        return value
      }
      function App() {
        let count = $state(0)
        function inner() {
          const count = 1
          consume(count)
        }
        return <button>{inner()}</button>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-S002')).toBe(false)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(false)
    expect(warnings.some(w => w.code === 'FICT-R002')).toBe(false)
  })

  it('warns when passing derived reactive value to unknown function', () => {
    const source = `
      import { $state } from 'fict'
      function sink(value) {
        return value
      }
      function App() {
        let count = $state(0)
        const doubled = count * 2
        sink(doubled)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R002')).toBe(true)
  })

  it('warns when passing reactive value inside object to unknown function', () => {
    const source = `
      import { $state } from 'fict'
      function sink(value) {
        return value
      }
      function App() {
        let count = $state(0)
        sink({ count })
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R002')).toBe(true)
  })

  it('does not warn FICT-R005 for non-escaping array callbacks', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        const items = [1, 2, 3]
        return <ul>{items.map(item => <li>{count + item}</li>)}</ul>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(false)
  })

  it('does not warn FICT-R005 for optional non-escaping array callbacks', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        const items = [1, 2, 3]
        return <ul>{items.map?.(item => <li>{count + item}</li>)}</ul>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(false)
  })

  it('warns FICT-R005 when inline closure escapes via unknown callback boundary', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        consume(() => count)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when inline closure escapes via optional callback boundary', () => {
    const cases = [
      `
        import { $state } from 'fict'
        function consume(fn) {
          return fn()
        }
        function App() {
          let count = $state(0)
          consume?.(() => count)
          return <div />
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          let count = $state(0)
          const bus = { subscribe(fn) { return fn() } }
          bus.subscribe?.(() => count)
          return <div />
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          let count = $state(0)
          Promise.resolve(1)?.then(() => count)
          return <div>{count}</div>
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          let count = $state(0)
          Promise.reject(1)?.catch(() => count)
          return <div>{count}</div>
        }
      `,
      `
        import { $state } from 'fict'
        function App() {
          let count = $state(0)
          Promise.resolve(1)?.finally(() => count)
          return <div>{count}</div>
        }
      `,
    ]

    for (const source of cases) {
      const warnings: Array<{ code: string }> = []
      transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
      expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
    }
  })

  it('warns FICT-R005 when named closure escapes via unknown callback boundary', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        const readCount = () => count
        consume(readCount)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when hoisted closure escapes before declaration', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        consume(readCount)
        function readCount() {
          return count
        }
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when object-property closure escapes via unknown callback boundary', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        const callbacks = { read: () => count }
        consume(callbacks.read)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when aliased object-property closure escapes via unknown callback boundary', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        const callbacks = { read: () => count }
        const read = callbacks.read
        consume(read)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when object shorthand callback slot escapes via unknown boundary', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        const read = () => count
        const callbacks = { read }
        consume(callbacks.read)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('warns FICT-R005 when object slot assigned from captured callback escapes', () => {
    const source = `
      import { $state } from 'fict'
      function consume(fn) {
        return fn()
      }
      function App() {
        let count = $state(0)
        const callbacks = {}
        const readCount = () => count
        callbacks.read = readCount
        consume(callbacks.read)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(true)
  })

  it('does not warn FICT-R005 for JSX event handlers capturing reactive values', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        const handleClick = () => {
          count = count + 1
        }
        return <button onClick={handleClick}>{count}</button>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-R005')).toBe(false)
  })

  it('warns only with FICT-S002 for direct state argument', () => {
    const source = `
      import { $state } from 'fict'
      function sink(value) {
        return value
      }
      function App() {
        let count = $state(0)
        sink(count)
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-S002')).toBe(true)
    expect(warnings.some(w => w.code === 'FICT-R002')).toBe(false)
  })

  it('throws FICT-S002 for local render functions that receive state', () => {
    const source = `
      import { $state } from 'fict'
      function render(value) {
        return value
      }
      function App() {
        let count = $state(0)
        render(count)
        return <div />
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(/FICT-S002/)
  })

  it('throws FICT-S002 for local createMemo functions that receive state', () => {
    const source = `
      import { $state } from 'fict'
      function createMemo(value) {
        return value
      }
      function App() {
        let count = $state(0)
        createMemo(count)
        return <div />
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(/FICT-S002/)
  })

  it('keeps imported render bindings on the state-argument allowlist', () => {
    const source = `
      import { $state, render as mount } from 'fict'
      function App() {
        let count = $state(0)
        mount(count)
        return <div />
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).not.toThrow(/FICT-S002/)
  })

  it('warns on nested mutation through a state member alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ nested: { value: 1 } })
        const nested = state.nested
        nested.value = 2
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('warns on dynamic property access through a state member alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ nested: { value: 1 } })
        const nested = state.nested
        const key = 'value'
        nested[key] = 2
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
  })

  it('does not warn for JSX map callbacks', () => {
    const source = `
      function App() {
        const items = [1, 2, 3]
        return (
          <ul>
            {items.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-C003')).toBe(false)
  })

  it('does not warn effects that read aliases of reactive bindings', () => {
    const source = `
      import { $state, $effect } from 'fict'
      function App() {
        let count = $state(0)
        let alias = count
        const state = $state({ total: 0 })
        const { total } = state
        $effect(() => {
          console.log(alias, total)
        })
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-E001')).toBe(false)
  })

  it('warns when list rendering returns a fragment without a key', () => {
    const source = `
      function App() {
        const items = [1, 2, 3]
        return (
          <div>
            {items.map(item => (
              <>
                <span>{item}</span>
              </>
            ))}
          </div>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(true)
  })

  it('warns when any list return branch is missing a key', () => {
    const source = `
      function App({ items }) {
        return (
          <ul>
            {items.map(item => {
              if (item.kind === 'primary') {
                return <li key={item.id}>{item.name}</li>
              }
              if (item.kind === 'secondary') {
                return <li>{item.name}</li>
              }
              return <li key={item.id + '-fallback'}>{item.name}</li>
            })}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(true)
  })

  it('warns when ternary map branch returns an unkeyed element', () => {
    const source = `
      function App({ items }) {
        return (
          <ul>
            {items.map(item =>
              item.kind === 'primary'
                ? <li key={item.id}>{item.name}</li>
                : <li>{item.name}</li>
            )}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(true)
  })

  it('warns when optional map list items are missing keys', () => {
    const source = `
      function App({ items }) {
        return (
          <ul>
            {items?.map(item => <li>{item.name}</li>)}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(true)
  })

  it('warns when map list items rely on spread-only attrs (key cannot be statically proven)', () => {
    const source = `
      function App({ items }) {
        return (
          <ul>
            {items.map(item => <li {...item}>{item.name}</li>)}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(true)
  })

  it('does not warn for dead unkeyed sequence operands when returned JSX is keyed', () => {
    const source = `
      function App({ items }) {
        return (
          <ul>
            {items.map(item => (
              <li>{item.name}</li>,
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        )
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-J002')).toBe(false)
  })

  it('does not warn effects that read props', () => {
    const source = `
      import { $effect } from 'fict'
      function App(props) {
        const { count } = props
        $effect(() => {
          console.log(props.count, count)
        })
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-E001')).toBe(false)
  })

  it('does not warn effects that read imported reactive bindings', () => {
    const source = `
      import { $effect } from 'fict'
      import { count } from './state'
      function App() {
        $effect(() => {
          console.log(count)
        })
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    const moduleMetadata = new Map<string, any>([['./state', { exports: { count: 'signal' } }]])
    transform(source, {
      moduleMetadata,
      onWarn: warning => warnings.push(warning as { code: string }),
    })
    expect(warnings.some(w => w.code === 'FICT-E001')).toBe(false)
  })

  it('warns empty effects when $effect is aliased', () => {
    const source = `
      import { $effect as fx } from 'fict'
      function App() {
        fx(() => {
          console.log('once')
        })
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-E001')).toBe(true)
  })

  it('throws when updating a reactive alias with ++', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let alias = count
        alias++
        return <div />
      }
    `
    expect(() => transform(source)).toThrow(/Alias reassignment/)
  })

  it('throws when assigning to a captured reactive alias inside a nested function', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let alias = count
        function update() {
          alias = 2
        }
        return <button onClick={update}>{count}</button>
      }
    `
    expect(() => transform(source)).toThrow(/Alias reassignment/)
  })

  it('throws when updating a captured reactive alias inside a nested function', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let alias = count
        const update = () => {
          alias++
        }
        return <button onClick={update}>{count}</button>
      }
    `
    expect(() => transform(source)).toThrow(/Alias reassignment/)
  })

  it('allows nested function parameters that shadow reactive aliases', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let alias = count
        function update(alias: number) {
          alias = 2
          return alias
        }
        return <button>{update(1)}</button>
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('allows loop counters initialized from reactive expressions', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const items = $state([1, 2, 3, 4])
        const shuffled = [...items]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        return <div>{shuffled.length}</div>
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('allows reassigning locals initialized from reactive member reads', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const items = $state([1, 2, 3, 4])
        let count = items.length
        count++
        return <div>{count}</div>
      }
    `
    expect(() => transform(source)).not.toThrow()
  })

  it('warns on mutating array methods through state', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const items = $state([1, 2])
        items.push(3)
        return <div>{items.length}</div>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('throws under strictGuarantee for mutating array methods through state', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const items = $state([1, 2])
        items.push(3)
        return <div>{items.length}</div>
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(/FICT-M/)
  })

  it('does not warn for non-mutating array methods through state', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const items = $state([1, 2])
        const doubled = items.map(item => item * 2)
        return <div>{doubled.length}</div>
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.filter(w => w.code === 'FICT-M')).toHaveLength(0)
  })

  it('throws when writing to a destructured alias from a state alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ count: 0 })
        const alias = state
        const { count } = alias
        count++
        return <div />
      }
    `
    expect(() => transform(source)).toThrow(/destructured state alias/)
  })

  it('warns on nested mutation through a state alias', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ nested: { value: 1 } })
        const alias = state
        alias.nested.value = 2
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('warns when deleting a nested property from state', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ nested: { value: 1 } })
        delete state.nested
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('throws under strictGuarantee when deleting a nested property from state', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const state = $state({ nested: { value: 1 } })
        delete state.nested
        return <div />
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(/FICT-M/)
  })

  it('warns once for dynamic delete paths through state', () => {
    const source = `
      import { $state } from 'fict'
      function App(key: 'nested') {
        const state = $state({ nested: { value: 1 } })
        delete state[key]
        return <div />
      }
    `
    const warnings: Array<{ code: string }> = []
    transform(source, { onWarn: warning => warnings.push(warning as { code: string }) })
    expect(warnings.filter(w => w.code === 'FICT-M')).toHaveLength(1)
    expect(warnings.filter(w => w.code === 'FICT-H')).toHaveLength(1)
  })
})
