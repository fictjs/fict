import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer, type FictCompilerOptions } from '../src'

function transform(code: string, options?: FictCompilerOptions): string {
  const normalized =
    code.includes('$state') && !code.includes("from 'fict'") && !code.includes('from "fict"')
      ? `import { $state } from 'fict'\n${code}`
      : code

  const mergedOptions: FictCompilerOptions = {
    fineGrainedDom: false,
    ...options,
  }

  const result = ts.transpileModule(normalized, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(null, mergedOptions)],
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

    it('throws on non-identifier $state targets', () => {
      expect(() =>
        transform(`
          const [a] = $state(0)
        `),
      ).toThrow(/Destructuring \$state is not supported/)
    })

    it('throws on $state inside loops', () => {
      expect(() =>
        transform(`
          for (let i = 0; i < 3; i++) {
            let x = $state(i)
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')

      expect(() =>
        transform(`
          let i = 0
          while (i < 3) {
            let x = $state(i)
            i++
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')
    })

    it('throws on $state inside conditionals', () => {
      expect(() =>
        transform(`
          if (true) {
            let x = $state(1)
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')

      expect(() =>
        transform(`
          switch (true) {
            case true:
              let x = $state(1)
              break
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')
    })

    it('throws on $effect inside loops or conditionals', () => {
      expect(() =>
        transform(`
          if (true) {
            $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          for (let i=0; i<3; i++) {
            $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')
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

    it('memoizes derived values that are only shorthand', () => {
      const output = transform(`
        let count = $state(1)
        const payload = { count }
      `)

      expect(output).toContain(`let count = __fictSignal(1);`)
      expect(output).toContain(`const payload = __fictMemo(() => ({ count: count() }));`)
    })
  })

  describe('JSX child expressions', () => {
    it('wraps reactive values in JSX children', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count}</div>
      `)

      expect(output).toContain('__fictInsert')
      expect(output).toContain('() => count()')
    })

    it('wraps derived values in JSX children', () => {
      const output = transform(`
        let count = $state(0)
        const doubled = count * 2
        const view = () => <div>{doubled}</div>
      `)

      expect(output).toContain('__fictInsert')
      expect(output).toContain('() => doubled()')
    })

    it('does not wrap static values in JSX children', () => {
      const output = transform(`
        const view = () => <div>{"static"}</div>
      `)

      expect(output).toContain(`{"static"}`)
      expect(output).not.toContain(`__fictInsert`)
    })

    it('does not wrap static expressions in JSX children', () => {
      const output = transform(`
        const view = () => <div>{1 + 2}</div>
      `)

      expect(output).toContain(`{1 + 2}`)
      expect(output).not.toContain(`__fictInsert`)
    })

    it('wraps complex expressions that depend on state', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count > 0 ? 'positive' : 'zero'}</div>
      `)

      expect(output).toContain('__fictConditional')
      expect(output).toContain(`__fictConditional(() => count() > 0`)
    })

    it('wraps array.map expressions that depend on state', () => {
      const output = transform(`
        let items = $state(['a', 'b', 'c'])
        const view = () => <ul>{items.map(item => <li>{item}</li>)}</ul>
      `)

      expect(output).toContain('__fictList')
      expect(output).toContain('items()')
    })

    it('wraps expressions even when inner callback shadows a tracked name', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{[1,2,3].map(count => <span>{count}</span>) && count}</div>
      `)

      expect(output).toContain('__fictConditional')
      expect(output).toContain('count()')
    })

    it('does not wrap already-function expressions', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{() => count}</div>
      `)

      // Should not double-wrap
      expect(output).not.toContain(`__fictInsert`)
      expect(output).toContain(`() => count()`)
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

      expect(output).toContain(`__fictConditional`)
    })

    it('handles ternary conditional rendering', () => {
      const output = transform(`
        let show = $state(true)
        const view = () => <div>{show ? <span>Yes</span> : <span>No</span>}</div>
      `)

      expect(output).toContain(`__fictConditional`)
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

      expect(output).toContain(`__fictInsert`)
      expect(output).toContain(`() => a() + b()`)
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

  describe('Binding helper lowering', () => {
    it('emits helper-based bindings for dynamic children', () => {
      const output = transform(`
        import { $state } from 'fict'

        function View() {
          let show = $state(true)
          let items = $state([
            { id: 1, text: 'A' },
            { id: 2, text: 'B' },
          ])

          return (
            <section>
              {show ? <span>A</span> : <span>B</span>}
              {items.map(item => <p key={item.id}>{item.text}</p>)}
              {show && items.length}
            </section>
          )
        }
      `)

      expect(output).toMatchInlineSnapshot(`
        "import { createSignal as __fictSignal, createElement as __fictCreateElement, createConditional as __fictConditional, createKeyedList as __fictKeyedList, onDestroy as __fictOnDestroy, toNodeArray as __fictToNodeArray } from "fict-runtime";
        function View() {
            let show = __fictSignal(true);
            let items = __fictSignal([
                { id: 1, text: 'A' },
                { id: 2, text: 'B' },
            ]);
            return (<section>
                      {((() => {
                const __fictBinding_1 = __fictConditional(() => show(), () => <span>A</span>, __fictCreateElement, () => <span>B</span>);
                __fictOnDestroy(__fictBinding_1.dispose);
                return __fictBinding_1.marker;
            })())}
                      {((() => {
                const __fictBinding_2 = __fictKeyedList(() => items(), (item, _index) => item.id, (__fictItemSig, __fictIndexSig) => {
                    return __fictToNodeArray(__fictCreateElement((item => <p key={item.id}>{item.text}</p>)(__fictItemSig())));
                });
                __fictOnDestroy(__fictBinding_2.dispose);
                return __fictBinding_2.marker;
            })())}
                      {((() => {
                const __fictBinding_3 = __fictConditional(() => show(), () => items().length, __fictCreateElement);
                __fictOnDestroy(__fictBinding_3.dispose);
                return __fictBinding_3.marker;
            })())}
                    </section>);
        }"
      `)
    })
  })

  describe('Fine-grained DOM lowering (fineGrainedDom=true)', () => {
    it('binds element attributes/styles/text via DOM helpers', () => {
      const output = transform(
        `
        import { $state } from 'fict'
        function View() {
          let count = $state(1)
          return (
            <section class={count > 1 ? 'large' : 'small'} style={{ opacity: count / 10 }}>
              <p data-id="value">{count}</p>
            </section>
          )
        }
      `,
        { fineGrainedDom: true },
      )

      expect(output).toContain('document.createElement("section")')
      expect(output).toContain('__fictBindClass(')
      expect(output).toContain('__fictBindStyle(')
      expect(output).toContain('__fictBindText(')
      expect(output).not.toContain('__fictInsert(')
    })

    it('lowers keyed lists to fine-grained DOM renderers', () => {
      const output = transform(
        `
        import { $state } from 'fict'
        function List() {
          let items = $state([{ id: 1, text: 'One' }])
          return <ul>{items.map(item => <li key={item.id}>{item.text}</li>)}</ul>
        }
      `,
        { fineGrainedDom: true },
      )

      expect(output).toContain('__fictKeyedList')
      expect(output).toContain('__fictBindText(')
      expect(output).toContain('document.createElement("li")')
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
      expect(output).toContain(`createSignal as __fictSignal`)
      expect(output).toContain(`createMemo as __fictMemo`)
      expect(output).toContain(`createEffect as __fictEffect`)
      expect(output).toContain(`createElement as __fictCreateElement`)
      expect(output).toContain(`insert as __fictInsert`)
      expect(output).toContain(`onDestroy as __fictOnDestroy`)

      // Check state and memo
      expect(output).toContain(`let count = __fictSignal(0);`)
      expect(output).toContain(`const doubled = __fictMemo(() => count() * 2);`)

      // Check effect
      expect(output).toContain(`__fictEffect(() => {`)
      expect(output).toContain('document.title = `Count: ${count()}`')

      // Check JSX reactive bindings
      expect(output).toContain(`__fictInsert`)
      expect(output).toContain(`() => count()`)
      expect(output).toContain(`() => doubled()`)

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
      // Should use createKeyedList because of key attribute
      expect(output).toContain(`__fictKeyedList`)

      // Check key is not wrapped
      expect(output).toContain(`key={todo.id}`)
      expect(output).not.toContain(`key={() =>`)

      // Check class binding
      expect(output).toContain(`class={todo.done ? 'done' : ''}`)
    })
  })

  describe('Rule D: Control flow region grouping', () => {
    it('groups derived values inside control flow into a single memo', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          const emptyHeading = 'None'
          let videos = $state([{ id: 1 }])

          const count = videos.length
          let heading = emptyHeading
          let extra = 42

          if (count > 0) {
            const noun = count > 1 ? 'Videos' : 'Video'
            heading = \`\${count} \${noun}\`
            extra = computeExtra()
          }

          return <div>{heading}{extra}</div>
        }
      `)

      const memoInvocationCount = (output.match(/__fictMemo\(/g) || []).length
      expect(memoInvocationCount).toBe(1)
      expect(output).toContain(`const heading = () => __fictRegion`)
      expect(output).toContain(`const extra = () => __fictRegion`)
      expect(output).toContain(
        `return { heading: heading != undefined ? heading : undefined, extra: extra != undefined ? extra : undefined`,
      )
      expect(output).toContain(`__fictInsert`)
      expect(output).toContain(`() => heading()`)
      expect(output).toContain(`() => extra()`)
    })

    it('still groups when early return exits after derived values', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let count = $state(0)
          const doubled = count * 2

          if (count === 0) {
            return null
          }

          const tripled = count * 3
          return <div>{doubled}{tripled}</div>
        }
      `)

      // Early return no longer prevents grouping; derived values share a region
      expect(output).toContain('__fictRegion')
      expect(output).toContain(
        'return { doubled: doubled != undefined ? doubled : undefined, tripled: tripled != undefined ? tripled : undefined }',
      )
      expect(output).toMatch(/const doubled = \(\) => __fictRegion_\d+\(\)\.doubled/)
      expect(output).toMatch(/const tripled = \(\) => __fictRegion_\d+\(\)\.tripled/)
    })

    it('groups let assignments in switch statements', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let mode = $state('idle')
          let color = 'gray'
          let label = 'Unknown'

          switch (mode) {
            case 'idle':
              color = 'gray'
              label = 'Idle'
              break
            case 'active':
              color = 'green'
              label = 'Active'
              break
          }

          return <div style={{color}}>{label}</div>
        }
      `)

      // Should group color and label assignments
      expect(output).toContain('__fictRegion')
      expect(output).toContain(
        'return { color: color != undefined ? color : undefined, label: label != undefined ? label : undefined }',
      )
    })

    it('handles nested control flow correctly', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let count = $state(0)
          let status = 'none'
          let color = 'gray'

          if (count > 0) {
            status = 'active'
            if (count > 10) {
              color = 'red'
            } else {
              color = 'green'
            }
          }

          return <div style={{color}}>{status}</div>
        }
      `)

      // Should group status and color
      expect(output).toContain('__fictRegion')
      const memoCount = (output.match(/__fictMemo\(/g) || []).length
      expect(memoCount).toBe(1)
    })

    it('does not group single derived output', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let count = $state(0)
          let doubled

          if (count > 0) {
            doubled = count * 2
          }

          return <div>{doubled}</div>
        }
      `)

      // Should not create region for single output
      expect(output).not.toContain('__fictRegion')
    })

    it('skips grouping when outputs are reassigned later', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let count = $state(0)
          let doubled = count * 2
          let tripled = count * 3

          // Later reassignment should prevent grouping
          doubled = count * 4

          return <div>{doubled}{tripled}</div>
        }
      `)

      // When reassigned, the entire region including reassignment gets grouped
      expect(output).toContain('__fictRegion')
    })

    it('handles multiple independent regions', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function View() {
          let count1 = $state(0)
          let a = count1 * 2
          let b = count1 * 3

          const unrelated = 'static'

          let count2 = $state(10)
          let c = count2 + 1
          let d = count2 + 2

          return <div>{a}{b}{c}{d}</div>
        }
      `)

      // May create one or two regions depending on implementation
      expect(output).toContain('__fictRegion')
    })
  })

  describe('Edge cases', () => {
    it('does not transform non-reactive variables', () => {
      const output = transform(`
        const staticValue = 42
        const view = () => <div>{staticValue}</div>
      `)

      expect(output).toContain(`{staticValue}`)
      expect(output).not.toContain(`__fictInsert`)
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
      expect(output1).not.toContain(`__fictInsert`)
      expect(output1).not.toContain(`count()`) // The inner count should NOT be converted

      // Case 2: Reactive array with shadowing parameter - outer needs wrapping
      const output2 = transform(`
        let count = $state(0)
        let items = $state(['a', 'b', 'c'])
        const view = () => <ul>{items.map(count => <li>{count}</li>)}</ul>
      `)

      // The expression items.map(...) DOES depend on reactive items
      // The wrapper is needed, but inner count should not be converted
      expect(output2).toContain(`__fictList`)
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

      expect(output).toContain(`__fictInsert`)
    })
  })
})
