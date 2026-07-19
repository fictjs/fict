import type { CompileRequest, CompileResult, ScanResult } from '@fictjs/compiler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  load: vi.fn(),
  scan: vi.fn(),
  transform: vi.fn(),
}))

vi.mock('@fictjs/compiler/native', () => ({
  loadNativeCompilerBinding: native.load,
}))

import fictWebpackLoader from '../loader'
import { attachLoaderBinding, createCompilationState } from '../shared'

function scanResult(): ScanResult {
  return {
    protocolVersion: 1,
    moduleRequests: [],
    hasModuleSyntax: false,
    diagnostics: [],
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'1'.repeat(64)}`,
  }
}

function compileResult(): CompileResult {
  return {
    protocolVersion: 1,
    code: 'export const value = 1;\n',
    map: null,
    diagnostics: [],
    moduleMetadata: { version: 1, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [],
    stats: null,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'1'.repeat(64)}`,
  }
}

async function compileWithLoaderOptions(
  mode: string,
  options: Record<string, unknown>,
): Promise<CompileRequest> {
  const resource = `/project/src/dev-default-${mode}.ts`
  const module = {
    buildInfo: {},
    identifier: () => resource,
    resource,
  }
  let callback: (error?: Error | null, content?: string) => void = () => undefined
  const completed = new Promise<string>((resolve, reject) => {
    callback = (error, content) => {
      if (error) reject(error)
      else resolve(content ?? '')
    }
  })
  const loaderContext = {
    async: () => callback,
    addDependency: vi.fn(),
    addMissingDependency: vi.fn(),
    cacheable: vi.fn(),
    getOptions: () => options,
    mode,
    resource,
    resourcePath: resource,
    rootContext: '/project',
    sourceMap: true,
  }
  attachLoaderBinding(loaderContext, {
    module: module as never,
    state: createCompilationState(),
  })

  fictWebpackLoader.call(loaderContext as never, 'export const value = true')
  await expect(completed).resolves.toBe('export const value = 1;\n')
  const calls = native.transform.mock.calls
  return calls[calls.length - 1]![0] as CompileRequest
}

describe('@fictjs/webpack-plugin compiler options', () => {
  beforeEach(() => {
    native.load.mockReset()
    native.scan.mockReset()
    native.transform.mockReset()
    native.scan.mockResolvedValue(scanResult())
    native.transform.mockResolvedValue(compileResult())
    native.load.mockReturnValue({ scan: native.scan, transform: native.transform })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['development default', 'development', {}, true],
    ['production default', 'production', {}, false],
    ['none-mode default', 'none', {}, true],
    ['explicit development opt-out', 'development', { dev: false }, false],
    ['explicit production opt-in', 'production', { dev: true }, true],
  ])('derives compiler dev for %s', async (_label, mode, options, expected) => {
    const request = await compileWithLoaderOptions(mode, options)
    expect(request.options?.dev).toBe(expected)
  })

  it('forces strict guarantees in production through the shared compiler policy', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('FICT_STRICT_GUARANTEE', 'false')
    const module = {
      buildInfo: {},
      identifier: () => '/project/src/strict.ts',
      resource: '/project/src/strict.ts',
    }
    let callback: (error?: Error | null, content?: string) => void = () => undefined
    const completed = new Promise<string>((resolve, reject) => {
      callback = (error, content) => {
        if (error) reject(error)
        else resolve(content ?? '')
      }
    })
    const loaderContext = {
      async: () => callback,
      addDependency: vi.fn(),
      addMissingDependency: vi.fn(),
      cacheable: vi.fn(),
      getOptions: () => ({ strictGuarantee: false }),
      mode: 'production',
      resource: '/project/src/strict.ts',
      resourcePath: '/project/src/strict.ts',
      rootContext: '/project',
      sourceMap: true,
    }
    attachLoaderBinding(loaderContext, {
      module: module as never,
      state: createCompilationState(),
    })

    fictWebpackLoader.call(loaderContext as never, 'export const value = true')
    await expect(completed).resolves.toBe('export const value = 1;\n')

    const request = native.transform.mock.calls[0]![0] as CompileRequest
    expect(request.options?.strictGuarantee).toBe(true)
  })

  it('forwards the same complete native TypeScript lowering option shape as Vite', async () => {
    const module = {
      buildInfo: {},
      identifier: () => '/project/src/options.ts',
      resource: '/project/src/options.ts',
    }
    let callback: (error?: Error | null, content?: string) => void = () => undefined
    const completed = new Promise<string>((resolve, reject) => {
      callback = (error, content) => {
        if (error) reject(error)
        else resolve(content ?? '')
      }
    })
    const loaderContext = {
      async: () => callback,
      addDependency: vi.fn(),
      addMissingDependency: vi.fn(),
      cacheable: vi.fn(),
      getOptions: () => ({
        typescriptOptions: {
          allowNamespaces: false,
          onlyRemoveTypeImports: true,
          optimizeConstEnums: true,
          optimizeEnums: true,
          rewriteImportExtensions: true,
          removeClassFieldsWithoutInitializer: true,
        },
      }),
      mode: 'development',
      resource: '/project/src/options.ts',
      resourcePath: '/project/src/options.ts',
      rootContext: '/project',
      sourceMap: true,
    }
    attachLoaderBinding(loaderContext, {
      module: module as never,
      state: createCompilationState(),
    })

    fictWebpackLoader.call(loaderContext as never, 'export const value: number = 1')
    await expect(completed).resolves.toBe('export const value = 1;\n')

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
})
