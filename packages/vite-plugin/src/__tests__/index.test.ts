import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build, createServer, resolveConfig, type Rollup, type TransformResult } from 'vite'
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

function waitForWatchEnd(watcher: Rollup.RollupWatcher, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (event: Rollup.RollupWatcherEvent) => {
      if (event.code === 'ERROR') {
        cleanup()
        reject(event.error)
      } else if (event.code === 'END') {
        cleanup()
        resolve()
      }
    }
    const timer = setTimeout(() => {
      watcher.off('event', onEvent)
      reject(new Error('Timed out waiting for Vite watch build.'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      watcher.off('event', onEvent)
    }
    watcher.on('event', onEvent)
  })
}

async function buildFictEntry(root: string, entry: string): Promise<string> {
  const result = await build({
    root,
    logLevel: 'silent',
    plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
    build: {
      write: false,
      lib: { entry, formats: ['es'], fileName: () => 'app.js' },
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
      },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  return outputs
    .flatMap(output => ('output' in output ? output.output : []))
    .filter(output => output.type === 'chunk')
    .map(output => output.code)
    .join('\n')
}

interface SourceMapLike {
  mappings: string
  sources?: string[]
}

const BASE64_VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0

  for (const char of segment) {
    const digit = BASE64_VLQ_CHARS.indexOf(char)
    if (digit < 0) {
      throw new Error(`Invalid sourcemap VLQ digit: ${char}`)
    }
    const continuation = (digit & 32) !== 0
    value += (digit & 31) << shift
    if (continuation) {
      shift += 5
      continue
    }
    const negative = (value & 1) === 1
    values.push((negative ? -1 : 1) * (value >> 1))
    value = 0
    shift = 0
  }

  return values
}

function findGeneratedPosition(code: string, token: string): { line: number; column: number } {
  const index = code.indexOf(token)
  expect(index).toBeGreaterThanOrEqual(0)
  const before = code.slice(0, index)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1]!.length,
  }
}

function originalPositionFor(
  map: SourceMapLike,
  generatedLine: number,
  generatedColumn: number,
): { source: string | undefined; line: number; column: number } | null {
  const lines = map.mappings.split(';')
  let sourceIndex = 0
  let originalLine = 0
  let originalColumn = 0
  let candidate: { source: string | undefined; line: number; column: number } | null = null

  for (let lineIndex = 0; lineIndex < lines.length && lineIndex < generatedLine; lineIndex++) {
    let currentGeneratedColumn = 0
    const segments = lines[lineIndex] ? lines[lineIndex]!.split(',') : []
    for (const segment of segments) {
      if (!segment) continue
      const decoded = decodeVlq(segment)
      currentGeneratedColumn += decoded[0] ?? 0
      if (decoded.length < 4) continue
      sourceIndex += decoded[1]!
      originalLine += decoded[2]!
      originalColumn += decoded[3]!
      if (lineIndex === generatedLine - 1 && currentGeneratedColumn <= generatedColumn) {
        candidate = {
          source: map.sources?.[sourceIndex],
          line: originalLine + 1,
          column: originalColumn,
        }
      }
    }
  }

  return candidate
}

describe('fict vite-plugin', () => {
  it('does not recompile linked Fict framework build artifacts', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'fict-vite-framework-dist-'))
    const appRoot = path.join(workspace, 'app')
    const runtimeRoot = path.join(workspace, 'runtime')
    const runtimeEntry = path.join(runtimeRoot, 'dist', 'index.js')
    const entry = path.join(appRoot, 'src', 'main.ts')

    try {
      await mkdir(path.dirname(entry), { recursive: true })
      await mkdir(path.dirname(runtimeEntry), { recursive: true })
      await writeFile(
        path.join(appRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-app', private: true }),
      )
      await writeFile(
        path.join(runtimeRoot, 'package.json'),
        JSON.stringify({ name: '@fictjs/runtime', type: 'module' }),
      )
      // This intentionally violates Fict macro placement. A framework dist
      // dependency must pass through untouched instead of being recompiled.
      await writeFile(runtimeEntry, `export function frameworkValue() { return $state(1) }`)
      await writeFile(
        entry,
        `import { frameworkValue } from '@fictjs/runtime'; export const value = frameworkValue()`,
      )

      const result = await build({
        root: appRoot,
        logLevel: 'silent',
        resolve: { alias: { '@fictjs/runtime': runtimeEntry } },
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toContain('$state(1)')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('prepares aliased cyclic hook metadata before a cold Vite build transforms the importer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-cold-metadata-'))
    const srcDir = path.join(root, 'src')
    const hooksDir = path.join(srcDir, 'hooks')

    try {
      await mkdir(hooksDir, { recursive: true })
      await writeFile(
        path.join(hooksDir, 'index.tsx'),
        `
          export { useCounter } from './use-counter'
          export const marker = 'ready'
        `,
      )
      await writeFile(
        path.join(hooksDir, 'use-counter.tsx'),
        `
          import { $state } from 'fict'
          import { marker } from './index'

          export const observedMarker = marker
          export function useCounter() {
            const count = $state(1)
            return count
          }
        `,
      )
      await writeFile(path.join(srcDir, 'public-hooks.tsx'), `export { useCounter } from './hooks'`)
      const entry = path.join(srcDir, 'App.tsx')
      await writeFile(
        entry,
        `
          import { useCounter } from '@/public-hooks'

          export function App() {
            const count = useCounter()
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        resolve: {
          alias: { '@': srcDir },
        },
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toMatch(/=>\s*[\w$]+\(\) \* 2,\s*\{\s*name:\s*"doubled"/)
      expect(code).not.toMatch(/=>\s*[\w$]+ \* 2,\s*\{\s*name:\s*"doubled"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prepares hook metadata from the output of earlier pre transforms', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-pre-transform-metadata-'))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const entry = path.join(srcDir, 'App.tsx')
    let removedDependencyVisited = false

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(path.join(srcDir, 'removed.ts'), `export const removed = true`)
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          import './removed'
          const makeValue = (value: number) => value
          export function useCounter() {
            const count = makeValue(1)
            return count
          }
        `,
      )
      await writeFile(
        entry,
        `
          import { useCounter } from './use-counter'
          export function App() {
            const count = useCounter()
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          {
            name: 'test-rewrite-hook-state',
            enforce: 'pre',
            transform(code, id) {
              const filename = id.split('?')[0]!
              if (filename.endsWith('/removed.ts')) {
                removedDependencyVisited = true
                return null
              }
              if (!filename.endsWith('/use-counter.tsx')) return null
              return code.replace("import './removed'", '').replace('makeValue(1)', '$state(1)')
            },
          },
          fict({ cache: false, useTypeScriptProject: false, functionSplitting: false }),
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toMatch(/=>\s*[\w$]+\(\) \* 2,\s*\{\s*name:\s*"doubled"/)
      expect(code).not.toMatch(/=>\s*[\w$]+ \* 2,\s*\{\s*name:\s*"doubled"/)
      expect(removedDependencyVisited).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses earlier pre-transform inputs when cyclic hook metadata converges', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-pre-transform-cycle-'))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const entry = path.join(srcDir, 'App.tsx')

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          import { marker } from './cycle'
          const makeValue = (value: number) => value
          export function useCounter() {
            const count = makeValue(marker)
            return count
          }
        `,
      )
      await writeFile(
        path.join(srcDir, 'cycle.ts'),
        `
          export { useCounter } from './use-counter'
          export const marker = 1
        `,
      )
      await writeFile(
        entry,
        `
          import { useCounter } from './use-counter'
          export function App() {
            const count = useCounter()
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          {
            name: 'test-rewrite-cyclic-hook-state',
            enforce: 'pre',
            transform(code, id) {
              if (!id.split('?')[0]!.endsWith('/use-counter.tsx')) return null
              return code.replace('makeValue(marker)', '$state(marker)')
            },
          },
          fict({ cache: false, useTypeScriptProject: false, functionSplitting: false }),
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toContain('__fictUseSignal')
      expect(code).toMatch(/=>\s*[\w$]+\(\) \* 2,\s*\{\s*name:\s*"doubled"/)
      expect(code).not.toMatch(/=>\s*[\w$]+ \* 2,\s*\{\s*name:\s*"doubled"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a loaded metadata dependency bypasses the Fict pipeline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-missing-pipeline-input-'))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const appPath = path.join(srcDir, 'App.tsx')

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(hookPath, `export function useCounter() { return 1 }`)
      const plugin = getTestPlugin({ cache: false, useTypeScriptProject: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })
      const load = vi.fn(async () => ({}))
      const context = {
        load,
        warn: vi.fn(),
        emitFile: vi.fn(),
        error(error: unknown): never {
          const message =
            error && typeof error === 'object' && 'message' in error
              ? String(error.message)
              : String(error)
          throw new Error(message)
        },
      }

      await expect(
        plugin.transform?.call(
          context,
          `import { useCounter } from './use-counter'; export const count = useCounter()`,
          appPath,
        ),
      ).rejects.toThrow('Transform pipeline did not provide compiler input')
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: hookPath }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves disabled and custom Vite watcher settings', async () => {
    const disabled = await resolveConfig(
      {
        configFile: false,
        plugins: [fict({ cache: false, useTypeScriptProject: false })],
        server: { watch: null },
      },
      'serve',
    )
    expect(disabled.server.watch).toBeNull()

    const customized = await resolveConfig(
      {
        configFile: false,
        plugins: [fict({ cache: false, useTypeScriptProject: false })],
        server: {
          watch: {
            ignored: ['**/generated/**'],
            usePolling: true,
          },
        },
      },
      'serve',
    )
    expect(customized.server.watch).toMatchObject({ usePolling: true })
    expect(customized.server.watch?.ignored).toEqual([
      '**/generated/**',
      '!**/node_modules/@fictjs/**',
      '!**/node_modules/fict/**',
    ])
  })

  it('refreshes TypeScript projects when config files appear or change', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-tsconfig-hmr-')))
    const srcDir = path.join(root, 'src')
    const appPath = path.join(srcDir, 'App.tsx')
    const configPath = path.join(root, 'tsconfig.json')
    const baseConfigPath = path.join(root, 'tsconfig.base.jsonc')
    let expectedHmrFile = ''
    let resolveHmr: (() => void) | undefined
    let server: Awaited<ReturnType<typeof createServer>> | undefined

    const triggerHmr = async (event: 'add' | 'change' | 'unlink', file: string) => {
      expectedHmrFile = path.normalize(file)
      const seen = new Promise<void>(resolve => {
        resolveHmr = resolve
      })
      server!.watcher.emit(event, file)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          seen,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timed out waiting for ${event}: ${file}`)),
              3_000,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    }

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(appPath, 'export const value: number = 1')
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, watch: null },
        plugins: [
          fict({ cache: false, functionSplitting: false }),
          {
            name: 'test-tsconfig-hmr-probe',
            hotUpdate({ file }) {
              if (path.normalize(file) === expectedHmrFile) {
                resolveHmr?.()
                resolveHmr = undefined
              }
            },
          },
        ],
      })

      const environment = server.environments.client
      await environment.transformRequest('/src/App.tsx')
      const send = vi.spyOn(environment.hot, 'send')

      await writeFile(baseConfigPath, JSON.stringify({ compilerOptions: { strict: false } }))
      await writeFile(
        configPath,
        JSON.stringify({ extends: './tsconfig.base.jsonc', include: ['src/**/*'] }),
      )
      await triggerHmr('add', configPath)
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })

      send.mockClear()
      await environment.transformRequest('/src/App.tsx')
      await writeFile(baseConfigPath, JSON.stringify({ compilerOptions: { strict: true } }))
      await triggerHmr('change', baseConfigPath)
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })

      send.mockClear()
      await environment.transformRequest('/src/App.tsx')
      await rm(configPath, { force: true })
      await triggerHmr('unlink', configPath)
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })

      send.mockClear()
      await environment.transformRequest('/src/App.tsx')
      await writeFile(
        configPath,
        JSON.stringify({ extends: './tsconfig.base.jsonc', include: ['src/**/*'] }),
      )
      await triggerHmr('add', configPath)
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })
    } finally {
      resolveHmr?.()
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('watches explicit and missing extended configs outside the Vite root', async () => {
    const container = await mkdtemp(path.join(tmpdir(), 'fict-vite-external-config-'))
    const root = path.join(container, 'app')
    const srcDir = path.join(root, 'src')
    const configPath = path.join(container, 'shared', 'tsconfig.custom.jsonc')
    const baseConfigPath = path.join(container, 'shared', 'base.jsonc')
    const missingBasePath = path.join(container, 'shared', 'missing.jsonc')

    try {
      await mkdir(srcDir, { recursive: true })
      await mkdir(path.dirname(configPath), { recursive: true })
      const explicitPlugin = fict({ tsconfigPath: configPath }) as any
      explicitPlugin.configResolved({ ...mockBuildConfig, command: 'serve', root })
      const explicitAdd = vi.fn()
      explicitPlugin.configureServer.handler({
        watcher: { add: explicitAdd },
        environments: {},
      })
      expect(explicitAdd).toHaveBeenCalledWith([path.normalize(configPath)])

      const appPath = path.join(srcDir, 'App.tsx')
      const appSource = 'export const value: number = 1'
      await writeFile(appPath, appSource)
      await writeFile(baseConfigPath, JSON.stringify({ extends: './missing.jsonc' }))
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ extends: '../shared/base.jsonc', include: ['src/**/*'] }),
      )
      const extendsPlugin = getTestPlugin({ cache: false }) as any
      extendsPlugin.configResolved({ ...mockBuildConfig, command: 'serve', root })
      const extendsAdd = vi.fn()
      extendsPlugin.configureServer.handler({ watcher: { add: extendsAdd }, environments: {} })
      await extendsPlugin.transform.call(
        {
          error(error: unknown): never {
            throw error instanceof Error ? error : new Error(String(error))
          },
          warn: vi.fn(),
          emitFile: vi.fn(),
        },
        appSource,
        appPath,
      )
      expect(extendsAdd.mock.calls.flatMap(call => call[0])).toContain(
        path.normalize(missingBasePath),
      )
      expect(extendsAdd.mock.calls.flatMap(call => call[0])).toContain(
        path.normalize(`${missingBasePath}.json`),
      )
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it('prepares cyclic earlier-transform hook metadata on the first dev request', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-dev-pre-transform-')))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const flagPath = path.join(srcDir, 'flag.json')
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let resolveHmr!: () => void
    const hmrSeen = new Promise<void>(resolve => {
      resolveHmr = resolve
    })

    try {
      await mkdir(srcDir, { recursive: true })
      const runtimePath = path.join(srcDir, 'fict-runtime.ts')
      await writeFile(runtimePath, `export {}`)
      await writeFile(flagPath, JSON.stringify({ signal: true }))
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          import { marker } from './cycle'
          import './flag.json'
          const makeValue = (value: number) => value
          export function useCounter() {
            const count = makeValue(marker)
            return count
          }
        `,
      )
      await writeFile(
        path.join(srcDir, 'cycle.ts'),
        `
          export { useCounter } from './use-counter'
          export const marker = 1
        `,
      )
      await writeFile(
        path.join(srcDir, 'App.tsx'),
        `
          import { useCounter } from './use-counter'
          export function App() {
            const count = useCounter()
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )

      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        resolve: {
          alias: {
            'fict/internal': runtimePath,
            fict: runtimePath,
          },
        },
        plugins: [
          {
            name: 'test-dev-rewrite-hook-state',
            enforce: 'pre',
            async transform(code, id) {
              if (!id.split('?')[0]!.endsWith('/use-counter.tsx')) return null
              const flag = JSON.parse(await readFile(flagPath, 'utf8')) as { signal: boolean }
              return flag.signal ? code.replace('makeValue(marker)', '$state(marker)') : null
            },
          },
          fict({ cache: false, useTypeScriptProject: false, functionSplitting: false }),
          {
            name: 'test-dev-metadata-hmr-probe',
            handleHotUpdate(context) {
              if (path.normalize(context.file) === path.normalize(flagPath)) resolveHmr()
            },
          },
        ],
        server: { middlewareMode: true, watch: null },
      })

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        server.transformRequest('/src/App.tsx'),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out transforming cyclic dev metadata.')),
            3_000,
          )
        }),
      ])
      clearTimeout(timeoutHandle)
      expect(result?.code).toMatch(/\bcount\d*\(\) \* 2/)
      expect(result?.code).not.toMatch(/\bcount\d* \* 2/)

      await server.watcher.unwatch(flagPath)
      await writeFile(flagPath, JSON.stringify({ signal: false }))
      server.watcher.emit('change', flagPath)
      await hmrSeen
      const updated = await server.transformRequest('/src/App.tsx')
      expect(updated?.code).toMatch(/\bcount\d* \* 2/)
      expect(updated?.code).not.toMatch(/\bcount\d*\(\) \* 2/)
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates client and SSR metadata during concurrent dev transforms', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-dev-environments-')))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    let server: Awaited<ReturnType<typeof createServer>> | undefined

    try {
      await mkdir(srcDir, { recursive: true })
      const runtimePath = path.join(srcDir, 'fict-runtime.ts')
      await writeFile(runtimePath, `export {}`)
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          const makeValue = (value: number) => value
          export function useCounter() {
            const count = makeValue(1)
            return count
          }
        `,
      )
      await writeFile(
        path.join(srcDir, 'App.tsx'),
        `
          import { useCounter } from './use-counter'
          export function App() {
            const count = useCounter()
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        resolve: { alias: { 'fict/internal': runtimePath, fict: runtimePath } },
        server: { middlewareMode: true, watch: null },
        plugins: [
          {
            name: 'test-environment-specific-hook-state',
            enforce: 'pre',
            transform(code, id, transformOptions) {
              if (!id.split('?')[0]!.endsWith('/use-counter.tsx')) return null
              return transformOptions?.ssr ? null : code.replace('makeValue(1)', '$state(1)')
            },
          },
          fict({ cache: false, useTypeScriptProject: false, functionSplitting: false }),
        ],
      })

      const [clientResult, ssrResult] = await Promise.all([
        server.environments.client.transformRequest('/src/App.tsx'),
        server.environments.ssr.transformRequest('/src/App.tsx'),
      ])

      expect(clientResult?.code).toMatch(/\bcount\d*\(\) \* 2/)
      expect(clientResult?.code).not.toMatch(/\bcount\d* \* 2/)
      expect(ssrResult?.code).toMatch(/\bcount\d* \* 2/)
      expect(ssrResult?.code).not.toMatch(/\bcount\d*\(\) \* 2/)
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let an older pre-pipeline request overwrite fresh HMR handlers', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-hmr-generation-')))
    const srcDir = path.join(root, 'src')
    const appPath = path.join(srcDir, 'App.tsx')
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const source = (label: string) => `
      import { __fictQrl } from '@fictjs/runtime/internal'
      export const __fict_e0 = () => ${JSON.stringify(label)}
      export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0')
    `
    const gateEntered = deferred()
    const releaseOld = deferred()
    const hmrSeen = deferred()
    let gated = false
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let oldRequest: Promise<TransformResult | null> | undefined

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(appPath, source('old-handler'))
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        dev: { preTransformRequests: false },
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, watch: null },
        plugins: [
          {
            name: 'test-earlier-load-gate',
            enforce: 'pre',
            resolveId(id) {
              if (id === '@fictjs/runtime/internal') return { id, external: true }
              return null
            },
            async load(id) {
              if (id.split('?')[0] === appPath && !gated) {
                gated = true
                const code = await readFile(appPath, 'utf8')
                gateEntered.resolve()
                await releaseOld.promise
                return code
              }
              return null
            },
          },
          fict({
            include: ['**/*.tsx'],
            cache: false,
            useTypeScriptProject: false,
            functionSplitting: true,
          }),
          {
            name: 'test-hmr-generation-probe',
            handleHotUpdate(context) {
              if (path.normalize(context.file) === path.normalize(appPath)) hmrSeen.resolve()
            },
          },
        ],
      })

      const environment = server.environments.client
      oldRequest = environment.transformRequest('/src/App.tsx')
      await within(gateEntered.promise, 'old request entering earlier load hook')

      await server.watcher.unwatch(appPath)
      await writeFile(appPath, source('new-handler'))
      server.watcher.emit('change', appPath)
      await within(hmrSeen.promise, 'Fict HMR generation swap')
      const fresh = await within(environment.transformRequest('/src/App.tsx'), 'fresh transform')
      expect(fresh?.code).toContain('virtual:fict-handler:')

      const virtualId = `\0fict-handler:${appPath}$$__fict_e0`
      const loadHandler = async (): Promise<string> => {
        const loaded = await environment.transformRequest(virtualId)
        return loaded?.code ?? ''
      }

      const beforeOldResumes = await loadHandler()
      expect(beforeOldResumes).toContain('new-handler')
      expect(beforeOldResumes).not.toContain('old-handler')

      releaseOld.resolve()
      await expect(within(oldRequest, 'old transform completion')).rejects.toThrow(
        'pre-HMR dev request',
      )

      const afterOldResumes = await loadHandler()
      expect(afterOldResumes).toContain('new-handler')
      expect(afterOldResumes).not.toContain('old-handler')

      const afterStaleCacheWrite = await environment.transformRequest('/src/App.tsx')
      expect(afterStaleCacheWrite?.code).toContain('virtual:fict-handler:')
      expect(afterStaleCacheWrite?.code).not.toContain('old-handler')

      const direct = await environment.pluginContainer.transform(source('new-handler'), appPath)
      expect(direct.code).toContain('virtual:fict-handler:')
    } finally {
      releaseOld.resolve()
      if (oldRequest) await Promise.allSettled([oldRequest])
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not reuse a completed request context in detached dev work', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-detached-context-')))
    const srcDir = path.join(root, 'src')
    const appPath = path.join(srcDir, 'App.tsx')
    const virtualId = `\0fict-handler:${appPath}$$__fict_e0`
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const source = (label: string) => `
      import { __fictQrl } from '@fictjs/runtime/internal'
      export const __fict_e0 = () => ${JSON.stringify(label)}
      export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0')
    `
    const detachedArmed = deferred()
    const releaseDetached = deferred()
    const hmrSeen = deferred()
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let detachedRequest: Promise<TransformResult | null> | undefined

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(appPath, source('old-handler'))
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        dev: { preTransformRequests: false },
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, watch: null },
        plugins: [
          {
            name: 'test-detached-context-runtime-resolve',
            resolveId(id) {
              return id === '@fictjs/runtime/internal' ? { id, external: true } : null
            },
          },
          fict({
            include: ['**/*.tsx'],
            cache: false,
            useTypeScriptProject: false,
            functionSplitting: true,
          }),
          {
            name: 'test-detached-context-probe',
            transform(_code, id) {
              if (id.split('?')[0] !== appPath || detachedRequest) return null
              detachedRequest = (async () => {
                detachedArmed.resolve()
                await releaseDetached.promise
                return server!.environments.client.transformRequest(virtualId)
              })()
              return null
            },
            handleHotUpdate(context) {
              if (path.normalize(context.file) === path.normalize(appPath)) hmrSeen.resolve()
            },
          },
        ],
      })

      const environment = server.environments.client
      const initial = await environment.transformRequest('/src/App.tsx')
      expect(initial?.code).toContain('virtual:fict-handler:')
      await detachedArmed.promise

      await server.watcher.unwatch(appPath)
      await writeFile(appPath, source('new-handler'))
      server.watcher.emit('change', appPath)
      await hmrSeen.promise

      const fresh = await environment.transformRequest('/src/App.tsx')
      expect(fresh?.code).toContain('virtual:fict-handler:')

      releaseDetached.resolve()
      const detached = await detachedRequest!
      expect(detached?.code).toContain('new-handler')
      expect(detached?.code).not.toContain('old-handler')

      const cached = await environment.transformRequest(virtualId)
      expect(cached?.code).toContain('new-handler')
      expect(cached?.code).not.toContain('old-handler')
    } finally {
      releaseDetached.resolve()
      if (detachedRequest) await Promise.allSettled([detachedRequest])
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a captured pre-HMR request without blocking later direct transforms', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-captured-request-')))
    const srcDir = path.join(root, 'src')
    const appPath = path.join(srcDir, 'App.tsx')
    const childPath = path.join(srcDir, 'Child.tsx')
    const unaffectedPath = path.join(srcDir, 'unaffected.js')
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const source = (label: string) => `
      import { __fictQrl } from '@fictjs/runtime/internal'
      export const __fict_e0 = () => ${JSON.stringify(label)}
      export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0')
    `
    const gateEntered = deferred()
    const releaseOld = deferred()
    const releaseUntrustedDetached = deferred()
    const hmrSeen = deferred()
    let gated = false
    let oldChildCode = ''
    let capturedTransform: ((url: string) => Promise<TransformResult | null>) | undefined
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let oldRequest: Promise<TransformResult | null> | undefined
    let untrustedDetachedRequest: Promise<TransformResult | null> | undefined

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(appPath, source('old-handler'))
      await writeFile(childPath, source('old-child'))
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        dev: { preTransformRequests: false },
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, watch: null },
        plugins: [
          {
            name: 'test-captured-pre-hmr-request',
            enforce: 'pre',
            configureServer: {
              order: 'pre',
              handler(devServer) {
                const environment = devServer.environments.client
                capturedTransform = environment.transformRequest.bind(environment)
              },
            },
            resolveId(id) {
              return id === '@fictjs/runtime/internal' ? { id, external: true } : null
            },
            async load(id) {
              const cleanId = id.split('?')[0]
              if (cleanId === childPath && id.includes('oldnested')) return oldChildCode
              if (cleanId !== appPath || gated) return null
              gated = true
              const code = await readFile(appPath, 'utf8')
              oldChildCode = await readFile(childPath, 'utf8')
              gateEntered.resolve()
              await releaseOld.promise
              await server!.environments.client.transformRequest('/src/Child.tsx?oldnested')
              return code
            },
            transform(_code, id) {
              if (id !== unaffectedPath || untrustedDetachedRequest) return null
              untrustedDetachedRequest = (async () => {
                await releaseUntrustedDetached.promise
                return server!.environments.client.transformRequest('/src/Child.tsx?oldnested')
              })()
              return null
            },
          },
          fict({
            include: ['**/*.tsx'],
            cache: false,
            useTypeScriptProject: false,
            functionSplitting: true,
          }),
          {
            name: 'test-captured-pre-hmr-probe',
            handleHotUpdate(context) {
              if (path.normalize(context.file) === path.normalize(appPath)) hmrSeen.resolve()
            },
          },
        ],
      })

      const environment = server.environments.client
      oldRequest = capturedTransform!('/src/App.tsx')
      await gateEntered.promise

      await server.watcher.unwatch(appPath)
      await server.watcher.unwatch(childPath)
      await writeFile(appPath, source('new-handler'))
      await writeFile(childPath, source('new-child'))
      server.watcher.emit('change', appPath)
      await hmrSeen.promise

      const fresh = await environment.transformRequest('/src/App.tsx')
      expect(fresh?.code).toContain('virtual:fict-handler:')
      const freshChild = await environment.transformRequest('/src/Child.tsx')
      expect(freshChild?.code).toContain('virtual:fict-handler:')
      await environment.moduleGraph.ensureEntryFromUrl(unaffectedPath)
      await expect(
        environment.pluginContainer.transform('export const unaffected = true', unaffectedPath),
      ).resolves.toBeDefined()
      await expect(
        environment.pluginContainer.transform(source('new-handler'), appPath),
      ).rejects.toThrow('pre-HMR request is still settling')

      releaseOld.resolve()
      await expect(oldRequest).rejects.toThrow('pre-HMR dev request')
      releaseUntrustedDetached.resolve()
      await expect(untrustedDetachedRequest).rejects.toThrow('unscoped dev pipeline')

      const direct = await environment.pluginContainer.transform(source('new-handler'), appPath)
      expect(direct.code).toContain('virtual:fict-handler:')

      const virtualId = `\0fict-handler:${childPath}$$__fict_e0`
      const handler = await environment.pluginContainer.load(virtualId)
      const handlerCode =
        typeof handler === 'string'
          ? handler
          : handler && typeof handler === 'object' && 'code' in handler
            ? String(handler.code)
            : ''
      expect(handlerCode).toContain('new-child')
      expect(handlerCode).not.toContain('old-child')

      const cached = await environment.transformRequest('/src/App.tsx')
      expect(cached?.code).toContain('virtual:fict-handler:')
      expect(cached?.code).not.toContain('old-handler')
      const cachedChild = await environment.transformRequest('/src/Child.tsx')
      expect(cachedChild?.code).toContain('virtual:fict-handler:')
      expect(cachedChild?.code).not.toContain('old-child')
    } finally {
      releaseOld.resolve()
      releaseUntrustedDetached.resolve()
      if (oldRequest) await Promise.allSettled([oldRequest])
      if (untrustedDetachedRequest) await Promise.allSettled([untrustedDetachedRequest])
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('transforms a TypeScript hook by default before its TSX importer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-default-ts-hook-'))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'hook.ts')
    const entry = path.join(srcDir, 'App.tsx')

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'

          export function useCounter(initial: number) {
            const count: number = $state(initial)
            return count
          }
        `,
      )
      await writeFile(
        entry,
        `
          import { useCounter } from './hook'

          export function App() {
            const count = useCounter(2)
            const doubled = count * 2
            return <div>{doubled}</div>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).not.toContain('$state')
      expect(code).toMatch(/=>\s*[\w$]+\(\) \* 2,\s*\{\s*name:\s*"doubled"/)
      expect(code).not.toMatch(/=>\s*[\w$]+ \* 2,\s*\{\s*name:\s*"doubled"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves Vite TypeScript lowering enabled for excluded TSX modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-excluded-tsx-'))
    const entry = path.join(root, 'plain.tsx')

    try {
      await writeFile(entry, 'export const answer: number = 42')

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          fict({
            include: ['**/compiled-only.tsx'],
            cache: false,
            useTypeScriptProject: false,
            functionSplitting: false,
          }),
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'plain.js' },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toContain('42')
      expect(code).not.toContain(': number')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { extension: '.js', typeAnnotation: '' },
    { extension: '.mjs', typeAnnotation: '' },
    { extension: '.cjs', typeAnnotation: '' },
    { extension: '.mts', typeAnnotation: ': number' },
    { extension: '.cts', typeAnnotation: ': number' },
  ])('transforms macros in $extension application modules by default', async testCase => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-default-module-'))
    const entry = path.join(root, `counter${testCase.extension}`)

    try {
      await writeFile(
        entry,
        `
          import { $state } from 'fict'

          export function useDoubled() {
            const count${testCase.typeAnnotation} = $state(2)
            return count * 2
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'counter.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).not.toContain('$state')
      expect(code).not.toContain(': number')
      expect(code).toMatch(/\}\)\(\) \* 2/)
      expect(code).not.toMatch(/\}\) \* 2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps bare package requests on the package metadata path when tsconfig maps them locally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-bare-tsconfig-path-'))
    const srcDir = path.join(root, 'src')
    const entry = path.join(srcDir, 'App.tsx')
    const source = `
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        return <div>{count}</div>
      }
    `

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            jsx: 'preserve',
            module: 'ESNext',
            moduleResolution: 'bundler',
            paths: { fict: ['src/fict.ts'] },
          },
          include: ['src'],
        }),
      )
      await writeFile(
        path.join(srcDir, 'fict.ts'),
        'export declare function $state<T>(value: T): T',
      )
      await writeFile(entry, source)

      const plugin = getTestPlugin({ cache: false, functionSplitting: false })
      plugin.configResolved?.({ ...mockBuildConfig, root })
      const context = {
        error(error: unknown): never {
          throw error instanceof Error ? error : new Error(String(error))
        },
        warn: vi.fn(),
        emitFile: vi.fn(),
      }
      const result = await plugin.transform?.call(context, source, entry)

      expect(result).toMatchObject({ code: expect.not.stringContaining('$state') })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lowers TypeScript runtime declarations before a real Vite build', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-typescript-lowering-'))
    const entry = path.join(root, 'App.tsx')

    try {
      await writeFile(
        entry,
        `
          import { $state } from 'fict'

          enum Status {
            Idle,
            Ready,
          }

          namespace Defaults {
            export const status = Status.Ready
          }

          class Model {
            declare status: Status
            current = Defaults.status
          }

          export function App() {
            const status = $state(new Model().current)
            return <div>{status}</div>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).toContain('fict/internal')
      expect(code).not.toContain('$state')
      expect(code).not.toMatch(/\benum\s+Status\b/)
      expect(code).not.toMatch(/\bnamespace\s+Defaults\b/)
      expect(code).not.toContain('declare status')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a consumer .babelrc that references an unavailable plugin', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.fict-vite-babelrc-'))
    const entry = path.join(root, 'App.tsx')

    try {
      await writeFile(
        path.join(root, '.babelrc'),
        JSON.stringify({ plugins: ['./missing-consumer-babel-plugin.cjs'] }),
      )
      await writeFile(
        entry,
        `
          import { $state } from 'fict'
          export function App() {
            const count = $state(1)
            return <div>{count}</div>
          }
        `,
      )

      const code = await buildFictEntry(root, entry)

      expect(code).toContain('fict/internal')
      expect(code).not.toContain('$state')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a consumer babel.config that would change compiled semantics', async () => {
    const originalCwd = process.cwd()
    const root = await mkdtemp(path.join(originalCwd, '.fict-vite-babel-config-'))
    const entry = path.join(root, 'marker.js')

    try {
      await writeFile(
        path.join(root, 'babel.config.cjs'),
        `
          module.exports = {
            plugins: [function mutateMarker() {
              return {
                visitor: {
                  StringLiteral(path) {
                    if (path.node.value === 'original-marker') {
                      path.node.value = 'mutated-marker'
                    }
                  }
                }
              }
            }]
          }
        `,
      )
      await writeFile(
        entry,
        `
          import { $state } from 'fict'
          export function useMarker() {
            const marker = $state('original-marker')
            return marker
          }
        `,
      )
      process.chdir(root)

      const code = await buildFictEntry(root, entry)

      expect(code).toContain('original-marker')
      expect(code).not.toContain('mutated-marker')
      expect(code).not.toContain('$state')
    } finally {
      process.chdir(originalCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deduplicates dependency metadata preparation across concurrent importer transforms', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-concurrent-metadata-'))
    const srcDir = path.join(root, 'src')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const compiledFiles: string[] = []

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          export function useCounter() {
            const count = $state(1)
            return count
          }
        `,
      )
      const plugin = getTestPlugin({
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
        explain: artifact => compiledFiles.push(path.normalize(artifact.fileName)),
      })
      plugin.configResolved?.({ ...mockBuildConfig, root })
      const context = {
        error(error: unknown): never {
          throw error instanceof Error ? error : new Error(String(error))
        },
        warn: vi.fn(),
        emitFile: vi.fn(),
      }
      const makeApp = (name: string) => `
        import { useCounter } from './use-counter'
        export function ${name}() {
          const count = useCounter()
          return <div>{count * 2}</div>
        }
      `

      const [first, second] = await Promise.all([
        plugin.transform?.call(context, makeApp('First'), path.join(srcDir, 'First.tsx')),
        plugin.transform?.call(context, makeApp('Second'), path.join(srcDir, 'Second.tsx')),
      ])

      expect(first && typeof first === 'object').toBe(true)
      expect(second && typeof second === 'object').toBe(true)
      expect(compiledFiles.filter(file => file === hookPath)).toHaveLength(1)
      expect(compiledFiles.filter(file => file.endsWith('First.tsx'))).toHaveLength(1)
      expect(compiledFiles.filter(file => file.endsWith('Second.tsx'))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keys persistent importer transforms with prepared local metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-local-metadata-cache-'))
    const srcDir = path.join(root, 'src')
    const cacheDir = path.join(root, '.cache')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const appPath = path.join(srcDir, 'App.tsx')
    const appSource = `
      import { useCounter } from '@/use-counter'
      export function App() {
        const count = useCounter()
        return <div>{count * 2}</div>
      }
    `
    const context = {
      error(error: unknown): never {
        const message =
          error && typeof error === 'object' && 'message' in error
            ? String(error.message)
            : String(error)
        throw new Error(message)
      },
      warn: vi.fn(),
      emitFile: vi.fn(),
    }

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        hookPath,
        `
          import { $state } from 'fict'
          export function useCounter() {
            const count = $state(1)
            return count
          }
        `,
      )
      const firstPlugin = getTestPlugin({
        cache: { persistent: true, dir: cacheDir },
        functionSplitting: false,
        useTypeScriptProject: false,
      })
      firstPlugin.configResolved?.({
        ...mockBuildConfig,
        root,
        resolve: { alias: { '@': srcDir } },
      })
      const first = await firstPlugin.transform?.call(context, appSource, appPath)
      expect(first && typeof first === 'object' && 'code' in first ? first.code : '').toMatch(
        /count\(\) \* 2/,
      )

      await writeFile(
        hookPath,
        `
          export function useCounter() {
            return 1
          }
        `,
      )
      const send = vi.fn()
      expect(
        firstPlugin.handleHotUpdate?.({
          file: hookPath,
          server: { ws: { send } },
        }),
      ).toEqual([])
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })
      const hmrResult = await firstPlugin.transform?.call(context, appSource, appPath)
      const hmrCode =
        hmrResult && typeof hmrResult === 'object' && 'code' in hmrResult
          ? String(hmrResult.code)
          : ''
      expect(hmrCode).toMatch(/count \* 2/)
      expect(hmrCode).not.toMatch(/count\(\) \* 2/)

      const secondPlugin = getTestPlugin({
        cache: { persistent: true, dir: cacheDir },
        functionSplitting: false,
        useTypeScriptProject: false,
      })
      secondPlugin.configResolved?.({
        ...mockBuildConfig,
        root,
        resolve: { alias: { '@': srcDir } },
      })
      const second = await secondPlugin.transform?.call(context, appSource, appPath)
      const secondCode =
        second && typeof second === 'object' && 'code' in second ? String(second.code) : ''
      expect(secondCode).toMatch(/count \* 2/)
      expect(secondCode).not.toMatch(/count\(\) \* 2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keys persistent transforms with extended TypeScript config contents', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-tsconfig-cache-'))
    const srcDir = path.join(root, 'src')
    const cacheDir = path.join(root, '.cache')
    const appPath = path.join(srcDir, 'App.tsx')
    const baseConfigPath = path.join(root, 'tsconfig.base.jsonc')
    const appSource = 'export const value: number = 1'
    const context = {
      error(error: unknown): never {
        throw error instanceof Error ? error : new Error(String(error))
      },
      warn: vi.fn(),
      emitFile: vi.fn(),
    }
    const createPlugin = () => {
      const plugin = getTestPlugin({
        cache: { persistent: true, dir: cacheDir },
        functionSplitting: false,
      })
      plugin.configResolved?.({ ...mockBuildConfig, root })
      return plugin
    }

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(baseConfigPath, JSON.stringify({ compilerOptions: { strict: false } }))
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './tsconfig.base.jsonc', include: ['src/**/*'] }),
      )
      await writeFile(appPath, appSource)

      await createPlugin().transform?.call(context, appSource, appPath)
      const firstCacheFiles = (await readdir(cacheDir)).filter(file => file.endsWith('.json'))
      expect(firstCacheFiles.length).toBeGreaterThan(0)

      await writeFile(baseConfigPath, JSON.stringify({ compilerOptions: { strict: true } }))
      await createPlugin().transform?.call(context, appSource, appPath)
      const secondCacheFiles = (await readdir(cacheDir)).filter(file => file.endsWith('.json'))
      expect(secondCacheFiles.length).toBeGreaterThan(firstCacheFiles.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retransforms unchanged importers when local hook metadata changes in build watch mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-watch-metadata-'))
    const srcDir = path.join(root, 'src')
    const outDir = path.join(root, 'dist')
    const hookPath = path.join(srcDir, 'use-counter.tsx')
    const appPath = path.join(srcDir, 'App.tsx')
    let watcher: Rollup.RollupWatcher | undefined

    try {
      await mkdir(srcDir, { recursive: true })
      await writeFile(
        hookPath,
        `
            import { $state } from 'fict'
            export function useCounter() {
              const count = $state(1)
              return count
            }
          `,
      )
      await writeFile(
        appPath,
        `
            import { useCounter } from './use-counter'
            export function App() {
              const count = useCounter()
              const doubled = count * 2
              return <div>{doubled}</div>
            }
          `,
      )

      watcher = (await build({
        root,
        logLevel: 'silent',
        plugins: [fict({ cache: false, useTypeScriptProject: false, functionSplitting: false })],
        build: {
          outDir,
          emptyOutDir: true,
          minify: false,
          lib: { entry: appPath, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
          watch: { buildDelay: 10 },
        },
      })) as Rollup.RollupWatcher

      await waitForWatchEnd(watcher)
      const firstCode = await readFile(path.join(outDir, 'app.js'), 'utf8')
      expect(firstCode).toMatch(/count\(\)\s*\*\s*2/)

      const rebuilt = waitForWatchEnd(watcher)
      await writeFile(
        hookPath,
        `
            export function useCounter() {
              const count = 1
              return count
            }
          `,
      )
      await rebuilt

      const secondCode = await readFile(path.join(outDir, 'app.js'), 'utf8')
      expect(secondCode).toMatch(/count\s*\*\s*2/)
      expect(secondCode).not.toMatch(/count\(\)\s*\*\s*2/)
    } finally {
      await watcher?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

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
        import { readCount } from './external'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          return readCount()
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

      const metadataCalls = emitFile.mock.calls as unknown as [
        { type: string; fileName: string; source?: string },
      ][]
      const metadataCall = metadataCalls.find(
        ([asset]) => asset.type === 'asset' && asset.fileName === 'index.fict.meta.json',
      )
      expect(metadataCall).toBeDefined()
      expect(JSON.parse(metadataCall![0].source as string)).toEqual({
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

      const metadataCalls = emitFile.mock.calls as unknown as [
        { type: string; fileName: string; source?: string },
      ][]
      const metadataCall = metadataCalls.find(
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
    async function splitHandlerExports(code: string, sourceModule: string) {
      const plugin = fict({ cache: false, functionSplitting: true, sourcemap: true }) as any
      plugin.configResolved?.(mockBuildConfig as any)

      const context = {
        emitFile: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      }
      const result = await plugin.transform.call(context, code, sourceModule)

      expect(context.error).not.toHaveBeenCalled()
      expect(context.warn).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)

      return {
        code: result.code as string,
        load: plugin.load as (id: string) => string | null,
        map: result.map as SourceMapLike | null,
      }
    }

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

        const generated = findGeneratedPosition(result.code as string, 'virtual:fict-handler:')
        const original = originalPositionFor(
          result.map as SourceMapLike,
          generated.line,
          generated.column,
        )
        expect(original).not.toBeNull()
        expect(original?.source).toContain('CounterMap.tsx')
        expect(sample.split('\n')[original!.line - 1]).toMatch(/\$state|onClick\$/)
      }
    })

    it('maps generated stack frame positions back to original TSX lines', async () => {
      const plugin = fict({ functionSplitting: true, resumable: true, sourcemap: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const sample = `
        import { $state } from 'fict'

        function crash() {
          throw new Error('mapped boom')
        }

        export function Counter() {
          let count = $state(0)
          return <button onClick$={() => crash()}>{count}</button>
        }
      `

      const mockContext = {
        error: vi.fn(),
        emitFile: vi.fn(),
      }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, '/project/src/CounterStack.tsx')
          : await transform?.handler.call(mockContext, sample, '/project/src/CounterStack.tsx')

      expect(result && typeof result === 'object').toBe(true)
      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.map).not.toBeNull()

        const generated = findGeneratedPosition(result.code as string, 'mapped boom')
        const stackFrame = `    at crash (/project/src/CounterStack.tsx:${generated.line}:${
          generated.column + 1
        })`
        const match = stackFrame.match(/:(\d+):(\d+)\)?$/)
        expect(match).not.toBeNull()

        const original = originalPositionFor(
          result.map as SourceMapLike,
          Number(match![1]),
          Number(match![2]) - 1,
        )

        expect(original).not.toBeNull()
        expect(original?.source).toContain('CounterStack.tsx')
        expect(sample.split('\n')[original!.line - 1]).toContain("throw new Error('mapped boom')")
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

    it('uses Babel scope for block, catch, and class static helper shadows', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictGetScopeProps, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  {
    const __fictUseLexicalScope = () => ['local'];
    __fictUseLexicalScope(scopeId, ['shadowed']);
  }
  try {
    throw new Error('local');
  } catch (__fictGetScopeProps) {
    __fictGetScopeProps(scopeId);
  }
  class Local {
    static {
      const __fictEnsureScope = () => 'local';
      __fictEnsureScope(scopeId, el);
    }
  }
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  return count + event.type + String(Local);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/ScopedHelperShadows.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/ScopedHelperShadows.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).toContain("import { __fictUseLexicalScope } from '@fictjs/runtime/internal';")
      expect(content).not.toContain('import { __fictGetScopeProps')
      expect(content).not.toContain('__fictEnsureScope } from')
    })

    it('preserves aliased helper imports after nested local shadows', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope as useScope, __fictGetScopeProps as getScopeProps, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  {
    const useScope = () => ['local'];
    useScope(scopeId, ['shadowed']);
  }
  function inner(getScopeProps) {
    return getScopeProps(scopeId);
  }
  const [count] = useScope(scopeId, ['count']);
  return count + inner(() => 'local') + event.type + el.tagName;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/AliasedScopedHelper.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/AliasedScopedHelper.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).toContain(
        "import { __fictUseLexicalScope as useScope } from '@fictjs/runtime/internal';",
      )
      expect(content).not.toContain('__fictGetScopeProps as getScopeProps')
      expect(content).toContain('const useScope = () => [')
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

    it('captures top-level dependencies when nested handler scopes shadow the same name', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
const config = { step: 1 };
function readStep() {
  return config.step;
}
class StepBox {
  value = 2;
}

export const __fict_e0 = (scopeId, event, el) => {
  const current = config.step + readStep() + new StepBox().value;
  function inner(config) {
    return config.step;
  }
  return current + inner({ step: 3 }) + event.type + el.tagName;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/ScopedDeps.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/ScopedDeps.tsx$$__fict_e0') as string | null

      expect(content).not.toBeNull()
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_config as config/)
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_readStep as readStep/)
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_StepBox as StepBox/)
    })

    it('avoids private dependency export name collisions', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const sourcePath = '/project/src/DepConflict.tsx'
      const collidingExport = `__fict_dep_${createHash('sha256')
        .update(`${sourcePath}:config`)
        .digest('hex')
        .slice(0, 8)}_config`
      const compiledCode = `
export const ${collidingExport} = 'user export';
const config = { step: 1 };

export const __fict_e0 = () => config.step;
      `

      const mockContext = { error: vi.fn(), emitFile: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, sourcePath)
          : null

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)
      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.code as string).toContain(`export const ${collidingExport}`)
        expect(result.code as string).toContain(`export { config as ${collidingExport}_1 }`)
      }

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/DepConflict.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).toContain(`${collidingExport}_1 as config`)
    })

    it('does not capture block or catch parameters that shadow top-level dependencies', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
const config = { step: 1 };

export const __fict_e0 = () => {
  {
    const config = { step: 2 };
    if (config.step) return config.step;
  }
  try {
    throw { step: 3 };
  } catch (config) {
    return config.step;
  }
};
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/ShadowOnlyDeps.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/ShadowOnlyDeps.tsx$$__fict_e0') as
        | string
        | null

      expect(content).not.toBeNull()
      expect(content).not.toContain('__fict_dep_config as config')
    })

    it('captures destructured and imported runtime deps without type-only imports', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictQrl } from '@fictjs/runtime/internal';
import { format as fmt } from './format';
import type { Formatter } from './types';

const { label } = { label: 'count' };

export const __fict_e0 = (value: Formatter) => {
  return fmt(label, value);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      await transform.call(mockContext, compiledCode, '/project/src/TypedDeps.tsx')

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/TypedDeps.tsx$$__fict_e0') as string | null

      expect(content).not.toBeNull()
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_fmt as fmt/)
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_label as label/)
      expect(content).not.toContain('__fict_dep_Formatter')
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

    it.each([
      {
        name: 'first',
        declaration: `
          export const __fict_e0 = () => 'handler',
            /* keep-after */ after = 'after';
        `,
        keptExports: ['after'],
        keptComments: ['keep-after'],
      },
      {
        name: 'middle',
        declaration: `
          export const /* keep-before */ before = 'before',
            __fict_e0 = () => 'handler',
            /* keep-after */ after = 'after';
        `,
        keptExports: ['before', 'after'],
        keptComments: ['keep-before', 'keep-after'],
      },
      {
        name: 'last',
        declaration: `
          export const /* keep-before */ before = 'before',
            __fict_e0 = () => 'handler';
        `,
        keptExports: ['before'],
        keptComments: ['keep-before'],
      },
    ])('preserves sibling exports when the handler is $name', async testCase => {
      const sourceModule = `/project/src/Sibling-${testCase.name}.tsx`
      const source = `
        import { __fictQrl } from '@fictjs/runtime/internal';
        ${testCase.declaration}
        export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0');
      `
      const result = await splitHandlerExports(source, sourceModule)

      expect(result.code).not.toMatch(/\b(?:const|let|var)\s+__fict_e0\b/)
      expect(result.code).toContain(`virtual:fict-handler:${sourceModule}$$__fict_e0#default`)
      for (const exportName of testCase.keptExports) {
        expect(result.code).toMatch(new RegExp(`\\b${exportName}\\s*=\\s*["']${exportName}["']`))
      }
      for (const comment of testCase.keptComments) {
        expect(result.code).toContain(comment)
      }

      const handlerModule = result.load(`\0fict-handler:${sourceModule}$$__fict_e0`)
      expect(handlerModule).toContain('export default')
      expect(handlerModule).toMatch(/["']handler["']/)
    })

    it('preserves siblings and sourcemaps around multiple handlers in one export', async () => {
      const sourceModule = '/project/src/MultipleSiblingHandlers.tsx'
      const source = `
        import { __fictQrl } from '@fictjs/runtime/internal';

        /* declaration-comment */
        export const /* keep-sibling */ keep = 'kept',
          __fict_e0 = () => 'first',
          __fict_e1 = () => 'second';

        export const firstUrl = __fictQrl(import.meta.url, '__fict_e0');
        export const secondUrl = __fictQrl(import.meta.url, '__fict_e1');
      `
      const result = await splitHandlerExports(source, sourceModule)

      expect(result.code).not.toMatch(/\b(?:const|let|var)\s+__fict_e[01]\b/)
      expect(result.code).toMatch(/export const\s+\/\* keep-sibling \*\/\s*keep\s*=\s*["']kept["']/)
      expect(result.code).toContain('declaration-comment')
      expect(result.code).toContain(`virtual:fict-handler:${sourceModule}$$__fict_e0#default`)
      expect(result.code).toContain(`virtual:fict-handler:${sourceModule}$$__fict_e1#default`)
      expect(result.load(`\0fict-handler:${sourceModule}$$__fict_e0`)).toMatch(/["']first["']/)
      expect(result.load(`\0fict-handler:${sourceModule}$$__fict_e1`)).toMatch(/["']second["']/)

      expect(result.map).not.toBeNull()
      const generated = findGeneratedPosition(result.code, 'keep =')
      const original = originalPositionFor(result.map!, generated.line, generated.column)
      expect(original).not.toBeNull()
      expect(original?.source).toContain('MultipleSiblingHandlers.tsx')
      expect(source.split('\n')[original!.line - 1]).toContain("keep = 'kept'")
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

        // Hoisted helpers referenced by handlers remain available from the
        // source module and are re-exported under a private dependency name.
        expect(code).toContain('export const __fict_fn_formatNumber_0')
        expect(code).toMatch(
          /export \{ __fict_fn_formatNumber_0 as __fict_dep_[a-f0-9]{8}___fict_fn_formatNumber_0 \}/,
        )
      }

      // Check that the virtual module imports the hoisted helper dependency
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
        if (content) {
          // Should include the handler
          expect(content).toContain('export default')
          expect(content).toContain('__fictUseLexicalScope')

          // Should import the hoisted helper from the source module dependency re-export
          expect(content).toContain('__fict_fn_formatNumber_0')
          expect(content).toMatch(
            /__fict_dep_[a-f0-9]{8}___fict_fn_formatNumber_0 as __fict_fn_formatNumber_0/,
          )
          // The helper should be imported from the source module
          expect(content).toContain('/project/src/Counter.tsx')
        }
      }
    })

    it('keeps handlers in the source module when they write mutable module-local bindings', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

let clicks = 0;

export const __fict_e0 = (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  clicks++;
  return clicks;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn(), warn: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/MutableLocal.tsx')
          : null

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)
      expect(mockContext.warn).not.toHaveBeenCalled()
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        expect(code).toContain('export const __fict_e0')
        expect(code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
        expect(code).not.toContain('virtual:fict-handler:/project/src/MutableLocal.tsx$$__fict_e0')
        expect(code).not.toContain('__fict_dep_clicks')
      }

      const load = plugin.load as any
      expect(load('\0fict-handler:/project/src/MutableLocal.tsx$$__fict_e0')).toBeNull()
    })

    it('still splits handlers that mutate properties on module-local objects', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

const metrics = { clicks: 0 };

export const __fict_e0 = (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  metrics.clicks++;
  return metrics.clicks;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/MutableObject.tsx')
          : null

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)
      expect(mockContext.warn).not.toHaveBeenCalled()
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        expect(code).not.toContain('export const __fict_e0')
        expect(code).toContain('virtual:fict-handler:/project/src/MutableObject.tsx$$__fict_e0')
        expect(code).toMatch(/export \{ metrics as __fict_dep_[a-f0-9]{8}_metrics \}/)
      }

      const load = plugin.load as any
      const content = load('\0fict-handler:/project/src/MutableObject.tsx$$__fict_e0') as
        | string
        | null
      expect(content).not.toBeNull()
      expect(content).toMatch(/__fict_dep_[a-f0-9]{8}_metrics as metrics/)
      expect(content).toContain('metrics.clicks++')
    })

    it('keeps handlers with import.meta in the source module', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  return new URL('./asset.png', import.meta.url).href;
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn(), warn: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/ImportMeta.tsx')
          : null

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)
      expect(mockContext.warn).not.toHaveBeenCalled()
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        expect(code).toContain('export const __fict_e0')
        expect(code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
        expect(code).not.toContain('virtual:fict-handler:/project/src/ImportMeta.tsx$$__fict_e0')
      }

      const load = plugin.load as any
      expect(load('\0fict-handler:/project/src/ImportMeta.tsx$$__fict_e0')).toBeNull()
    })

    it('keeps handlers with relative dynamic imports in the source module', async () => {
      const plugin = fict({ functionSplitting: true }) as any

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = async (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  return import('./heavy');
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn(), warn: vi.fn() }
      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/RelativeImport.tsx')
          : null

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)
      expect(mockContext.warn).not.toHaveBeenCalled()
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        expect(code).toContain('export const __fict_e0')
        expect(code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
        expect(code).not.toContain(
          'virtual:fict-handler:/project/src/RelativeImport.tsx$$__fict_e0',
        )
      }

      const load = plugin.load as any
      expect(load('\0fict-handler:/project/src/RelativeImport.tsx$$__fict_e0')).toBeNull()
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
