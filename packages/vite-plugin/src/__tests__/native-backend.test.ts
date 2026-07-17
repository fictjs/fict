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
    nativeTarget: 'aarch64-apple-darwin',
    oxcVersion: '0.139.0',
    nodeApiVersion: 10,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'1'.repeat(64)}`,
    compilerBuildRevision: null,
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

function createTestPlugin(options: Parameters<typeof fict>[0] = {}) {
  return fict(options) as any
}

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
    analyzeSync: vi.fn(),
    analyze: vi.fn(),
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

  it('uses Rust for the whole build', async () => {
    native.transform.mockResolvedValue(
      compileResult({ code: 'export const selectedByDefault = true;\n' }),
    )
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.(config as never)

    const result = (await plugin.transform?.call(
      context() as never,
      'export const source = true',
      '/project/src/default.ts',
    )) as { code: string }

    expect(result.code).toContain('selectedByDefault')
    expect(native.transform).toHaveBeenCalledOnce()
  })

  it('forwards every native TypeScript lowering option', async () => {
    native.transform.mockResolvedValue(compileResult())
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
      typescriptOptions: {
        allowNamespaces: false,
        onlyRemoveTypeImports: true,
        optimizeConstEnums: true,
        optimizeEnums: true,
        rewriteImportExtensions: true,
        removeClassFieldsWithoutInitializer: true,
      },
    })
    plugin.configResolved?.(config as never)

    await plugin.transform?.call(
      context() as never,
      'export const value: number = 1',
      '/project/src/options.ts',
    )

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.options?.typescript).toEqual({
      allowNamespaces: false,
      onlyRemoveTypeImports: true,
      optimizeConstEnums: true,
      optimizeEnums: true,
      rewriteImportExtensions: true,
      removeClassFieldsWithoutInitializer: true,
    })
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
    const plugin = createTestPlugin({
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
    const plugin = createTestPlugin({
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
    const plugin = createTestPlugin({
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

  it('consumes structured Rust Preview handlers without reparsing compiler output', async () => {
    native.transform.mockResolvedValue(
      compileResult({
        code: `
          import { __fictQrl } from 'fict/internal'
          const button = document.createElement('button')
          button.setAttribute('on:click', __fictQrl("fict:compiler-artifact:handler-0", "default"))
          export { button }
        `,
        map: {
          version: 3,
          sources: ['/sources/App.tsx'],
          sourcesContent: ['export const source = true'],
          names: [],
          mappings: 'AAAA;AACA;AACA;AACA;AACA',
        },
        artifacts: [
          {
            id: 'handler-0',
            kind: 'handlerModule',
            code: 'export default (_scopeId, event) => event.type;\n',
            map: {
              version: 3,
              sources: ['/sources/App.tsx'],
              sourcesContent: ['export const source = true'],
              names: [],
              mappings: 'AAAA',
            },
            handler: {
              sourceExportName: '__fict_e0',
              artifactExportName: 'default',
              moduleSpecifier: 'fict:compiler-artifact:handler-0',
              sourceSpan: { start: 0, end: 6 },
            },
          },
        ],
      }),
    )
    const plugin = createTestPlugin({
      resumable: true,
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.(config as never)
    const pluginContext = context()
    const transformed = (await plugin.transform?.call(
      pluginContext as never,
      'export const source = true',
      '/project/src/App.tsx',
    )) as { code: string; map: unknown }

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.options?.preview).toEqual({
      resumable: true,
      autoExtractHandlers: true,
      autoExtractThreshold: 3,
    })
    expect(transformed.code).not.toContain('fict:compiler-artifact:handler-0')
    const handlerModuleId = transformed.code.match(/"(virtual:fict-handler:[^"]+)"/)?.[1]
    expect(handlerModuleId).toBeTruthy()
    expect(transformed.map).toMatchObject({ sources: ['/sources/App.tsx'] })

    const resolved = await plugin.resolveId?.call(pluginContext as never, handlerModuleId!)
    const loaded = (await plugin.load?.call(pluginContext as never, resolved as string)) as {
      code: string
      map: unknown
    }
    expect(loaded.code).toBe('export default (_scopeId, event) => event.type;\n')
    expect(JSON.parse(loaded.map as string)).toMatchObject({ sources: ['/sources/App.tsx'] })
  })

  it('preserves the Vite full-reload contract without loading the native compiler', () => {
    const plugin = createTestPlugin({
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
