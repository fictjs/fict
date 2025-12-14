import { describe, it, expect } from 'vitest'

import { type FictCompilerOptions } from '../src/index'

import { transformFineGrained, transformLegacyDom } from './test-utils'

/**
 * Helper to transform source code with the legacy DOM lowering (fine-grained disabled).
 */
function transform(source: string): string {
  return transformWithOptions(source, { fineGrainedDom: false })
}

function transformWithOptions(source: string, options?: FictCompilerOptions): string {
  return transformFineGrained(source, options)
}

describe('Fict Compiler - Basic Transforms', () => {
  describe('$state transformations', () => {
    it('transforms $state declarations to createSignal', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
      `
      const output = transform(input)
      expect(output).toContain('createSignal as __fictSignal')
      expect(output).toContain('__fictSignal(0)')
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
      expect(output).toContain('createMemo as __fictMemo')
      expect(output).toContain('__fictMemo(() => count() * 2)')
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
      expect(output).toContain('const doubled = () =>')
      // Getter is created but not auto-called inside nested arrow functions
      expect(output).toContain('console.log(doubled)')
      expect(output).not.toContain('__fictMemo')
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
      expect(output).toContain('const doubled = () =>')
      // Getter is created but not auto-called inside nested functions
      expect(output).toContain('return doubled')
      expect(output).not.toContain('return doubled()')
      expect(output).not.toContain('__fictMemo')
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
      expect(output).toContain('createEffect as __fictEffect')
      expect(output).toContain('__fictEffect(')
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
      // The original arrow function remains unchanged (in object property format after JSX transform)
      expect(output).toContain('onClick: () => count(count() + 1)')
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
      expect(output).toContain('document.createElement("button")')
      expect(output).toContain('document.createTextNode')
      expect(output).toContain('__fictBindAttribute')
      expect(output).toContain('__fictBindText')
      expect(output).toContain('const __fg0_el0 = document.createElement("button")')
      expect(output).toContain('const __fg0_txt0 = document.createTextNode("")')
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
      expect(output).toContain('__fictCreateKeyedListContainer')
      expect(output).toContain('__fictMoveMarkerBlock')
      expect(output).toContain('document.createElement("li")')
      expect(output).toContain('__fictBindText')
      expect(output).toContain('__fgValueSig().label')
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
      expect(output).toContain('__fictConditional')
      // Conditional branches are lowered to DOM API calls
      expect(output).toContain('createElement("span")')
      expect(output).toContain('createElement("p")')
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
      expect(output).toContain('.current = __fg0_el')
      expect(output).toContain('__fictOnDestroy(() => __fictRef_')
      expect(output).toContain('(__fg0_el')
      expect(output).toContain('__fictOnDestroy(() => {')
      expect(output).toContain('.current = null')
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
      expect(output).toContain('createPortal(document.body')
      // Portal content is lowered to fine-grained DOM
      expect(output).toContain('document.createElement("div")')
      expect(output).toContain('__fictBindText')
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
      expect(output).toContain('__fictBindProperty')
      expect(output).not.toContain('__fictBindAttribute(__fg')
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
    expect(output).toContain('createSignal as __fictSignal')
    expect(output).toContain('createMemo as __fictMemo')
    expect(output).toContain('createEffect as __fictEffect')

    // Should transform state
    expect(output).toContain('__fictSignal(0)')

    // Should transform derived
    expect(output).toContain('__fictMemo')

    // Should transform effect
    expect(output).toContain('__fictEffect')

    // Should wrap reactive JSX
    expect(output).toContain('() => doubled()')
  })
})
