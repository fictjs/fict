import type {
  CompileRequest,
  CompileResult,
  ModuleReactiveMetadata,
  ScanRequest,
  ScanResult,
} from '@fictjs/compiler'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    scan: vi.fn(),
    scanSync: vi.fn(),
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

function scanResult(request: ScanRequest, overrides: Partial<ScanResult> = {}): ScanResult {
  const dependencyStart = request.code.indexOf("'dep'")
  const legacyStart = request.code.indexOf("'legacy'")
  const hiddenStart = request.code.indexOf("'hidden'")
  const moduleRequests: ScanResult['moduleRequests'] = []
  if (dependencyStart !== -1) {
    moduleRequests.push({
      source: 'dep',
      kind: 'import',
      typeOnly: false,
      span: { start: dependencyStart, end: dependencyStart + 5 },
    })
  }
  if (legacyStart !== -1) {
    moduleRequests.push({
      source: 'legacy',
      kind: 'importEquals',
      typeOnly: false,
      span: { start: legacyStart, end: legacyStart + 8 },
    })
  }
  if (hiddenStart !== -1) {
    moduleRequests.push({
      source: 'hidden',
      kind: 'importEquals',
      typeOnly: true,
      span: { start: hiddenStart, end: hiddenStart + 8 },
    })
  }
  return {
    protocolVersion: 1,
    moduleRequests,
    hasModuleSyntax: moduleRequests.length > 0,
    diagnostics: [],
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
    scanSync: native.scanSync,
    scan: native.scan,
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
  beforeEach(() => {
    native.load.mockReset()
    native.scan.mockReset()
    native.scanSync.mockReset()
    native.transform.mockReset()
    native.scan.mockImplementation(async request => scanResult(request as ScanRequest))
    native.scanSync.mockImplementation(request => scanResult(request as ScanRequest))
    native.load.mockReturnValue(binding())
  })

  it('passes a serializable metadata snapshot to the native compile stage', async () => {
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
    const source = `
      import { count } from 'dep'
      import legacy = require('legacy')
      import type hidden = require('hidden')
      export function App() { return [count, legacy] }
    `
    const transformed = (await plugin.transform?.call(
      context() as never,
      source,
      '/project/src/App.tsx?import',
    )) as { code: string }

    expect(transformed.code).toBe('export const App = 1;\n')
    expect(native.load).toHaveBeenCalledOnce()
    expect(native.scan).toHaveBeenCalled()
    expect(native.scanSync).toHaveBeenCalled()
    expect(native.scan.mock.calls[0]?.[0]).toMatchObject({
      code: source,
      filename: '/project/src/App.tsx',
      moduleId: '/project/src/App.tsx?import',
    })
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
    })
    expect(request.metadata).toEqual([
      expect.objectContaining({
        request: 'dep',
        resolvedId: 'dep',
        status: 'resolved',
        metadata: dependency,
      }),
      expect.objectContaining({
        request: 'legacy',
        resolvedId: 'legacy',
        status: 'opaque',
        metadata: null,
      }),
    ])
    expect(request.metadata).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ request: 'hidden' })]),
    )
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

  it('fails before compilation when the native module scan reports a parser error', async () => {
    native.scan.mockImplementation(async request =>
      scanResult(request as ScanRequest, {
        diagnostics: [
          {
            code: 'FICT-PARSE',
            severity: 'error',
            message: 'invalid import declaration',
            primarySpan: { start: 7, end: 8 },
            secondaryLabels: [],
            help: null,
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
      plugin.transform?.call(context() as never, 'import {', '/project/src/broken.ts'),
    ).rejects.toThrow(/\[FICT-PARSE\].*invalid import declaration[\s\S]*broken\.ts:1:8/)
    expect(native.transform).not.toHaveBeenCalled()
  })

  it('fails fast when Preview output is requested from the stable Rust graph', () => {
    expect(() => fict({ backend: 'rust', resumable: true })).toThrow(
      'does not yet support Preview resumability',
    )
  })

  it('preserves the Vite full-reload contract without loading the native compiler', () => {
    const plugin = fict({
      backend: 'rust',
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    const send = vi.fn()

    plugin.configResolved?.({ ...config, command: 'serve' } as never)
    const result = plugin.handleHotUpdate?.({
      file: '/project/src/App.tsx',
      server: { ws: { send } },
    } as never)

    expect(result).toEqual([])
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })
    expect(native.load).not.toHaveBeenCalled()
    expect(native.scan).not.toHaveBeenCalled()
    expect(native.scanSync).not.toHaveBeenCalled()
    expect(native.transform).not.toHaveBeenCalled()
  })
})
