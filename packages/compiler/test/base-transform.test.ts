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

      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 1)`)
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

      expect(output).toContain('bindText')
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
      // Static text uses direct assignment instead of bindText
      expect(output).not.toContain(`bindText`)
      expect(output).toContain(`.data = String`)
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
      expect(output).toContain('bindText')
      expect(output).toContain('count()')
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

      // Should generate handler assignment and data getter:
      //   $$click = select
      //   $$clickData = () => data.key
      expect(output).toContain('$$click')
      expect(output).toContain('$$clickData')
      // Handler should be assigned directly (runtime will pass data + event)
      expect(output).toContain('$$click = select')
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

      // console.log uses standard event delegation (not optimization)
      // Standard path still creates data binding for tracked variables
      expect(output).toContain('$$click')
      // The handler is an arrow function wrapping the console.log call
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

      // handler is a signal, so should not apply
      // The pattern should fall through to standard event handling
      expect(output).toContain('$$click')
    })
  })
})
