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
})
