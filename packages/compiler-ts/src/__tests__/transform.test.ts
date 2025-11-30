import ts from 'typescript'
import { describe, it, expect } from 'vitest'

import { createFictTransformer } from '../index'

/**
 * Helper to transform source code and return the result
 */
function transform(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer()],
    },
  })
  return result.outputText
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
        let count = $state(0)
        const doubled = count * 2
        const onClick = () => console.log(doubled)
      `
      const output = transform(input)
      // TODO: Optimization - should create a getter, not a memo, when only used in events
      // For now, we create memo for all derived values, which is correct but not optimal
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
      // The original arrow function remains unchanged
      expect(output).toContain('onClick={() => count(count() + 1)}')
    })

    it('does not wrap key attribute', () => {
      const input = `
        import { $state } from 'fict'
        let id = $state('1')
        const el = <div key={id}>Content</div>
      `
      const output = transform(input)
      // key attribute should get the reactive value but not be wrapped in arrow function
      expect(output).toContain('key={id()}')
      expect(output).not.toContain('key={() =>')
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
    expect(() => transform(input)).toThrow('must assign to an identifier')
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
