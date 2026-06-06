import { afterEach, describe, expect, it } from 'vitest'

import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictDisableResumable,
  __fictDisableSSR,
  __fictEnableSSR,
  __fictEnsureScope,
  __fictGetScopeRegistry,
  __fictGetSSRScope,
  __fictRegisterScope,
  __fictSetSSRState,
  __fictUseLexicalScope,
  serializeValue,
} from '../src/internal'

describe('SSR lifecycle state cleanup', () => {
  afterEach(() => {
    __fictDisableResumable()
    __fictDisableSSR()
    __fictSetSSRState(null)
  })

  it('clears registry, snapshot state, and resumed scopes when SSR is disabled', () => {
    __fictEnableSSR()

    const host = document.createElement('div')
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = { slots: [], cursor: 0 }
    __fictRegisterScope(scopeContext, host)

    const scopeSnapshot = {
      id: 's-resume',
      slots: [[0, 'raw' as const, 41]],
      vars: { value: 0 },
    }

    __fictSetSSRState({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: { 's-resume': scopeSnapshot },
    })
    __fictEnsureScope('s-resume', document.createElement('div'), scopeSnapshot)

    expect(__fictGetScopeRegistry().size).toBe(1)
    expect(__fictGetSSRScope('s-resume')).toEqual(scopeSnapshot)
    expect(__fictUseLexicalScope('s-resume', ['value'])).toEqual([41])

    __fictDisableSSR()

    expect(__fictGetScopeRegistry().size).toBe(0)
    expect(__fictGetSSRScope('s-resume')).toBeUndefined()
    expect(() => __fictUseLexicalScope('s-resume', ['value'])).toThrow(
      '[fict] Missing resumed scope for s-resume',
    )
  })

  it('restores cross-slot references with shared refs', () => {
    const seen = new Map<object, string>()
    const shared = { value: 1 }
    const slot0 = serializeValue(shared, seen, '$[0]')
    const slot1 = serializeValue({ shared }, seen, '$[1]')
    const scopeSnapshot = {
      id: 's-cross-slot',
      slots: [
        [0, 'raw' as const, slot0],
        [1, 'raw' as const, slot1],
      ],
      vars: { first: 0, second: 1 },
    }

    __fictEnsureScope('s-cross-slot', document.createElement('div'), scopeSnapshot)

    const [first, second] = __fictUseLexicalScope('s-cross-slot', ['first', 'second']) as [
      { value: number },
      { shared: { value: number } },
    ]
    expect(second.shared).toBe(first)
    expect(second.shared.value).toBe(1)
  })
})
