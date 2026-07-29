import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  CompileRequest,
  CompileResult,
  ModuleReactiveMetadata,
  ScanRequest,
  ScanResult,
} from '@fictjs/compiler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    compilerCapabilityManifestVersion: 2,
    compilerCapabilityManifestDigest: `sha256:${'0'.repeat(64)}`,
    compilerCapabilityPackageVersion: 'test-capability-package',
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

import fict, { __fictVitePluginInternals } from '..'

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
  server: { fs: { allow: ['/project'] } },
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

function scanAllStaticImports(request: ScanRequest): ScanResult {
  const moduleRequests: ScanResult['moduleRequests'] = []
  const pattern = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g
  for (const match of request.code.matchAll(pattern)) {
    const source = match[1]!
    const start = match.index + match[0].lastIndexOf(source)
    moduleRequests.push({
      source,
      kind: 'import',
      typeOnly: false,
      span: { start, end: start + source.length },
    })
  }
  return {
    protocolVersion: 1,
    moduleRequests,
    hasModuleSyntax: moduleRequests.length > 0,
    diagnostics: [],
    compilerBuildId: native.info.compilerBuildId,
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

describe('Vite alias metadata resolution', () => {
  it.each(['g', 'y', 'gy'])(
    'applies a stateful /%s RegExp from the same position for matching and replacement',
    flags => {
      const find = new RegExp('^dep', flags)
      find.lastIndex = 7

      expect(
        __fictVitePluginInternals.applyAlias('dep/subpath', [
          { find, replacement: 'actual-package' },
        ]),
      ).toBe('actual-package/subpath')
      expect(find.lastIndex).toBe(7)
    },
  )

  it.each(['', 'g', 'y'])('does not mutate a frozen /%s RegExp alias', flags => {
    const find = Object.freeze(new RegExp('^dep', flags))

    expect(
      __fictVitePluginInternals.applyAlias('dep/subpath', [
        { find, replacement: 'actual-package' },
      ]),
    ).toBe('actual-package/subpath')
    expect(find.lastIndex).toBe(0)
  })
})

describe('Vite package metadata mapping', () => {
  it('does not publish a non-invertible public export pattern', () => {
    const asset = {
      chunkFileName: 'shared.js',
      metadataFileName: 'shared.fict.meta.json',
    }
    const result = __fictVitePluginInternals.buildFictPackageMappingResult(
      [asset],
      { exports: { './*': './shared.js' } },
      '/package',
      '/package',
    )

    expect([...result.mappings]).toEqual([])
    expect(result.unmappedAssets).toEqual([asset])
  })
})

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

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['serve command', 'serve', 'production', {}, true],
    ['development build', 'build', 'development', {}, true],
    ['production build', 'build', 'production', {}, false],
    ['explicit serve opt-out', 'serve', 'development', { dev: false }, false],
    ['explicit production opt-in', 'build', 'production', { dev: true }, true],
  ])('derives compiler dev for %s', async (_label, command, mode, compilerOptions, expected) => {
    native.transform.mockResolvedValue(compileResult())
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
      ...compilerOptions,
    })
    plugin.configResolved?.({ ...config, command, mode } as never)

    await plugin.transform?.call(
      context() as never,
      'export const value = true',
      '/project/src/dev-default.ts',
    )

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.options?.dev).toBe(expected)
  })

  it('forces strict guarantees in production through the shared compiler policy', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('FICT_STRICT_GUARANTEE', 'false')
    native.transform.mockResolvedValue(compileResult())
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
      strictGuarantee: false,
    })
    plugin.configResolved?.(config as never)

    await plugin.transform?.call(
      context() as never,
      'export const value = true',
      '/project/src/strict.ts',
    )

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.options?.strictGuarantee).toBe(true)
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
        resolvedId: null,
        status: 'missing',
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

  it('marks only plain packages opaque and fails closed for broken Fict declarations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-state-'))
    const importer = path.join(root, 'src', 'App.ts')
    const plainPackage = path.join(root, 'node_modules', 'plain-library')
    const brokenPackage = path.join(root, 'node_modules', 'broken-library')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(plainPackage, { recursive: true })
    await mkdir(brokenPackage, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      path.join(plainPackage, 'package.json'),
      JSON.stringify({ name: 'plain-library' }),
    )
    await writeFile(
      path.join(brokenPackage, 'package.json'),
      JSON.stringify({ name: 'broken-library', fict: { metadata: './index.fict.meta.json' } }),
    )
    await writeFile(path.join(brokenPackage, 'index.fict.meta.json'), '{')

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)

      await plugin.transform?.call(
        context() as never,
        "import 'plain-library'; import { useBroken } from 'broken-library'; export const value = useBroken();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            request: 'plain-library',
            resolvedId: 'plain-library',
            status: 'opaque',
            metadata: null,
          }),
          expect.objectContaining({
            request: 'broken-library',
            resolvedId: null,
            status: 'missing',
            metadata: null,
          }),
        ]),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads package metadata from Vite-resolved package boundaries outside ancestor node_modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-host-package-'))
    const importer = path.join(root, 'src', 'App.ts')
    const packageRoot = path.join(root, '.store', 'node_modules', 'virtual-hook')
    const packageEntry = path.join(packageRoot, 'index.js')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(packageEntry, 'export function useVirtual() {}')
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'virtual-hook',
        fict: { metadata: './index.fict.meta.json' },
      }),
    )
    await writeFile(
      metadataPath,
      JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
    )

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const metadataDependencies = vi.fn()
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
        onModuleMetadataDependency: metadataDependencies,
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)
      const resolve = vi.fn(async (source: string) =>
        source === 'virtual-hook' ? { id: packageEntry } : null,
      )

      await plugin.transform?.call(
        { ...context(), resolve } as never,
        "import { useVirtual } from 'virtual-hook'; export const value = useVirtual();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual([
        expect.objectContaining({
          request: 'virtual-hook',
          resolvedId: packageEntry,
          status: 'resolved',
          metadata: { version: 1, exports: {}, hooks: { useVirtual: {} } },
        }),
      ])
      expect(resolve).toHaveBeenCalledWith('virtual-hook', importer, { skipSelf: true })
      expect(metadataDependencies).toHaveBeenCalledWith(packageJsonPath)
      expect(metadataDependencies).toHaveBeenCalledWith(metadataPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads package metadata for Vite-resolved package imports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-imports-'))
    const importer = path.join(root, 'src', 'App.ts')
    const packageRoot = path.join(root, '.store', 'node_modules', 'hook-lib')
    const packageEntry = path.join(packageRoot, 'index.js')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(packageEntry, 'export function useVirtual() {}')
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'hook-lib',
        exports: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
    )
    await writeFile(
      metadataPath,
      JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
    )

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const metadataDependencies = vi.fn()
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
        onModuleMetadataDependency: metadataDependencies,
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)
      const resolve = vi.fn(async (source: string) =>
        source === '#virtual-hook' ? { id: packageEntry } : null,
      )

      await plugin.transform?.call(
        { ...context(), resolve } as never,
        "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual([
        expect.objectContaining({
          request: '#virtual-hook',
          resolvedId: packageEntry,
          status: 'resolved',
          metadata: { version: 1, exports: {}, hooks: { useVirtual: {} } },
        }),
      ])
      expect(resolve).toHaveBeenCalledWith('#virtual-hook', importer, { skipSelf: true })
      expect(metadataDependencies).toHaveBeenCalledWith(packageJsonPath)
      expect(metadataDependencies).toHaveBeenCalledWith(metadataPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for a Vite-resolved non-invertible package export pattern', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-pattern-'))
    const importer = path.join(root, 'src', 'App.ts')
    const packageRoot = path.join(root, '.store', 'node_modules', 'hook-lib')
    const packageEntry = path.join(packageRoot, 'shared.js')
    const metadataPath = path.join(packageRoot, 'shared.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(packageEntry, 'export function useVirtual() {}')
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'hook-lib',
        exports: { './*': './shared.js' },
        fict: { exports: { './*': './shared.fict.meta.json' } },
      }),
    )
    await writeFile(
      metadataPath,
      JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
    )

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)
      const resolve = vi.fn(async (source: string) =>
        source === '#virtual-hook' ? { id: packageEntry } : null,
      )

      await plugin.transform?.call(
        { ...context(), resolve } as never,
        "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual([
        expect.objectContaining({
          request: '#virtual-hook',
          resolvedId: null,
          status: 'missing',
          metadata: null,
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads package metadata for package imports externalized to a bare package', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-external-package-imports-'))
    const importer = path.join(root, 'src', 'App.ts')
    const packageRoot = path.join(root, 'node_modules', 'hook-lib')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'hook-lib',
        fict: { metadata: './index.fict.meta.json' },
      }),
    )
    await writeFile(
      metadataPath,
      JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
    )

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const metadataDependencies = vi.fn()
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
        onModuleMetadataDependency: metadataDependencies,
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)
      const resolve = vi.fn(async (source: string) =>
        source === '#virtual-hook' ? { id: 'hook-lib', external: true } : null,
      )

      await plugin.transform?.call(
        { ...context(), resolve } as never,
        "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual([
        expect.objectContaining({
          request: '#virtual-hook',
          resolvedId: 'hook-lib',
          status: 'resolved',
          metadata: { version: 1, exports: {}, hooks: { useVirtual: {} } },
        }),
      ])
      expect(resolve).toHaveBeenCalledWith('#virtual-hook', importer, { skipSelf: true })
      expect(metadataDependencies).toHaveBeenCalledWith(packageJsonPath)
      expect(metadataDependencies).toHaveBeenCalledWith(metadataPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads package metadata for package imports externalized to a physical entry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-external-package-entry-'))
    const importer = path.join(root, 'src', 'App.ts')
    const packageRoot = path.join(root, 'node_modules', 'hook-lib')
    const packageEntry = path.join(packageRoot, 'index.js')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(packageEntry, 'export function useVirtual() {}')
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'hook-lib',
        exports: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
    )
    await writeFile(
      metadataPath,
      JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
    )

    try {
      native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
      native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
      native.transform.mockResolvedValue(compileResult())
      const plugin = createTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'native-test@1',
      })
      plugin.configResolved?.({
        ...config,
        root,
        server: { fs: { allow: [root] } },
      } as never)
      const resolve = vi.fn(async (source: string) =>
        source === '#virtual-hook' ? { id: packageEntry, external: true } : null,
      )

      await plugin.transform?.call(
        { ...context(), resolve } as never,
        "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
        importer,
      )

      const request = native.transform.mock.calls[0]![0] as CompileRequest
      expect(request.metadata).toEqual([
        expect.objectContaining({
          request: '#virtual-hook',
          resolvedId: packageEntry,
          status: 'resolved',
          metadata: { version: 1, exports: {}, hooks: { useVirtual: {} } },
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'browser entry',
      { main: './server.js', browser: './browser.js' },
      ['browser', 'module'],
      'browser.js',
    ],
    [
      'browser object entry',
      { main: './server.js', browser: { './server.js': './browser.js' } },
      ['browser', 'module'],
      'browser.js',
    ],
    [
      'custom main field',
      { main: './server.js', customMain: './custom.js' },
      ['customMain'],
      'custom.js',
    ],
    ['implicit index entry', {}, ['browser', 'module'], 'index.js'],
    [
      'valid root entry beside invalid encoded entries',
      {
        exports: {
          '.': './index.js',
          './%2Fescape': './index.js',
          './%5cescape': './index.js',
          './%00escape': './index.js',
          './invalid%': './index.js',
          './NODE_MODULES/escape': './index.js',
        },
      },
      ['browser', 'module'],
      'index.js',
    ],
  ] as const)(
    'loads package-import metadata from a Vite-resolved %s',
    async (_label, entryManifest, mainFields, entryFileName) => {
      const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-import-entry-'))
      const importer = path.join(root, 'src', 'App.ts')
      const packageRoot = path.join(root, '.store', 'node_modules', 'hook-lib')
      const packageEntry = path.join(packageRoot, entryFileName)
      const packageJsonPath = path.join(packageRoot, 'package.json')
      const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
      await mkdir(path.dirname(importer), { recursive: true })
      await mkdir(packageRoot, { recursive: true })
      await writeFile(importer, 'export {}')
      for (const entry of ['server.js', 'browser.js', 'custom.js', 'index.js']) {
        await writeFile(path.join(packageRoot, entry), 'export function useVirtual() {}')
      }
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          name: 'hook-lib',
          ...entryManifest,
          fict: { metadata: './index.fict.meta.json' },
        }),
      )
      await writeFile(
        metadataPath,
        JSON.stringify({ version: 1, exports: {}, hooks: { useVirtual: {} } }),
      )

      try {
        native.scan.mockImplementation(async request =>
          scanAllStaticImports(request as ScanRequest),
        )
        native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
        native.transform.mockResolvedValue(compileResult())
        const plugin = createTestPlugin({
          cache: false,
          functionSplitting: false,
          useTypeScriptProject: false,
          publicIdentityNamespace: 'native-test@1',
        })
        plugin.configResolved?.({
          ...config,
          root,
          resolve: { ...config.resolve, mainFields: [...mainFields] },
          server: { fs: { allow: [root] } },
        } as never)
        const resolve = vi.fn(async (source: string) =>
          source === '#virtual-hook' ? { id: packageEntry } : null,
        )

        await plugin.transform?.call(
          { ...context(), resolve } as never,
          "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
          importer,
        )

        const request = native.transform.mock.calls[0]![0] as CompileRequest
        expect(request.metadata).toEqual([
          expect.objectContaining({
            request: '#virtual-hook',
            resolvedId: packageEntry,
            status: 'resolved',
            metadata: { version: 1, exports: {}, hooks: { useVirtual: {} } },
          }),
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    ['virtual scheme', { id: 'virtual:hook' }],
    ['one-character hierarchical scheme', { id: 'x://hook' }],
    ['internal id', { id: '\0virtual-hook' }],
    ['external scheme', { id: 'node:hook', external: true }],
  ] as const)('keeps a package import resolved to an opaque %s', async (_label, resolution) => {
    native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
    native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
    native.transform.mockResolvedValue(compileResult())
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.(config as never)
    const resolve = vi.fn(async (source: string) =>
      source === '#virtual-hook' ? resolution : null,
    )

    await plugin.transform?.call(
      { ...context(), resolve } as never,
      "import { useVirtual } from '#virtual-hook'; export const value = useVirtual();",
      '/project/src/App.ts',
    )

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.metadata).toEqual([
      expect.objectContaining({
        request: '#virtual-hook',
        resolvedId: resolution.id,
        status: 'opaque',
        metadata: null,
      }),
    ])
  })

  it('keeps scheme imports opaque instead of reporting missing package metadata', async () => {
    native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
    native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
    native.transform.mockResolvedValue(compileResult())
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.(config as never)
    const sources = ['node:async_hooks', 'virtual:hook', 'x://hook', 'https://example.test/hook.js']
    const code = sources
      .map((source, index) => `import { useHook as useHook${index} } from '${source}'`)
      .join('\n')

    await plugin.transform?.call(context() as never, code, '/project/src/App.ts')

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.metadata).toEqual(
      expect.arrayContaining(
        sources.map(source =>
          expect.objectContaining({
            request: source,
            resolvedId: source,
            status: 'opaque',
            metadata: null,
          }),
        ),
      ),
    )
    expect(request.metadata).toHaveLength(sources.length)
  })

  it('propagates partial local metadata as incompleteCycle without discarding known facts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-partial-metadata-'))
    const hookFile = path.join(root, 'hooks.ts')
    const appFile = path.join(root, 'app.ts')
    const hookSource = `
      export function useCounter() { return 1 }
      export * from 'ordinary-package'
    `
    const appSource = `
      import { useCounter } from './hooks'
      export const value = useCounter()
    `
    await writeFile(hookFile, hookSource)
    await writeFile(appFile, appSource)
    native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
    native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
    native.transform.mockImplementation(async request => {
      const input = request as CompileRequest
      if (input.filename === hookFile) {
        return compileResult({
          moduleMetadata: {
            version: 1,
            exports: {},
            hooks: { useCounter: { directAccessor: 'signal' } },
          },
          metadataIncomplete: true,
          unresolvedMetadataRequests: ['ordinary-package'],
        })
      }
      return compileResult()
    })
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.({ ...config, root } as never)

    try {
      await plugin.transform?.call(context() as never, appSource, appFile)
      const appRequest = native.transform.mock.calls
        .map(call => call[0] as CompileRequest)
        .find(request => request.filename === appFile)
      expect(appRequest?.metadata).toEqual([
        expect.objectContaining({
          request: './hooks',
          resolvedId: hookFile,
          status: 'incompleteCycle',
          metadata: {
            version: 1,
            exports: {},
            hooks: { useCounter: { directAccessor: 'signal' } },
          },
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('certifies a real metadata SCC after partial facts reach a fixed point', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-metadata-scc-'))
    const aFile = path.join(root, 'a.ts')
    const bFile = path.join(root, 'b.ts')
    const aSource = `import { useB } from './b'; export function useA() { return useB() }`
    const bSource = `import { useA } from './a'; export function useB() { return useA() }`
    await writeFile(aFile, aSource)
    await writeFile(bFile, bSource)
    native.scan.mockImplementation(async request => scanAllStaticImports(request as ScanRequest))
    native.scanSync.mockImplementation(request => scanAllStaticImports(request as ScanRequest))
    native.transform.mockImplementation(async request => {
      const input = request as CompileRequest
      const incomplete = input.metadata?.some(entry => entry.status === 'incompleteCycle') ?? false
      const hook = input.filename === aFile ? 'useA' : 'useB'
      return compileResult({
        moduleMetadata: {
          version: 1,
          exports: {},
          hooks: { [hook]: { directAccessor: 'signal' } },
        },
        metadataIncomplete: incomplete,
        unresolvedMetadataRequests: incomplete
          ? (input.metadata?.map(entry => entry.request) ?? [])
          : [],
      })
    })
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })
    plugin.configResolved?.({ ...config, root } as never)

    try {
      await plugin.transform?.call(context() as never, aSource, aFile)
      const requests = native.transform.mock.calls.map(call => call[0] as CompileRequest)
      expect(
        requests.some(request =>
          request.metadata?.some(entry => entry.status === 'incompleteCycle'),
        ),
      ).toBe(true)
      for (const filename of [aFile, bFile]) {
        const moduleRequests = requests.filter(request => request.filename === filename)
        const lastRequest = moduleRequests[moduleRequests.length - 1]
        expect(lastRequest?.metadata).toEqual([
          expect.objectContaining({ status: 'resolved', metadata: expect.any(Object) }),
        ])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
          const fallbackButton = document.createElement('button')
          fallbackButton.setAttribute('on:click', __fictQrl("fict:compiler-artifact:handler-0", "default"))
          export { button, fallbackButton }
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
    const handlerModuleIds = [...transformed.code.matchAll(/"(virtual:fict-handler:[^"]+)"/g)].map(
      match => match[1],
    )
    expect(handlerModuleIds).toHaveLength(2)
    expect(new Set(handlerModuleIds).size).toBe(1)
    const handlerModuleId = handlerModuleIds[0]
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

  it('adds an equivalent physical dev root to the Vite filesystem allowlist', async () => {
    const physicalRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-real-root-')))
    const logicalRoot = `${physicalRoot}-logical`
    const allow = [logicalRoot]
    const plugin = createTestPlugin({
      cache: false,
      functionSplitting: false,
      useTypeScriptProject: false,
      publicIdentityNamespace: 'native-test@1',
    })

    try {
      await symlink(physicalRoot, logicalRoot, process.platform === 'win32' ? 'junction' : 'dir')
      plugin.configResolved?.({
        ...config,
        command: 'serve',
        root: logicalRoot,
        server: { fs: { allow } },
      } as never)

      expect(allow).toContain(physicalRoot)
    } finally {
      await rm(logicalRoot, { recursive: true, force: true })
      await rm(physicalRoot, { recursive: true, force: true })
    }
  })
})
