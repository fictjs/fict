import { describe, expect, it } from 'vitest'
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

  it('throws when $state is declared inside a nested function (closure)', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const handleClick = () => {
          const x = $state(0)
        }
      }
    `
    expect(() => transform(source)).toThrow(
      /component or hook function body|no nested functions|cannot be declared inside nested functions/,
    )
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
      /component or hook function body|no nested functions|cannot be declared inside nested functions/,
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
      /component or hook function body|no nested functions|cannot be declared inside nested functions/,
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
      /component or hook function body|no nested functions|cannot be declared inside nested functions/,
    )
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
})
