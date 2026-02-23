import { describe, expect, it } from 'vitest'

import { normalizeDependencyKey as normalizeOverrideKey } from '../src/ir/codegen-overrides'
import { getSSABaseName, makeSSAName } from '../src/ir/hir'
import { normalizeDependencyKey } from '../src/ir/dependency-key'

describe('normalizeDependencyKey', () => {
  it('normalizes compiler-generated SSA keys segment-by-segment', () => {
    const user = makeSSAName('user', 1)
    const city = makeSSAName('city', 2)

    expect(normalizeDependencyKey(`${user}.address.${city}`)).toBe('user.address.city')
  })

  it('keeps user-defined $$ssa-like identifiers unchanged', () => {
    const raw = 'foo$$ssa1.profile'
    expect(normalizeDependencyKey(raw)).toBe(raw)
  })

  it('shares normalization behavior with codegen overrides', () => {
    const count = makeSSAName('count', 3)
    const key = `${count}.value`

    expect(normalizeOverrideKey(key)).toBe(normalizeDependencyKey(key))
    expect(normalizeOverrideKey(key)).toBe(`${getSSABaseName(count)}.value`)
  })
})
