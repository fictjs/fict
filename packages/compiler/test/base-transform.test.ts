import * as babel from '@babel/core'
import presetTypescript from '@babel/preset-typescript'
import { describe, expect, it } from 'vitest'

import { createFictPlugin, type FictCompilerOptions } from '../src'

function transform(code: string, options?: FictCompilerOptions): string {
  const normalized =
    code.includes('$state') && !code.includes("from 'fict'") && !code.includes('from "fict"')
      ? `import { $state } from 'fict'\n${code}`
      : code

  const result = babel.transformSync(normalized, {
    filename: 'test.tsx',
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
    plugins: [[createFictPlugin, options]],
    presets: [[presetTypescript, { isTSX: true, allExtensions: true, allowDeclareFields: true }]],
  })

  return result?.code?.trim() || ''
}

describe('createFictPlugin', () => {
  describe('Basic transformations', () => {
    it('rewrites $state to createSignal', () => {
      const output = transform(`
        import { $state } from 'fict'
        let count = $state(0)
      `)

      expect(output).toContain(`__fictUseContext`)
      expect(output).toContain(`__fictUseSignal(__fictCtx, 0, 0)`)
      expect(output).not.toContain('$state')
    })

    it('rewrites derived const to createMemo', () => {
      const output = transform(`
        let count = $state(0)
        const doubled = count * 2
      `)

      expect(output).toContain(`__fictUseMemo(__fictCtx, () => count() * 2`)
      expect(output).toContain(`count()`)
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

      expect(output).toContain(`__fictUseEffect(__fictCtx`)
      expect(output).toContain(`console.log(count())`)
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

      expect(output).toContain(`count(5)`)
      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 2)`)
      expect(output).toContain(`count(count() * 3)`)
      expect(output).toContain(`count(count() / 4)`)
    })

    it('transforms self-referential assignments like count = count + 1', () => {
      const output = transform(`
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
        let count = $state(0)
        const handler = () => {
          count = 5
          count = count + 1
        }
      `)

      expect(output).toContain(`count(5)`)
      expect(output).toContain(`count(count() + 1)`)
    })

    it('transforms increment/decrement operators', () => {
      const output = transform(`
        let count = $state(0)
        count++
        count--
        ++count
        --count
      `)

      expect(output).toContain(`count(count() + 1)`)
      expect(output).toContain(`count(count() - 1)`)
    })

    it('converts shorthand properties using tracked identifiers', () => {
      const output = transform(`
        let count = $state(1)
        const payload = { count, other: count + 1 }
      `)

      expect(output).toContain(`__fictUseSignal(__fictCtx, 1, 0)`)
      expect(output).toContain(`count: count()`)
    })
  })

  describe('JSX child expressions', () => {
    it('wraps reactive values in JSX children', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count}</div>
      `)

      expect(output).toContain('insert')
      expect(output).toContain('count()')
    })

    it('does not wrap static values in JSX children', () => {
      const output = transform(`
        const view = () => <div>{"static"}</div>
      `)

      expect(output).toContain(`"static"`)
      expect(output).toContain(`insert`)
    })

    it('wraps complex expressions that depend on state', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div>{count > 0 ? 'positive' : 'zero'}</div>
      `)

      expect(output).toContain('createConditional')
      expect(output).toContain(`count()`)
    })

    it('wraps array.map expressions that depend on state', () => {
      const output = transform(`
        let items = $state(['a', 'b', 'c'])
        const view = () => <ul>{items.map(item => <li>{item}</li>)}</ul>
      `)

      // Template cloning uses insert for dynamic lists
      expect(output).toContain('insert')
      expect(output).toContain('items()')
    })
  })

  describe('JSX attribute expressions', () => {
    it('wraps reactive values in attributes', () => {
      const output = transform(`
        let isValid = $state(false)
        const view = () => <button disabled={!isValid}>Click</button>
      `)

      expect(output).toContain(`bindProperty`)
      expect(output).toContain(`!isValid()`)
    })

    it('does not wrap event handlers', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <button onClick={() => count++}>Click</button>
      `)

      // Event handler should stay as a single arrow body
      expect(output).toContain(`bindEvent`)
      expect(output).toContain(`count(count() + 1)`)
      expect(output).not.toContain(`() => () =>`)
    })

    it('does not wrap key attribute', () => {
      const output = transform(`
        let items = $state([{ id: 1 }])
        const view = () => items.map(item => <div key={item.id}>{item.id}</div>)
      `)

      expect(output).toContain(`item.id`)
      expect(output).not.toContain(`key={() =>`)
    })
  })

  describe('Edge cases', () => {
    it('does not transform non-reactive variables', () => {
      const output = transform(`
        const staticValue = 42
        const view = () => <div>{staticValue}</div>
      `)

      expect(output).toContain(`staticValue`)
      expect(output).toContain(`insert`)
    })

    it('handles derived values in attributes', () => {
      const output = transform(`
        let count = $state(0)
        const isEmpty = count === 0
        const view = () => <button disabled={isEmpty}>Click</button>
      `)

      expect(output).toContain(`bindProperty`)
      expect(output).toContain(`isEmpty()`)
    })

    it('handles template literals with state', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => <div title={\`Count: \${count}\`}>test</div>
      `)

      expect(output).toContain('count()')
    })

    it('handles optional chaining and TS assertions', () => {
      const output = transform(`
        let user = $state<{ profile?: { name?: string } }>({ profile: {} })
        const view = () => <div>{user?.profile?.name}</div>
        const foo = (user as any)?.profile!.name
      `)

      expect(output).toContain('user()?.profile?.name')
      expect(output).toContain('user()?.profile')
    })

    it('handles conditional rendering with &&', () => {
      const output = transform(`
        let show = $state(true)
        const view = () => <div>{show && <span>Visible</span>}</div>
      `)

      expect(output).toContain(`createConditional`)
    })

    it('handles ternary conditional rendering', () => {
      const output = transform(`
        let show = $state(true)
        const view = () => <div>{show ? <span>Yes</span> : <span>No</span>}</div>
      `)

      expect(output).toContain(`createConditional`)
    })

    it('handles nested components with reactive props', () => {
      const output = transform(`
        let count = $state(0)
        const Child = ({ value }) => <span>{value}</span>
        const Parent = () => <Child value={count} />
      `)

      expect(output).toContain(`value={__fictProp(() => count())}`)
    })

    it('treats props member access as reactive in JSX', () => {
      const output = transform(`
        function Component(props) {
          return <div>{props.count}</div>
        }
      `)
      expect(output).toContain('insert')
      expect(output).toContain('props.count')
    })

    it('memoizes derived values from props member access', () => {
      const output = transform(`
        function Component(props) {
          const doubled = props.count * 2
          return <div>{doubled}</div>
        }
      `)
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('props.count')
    })

    it('makes destructured props reactive in JSX', () => {
      const output = transform(`
        function Component({ value }) {
          return <div>{value}</div>
        }
      `)
      expect(output).toContain('__props')
      expect(output).toContain('value()')
    })

    it('supports nested destructured props reactively', () => {
      const output = transform(`
        function Component({ user: { name } }) {
          return <div>{name}</div>
        }
      `)
      expect(output).toContain('__props')
      expect(output).toContain('name()')
    })

    it('keeps defaults in destructured props while remaining reactive', () => {
      const output = transform(`
        function Component({ value = 10 }) {
          return <div>{value}</div>
        }
      `)
      expect(output).toContain('__props')
      expect(output).toContain('value()')
      expect(output).toContain('=== undefined')
    })

    it('supports rest props destructuring while preserving reactivity', () => {
      const output = transform(`
        function Component({ count, ...rest }) {
          const doubled = rest.count * 2
          return <div>{doubled}</div>
        }
      `)
      expect(output).toContain('__fictPropsRest')
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('rest.count')
    })

    it('spreads rest props to child components without losing getters', () => {
      const output = transform(`
        const Child = (props) => <span>{props.label}</span>
        function Component({ label, ...rest }) {
          return <Child {...rest} />
        }
      `)
      expect(output).toContain('__fictPropsRest')
      expect(output).toContain('...rest')
    })

    it('handles only rest destructuring as props alias', () => {
      const output = transform(`
        function Component({ ...props }) {
          const doubled = props.count * 2
          return <div>{doubled}</div>
        }
      `)
      expect(output).toContain('__fictPropsRest')
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('props.count')
    })

    it('wraps reactive values inside spread object literals for components', () => {
      const output = transform(`
        let count = $state(0)
        const Child = (props) => <span>{props.value}</span>
        const Parent = () => <Child {...{ value: count }} />
      `)
      expect(output).toContain('__fictProp(() => count())')
    })

    it('wraps shorthand reactive entries inside spread object literals', () => {
      const output = transform(`
        let count = $state(0)
        const Child = (props) => <span>{props.count}</span>
        const Parent = () => {
          const obj = { count }
          return <Child {...obj} />
        }
      `)
      expect(output).toContain('__fictProp(() => count())')
    })

    it('preserves reactivity through layered object spreads before JSX', () => {
      const output = transform(`
        let count = $state(0)
        const base = { count }
        const obj = { ...base }
        const Parent = () => <Child {...obj} />
      `)
      expect(output).toContain('__fictProp(() => count())')
    })

    it('passes reactive children to components as getters', () => {
      const output = transform(`
        let count = $state(0)
        const Child = (props) => <div>{props.children}</div>
        const Parent = () => <Child>{count}</Child>
      `)

      expect(output).toContain(`insert`)
      expect(output).toContain(`count()`)
    })

    it('keeps reactive expressions inside component child trees as props', () => {
      const output = transform(`
        let count = $state(0)
        const Child = (props) => <section>{props.children}</section>
        const Parent = () => (
          <Child>
            <span>{count}</span>
          </Child>
        )
      `)

      expect(output).toContain(`insert`)
      expect(output).toContain(`count()`)
    })

    it('handles multiple reactive values in one expression', () => {
      const output = transform(`
        let a = $state(1)
        let b = $state(2)
        const view = () => <div>{a + b}</div>
      `)

      expect(output).toContain(`insert`)
      expect(output).toContain(`a()`)
      expect(output).toContain(`b()`)
    })

    it('handles class binding with reactive value', () => {
      const output = transform(`
        let active = $state(false)
        const view = () => <div class={active ? 'active' : ''}>test</div>
      `)

      expect(output).toContain(`bindClass`)
      expect(output).toContain(`active()`)
    })

    it('handles style binding with reactive value', () => {
      const output = transform(`
        let color = $state('red')
        const view = () => <div style={{ color: color }}>test</div>
      `)

      expect(output).toContain(`bindStyle`)
      expect(output).toContain(`color()`)
    })

    it('does not transform shadowed variables', () => {
      const output = transform(`
        let count = $state(0)
        const view = () => {
          const count = 5
          return <div>{count}</div>
        }
      `)

      // The inner count is shadowed, so should not be transformed
      expect(output).toContain(`const count = 5`)
    })

    it('handles aliasing of state variables', () => {
      const output = transform(`
        let count = $state(0)
        const alias = count
        const view = () => <div>{alias}</div>
      `)

      expect(output).toContain(`alias()`)
    })
  })

  describe('Alias variable handling', () => {
    it('transforms alias to getter function', () => {
      const output = transform(`
        let count = $state(0)
        const alias = count
      `)

      expect(output).toContain(`const alias = () => count()`)
    })

    it('transforms alias usage to getter call', () => {
      const output = transform(`
        let count = $state(0)
        const alias = count
        console.log(alias)
      `)

      expect(output).toContain(`console.log(alias())`)
    })

    it('throws on alias reassignment', () => {
      expect(() =>
        transform(`
          let count = $state(0)
          const alias = count
          alias = 5
        `),
      ).toThrow(/Aliasing \$state values must remain getters/)
    })
  })

  describe('Derived cycle detection', () => {
    it('allows acyclic derived chains', () => {
      const output = transform(`
        let base = $state(0)
        const a = base + 1
        const b = a + 1
        const c = b + 1
      `)

      expect(output).toContain(`__fictUseMemo`)
    })
  })

  describe('Property mutation warnings', () => {
    it('emits warning for direct property mutation', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let user = $state({ name: 'Alice' })
        user.name = 'Bob'
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0].code).toBe('FICT-M')
    })

    it('emits warning for nested property mutation', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let user = $state({ profile: { name: 'Alice' } })
        user.profile.name = 'Bob'
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0].code).toBe('FICT-M')
    })

    it('emits warning for increment on property', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let obj = $state({ count: 0 })
        obj.count++
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0].code).toBe('FICT-M')
    })
  })

  describe('Black-box function warnings (Rule H)', () => {
    it('emits warning when state is passed to unknown function', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let user = $state({ name: 'Alice' })
        someFunction(user)
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0].code).toBe('FICT-H')
      expect(warnings[0].message).toContain('black box')
    })

    it('does not warn for safe functions', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let user = $state({ name: 'Alice' })
        console.log(user)
        JSON.stringify(user)
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
    })

    it('does not warn for $effect', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        import { $state, $effect } from 'fict'
        let user = $state({ name: 'Alice' })
        $effect(() => console.log(user))
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
    })
  })

  describe('Function parameter shadowing', () => {
    it('does not transform shadowed parameter in nested function', () => {
      const output = transform(`
        let count = $state(0)
        const fn = (count) => {
          return count + 1
        }
      `)

      // The inner count parameter should not be transformed to count()
      expect(output).toContain(`const fn = count => {`)
      expect(output).toContain(`return count + 1`)
      // But outer count should still be a signal
      expect(output).toContain(`__fictUseSignal(__fictCtx, 0, 0)`)
    })

    it('handles multiple nested functions with different shadows', () => {
      const output = transform(`
        let a = $state(1)
        let b = $state(2)
        const f1 = (a) => a + b
        const f2 = (b) => a + b
      `)

      // f1: a is shadowed, b is not
      // f2: b is shadowed, a is not
      expect(output).toContain(`__fictUseSignal(__fictCtx, 1, 0)`)
      expect(output).toContain(`__fictUseSignal(__fictCtx, 2, 1)`)
    })
  })

  describe('Derived variable protection', () => {
    it('throws on derived variable reassignment', () => {
      expect(() =>
        transform(`
          let count = $state(0)
          const doubled = count * 2
          doubled = 10
        `),
      ).toThrow(/Cannot reassign derived value/)
    })
  })

  describe('Rule H: Dynamic property access warning', () => {
    it('warns on dynamic property access (obj[key]) with runtime key', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let data = $state({ a: 1, b: 2 })
        const key = 'a'
        const value = data[key]
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )
      expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
      expect(
        warnings.some(w => w.message.includes('Dynamic property access widens dependency')),
      ).toBe(true)
    })

    it('does not warn on static property access (obj["literal"])', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let data = $state({ a: 1 })
        const value = data["a"]
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )
      expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
    })

    it('does not warn on numeric index access (arr[0])', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let items = $state([1, 2, 3])
        const first = items[0]
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )
      expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
    })

    it('emits warnings for deep mutations and dynamic property access', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        const key = 'city'
        let user = $state({ addr: { city: 'Paris' } })
        user.addr[key] = 'London'
      `,
        {
          onWarn: warning => warnings.push(warning),
        },
      )

      expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
      expect(
        warnings.some(
          w =>
            w.code === 'FICT-M' &&
            w.message.includes('immutable update') &&
            w.message.includes('$store'),
        ),
      ).toBe(true)
    })

    it('warns on template literal dynamic property access', () => {
      const warnings: { code: string; message: string }[] = []
      transform(
        `
        let obj = $state({ a: 1 })
        const key = 'a'
        const val = obj[\`\${key}\`]
      `,
        { onWarn: w => warnings.push(w) },
      )
      expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
    })
  })

  describe('Derived cycle detection', () => {
    it('detects cyclic derived dependencies', () => {
      expect(() =>
        transform(`
          let source = $state(0)
          const a = b + source
          const b = a + 1
        `),
      ).toThrow(/cyclic derived dependency/i)
    })

    it('detects longer cycle chains (a -> b -> c -> a)', () => {
      expect(() =>
        transform(`
          let source = $state(0)
          const a = c + source
          const b = a + 1
          const c = b + 1
        `),
      ).toThrow(/cyclic derived dependency/i)
    })

    it('does not throw for valid derived chain', () => {
      expect(() =>
        transform(`
          let source = $state(0)
          const a = source + 1
          const b = a + 1
          const c = b + 1
        `),
      ).not.toThrow()
    })
  })

  describe('Module-level derived values (Rule I)', () => {
    it('keeps module-level derived values as memos even for event usage', () => {
      const output = transform(`
      let count = $state(1)
      export const doubled = count * 2
      export const click = () => console.log(doubled)
    `)
      expect(output).toContain('__fictUseMemo(__fictCtx, () => count() * 2')
    })

    it('keeps exported via export clause derived values as memos', () => {
      const output = transform(`
      let count = $state(1)
      const doubled = count * 2
      export { doubled }
    `)
      expect(output).toContain('__fictUseMemo(__fictCtx, () => count() * 2')
    })
  })

  describe('Props destructuring (Rule E)', () => {
    it('transforms destructured props to getter', () => {
      const output = transform(`
        function Component({ name }) {
          return <div>{name}</div>
        }
      `)
      expect(output).toContain('__props')
      expect(output).toContain('.name')
    })

    it('handles default values in destructured props', () => {
      const output = transform(`
        function Component({ count = 0 }) {
          return <div>{count}</div>
        }
      `)
      expect(output).toMatch(/=== undefined \? 0|undefined.*0/)
    })

    it('handles nested destructuring', () => {
      const output = transform(`
        function Component({ user: { name, age = 18 } }) {
          return <div>{name} ({age})</div>
        }
      `)
      expect(output).toContain('__props')
    })

    it('handles arrow function components', () => {
      const output = transform(`
        const Component = ({ title }) => <h1>{title}</h1>
      `)
      expect(output).toContain('__props')
      expect(output).toContain('.title')
    })

    it('does not transform non-JSX functions', () => {
      const output = transform(`
        function helper({ x, y }) {
          return x + y
        }
      `)
      // Should not contain __props since no JSX
      expect(output).not.toContain('__props')
    })

    it('treats props member access as reactive in JSX', () => {
      const output = transform(`
        function Component(props) {
          return <div>{props.count}</div>
        }
      `)
      expect(output).toContain('insert')
      expect(output).toContain('props.count')
    })

    it('memoizes derived values from props member access', () => {
      const output = transform(`
        function Component(props) {
          const doubled = props.count * 2
          return <div>{doubled}</div>
        }
      `)
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('props.count')
    })
  })

  describe('Rule D / Rule J', () => {
    it('groups multiple derived values into a region memo (Rule D)', () => {
      const output = transform(`
        function View() {
          let count = $state(0)
          const doubled = count * 2
          const tripled = count * 3
          if (count > 0) {
            console.log(doubled, tripled)
          }
          return <div>{doubled}{tripled}</div>
        }
      `)

      expect(output).toMatch(/__fictRegion_/)
      expect(output).toContain('__fictUseMemo')
      expect(output).toMatch(/const doubled = \(\) => __fictRegion_/)
      expect(output).toMatch(/const tripled = \(\) => __fictRegion_/)
    })

    it('lazily evaluates branch-only derived values when enabled (Rule J)', () => {
      const output = transform(
        `
      function View() {
        let count = $state(0)
        const pos = count + 1
        const neg = count - 1
        const value = count > 0 ? pos : neg
        return value
      }
    `,
        { lazyConditional: true },
      )

      expect(output).toContain('count() > 0 ? pos() : neg()')
    })

    it('caches getter calls when getterCache is enabled', () => {
      const output = transform(
        `
        function View() {
          let count = $state(0)
          const view = () => count + count
          return view()
        }
      `,
        { getterCache: true },
      )

      expect(output).toContain('__cached_count')
      expect(output).toMatch(/__cached_count/)
    })
  })

  describe('Fine-grained DOM lowering', () => {
    it('lowers intrinsic JSX to DOM binds when enabled', () => {
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

      // Template cloning generates template() instead of document.createElement
      expect(output).toContain('template')
      expect(output).toContain('bindClass')
      expect(output).toContain('bindStyle')
      // Template cloning uses insert instead of bindText
      expect(output).toContain('insert')
    })

    it('rewrites tracked reads inside bindings and effects', () => {
      const output = transform(
        `
        import { $state, $effect } from 'fict'
        function View() {
          let count = $state(0)
          $effect(() => {
            document.title = \`Count: \${count}\`
          })
          return <div>{(console.log('bb'), count)}</div>
        }
      `,
        { fineGrainedDom: true },
      )

      expect(output).toContain('document.title = `Count: ${count()}`')
      expect(output).toContain("console.log('bb'), count()")
      expect(output).not.toContain("console.log('bb'), count)")
    })
  })
})
