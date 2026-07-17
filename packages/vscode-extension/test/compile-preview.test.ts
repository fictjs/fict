import type { CompileRequest, CompileResult, FictDiagnostic } from '@fictjs/compiler'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeTransformer } from '../src/compiler/native'

vi.mock('vscode', () => ({
  Uri: {
    parse(value: string) {
      return {
        toString: () => value,
      }
    },
  },
  EventEmitter: class<T> {
    readonly event = vi.fn()
    fire = vi.fn()
    dispose = vi.fn()
  },
}))

import { compileDocumentSource } from '../src/commands/compilePreview'

function createDocument(
  source: string,
  fileName = '/tmp/App.tsx',
  languageId = fileName.endsWith('.tsx') ? 'typescriptreact' : 'typescript',
) {
  return {
    fileName,
    languageId,
    uri: { toString: () => `file://${fileName}` },
    getText: () => source,
  } as const
}

function compileResult(code: string, diagnostics: FictDiagnostic[] = []): CompileResult {
  return {
    protocolVersion: 1,
    code,
    map: null,
    diagnostics,
    moduleMetadata: { version: 1, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [],
    stats: null,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
  }
}

function transformer(result: CompileResult): {
  compiler: NativeTransformer
  transformSync: ReturnType<typeof vi.fn<(request: CompileRequest) => CompileResult>>
} {
  const transformSync = vi.fn((_request: CompileRequest) => result)
  return { compiler: { transformSync }, transformSync }
}

describe('compile preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses native transformSync with explicit TSX identity', () => {
    const native = transformer(compileResult('const count = __fictUseSignal(0)'))
    const document = createDocument(
      "import { $state } from 'fict'\nexport function App(){ let count = $state(0); return <button>{count}</button> }\n",
    )
    const output = compileDocumentSource(document as never, native.compiler)

    expect(output).toContain('__fictUseSignal')
    expect(native.transformSync).toHaveBeenCalledWith(
      expect.objectContaining({
        code: document.getText(),
        filename: '/tmp/App.tsx',
        moduleId: 'file:///tmp/App.tsx',
        language: 'tsx',
        options: expect.objectContaining({ dev: false, strictGuarantee: true }),
      }),
    )
  })

  it('selects TypeScript grammar for angle-bracket assertions', () => {
    const native = transformer(compileResult('const asserted = input;'))
    const output = compileDocumentSource(
      createDocument(
        "import { $state } from 'fict'\nexport function useValue(input: unknown) { const asserted = <number>input; const value = $state(asserted); return value }\n",
        '/tmp/use-value.ts',
      ) as never,
      native.compiler,
    )

    expect(output).not.toContain('<number>')
    expect(native.transformSync).toHaveBeenCalledWith(expect.objectContaining({ language: 'ts' }))
  })

  it('preserves structured strict-guarantee failures in preview compilation', () => {
    const native = transformer(
      compileResult('', [
        {
          code: 'FICT-M',
          severity: 'error',
          message: 'nested state mutation is unsupported',
          primarySpan: { start: 0, end: 1 },
          secondaryLabels: [],
          help: null,
          notes: [],
          guaranteeClass: 'unsupported',
        },
      ]),
    )

    expect(() =>
      compileDocumentSource(
        createDocument(
          "import { $state } from 'fict'\nexport function App(){ let state = $state({ count: 0 }); state.count = 1; return <div>{state.count}</div> }\n",
        ) as never,
        native.compiler,
      ),
    ).toThrow(/\[FICT-M\].*nested state mutation/)
  })
})
