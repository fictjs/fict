import type { AnalyzeRequest, AnalyzeResult } from '@fictjs/compiler'
import { describe, expect, it, vi } from 'vitest'

import { analyzeDocument } from '../src/analysis/analyzerClient'
import type { NativeAnalyzer } from '../src/compiler/native'

const COMPONENT_SOURCE = `
import { $state } from 'fict'

export function App() {
  const count = $state(0)
  return <div>{count}</div>
}
`

const UNSUPPORTED_HIR_SOURCE = `
import { render } from 'fict'

export function App(props) {
  return <div>{...props.children}</div>
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

const settings = {
  mode: 'compiler' as const,
  verbosity: 'minimal' as const,
  includeRegions: true,
  includeDiagnostics: true,
}

function document(source: string, fileName = '/tmp/App.tsx') {
  return {
    languageId: fileName.endsWith('.tsx') ? 'typescriptreact' : 'typescript',
    fileName,
    uri: {
      fsPath: fileName,
      toString: () => `file://${fileName}`,
    },
    getText: () => source,
  } as const
}

function analyzer(result: AnalyzeResult): {
  compiler: NativeAnalyzer
  analyzeSync: ReturnType<typeof vi.fn<(request: AnalyzeRequest) => AnalyzeResult>>
} {
  const analyzeSync = vi.fn((_request: AnalyzeRequest) => result)
  return { compiler: { analyzeSync }, analyzeSync }
}

describe('analyzer client', () => {
  it('uses native analyzeSync and preserves trace and region output', async () => {
    const native = analyzer({
      fileName: '/tmp/App.tsx',
      components: [
        {
          name: 'App',
          startLine: 4,
          endLine: 7,
          trace: [
            {
              line: 6,
              markers: [{ kind: 'reactive', label: 'JSX expression updates' }],
            },
          ],
          regions: [
            {
              id: 0,
              startLine: 5,
              endLine: 6,
              dependencies: ['count'],
              declarations: [],
              hasControlFlow: false,
              hasReactiveWrites: false,
            },
          ],
        },
      ],
      diagnostics: [],
    })
    const sourceDocument = document(COMPONENT_SOURCE)
    const result = await analyzeDocument(
      sourceDocument as never,
      settings,
      undefined,
      native.compiler,
    )

    expect(result).toMatchObject({
      mode: 'compiler',
      isFictFile: true,
      components: [expect.objectContaining({ name: 'App' })],
      diagnostics: [],
    })
    expect(native.analyzeSync).toHaveBeenCalledWith(
      expect.objectContaining({
        code: COMPONENT_SOURCE,
        filename: '/tmp/App.tsx',
        moduleId: 'file:///tmp/App.tsx',
        language: 'tsx',
        options: expect.objectContaining({
          includeRegions: true,
          includeDiagnostics: true,
          verbosity: 'minimal',
        }),
      }),
    )
  })

  it('falls back to static components only for explicit native HIR failures', async () => {
    const native = analyzer({
      fileName: '/tmp/unsupported.tsx',
      components: [],
      diagnostics: [
        {
          code: 'FICT-HIR-UNSUPPORTED',
          severity: 'error',
          message: 'unsupported HIR fixture',
          line: 5,
          column: 10,
        },
      ],
    })
    const result = await analyzeDocument(
      document(UNSUPPORTED_HIR_SOURCE, '/tmp/unsupported.tsx') as never,
      settings,
      undefined,
      native.compiler,
    )

    expect(result?.mode).toBe('compiler')
    expect(result?.components[0]?.name).toBe('App')
    expect(result?.diagnostics[0]?.code).toBe('FICT-HIR-UNSUPPORTED')
  })

  it('does not fabricate static components for structured placement diagnostics', async () => {
    const native = analyzer({
      fileName: '/tmp/util.ts',
      components: [],
      diagnostics: [
        {
          code: 'FICT-PLACEMENT-STATE-OWNER',
          message: '$state() must be declared inside a component or hook function body',
          severity: 'error',
          line: 3,
          column: 13,
        },
      ],
    })
    const result = await analyzeDocument(
      document(MODULE_LEVEL_STATE_ERROR_SOURCE, '/tmp/util.ts') as never,
      settings,
      undefined,
      native.compiler,
    )

    expect(result?.mode).toBe('compiler')
    expect(result?.components).toEqual([])
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-PLACEMENT-STATE-OWNER',
        line: 3,
        column: 13,
      }),
    ])
  })

  it('uses structured parser locations without parsing compiler error strings', async () => {
    const native = analyzer({
      fileName: '/tmp/invalid.tsx',
      components: [],
      diagnostics: [
        {
          code: 'FICT-PARSE',
          severity: 'error',
          message: 'Expected `}` but found `EOF`',
          line: 8,
          column: 1,
        },
      ],
    })
    const result = await analyzeDocument(
      document(INVALID_SYNTAX_SOURCE, '/tmp/invalid.tsx') as never,
      settings,
      undefined,
      native.compiler,
    )

    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-PARSE',
        message: 'Expected `}` but found `EOF`',
        line: 8,
        column: 1,
      }),
    ])
  })

  it('reports native loader failures without regex-derived locations', async () => {
    const error = Object.assign(new Error('native package unavailable'), {
      code: 'FICT_NATIVE_COMPILER_LOAD_FAILED',
    })
    const compiler: NativeAnalyzer = {
      analyzeSync: vi.fn(() => {
        throw error
      }),
    }
    const result = await analyzeDocument(
      document(COMPONENT_SOURCE) as never,
      settings,
      undefined,
      compiler,
    )

    expect(result?.components[0]?.name).toBe('App')
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'FICT-NATIVE-LOAD',
        line: 1,
        column: 1,
      }),
    ])
  })
})
