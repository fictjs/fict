import { describe, expect, it, vi } from 'vitest'

import { transform } from '../test-utils'
import {
  compareBackendOutcomes,
  compileFixture,
  normalizeComparableValue,
  type BackendOutcome,
  type CompileFixture,
  type CompilerBackend,
} from './backend-harness'
import { createLegacyCompilerBackend, type LegacyFixtureOptions } from './legacy-backend'

const fixture: CompileFixture<LegacyFixtureOptions> = {
  name: 'stateful counter',
  filename: '/fixtures/counter.tsx',
  source: `
    import { $state } from 'fict'

    export function Counter() {
      let count = $state(0)
      return <button onClick={() => count++}>{count}</button>
    }
  `,
}

function backend(name: string, result: ReturnType<CompilerBackend['compile']>): CompilerBackend {
  return { name, compile: vi.fn(() => result) }
}

describe('backend-neutral differential fixture harness', () => {
  it('adapts the real legacy compiler without changing its generated code', async () => {
    const report = await compileFixture(fixture, [createLegacyCompilerBackend()])

    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]?.outcome).toMatchObject({
      status: 'success',
      code: transform(fixture.source, {}, fixture.filename),
      diagnostics: [],
    })
    expect(report.comparisons).toEqual([])
  })

  it('captures a real legacy source map when the fixture requests one', async () => {
    const report = await compileFixture({ ...fixture, options: { sourcemap: true } }, [
      createLegacyCompilerBackend(),
    ])

    expect(report.outcomes[0]?.outcome).toMatchObject({
      status: 'success',
      sourceMap: {
        version: 3,
        sources: [fixture.filename],
      },
    })
  })

  it('runs every injected backend with the same fixture and compares to the first', async () => {
    const legacy = backend('legacy', { code: 'const value = 1;' })
    const rust = backend('rust', Promise.resolve({ code: 'const value = 1;' }))
    const neutralFixture = {
      name: 'same output',
      filename: 'same.tsx',
      source: 'const value: number = 1',
      options: { dev: true },
    }

    const report = await compileFixture(neutralFixture, [legacy, rust])

    expect(legacy.compile).toHaveBeenCalledWith(neutralFixture)
    expect(rust.compile).toHaveBeenCalledWith(neutralFixture)
    expect(report.comparisons).toEqual([
      {
        baseline: 'legacy',
        candidate: 'rust',
        equivalent: true,
        differences: [],
      },
    ])
  })

  it('reports generated code differences without hiding whitespace', async () => {
    const report = await compileFixture(
      { name: 'code diff', filename: 'diff.ts', source: 'const value = 1' },
      [
        backend('legacy', { code: 'const value = 1;' }),
        backend('rust', { code: 'const value=1;' }),
      ],
    )

    expect(report.comparisons[0]).toMatchObject({
      equivalent: false,
      differences: [{ field: 'code' }],
    })
  })

  it('normalizes diagnostic ordering and line endings', async () => {
    const first = {
      code: '',
      diagnostics: [
        { code: 'FICT-B', message: 'second\r\nline', severity: 'warning' as const, line: 2 },
        { code: 'FICT-A', message: 'first', severity: 'error' as const, line: 1 },
      ],
    }
    const second = {
      code: '',
      diagnostics: [
        { code: 'FICT-A', message: 'first', severity: 'error' as const, line: 1 },
        { code: 'FICT-B', message: 'second\nline', severity: 'warning' as const, line: 2 },
      ],
    }

    const report = await compileFixture(
      { name: 'diagnostics', filename: 'diagnostics.tsx', source: '' },
      [backend('legacy', first), backend('rust', second)],
    )

    expect(report.comparisons[0]?.equivalent).toBe(true)
    expect(report.outcomes[0]?.outcome).toMatchObject({
      diagnostics: [{ code: 'FICT-A' }, { code: 'FICT-B', message: 'second\nline' }],
    })
  })

  it('normalizes object, map, and set ordering before metadata comparison', async () => {
    const report = await compileFixture({ name: 'metadata', filename: 'metadata.ts', source: '' }, [
      backend('legacy', {
        code: '',
        metadata: {
          exports: new Map([
            ['z', 'memo'],
            ['a', 'signal'],
          ]),
          helpers: new Set(['signal', 'memo']),
        },
      }),
      backend('rust', {
        code: '',
        metadata: {
          helpers: new Set(['memo', 'signal']),
          exports: new Map([
            ['a', 'signal'],
            ['z', 'memo'],
          ]),
        },
      }),
    ])

    expect(report.comparisons[0]?.equivalent).toBe(true)
  })

  it('captures backend exceptions as explicit comparable failures', async () => {
    const createFailure = () => {
      const error = new SyntaxError('unsupported syntax\r\nnear token')
      Object.assign(error, { code: 'FICT-PARSE', loc: { line: 3, column: 7 } })
      return error
    }
    const throwingBackend = (name: string): CompilerBackend => ({
      name,
      compile() {
        throw createFailure()
      },
    })

    const report = await compileFixture(
      { name: 'failure', filename: 'failure.ts', source: 'invalid' },
      [throwingBackend('legacy'), throwingBackend('rust')],
    )

    expect(report.outcomes[0]?.outcome).toEqual({
      status: 'failure',
      error: {
        name: 'SyntaxError',
        message: 'unsupported syntax\nnear token',
        code: 'FICT-PARSE',
        line: 3,
        column: 7,
      },
    })
    expect(report.comparisons[0]?.equivalent).toBe(true)
  })

  it('distinguishes backend failure from a successful empty compilation', () => {
    const failure: BackendOutcome = {
      backend: 'legacy',
      outcome: { status: 'failure', error: { name: 'Error', message: 'failed' } },
    }
    const success: BackendOutcome = {
      backend: 'rust',
      outcome: { status: 'success', code: '', diagnostics: [] },
    }

    expect(compareBackendOutcomes(failure, success)).toMatchObject({
      equivalent: false,
      differences: [{ field: 'status' }, { field: 'error' }],
    })
  })

  it('rejects empty and duplicate backend lists instead of silently skipping work', async () => {
    await expect(compileFixture(fixture, [])).rejects.toThrow(
      'requires at least one compiler backend',
    )
    await expect(
      compileFixture(fixture, [createLegacyCompilerBackend(), createLegacyCompilerBackend()]),
    ).rejects.toThrow('Duplicate compiler backend name: legacy')
  })

  it('fails closed for cyclic or executable comparison values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => normalizeComparableValue(cyclic)).toThrow('cannot contain cycles')
    expect(() => normalizeComparableValue({ callback: () => undefined })).toThrow(
      'cannot contain function values',
    )
  })
})
