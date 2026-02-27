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
})
