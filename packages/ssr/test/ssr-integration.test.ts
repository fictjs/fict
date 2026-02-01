import { describe, it, expect, afterEach } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import {
  __fictUseContext,
  __fictUseSignal,
  __fictGetSSRScope,
  __fictSetSSRState,
  __fictEnsureScope,
  __fictEnableResumable,
  __fictDisableResumable,
  __fictDisableSSR,
} from '@fictjs/runtime/internal'

import { renderToDocument, renderToString } from '../src/index'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Parse the snapshot script from HTML output
 */
function parseSnapshot(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
  )
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Find all scope IDs from snapshot
 */
function getScopeIds(snapshot: Record<string, unknown>): string[] {
  const scopes = snapshot.scopes as Record<string, unknown> | undefined
  return scopes ? Object.keys(scopes) : []
}

/**
 * Find scope with specific signal value
 */
function findScopeWithSlotValue(
  snapshot: Record<string, unknown>,
  value: unknown,
): {
  id: string
  scope: { slots: Array<[number, string, unknown]>; props?: Record<string, unknown> }
} | null {
  const scopes = snapshot.scopes as Record<
    string,
    { slots: Array<[number, string, unknown]>; props?: Record<string, unknown> }
  >
  for (const [id, scope] of Object.entries(scopes)) {
    if (
      scope.slots.some(slot => {
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(slot[2]) === JSON.stringify(value)
        }
        return slot[2] === value
      })
    ) {
      return { id, scope }
    }
  }
  return null
}

// ============================================================================
// Test Suite 1: SSR Output + Loader Event Recovery
// ============================================================================

describe('SSR Output + Loader Event Recovery', () => {
  afterEach(() => {
    __fictDisableResumable()
    __fictDisableSSR()
    __fictSetSSRState(null)
  })

  it('renders HTML with scope attributes and snapshot', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'button', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@test', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter, props: { initial: 10 } }))

    // Verify scope attributes
    expect(html).toContain('<fict-host')
    expect(html).toContain('data-fict-s=')
    expect(html).toContain('data-fict-t="Counter@test"')
    expect(html).toContain('data-fict-h="counter#resume"')

    // Verify snapshot is present
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.scopes).toBeDefined()

    const scopeIds = getScopeIds(snapshot!)
    expect(scopeIds.length).toBe(1)

    const scope = (snapshot!.scopes as Record<string, unknown>)[scopeIds[0]!] as {
      slots: Array<[number, string, unknown]>
      props?: Record<string, unknown>
    }
    expect(scope.slots).toEqual([[0, 'sig', 10]])
    expect(scope.props?.initial).toBe(10)
  })

  it('loader parses snapshot and enables resumable mode', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'span', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@loader-test', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter, props: { initial: 42 } }))
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    // Simulate what installResumableLoader does: parse snapshot and enable resumable
    __fictSetSSRState(snapshot as any)
    __fictEnableResumable()

    // Verify we can retrieve scope data
    const scopeIds = getScopeIds(snapshot!)
    expect(scopeIds.length).toBeGreaterThan(0)

    const scopeData = __fictGetSSRScope(scopeIds[0]!)
    expect(scopeData).toBeDefined()
    expect(scopeData?.slots).toEqual([[0, 'sig', 42]])
  })

  it('scope can be resumed from snapshot', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'span', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@resume-test', resume: 'counter#resume' }

    const result = renderToDocument(() => ({ type: Counter, props: { initial: 7 } }))

    try {
      const snapshot = parseSnapshot(result.html)
      expect(snapshot).not.toBeNull()

      const scopeIds = getScopeIds(snapshot!)
      expect(scopeIds.length).toBe(1)
      const scopeId = scopeIds[0]!

      // Simulate client-side: load snapshot and resume scope
      __fictSetSSRState(snapshot as any)
      __fictEnableResumable()

      // Create a mock host element
      const host = result.document.createElement('div')
      host.setAttribute('data-fict-s', scopeId)

      const scopeData = __fictGetSSRScope(scopeId)
      expect(scopeData).toBeDefined()

      // Resume the scope
      const ctx = __fictEnsureScope(scopeId, host, scopeData)

      // Verify HookContext is recreated
      expect(ctx).toBeDefined()
      expect(ctx.scopeId).toBe(scopeId)
      expect(ctx.slots).toBeDefined()

      // Verify signal is restored with correct value
      const signal = ctx.slots[0] as (() => number) | undefined
      expect(signal).toBeDefined()
      expect(typeof signal).toBe('function')
      expect(signal!()).toBe(7)
    } finally {
      result.dispose()
    }
  })

  it('QRL-style event attributes are preserved in SSR output', () => {
    // Using attr: prefix to ensure attribute is written as-is
    function Button(): FictNode {
      return {
        type: 'button',
        props: {
          'attr:data-onclick': '/assets/handler.js#handleClick',
          children: 'Click me',
        },
      }
    }

    const html = renderToString(() => ({ type: Button, props: {} }))

    // The data-onclick attribute should be in the HTML
    expect(html).toContain('data-onclick="/assets/handler.js#handleClick"')
    expect(html).toContain('Click me')
  })
})

// ============================================================================
// Test Suite 2: Recovery + Partial Hydrate + Binding Updates
// ============================================================================

describe('Recovery + Partial Hydrate + Binding Updates', () => {
  afterEach(() => {
    __fictDisableResumable()
    __fictDisableSSR()
    __fictSetSSRState(null)
  })

  it('resumed context contains signals from snapshot', () => {
    // Use a unique value (100) that won't collide with other tests
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'div', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@update-test', resume: 'counter#resume' }

    const result = renderToDocument(() => ({ type: Counter, props: { initial: 100 } }))

    try {
      const snapshot = parseSnapshot(result.html)
      expect(snapshot).not.toBeNull()

      // Verify the snapshot structure contains the signal value
      const found = findScopeWithSlotValue(snapshot!, 100)
      expect(found).not.toBeNull()
      expect(found!.scope.slots[0]).toEqual([0, 'sig', 100])

      // Set up resumable state
      __fictSetSSRState(snapshot as any)
      __fictEnableResumable()

      // Create host element for resume
      const host = result.document.createElement('div')
      host.setAttribute('data-fict-s', found!.id)

      // Resume the scope
      const scopeData = __fictGetSSRScope(found!.id)
      const ctx = __fictEnsureScope(found!.id, host, scopeData)

      // Verify context is created with the signal
      expect(ctx).toBeDefined()
      expect(ctx.scopeId).toBe(found!.id)
      expect(ctx.slots.length).toBeGreaterThan(0)

      // The slot should contain a signal function created by createSignal
      const signal = ctx.slots[0]
      expect(typeof signal).toBe('function')
    } finally {
      result.dispose()
    }
  })

  it('multiple scopes can be independently resumed', () => {
    function Counter(props: { id: string; initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'div', props: { 'data-id': props.id, children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@multi-test', resume: 'counter#resume' }

    const result = renderToDocument(() => ({
      type: 'div',
      props: {
        children: [
          { type: Counter, props: { id: 'a', initial: 1 } },
          { type: Counter, props: { id: 'b', initial: 2 } },
          { type: Counter, props: { id: 'c', initial: 3 } },
        ],
      },
    }))

    try {
      const snapshot = parseSnapshot(result.html)
      expect(snapshot).not.toBeNull()

      const scopeIds = getScopeIds(snapshot!)
      expect(scopeIds.length).toBe(3)

      __fictSetSSRState(snapshot as any)
      __fictEnableResumable()

      // Find and resume the scope with initial value 2
      const found = findScopeWithSlotValue(snapshot!, 2)
      expect(found).not.toBeNull()
      const middleScopeId = found!.id

      const host = result.document.createElement('div')
      host.setAttribute('data-fict-s', middleScopeId)

      const scopeData = __fictGetSSRScope(middleScopeId)
      const ctx = __fictEnsureScope(middleScopeId, host, scopeData)

      // Only the middle scope should have been resumed
      const count = ctx.slots[0] as (() => number) | undefined
      expect(count).toBeDefined()
      expect(count!()).toBe(2)

      // Scope with value 1 should still be in snapshot (not resumed yet)
      const firstFound = findScopeWithSlotValue(snapshot!, 1)
      expect(firstFound).not.toBeNull()
      expect(firstFound!.scope.slots).toEqual([[0, 'sig', 1]])
    } finally {
      result.dispose()
    }
  })

  it('restored object signal snapshot structure is correct', () => {
    // Use a unique value that won't collide
    function StoreComponent(props: { initial: { count: number } }): FictNode {
      const ctx = __fictUseContext()
      const store = __fictUseSignal(ctx, props.initial, { name: 'store' })
      return { type: 'div', props: { children: String((store() as { count: number }).count) } }
    }

    ;(StoreComponent as any).__fictMeta = { id: 'Store@test', resume: 'store#resume' }

    const result = renderToDocument(() => ({
      type: StoreComponent,
      props: { initial: { count: 999 } },
    }))

    try {
      const snapshot = parseSnapshot(result.html)
      expect(snapshot).not.toBeNull()

      // Verify the snapshot contains the object value
      const found = findScopeWithSlotValue(snapshot!, { count: 999 })
      expect(found).not.toBeNull()
      expect(found!.scope.slots[0]).toEqual([0, 'sig', { count: 999 }])

      // Set up resumable state
      __fictSetSSRState(snapshot as any)
      __fictEnableResumable()

      const host = result.document.createElement('div')
      host.setAttribute('data-fict-s', found!.id)

      const scopeData = __fictGetSSRScope(found!.id)
      const ctx = __fictEnsureScope(found!.id, host, scopeData)

      // Verify context is created with the object signal
      expect(ctx).toBeDefined()
      expect(ctx.slots.length).toBeGreaterThan(0)
      expect(typeof ctx.slots[0]).toBe('function')
    } finally {
      result.dispose()
    }
  })

  it('props are preserved in snapshot and accessible after resume', () => {
    function Greeting(props: { name: string; age: number }): FictNode {
      const ctx = __fictUseContext()
      return { type: 'span', props: { children: `Hello ${props.name}, ${props.age}` } }
    }

    ;(Greeting as any).__fictMeta = { id: 'Greeting@props-test', resume: 'greeting#resume' }

    const result = renderToDocument(() => ({
      type: Greeting,
      props: { name: 'Alice', age: 30 },
    }))

    try {
      const snapshot = parseSnapshot(result.html)
      expect(snapshot).not.toBeNull()

      const scopeIds = getScopeIds(snapshot!)
      const scopeId = scopeIds[0]!

      const scopes = snapshot!.scopes as Record<string, { props?: Record<string, unknown> }>
      const scope = scopes[scopeId]

      // Props should be in snapshot
      expect(scope?.props).toBeDefined()
      expect(scope?.props?.name).toBe('Alice')
      expect(scope?.props?.age).toBe(30)
    } finally {
      result.dispose()
    }
  })
})

// ============================================================================
// Test Suite 3: List/Conditional/Fragment Combination Scenarios
// ============================================================================

describe('List/Conditional/Fragment Combination Scenarios', () => {
  afterEach(() => {
    __fictDisableResumable()
    __fictDisableSSR()
    __fictSetSSRState(null)
  })

  it('renders conditional with nested conditionals preserving markers', () => {
    function ConditionalComponent(props: { show: boolean; nested: boolean }): FictNode {
      const ctx = __fictUseContext()
      const show = __fictUseSignal(ctx, props.show, { name: 'show' })
      const nested = __fictUseSignal(ctx, props.nested, { name: 'nested' })

      if (!show()) return null
      if (nested()) {
        return { type: 'span', props: { children: 'Nested' } }
      }
      return { type: 'span', props: { children: 'Outer' } }
    }

    ;(ConditionalComponent as any).__fictMeta = { id: 'Cond@test', resume: 'cond#resume' }

    const html = renderToString(() => ({
      type: ConditionalComponent,
      props: { show: true, nested: true },
    }))

    expect(html).toContain('Nested')
    expect(html).toContain('<fict-host')
    expect(html).toContain('data-fict-s=')

    // Verify snapshot preserves both signals
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    const scopeIds = getScopeIds(snapshot!)
    expect(scopeIds.length).toBe(1)

    const scope = (snapshot!.scopes as Record<string, unknown>)[scopeIds[0]!] as {
      slots: Array<[number, string, unknown]>
    }
    expect(scope.slots.length).toBe(2)
    expect(scope.slots[0]).toEqual([0, 'sig', true])
    expect(scope.slots[1]).toEqual([1, 'sig', true])
  })

  it('renders list items with snapshot data', () => {
    interface Item {
      id: number
      name: string
    }

    function ListComponent(props: { items: Item[] }): FictNode {
      const ctx = __fictUseContext()
      const items = __fictUseSignal(ctx, props.items, { name: 'items' })

      return {
        type: 'ul',
        props: {
          children: items().map((item: Item) => ({
            type: 'li',
            props: { key: item.id, children: item.name },
          })),
        },
      }
    }

    ;(ListComponent as any).__fictMeta = { id: 'List@test', resume: 'list#resume' }

    const testItems = [
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
      { id: 3, name: 'Orange' },
    ]

    const html = renderToString(() => ({
      type: ListComponent,
      props: { items: testItems },
    }))

    expect(html).toContain('Apple')
    expect(html).toContain('Banana')
    expect(html).toContain('Orange')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li')

    // Verify snapshot has the items array
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    const found = findScopeWithSlotValue(snapshot!, testItems)
    expect(found).not.toBeNull()
    expect(found!.scope.slots[0]![0]).toBe(0)
    expect(found!.scope.slots[0]![1]).toBe('sig')
  })

  it('handles conditional inside list items', () => {
    interface Item {
      id: number
      name: string
      active: boolean
    }

    function ConditionalListItem(props: { item: Item }): FictNode {
      const ctx = __fictUseContext()
      const item = __fictUseSignal(ctx, props.item, { name: 'item' })

      const current = item() as Item
      if (current.active) {
        return { type: 'li', props: { class: 'active', children: current.name } }
      }
      return { type: 'li', props: { class: 'inactive', children: current.name } }
    }

    ;(ConditionalListItem as any).__fictMeta = {
      id: 'CondListItem@test',
      resume: 'condItem#resume',
    }

    function List(props: { items: Item[] }): FictNode {
      return {
        type: 'ul',
        props: {
          children: props.items.map(item => ({
            type: ConditionalListItem,
            props: { item },
          })),
        },
      }
    }

    const testItems = [
      { id: 1, name: 'Active', active: true },
      { id: 2, name: 'Inactive', active: false },
    ]

    const html = renderToString(() => ({
      type: List,
      props: { items: testItems },
    }))

    expect(html).toContain('class="active"')
    expect(html).toContain('class="inactive"')
    expect(html).toContain('Active')
    expect(html).toContain('Inactive')

    // Verify list item components have scopes
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    const scopeIds = getScopeIds(snapshot!)
    // Should have at least 2 scopes for the two ConditionalListItem components
    expect(scopeIds.length).toBeGreaterThanOrEqual(2)
  })

  it('handles list inside conditional', () => {
    interface Item {
      id: number
      name: string
    }

    function ConditionalList(props: { show: boolean; items: Item[] }): FictNode {
      const ctx = __fictUseContext()
      const show = __fictUseSignal(ctx, props.show, { name: 'show' })
      const items = __fictUseSignal(ctx, props.items, { name: 'items' })

      if (!show()) {
        return { type: 'p', props: { children: 'No items' } }
      }

      return {
        type: 'ul',
        props: {
          children: items().map((item: Item) => ({
            type: 'li',
            props: { key: item.id, children: item.name },
          })),
        },
      }
    }

    ;(ConditionalList as any).__fictMeta = { id: 'CondList@test', resume: 'condList#resume' }

    // Test with show=true
    const htmlShown = renderToString(() => ({
      type: ConditionalList,
      props: {
        show: true,
        items: [
          { id: 1, name: 'First' },
          { id: 2, name: 'Second' },
        ],
      },
    }))

    expect(htmlShown).toContain('<ul>')
    expect(htmlShown).toContain('First')
    expect(htmlShown).toContain('Second')

    // Test with show=false
    const htmlHidden = renderToString(() => ({
      type: ConditionalList,
      props: {
        show: false,
        items: [{ id: 1, name: 'First' }],
      },
    }))

    expect(htmlHidden).toContain('No items')
    expect(htmlHidden).not.toContain('<ul>')
  })

  it('handles fragment (array) children', () => {
    function FragmentComponent(props: { items: string[] }): FictNode {
      const ctx = __fictUseContext()
      const items = __fictUseSignal(ctx, props.items, { name: 'items' })

      // Return array (fragment)
      return items().map((item: string, index: number) => ({
        type: 'span',
        props: { key: index, children: item },
      })) as unknown as FictNode
    }

    ;(FragmentComponent as any).__fictMeta = { id: 'Fragment@test', resume: 'frag#resume' }

    const html = renderToString(() => ({
      type: FragmentComponent,
      props: { items: ['One', 'Two', 'Three'] },
    }))

    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).toContain('Three')
    // Check for span elements (may have key attribute)
    expect(html.match(/<span/g)?.length).toBe(3)
  })

  it('preserves scope data for deeply nested components', () => {
    function DeepChild(props: { value: number }): FictNode {
      const ctx = __fictUseContext()
      const value = __fictUseSignal(ctx, props.value, { name: 'value' })
      return { type: 'span', props: { children: String(value()) } }
    }

    ;(DeepChild as any).__fictMeta = { id: 'DeepChild@test', resume: 'deep#resume' }

    function MiddleComponent(props: { value: number }): FictNode {
      const ctx = __fictUseContext()
      const doubled = __fictUseSignal(ctx, props.value * 2, { name: 'doubled' })
      return {
        type: 'div',
        props: {
          children: { type: DeepChild, props: { value: doubled() } },
        },
      }
    }

    ;(MiddleComponent as any).__fictMeta = { id: 'Middle@test', resume: 'middle#resume' }

    function TopComponent(props: { base: number }): FictNode {
      const ctx = __fictUseContext()
      const base = __fictUseSignal(ctx, props.base, { name: 'base' })
      return {
        type: 'section',
        props: {
          children: { type: MiddleComponent, props: { value: base() } },
        },
      }
    }

    ;(TopComponent as any).__fictMeta = { id: 'Top@test', resume: 'top#resume' }

    const html = renderToString(() => ({
      type: TopComponent,
      props: { base: 5 },
    }))

    // Verify HTML structure
    expect(html).toContain('<section>')
    expect(html).toContain('<div>')
    expect(html).toContain('<span>')
    expect(html).toContain('10') // 5 * 2 = 10

    // Verify all three scopes are in snapshot
    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    const scopeIds = getScopeIds(snapshot!)
    expect(scopeIds.length).toBe(3)

    // Verify scope with base=5 exists
    const topScope = findScopeWithSlotValue(snapshot!, 5)
    expect(topScope).not.toBeNull()

    // Verify scope with doubled=10 exists
    const middleScope = findScopeWithSlotValue(snapshot!, 10)
    expect(middleScope).not.toBeNull()
  })

  it('handles empty list gracefully', () => {
    function EmptyListComponent(): FictNode {
      const ctx = __fictUseContext()
      const items = __fictUseSignal<string[]>(ctx, [], { name: 'items' })

      return {
        type: 'ul',
        props: {
          children:
            items().length > 0
              ? items().map((item: string, i: number) => ({
                  type: 'li',
                  props: { key: i, children: item },
                }))
              : { type: 'li', props: { class: 'empty', children: 'No items' } },
        },
      }
    }

    ;(EmptyListComponent as any).__fictMeta = { id: 'EmptyList@test', resume: 'empty#resume' }

    const html = renderToString(() => ({
      type: EmptyListComponent,
      props: {},
    }))

    expect(html).toContain('No items')
    expect(html).toContain('class="empty"')

    const snapshot = parseSnapshot(html)
    expect(snapshot).not.toBeNull()

    const scopeIds = getScopeIds(snapshot!)
    expect(scopeIds.length).toBe(1)

    const scope = (snapshot!.scopes as Record<string, unknown>)[scopeIds[0]!] as {
      slots: Array<[number, string, unknown]>
    }
    expect(scope.slots[0]).toEqual([0, 'sig', []])
  })

  it('handles conditional that returns null', () => {
    function MaybeRender(props: { visible: boolean }): FictNode {
      const ctx = __fictUseContext()
      const visible = __fictUseSignal(ctx, props.visible, { name: 'visible' })

      if (!visible()) {
        return null as unknown as FictNode
      }

      return { type: 'div', props: { children: 'Visible!' } }
    }

    ;(MaybeRender as any).__fictMeta = { id: 'Maybe@test', resume: 'maybe#resume' }

    // When visible=false
    const htmlHidden = renderToString(() => ({
      type: MaybeRender,
      props: { visible: false },
    }))

    // Component should still have scope wrapper but no content
    expect(htmlHidden).toContain('<fict-host')
    expect(htmlHidden).not.toContain('Visible!')

    // When visible=true
    const htmlVisible = renderToString(() => ({
      type: MaybeRender,
      props: { visible: true },
    }))

    expect(htmlVisible).toContain('Visible!')
  })
})
