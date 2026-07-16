import { afterEach, expect, it, vi } from 'vitest'

const FORBIDDEN_RUST_BACKEND_MODULES = [
  '@babel/core',
  '@babel/generator',
  '@babel/helper-plugin-utils',
  '@babel/parser',
  '@babel/plugin-syntax-jsx',
  '@babel/plugin-transform-typescript',
  '@babel/traverse',
  '@babel/types',
] as const

afterEach(() => {
  for (const moduleId of FORBIDDEN_RUST_BACKEND_MODULES) vi.doUnmock(moduleId)
  vi.doUnmock('@fictjs/compiler/graph-host')
  vi.doUnmock('@fictjs/compiler/native')
  vi.resetModules()
})

it('imports and runs the Rust compiler without evaluating Babel', async () => {
  for (const moduleId of FORBIDDEN_RUST_BACKEND_MODULES) {
    vi.doMock(moduleId, () => {
      throw new Error(`Rust backend loaded forbidden runtime module ${moduleId}`)
    })
  }

  const compilerBuildId = `fict-rust-p1-oxc0.139.0-m1-${'7'.repeat(64)}`
  const scanResult = {
    protocolVersion: 1 as const,
    moduleRequests: [],
    hasModuleSyntax: true,
    diagnostics: [],
    compilerBuildId,
  }
  const transform = vi.fn(async () => ({
    protocolVersion: 1 as const,
    code:
      `import { __fictQrl } from 'fict/internal'\n` +
      `export const compiledByRust = __fictQrl("fict:compiler-artifact:handler-0", "default")\n`,
    map: null,
    diagnostics: [],
    moduleMetadata: { version: 1 as const, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [
      {
        id: 'handler-0',
        kind: 'handlerModule' as const,
        code: 'export default (_scopeId, event) => event.type;\n',
        map: null,
        handler: {
          sourceExportName: '__fict_e0',
          artifactExportName: 'default',
          moduleSpecifier: 'fict:compiler-artifact:handler-0',
          sourceSpan: { start: 0, end: 6 },
        },
      },
    ],
    stats: null,
    compilerBuildId,
  }))
  vi.doMock('@fictjs/compiler/graph-host', () => ({
    resolvePackageModuleMetadata: () => undefined,
  }))
  vi.doMock('@fictjs/compiler/native', () => ({
    loadNativeCompilerBinding: () => ({
      nativeCompilerInfo: () => ({
        backend: 'rust' as const,
        nativeTarget: 'aarch64-apple-darwin',
        oxcVersion: '0.139.0',
        nodeApiVersion: 10,
        compilerBuildId,
        compilerBuildRevision: null,
        compilerProtocolVersion: 1,
        metadataSchemaVersion: 1,
      }),
      scan: async () => scanResult,
      scanSync: () => scanResult,
      transform,
    }),
  }))

  const { default: fict } = await import('../index')
  const plugin = fict({
    resumable: true,
    functionSplitting: false,
    useTypeScriptProject: false,
    publicIdentityNamespace: 'loading-test@1',
  }) as any
  plugin.configResolved?.({
    command: 'build',
    mode: 'production',
    root: '/project',
    base: '/',
    build: { ssr: true },
    resolve: { alias: [], preserveSymlinks: false },
  } as never)
  const pluginContext = {
    emitFile: vi.fn(),
    warn: vi.fn(),
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error))
    },
  }
  const result = (await plugin.transform?.call(
    pluginContext as never,
    'export function App(): JSX.Element { return <main /> }',
    '/project/src/App.tsx',
  )) as { code: string }

  expect(result.code).toContain('compiledByRust')
  expect(result.code).not.toContain('fict:compiler-artifact:handler-0')
  const handlerModuleId = result.code.match(/"(virtual:fict-handler:[^"]+)"/)?.[1]
  expect(handlerModuleId).toBeTruthy()
  const resolved = await plugin.resolveId?.call(pluginContext as never, handlerModuleId!)
  const loaded = (await plugin.load?.call(pluginContext as never, resolved as string)) as {
    code: string
  }
  expect(loaded.code).toContain('event.type')
  expect(transform).toHaveBeenCalled()
})
