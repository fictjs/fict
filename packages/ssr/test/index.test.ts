import { describe, it, expect } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictQrl,
  __fictUseContext,
  __fictUseSignal,
} from '@fictjs/runtime/internal'

import { renderToDocument, renderToString } from '../src/index'

describe('@fictjs/ssr', () => {
  it('renders snapshot script with scope data', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'span', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@test', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter, props: { initial: 5 } }))

    expect(html).toContain('<fict-host')
    expect(html).toContain('data-fict-s=')
    expect(html).toContain('data-fict-t="Counter@test"')
    expect(html).toContain('data-fict-h="counter#resume"')

    const match = html.match(
      /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
    )
    expect(match).not.toBeNull()
    const state = JSON.parse(match?.[1] ?? '{}') as {
      scopes: Record<
        string,
        { slots: Array<[number, string, unknown]>; props?: Record<string, unknown> }
      >
    }
    const scopeIds = Object.keys(state.scopes ?? {})
    expect(scopeIds.length).toBe(1)
    expect(state.v).toBe(FICT_SSR_SNAPSHOT_SCHEMA_VERSION)
    const scope = state.scopes[scopeIds[0]!]!
    expect(scope.props?.initial).toBe(5)
    expect(scope.slots).toEqual([[0, 'sig', 5]])
  })

  it('escapes snapshot payload to avoid script breakout', () => {
    const attack = '</script><script>globalThis.__fictXss=1</script>'

    function Counter(): FictNode {
      const ctx = __fictUseContext()
      const message = __fictUseSignal(ctx, attack, { name: 'message' })
      return { type: 'span', props: { children: String(message()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@xss', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter, props: {} }))
    expect(html).not.toContain('</script><script>globalThis.__fictXss=1</script>')
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.__fictXss=1')

    const match = html.match(
      /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
    )
    expect(match).not.toBeNull()
    const state = JSON.parse(match?.[1] ?? '{}') as {
      scopes: Record<string, { slots: Array<[number, string, unknown]> }>
    }
    const scope = state.scopes[Object.keys(state.scopes)[0]!]!
    expect(scope.slots[0]?.[2]).toBe(attack)
  })

  it('installs manifest mapping for QRL resolution', () => {
    const manifest = {
      'file:///counter.tsx': '/assets/counter.js',
    }

    const result = renderToDocument(() => ({ type: 'div', props: {} }), {
      includeSnapshot: false,
      manifest,
    })

    try {
      expect(__fictQrl('file:///counter.tsx', '__fict_r0')).toBe('/assets/counter.js#__fict_r0')
    } finally {
      result.dispose()
    }
  })
})
