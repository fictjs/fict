import { describe, expect, it } from 'vitest'
import * as t from '@babel/types'

import { applyRegionMetadata, type RegionMetadata } from '../src/fine-grained-dom'
import { makeSSAName } from '../src/ir/hir'

describe('applyRegionMetadata', () => {
  it('normalizes generated SSA dependency keys for overrides', () => {
    const ssaCount = makeSSAName('count', 1)
    const state: { identifierOverrides?: Record<string, () => t.Expression> } = {}
    const region: RegionMetadata = {
      id: 1,
      dependencies: new Set([`${ssaCount}.value`]),
      declarations: new Set(),
      hasControlFlow: false,
      hasReactiveWrites: false,
    }

    applyRegionMetadata(state, {
      region,
      dependencyGetter: name => t.identifier(name.replace(/[^\w$]/g, '_')),
    })

    expect(state.identifierOverrides).toBeDefined()
    expect(state.identifierOverrides?.['count.value']).toBeTypeOf('function')
    expect(state.identifierOverrides?.count).toBeTypeOf('function')
  })

  it('does not strip non-SSA underscore suffixes from dependency keys', () => {
    const state: { identifierOverrides?: Record<string, () => t.Expression> } = {}
    const region: RegionMetadata = {
      id: 2,
      dependencies: new Set(['user_1.profile_2']),
      declarations: new Set(),
      hasControlFlow: false,
      hasReactiveWrites: false,
    }

    applyRegionMetadata(state, {
      region,
      dependencyGetter: name => t.identifier(name.replace(/[^\w$]/g, '_')),
    })

    expect(state.identifierOverrides).toBeDefined()
    expect(state.identifierOverrides?.['user_1.profile_2']).toBeTypeOf('function')
    expect(state.identifierOverrides?.user_1).toBeTypeOf('function')
    expect(state.identifierOverrides?.user).toBeUndefined()
  })

  it('keeps user-defined $$ssa-like names when not compiler generated', () => {
    const state: { identifierOverrides?: Record<string, () => t.Expression> } = {}
    const region: RegionMetadata = {
      id: 3,
      dependencies: new Set(['foo$$ssa1.bar']),
      declarations: new Set(),
      hasControlFlow: false,
      hasReactiveWrites: false,
    }

    applyRegionMetadata(state, {
      region,
      dependencyGetter: name => t.identifier(name.replace(/[^\w$]/g, '_')),
    })

    expect(state.identifierOverrides).toBeDefined()
    expect(state.identifierOverrides?.['foo$$ssa1.bar']).toBeTypeOf('function')
    expect(state.identifierOverrides?.['foo$$ssa1']).toBeTypeOf('function')
    expect(state.identifierOverrides?.foo).toBeUndefined()
  })
})
