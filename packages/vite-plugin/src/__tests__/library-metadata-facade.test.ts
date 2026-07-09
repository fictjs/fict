import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'

import fict from '..'

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
})
