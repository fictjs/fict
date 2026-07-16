import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { ResolvedConfig } from 'vite'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import fict from '..'

const execFileAsync = promisify(execFile)

interface NpmPackEntry {
  filename: string
  files: { path: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNpmPackEntry(stdout: string): NpmPackEntry {
  const output: unknown = JSON.parse(stdout)
  const entries = Array.isArray(output) ? output : isRecord(output) ? Object.values(output) : []

  if (entries.length !== 1) {
    throw new Error(`Expected npm pack to return exactly one package, received ${entries.length}`)
  }

  const [entry] = entries
  if (!isRecord(entry) || typeof entry.filename !== 'string' || !Array.isArray(entry.files)) {
    throw new Error('Unexpected npm pack JSON output')
  }

  const files = entry.files.map(file => {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw new Error('Unexpected npm pack file entry')
    }
    return { path: file.path }
  })

  return { filename: entry.filename, files }
}

const mockBuildConfig = {
  command: 'build',
  mode: 'production',
  root: '/project',
  base: '/',
  build: { ssr: false },
  resolve: { alias: [] },
} as unknown as ResolvedConfig

describe('npm pack JSON compatibility', () => {
  const entry: NpmPackEntry = {
    filename: 'fict-hook-lib-0.0.0-e2e.tgz',
    files: [{ path: 'dist/index.js' }, { path: 'package.json' }],
  }

  it.each([
    ['npm 11 array output', [entry]],
    ['npm 12 package-keyed output', { 'fict-hook-lib': entry }],
  ])('reads %s', (_label, output) => {
    expect(parseNpmPackEntry(JSON.stringify(output))).toEqual(entry)
  })

  it('rejects output that does not describe exactly one package', () => {
    expect(() => parseNpmPackEntry('{}')).toThrow(
      'Expected npm pack to return exactly one package, received 0',
    )
  })
})

describe('vite-plugin library publishing e2e', () => {
  it('packs generated metadata and lets an installed consumer recover hook reactivity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-library-publish-e2e-'))
    const libraryRoot = path.join(root, 'library')
    const consumerRoot = path.join(root, 'consumer')
    const packDir = path.join(root, 'pack')

    try {
      await mkdir(path.join(libraryRoot, 'src'), { recursive: true })
      await mkdir(path.join(consumerRoot, 'src'), { recursive: true })
      await mkdir(packDir, { recursive: true })

      await writeFile(
        path.join(libraryRoot, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          version: '0.0.0-e2e',
          type: 'module',
          files: ['dist'],
          exports: {
            '.': {
              import: './dist/index.js',
              require: './dist/index.cjs',
            },
          },
        }),
      )
      await writeFile(
        path.join(libraryRoot, 'src', 'index.ts'),
        `
          import { $state } from 'fict'

          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            const count = $state(0)
            return count
          }
        `,
      )

      await build({
        root: libraryRoot,
        logLevel: 'silent',
        plugins: [fict({ library: true, useTypeScriptProject: false, cache: false })],
        build: {
          emptyOutDir: true,
          outDir: 'dist',
          lib: {
            entry: path.join(libraryRoot, 'src', 'index.ts'),
            formats: ['es', 'cjs'],
            fileName: format => (format === 'es' ? 'index.js' : 'index.cjs'),
          },
          rollupOptions: {
            external: id => id === 'fict' || id.startsWith('fict/'),
          },
        },
      })

      const libraryPkg = JSON.parse(await readFile(path.join(libraryRoot, 'package.json'), 'utf8'))
      expect(libraryPkg.fict).toEqual({ metadata: './dist/index.fict.meta.json' })

      const packResult = await execFileAsync('npm', [
        'pack',
        libraryRoot,
        '--json',
        '--pack-destination',
        packDir,
      ])
      const packedPackage = parseNpmPackEntry(packResult.stdout)
      expect(packedPackage.files.map(file => file.path).sort()).toEqual(
        expect.arrayContaining([
          'dist/index.cjs',
          'dist/index.fict.meta.json',
          'dist/index.js',
          'package.json',
        ]),
      )

      const tarballPath = path.join(packDir, packedPackage.filename)
      await writeFile(
        path.join(consumerRoot, 'package.json'),
        JSON.stringify({
          name: 'consumer',
          private: true,
          type: 'module',
        }),
      )
      await execFileAsync(
        'npm',
        [
          'install',
          tarballPath,
          '--ignore-scripts',
          '--package-lock=false',
          '--no-audit',
          '--no-fund',
        ],
        {
          cwd: consumerRoot,
        },
      )

      const plugin = fict({ useTypeScriptProject: false, cache: false }) as any
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved({ ...mockBuildConfig, root: consumerRoot })
      }
      const transform = plugin.transform
      if (!transform) throw new Error('Expected transform hook')

      const appSource = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const count = useCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `
      const context = {
        error(error: unknown): never {
          throw error instanceof Error ? error : new Error(String(error))
        },
        warn(error: unknown): void {
          throw error instanceof Error ? error : new Error(String(error))
        },
        emitFile(): string {
          return 'asset-id'
        },
      }
      const result =
        typeof transform === 'function'
          ? await transform.call(context, appSource, path.join(consumerRoot, 'src', 'App.tsx'))
          : await transform.handler.call(
              context,
              appSource,
              path.join(consumerRoot, 'src', 'App.tsx'),
            )

      expect(result && typeof result === 'object').toBe(true)
      expect(result && typeof result === 'object' && 'code' in result ? result.code : '').toMatch(
        /count\(\) \* 2/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
