import { describe, expect, it } from 'vitest'
import ts from 'typescript'

import { createFictTransformer } from '../src'

function transform(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(null)],
    },
  })

  return result.outputText.trim()
}

describe('createFictTransformer', () => {
  describe('Basic transformations', () => {
    it('rewrites $state to createSignal', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
      `)

      expect(output).toContain(`import { createSignal as __fictSignal } from "fict-runtime";`)
      expect(output).toContain(`let count = __fictSignal(0);`)
      expect(output).not.toContain('$state')
    })

    it('rewrites derived const to createMemo', () => {
      const output = transform(`
        let count = $state(0)
        const doubled = count * 2
      `)

      expect(output).toContain(`const doubled = __fictMemo(() => count() * 2);`)
    })

    it('rewrites $effect to createEffect', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'
        let count = $state(0)
        $effect(() => {
          console.log(count)
        })
      `)

      expect(output).toContain(`__fictEffect(() => {`)
      expect(output).toContain(`console.log(count());`)
    })

    it('transforms assignment operators', () => {
      const output = transform(`
        let count = $state(0)
        count = 5
        count += 1
        count -= 2
        count *= 3
        count /= 4
      `)

      expect(output).toContain(`count(5);`)
      expect(output).toContain(`count(count() + 1);`)
      expect(output).toContain(`count(count() - 2);`)
      expect(output).toContain(`count(count() * 3);`)
      expect(output).toContain(`count(count() / 4);`)
    })

    it('transforms increment/decrement operators', () => {
      const output = transform(`
        let count = $state(0)
        count++
        count--
        ++count
        --count
      `)

      expect(output).toContain(`count(count() + 1);`)
      expect(output).toContain(`count(count() - 1);`)
    })

    it('converts shorthand properties using tracked identifiers', () => {
      const output = transform(`
        let count = $state(1)
        const payload = { count, other: count + 1 }
      `)

      expect(output).toContain(`let count = __fictSignal(1);`)
      expect(output).toContain(
        `const payload = __fictMemo(() => ({ count: count(), other: count() + 1 }));`,
      )
    })
  })

  describe('JSX child expressions', () => {
    it('wraps reactive values in JSX children', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count}</div>
      `)

      expect(output).toContain(`{() => count()}`)
    })

    it('wraps derived values in JSX children', () => {
      const output = transform(`
        let count = $state(0)
        const doubled = count * 2
        const view = () => <div>{doubled}</div>
      `)

      expect(output).toContain(`{() => doubled()}`)
    })

    it('does not wrap static values in JSX children', () => {
      const output = transform(`
        const view = () => <div>{"static"}</div>
      `)

      expect(output).toContain(`{"static"}`)
      expect(output).not.toContain(`{() =>`)
    })

    it('does not wrap static expressions in JSX children', () => {
      const output = transform(`
        const view = () => <div>{1 + 2}</div>
      `)

      expect(output).toContain(`{1 + 2}`)
      expect(output).not.toContain(`{() =>`)
    })

    it('wraps complex expressions that depend on state', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count > 0 ? 'positive' : 'zero'}</div>
      `)

      expect(output).toContain(`{() => count() > 0 ? 'positive' : 'zero'}`)
    })

    it('wraps array.map expressions that depend on state', () => {
      const output = transform(`
        let items = $state(['a', 'b', 'c'])
        const view = () => <ul>{items.map(item => <li>{item}</li>)}</ul>
      `)

      expect(output).toContain(`{() => items().map(item => <li>{item}</li>)}`)
    })

    it('does not wrap already-function expressions', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{() => count}</div>
      `)

      // Should not double-wrap
      expect(output).not.toContain(`{() => () =>`)
      expect(output).toContain(`{() => count()}`)
    })
  })

  describe('JSX attribute expressions', () => {
    it('wraps reactive values in attributes', () => {
      const output = transform(`
        let isValid = $state(false)
        const view = () => <button disabled={!isValid}>Click</button>
      `)

      expect(output).toContain(`disabled={() => !isValid()}`)
    })

    it('wraps derived values in attributes', () => {
      const output = transform(`
        let count = $state(0)
        const isEmpty = count === 0
        const view = () => <button disabled={isEmpty}>Click</button>
      `)

      expect(output).toContain(`disabled={() => isEmpty()}`)
    })

    it('wraps template literals that depend on state', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div title={\`Count: \${count}\`}>test</div>
      `)

      expect(output).toContain('title={() => `Count: ${count()}`}')
    })

    it('does not wrap event handlers', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <button onClick={() => count++}>Click</button>
      `)

      // Event handler should NOT be wrapped in () =>
      expect(output).toContain(`onClick={() => count(count() + 1)}`)
      expect(output).not.toContain(`onClick={() => () =>`)
    })

    it('does not wrap key attribute', () => {
      const output = transform(`
        let items = $state([{ id: 1 }])
        const view = () => items.map(item => <div key={item.id}>{item.id}</div>)
      `)

      expect(output).toContain(`key={item.id}`)
      expect(output).not.toContain(`key={() =>`)
    })

    it('does not wrap ref attribute', () => {
      const output = transform(`
        let myRef = $state(null)
        const view = () => <div ref={myRef}>test</div>
      `)

      expect(output).toContain(`ref={myRef()}`)
      expect(output).not.toContain(`ref={() =>`)
    })

    it('does not wrap static string attributes', () => {
      const output = transform(`
        const view = () => <div id="static">test</div>
      `)

      expect(output).toContain(`id="static"`)
    })
  })

  describe('Complex JSX patterns', () => {
    it('handles conditional rendering with &&', () => {
      const output = transform(`
        let show = $state(true)
        const view = () => <div>{show && <span>Visible</span>}</div>
      `)

      expect(output).toContain(`{() => show() && <span>Visible</span>}`)
    })

    it('handles ternary conditional rendering', () => {
      const output = transform(`
        let show = $state(true)
        const view = () => <div>{show ? <span>Yes</span> : <span>No</span>}</div>
      `)

      expect(output).toContain(`{() => show() ? <span>Yes</span> : <span>No</span>}`)
    })

    it('handles nested components with reactive props', () => {
      const output = transform(`
        let count = $state(0)
        const Child = ({ value }) => <span>{value}</span>
        const Parent = () => <Child value={count} />
      `)

      expect(output).toContain(`value={() => count()}`)
    })

    it('handles multiple reactive values in one expression', () => {
      const output = transform(`
        let a = $state(1)
        let b = $state(2)
        const view = () => <div>{a + b}</div>
      `)

      expect(output).toContain(`{() => a() + b()}`)
    })

    it('handles class binding with reactive value', () => {
      const output = transform(`
        let active = $state(false)
        const view = () => <div class={active ? 'active' : ''}>test</div>
      `)

      expect(output).toContain(`class={() => active() ? 'active' : ''}`)
    })

    it('handles style binding with reactive value', () => {
      const output = transform(`
        let color = $state('red')
        const view = () => <div style={{ color: color }}>test</div>
      `)

      expect(output).toContain(`style={() => ({ color: color() })}`)
    })
  })

  describe('Full component transformation', () => {
    it('transforms a complete Counter component', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'

        export function Counter() {
          let count = $state(0)
          const doubled = count * 2

          $effect(() => {
            document.title = \`Count: \${count}\`
          })

          return (
            <div>
              <p>Count: {count}</p>
              <p>Doubled: {doubled}</p>
              <button onClick={() => count++}>+1</button>
              <button onClick={() => count--}>-1</button>
            </div>
          )
        }
      `)

      // Check imports
      expect(output).toContain(
        `import { createSignal as __fictSignal, createMemo as __fictMemo, createEffect as __fictEffect } from "fict-runtime";`,
      )

      // Check state and memo
      expect(output).toContain(`let count = __fictSignal(0);`)
      expect(output).toContain(`const doubled = __fictMemo(() => count() * 2);`)

      // Check effect
      expect(output).toContain(`__fictEffect(() => {`)
      expect(output).toContain('document.title = `Count: ${count()}`')

      // Check JSX reactive bindings
      expect(output).toContain(`{() => count()}`)
      expect(output).toContain(`{() => doubled()}`)

      // Check event handlers (should not be double-wrapped)
      expect(output).toContain(`onClick={() => count(count() + 1)}`)
      expect(output).toContain(`onClick={() => count(count() - 1)}`)
    })

    it('transforms a TodoList component', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function TodoList() {
          let todos = $state([
            { id: 1, text: 'Learn Fict', done: false },
            { id: 2, text: 'Build app', done: false },
          ])
          let filter = $state('all')

          const filteredTodos = todos.filter(todo => {
            if (filter === 'active') return !todo.done
            if (filter === 'completed') return todo.done
            return true
          })

          return (
            <div>
              <select value={filter} onChange={e => filter = e.target.value}>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
              </select>
              <ul>
                {filteredTodos.map(todo => (
                  <li key={todo.id} class={todo.done ? 'done' : ''}>
                    {todo.text}
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      `)

      // Check state variables
      expect(output).toContain(`let todos = __fictSignal([`)
      expect(output).toContain(`let filter = __fictSignal('all');`)

      // Check derived value
      expect(output).toContain(`const filteredTodos = __fictMemo(() => todos().filter(todo => {`)

      // Check reactive bindings
      expect(output).toContain(`value={() => filter()}`)
      expect(output).toContain(`{() => filteredTodos().map(todo => (`)

      // Check key is not wrapped
      expect(output).toContain(`key={todo.id}`)
      expect(output).not.toContain(`key={() =>`)

      // Check class binding
      expect(output).toContain(`class={todo.done ? 'done' : ''}`)
    })
  })

  describe('Edge cases', () => {
    it('does not transform non-reactive variables', () => {
      const output = transform(`
        const staticValue = 42
        const view = () => <div>{staticValue}</div>
      `)

      expect(output).toContain(`{staticValue}`)
      expect(output).not.toContain(`{() =>`)
    })

    it('handles function parameters that shadow state variables', () => {
      // Case 1: Static array with shadowing parameter - no wrapping needed
      const output1 = transform(`
        let count = $state(0)
        const view = () => <div>{[1,2,3].map(count => <span>{count}</span>)}</div>
      `)

      // The expression [1,2,3].map(...) doesn't depend on reactive values
      // because: 1) [1,2,3] is static, 2) inner count is a parameter, not the $state
      expect(output1).toContain(`{[1, 2, 3].map(count => <span>{count}</span>)}`)
      expect(output1).not.toContain(`{() =>`)
      expect(output1).not.toContain(`count()`) // The inner count should NOT be converted

      // Case 2: Reactive array with shadowing parameter - outer needs wrapping
      const output2 = transform(`
        let count = $state(0)
        let items = $state(['a', 'b', 'c'])
        const view = () => <ul>{items.map(count => <li>{count}</li>)}</ul>
      `)

      // The expression items.map(...) DOES depend on reactive items
      // The wrapper is needed, but inner count should not be converted
      expect(output2).toContain(`{() => items().map(count => <li>{count}</li>)}`)
      // Make sure only items() is called, not the shadowed count
      expect(output2.match(/items\(\)/g)?.length).toBe(1)
    })

    it('preserves JSX spread attributes', () => {
      const output = transform(`
        let props = $state({ id: 'test' })
        const view = () => <div {...props}>test</div>
      `)

      expect(output).toContain(`{...props()}`)
    })

    it('handles empty JSX expressions', () => {
      const output = transform(`
        const view = () => <div>{/* comment */}</div>
      `)

      // Should not crash on empty expressions
      expect(output).toContain(`<div>`)
    })

    it('handles fragment syntax', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <><span>{count}</span></>
      `)

      expect(output).toContain(`{() => count()}`)
    })
  })
})
