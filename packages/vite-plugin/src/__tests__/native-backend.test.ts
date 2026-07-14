import type { CompileRequest, CompileResult, ModuleReactiveMetadata } from '@fictjs/compiler'
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const info = {
    backend: 'rust' as const,
    oxcVersion: '0.139.0',
    nodeApiVersion: 10,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'1'.repeat(64)}`,
    compilerProtocolVersion: 1,
    metadataSchemaVersion: 1,
  }
  return {
    info,
    transform: vi.fn(),
    load: vi.fn(),
  }
})

vi.mock('@fictjs/compiler/native', () => ({
  loadNativeCompilerBinding: native.load,
}))

import fict from '..'

const config = {
  command: 'build' as const,
  mode: 'production',
  root: '/project',
  base: '/',
  build: { ssr: true },
  resolve: { alias: [], preserveSymlinks: false },
}

function compileResult(overrides: Partial<CompileResult> = {}): CompileResult {
  return {
    protocolVersion: 1,
    code: 'export const App = 1;\n',
    map: null,
    diagnostics: [],
    moduleMetadata: { version: 1, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [],
    stats: null,
    compilerBuildId: native.info.compilerBuildId,
    ...overrides,
  }
}

function binding() {
  return {
    nativeCompilerInfo: () => native.info,
    parseTsxProbeSync: () => ({ statementCount: 1, diagnosticCount: 0 }),
    parseTsxProbeAsync: async () => ({ statementCount: 1, diagnosticCount: 0 }),
    transformSync: vi.fn(),
    transform: native.transform,
    scanSync: vi.fn(),
    scan: vi.fn(),
  }
}

function context() {
  return {
    emitFile: vi.fn(),
    warn: vi.fn(),
    error(error: unknown): never {
      if (error && typeof error === 'object' && 'message' in error) {
        throw new Error(String(error.message))
      }
      throw error instanceof Error ? error : new Error(String(error))
    },
  }
}

describe('Rust compiler backend', () => {
  it('passes a serializable metadata snapshot to the native compile stage', async () => {
    native.transform.mockReset()
    native.load.mockReset()
    native.load.mockReturnValue(binding())
    native.transform.mockResolvedValue(
      compileResult({
        diagnostics: [
          {
            code: 'FICT-R006',
            severity: 'warning',
            message: 'reactive loop fallback',
            primarySpan: { start: 0, end: 6 },
            secondaryLabels: [],
            help: null,
            notes: [],
            guaranteeClass: 'fallback',
          },
        ],
        moduleMetadata: {
          version: 1,
          exports: { App: 'signal' },
        },
        metadataDependencies: ['dep'],
        explain: {
          version: 1,
          fileName: '/project/src/App.tsx',
          helpers: ['signal'],
          diagnostics: [],
          events: [
            {
              kind: 'source-signal',
              message: 'signal source',
              name: 'App',
              code: null,
              span: { start: 0, end: 6 },
            },
          ],
        },
      }),
    )
    const dependency: ModuleReactiveMetadata = {
      version: 1,
      exports: { count: 'signal' },
    }
    const warnings = vi.fn()
    const explanations = vi.fn()
    const metadataDependencies = vi.fn()
    const plugin = fict({
      backend: 'rust',
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
      resolveModuleMetadata: source => (source === 'dep' ? dependency : undefined),
      onModuleMetadataDependency: metadataDependencies,
      onWarn: warnings,
      explain: explanations,
    })
    plugin.configResolved?.(config as never)
    const source = `import { count } from 'dep'; export function App() { return count }`
    const transformed = (await plugin.transform?.call(
      context() as never,
      source,
      '/project/src/App.tsx?import',
    )) as { code: string }

    expect(transformed.code).toBe('export const App = 1;\n')
    expect(native.load).toHaveBeenCalledOnce()
    expect(native.transform).toHaveBeenCalledOnce()
    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request).toMatchObject({
      code: source,
      filename: '/project/src/App.tsx',
      moduleId: '/project/src/App.tsx?import',
      options: {
        sourcemap: true,
        explain: true,
        fineGrainedDom: true,
        strictGuarantee: true,
        typescript: { allowNamespaces: true },
      },
      metadata: [
        {
          request: 'dep',
          resolvedId: 'dep',
          status: 'resolved',
          metadata: dependency,
        },
      ],
    })
    expect(request.metadata?.[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.values(request.options ?? {})).not.toContain(expect.any(Function))
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FICT-R006', line: 1, column: 1 }),
    )
    expect(explanations).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        events: [expect.objectContaining({ name: 'App', line: 1, column: 1 })],
      }),
    )
    expect(metadataDependencies).toHaveBeenCalledWith('dep')
  })

  it('surfaces structured native errors with source locations', async () => {
    native.transform.mockReset()
    native.load.mockReset()
    native.load.mockReturnValue(binding())
    native.transform.mockResolvedValue(
      compileResult({
        code: '',
        diagnostics: [
          {
            code: 'FICT-PARSE',
            severity: 'error',
            message: 'unexpected token',
            primarySpan: { start: 7, end: 8 },
            secondaryLabels: [],
            help: 'fix the token',
            notes: [],
            guaranteeClass: 'unsupported',
          },
        ],
      }),
    )
    const plugin = fict({
      backend: 'rust',
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.(config as never)

    await expect(
      plugin.transform?.call(context() as never, 'const =', '/project/src/broken.ts'),
    ).rejects.toThrow(/\[FICT-PARSE\].*unexpected token[\s\S]*broken\.ts:1:8/)
  })

  it('fails fast when Preview output is requested from the stable Rust graph', () => {
    expect(() => fict({ backend: 'rust', resumable: true })).toThrow(
      'does not yet support Preview resumability',
    )
  })
})
