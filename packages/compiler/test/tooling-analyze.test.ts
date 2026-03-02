import { describe, expect, it } from 'vitest'

import { analyzeFictFile } from '../src/index'

const SAMPLE_COMPONENT = `
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

describe('analyzeFictFile', () => {
  it('returns component analysis with trace markers and regions', () => {
    const result = analyzeFictFile(SAMPLE_COMPONENT, 'counter.tsx', {
      includeRegions: true,
      includeDiagnostics: true,
      verbosity: 'verbose',
    })

    expect(result.fileName).toBe('counter.tsx')
    expect(result.components.length).toBeGreaterThan(0)

    const counter = result.components.find(component => component.name === 'Counter')
    expect(counter).toBeDefined()
    expect(counter?.trace.length).toBeGreaterThan(0)
    expect(counter?.regions?.length ?? 0).toBeGreaterThan(0)

    const markerKinds = new Set(
      (counter?.trace ?? []).flatMap(entry => entry.markers.map(marker => marker.kind)),
    )

    expect(markerKinds.has('once')).toBe(true)
    expect(markerKinds.has('effect')).toBe(true)
  })

  it('can skip diagnostics and regions when configured', () => {
    const result = analyzeFictFile(SAMPLE_COMPONENT, 'counter.tsx', {
      includeRegions: false,
      includeDiagnostics: false,
      verbosity: 'minimal',
    })

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.components[0]?.regions).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })
})
