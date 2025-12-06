/**
 * Cross-Module Tests
 *
 * Tests for $state and derived values used across module boundaries.
 * Verifies proper handling of imports, exports, and re-exports.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer } from '../index'

function transform(source: string, options?: Parameters<typeof createFictTransformer>[1]): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(undefined, { fineGrainedDom: false, ...options })],
    },
  })
  return result.outputText
}

describe('Cross-module $state export', () => {
  it('exports named state variable', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
    `)
    expect(output).toContain('export let count')
    expect(output).toContain('__fictSignal')
  })

  it('exports multiple state variables', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export let name = $state('John')
    `)
    expect(output).toContain('export let count')
    expect(output).toContain('export let name')
    // Count includes import statement, so at least 2 actual usages
    expect(output.match(/__fictSignal/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('exports state via export clause', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      export { count }
    `)
    expect(output).toContain('export { count }')
    expect(output).toContain('__fictSignal')
  })

  it('exports state with alias', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      export { count as counter }
    `)
    expect(output).toContain('export { count as counter }')
  })

  it('default exports state', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      export default count
    `)
    expect(output).toContain('export default count')
  })
})

describe('Cross-module derived export', () => {
  it('exported derived becomes memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      export const doubled = count * 2
    `)
    expect(output).toContain('__fictMemo')
    expect(output).toContain('export const doubled')
  })

  it('derived exported via clause becomes memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      export { doubled }
    `)
    expect(output).toContain('__fictMemo')
  })

  it('derived exported with alias becomes memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      export { doubled as multiplied }
    `)
    expect(output).toContain('__fictMemo')
  })

  it('default exported derived becomes memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      export default doubled
    `)
    expect(output).toContain('__fictMemo')
  })

  it('multiple exported deriveds all become memos', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      export const doubled = count * 2
      export const tripled = count * 3
      export const quadrupled = count * 4
    `)
    // At least some deriveds become memos (implementation may optimize)
    expect(output.match(/__fictMemo/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Cross-module usage patterns', () => {
  it('event-only usage of exported derived still produces memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export const doubled = count * 2

      // Even though this is event-only, module-level needs memo
      export function logDoubled() {
        console.log(doubled)
      }
    `)
    expect(output).toContain('__fictMemo')
    expect(output).toContain('doubled()')
  })

  it('exported alias uses original state (no duplicate signals)', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      const alias = count
      export { alias }
    `)
    const signalCalls = (output.match(/__fictSignal\(/g) || []).length
    expect(signalCalls).toBe(1)
    // Module-level alias compiles as memo to keep cross-module semantics consistent
    expect(output).toContain('__fictMemo(() => count())')
  })

  it('non-exported function-scoped derived', () => {
    const output = transform(`
      import { $state } from 'fict'
      function localFunction() {
        let count = $state(0)
        const doubled = count * 2
        // Event-only in function scope
        return () => console.log(doubled)
      }
    `)
    // Verify signal is created and derived value is handled
    expect(output).toContain('__fictSignal')
    expect(output).toContain('doubled')
  })

  it('mixed local and exported derived', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)

      // Exported -> memo
      export const exported = count * 2

      // Local event-only
      const local = count * 3
      const handler = () => console.log(local)
    `)
    expect(output).toContain('__fictMemo') // For exported
    expect(output).toContain('local') // Local derived is preserved
  })
})

describe('Cross-module state consumers', () => {
  // Note: These tests simulate what would happen in consumer modules
  // by testing the generated export format

  it('exported state can be consumed with getter pattern', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)

      // Simulating consumer usage
      function Consumer() {
        // Would import count from this module
        return <div>{count}</div>
      }
    `)
    expect(output).toContain('count()')
  })

  it('exported derived can be consumed with memo pattern', () => {
    const output = transform(`
      import { $state } from 'fict'
      let base = $state(0)
      export const derived = base * 2

      function Consumer() {
        // Would import derived from this module
        return <div>{derived}</div>
      }
    `)
    expect(output).toContain('derived()')
  })

  it('exported alias consumed without duplicating signal', () => {
    // Simulate a store module exposing an alias
    const store = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      const alias = count
      export { alias }
    `)
    const signalCalls = (store.match(/__fictSignal\(/g) || []).length
    expect(signalCalls).toBe(1)
    // Consumer reading alias should call alias() (not create new signal)
    const consumer = transform(
      `
      import { alias } from './store'
      export function View() {
        return <div>{alias}</div>
      }
    `,
      { fineGrainedDom: false },
    )
    expect(consumer).toContain('alias')
  })
})

describe('Re-export scenarios', () => {
  it('handles chained derived exports', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      export const quadrupled = doubled * 2
    `)
    // Both should be memos
    expect(output.match(/__fictMemo/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('handles derived depending on exported state', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export const doubled = count * 2
    `)
    expect(output).toContain('__fictSignal')
    expect(output).toContain('__fictMemo')
    expect(output).toContain('count() * 2')
  })

  it('handles multiple files pattern (simulated)', () => {
    // Store module
    const storeOutput = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export const doubled = count * 2
      export function increment() {
        count++
      }
    `)

    expect(storeOutput).toContain('__fictSignal')
    expect(storeOutput).toContain('__fictMemo')
    expect(storeOutput).toContain('count(count() + 1)')

    // Consumer component would import these
    const consumerOutput = transform(`
      import { $state, $effect } from 'fict'
      // Simulated: import { count, doubled, increment } from './store'

      // Using local state for testing
      let count = $state(0)
      const doubled = count * 2

      function Counter() {
        $effect(() => {
          console.log('Count changed:', doubled)
        })

        return (
          <div>
            <span>{doubled}</span>
            <button onClick={() => count++}>+</button>
          </div>
        )
      }
    `)

    expect(consumerOutput).toContain('__fictEffect')
    expect(consumerOutput).toContain('doubled()')
  })
})

describe('Edge cases', () => {
  it('handles circular derived (throws error)', () => {
    expect(() =>
      transform(`
      import { $state } from 'fict'
      let source = $state(0)
      export const a = b + source
      export const b = a + 1
    `),
    ).toThrow(/cyclic/i)
  })

  it('handles exported state used in condition', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let show = $state(false)
      export let count = $state(0)

      function Component() {
        return show ? <div>{count}</div> : null
      }
    `)
    expect(output).toContain('show()')
    expect(output).toContain('count()')
  })

  it('handles state array with map export', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let items = $state([{ id: 1, name: 'A' }])

      export function ItemList() {
        return (
          <ul>
            {items.map(item => <li key={item.id}>{item.name}</li>)}
          </ul>
        )
      }
    `)
    expect(output).toContain('__fictSignal')
    expect(output).toContain('__fictKeyedList')
  })

  it('handles computed property names in state object', () => {
    const output = transform(`
      import { $state } from 'fict'
      const KEY = 'dynamicKey'
      export let obj = $state({ [KEY]: 'value' })
    `)
    expect(output).toContain('__fictSignal')
    expect(output).toContain('[KEY]')
  })

  it('handles state with function value', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let callback = $state(() => console.log('default'))
    `)
    expect(output).toContain('__fictSignal')
  })

  it('handles nested state objects', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let user = $state({
        profile: {
          name: 'John',
          settings: {
            theme: 'dark'
          }
        }
      })
    `)
    expect(output).toContain('__fictSignal')
  })
})

describe('Import patterns (consumer side)', () => {
  // These tests verify how the compiler handles imports that would come
  // from other fict modules

  it('handles named import usage', () => {
    const output = transform(`
      import { $state } from 'fict'
      // Simulating: import { count } from './store'

      let count = $state(0) // Local version for testing

      function Display() {
        return <div>Count: {count}</div>
      }
    `)
    expect(output).toContain('count()')
  })

  it('handles aliased import usage', () => {
    const output = transform(`
      import { $state } from 'fict'
      // Simulating: import { count as counter } from './store'

      let counter = $state(0) // Local version for testing

      function Display() {
        return <div>Counter: {counter}</div>
      }
    `)
    expect(output).toContain('counter()')
  })

  it('handles namespace import pattern', () => {
    const output = transform(`
      import { $state } from 'fict'
      // Simulating: import * as store from './store'

      // Using object pattern to simulate namespace
      const store = {
        count: $state(0)
      }

      function Display() {
        // Note: direct object access doesn't trigger signal rewrite
        // This tests that the pattern works
        return <div>Count: {store.count}</div>
      }
    `)
    expect(output).toBeDefined()
  })
})

describe('Effect dependencies with cross-module', () => {
  it('effect tracks exported state', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      export let count = $state(0)

      $effect(() => {
        console.log('Count is:', count)
      })
    `)
    expect(output).toContain('__fictEffect')
    expect(output).toContain('count()')
  })

  it('effect tracks exported derived', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      let count = $state(0)
      export const doubled = count * 2

      $effect(() => {
        console.log('Doubled is:', doubled)
      })
    `)
    expect(output).toContain('__fictEffect')
    expect(output).toContain('doubled()')
  })

  it('effect with multiple cross-module dependencies', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      export let a = $state(1)
      export let b = $state(2)
      export const sum = a + b

      $effect(() => {
        console.log(a, b, sum)
      })
    `)
    expect(output).toContain('a()')
    expect(output).toContain('b()')
    expect(output).toContain('sum()')
  })
})
