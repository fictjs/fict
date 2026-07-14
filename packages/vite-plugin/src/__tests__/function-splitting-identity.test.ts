import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'

import createFictVitePlugin, { __fictVitePluginInternals, registerExtractedHandler } from '..'
import type { FictNode } from '../../../runtime/src/types'
import { renderToString } from '../../../ssr/src/index'

function fict(
  options?: Parameters<typeof createFictVitePlugin>[0],
): ReturnType<typeof createFictVitePlugin> {
  return createFictVitePlugin({ backend: 'legacy', ...options })
}

interface BuildArtifact {
  fileName: string
  source: string
}

interface ResumableBuildArtifact extends BuildArtifact {
  isEntry: boolean
}

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

async function linkFixtureRuntime(root: string): Promise<void> {
  const nodeModulesDir = path.join(root, 'node_modules')
  await mkdir(nodeModulesDir, { recursive: true })
  await symlink(
    path.join(workspaceRoot, 'packages/fict'),
    path.join(nodeModulesDir, 'fict'),
    'junction',
  )
}

async function writeResumableIdentityFixture(root: string): Promise<string> {
  const sourceDir = path.join(root, 'src')
  const entry = path.join(sourceDir, 'Counter.tsx')
  await mkdir(sourceDir, { recursive: true })
  await linkFixtureRuntime(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'identity-fixture', type: 'module' }),
  )
  await writeFile(path.join(sourceDir, 'plain.ts'), `export const label = 'stable'\n`)
  await writeFile(
    entry,
    `
      import { $state } from 'fict'
      import { label } from './plain'

      export function Counter() {
        let count = $state(1)
        return <button onClick$={() => count++}>{label}:{count}</button>
      }
    `,
  )
  return entry
}

async function buildResumableIdentityFixture(
  root: string,
  target: 'client' | 'ssr',
): Promise<ResumableBuildArtifact[]> {
  const entry = await writeResumableIdentityFixture(root)
  const isSsr = target === 'ssr'
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      fict({
        cache: false,
        useTypeScriptProject: false,
        functionSplitting: true,
        resumable: true,
      }),
    ],
    build: {
      write: false,
      sourcemap: false,
      ...(isSsr
        ? { ssr: entry }
        : { lib: { entry, formats: ['es'], fileName: () => 'client.js' } }),
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
        output: {
          entryFileNames: isSsr ? 'server.mjs' : undefined,
          chunkFileNames: 'chunks/[name].js',
        },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output =>
    'output' in output ? output.output : [],
  ) as Rollup.OutputFile[]

  return outputs.map(output => ({
    fileName: output.fileName,
    isEntry: output.type === 'chunk' && output.isEntry,
    source: output.type === 'chunk' ? output.code : String(output.source),
  }))
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
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'function-splitting-fixture', version: '1.0.0', type: 'module' }),
  )
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

async function buildMacroFixture(
  root: string,
  entryName: string,
  source = `
    import { $state } from 'fict'

    export function Counter() {
      let count = $state(0)
      return <button onClick$={() => count++}>{count}</button>
    }
  `,
): Promise<BuildArtifact[]> {
  const sourceDir = path.join(root, 'src')
  const entry = path.join(sourceDir, entryName)
  await mkdir(sourceDir, { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'macro-splitting-fixture', version: '1.0.0', type: 'module' }),
  )
  await writeFile(entry, source)

  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      fict({
        cache: false,
        useTypeScriptProject: false,
        functionSplitting: true,
        resumable: true,
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

async function writePreservedSymlinkFixture(root: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(root, 'shared'), { recursive: true }),
    mkdir(path.join(root, 'src', 'a'), { recursive: true }),
    mkdir(path.join(root, 'src', 'b'), { recursive: true }),
  ])
  await linkFixtureRuntime(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'preserved-symlink-fixture', version: '1.0.0', type: 'module' }),
  )
  await writeFile(
    path.join(root, 'shared', 'Counter.tsx'),
    `
      import { label } from './config'

      export function Counter() {
        return (
          <button onClick$={() => { globalThis.__fictPreservedLabel = label }}>
            {label}
          </button>
        )
      }
    `,
  )
  await Promise.all([
    writeFile(path.join(root, 'shared', 'config.ts'), `export const label = 'BASE'\n`),
    writeFile(path.join(root, 'src', 'a', 'config.ts'), `export const label = 'A'\n`),
    writeFile(path.join(root, 'src', 'b', 'config.ts'), `export const label = 'B'\n`),
    symlink('../../shared/Counter.tsx', path.join(root, 'src', 'a', 'Counter.tsx')),
    symlink('../../shared/Counter.tsx', path.join(root, 'src', 'b', 'Counter.tsx')),
    writeFile(
      path.join(root, 'src', 'entry.ts'),
      `
        export { Counter as CounterA } from './a/Counter'
        export { Counter as CounterB } from './b/Counter'
      `,
    ),
  ])
}

async function buildPreservedSymlinkFixture(
  root: string,
  preserveSymlinks: boolean,
): Promise<BuildArtifact[]> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { preserveSymlinks },
    plugins: [
      fict({
        cache: false,
        useTypeScriptProject: false,
        functionSplitting: true,
        resumable: true,
      }),
    ],
    build: {
      write: false,
      lib: {
        entry: path.join(root, 'src', 'entry.ts'),
        formats: ['es'],
        fileName: () => 'app.js',
      },
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

  it('keeps preserve-symlinks identities stable across root path aliases', async () => {
    const realRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-symlink-root-real-')))
    const aliasParent = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fict-symlink-root-alias-')),
    )
    const aliasRoot = path.join(aliasParent, 'project')
    const realModule = path.join(realRoot, 'src', 'Counter.tsx')
    const aliasModule = path.join(aliasRoot, 'src', 'Counter.tsx')

    try {
      await mkdir(path.dirname(realModule), { recursive: true })
      await Promise.all([
        writeFile(
          path.join(realRoot, 'package.json'),
          JSON.stringify({ name: 'root-alias-fixture', version: '1.0.0' }),
        ),
        writeFile(realModule, 'export function Counter() {}'),
      ])
      await symlink(realRoot, aliasRoot, 'junction')

      const realPublicId = __fictVitePluginInternals.createPublicModuleId(
        realModule,
        realRoot,
        undefined,
        true,
      )
      const aliasPublicId = __fictVitePluginInternals.createPublicModuleId(
        aliasModule,
        aliasRoot,
        undefined,
        true,
      )
      const realHandlerId = __fictVitePluginInternals.createHandlerId(
        realModule,
        '__fict_e0',
        realRoot,
        undefined,
        true,
      )
      const aliasHandlerId = __fictVitePluginInternals.createHandlerId(
        aliasModule,
        '__fict_e0',
        aliasRoot,
        undefined,
        true,
      )

      expect(aliasPublicId).toBe(realPublicId)
      expect(aliasHandlerId).toBe(realHandlerId)
      expect(__fictVitePluginInternals.createPublicModuleId(aliasModule, aliasRoot)).toBe(
        __fictVitePluginInternals.createPublicModuleId(realModule, realRoot),
      )
      expect(__fictVitePluginInternals.createHandlerId(aliasModule, '__fict_e0', aliasRoot)).toBe(
        __fictVitePluginInternals.createHandlerId(realModule, '__fict_e0', realRoot),
      )
    } finally {
      await Promise.all([
        rm(aliasParent, { recursive: true, force: true }),
        rm(realRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('preserves logical symlink module identities only when Vite preserves symlinks', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-preserved-symlinks-')))

    try {
      await writePreservedSymlinkFixture(root)
      const [physicalArtifacts, logicalArtifacts] = await Promise.all([
        buildPreservedSymlinkFixture(root, false),
        buildPreservedSymlinkFixture(root, true),
      ])
      const readManifest = (artifacts: BuildArtifact[]) =>
        JSON.parse(
          artifacts.find(artifact => artifact.fileName === 'fict.manifest.json')!.source,
        ) as Record<string, string>
      const manifestKeys = (artifacts: BuildArtifact[], prefix: string) =>
        Object.keys(readManifest(artifacts)).filter(key => key.startsWith(prefix))

      expect(manifestKeys(physicalArtifacts, 'fict:module:')).toHaveLength(1)
      expect(manifestKeys(physicalArtifacts, 'virtual:fict-handler:')).toHaveLength(1)
      expect(manifestKeys(logicalArtifacts, 'fict:module:')).toHaveLength(2)
      expect(manifestKeys(logicalArtifacts, 'virtual:fict-handler:')).toHaveLength(2)

      const logicalJavaScript = logicalArtifacts
        .filter(artifact => artifact.fileName.endsWith('.js'))
        .map(artifact => artifact.source)
        .join('\n')
      expect(logicalJavaScript).toContain('"A"')
      expect(logicalJavaScript).toContain('"B"')
      expect(logicalJavaScript).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not emit an empty resumability manifest for a build without QRL owners', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-empty-manifest-')))
    try {
      const artifacts = await buildMacroFixture(
        root,
        'plain.ts',
        'export const answer: number = 42',
      )
      expect(artifacts.some(artifact => artifact.fileName === 'fict.manifest.json')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps public resumable identities private and interoperable across checkout roots', async () => {
    const clientRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-public-client-')))
    const serverRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-public-server-')))
    const globalRecord = globalThis as Record<string, unknown>

    try {
      const [clientArtifacts, serverArtifacts] = await Promise.all([
        buildResumableIdentityFixture(clientRoot, 'client'),
        buildResumableIdentityFixture(serverRoot, 'ssr'),
      ])
      const manifestArtifact = clientArtifacts.find(
        artifact => artifact.fileName === 'fict.manifest.json',
      )
      expect(manifestArtifact).toBeDefined()
      const manifest = JSON.parse(manifestArtifact!.source) as Record<string, string>
      const manifestKeys = Object.keys(manifest)
      const publicKeys = manifestKeys.filter(key => key.startsWith('fict:module:'))
      const handlerKeys = manifestKeys.filter(key => key.startsWith('virtual:fict-handler:'))

      expect(publicKeys).toHaveLength(1)
      expect(publicKeys[0]).toMatch(/^fict:module:m[a-f0-9]{32}$/)
      expect(handlerKeys).toHaveLength(1)
      expect(manifestKeys).toHaveLength(2)
      expect(manifestKeys.every(key => !key.startsWith('file://'))).toBe(true)

      const publicKey = publicKeys[0]!
      const clientJavaScript = clientArtifacts
        .filter(artifact => artifact.fileName.endsWith('.js'))
        .map(artifact => artifact.source)
        .join('\n')
      const serverJavaScript = serverArtifacts
        .filter(artifact => artifact.fileName.endsWith('.js') || artifact.fileName.endsWith('.mjs'))
        .map(artifact => artifact.source)
        .join('\n')
      const publicArtifacts = `${clientJavaScript}\n${serverJavaScript}\n${manifestArtifact!.source}`

      expect(serverJavaScript).toContain(publicKey)
      expect(publicArtifacts).not.toContain(clientRoot)
      expect(publicArtifacts).not.toContain(serverRoot)
      expect(publicArtifacts).not.toContain(pathToFileURL(clientRoot).href)
      expect(publicArtifacts).not.toContain(pathToFileURL(serverRoot).href)

      const serverOutputDir = path.join(serverRoot, 'test-output')
      for (const artifact of serverArtifacts) {
        const outputPath = path.join(serverOutputDir, artifact.fileName)
        await mkdir(path.dirname(outputPath), { recursive: true })
        await writeFile(outputPath, artifact.source)
      }
      const serverEntry = serverArtifacts.find(artifact => artifact.isEntry)
      expect(serverEntry).toBeDefined()
      const serverEntryUrl = pathToFileURL(path.join(serverOutputDir, serverEntry!.fileName)).href

      delete globalRecord.__FICT_MANIFEST__
      const missingManifestModule = (await import(`${serverEntryUrl}?manifest=missing`)) as {
        Counter: (props?: Record<string, unknown>) => FictNode
      }
      const missingManifestHtml = renderToString(() => ({
        type: missingManifestModule.Counter,
        props: {},
      }))
      expect(missingManifestHtml).toContain(publicKey)
      expect(missingManifestHtml).not.toContain('/@fs/')
      expect(missingManifestHtml).not.toContain(clientRoot)
      expect(missingManifestHtml).not.toContain(serverRoot)

      globalRecord.__FICT_MANIFEST__ = manifest
      const mappedModule = (await import(`${serverEntryUrl}?manifest=client-a`)) as {
        Counter: (props?: Record<string, unknown>) => FictNode
      }
      const mappedHtml = renderToString(() => ({ type: mappedModule.Counter, props: {} }), {
        includeSnapshot: true,
        manifest,
      })
      const snapshot = mappedHtml.match(
        /<script[^>]*(?:data-fict-snapshot|id="__FICT_SNAPSHOT__")[^>]*>([\s\S]*?)<\/script>/,
      )?.[1]

      expect(snapshot).toBeDefined()
      expect(mappedHtml).toContain(manifest[publicKey]!)
      expect(mappedHtml).toContain(handlerKeys[0]!)
      expect(mappedHtml).not.toContain(clientRoot)
      expect(mappedHtml).not.toContain(serverRoot)
      expect(snapshot).not.toContain(clientRoot)
      expect(snapshot).not.toContain(serverRoot)
    } finally {
      delete globalRecord.__FICT_MANIFEST__
      await Promise.all([
        rm(clientRoot, { recursive: true, force: true }),
        rm(serverRoot, { recursive: true, force: true }),
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

  it.each(['Counter#physical.tsx', 'Counter?physical.tsx'])(
    'compiles macros and splits handlers from the physical file %s',
    async entryName => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-handler-url-name-')))
      try {
        const artifacts = await buildMacroFixture(root, entryName)
        const chunks = artifacts
          .filter(artifact => artifact.fileName !== 'fict.manifest.json')
          .map(artifact => artifact.source)
          .join('\n')

        expect(chunks).not.toContain('$state')
        expect(chunks).toContain('virtual:fict-handler:')
        expect(artifacts.some(artifact => artifact.fileName.includes('handler-__fict_e0'))).toBe(
          true,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('preserves prevent-default QRL flags when splitting a production handler', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-handler-flags-')))
    try {
      const artifacts = await buildMacroFixture(
        root,
        'Counter.tsx',
        `
          import { $state } from 'fict'

          export function Counter() {
            let count = $state(0)
            return (
              <button onClick$={(event) => {
                event.preventDefault()
                count++
              }}>
                {count}
              </button>
            )
          }
        `,
      )
      const app = artifacts.find(artifact => artifact.fileName === 'app.js')?.source ?? ''
      const manifest = JSON.parse(
        artifacts.find(artifact => artifact.fileName === 'fict.manifest.json')!.source,
      ) as Record<string, string>
      const handlerEntries = Object.entries(manifest).filter(([key]) =>
        key.startsWith('virtual:fict-handler:'),
      )
      const handlerChunk = artifacts.find(artifact =>
        artifact.fileName.includes('handler-__fict_e0'),
      )

      expect(handlerEntries).toHaveLength(1)
      expect(handlerChunk).toBeDefined()
      expect(handlerEntries[0]?.[1]).toContain(handlerChunk!.fileName)
      expect(app).toContain(JSON.stringify(handlerEntries[0]?.[0]))
      expect(app).toMatch(
        /[\w$]+\(\s*["']virtual:fict-handler:h[a-f0-9]{32}\$\$__fict_e0["']\s*,\s*["']default["']\s*,\s*["']pd["']\s*\)/,
      )
      expect(app).not.toMatch(/["']__fict_e0["']/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
