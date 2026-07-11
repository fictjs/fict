import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build } from 'vite'
import { describe, expect, it, vi } from 'vitest'

import fict from '..'

function createTransformPlugin(options: Parameters<typeof fict>[0] = {}) {
  const plugin = fict({
    cache: false,
    functionSplitting: false,
    useTypeScriptProject: false,
    ...options,
  }) as any
  const context = {
    emitFile: vi.fn(),
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error))
    },
    warn: vi.fn(),
  }
  return { context, plugin }
}

describe('vite plugin transform filter', () => {
  it('honors nested include and exclude globs', async () => {
    const { context, plugin } = createTransformPlugin({
      include: ['src/**/*.tsx'],
      exclude: ['src/**/generated/**'],
    })
    const source = 'export function App() { return <div /> }'
    plugin.configResolved({
      command: 'build',
      mode: 'production',
      root: '/workspace',
      build: { ssr: false },
      resolve: { alias: [] },
    })

    await expect(
      plugin.transform.call(context, source, '/workspace/src/features/App.tsx'),
    ).resolves.toMatchObject({ code: expect.any(String) })
    await expect(
      plugin.transform.call(context, source, '/workspace/src/generated/App.tsx'),
    ).resolves.toBeNull()
    await expect(
      plugin.transform.call(context, source, '/workspace/test/App.tsx'),
    ).resolves.toBeNull()
  })

  it.each(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])(
    'transforms the default .%s module extension with URL suffixes removed',
    async extension => {
      const { context, plugin } = createTransformPlugin()
      const source = `
        import { $state } from 'fict'
        export function useValue() {
          const value = $state(1)
          return value
        }
      `

      const result = await plugin.transform.call(
        context,
        source,
        `/workspace/src/value.${extension}?import#fragment`,
      )

      expect(result).toMatchObject({ code: expect.not.stringContaining('$state') })
    },
  )

  it.each(['vue', 'json', 'css'])(
    'does not transform the non-module .%s extension',
    async extension => {
      const { context, plugin } = createTransformPlugin()

      await expect(
        plugin.transform.call(
          context,
          'export const value = 1',
          `/workspace/src/value.${extension}`,
        ),
      ).resolves.toBeNull()
    },
  )

  it('excludes dependency files with the default node_modules glob', async () => {
    const { context, plugin } = createTransformPlugin()

    await expect(
      plugin.transform.call(
        context,
        'export function App() { return <div /> }',
        '/workspace/node_modules/example/App.tsx',
      ),
    ).resolves.toBeNull()
  })

  it('matches root-relative globs against physical /@fs/ request ids', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-filter-fs-')))
    const sourceDir = path.join(root, 'src')
    const sourcePath = path.join(sourceDir, 'App.tsx')
    const source = 'export function App() { return <div /> }'

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(sourcePath, source)
      const { context, plugin } = createTransformPlugin({ include: ['src/**/*.tsx'] })
      plugin.configResolved({
        command: 'build',
        mode: 'production',
        root,
        build: { ssr: false },
        resolve: { alias: [] },
      })

      await expect(
        plugin.transform.call(context, source, `/@fs/${sourcePath}?import`),
      ).resolves.toMatchObject({ code: expect.any(String) })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes Windows separators and rejects Vite virtual ids before glob matching', async () => {
    const { context, plugin } = createTransformPlugin({ include: ['**/src/**/*.tsx'] })
    const source = 'export function App() { return <div /> }'

    await expect(
      plugin.transform.call(context, source, String.raw`C:\workspace\src\App.tsx?import`),
    ).resolves.toMatchObject({ code: expect.any(String) })

    for (const id of [
      '\0plugin-runtime.tsx',
      'virtual:plugin-runtime.tsx',
      '/@id/plugin-runtime.tsx',
      '/@vite/plugin-runtime.tsx',
      '@vite/plugin-runtime.tsx',
    ]) {
      await expect(plugin.transform.call(context, source, id)).resolves.toBeNull()
    }
  })

  it.each(['types.d.ts?import', 'types.d.mts?raw', 'types.d.cts#raw'])(
    'never transforms TypeScript declaration request %s',
    async request => {
      const { context, plugin } = createTransformPlugin({ include: ['**/*'] })

      await expect(
        plugin.transform.call(
          context,
          'export declare function useCounter(): number',
          `/workspace/src/${request}`,
        ),
      ).resolves.toBeNull()
    },
  )

  it('anchors relative globs to the Vite root across query-suffixed importer pipelines', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-filter-root-')))
    const sourceDir = path.join(root, 'src')
    const entry = path.join(sourceDir, 'App.ts')

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'filter-root-fixture', version: '1.0.0', private: true }),
      )
      await writeFile(
        path.join(sourceDir, 'use-count.ts'),
        `
          import { $state } from 'fict'
          export function useCount() {
            const count = $state(2)
            return count
          }
        `,
      )
      await writeFile(
        entry,
        `
          import { useCount } from './use-count.ts?import'
          export function App() {
            const count = useCount()
            return count * 2
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          fict({
            cache: false,
            functionSplitting: false,
            useTypeScriptProject: false,
            include: ['src/**/*.ts'],
          }),
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: { external: id => id === 'fict' || id.startsWith('fict/') },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).not.toContain('$state')
      expect(code).toMatch(/return\s+[\w$]+\(\)\(\)\s*\*\s*2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
