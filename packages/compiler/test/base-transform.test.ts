import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('createFictPlugin (HIR)', () => {
  describe('Basics', () => {
    it('rewrites $state to useSignal', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
      `)

      expect(output).toContain('__fictUseContext')
      expect(output).toContain('__fictUseSignal(__fictCtx, 0)')
      expect(output).not.toContain('$state')
    })

    it('rewrites derived const to useMemo', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        const doubled = count * 2
      `)

      expect(output).toContain(`__fictUseMemo(__fictCtx, () => count() * 2`)
      expect(output).toContain('count()')
    })

    it('throws on non-identifier $state targets', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          const [a] = $state(0)
        `),
      ).toThrow(/Destructuring \$state is not supported/)
    })

    it('throws on $state inside loops', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          for (let i = 0; i < 3; i++) {
            let x = $state(i)
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')

      expect(() =>
        transform(`
          import { $state } from 'fict'
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
          import { $state } from 'fict'
          if (true) {
            let x = $state(1)
          }
        `),
      ).toThrow('$state() cannot be declared inside loops or conditionals')
    })

    it('throws on $effect inside loops or conditionals', () => {
      expect(() =>
        transform(`
          import { $effect } from 'fict'
          if (true) {
            $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')

      expect(() =>
        transform(`
          import { $effect } from 'fict'
          for (let i=0; i<3; i++) {
            $effect(() => {})
          }
        `),
      ).toThrow('$effect() cannot be called inside loops or conditionals')
    })

    it('rewrites $effect to useEffect', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'
        let count = $state(0)
        $effect(() => {
          console.log(count)
        })
      `)

      expect(output).toContain(`__fictUseEffect(__fictCtx`)
      expect(output).toContain(`console.log(count())`)
    })
  })

  describe('Assignments', () => {
    it('transforms assignment operators', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        count = 5
        count += 1
        count -= 2
        count *= 3
        count /= 4
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
        let count = $state(0)
        count = count + 1
        count = count - 1
        count = count * 2
      `)

      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 1)`)
      expect(output).toContain(`count(count() * 2)`)
    })

    it('transforms assignments inside arrow function block bodies', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        const handler = () => {
          count = 5
          count = count + 1
        }
      `)

      expect(output).toContain(`function handler()`)
      expect(output).toContain(`count(5)`)
      expect(output).toContain(`count(count() + 1)`)
    })

    it('transforms increment/decrement operators', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        count++
        count--
        ++count
        --count
      `)

      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 1)`)
    })
  })

  describe('JSX', () => {
    it('wraps reactive values in JSX children', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        const view = () => <div>{count}</div>
      `)

      expect(output).toContain('insert')
      expect(output).toContain('count()')
    })

    it('does not wrap static values in JSX children', () => {
      const output = transform(`
        import { $state } from 'fict'
        const view = () => <div>{"static"}</div>
      `)

      expect(output).toContain(`"static"`)
      expect(output).toContain(`insert`)
    })

    it('wraps complex expressions that depend on state', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
        const view = () => <div>{count > 0 ? 'positive' : 'zero'}</div>
      `)

      expect(output).toContain('createConditional')
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
      expect(output).toMatch(/const \{\s*count,\s*doubled,\s*tripled\s*\} = __region_0/)
    })
  })

  describe('Safety', () => {
    it('throws on alias reassignment of tracked values', () => {
      expect(() =>
        transform(`
          import { $state } from 'fict'
          let count = $state(0)
          const alias = count
          alias = 1
        `),
      ).toThrow(/Alias reassignment is not supported/)
    })
  })

  describe('Fine-grained DOM', () => {
    it('rewrites tracked reads inside bindings and effects', () => {
      const output = transform(`
        import { $state, $effect } from 'fict'
        let count = $state(0)
        $effect(() => {
          document.title = \`Count: \${count}\`
        })
        const View = () => <div>{count}</div>
      `)

      expect(output).toContain('document.title = `Count: ${count()}`')
      expect(output).toContain('insert')
      expect(output).toContain('count()')
    })
  })
})
