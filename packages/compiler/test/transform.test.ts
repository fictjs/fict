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
        let count = $state(0)
      `
      const output = transform(input)
      expect(output).toContain('__fictPushContext')
      expect(output).toContain('__fictPopContext')
      expect(output).toContain('__fictUseSignal(__fictCtx, 0)')
      expect(output).not.toContain('$state')
    })

    it('transforms state reads to getter calls', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        console.log(count)
      `
      const output = transform(input)
      expect(output).toContain('count()')
    })

    it('transforms state writes to setter calls', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        count = 5
      `
      const output = transform(input)
      expect(output).toContain('count(5)')
    })

    it('transforms compound assignments', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        count += 1
      `
      const output = transform(input)
      expect(output).toContain('count(count() + 1)')
    })

    it('transforms increment/decrement operators', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        count++
        count--
      `
      const output = transform(input)
      expect(output).toContain('count(count() + 1)')
      expect(output).toContain('count(count() - 1)')
    })
  })

  describe('Derived values', () => {
    it('creates memo for derived const', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const doubled = count * 2
      `
      const output = transform(input)
      // Memo is created with an ID parameter for tracking
      expect(output).toMatch(/__fictUseMemo\(__fictCtx, \(\) => count\(\) \* 2, \d+\)/)
    })

    it('creates memo for chained derived values (derived-from-derived) in component body', () => {
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
      // Dependent derived values should each get their own memo to preserve memoized chains.
      // Memos are created with ID parameters for tracking
      expect(output).toMatch(/__fictUseMemo\(__fictCtx, \(\) => count\(\) \* 2, \d+\)/)
      expect(output).toMatch(/__fictUseMemo\(__fictCtx, \(\) => doubled\(\) \* 2, \d+\)/)
      expect(output).toContain('console.log("fourfold", fourfold())')
      // Note: regions ARE now created in the new HIR codegen
      expect(output).toContain('__region_')
    })

    it('groups independent derived values into a region memo', () => {
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
      const output = transform(input)
      // Region memo groups related derived values
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('doubled')
      expect(output).toContain('squared')
    })

    it('does not memo function expressions', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const handler = () => console.log(count)
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
        function useLog() {
          let count = $state(0)
          const doubled = count * 2
          function log() {
            return doubled
          }
          return log
        }
      `
      const output = transform(input)
      // The output includes memos and doubled() getter calls
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('doubled()')
    })
  })

  describe('$effect transformations', () => {
    it('transforms $effect to createEffect', () => {
      const input = `
        import { $state, $effect } from 'fict'
        let count = $state(0)
        $effect(() => {
          console.log(count)
        })
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
        let count = $state(0)
        const fn = (count) => count + 1
      `
      const output = transform(input)
      // Inner count should not be transformed
      expect(output).toContain('count + 1')
      expect(output).not.toContain('count() + 1')
    })

    it('handles destructuring parameter shadowing', () => {
      const input = `
        import { $state } from 'fict'
        let value = $state(0)
        const fn = ({ value }) => value + 1
      `
      const output = transform(input)
      // Inner value should not be transformed
      expect(output).toContain('value + 1')
    })

    it('handles array destructuring shadowing', () => {
      const input = `
        import { $state } from 'fict'
        let x = $state(0)
        const fn = ([x]) => x + 1
      `
      const output = transform(input)
      expect(output).toContain('x + 1')
    })
  })

  describe('JSX transformations', () => {
    it('wraps reactive JSX children', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const el = <div>{count}</div>
      `
      const output = transform(input)
      expect(output).toContain('() => count()')
    })

    it('wraps reactive JSX attributes', () => {
      const input = `
        import { $state } from 'fict'
        let disabled = $state(false)
        const el = <button disabled={disabled}>Click</button>
      `
      const output = transform(input)
      expect(output).toContain('() => disabled()')
    })

    it('does not wrap event handlers', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const el = <button onClick={() => count++}>Click</button>
      `
      const output = transform(input)
      // Event handler should not be wrapped in an additional arrow function
      // The HIR codegen uses bindEvent for events
      expect(output).toContain('bindEvent')
      expect(output).toContain('count(count() + 1)')
      expect(output).not.toContain('onClick: () => () =>')
    })

    it('does not wrap key attribute', () => {
      const input = `
        import { $state } from 'fict'
        let id = $state('1')
        const el = <div key={id}>Content</div>
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
      expect(output).toContain('insert')
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
      expect(output).toContain('insert')
      expect(output).toContain('item().label')
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
      expect(output).toContain('insert')
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
      // Check that the output includes template cloning and insert for the portal content
      expect(output).toContain('template')
      expect(output).toContain('insert')
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
        let count = $state(0)
        const obj = { count }
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
        for (let i = 0; i < 10; i++) {
          let count = $state(0)
        }
      `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws error for $state in while loop', () => {
    const input = `
        import { $state } from 'fict'
        while (true) {
          let count = $state(0)
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
    expect(output).toContain('__fictUseSignal(__fictCtx, 0)')

    // Should transform derived
    expect(output).toContain('__fictUseMemo')

    // Should transform effect
    expect(output).toContain('__fictUseEffect')

    // Should wrap reactive JSX
    expect(output).toContain('() => doubled()')
  })
})
