import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('$store memoization and dynamic access', () => {
  it('memoizes derived store computations automatically', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ items: [1, 2, 3] })
        const active = store.items.filter(n => n > 1)
        return <div>{active}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => store.items.filter`)
    expect(output).toContain(`insert(__el_`)
  })

  it('preserves dynamic store property access inside memos', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component(props) {
        const store = $store({ items: { a: 1, b: 2 } })
        const value = store[props.key]
        return <div>{value}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => store[props.key]`)
  })

  it('preserves dynamic $state property access inside memos', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Component(props) {
        const state = $state({ items: { a: 1 } })
        const value = state[props.key]
        return <div>{value}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => state()[props.key]`)
  })

  it('treats module-scoped $store as reactive inside components', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      const store = $store({ count: 1 })
      function Component() {
        const doubled = store.count * 2
        return <span>{doubled}</span>
      }
    `)

    expect(output).toContain(`const doubled = __fictUseMemo(__fictCtx, () => store.count * 2`)
    expect(output).toContain(`insert(__el_`)
  })

  it('memoizes nested store property access in derived computation', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ user: { profile: { name: 'Alice', age: 30 } } })
        const info = store.user.profile.name + ' (' + store.user.profile.age + ')'
        return <div>{info}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => store.user.profile.name`)
    expect(output).toContain(`store.user.profile.age`)
  })

  it('memoizes store method chaining with multiple callbacks', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ items: [{ value: 1, active: true }, { value: 2, active: false }] })
        const total = store.items
          .filter(i => i.active)
          .map(i => i.value)
          .reduce((a, b) => a + b, 0)
        return <span>{total}</span>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => store.items`)
    expect(output).toContain(`.filter(`)
    expect(output).toContain(`.map(`)
    expect(output).toContain(`.reduce(`)
  })

  it('does not wrap store write operations in memo', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ count: 0 })
        const increment = () => {
          store.count = store.count + 1
        }
        return <button onClick={increment}>{store.count}</button>
      }
    `)

    // The assignment itself should not be wrapped in memo
    expect(output).not.toMatch(/__fictUseMemo\([^)]+,\s*\(\)\s*=>\s*store\.count\s*=/)
    // But the display value should still be reactive
    expect(output).toContain(`store.count`)
  })

  it('handles store with array mutations correctly', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ list: ['a', 'b', 'c'] })
        const addItem = () => {
          store.list.push('new')
        }
        const items = store.list.map(x => x.toUpperCase())
        return <div onClick={addItem}>{items}</div>
      }
    `)

    // The derived computation should be memoized
    expect(output).toContain(`__fictUseMemo(__fictCtx, () => store.list.map`)
    // The push should not be wrapped
    expect(output).not.toMatch(/__fictUseMemo\([^)]+,\s*\(\)\s*=>\s*store\.list\.push/)
  })

  it('memoizes store access combined with props', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component(props) {
        const store = $store({ multiplier: 2 })
        const result = props.value * store.multiplier
        return <span>{result}</span>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () =>`)
    expect(output).toContain(`store.multiplier`)
  })

  it('handles conditional store property access', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ user: null, defaultName: 'Guest' })
        const name = store.user?.name ?? store.defaultName
        return <div>{name}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () =>`)
    expect(output).toContain(`store.user?.name`)
    expect(output).toContain(`store.defaultName`)
  })

  it('handles store in ternary expressions', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ isLoggedIn: false, username: 'Alice' })
        const display = store.isLoggedIn ? store.username : 'Guest'
        return <span>{display}</span>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () =>`)
    expect(output).toContain(`store.isLoggedIn`)
  })

  it('handles multiple stores with different derivations', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const userStore = $store({ name: 'Alice', age: 30 })
        const settingsStore = $store({ theme: 'dark', fontSize: 14 })
        const greeting = 'Hello, ' + userStore.name
        const style = { fontSize: settingsStore.fontSize + 'px' }
        return <div style={style}>{greeting}</div>
      }
    `)

    expect(output).toContain(`__fictUseMemo(__fictCtx, () => "Hello, " + userStore.name`)
    expect(output).toContain(`settingsStore.fontSize`)
  })

  it('handles store inside map callback for list rendering', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] })
        return (
          <ul>
            {store.users.map(user => <li key={user.id}>{user.name}</li>)}
          </ul>
        )
      }
    `)

    // The compiler optimizes .map with key to createKeyedList for fine-grained DOM updates
    expect(output).toContain(`createKeyedList(() => store.users`)
    expect(output).toContain(`user.id`)
  })

  it('handles store in computed property names', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ className: 'box', id: 'main' })
        return <div className={store.className} id={store.id}>content</div>
      }
    `)

    expect(output).toContain(`store.className`)
    expect(output).toContain(`store.id`)
  })

  it('does not double-wrap already memoized store computations', () => {
    const output = transform(`
      import { $store, $memo } from 'fict/plus'
      function Component() {
        const store = $store({ items: [1, 2, 3] })
        const doubled = $memo(() => store.items.map(x => x * 2))
        return <div>{doubled()}</div>
      }
    `)

    // Should have exactly one memo wrapper from $memo, not additional auto-memo
    const memoMatches = output.match(/__fictUseMemo/g) || []
    // The $memo call creates one, and potentially one for region - but not double wrapping the same expression
    expect(output).toContain(`store.items.map`)
    expect(output).not.toMatch(/__fictUseMemo\([^)]+__fictUseMemo/)
  })
})
