import { describe, expect, it } from 'vitest'

import { analyzeDocument, extractLocationFromCompilerMessage } from '../src/analysis/analyzerClient'

const UNSUPPORTED_HIR_SOURCE = `
import { $state } from 'fict'

export function App() {
  let state = $state({ user: { name: 'a' } })
  const arr = [, 1]
  return <div>{state.user.name}{arr.length}</div>
}
`

const UNSUPPORTED_STATEMENT_SOURCE = `
export function App() {
  debugger
  return <div />
}
`

const MODULE_LEVEL_STATE_ERROR_SOURCE = `
import { $state } from 'fict'
let count = $state(0)
count++

export function Util() {
  return 1
}
`

const INVALID_SYNTAX_SOURCE = `
import { $state } from 'fict'

export function App() {
  let count = $state(0)
  return <div>{count}</div>

`

describe('analyzer client', () => {
  it('extracts parser summary locations when compiler errors omit code frames', () => {
    expect(extractLocationFromCompilerMessage('/tmp/invalid.tsx: Unexpected token (8:0)')).toEqual({
      line: 8,
      column: 1,
    })
  })

  it('falls back to static components when compiler analysis hits unsupported HIR', async () => {
    const document = {
      languageId: 'typescriptreact',
      fileName: '/tmp/unsupported.tsx',
      uri: { fsPath: '/tmp/unsupported.tsx' },
      getText: () => UNSUPPORTED_HIR_SOURCE,
    } as const

    const result = await analyzeDocument(document as never, {
      mode: 'compiler',
      verbosity: 'minimal',
      includeRegions: true,
      includeDiagnostics: true,
    })

    expect(result).not.toBeNull()
    expect(result?.mode).toBe('compiler')
    expect(result?.components.length).toBeGreaterThan(0)
    expect(result?.components[0]?.name).toBe('App')
    expect(result?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FICT-HIR-UNSUPPORTED',
          severity: 'error',
        }),
      ]),
    )
  })

  it('falls back to static components for other compiler analysis errors', async () => {
    const document = {
      languageId: 'typescriptreact',
      fileName: '/tmp/debugger.tsx',
      uri: { fsPath: '/tmp/debugger.tsx' },
      getText: () => UNSUPPORTED_STATEMENT_SOURCE,
    } as const

    const result = await analyzeDocument(document as never, {
      mode: 'compiler',
      verbosity: 'minimal',
      includeRegions: true,
      includeDiagnostics: true,
    })

    expect(result).not.toBeNull()
    expect(result?.mode).toBe('compiler')
    expect(result?.components.length).toBeGreaterThan(0)
    expect(result?.components[0]?.name).toBe('App')
    expect(result?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FICT-COMPILE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('does not fabricate static components for non-HIR compiler errors', async () => {
    const document = {
      languageId: 'typescript',
      fileName: '/tmp/util.ts',
      uri: { fsPath: '/tmp/util.ts' },
      getText: () => MODULE_LEVEL_STATE_ERROR_SOURCE,
    } as const

    const result = await analyzeDocument(document as never, {
      mode: 'compiler',
      verbosity: 'minimal',
      includeRegions: true,
      includeDiagnostics: true,
    })

    expect(result).not.toBeNull()
    expect(result?.mode).toBe('compiler')
    expect(result?.components).toEqual([])
    expect(result?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FICT-COMPILE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('returns structured compiler diagnostics when analysis throws before compiler diagnostics are available', async () => {
    const document = {
      languageId: 'typescriptreact',
      fileName: '/tmp/invalid.tsx',
      uri: { fsPath: '/tmp/invalid.tsx' },
      getText: () => INVALID_SYNTAX_SOURCE,
    } as const

    const result = await analyzeDocument(document as never, {
      mode: 'compiler',
      verbosity: 'minimal',
      includeRegions: true,
      includeDiagnostics: true,
    })

    expect(result).not.toBeNull()
    expect(result?.mode).toBe('compiler')
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-COMPILE',
        severity: 'error',
        message: expect.stringContaining('Unexpected token'),
        line: 8,
        column: expect.any(Number),
      }),
    ])
    expect(result?.diagnostics[0]?.column).toBeGreaterThan(0)
  })
})
