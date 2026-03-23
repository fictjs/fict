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

  it('returns the strict compiler error before unsupported HIR recovery runs', () => {
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'FICT-M', severity: 'error' }),
    ])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-HIR-UNSUPPORTED')).toBe(
      false,
    )
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('preserves structured diagnostics when explicit escalation blocks before HIR recovery', () => {
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'FICT-M', severity: 'error' }),
    ])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-HIR-UNSUPPORTED')).toBe(
      false,
    )
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('reports strictGuarantee fallback diagnostics as errors by default', () => {
    const result = analyzeFictFile(
      `
        function App({ list: [first, ...rest] }) {
          return <div>{first}</div>
        }
      `,
      'strict-guarantee-default.tsx',
      {
        includeRegions: false,
        includeDiagnostics: true,
      },
    )

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-P002', severity: 'error' })]),
    )
  })

  it('honors default FICT-R004 error behavior in tooling analysis', () => {
    const result = analyzeFictFile(
      `
        import { $state, createEffect } from 'fict'

        export function App() {
          const count = $state(0)
          if (count > 0) {
            createEffect(() => console.log(count))
          }
          return <div>{count}</div>
        }
      `,
      'strict-r004-default.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-R004', severity: 'error' })]),
    )
  })

  it('preserves structured diagnostics when strictGuarantee blocks compilation by default', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        export function App() {
          let state = $state({ count: 0 })
          state.count = 1
          return <div>{state.count}</div>
        }
      `,
      'strict-guarantee-blocked.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-M', severity: 'error' })]),
    )
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('downgrades strictGuarantee fallback diagnostics when strictGuarantee is disabled', () => {
    const result = analyzeFictFile(
      `
        function App({ list: [first, ...rest] }) {
          return <div>{first}</div>
        }
      `,
      'strict-guarantee-disabled.tsx',
      {
        includeRegions: false,
        includeDiagnostics: true,
        compilerOptions: {
          strictGuarantee: false,
        },
      },
    )

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-P002', severity: 'warning' })]),
    )
  })

  it('allows component analysis when strictGuarantee is explicitly disabled', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        export function App() {
          let state = $state({ count: 0 })
          state.count = 1
          return <div>{state.count}</div>
        }
      `,
      'strict-guarantee-opt-out.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        compilerOptions: {
          strictGuarantee: false,
        },
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-M', severity: 'warning' })]),
    )
  })

  it('allows explicitly downgrading FICT-R004 through compilerOptions.warningLevels', () => {
    const result = analyzeFictFile(
      `
        import { $state, createEffect } from 'fict'

        export function App() {
          const count = $state(0)
          if (count > 0) {
            createEffect(() => console.log(count))
          }
          return <div>{count}</div>
        }
      `,
      'strict-r004-downgraded.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        compilerOptions: {
          warningLevels: { 'FICT-R004': 'warn' },
        },
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-R004', severity: 'warning' })]),
    )
  })

  it('preserves FICT-C002 for direct loop/conditional hook placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        export function App({ items }) {
          for (const item of items) {
            let count = $state(item)
            console.log(count)
          }
          return <div />
        }
      `,
      'loop-hooks.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-C002', severity: 'error' })]),
    )
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('preserves FICT-C001 for direct conditional hook placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        export function App({ ready }) {
          if (ready) {
            let count = $state(0)
            return <div>{count}</div>
          }
          return <div>fallback</div>
        }
      `,
      'conditional-hooks.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FICT-C001', severity: 'error' })]),
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
