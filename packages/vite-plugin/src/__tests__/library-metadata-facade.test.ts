import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'

import createFictVitePlugin from '..'

function fict(
  options?: Parameters<typeof createFictVitePlugin>[0],
): ReturnType<typeof createFictVitePlugin> {
  return createFictVitePlugin({ backend: 'legacy', ...options })
}

async function buildLibraryMetadata(root: string, entry: string): Promise<unknown[]> {
  const result = await build({
    root,
    logLevel: 'silent',
    plugins: [
      fict({
        cache: false,
        functionSplitting: false,
        library: true,
        useTypeScriptProject: false,
      }),
    ],
    build: {
      write: false,
      lib: { entry, formats: ['es'], fileName: () => 'index.js' },
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output)
  return outputs
    .filter(
      (output): output is Rollup.OutputAsset =>
        output.type === 'asset' && output.fileName.endsWith('.fict.meta.json'),
    )
    .map(output => JSON.parse(String(output.source)))
}

describe('library entry metadata', () => {
  it('publishes facade metadata without inheriting same-named bundled internals', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-library-facade-metadata-'))
    const sourceDir = path.join(root, 'src')
    const entry = path.join(sourceDir, 'index.ts')

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(
        path.join(sourceDir, 'internal.ts'),
        `
          console.log('keep bundled internal')

          /** @fictReturn { directAccessor: "signal" } */
          export function useCounter() {
            return 1
          }

          /** @fictReturn { directAccessor: "memo" } */
          export function usePublic() {
            return 2
          }
        `,
      )
      await writeFile(
        entry,
        `
          import './internal'

          export function useCounter() {
            return 3
          }

          export { usePublic as useForwarded } from './internal'
        `,
      )

      expect(await buildLibraryMetadata(root, entry)).toEqual([
        {
          version: 1,
          exports: {},
          hooks: { useForwarded: { directAccessor: 'memo' } },
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'reactive export',
      source: `
        import { createMemo } from 'fict'
        const value = createMemo(() => 1)
        export { value as "__proto__" }
      `,
      field: 'exports' as const,
      expected: 'memo',
    },
    {
      label: 'hook export',
      source: `
        /** @fictReturn { directAccessor: "signal" } */
        function useValue() {
          return 1
        }
        export { useValue as "__proto__" }
      `,
      field: 'hooks' as const,
      expected: { directAccessor: 'signal' },
    },
  ])('preserves a __proto__ $label in published metadata', async ({ source, field, expected }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-library-special-metadata-key-'))
    const entry = path.join(root, 'index.ts')

    try {
      await writeFile(entry, source)

      const [metadata] = (await buildLibraryMetadata(root, entry)) as Record<
        string,
        Record<string, unknown>
      >[]
      const record = metadata?.[field]

      expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true)
      expect(record?.['__proto__']).toEqual(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes reactive namespace metadata from a library facade', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-library-namespace-metadata-'))
    const entry = path.join(root, 'index.ts')

    try {
      await writeFile(
        path.join(root, 'signals.ts'),
        `
          import { createMemo } from 'fict'
          export const count = createMemo(() => 1)
        `,
      )
      await writeFile(entry, `export * as signals from './signals'`)

      expect(await buildLibraryMetadata(root, entry)).toEqual([
        {
          version: 1,
          exports: {},
          namespaces: {
            signals: {
              version: 1,
              exports: { count: 'memo' },
            },
          },
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
