import { describe, expect, it } from 'vitest'

import {
  analyzeStaticFictSource,
  isLikelyFictSource,
  mergeLiveTraceUpdates,
} from '../src/analysis/static-analyzer'

const SOURCE = `
import { $effect, $state } from 'fict'

export function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    console.log(count)
  })

  return <button>{doubled}</button>
}
`

describe('static analyzer', () => {
  it('detects likely Fict source', () => {
    expect(isLikelyFictSource(SOURCE)).toBe(true)
  })

  it('produces component and trace markers', () => {
    const result = analyzeStaticFictSource(SOURCE, 'counter.tsx', 'verbose')
    expect(result.isFictFile).toBe(true)
    expect(result.mode).toBe('static')
    expect(result.components.length).toBeGreaterThan(0)

    const counter = result.components.find(component => component.name === 'Counter')
    expect(counter).toBeDefined()
    expect(counter?.trace.length).toBeGreaterThan(0)
  })

  it('merges live trace updates into existing component traces', () => {
    const result = analyzeStaticFictSource(SOURCE, 'counter.tsx', 'minimal')
    const updates = new Map([
      [8, { line: 8, kind: 'effect' as const, runCount: 3, lastDurationMs: 2.6 }],
    ])

    const merged = mergeLiveTraceUpdates(result.components, updates)
    const hasLiveMarker = merged.some(component =>
      component.trace.some(entry =>
        entry.markers.some(marker => marker.label === 'Live trace update from dev server'),
      ),
    )

    expect(hasLiveMarker).toBe(true)
  })
})
