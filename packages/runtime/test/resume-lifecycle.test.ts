import { afterEach, describe, expect, it } from 'vitest'

import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictDisableResumable,
  __fictDisableSSR,
  __fictEnableSSR,
  __fictEnsureScope,
  __fictGetScopeProps,
  __fictGetScopeRegistry,
  __fictGetSSRScope,
  __fictRegisterScope,
  __fictSerializeSSRState,
  __fictSerializeSSRStateForScopes,
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

  it('serializes and restores complex scope props through JSON', () => {
    __fictEnableSSR()
    const props = {
      date: new Date(0),
      map: new Map([['a', 1]]),
      set: new Set([1]),
      undef: undefined,
      nan: NaN,
      inf: Infinity,
      negInf: -Infinity,
      big: 1n,
    }
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = { slots: [], cursor: 0 }
    const id = __fictRegisterScope(scopeContext, document.createElement('div'), 'Child', props)

    const state = JSON.parse(JSON.stringify(__fictSerializeSSRState())) as ReturnType<
      typeof __fictSerializeSSRState
    >
    __fictEnsureScope(id, document.createElement('div'), state.scopes[id])

    const restored = __fictGetScopeProps(id) as typeof props
    expect(restored.date).toBeInstanceOf(Date)
    expect(restored.date.getTime()).toBe(0)
    expect(restored.map).toBeInstanceOf(Map)
    expect(restored.map.get('a')).toBe(1)
    expect(restored.set).toBeInstanceOf(Set)
    expect(restored.set.has(1)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(restored, 'undef')).toBe(true)
    expect(restored.undef).toBeUndefined()
    expect(Number.isNaN(restored.nan)).toBe(true)
    expect(restored.inf).toBe(Infinity)
    expect(restored.negInf).toBe(-Infinity)
    expect(restored.big).toBe(1n)
  })

  it('serializes complex scope props in scoped snapshots', () => {
    __fictEnableSSR()
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = { slots: [], cursor: 0 }
    const id = __fictRegisterScope(scopeContext, document.createElement('div'), 'Child', {
      big: 1n,
      date: new Date(0),
    })

    const state = JSON.parse(JSON.stringify(__fictSerializeSSRStateForScopes([id]))) as ReturnType<
      typeof __fictSerializeSSRStateForScopes
    >
    __fictEnsureScope(id, document.createElement('div'), state.scopes[id])

    const restored = __fictGetScopeProps(id) as { big: bigint; date: Date }
    expect(restored.big).toBe(1n)
    expect(restored.date).toBeInstanceOf(Date)
    expect(restored.date.getTime()).toBe(0)
  })

  it('omits function-valued object props while preserving nested data props', () => {
    __fictEnableSSR()
    function Child() {
      return null
    }
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = { slots: [], cursor: 0 }
    const id = __fictRegisterScope(scopeContext, document.createElement('div'), 'Child', {
      onClick: () => undefined,
      child: {
        type: Child,
        props: {
          date: new Date(0),
        },
      },
    })

    const state = JSON.parse(JSON.stringify(__fictSerializeSSRState())) as ReturnType<
      typeof __fictSerializeSSRState
    >
    __fictEnsureScope(id, document.createElement('div'), state.scopes[id])

    const restored = __fictGetScopeProps(id) as {
      onClick?: unknown
      child: { type?: unknown; props: { date: Date } }
    }
    expect(Object.prototype.hasOwnProperty.call(restored, 'onClick')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(restored.child, 'type')).toBe(false)
    expect(restored.child.props.date).toBeInstanceOf(Date)
    expect(restored.child.props.date.getTime()).toBe(0)
  })

  it('skips raw function hook slots during snapshot serialization', () => {
    __fictEnableSSR()
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = {
      slots: [],
      cursor: 0,
    }
    scopeContext.slots[1000] = () => undefined
    const id = __fictRegisterScope(scopeContext, document.createElement('div'), 'Child', {
      label: 'ok',
    })

    const state = __fictSerializeSSRState()
    expect(state.scopes[id]?.slots).toEqual([])
    expect(state.scopes[id]?.slots.some(([index]) => index === 1000)).toBe(false)
  })

  it('preserves references shared between scope props and slots', () => {
    __fictEnableSSR()
    const shared = { value: 1 }
    const scopeContext: Parameters<typeof __fictRegisterScope>[0] = {
      slots: [shared],
      cursor: 0,
      slotMap: { shared: 0 },
    }
    const id = __fictRegisterScope(scopeContext, document.createElement('div'), 'Child', {
      shared,
    })

    const state = JSON.parse(JSON.stringify(__fictSerializeSSRState())) as ReturnType<
      typeof __fictSerializeSSRState
    >
    __fictEnsureScope(id, document.createElement('div'), state.scopes[id])

    const [slotShared] = __fictUseLexicalScope(id, ['shared']) as [{ value: number }]
    const restoredProps = __fictGetScopeProps(id) as { shared: { value: number } }
    expect(restoredProps.shared).toBe(slotShared)
    expect(restoredProps.shared.value).toBe(1)
  })
})
