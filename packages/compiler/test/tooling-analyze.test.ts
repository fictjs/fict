import { describe, expect, it } from 'vitest'

import { analyzeFictFile } from '../src/index'
import { inferCompilerDiagnosticFromSource } from '../src/tooling/analyze'

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

function sourceLine(source: string, needle: string): number {
  const line = source.split(/\r?\n/).findIndex(text => text.includes(needle))
  expect(line).toBeGreaterThanOrEqual(0)
  return line + 1
}

function hasTraceMarker(
  source: string,
  identifier: string,
  lineNeedle: string,
  kind: 'once' | 'reactive' | 'effect',
): boolean {
  const result = analyzeFictFile(source, `${identifier}.tsx`, {
    includeRegions: true,
    includeDiagnostics: true,
    verbosity: 'verbose',
  })
  const component = result.components.find(entry => entry.name === identifier)
  const line = sourceLine(source, lineNeedle)
  return (
    component?.trace
      .find(entry => entry.line === line)
      ?.markers.some(marker => marker.kind === kind) ?? false
  )
}

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

  it('marks state initialization declarations on their source lines', () => {
    const source = `
      import { $state, $state as s } from 'fict'

      export function App() {
        const count = $state(0)
        let total = s(1)
        return <div>{count + total}</div>
      }
    `
    const result = analyzeFictFile(source, 'state-trace.tsx', {
      includeRegions: true,
      includeDiagnostics: true,
      verbosity: 'verbose',
    })

    const app = result.components.find(component => component.name === 'App')
    expect(app).toBeDefined()

    for (const needle of ['const count', 'let total']) {
      const line = sourceLine(source, needle)
      expect(app?.trace.find(entry => entry.line === line)?.markers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'once',
            label: 'Signal initialization runs once',
          }),
        ]),
      )
    }

    const jsxLine = sourceLine(source, 'return <div>')
    expect(app?.trace.find(entry => entry.line === jsxLine)?.markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'reactive' })]),
    )
  })

  it('marks JSX reads of dollar-prefixed state identifiers as reactive', () => {
    const source = `
      import { $state } from 'fict'

      export function Counter() {
        let $count = $state(0)
        return <button>{$count}</button>
      }
    `

    expect(hasTraceMarker(source, 'Counter', 'return <button>{$count}</button>', 'reactive')).toBe(
      true,
    )
  })

  it('marks derived JSX reads from dollar-suffixed state identifiers as reactive', () => {
    const source = `
      import { $state } from 'fict'

      export function Counter() {
        let count$ = $state(0)
        const doubled$ = count$ * 2
        return <button>{doubled$}</button>
      }
    `

    expect(
      hasTraceMarker(source, 'Counter', 'return <button>{doubled$}</button>', 'reactive'),
    ).toBe(true)
  })

  it('does not match dollar-prefixed state identifiers inside longer identifiers', () => {
    const source = `
      import { $state } from 'fict'

      export function Counter() {
        let $count = $state(0)
        const $counter = 1
        return <button>{$counter}</button>
      }
    `

    expect(
      hasTraceMarker(source, 'Counter', 'return <button>{$counter}</button>', 'reactive'),
    ).toBe(false)
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

  it('includes no-JSX components that use aliased $state imports', () => {
    const result = analyzeFictFile(
      `
        import { $state as s } from 'fict'

        export function Counter() {
          let count = s(0)
          return count
        }
      `,
      'aliased-state.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
      },
    )

    expect(result.components.some(component => component.name === 'Counter')).toBe(true)
  })

  it('includes no-JSX components that use aliased $effect imports', () => {
    const result = analyzeFictFile(
      `
        import { $effect as fx } from 'fict'

        export function Counter() {
          fx(() => {})
          return null
        }
      `,
      'aliased-effect.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
        verbosity: 'minimal',
      },
    )

    expect(result.components.some(component => component.name === 'Counter')).toBe(true)
  })

  it('returns diagnostics instead of throwing for unsupported HIR input', () => {
    const result = analyzeFictFile(
      `
        function App() {
          return <svg:path />
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
    expect(result.diagnostics[0]?.message).toContain('Unsupported JSX tag syntax')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-COMPILE')).toBe(false)
  })

  it('returns the strict compiler error before unsupported HIR recovery runs', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        function App() {
          let state = $state({ user: { name: 'a' } })
          state.user.name = 'b'
          return <div>{state.user.name}<svg:path /></div>
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
          return <div>{state.user.name}<svg:path /></div>
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

  it('preserves FICT-C001 for conditional $effect placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $effect } from 'fict'

        export function App({ ready }) {
          if (ready) {
            $effect(() => console.log('ready'))
          }
          return <div />
        }
      `,
      'conditional-effect.tsx',
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

  it('preserves FICT-C002 for loop $effect placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $effect } from 'fict'

        export function App({ items }) {
          for (const item of items) {
            $effect(() => console.log(item))
          }
          return <div />
        }
      `,
      'loop-effect.tsx',
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

  it('preserves FICT-C001 for conditional $memo placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $memo } from 'fict'

        export function App({ ready }) {
          if (ready) {
            const doubled = $memo(() => 2)
            return <div>{doubled}</div>
          }
          return <div />
        }
      `,
      'conditional-memo.tsx',
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

  it('preserves FICT-C002 for loop $memo placement errors', () => {
    const result = analyzeFictFile(
      `
        import { $memo } from 'fict'

        export function App({ items }) {
          for (const item of items) {
            const value = $memo(() => item)
            return <div>{value}</div>
          }
          return <div />
        }
      `,
      'loop-memo.tsx',
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

  it('infers direct hook placement codes from summary-only compiler messages', () => {
    const inferred = inferCompilerDiagnosticFromSource(
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
      '/home/runner/work/fict/fict/packages/compiler/loop-hooks.tsx: $state() cannot be declared inside loops or conditionals.',
    )

    expect(inferred).toEqual(
      expect.objectContaining({
        code: 'FICT-C002',
        location: expect.objectContaining({
          line: 6,
        }),
      }),
    )
    expect(inferred?.location.column ?? 0).toBeGreaterThan(0)
  })

  it('infers effect placement codes from summary-only compiler messages', () => {
    const inferred = inferCompilerDiagnosticFromSource(
      `
        import { $effect } from 'fict'

        export function App({ ready }) {
          if (ready) {
            $effect(() => console.log('ready'))
          }
          return <div />
        }
      `,
      'conditional-effect.tsx',
      '/home/runner/work/fict/fict/packages/compiler/conditional-effect.tsx: $effect() cannot be called inside loops or conditionals.',
    )

    expect(inferred).toEqual(
      expect.objectContaining({
        code: 'FICT-C001',
        location: expect.objectContaining({
          line: 6,
        }),
      }),
    )
  })

  it('infers memo placement codes from summary-only compiler messages', () => {
    const inferred = inferCompilerDiagnosticFromSource(
      `
        import { $memo } from 'fict'

        export function App({ ready }) {
          if (ready) {
            const doubled = $memo(() => 2)
            return <div>{doubled}</div>
          }
          return <div />
        }
      `,
      'conditional-memo.tsx',
      '/home/runner/work/fict/fict/packages/compiler/conditional-memo.tsx: $memo() cannot be called inside loops or conditionals.',
    )

    expect(inferred).toEqual(
      expect.objectContaining({
        code: 'FICT-C001',
        location: expect.objectContaining({
          line: 6,
        }),
      }),
    )
  })

  it('infers nested hook locations from summary-only compiler messages', () => {
    const inferred = inferCompilerDiagnosticFromSource(
      `
        import { $state } from 'fict'

        export function App() {
          function inner() {
            let count = $state(0)
            return count
          }

          return <div>{inner()}</div>
        }
      `,
      'nested-state.tsx',
      '/home/runner/work/fict/fict/packages/compiler/nested-state.tsx: $state() cannot be declared inside nested functions.',
    )

    expect(inferred).toEqual(
      expect.objectContaining({
        code: null,
        location: expect.objectContaining({
          line: 6,
        }),
      }),
    )
    expect(inferred?.location.column ?? 0).toBeGreaterThan(0)
  })

  it('throws when unsupported HIR input is encountered and diagnostics are disabled', () => {
    expect(() =>
      analyzeFictFile(
        `
          function App() {
            return <svg:path />
          }
        `,
        'unsupported.tsx',
        {
          includeRegions: true,
          includeDiagnostics: false,
          verbosity: 'minimal',
        },
      ),
    ).toThrow(/Unsupported JSX tag syntax/)
  })

  it('returns a generic compile diagnostic when no structured compiler warning exists', () => {
    const result = analyzeFictFile(
      `
        export function App() {
          type Local = string
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

  it('returns a located generic compile diagnostic for direct compiler errors without mapped codes', () => {
    const result = analyzeFictFile(
      `
        import { $state } from 'fict'

        export function App() {
          function inner() {
            let count = $state(0)
            return count
          }

          return <div>{inner()}</div>
        }
      `,
      'nested-state.tsx',
      {
        includeRegions: true,
        includeDiagnostics: true,
      },
    )

    expect(result.components.length).toBeGreaterThan(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-COMPILE',
        severity: 'error',
        message: expect.stringContaining('$state() cannot be declared inside nested functions.'),
        line: 6,
      }),
    ])
    expect(result.diagnostics[0]?.column ?? 0).toBeGreaterThan(0)
  })
})
