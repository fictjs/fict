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

  it('returns diagnostics instead of throwing for unsupported HIR input', () => {
    const result = analyzeFictFile(
      `
        function App() {
          const arr = [, 1]
          return <div>{arr.length}</div>
        }
      `,
      'unsupported.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
      },
    )

    expect(result.components).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FICT-HIR-UNSUPPORTED',
          severity: 'error',
        }),
      ]),
    )
    expect(result.diagnostics[0]?.message).toContain('Array literal holes')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('preserves compiler diagnostics when unsupported HIR stops component analysis', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        function App() {
          let state = $state({ user: { name: 'a' } })
          state.user.name = 'b'
          const arr = [, 1]
          return <div>{state.user.name}{arr.length}</div>
        }
      `,
      'unsupported-with-warning.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
      },
    )

    expect(result.components).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FICT-M', severity: 'warning' }),
        expect.objectContaining({
          code: 'FICT-HIR-UNSUPPORTED',
          severity: 'error',
        }),
      ]),
    )
  })

  it('preserves structured diagnostics during recovery even when warnings are escalated', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        function App() {
          let state = $state({ user: { name: 'a' } })
          state.user.name = 'b'
          const arr = [, 1]
          return <div>{state.user.name}{arr.length}</div>
        }
      `,
      'unsupported-with-escalation.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
        compilerOptions: {
          warningsAsErrors: ['FICT-M'],
        },
      },
    )

    expect(result.components).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FICT-M', severity: 'warning' }),
        expect.objectContaining({
          code: 'FICT-HIR-UNSUPPORTED',
          severity: 'error',
        }),
      ]),
    )
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('throws when unsupported HIR input is encountered and diagnostics are disabled', () => {
    expect(() =>
      analyzeFictFile(
        `
          function App() {
            const arr = [, 1]
            return <div>{arr.length}</div>
          }
        `,
        'unsupported.tsx',
        {
          includeRegions: true,
          includeDiagnostics: false,
          verbosity: 'minimal',
        },
      ),
    ).toThrow(/Array literal holes/)
  })

  it('returns a generic compile diagnostic when no structured compiler warning exists', () => {
    const result = analyzeFictFile(
      `
        export function App() {
          debugger
          return <div />
        }
      `,
      'unsupported-statement.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
      },
    )

    expect(result.components).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-COMPILE',
        severity: 'error',
      }),
    ])
  })
})
