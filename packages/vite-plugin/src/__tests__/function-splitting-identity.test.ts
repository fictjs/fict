import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'

import fict, { registerExtractedHandler } from '..'

interface BuildArtifact {
  fileName: string
  source: string
}

async function buildFixture(
  root: string,
  entryName = 'App.js',
  cache: NonNullable<Parameters<typeof fict>[0]>['cache'] = false,
): Promise<BuildArtifact[]> {
  const sourceDir = path.join(root, 'src')
  const entry = path.join(sourceDir, entryName)
  await mkdir(sourceDir, { recursive: true })
  await writeFile(
    entry,
    `
      import { __fictQrl } from 'fict/internal'
      const config = { step: 1 }
      export const __fict_e0 = () => config.step
      export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0')
    `,
  )

  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      fict({
        cache,
        useTypeScriptProject: false,
        functionSplitting: true,
      }),
    ],
    build: {
      write: false,
      lib: { entry, formats: ['es'], fileName: () => 'app.js' },
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
        output: { chunkFileNames: 'chunks/[name].js' },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output =>
    'output' in output ? output.output : [],
  ) as Rollup.OutputFile[]

  return outputs.map(output => ({
    fileName: output.fileName,
    source: output.type === 'chunk' ? output.code : String(output.source),
  }))
}

describe('function splitting build identity', () => {
  it('keeps manually registered handler IDs opaque and loadable', () => {
    const sourceModule = String.raw`C:\private build\App #?.tsx`
    const virtualUrl = registerExtractedHandler(sourceModule, '__fict_e_manual', [], '() => 42')
    expect(virtualUrl).toMatch(/^virtual:fict-handler:h[a-f0-9]{32}\$\$__fict_e_manual$/)
    expect(virtualUrl).not.toContain(sourceModule)

    const plugin = fict({ functionSplitting: true }) as any
    const resolved = plugin.resolveId(virtualUrl)
    expect(resolved).toBe(`\0${virtualUrl.slice('virtual:'.length)}`)
    const loaded = plugin.load(resolved)
    expect(loaded).toContain('export default () => 42')
  })

  it('emits root-stable public handler identities', async () => {
    const firstRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-handler-first-')))
    const secondRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-handler-second-')))
    try {
      const [first, second] = await Promise.all([buildFixture(firstRoot), buildFixture(secondRoot)])
      const chunks = (artifacts: BuildArtifact[]) =>
        artifacts
          .filter(artifact => artifact.fileName !== 'fict.manifest.json')
          .sort((left, right) => left.fileName.localeCompare(right.fileName))
      expect(chunks(first)).toEqual(chunks(second))

      const handlerManifestEntries = (artifacts: BuildArtifact[]) => {
        const manifest = JSON.parse(
          artifacts.find(artifact => artifact.fileName === 'fict.manifest.json')!.source,
        ) as Record<string, string>
        // Ordinary file:// entries serve unsplit QRLs and have a separate identity contract.
        return Object.entries(manifest).filter(([key]) => key.startsWith('virtual:fict-handler:'))
      }
      const firstHandlers = handlerManifestEntries(first)
      const secondHandlers = handlerManifestEntries(second)
      expect(firstHandlers).toEqual(secondHandlers)
      expect(firstHandlers).toHaveLength(1)
      expect(firstHandlers[0]?.[0]).toMatch(/^virtual:fict-handler:h[a-f0-9]{32}\$\$__fict_e0$/)
      expect(JSON.stringify(firstHandlers)).not.toContain(firstRoot)
      expect(JSON.stringify(secondHandlers)).not.toContain(secondRoot)
    } finally {
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('restores stable split handlers from the persistent cache', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-handler-cache-')))
    const cacheDir = path.join(root, '.cache')
    try {
      const cache = { persistent: true, dir: cacheDir } as const
      const first = await buildFixture(root, 'App.js', cache)
      expect((await readdir(cacheDir)).some(file => file.endsWith('.json'))).toBe(true)

      const second = await buildFixture(root, 'App.js', cache)
      expect(second).toEqual(first)
      expect(second.find(artifact => artifact.fileName === 'fict.manifest.json')?.source).toMatch(
        /virtual:fict-handler:h[a-f0-9]{32}\$\$__fict_e0/,
      )
      expect(second.some(artifact => artifact.fileName.includes('handler-__fict_e0'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['App with space.js', String.raw`App\backslash.js`])(
    'builds a split handler from %s',
    async entryName => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict handler special ')))
      try {
        const artifacts = await buildFixture(root, entryName)
        expect(artifacts.some(artifact => artifact.fileName === 'fict.manifest.json')).toBe(true)
        expect(artifacts.some(artifact => artifact.fileName.includes('handler-__fict_e0'))).toBe(
          true,
        )
        expect(
          artifacts.find(artifact => artifact.fileName === 'fict.manifest.json')?.source,
        ).toMatch(/virtual:fict-handler:h[a-f0-9]{32}\$\$__fict_e0/)
        const emittedChunks = artifacts
          .filter(artifact => artifact.fileName !== 'fict.manifest.json')
          .map(artifact => artifact.source)
          .join('\n')
        expect(emittedChunks).not.toContain(root)
        expect(emittedChunks).not.toContain(entryName)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
