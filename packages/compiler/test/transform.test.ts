import { describe, it, expect } from 'vitest'

import { type FictCompilerOptions } from '../src/index'
import { transform as transformHIR } from './test-utils'

/**
 * Helper to transform source code with the HIR DOM lowering (fine-grained disabled).
 */
function transform(source: string): string {
  return transformWithOptions(source, { fineGrainedDom: false })
}

function transformWithOptions(source: string, options?: FictCompilerOptions): string {
  return transformHIR(source, options)
}

describe('Fict Compiler - Basic Transforms', () => {
  describe('$state transformations', () => {
    it('transforms $state declarations to createSignal', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          return count
        }
      `
      const output = transform(input)
      expect(output).toContain('__fictUseContext')
      expect(output).toContain('__fictUseSignal(__fictCtx, 0')
      expect(output).not.toContain('$state')
    })

    it('transforms state reads to getter calls', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          console.log(count)
          return count
        }
      `
      const output = transform(input)
      expect(output).toContain('count()')
    })

    it('transforms state writes to setter calls', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count = 5
          return count
        }
      `
      const output = transform(input)
      expect(output).toContain('count(5)')
    })

    it('transforms compound assignments', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count += 1
          return count
        }
      `
      const output = transform(input)
      expect(output).toContain('count(count() + 1)')
    })

    it('transforms increment/decrement operators', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count++
          count--
          return count
        }
      `
      const output = transform(input)
      expect(output).toContain('count(count() + 1)')
      expect(output).toContain('count(count() - 1)')
    })
  })

  describe('Derived values', () => {
    it('inlines derived const by default', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          return doubled
        }
      `
      const output = transform(input)
      expect(output).not.toContain('__fictUseMemo')
      expect(output).toContain('count() * 2')
    })

    it('inlines chained derived values by default', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          const fourfold = doubled * 2
          console.log('fourfold', fourfold)
          return null
    }
  `
      const output = transform(input)
      expect(output).not.toContain('__fictUseMemo')
      expect(output).toContain('console.log("fourfold"')
      expect(output).toContain('count()')
    })

    it('groups independent derived values into a region memo when inlining is disabled', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          const squared = count * count
          console.log(doubled, squared)
          return null
        }
      `
      const output = transformWithOptions(input, { inlineDerivedMemos: false })
      // Region memo groups related derived values
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('doubled')
      expect(output).toContain('squared')
    })

    it('does not memo function expressions', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const handler = () => console.log(count)
          return handler
        }
      `
      const output = transform(input)
      expect(output).not.toContain('__fictMemo')
      expect(output).toContain('count()')
    })

    it('creates getter for event-only usage', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          const onClick = () => console.log(doubled)
          return onClick
        }
      `
      const output = transform(input)
      // Memo is created with an ID parameter for tracking
      expect(output).toMatch(/__fictUseMemo\(__fictCtx, \(\) => count\(\) \* 2, \d+\)/)
      expect(output).toContain('onClick = () => console.log(doubled())')
    })

    it('creates getter for plain function-only usage (non-JSX handler)', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          function useLog() {
            function log() {
              return doubled
            }
            return log
          }
          return useLog
        }
      `
      const output = transform(input)
      // The output includes memos and doubled() getter calls
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('doubled()')
    })
  })

  describe('Event handler safety', () => {
    it('does not wrap event handlers with useEffect for tracked reads', () => {
      const input = `
        import { $state } from 'fict'
        function App() {
          let rows = $state([{ id: 1 }])
          let selected = $state(1)
          const remove = (id) => {
            rows(rows().filter(row => row.id !== id))
            if (selected() === id) selected(null)
          }
          return <button onClick={() => remove(1)}>Remove</button>
        }
      `
      const output = transform(input)
      expect(output).not.toContain('__fictUseEffect(__fictCtx')
    })
  })

  describe('$effect transformations', () => {
    it('transforms $effect to createEffect', () => {
      const input = `
        import { $state, $effect } from 'fict'
        function Component() {
          let count = $state(0)
          $effect(() => {
            console.log(count)
          })
        }
      `
      const output = transform(input)
      expect(output).toContain('__fictUseEffect(__fictCtx, () => {')
      expect(output).not.toContain('$effect')
    })
  })

  describe('Parameter shadowing', () => {
    it('handles parameter shadowing', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const fn = (count) => count + 1
          return fn
        }
      `
      const output = transform(input)
      // Inner count should not be transformed
      expect(output).toContain('count + 1')
      expect(output).not.toContain('count() + 1')
    })

    it('handles destructuring parameter shadowing', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let value = $state(0)
          const fn = ({ value }) => value + 1
          return fn
        }
      `
      const output = transform(input)
      // Inner value should not be transformed
      expect(output).toContain('value + 1')
    })

    it('handles array destructuring shadowing', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let x = $state(0)
          const fn = ([x]) => x + 1
          return fn
        }
      `
      const output = transform(input)
      expect(output).toContain('x + 1')
    })
  })

  describe('JSX transformations', () => {
    it('wraps reactive JSX children', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const el = <div>{count}</div>
          return el
        }
      `
      const output = transform(input)
      expect(output).toContain('() => count()')
    })

    it('wraps reactive JSX attributes', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let disabled = $state(false)
          const el = <button disabled={disabled}>Click</button>
          return el
        }
      `
      const output = transform(input)
      expect(output).toContain('() => disabled()')
    })

    it('does not wrap event handlers', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const el = <button onClick={() => count++}>Click</button>
          return el
        }
      `
      const output = transform(input)
      // Event handler should not be wrapped in an additional arrow function
      // Delegated events like click use direct property assignment for performance
      expect(output).toContain('$$click')
      expect(output).toContain('count(count() + 1)')
      expect(output).not.toContain('onClick: () => () =>')
    })

    it('does not wrap key attribute', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let id = $state('1')
          const el = <div key={id}>Content</div>
          return el
        }
      `
      const output = transform(input)
      // key attribute should get the reactive value but not be wrapped in arrow function
      // In JSX transform, key is passed as the third argument to _jsx
      expect(output).toContain('id()')
      expect(output).not.toContain('() => id()')
    })
  })

  describe('Fine-grained DOM lowering (default)', () => {
    it('emits direct DOM creation and bindings for simple intrinsic JSX', () => {
      const input = `
        import { $state } from 'fict'
        function View() {
          let count = $state(0)
          return <button data-count={count}>{count}</button>
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('bindAttribute')
      expect(output).toContain('bindText')
      expect(output).toContain('count()')
    })

    it('lowers keyed list renderers to fine-grained DOM operations', () => {
      const input = `
        import { $state } from 'fict'
        function List() {
          let items = $state([{ id: 1, label: 'One' }])
          return <ul>{items.map(item => <li key={item.id}>{item.label}</li>)}</ul>
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('createKeyedList')
      expect(output).toContain('toNodeArray')
      expect(output).toContain('template')
      expect(output).toContain('bindText')
      expect(output).toContain('item().label')
    })

    it('rewrites unkeyed list callback params to signal getters', () => {
      const input = `
        import { $state } from 'fict'
        function Scores() {
          let scores = $state([98.5, 100])
          return (
            <ul>
              {scores.map((score, idx) => {
                const isPerfect = score === 100
                const scoreType = typeof score
                return <li data-idx={idx}>{scoreType}:{isPerfect ? 'yes' : 'no'}:{score}</li>
              })}
            </ul>
          )
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('createKeyedList')
      expect(output).toContain('score() === 100')
      expect(output).toContain('typeof score()')
      expect(output).toContain('idx()')
    })

    it('lowers conditional branches to fine-grained DOM operations', () => {
      const input = `
        import { $state } from 'fict'
        function View() {
          const show = $state(true)
          const label = $state('ready')
          return <section>{show() ? <span>{label()}</span> : <p>off</p>}</section>
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('template')
    })

    it('lowers refs to assignment with cleanup in fine-grained mode', () => {
      const input = `
        import { createRef } from 'fict'
        function View() {
          const ref = createRef<HTMLInputElement>()
          const cb = (el: HTMLElement | null) => { window.last = el }
          return <div><input ref={ref} /><input ref={cb} /></div>
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('bindRef')
      expect(output).toContain('ref')
      expect(output).toContain('cb')
    })

    it('wraps createPortal calls with dispose registration', () => {
      const input = `
        import { $state, createPortal, createElement } from 'fict'
        function View() {
          let count = $state(0)
          return (
            <>
              <div data-id="host">host</div>
              {createPortal(document.body, () => <div data-id="portal">{count}</div>, createElement)}
            </>
          )
        }
      `
      const output = transformWithOptions(input)
      // Check that the output includes template cloning for the portal content
      expect(output).toContain('template')
      expect(output).toContain('bindText')
    })

    it('lowers value/checked to property bindings', () => {
      const input = `
        import { $state } from 'fict'
        function View() {
          const val = $state('')
          const on = $state(false)
          return <input value={val} checked={on} />
        }
      `
      const output = transformWithOptions(input)
      expect(output).toContain('bindProperty')
      expect(output).not.toContain('bindAttribute(__fg')
    })
  })

  describe('Shorthand properties', () => {
    it('transforms shorthand property assignments', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const obj = { count }
          return obj
        }
      `
      const output = transform(input)
      expect(output).toContain('count: count()')
    })
  })
})

describe('Fict Compiler - Error Cases', () => {
  it('throws error for $state in loop', () => {
    const input = `
        import { $state } from 'fict'
        function Component() {
          for (let i = 0; i < 10; i++) {
            let count = $state(0)
          }
          return null
        }
      `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws error for $state in while loop', () => {
    const input = `
        import { $state } from 'fict'
        function Component() {
          while (true) {
            let count = $state(0)
            break
          }
          return null
        }
      `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws error for $state with destructuring', () => {
    const input = `
        import { $state } from 'fict'
        const { x } = $state({ x: 1 })
      `
    expect(() => transform(input)).toThrow(/Destructuring \$state is not supported/)
  })

  it('throws error when assigning to $state call result', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      $state(1) = 2
    `
    // Babel's parser throws before our transform can validate
    expect(() => transform(input)).toThrow(/Invalid left-hand side in assignment expression/)
  })
})

describe('Fict Compiler - Integration', () => {
  it('handles complete component', () => {
    const input = `
      import { $state, $effect } from 'fict'

      export function Counter() {
        let count = $state(0)
        const doubled = count * 2

        $effect(() => {
          document.title = \`Count: \${count}\`
        })

        return (
          <div>
            <p>{doubled}</p>
            <button onClick={() => count++}>Increment</button>
          </div>
        )
      }
    `
    const output = transform(input)

    // Should have runtime imports
    expect(output).toContain('__fictUseContext')
    expect(output).toContain('__fictUseSignal')
    expect(output).toContain('__fictUseMemo')
    expect(output).toContain('__fictUseEffect')

    // Should transform state
    expect(output).toContain('__fictUseSignal(__fictCtx, 0')

    // Should transform effect
    expect(output).toContain('__fictUseEffect')

    // Should wrap reactive JSX
    expect(output).toContain('count() * 2')
  })
})
