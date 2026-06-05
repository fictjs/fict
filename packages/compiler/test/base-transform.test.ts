import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('createFictPlugin (HIR)', () => {
  describe('Basics', () => {
    it('rewrites $state to useSignal', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          return count
        }
      `)

      expect(output).toContain('__fictUseContext')
      expect(output).toContain('__fictUseSignal(__fictCtx, 0')
      expect(output).not.toContain('$state')
    })

    it('rewrites aliased $state to useSignal', () => {
      const output = transform(`
        import { $state as s } from 'fict'
        function Component() {
          let count = s(0)
          return count
        }
      `)

      expect(output).toContain('__fictUseSignal(__fictCtx, 0')
      expect(output).not.toContain('s(')
    })

    it('inlines derived const by default', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          return doubled
        }
      `)

      expect(output).not.toContain('__fictUseMemo')
      expect(output).toContain('count() * 2')
    })

    it('throws on non-identifier $state targets', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          function Component() {
            const [a] = $state(0)
            return a
          }
        `),
      ).toThrow(/Destructuring \$state is not supported/)
    })

    it('rewrites destructuring assignments to tracked setters', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          ;({ count } = { count: 2 })
          return count
        }
      `)

      expect(output).toMatch(/count\([_$\w]+\s*\.count\)/)
    })

    it('rewrites array destructuring assignments to tracked setters', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          ;[count] = [2]
          return count
        }
      `)

      expect(output).toMatch(/count\(\s*2\s*\)/)
    })

    it('rewrites destructuring assignments with defaults to tracked setters', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          ;({ count = 2 } = {})
          return count
        }
      `)

      expect(output).toContain('count(')
    })

    it('throws on $state inside loops', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          function Component() {
            for (let i = 0; i < 3; i++) {
              let x = $state(i)
            }
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')

      expect(() =>
        transform(`
          import { $state } from 'fict'
          function Component() {
            let i = 0
            while (i < 3) {
              let x = $state(i)
              i++
            }
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')
    })

    it('throws on $state inside conditionals', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          function Component() {
            if (true) {
              let x = $state(1)
            }
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')
    })

    it('throws on $effect inside loops or conditionals', () => {
      expect(() =>
        transform(`
          import { $effect } from 'fict'
          function Component() {
            if (true) {
              $effect(() => {})
            }
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          import { $effect } from 'fict'
          function Component() {
            for (let i=0; i<3; i++) {
              $effect(() => {})
            }
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          import { $effect } from 'fict'
          function Component() {
            const cond = true
            cond && $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          import { $effect } from 'fict'
          function Component() {
            const cond = true
            cond || $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          import { $effect } from 'fict'
          function Component() {
            const cond = true
            cond ?? $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')
    })

    it('preserves async function declarations with await in terminators', () => {
      const output = transform(`
        async function fetcher(flag) {
          if (flag) {
            return await fetchData()
          }
          return 1
        }
      `)

      expect(output).toContain('async function fetcher')
      expect(output).toContain('await fetchData()')
    })

    it('preserves async functions even without await', () => {
      const output = transform(`
        async function noop() {
          return 1
        }
      `)

      expect(output).toContain('async function noop')
    })

    it('preserves debugger statements in HIR-lowered functions', () => {
      const output = transform(`
        import { $state } from 'fict'

        export function useProbe() {
          let flag = $state(true)
          debugger

          if (flag) {
            debugger
          }

          while (flag) {
            debugger
            break
          }

          function nested() {
            debugger
            return 2
          }

          return nested()
        }
      `)

      expect(output.match(/\bdebugger;/g)).toHaveLength(4)
    })

    it('preserves regex literals in function bodies', () => {
      const output = transform(`
        function validateEmail(email: string) {
          return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)
        }
      `)

      expect(output).toContain('/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/')
      expect(output).not.toContain('undefined.test')
    })

    it('preserves regex literals with flags', () => {
      const output = transform(`
        function search(text: string) {
          return text.match(/foo/gi)
        }
      `)

      expect(output).toContain('/foo/gi')
    })

    it('preserves regex literals with multiple flags', () => {
      const output = transform(`
        function multiline(text: string) {
          return /^start/gim.test(text)
        }
      `)

      expect(output).toContain('/^start/gim')
    })

    it('preserves empty regex pattern', () => {
      const output = transform(`
        function empty() {
          return /(?:)/.test('')
        }
      `)

      expect(output).toContain('/(?:)/')
    })

    it('preserves regex with escape sequences', () => {
      const output = transform(`
        function hasWhitespace(str: string) {
          return /[\\n\\t\\r]/.test(str)
        }
      `)

      expect(output).toContain('/[\\n\\t\\r]/')
    })

    it('preserves regex in conditional expressions', () => {
      const output = transform(`
        function validate(input: string) {
          const isValid = /^[a-z]+$/.test(input) ? true : false
          return isValid
        }
      `)

      expect(output).toContain('/^[a-z]+$/')
    })

    it('preserves regex as function argument', () => {
      const output = transform(`
        function splitByComma(str: string) {
          return str.split(/,\\s*/)
        }
      `)

      expect(output).toContain('/,\\s*/')
    })

    it('preserves bigint literals in function bodies', () => {
      const output = transform(`
        function big() {
          return 9007199254740993n
        }
      `)

      expect(output).toContain('9007199254740993n')
      expect(output).not.toContain('return undefined')
    })

    it('handles TypeScript expression wrappers', () => {
      const output = transform(`
        function identity<T>(value: T) {
          return value
        }

        function wrap(value: string) {
          const a = (value as string)!
          const b = value satisfies string
          return identity<string>(a) + b
        }
      `)

      expect(output).toContain('identity')
      expect(output).not.toContain('return undefined')
    })

    it('preserves import expressions and meta properties', () => {
      const output = transform(`
        async function load() {
          const mod = await import('./foo')
          return import.meta.url + mod
        }
      `)

      expect(output).toContain('import(')
      expect(output).toContain('import.meta')
      expect(output).not.toContain('return undefined')
    })

    it('preserves dynamic import options', () => {
      const output = transform(`
        import { $state } from 'fict'

        export async function useProbe() {
          let tick = $state(0)
          return import('./data.json', { with: { type: 'json' } })
        }
      `)

      expect(output).toContain('import("./data.json", {')
      expect(output).toContain('with: {')
      expect(output).toContain('type: "json"')
    })

    it('preserves dynamic import option expressions', () => {
      const output = transform(`
        import { $state } from 'fict'

        export async function useProbe(path, options) {
          let tick = $state(0)
          return import(path, options)
        }
      `)

      expect(output).toContain('import(path, options)')
    })

    it('does not fold writes hidden in dynamic import sources', () => {
      const output = transform(`
        export function useProbe() {
          "use pure"
          let x = 1
          let y = 1
          const p = import((x = 2, y++, './dep.js'))
          return x + y
        }
      `)

      expect(output).toContain('import((x = 2, y++, "./dep.js"))')
      expect(output).not.toContain('return 2;')
    })

    it('invalidates const array caches for dynamic import source member calls', () => {
      const output = transform(`
        export function useProbe() {
          "use pure"
          const arr = [1]
          const p = import((arr.push(2), './dep.js'))
          return arr.length
        }
      `)

      expect(output).toContain('arr.push(2)')
      expect(output).not.toContain('return 1;')
    })

    it('invalidates const array caches for dynamic import option member calls', () => {
      const output = transform(`
        export function useProbe() {
          "use pure"
          const arr = [1]
          const p = import('./dep.js', { with: { type: (arr.push(2), 'json') } })
          return arr.length
        }
      `)

      expect(output).toContain('arr.push(2)')
      expect(output).not.toContain('return 1;')
    })

    it('lowers default-exported arrow JSX components', () => {
      const output = transform(`
        export default () => <div />
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toContain('=> <div')
    })

    it('lowers block-bodied default arrows with macros', () => {
      const output = transform(`
        import { $state } from 'fict'

        export default () => {
          let count = $state(1)
          return <div>{count}</div>
        }
      `)

      expect(output).toContain('template("<div>')
      expect(output).not.toContain('$state(1)')
      expect(output).not.toContain('return <div>')
    })

    it('lowers default-exported function expressions', () => {
      const output = transform(`
        export default (function () {
          return <span />
        })
      `)

      expect(output).toContain('template("<span></span>")')
      expect(output).not.toContain('return <span')
    })

    it('lowers direct default-exported JSX expressions', () => {
      const output = transform(`
        export default <div />
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toMatch(/exports\.default\s*=\s*</)
    })

    it('lowers nested JSX inside default-exported expressions', () => {
      const output = transform(`
        export default {
          view: <div />,
          items: [<span />],
        }
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).toContain('template("<span></span>")')
      expect(output).not.toMatch(/:\s*</)
      expect(output).not.toMatch(/\[\s*</)
    })

    it('lowers conditional JSX inside default-exported expressions', () => {
      const output = transform(`
        const flag = true
        export default flag ? <div /> : <span />
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).toContain('template("<span></span>")')
      expect(output).not.toMatch(/\?\s*</)
      expect(output).not.toMatch(/:\s*</)
    })

    it('lowers JSX callbacks inside default-exported memo calls', () => {
      const output = transform(`
        import { createMemo } from 'fict'
        export default createMemo(() => <div />)
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toContain('=> <div')
    })

    it('lowers default-exported effect macro calls', () => {
      const output = transform(`
        import { $effect } from 'fict'
        export default $effect(() => {})
      `)

      expect(output).toContain('createEffect')
      expect(output).not.toContain('$effect')
    })

    it('lowers JSX returned from class expression methods', () => {
      const output = transform(`
        export function make() {
          return class {
            render() {
              return <div />
            }
          }
        }
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toMatch(/return\s+</)
    })

    it('lowers JSX in class expression fields', () => {
      const output = transform(`
        export function make() {
          return class {
            view = <section />
            static label = <strong />
          }
        }
      `)

      expect(output).toContain('template("<section></section>")')
      expect(output).toContain('template("<strong></strong>")')
      expect(output).not.toMatch(/=\s+</)
    })

    it('lowers JSX in class expression static blocks', () => {
      const output = transform(`
        export function make() {
          return class {
            static {
              this.view = <span />
            }
          }
        }
      `)

      expect(output).toContain('template("<span></span>")')
      expect(output).not.toMatch(/=\s+</)
    })

    it('lowers JSX in exported class declarations', () => {
      const output = transform(`
        export class App {
          render() {
            return <div />
          }
        }
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toMatch(/return\s+</)
    })

    it('lowers JSX in default-exported class declarations', () => {
      const output = transform(`
        export default class App {
          render() {
            return <div />
          }
        }
      `)

      expect(output).toContain('template("<div></div>")')
      expect(output).not.toMatch(/return\s+</)
    })

    it('rewrites $effect to useEffect', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'
        function Component() {
          let count = $state(0)
          $effect(() => {
            console.log(count)
          })
          return null
        }
      `)

      expect(output).toContain(`__fictUseEffect(__fictCtx`)
      expect(output).toContain(`console.log(count())`)
    })

    it('declares context for effect-only components', () => {
      const output = transform(`
        import { $effect } from 'fict'
        function Component() {
          $effect(() => {})
          return null
        }
      `)

      expect(output).toContain('__fictUseEffect(__fictCtx')
      expect(output).toContain('const __fictCtx = __fictUseContext()')
    })

    it('rewrites aliased $effect to useEffect', () => {
      const output = transform(`
        import { $state, $effect as fx } from 'fict'
        function Component() {
          let count = $state(0)
          fx(() => {
            console.log(count)
          })
          return null
        }
      `)

      expect(output).toContain(`__fictUseEffect(__fictCtx`)
      expect(output).not.toContain('fx(')
    })

    it('treats aliased $memo as memo accessor', () => {
      const output = transform(`
        import { $state, $memo as m } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = m(() => count * 2)
          return <div>{doubled}</div>
        }
      `)

      expect(output).toMatch(/const\s+doubled\s*=\s*m/)
      expect(output).toContain('doubled()')
      expect(output).not.toContain('__fictUseMemo(__fictCtx, () => m')
    })
  })

  describe('Assignments', () => {
    it('transforms assignment operators', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count = 5
          count += 1
          count -= 2
          count *= 3
          count /= 4
          return count
        }
      `)

      expect(output).toContain(`count(5)`)
      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 2)`)
      expect(output).toContain(`count(count() * 3)`)
      expect(output).toContain(`count(count() / 4)`)
    })

    it('transforms self-referential assignments like count = count + 1', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count = count + 1
          count = count - 1
          count = count * 2
          return count
        }
      `)

      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 1)`)
      expect(output).toContain(`count(count() * 2)`)
    })

    it('transforms assignments inside arrow function block bodies', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const handler = () => {
            count = 5
            count = count + 1
          }
          return handler
        }
      `)

      expect(output).toContain(`const handler = () =>`)
      expect(output).toContain(`count(5)`)
      expect(output).toContain(`count(count() + 1)`)
    })

    it('transforms increment/decrement operators', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          count++
          count--
          ++count
          --count
          return count
        }
      `)

      expect(output).toMatch(/count\(__prev_\d+ \+ \(typeof __prev_\d+ === "bigint" \? 1n : 1\)\)/)
      expect(output).toMatch(/count\(__prev_\d+ - \(typeof __prev_\d+ === "bigint" \? 1n : 1\)\)/)
    })
  })

  describe('JSX', () => {
    it('wraps reactive values in JSX children', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const view = () => <div>{count}</div>
          return view()
        }
      `)

      expect(output).toContain('insertBetween')
      expect(output).toContain('createElement')
      expect(output).toContain('count()')
    })

    it('does not wrap static values in JSX children', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          const view = () => <div>{"static"}</div>
          return view()
        }
      `)

      expect(output).toContain(`"static"`)
      // Static text uses the runtime formatter without creating a reactive binding.
      expect(output).not.toContain(`bindText`)
      expect(output).toContain(`setText`)
    })

    it('wraps complex expressions that depend on state', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const view = () => <div>{count > 0 ? 'positive' : 'zero'}</div>
          return view()
        }
      `)

      expect(output).toContain('bindText')
      expect(output).toContain(`count()`)
    })
  })

  describe('Regions and memos', () => {
    it('groups derived values into a region memo', () => {
      const output = transform(`
        import { $state } from 'fict'
        function View() {
          let count = $state(0)
          const doubled = count * 2
          const tripled = count * 3
          if (count() > 0) {
            console.log(doubled(), tripled())
          }
          return <div>{doubled()}{tripled()}</div>
        }
      `)

      expect(output).toContain('__region_0')
      expect(output).toContain('__fictUseMemo(__fictCtx')
      // count is a state variable (signal), not part of the region
      // Only derived values (doubled, tripled) are in the region
      expect(output).toMatch(/const \{\s*doubled,\s*tripled\s*\} = __region_0\(\)/)
    })
  })

  describe('Safety', () => {
    it('rejects alias reassignment', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          function Component() {
            let count = $state(0)
            let alias = count
            alias = 1
          }
        `),
      ).toThrow(/Alias reassignment is not supported/)
    })
  })

  describe('Fine-grained DOM', () => {
    it('rewrites tracked reads inside bindings and effects', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'
        function Component() {
          let count = $state(0)
          $effect(() => {
            document.title = \`Count: \${count}\`
          })
          const View = () => <div>{count}</div>
          return View
        }
      `)

      expect(output).toContain('document.title = `Count: ${count()}`')
      expect(output).toContain('insertBetween')
      expect(output).toContain('createElement')
      expect(output).toContain('count()')
    })

    it('falls back to vnode output when fineGrainedDom is disabled', () => {
      const output = transform(
        `
          import { $state } from 'fict'
          function Component() {
            let count = $state(0)
            return <div>{count}</div>
          }
        `,
        { fineGrainedDom: false },
      )

      expect(output).toContain('type: "div"')
      expect(output).not.toContain('bindText')
    })
  })

  describe('Event delegation data-binding', () => {
    it('optimizes onClick={() => handler(data)} pattern', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let selected = $state(null)
          const select = (id) => selected = id
          const data = { key: 123 }
          const view = () => <button onClick={() => select(data.key)}>Click</button>
          return view()
        }
      `)

      expect(output).toMatch(
        /addEventListener\([^,]+,\s*"click",\s*\[select,\s*__fictReactive\(\(\)\s*=>\s*data\.key\),\s*"__fictDataOnly"\],\s*true\)/,
      )
      expect(output).toContain('__fictReactive')
      expect(output).toContain('data.key')
    })

    it('handles console.log patterns with standard event delegation', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const view = () => <button onClick={() => console.log(count)}>Log</button>
          return view()
        }
      `)

      expect(output).toMatch(/addEventListener\([^,]+,\s*"click",/)
      expect(output).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[/)
      expect(output).toContain('console.log(count())')
    })

    it('does not optimize when handler is a tracked variable', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let handler = $state((x) => x)
          const data = 123
          const view = () => <button onClick={() => handler(data)}>Click</button>
          return view()
        }
      `)

      expect(output).toMatch(/addEventListener\([^,]+,\s*"click",/)
      expect(output).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[/)
    })
  })
})
