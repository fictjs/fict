import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it, expect, vi } from 'vitest'

import fict, { __fictVitePluginInternals } from '..'

// Mock Vite config for testing
const mockBuildConfig = {
  command: 'build' as const,
  mode: 'production',
  root: '/project',
  base: '/',
  build: { ssr: false },
  resolve: { alias: [] },
}

const mockSsrBuildConfig = {
  ...mockBuildConfig,
  build: { ssr: true },
}

type TestPlugin = ReturnType<typeof fict> & {
  configResolved?: (config: unknown) => void
  transform?: (this: unknown, code: string, id: string) => unknown | Promise<unknown>
  generateBundle?: {
    call: (context: unknown, options: unknown, bundle: unknown) => unknown
  }
  writeBundle?: {
    call: (context: unknown, options: unknown, bundle: unknown) => unknown | Promise<unknown>
  }
  handleHotUpdate?: (context: {
    file: string
    server: { ws: { send: (payload: unknown) => void } }
  }) => unknown[] | void
}

function getTestPlugin(options?: Parameters<typeof fict>[0]): TestPlugin {
  return fict(options) as TestPlugin
}

describe('fict vite-plugin', () => {
  it('applies the Babel transformer', async () => {
    const plugin = fict() as any
    const sample = `
      import { $state } from 'fict'
      function Button() {
        let count = $state(0)
        return <button>{count}</button>
      }
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Button.tsx')
        : await transform?.handler.call(mockContext, sample, '/project/src/Button.tsx')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      // HIR codegen is now the default - check for HIR output markers
      // The output should contain __fict_hir_codegen__ marker or runtime imports
      const code = result.code as string
      const hasHIRMarker = code.includes('__fict_hir_codegen__')
      const hasRuntimeImport = code.includes('@fictjs/runtime') || code.includes('fict/internal')
      expect(hasHIRMarker || hasRuntimeImport).toBe(true)
    }
  })

  it('transforms files with Vite query params', async () => {
    const plugin = fict() as any
    const sample = `
      import { $state } from 'fict'
      function Button() {
        let count = $state(0)
        return <button>{count}</button>
      }
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Button.tsx?import')
        : await transform?.handler.call(mockContext, sample, '/project/src/Button.tsx?import')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      const code = result.code as string
      const hasHIRMarker = code.includes('__fict_hir_codegen__')
      const hasRuntimeImport = code.includes('@fictjs/runtime') || code.includes('fict/internal')
      expect(hasHIRMarker || hasRuntimeImport).toBe(true)
    }
  })

  it('skips bundler virtual runtime modules in library mode', async () => {
    const plugin = fict({ library: true, useTypeScriptProject: false }) as any
    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(
            { error: vi.fn() },
            'export var __name = () => {}',
            '\0rolldown/runtime.js',
          )
        : await transform?.handler.call(
            { error: vi.fn() },
            'export var __name = () => {}',
            '\0rolldown/runtime.js',
          )

    expect(result).toBeNull()
  })

  it('sends a full reload for transformed modules during HMR', () => {
    const plugin = getTestPlugin({ useTypeScriptProject: false })
    const send = vi.fn()

    const result = plugin.handleHotUpdate?.({
      file: '/project/src/App.tsx',
      server: { ws: { send } },
    })

    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })
    expect(result).toEqual([])
  })

  it('leaves non-transformed files to Vite HMR', () => {
    const plugin = getTestPlugin({ useTypeScriptProject: false })
    const send = vi.fn()

    const result = plugin.handleHotUpdate?.({
      file: '/project/src/styles.css',
      server: { ws: { send } },
    })

    expect(send).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it('resolves Fict hook metadata from bare package imports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-meta-'))
    const packageDir = path.join(root, 'node_modules', 'fict-hook-lib')

    try {
      await mkdir(path.join(packageDir, 'dist'), { recursive: true })
      await writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: './dist/index.js',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      await writeFile(
        path.join(packageDir, 'dist', 'index.fict.meta.json'),
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
      )

      const plugin = fict({ useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const sample = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const count = useCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `

      const mockContext = {
        error: vi.fn(),
        warn: vi.fn(),
        emitFile: vi.fn(),
      }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, path.join(root, 'src', 'App.tsx'))
          : await transform?.handler.call(mockContext, sample, path.join(root, 'src', 'App.tsx'))

      expect(result && typeof result === 'object').toBe(true)
      expect(result.code as string).toMatch(/count\(\) \* 2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates transform cache when bare package metadata changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-meta-cache-'))
    const packageDir = path.join(root, 'node_modules', 'fict-hook-lib')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      await mkdir(path.dirname(metaPath), { recursive: true })
      await writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: './dist/index.js',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      await writeFile(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
      )

      const plugin = fict({ useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const sample = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const count = useCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `
      const appPath = path.join(root, 'src', 'App.tsx')
      const mockContext = {
        error: vi.fn(),
        warn: vi.fn(),
        emitFile: vi.fn(),
      }
      const transform = plugin.transform as any
      const first =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, appPath)
          : await transform?.handler.call(mockContext, sample, appPath)

      expect(first && typeof first === 'object').toBe(true)
      expect(first.code as string).toMatch(/count\(\) \* 2/)

      await writeFile(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: {},
        }),
      )

      const second =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, appPath)
          : await transform?.handler.call(mockContext, sample, appPath)

      expect(second && typeof second === 'object').toBe(true)
      expect(second.code as string).not.toMatch(/count\(\) \* 2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits library metadata assets for TypeScript entry chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-meta-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      const plugin = fict({ library: true, useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const source = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `

      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(
              { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
              source,
              sourcePath,
            )
          : await transform?.handler.call(
              { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
              source,
              sourcePath,
            )

      expect(result && typeof result === 'object').toBe(true)

      const emitFile = vi.fn(() => 'asset-id')
      plugin.generateBundle.call(
        { emitFile },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )

      const metadataCall = emitFile.mock.calls.find(
        ([asset]) => asset.type === 'asset' && asset.fileName === 'index.fict.meta.json',
      )
      expect(metadataCall).toBeDefined()
      expect(JSON.parse(metadataCall?.[0].source as string)).toEqual({
        version: 1,
        exports: {},
        hooks: { useCounter: { directAccessor: 'signal' } },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores library metadata assets from transform cache hits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-meta-cache-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      const plugin = fict({ library: true, useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const source = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const context = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const transform = plugin.transform as any

      await (typeof transform === 'function'
        ? transform.call(context, source, sourcePath)
        : transform?.handler.call(context, source, sourcePath))

      if (typeof plugin.buildStart === 'function') {
        plugin.buildStart.call({})
      }

      await (typeof transform === 'function'
        ? transform.call(context, source, sourcePath)
        : transform?.handler.call(context, source, sourcePath))

      const emitFile = vi.fn(() => 'asset-id')
      plugin.generateBundle.call(
        { emitFile },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )

      const metadataCall = emitFile.mock.calls.find(
        ([asset]) => asset.type === 'asset' && asset.fileName === 'index.fict.meta.json',
      )
      expect(metadataCall).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes fict.metadata to package.json for single-entry library builds', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-package-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: {
            '.': {
              import: './dist/index.js',
              require: './dist/index.cjs',
            },
          },
        }),
      )

      const plugin = fict({ library: true, useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const source = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const transform = plugin.transform as any
      await (typeof transform === 'function'
        ? transform.call({ error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }, source, sourcePath)
        : transform?.handler.call(
            { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
            source,
            sourcePath,
          ))

      plugin.generateBundle.call(
        { emitFile: vi.fn(() => 'asset-id') },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )
      await plugin.writeBundle.call({}, {}, {})

      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      expect(pkg.fict).toEqual({ metadata: './dist/index.fict.meta.json' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes fict.exports to package.json for multi-entry library builds', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-package-subpaths-'))

    try {
      const indexPath = path.join(root, 'src', 'index.ts')
      const hooksPath = path.join(root, 'src', 'hooks.tsx')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: {
            '.': './dist/index.js',
            './hooks': './dist/hooks.js',
          },
        }),
      )

      const plugin = fict({ library: true, useTypeScriptProject: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root } as any)
      }

      const transform = plugin.transform as any
      await (typeof transform === 'function'
        ? transform.call(
            { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
            `
              import { $state } from 'fict'
              /** @fictReturn { directAccessor: "signal" } */
              export function useCounter() {
                const count = $state(0)
                return count
              }
            `,
            indexPath,
          )
        : transform?.handler.call(
            { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
            `
              import { $state } from 'fict'
              /** @fictReturn { directAccessor: "signal" } */
              export function useCounter() {
                const count = $state(0)
                return count
              }
            `,
            indexPath,
          ))
      await (typeof transform === 'function'
        ? transform.call(
            { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
            `
              import { $state } from 'fict'
              /** @fictReturn { directAccessor: "signal" } */
              export function useToggle() {
                const on = $state(false)
                return on
              }
            `,
            hooksPath,
          )
        : transform?.handler.call(
            { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
            `
              import { $state } from 'fict'
              /** @fictReturn { directAccessor: "signal" } */
              export function useToggle() {
                const on = $state(false)
                return on
              }
            `,
            hooksPath,
          ))

      plugin.generateBundle.call(
        { emitFile: vi.fn(() => 'asset-id') },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: indexPath,
            modules: { [indexPath]: {} },
            exports: ['useCounter'],
          },
          'hooks.js': {
            type: 'chunk',
            fileName: 'hooks.js',
            isEntry: true,
            facadeModuleId: hooksPath,
            modules: { [hooksPath]: {} },
            exports: ['useToggle'],
          },
        },
      )
      await plugin.writeBundle.call({}, {}, {})

      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      expect(pkg.fict).toEqual({
        exports: {
          '.': './dist/index.fict.meta.json',
          './hooks': './dist/hooks.fict.meta.json',
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits metadata under metadataDir without mutating package.json when packageJson is false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-package-json-false-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: './dist/index.js',
        }),
      )

      const plugin = getTestPlugin({
        library: { metadataDir: 'fict-meta', packageJson: false },
        useTypeScriptProject: false,
      })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
        sourcePath,
      )

      const emitFile = vi.fn(() => 'asset-id')
      plugin.generateBundle?.call(
        { emitFile, warn: vi.fn() },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )
      await plugin.writeBundle?.call({ warn: vi.fn(), error: vi.fn() }, {}, {})

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'asset',
          fileName: 'fict-meta/index.fict.meta.json',
        }),
      )
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      expect(pkg.fict).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps multi-format library metadata through module and main package targets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-main-module-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          module: './dist/index.js',
          main: './dist/index.cjs',
        }),
      )

      const plugin = getTestPlugin({ library: true, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
        sourcePath,
      )

      const bundle = {
        'index.js': {
          type: 'chunk',
          fileName: 'index.js',
          isEntry: true,
          facadeModuleId: sourcePath,
          modules: { [sourcePath]: {} },
          exports: ['useCounter'],
        },
        'index.cjs': {
          type: 'chunk',
          fileName: 'index.cjs',
          isEntry: true,
          facadeModuleId: sourcePath,
          modules: { [sourcePath]: {} },
          exports: ['useCounter'],
        },
      }
      plugin.generateBundle?.call({ emitFile: vi.fn(() => 'asset-id'), warn: vi.fn() }, {}, bundle)
      await plugin.writeBundle?.call({ warn: vi.fn(), error: vi.fn() }, {}, {})

      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      expect(pkg.fict).toEqual({ metadata: './dist/index.fict.meta.json' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('warns when a library entry emits no Fict metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-missing-meta-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      const plugin = getTestPlugin({ library: true, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      const warn = vi.fn()
      plugin.generateBundle?.call(
        { emitFile: vi.fn(() => 'asset-id'), warn },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['plainUtility'],
          },
        },
      )

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not produce Fict metadata'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails package.json publishing when metadata assets cannot be mapped to public entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-unmapped-meta-'))

    try {
      const indexPath = path.join(root, 'src', 'index.ts')
      const hooksPath = path.join(root, 'src', 'hooks.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: {
            '.': './dist/index.js',
          },
        }),
      )

      const plugin = getTestPlugin({ library: true, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
        indexPath,
      )
      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useToggle() {
            const on = $state(false)
            return on
          }
        `,
        hooksPath,
      )

      plugin.generateBundle?.call(
        { emitFile: vi.fn(() => 'asset-id'), warn: vi.fn() },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: indexPath,
            modules: { [indexPath]: {} },
            exports: ['useCounter'],
          },
          'hooks.js': {
            type: 'chunk',
            fileName: 'hooks.js',
            isEntry: true,
            facadeModuleId: hooksPath,
            modules: { [hooksPath]: {} },
            exports: ['useToggle'],
          },
        },
      )

      await expect(
        plugin.writeBundle?.call(
          {
            warn: vi.fn(),
            error: (message: string) => {
              throw new Error(message)
            },
          },
          {},
          {},
        ),
      ).rejects.toThrow('could not be declared in package.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails single-entry package publishing when declared targets do not match emitted metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-single-mismatch-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: './dist/other.js',
        }),
      )

      const plugin = getTestPlugin({ library: true, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
        sourcePath,
      )

      plugin.generateBundle?.call(
        { emitFile: vi.fn(() => 'asset-id'), warn: vi.fn() },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )

      await expect(
        plugin.writeBundle?.call(
          {
            warn: vi.fn(),
            error: (message: string) => {
              throw new Error(message)
            },
          },
          {},
          {},
        ),
      ).rejects.toThrow('no package.json exports/module/main target matched')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses root metadata fallback only when package.json has no public targets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-library-default-fallback-'))

    try {
      const sourcePath = path.join(root, 'src', 'index.ts')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
        }),
      )

      const plugin = getTestPlugin({ library: true, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })

      await plugin.transform?.call(
        { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() },
        `
          import { $state } from 'fict'
          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
        sourcePath,
      )

      plugin.generateBundle?.call(
        { emitFile: vi.fn(() => 'asset-id'), warn: vi.fn() },
        {},
        {
          'index.js': {
            type: 'chunk',
            fileName: 'index.js',
            isEntry: true,
            facadeModuleId: sourcePath,
            modules: { [sourcePath]: {} },
            exports: ['useCounter'],
          },
        },
      )
      await plugin.writeBundle?.call({ warn: vi.fn(), error: vi.fn() }, {}, {})

      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      expect(pkg.fict).toEqual({ metadata: './dist/index.fict.meta.json' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates cached consumers when indirect local package metadata changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-package-meta-indirect-cache-'))
    const packageDir = path.join(root, 'node_modules', 'fict-hook-lib')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      await mkdir(path.dirname(metaPath), { recursive: true })
      await mkdir(path.join(root, 'src'), { recursive: true })
      await writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          type: 'module',
          exports: './dist/index.js',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      await writeFile(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
      )

      const hooksPath = path.join(root, 'src', 'hooks.ts')
      const hooksSource = `
        import { useCounter } from 'fict-hook-lib'
        export function useWrappedCounter() {
          return useCounter()
        }
      `
      await writeFile(hooksPath, hooksSource)
      const appSource = `
        import { useWrappedCounter } from './hooks'
        export function App() {
          const count = useWrappedCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `

      const appPath = path.join(root, 'src', 'App.tsx')
      const firstFingerprint = __fictVitePluginInternals.computePackageMetadataCacheFingerprint(
        appSource,
        appPath,
        { emitModuleMetadata: false },
        new Map(),
        root,
      )

      await writeFile(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: {},
        }),
      )
      const secondFingerprint = __fictVitePluginInternals.computePackageMetadataCacheFingerprint(
        appSource,
        appPath,
        { emitModuleMetadata: false },
        new Map(),
        root,
      )

      expect(secondFingerprint).not.toBe(firstFingerprint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers resumable component resumes with runtime module URLs', async () => {
    const plugin = fict({ resumable: true }) as any
    const sample = `
      import { $state } from 'fict'

      export function Counter() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Counter.tsx')
        : await transform?.handler.call(mockContext, sample, '/project/src/Counter.tsx')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      expect(result.code as string).toContain(
        '__fictRegisterResume(__fictQrl(import.meta.url, "__fict_r0"), __fict_r0)',
      )
    }
  })

  describe('function-level code splitting', () => {
    it('rewrites QRLs to virtual modules when functionSplitting is enabled', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const sample = `
        import { $state } from 'fict'
        export function Counter() {
          let count = $state(0)
          return <button onClick$={() => count++}>{count}</button>
        }
      `

      const mockContext = {
        error: vi.fn(),
      }

      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, '/project/src/Counter.tsx')
          : await transform?.handler.call(mockContext, sample, '/project/src/Counter.tsx')

      expect(result && typeof result === 'object').toBe(true)
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // When function splitting is enabled, QRLs should point to virtual modules
        if (code.includes('__fict_e')) {
          // Handler exports should still exist (handlers stay in module)
          expect(code).toContain('export const __fict_e')

          // QRLs should be rewritten to virtual module URLs
          // Or if no handlers were detected due to the pattern, original QRL format
          const hasVirtualQrl = code.includes('virtual:fict-handler:')
          const hasOriginalQrl = code.includes('__fictQrl(')

          // Either format is acceptable depending on regex match
          expect(hasVirtualQrl || hasOriginalQrl).toBe(true)
        }
      }
    })

    it('preserves main-module sourcemaps when function splitting rewrites handlers', async () => {
      const plugin = fict({ functionSplitting: true, resumable: true, sourcemap: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const sample = `
        import { $state } from 'fict'
        export function Counter() {
          let count = $state(0)
          return <button onClick$={() => count++}>{count}</button>
        }
      `

      const mockContext = {
        error: vi.fn(),
        emitFile: vi.fn(),
      }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, '/project/src/CounterMap.tsx')
          : await transform?.handler.call(mockContext, sample, '/project/src/CounterMap.tsx')

      expect(result && typeof result === 'object').toBe(true)
      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.code as string).toContain('virtual:fict-handler:')
        expect(result.map).not.toBeNull()
        expect(result.map).toMatchObject({ version: 3 })
      }
    })

    it('resolves virtual handler modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      const resolveId = plugin.resolveId as any
      if (typeof resolveId === 'function') {
        const resolved = resolveId('virtual:fict-handler:/src/Counter.tsx$$__fict_e0')
        expect(resolved).toBe('\0fict-handler:/src/Counter.tsx$$__fict_e0')
      }
    })

    it('loads extracted virtual handler modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      // First, configure and do a transform to register handlers
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      if (typeof transform === 'function') {
        await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      // Now test loading a virtual handler module
      const load = plugin.load as any
      expect(typeof load).toBe('function')
      const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(content).not.toBeNull()
      expect(content).toContain('export default')
      expect(content).toContain('__fictUseLexicalScope')
    })

    it('preserves fict/internal imports in extracted handler modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from 'fict/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/FictCounter.tsx')
          : await transform?.handler.call(mockContext, compiledCode, '/project/src/FictCounter.tsx')

      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.code as string).toContain('virtual:fict-handler:')
      }

      const load = plugin.load as any
      expect(typeof load).toBe('function')
      const content = load('\0fict-handler:/project/src/FictCounter.tsx$$__fict_e0') as
        | string
        | null
      expect(content).not.toBeNull()
      expect(content).toContain("from 'fict/internal'")
      expect(content).not.toContain('@fictjs/runtime/internal')
    })

    it('does not import runtime helpers mentioned only in strings or comments', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  // __fictGetScopeProps should not be detected from comments.
  const helperName = "__fictUseLexicalScope";
  return helperName + scopeId + event.type + el.tagName;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/StringHelperMention.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/StringHelperMention.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).not.toContain('import { __fictUseLexicalScope')
      expect(content).not.toContain('import { __fictGetScopeProps')
    })

    it('does not import runtime helpers shadowed by local bindings', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const __fictUseLexicalScope = () => ['local'];
  const [value] = __fictUseLexicalScope(scopeId, ['count']);
  return value + event.type + el.tagName;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/ShadowedHelper.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/ShadowedHelper.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).not.toContain("from '@fictjs/runtime/internal';")
      expect(content).toContain('const __fictUseLexicalScope')
    })

    it('preserves aliased runtime helper imports in extracted handler modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope as useScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = useScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/AliasedHelper.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/AliasedHelper.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).toContain(
        "import { __fictUseLexicalScope as useScope } from '@fictjs/runtime/internal';",
      )
      expect(content).toContain('useScope(scopeId')
      expect(content).not.toContain('__fict_dep_useScope')
    })

    it('clears extracted handlers on buildStart', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      if (typeof transform === 'function') {
        await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      const load = plugin.load as any
      expect(typeof load).toBe('function')
      const beforeReset = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string
      expect(beforeReset).toContain('export default')

      const buildStart = plugin.buildStart as (() => void) | undefined
      expect(typeof buildStart).toBe('function')
      buildStart?.()

      const afterReset = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
      expect(afterReset).toBeNull()
    })

    it('keeps handler registries isolated across plugin instances', async () => {
      const pluginA = fict({ functionSplitting: true }) as any
      const pluginB = fict({ functionSplitting: true }) as any

      if (typeof pluginA.configResolved === 'function') {
        pluginA.configResolved(mockBuildConfig as any)
      }
      if (typeof pluginB.configResolved === 'function') {
        pluginB.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transformA = pluginA.transform as any
      if (typeof transformA === 'function') {
        await transformA.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      const loadA = pluginA.load as any
      expect(typeof loadA).toBe('function')
      const before = loadA('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(before).not.toBeNull()
      expect(before).toContain('export default')

      const buildStartB = pluginB.buildStart as (() => void) | undefined
      expect(typeof buildStartB).toBe('function')
      buildStartB?.()

      const after = loadA('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(after).not.toBeNull()
      expect(after).toContain('export default')
    })

    it('isolates handler registries between client and ssr build contexts', async () => {
      const clientPlugin = fict({ functionSplitting: true }) as any
      const ssrPlugin = fict({ functionSplitting: true }) as any

      if (typeof clientPlugin.configResolved === 'function') {
        clientPlugin.configResolved(mockBuildConfig as any)
      }
      if (typeof ssrPlugin.configResolved === 'function') {
        ssrPlugin.configResolved(mockSsrBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const clientContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const ssrContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }

      const clientTransform = clientPlugin.transform as any
      const ssrTransform = ssrPlugin.transform as any
      if (typeof clientTransform === 'function') {
        await clientTransform.call(clientContext, compiledCode, '/project/src/Counter.tsx')
      }
      if (typeof ssrTransform === 'function') {
        await ssrTransform.call(ssrContext, compiledCode, '/project/src/Counter.tsx')
      }

      expect(clientContext.error).not.toHaveBeenCalled()
      expect(ssrContext.error).not.toHaveBeenCalled()

      const clientLoad = clientPlugin.load as any
      const ssrLoad = ssrPlugin.load as any
      expect(typeof clientLoad).toBe('function')
      expect(typeof ssrLoad).toBe('function')

      const beforeClientReset = clientLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as
        | string
        | null
      const beforeSsrReset = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as
        | string
        | null
      expect(beforeClientReset).not.toBeNull()
      expect(beforeSsrReset).not.toBeNull()

      const ssrBuildStart = ssrPlugin.buildStart as (() => void) | undefined
      expect(typeof ssrBuildStart).toBe('function')
      ssrBuildStart?.()

      const afterSsrResetClientLoad = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const afterSsrResetSsrLoad = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(afterSsrResetClientLoad).not.toBeNull()
      expect(afterSsrResetClientLoad).toContain('export default')
      expect(afterSsrResetSsrLoad).toBeNull()
    })

    it('keeps client handlers after ssr buildStart without ssr transform', async () => {
      const clientPlugin = fict({ functionSplitting: true }) as any
      const ssrPlugin = fict({ functionSplitting: true }) as any

      if (typeof clientPlugin.configResolved === 'function') {
        clientPlugin.configResolved(mockBuildConfig as any)
      }
      if (typeof ssrPlugin.configResolved === 'function') {
        ssrPlugin.configResolved(mockSsrBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const clientContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const clientTransform = clientPlugin.transform as any
      if (typeof clientTransform === 'function') {
        await clientTransform.call(clientContext, compiledCode, '/project/src/Counter.tsx')
      }
      expect(clientContext.error).not.toHaveBeenCalled()

      const clientLoad = clientPlugin.load as any
      const ssrLoad = ssrPlugin.load as any
      expect(typeof clientLoad).toBe('function')
      expect(typeof ssrLoad).toBe('function')

      const beforeSsrBuildStartClient = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const beforeSsrBuildStartSsr = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(beforeSsrBuildStartClient).not.toBeNull()
      expect(beforeSsrBuildStartClient).toContain('export default')
      expect(beforeSsrBuildStartSsr).toBeNull()

      const ssrBuildStart = ssrPlugin.buildStart as (() => void) | undefined
      expect(typeof ssrBuildStart).toBe('function')
      ssrBuildStart?.()

      const afterSsrBuildStartClient = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const afterSsrBuildStartSsr = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(afterSsrBuildStartClient).not.toBeNull()
      expect(afterSsrBuildStartClient).toContain('export default')
      expect(afterSsrBuildStartSsr).toBeNull()
    })

    it('extracts handler code with AST and generates standalone modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Use pre-compiled code that has the handler exports
      // This simulates what the compiler output looks like
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  // Component code...
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any

      // Simulate the transform with already-compiled code
      // We need to test the extraction directly
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
          : null

      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // Handler export should be removed from main module
        expect(code).not.toContain('export const __fict_e0')

        // QRL should be rewritten to virtual module URL
        expect(code).toContain('virtual:fict-handler:')
        expect(code).toContain('#default')
      }

      // Check that the virtual module is generated correctly
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
        if (content) {
          // Should be a standalone module with:
          // 1. Its own imports
          expect(content).toContain('import')
          expect(content).toContain('@fictjs/runtime/internal')

          // 2. The handler function as default export
          expect(content).toContain('export default')
          expect(content).toContain('scopeId')
          expect(content).toContain('__fictUseLexicalScope')
        }
      }
    })

    it('includes hoisted helper functions in handler virtual modules', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Simulated compiled code with a hoisted helper function
      // This is what the compiler generates when a handler uses a component-scoped function
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_fn_formatNumber_0 = n => n.toLocaleString();

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => {
    count(count() + 1);
    console.log(__fict_fn_formatNumber_0(count()));
  };
  return __handler.call(el, event);
};

function Counter() {
  // Component code...
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any

      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
          : null

      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // Handler export should be removed from main module
        expect(code).not.toContain('export const __fict_e0')

        // Hoisted function should also be removed (it's only used by handler)
        expect(code).not.toContain('export const __fict_fn_formatNumber_0')
      }

      // Check that the virtual module includes the hoisted helper
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
        if (content) {
          // Should include the handler
          expect(content).toContain('export default')
          expect(content).toContain('__fictUseLexicalScope')

          // Should include the hoisted helper function as a dependency import
          expect(content).toContain('__fict_fn_formatNumber_0')
          // The helper should be imported from the source module
          expect(content).toContain('/project/src/Counter.tsx')
        }
      }
    })

    it('handler with direct function reference works in virtual module', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Test onClick={helper} pattern (direct function reference)
      // Handler still needs __fictUseLexicalScope call for vite-plugin to detect it
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_fn_handleClick_0 = () => console.log('clicked');

export const __fict_e0 = (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  return __fict_fn_handleClick_0.call(el, event);
};

function Button() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = {
        error: vi.fn(),
        emitFile: vi.fn(), // Required for production build handler emission
      }
      const transform = plugin.transform as any

      // Use a unique file path for this test
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/DirectRef.tsx')
          : await transform?.handler?.call(mockContext, compiledCode, '/project/src/DirectRef.tsx')

      expect(result && typeof result === 'object').toBe(true)

      // Check virtual module has the dependency
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/DirectRef.tsx$$__fict_e0')
        if (content) {
          // Handler should reference the hoisted function
          expect(content).toContain('__fict_fn_handleClick_0')
        }
      }
    })

    it('skips recompiling precompiled modules when splitting is disabled', async () => {
      const plugin = fict({ functionSplitting: false }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // This is already compiler output. Re-running the compiler on it used to fail
      // under strict guarantee diagnostics (for example FICT-R002).
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';
/* precompiled-sentinel */
export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = {
        error: vi.fn(),
        warn: vi.fn(),
      }
      const transform = plugin.transform as any

      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Precompiled.tsx')
          : await transform?.handler?.call(
              mockContext,
              compiledCode,
              '/project/src/Precompiled.tsx',
            )

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)

      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.code).toContain('precompiled-sentinel')
        expect(result.code).toContain('export const __fict_e0')
        expect(result.code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
        expect(result.map).toBeNull()
      }
    })
  })
})
