import { describe, expect, it } from 'vitest'

import { createSelector, createSignal } from '../src/advanced'
import { batch, createEffect, createRoot } from '../src/index'

describe('selector predicates', () => {
  it('compares keys with the source instead of comparing successive sources', () => {
    const selected = createSignal(1)
    const values: boolean[] = []
    const owner = createRoot(() => {
      const matches = createSelector(
        () => selected(),
        (key, value) => key <= value,
      )
      createEffect(() => {
        values.push(matches(2))
      })
    })

    try {
      batch(() => selected(2))
      batch(() => selected(3))
      batch(() => selected(1))
      expect(values).toEqual([false, true, false])
    } finally {
      owner.dispose()
    }
  })

  it('accepts different key and source types without passing a source as a key', () => {
    const selected = createSignal(1)
    const values: boolean[] = []
    const owner = createRoot(() => {
      const matches = createSelector<number, string>(
        () => selected(),
        (key, value) => key.toLowerCase() === `row-${value}`,
      )
      createEffect(() => {
        values.push(matches('ROW-2'))
      })
    })

    try {
      batch(() => selected(2))
      batch(() => selected(3))
      expect(values).toEqual([false, true, false])
    } finally {
      owner.dispose()
    }
  })

  it('keeps NaN keys unselected under strict equality', () => {
    const selected = createSignal(NaN)
    const nanValues: boolean[] = []
    const oneValues: boolean[] = []
    const owner = createRoot(() => {
      const matches = createSelector(() => selected())
      createEffect(() => {
        nanValues.push(matches(NaN))
      })
      createEffect(() => {
        oneValues.push(matches(1))
      })
    })

    try {
      batch(() => selected(NaN))
      batch(() => selected(1))
      batch(() => selected(NaN))
      expect(nanValues).toEqual([false])
      expect(oneValues).toEqual([false, true, false])
    } finally {
      owner.dispose()
    }
  })
})

describe('selector subscriptions', () => {
  it('does not retain keys read without a reactive subscriber', () => {
    const selected = createSignal(0)
    let comparisons = 0
    const owner = createRoot(() => {
      const matches = createSelector(
        () => selected(),
        (key, value) => {
          comparisons++
          return key === value
        },
      )
      for (let key = 0; key < 1000; key++) expect(matches(key)).toBe(key === 0)
      return matches
    })

    try {
      comparisons = 0
      batch(() => selected(1))
      expect(comparisons).toBe(0)
      expect(owner.value(1)).toBe(true)
      expect(owner.value(0)).toBe(false)
    } finally {
      owner.dispose()
    }
  })
})
