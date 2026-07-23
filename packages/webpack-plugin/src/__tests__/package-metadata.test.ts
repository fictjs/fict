import { readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import webpack, { type Compiler, type Configuration, type Stats } from 'webpack'

import {
  backdateFixtureInputs,
  buildAssetMatches,
  builtFixtureFiles,
  closeWatching,
  createBuildQueue,
  createFixture,
  createWebpackConfiguration,
  runCompiler,
  waitForWatchingReady,
} from './fixture'

const entrySource = `
  import { useCounter } from 'hook-lib'
  export function App() {
    const count = useCounter()
    return count * 2
  }
`

const wrappedEntrySource = `
  import { useCounter } from './wrapper'
  export function App() {
    const count = useCounter()
    return count * 2
  }
`

const wrapperSource = `
  import { useCounter as usePackageCounter } from 'hook-lib'
  export function useCounter() {
    return usePackageCounter()
  }
`

const packageJson = (metadata: string): string =>
  JSON.stringify({
    name: 'hook-lib',
    version: '1.0.0',
    main: './index.js',
    fict: { metadata },
  })

function excludeHookPackage(
  configuration: Configuration,
  additionalRoots: readonly string[] = [],
): Configuration {
  const rule = configuration.module?.rules?.[0]
  if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
  rule.exclude = (resource: string) =>
    resource.includes(`${path.sep}node_modules${path.sep}`) ||
    additionalRoots.some(root => resource === root || resource.startsWith(`${root}${path.sep}`))
  return configuration
}

const hookMetadata = (reactive: boolean): string =>
  JSON.stringify({
    version: 1,
    exports: {},
    hooks: { useCounter: reactive ? { directAccessor: 'signal' } : {} },
  })

interface StoredWebpackMetadata {
  version: number
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
}

function storedMetadata(stats: Stats, resource: string): StoredWebpackMetadata {
  const candidates = [...stats.compilation.modules].filter(
    candidate => (candidate as { resource?: unknown }).resource === resource,
  ) as { buildInfo?: Record<string, unknown> }[]
  const stored = candidates
    .map(candidate => candidate.buildInfo?.fictWebpackMetadataV7)
    .filter(
      (metadata): metadata is Record<string, unknown> =>
        metadata !== null && typeof metadata === 'object',
    )
  if (stored.length !== 1) {
    throw new Error(
      `Expected one persisted Fict metadata record for ${resource}; ` +
        `found ${stored.length} across ${candidates.length} matching Webpack modules.`,
    )
  }
  return stored[0] as unknown as StoredWebpackMetadata
}

async function readBundle(root: string): Promise<string> {
  return readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
}

function createRebuildObserver(): {
  builtBeforeFict: string[]
  plugin: { apply(compiler: Compiler): void }
  rebuiltByFict: string[]
} {
  const observation = {
    builtBeforeFict: [] as string[],
    rebuiltByFict: [] as string[],
    plugin: {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictWebpackTestObserver', compilation => {
          observation.rebuiltByFict = []
          compilation.hooks.rebuildModule.tap('FictWebpackTestObserver', module => {
            const resource = (module as { resource?: unknown }).resource
            if (typeof resource === 'string') observation.rebuiltByFict.push(resource)
          })
        })
        compiler.hooks.finishMake.tap(
          { name: 'FictWebpackTestObserver', stage: Number.MAX_SAFE_INTEGER - 1 },
          compilation => {
            observation.builtBeforeFict = [...compilation.modules]
              .filter(module => compilation.builtModules.has(module))
              .map(module => (module as { resource?: unknown }).resource)
              .filter((resource): resource is string => typeof resource === 'string')
          },
        )
      },
    },
  }
  return observation
}

describe('@fictjs/webpack-plugin package metadata', () => {
  it('selects persisted metadata by module identity when resources are duplicated', () => {
    const resource = '/virtual/entry.ts'
    const expected: StoredWebpackMetadata = {
      version: 7,
      incomplete: false,
      dependencyFingerprint: 'fingerprint',
      metadataDependencies: [],
    }
    const stats = {
      compilation: {
        modules: new Set([
          { resource, buildInfo: {} },
          { resource, buildInfo: { fictWebpackMetadataV7: expected } },
        ]),
      },
    } as unknown as Stats

    expect(storedMetadata(stats, resource)).toBe(expected)
  })

  it('watches package manifests and sidecars and rebuilds their importer', async () => {
    const root = await createFixture({
      'entry.ts': entrySource,
      'node_modules/hook-lib/index.js': 'exports.useCounter = () => 1',
      'node_modules/hook-lib/package.json': packageJson('./hook.fict.meta.json'),
      'node_modules/hook-lib/hook.fict.meta.json': hookMetadata(true),
      'node_modules/hook-lib/reactive-again.fict.meta.json': hookMetadata(true),
    })
    const entryPath = path.join(root, 'entry.ts')
    const packagePath = path.join(root, 'node_modules', 'hook-lib', 'package.json')
    const sidecarPath = path.join(root, 'node_modules', 'hook-lib', 'hook.fict.meta.json')
    const secondSidecarPath = path.join(
      root,
      'node_modules',
      'hook-lib',
      'reactive-again.fict.meta.json',
    )
    const compiler = webpack(excludeHookPackage(createWebpackConfiguration(root)))
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      const firstStored = storedMetadata(firstStats, entryPath)
      expect(firstStored.metadataDependencies).toEqual([packagePath, sidecarPath].sort())
      expect(firstStats.compilation.fileDependencies).toContain(packagePath)
      expect(firstStats.compilation.fileDependencies).toContain(sidecarPath)
      await waitForWatchingReady(watching, { files: [packagePath, sidecarPath] })

      const sidecarBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /return count\s*\*\s*2/),
        { description: 'the plain sidecar bundle' },
      )
      await writeFile(sidecarPath, hookMetadata(false))
      const sidecarStats = await sidecarBuild
      const plainBundle = await readBundle(root)
      expect(plainBundle).toMatch(/return count\s*\*\s*2/)
      expect(plainBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(sidecarStats, root)).toContain(entryPath)
      const sidecarStored = storedMetadata(sidecarStats, entryPath)
      expect(sidecarStored.dependencyFingerprint).not.toBe(firstStored.dependencyFingerprint)
      await waitForWatchingReady(watching, { files: [packagePath, sidecarPath] })

      const manifestBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        { description: 'the reactive manifest bundle' },
      )
      await writeFile(packagePath, packageJson('./reactive-again.fict.meta.json'))
      const manifestStats = await manifestBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(manifestStats, root)).toContain(entryPath)
      const manifestStored = storedMetadata(manifestStats, entryPath)
      expect(manifestStored.metadataDependencies).toEqual([packagePath, secondSidecarPath].sort())
      expect(manifestStored.dependencyFingerprint).not.toBe(sidecarStored.dependencyFingerprint)
      expect(manifestStats.compilation.fileDependencies).toContain(secondSidecarPath)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates a filesystem-cached importer from the sidecar content fingerprint', async () => {
    const signalMetadata = hookMetadata(true)
    const plainMetadata = hookMetadata(false).padEnd(signalMetadata.length, ' ')
    const root = await createFixture({
      'entry.ts': wrappedEntrySource,
      'wrapper.ts': wrapperSource,
      'node_modules/hook-lib/index.js': 'exports.useCounter = () => 1',
      'node_modules/hook-lib/package.json': packageJson('./hook.fict.meta.json'),
      'node_modules/hook-lib/hook.fict.meta.json': signalMetadata,
    })
    const entryPath = path.join(root, 'entry.ts')
    const wrapperPath = path.join(root, 'wrapper.ts')
    const sidecarPath = path.join(root, 'node_modules', 'hook-lib', 'hook.fict.meta.json')
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const rebuildObserver = createRebuildObserver()
    const configuration = () =>
      excludeHookPackage(
        createWebpackConfiguration(root, {
          cache,
          plugins: [rebuildObserver.plugin],
        }),
      )

    try {
      expect(Buffer.byteLength(plainMetadata)).toBe(Buffer.byteLength(signalMetadata))
      await backdateFixtureInputs([
        entryPath,
        wrapperPath,
        path.join(root, 'node_modules', 'hook-lib', 'index.js'),
        path.join(root, 'node_modules', 'hook-lib', 'package.json'),
        sidecarPath,
      ])

      const firstStats = await runCompiler(configuration())
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      const firstStored = storedMetadata(firstStats, wrapperPath)

      const cachedStats = await runCompiler(configuration())
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])
      expect(rebuildObserver.builtBeforeFict).toEqual([])
      expect(rebuildObserver.rebuiltByFict).toEqual([])

      const originalStat = await stat(sidecarPath)
      await writeFile(sidecarPath, plainMetadata)
      await utimes(sidecarPath, originalStat.atime, originalStat.mtime)

      const changedStats = await runCompiler(configuration())
      const changedBundle = await readBundle(root)
      expect(changedBundle).toMatch(/return count\s*\*\s*2/)
      expect(changedBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(rebuildObserver.builtBeforeFict).not.toContain(entryPath)
      expect(rebuildObserver.builtBeforeFict).not.toContain(wrapperPath)
      expect(rebuildObserver.rebuiltByFict).toContain(wrapperPath)
      expect(rebuildObserver.rebuiltByFict).toContain(entryPath)
      expect(builtFixtureFiles(changedStats, root)).toContain(entryPath)
      expect(builtFixtureFiles(changedStats, root)).toContain(wrapperPath)
      expect(storedMetadata(changedStats, wrapperPath).dependencyFingerprint).not.toBe(
        firstStored.dependencyFingerprint,
      )

      const recachedStats = await runCompiler(configuration())
      expect(await readBundle(root)).toMatch(/return count\s*\*\s*2/)
      expect(builtFixtureFiles(recachedStats, root)).toEqual([])
      expect(rebuildObserver.rebuiltByFict).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('watches the real sidecar behind a managed symlinked package', async () => {
    const root = await createFixture({
      'entry.ts': entrySource,
      'node_modules/.keep': '',
      'packages/hook-lib/index.js': 'exports.useCounter = () => 1',
      'packages/hook-lib/package.json': packageJson('./hook.fict.meta.json'),
      'packages/hook-lib/hook.fict.meta.json': hookMetadata(true),
    })
    const entryPath = path.join(root, 'entry.ts')
    const packageLink = path.join(root, 'node_modules', 'hook-lib')
    const realPackage = path.join(root, 'packages', 'hook-lib')
    const lexicalPackagePath = path.join(packageLink, 'package.json')
    const lexicalSidecarPath = path.join(packageLink, 'hook.fict.meta.json')
    const realPackagePath = path.join(realPackage, 'package.json')
    const realSidecarPath = path.join(realPackage, 'hook.fict.meta.json')
    await symlink(realPackage, packageLink, process.platform === 'win32' ? 'junction' : 'dir')

    const compiler = webpack(
      excludeHookPackage(
        createWebpackConfiguration(root, {
          snapshot: { managedPaths: [path.join(root, 'node_modules')] },
        }),
        [realPackage],
      ),
    )
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(storedMetadata(firstStats, entryPath).metadataDependencies).toEqual(
        [lexicalPackagePath, lexicalSidecarPath, realPackagePath, realSidecarPath].sort(),
      )
      await waitForWatchingReady(watching, {
        files: [lexicalPackagePath, lexicalSidecarPath, realPackagePath, realSidecarPath],
      })

      const rebuilt = builds.nextMatching(
        stats => buildAssetMatches(stats, /return count\s*\*\s*2/),
        { description: 'the plain managed-package bundle' },
      )
      await writeFile(realSidecarPath, hookMetadata(false))
      const changedStats = await rebuilt
      const changedBundle = await readBundle(root)
      expect(changedBundle).toMatch(/return count\s*\*\s*2/)
      expect(changedBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(changedStats, root)).toContain(entryPath)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })
})
