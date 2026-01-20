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
      expect(output).toContain('__fictUseSignal(__fictCtx, 0)')
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

      expect(output).toContain('__fictUseSignal(__fictCtx, 0)')
      expect(output).not.toContain('s(')
    })

    it('rewrites derived const to useMemo', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2
          return doubled
        }
      `)

      expect(output).toContain(`__fictUseMemo(__fictCtx, () => count() * 2`)
      expect(output).toContain('count()')
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
      // P1-1: Static text uses direct assignment instead of bindText
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

  describe('P1-2: Event delegation data-binding', () => {
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

      // P1-2: Should generate wrapper and data getter:
      //   $$click = (__data, _e) => select(__data)
      //   $$clickData = () => data.key
      expect(output).toContain('$$click')
      expect(output).toContain('$$clickData')
      // Wrapper function that adapts to (data, event) signature
      expect(output).toContain('(__data, _e) => select(__data)')
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

      // console.log uses standard event delegation (not P1-2 optimization)
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

      // handler is a signal, so P1-2 should not apply
      // The pattern should fall through to standard event handling
      expect(output).toContain('$$click')
    })
  })
})
