import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type { CompilerWarning } from '../index'
import { createFictTransformer } from '../index'

function transform(source: string, options?: Parameters<typeof createFictTransformer>[1]): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      jsx: ts.JsxEmit.Preserve,
    },
    transformers: {
      before: [createFictTransformer(undefined, options)],
    },
  })
  return result.outputText
}

function transformWithWarnings(source: string): { output: string; warnings: CompilerWarning[] } {
  const warnings: CompilerWarning[] = []
  const output = transform(source, { onWarn: w => warnings.push(w) })
  return { output, warnings }
}

describe('Spec rule coverage', () => {
  it('throws when $state is used without importing from fict', () => {
    const input = `
      let count = $state(0)
    `
    expect(() => transform(input)).toThrow('must be imported from "fict"')
  })

  it('throws when $state is declared inside conditional blocks', () => {
    const input = `
      import { $state } from 'fict'
      if (true) {
        const count = $state(0)
      }
    `
    expect(() => transform(input)).toThrow('top-level scope')
  })

  it('supports props destructuring with tracked getters', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ name, age = 18 }) {
        const label = \`\${name} (\${age})\`
        return <div>{label}</div>
      }
    `
    const output = transform(input)
    expect(output).toContain('function Greeting(__props')
    expect(output).toContain('__props_1.name')
    expect(output).toContain('__props_1.age')
    expect(output).toContain('__fictMemo(() => `')
    expect(output).toContain('() => label()')
  })

  it('does not leak prop getter tracking outside the function', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ name }) {
        return <div>{name}</div>
      }
      const name = 'foo'
      console.log(name)
    `
    const output = transform(input)
    expect(output).toContain("const name = 'foo'")
    expect(output).not.toContain('console.log(name())')
  })

  it('preserves nested default values in destructured props', () => {
    const input = `
      import { $state } from 'fict'
      function Greeting({ profile: { name } = { name: 'Anon' } }) {
        return <div>{name}</div>
      }
    `
    const output = transform(input)
    expect(output).toContain("=== undefined ? { name: 'Anon' } : __props_1.profile")
  })

  it('rewrites destructured props that shadow tracked names inside JSX', () => {
    const input = `
      import { $state } from 'fict'
      const count = $state(0)
      function Child({ count }) {
        return <div>{count}</div>
      }
    `
    const output = transform(input)
    expect(output).toContain('const count = () =>')
    expect(output).toContain('__props_1.count')
    expect(output).toContain('__fictInsert')
    expect(output).toContain('() => count()')
  })

  it('emits warnings for deep mutations and dynamic property access', () => {
    const warnings: any[] = []
    const input = `
      import { $state } from 'fict'
      const key = 'city'
      let user = $state({ addr: { city: 'Paris' } })
      user.addr[key] = 'London'
    `
    transform(input, {
      onWarn: warning => warnings.push(warning),
    })

    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
    expect(
      warnings.some(
        w =>
          w.code === 'FICT-M' &&
          w.message.includes('immutable update') &&
          w.message.includes('$store'),
      ),
    ).toBe(true)
  })

  it('detects cyclic derived dependencies', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = b + source
      const b = a + 1
    `
    expect(() => transform(input, { dev: true })).toThrow(/cyclic derived dependency/i)
  })

  it('keeps module-level derived values as memos even for event usage', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(1)
      export const doubled = count * 2
      export const click = () => console.log(doubled)
    `
    const output = transform(input)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })

  it('keeps exported via export clause derived values as memos', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(1)
      const doubled = count * 2
      export { doubled }
    `
    const output = transform(input)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })

  it('keeps default exported derived values as memos', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(1)
      const doubled = count * 2
      export default doubled
    `
    const output = transform(input)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })

  it('keeps export-as derived values as memos', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(1)
      const doubled = count * 2
      export { doubled as renamed }
    `
    const output = transform(input)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })
})

// ============================================================================
// Rule H: Conservative Downgrade and Warning
// ============================================================================

describe('Rule H: Conservative downgrade and warning', () => {
  it('warns on dynamic property access (obj[key]) with runtime key', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let data = $state({ a: 1, b: 2 })
      const key = 'a'
      const value = data[key]
    `)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
    expect(
      warnings.some(w => w.message.includes('Dynamic property access widens dependency')),
    ).toBe(true)
  })

  it('does not warn on static property access (obj["literal"])', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let data = $state({ a: 1 })
      const value = data["a"]
    `)
    expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
  })

  it('does not warn on numeric index access (arr[0])', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let items = $state([1, 2, 3])
      const first = items[0]
    `)
    expect(warnings.filter(w => w.code === 'FICT-H').length).toBe(0)
  })

  it('warns on dynamic element access write', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let data = $state({ a: 1 })
      const key = 'a'
      data[key] = 2
    `)
    // FICT-M for nested mutation, and potentially FICT-H for dynamic path
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  // Black-box function detection tests
  it('warns when state object is passed to unknown function', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ name: 'John' })
      someExternalFunction(user)
    `)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
    expect(warnings.some(w => w.message.includes('black box'))).toBe(true)
  })

  it('does not warn when state is passed to console.log', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ name: 'John' })
      console.log(user)
    `)
    expect(
      warnings.filter(w => w.code === 'FICT-H' && w.message.includes('black box')).length,
    ).toBe(0)
  })

  it('does not warn when state is passed to JSON.stringify', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let data = $state({ x: 1 })
      const json = JSON.stringify(data)
    `)
    expect(
      warnings.filter(w => w.code === 'FICT-H' && w.message.includes('black box')).length,
    ).toBe(0)
  })

  it('warns when state property is passed to unknown method', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ profile: { name: 'John' } })
      processProfile(user.profile)
    `)
    expect(warnings.some(w => w.code === 'FICT-H')).toBe(true)
  })
})

// ============================================================================
// Rule I: Cross-Module Derivation
// ============================================================================

describe('Rule I: Cross-module derivation', () => {
  it('module-level exported derived values compile to memo (not getter)', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export const doubled = count * 2
    `)
    // Cross-module derived must always be memo for consistency
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })

  it('event-only usage at module level still produces memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      export let count = $state(0)
      export const doubled = count * 2
      export const handler = () => console.log(doubled)
    `)
    // Even with event-only usage, module-level derived should be memo
    expect(output).toContain('__fictMemo(() => count() * 2)')
    expect(output).toContain('doubled()')
  })

  it('non-exported function-scoped derived can be getter', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        return () => console.log(doubled)
      }
    `)
    // Function-scoped event-only usage -> getter
    expect(output).toContain('const doubled = () =>')
    expect(output).not.toContain('__fictMemo')
  })

  it('re-exports maintain memo status', () => {
    const output = transform(`
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      export { doubled }
    `)
    expect(output).toContain('__fictMemo(() => count() * 2)')
  })
})

// ============================================================================
// Rule K: Circular Dependency Detection
// ============================================================================

describe('Rule K: Circular dependency detection', () => {
  it('detects direct circular dependency (a -> b -> a)', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = b + source
      const b = a + 1
    `
    expect(() => transform(input)).toThrow(/cyclic derived dependency/i)
    expect(() => transform(input)).toThrow(/a -> b -> a/)
  })

  it('detects longer cycle chains (a -> b -> c -> a)', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = c + source
      const b = a + 1
      const c = b + 1
    `
    expect(() => transform(input)).toThrow(/cyclic derived dependency/i)
  })

  it('does not throw for valid derived chain', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = source + 1
      const b = a + 1
      const c = b + 1
    `
    expect(() => transform(input)).not.toThrow()
  })

  it('cycle error includes location info', () => {
    const input = `
      import { $state } from 'fict'
      let source = $state(0)
      const a = b + source
      const b = a + 1
    `
    expect(() => transform(input)).toThrow(/at.*:\d+:\d+/)
  })
})

// ============================================================================
// Rule M: Deep Modification Warning
// ============================================================================

describe('Rule M: Deep modification warning', () => {
  it('warns on nested property assignment (user.addr.city = ...)', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ addr: { city: 'London' } })
      user.addr.city = 'Paris'
    `)
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
    expect(warnings.some(w => w.message.includes('Direct mutation of nested property'))).toBe(true)
    expect(
      warnings.some(w => w.message.includes('immutable update') || w.message.includes('$store')),
    ).toBe(true)
  })

  it('warns on nested property increment (user.count++)', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ count: 0 })
      user.count++
    `)
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('warns on array element mutation (arr[0].x = ...)', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let items = $state([{ value: 1 }])
      items[0].value = 2
    `)
    expect(warnings.some(w => w.code === 'FICT-M')).toBe(true)
  })

  it('does not warn on top-level reassignment (user = { ... })', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ name: 'John' })
      user = { name: 'Jane' }
    `)
    expect(warnings.filter(w => w.code === 'FICT-M').length).toBe(0)
  })

  it('warning includes line and column info', () => {
    const { warnings } = transformWithWarnings(`
      import { $state } from 'fict'
      let user = $state({ x: 1 })
      user.x = 2
    `)
    const mutationWarning = warnings.find(w => w.code === 'FICT-M')
    expect(mutationWarning).toBeDefined()
    expect(mutationWarning!.line).toBeGreaterThan(0)
    expect(mutationWarning!.column).toBeGreaterThan(0)
  })
})

// ============================================================================
// Rule A: $state placement constraints
// ============================================================================

describe('Rule A: $state placement constraints', () => {
  it('throws when $state declared in for loop', () => {
    const input = `
      import { $state } from 'fict'
      for (let i = 0; i < 10; i++) {
        let count = $state(0)
      }
    `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws when $state declared in while loop', () => {
    const input = `
      import { $state } from 'fict'
      while (true) {
        let count = $state(0)
        break
      }
    `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws when $state declared in for-of loop', () => {
    const input = `
      import { $state } from 'fict'
      const items = [1, 2, 3]
      for (const item of items) {
        let count = $state(item)
      }
    `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws when $state declared in do-while loop', () => {
    const input = `
      import { $state } from 'fict'
      do {
        let count = $state(0)
      } while (false)
    `
    expect(() => transform(input)).toThrow('cannot be declared inside loops')
  })

  it('throws when $state declared in if block', () => {
    const input = `
      import { $state } from 'fict'
      if (true) {
        let count = $state(0)
      }
    `
    expect(() => transform(input)).toThrow('top-level scope')
  })

  it('throws when $state declared in switch case', () => {
    const input = `
      import { $state } from 'fict'
      const x = 1
      switch (x) {
        case 1:
          let count = $state(0)
          break
      }
    `
    expect(() => transform(input)).toThrow('top-level scope')
  })

  it('allows $state at function top-level', () => {
    const input = `
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        return count
      }
    `
    expect(() => transform(input)).not.toThrow()
  })

  it('allows $state at module top-level', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      export { count }
    `
    expect(() => transform(input)).not.toThrow()
  })
})

// ============================================================================
// Rule C: memo vs getter selection
// ============================================================================

// ============================================================================
// Rule J: Lazy Evaluation of Conditional Derivation
// ============================================================================

describe('Rule J: Lazy evaluation of conditional derivation', () => {
  function transformWithLazy(source: string): string {
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        jsx: ts.JsxEmit.Preserve,
      },
      transformers: {
        before: [createFictTransformer(undefined, { lazyConditional: true })],
      },
    })
    return result.outputText
  }

  it('generates lazy evaluation when derived is only used in true branch', () => {
    const output = transformWithLazy(`
      import { $state } from 'fict'
      function Component() {
        let show = $state(false)
        let data = $state({ items: [] })
        const count = data.items.length
        const expensive = count * 100
        const simple = show ? 1 : 0
        if (show) {
          console.log(expensive)
        }
        return <div>{simple}</div>
      }
    `)
    // When lazyConditional is enabled and we have multiple derived values in a region,
    // expensive computation that's only used in conditional should be handled
    expect(output).toContain('__fictMemo')
  })

  it('creates region memo with multiple derived values', () => {
    const output = transformWithLazy(`
      import { $state } from 'fict'
      function Component() {
        let show = $state(false)
        let data = $state({ items: [] })
        const count = data.items.length
        let heading = 'Empty'
        let extra = 0
        if (count > 0) {
          heading = 'Items: ' + count
          extra = count * 10
        }
        return <div>{heading} - {extra}</div>
      }
    `)
    // Should create a region memo for the grouped derivations
    expect(output).toContain('__fictRegion')
    expect(output).toContain('heading')
    expect(output).toContain('extra')
  })
})

// ============================================================================
// Rule L: Getter Cache in Same Sync Block
// ============================================================================

describe('Rule L: Getter cache in same sync block', () => {
  function transformWithGetterCache(source: string): string {
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        jsx: ts.JsxEmit.Preserve,
      },
      transformers: {
        before: [createFictTransformer(undefined, { getterCache: true })],
      },
    })
    return result.outputText
  }

  it('caches getter when used multiple times in same function', () => {
    const output = transformWithGetterCache(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        const click = () => {
          console.log(doubled)
          console.log(doubled)
          console.log(doubled)
        }
        return click
      }
    `)
    // Should have a cached variable for doubled
    expect(output).toContain('__cached_doubled')
  })

  it('does not cache getter when used only once', () => {
    const output = transformWithGetterCache(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        const click = () => {
          console.log(doubled)
        }
        return click
      }
    `)
    // Should not have cached variable when only used once
    expect(output).not.toContain('__cached_doubled')
  })

  it('does not cache getter across different sync blocks', () => {
    const output = transformWithGetterCache(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        const click1 = () => console.log(doubled)
        const click2 = () => console.log(doubled)
        return [click1, click2]
      }
    `)
    // Each function is its own sync block, so no caching should happen
    expect(output).not.toContain('__cached_doubled')
  })

  it('caches multiple getters independently', () => {
    const output = transformWithGetterCache(`
      import { $state } from 'fict'
      function Component() {
        let a = $state(1)
        let b = $state(2)
        const doubleA = a * 2
        const doubleB = b * 2
        const click = () => {
          console.log(doubleA, doubleB)
          console.log(doubleA, doubleB)
        }
        return click
      }
    `)
    expect(output).toContain('__cached_doubleA')
    expect(output).toContain('__cached_doubleB')
  })
})

describe('Rule C: memo vs getter selection', () => {
  it('JSX usage triggers memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)
    expect(output).toContain('__fictMemo')
  })

  it('$effect usage triggers memo', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        $effect(() => console.log(doubled))
        return null
      }
    `)
    expect(output).toContain('__fictMemo')
  })

  it('event-only usage produces getter', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        const onClick = () => console.log(doubled)
        return onClick
      }
    `)
    expect(output).toContain('const doubled = () =>')
    expect(output).not.toContain('__fictMemo')
  })

  it('both JSX and event usage produces memo', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const doubled = count * 2
        return <>
          <div>{doubled}</div>
          <button onClick={() => console.log(doubled)}>Log</button>
        </>
      }
    `)
    expect(output).toContain('__fictMemo')
    expect(output).toContain('doubled()')
  })
})
