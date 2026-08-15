import { rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import webpack, { type Stats } from 'webpack'

import {
  backdateFixtureInputs,
  buildAssetMatches,
  buildAssetSource,
  builtFixtureFiles,
  closeWatching,
  createBuildQueue,
  createFixture,
  createWebpackConfiguration,
  fixtureWatchOptions,
  runApp,
  runCompiler,
  waitForWatchingReady,
} from './fixture'

const signalHook = (value: number): string => `
  import { $state } from 'fict'
  export function useCounter() {
    const count = $state(${value})
    return count
  }
`

const plainHook = (value: number): string => `
  export function useCounter() {
    return ${value}
  }
`

const entrySource = `
  import { useCounter } from './use-counter'
  export function App() {
    const count = useCounter()
    return count * 2
  }
`

describe('@fictjs/webpack-plugin incremental metadata', () => {
  it('rebuilds unchanged importers across signal ↔ plain watch transitions', async () => {
    const root = await createFixture({
      'entry.ts': entrySource,
      'use-counter.ts': signalHook(1),
    })
    const hookPath = path.join(root, 'use-counter.ts')
    const compiler = webpack(createWebpackConfiguration(root))
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch(fixtureWatchOptions, (error, stats) => {
      builds.push(error, stats)
      // Model a trailing duplicate callback so each transition must select its own build result.
      builds.push(error, stats)
    })!

    try {
      await firstBuild
      expect(runApp(root)).toBe(2)
      await waitForWatchingReady(watching)

      const plainBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /return count\s*\*\s*2/),
        {
          description: 'the plain-hook runtime bundle',
        },
      )
      await writeFile(hookPath, plainHook(3))
      const plainStats = await plainBuild
      expect(runApp(root)).toBe(6)
      expect(builtFixtureFiles(plainStats, root)).toContain(path.join(root, 'entry.ts'))
      await waitForWatchingReady(watching)

      const signalBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        {
          description: 'the signal-hook runtime bundle',
        },
      )
      await writeFile(hookPath, signalHook(2))
      const signalStats = await signalBuild
      expect(runApp(root)).toBe(4)
      expect(builtFixtureFiles(signalStats, root)).toContain(path.join(root, 'entry.ts'))
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hydrates metadata from filesystem cache across Compiler instances', async () => {
    const root = await createFixture({
      'entry.ts': entrySource,
      'use-counter.ts': signalHook(1),
    })
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const entryPath = path.join(root, 'entry.ts')
    const hookPath = path.join(root, 'use-counter.ts')

    try {
      await backdateFixtureInputs([entryPath, hookPath])
      await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(2)

      const cachedStats = await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(2)
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])

      await writeFile(hookPath, plainHook(4))
      const changedStats = await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(8)
      expect(builtFixtureFiles(changedStats, root)).toContain(entryPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers watch output across rapid edits, compiler errors, and delete/recreate', async () => {
    const root = await createFixture({
      'entry.ts': entrySource,
      'use-counter.ts': signalHook(1),
    })
    const entryPath = path.join(root, 'entry.ts')
    const hookPath = path.join(root, 'use-counter.ts')
    const compiler = webpack(createWebpackConfiguration(root, { devtool: 'source-map' }))
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch(fixtureWatchOptions, (error, stats) => {
      builds.push(error, stats)
    })!

    const assertSourceMap = (stats: Stats): void => {
      const sourceMap = JSON.parse(buildAssetSource(stats, 'bundle.cjs.map')) as {
        mappings?: unknown
        sources?: unknown
      }
      expect(sourceMap.mappings).toEqual(expect.any(String))
      expect(sourceMap.mappings).not.toBe('')
      expect(sourceMap.sources).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/entry\.ts$/),
          expect.stringMatching(/use-counter\.ts$/),
        ]),
      )
    }

    try {
      const initialStats = await firstBuild
      expect(runApp(root)).toBe(2)
      assertSourceMap(initialStats)
      await waitForWatchingReady(watching, { files: [entryPath, hookPath] })

      const rapidBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        { description: 'the final signal-hook output after rapid edits' },
      )
      await writeFile(hookPath, plainHook(6))
      await writeFile(hookPath, signalHook(5))
      const rapidStats = await rapidBuild
      expect(runApp(root)).toBe(10)
      expect(builtFixtureFiles(rapidStats, root)).toContain(entryPath)
      assertSourceMap(rapidStats)
      await waitForWatchingReady(watching, { files: [entryPath, hookPath] })

      const failedBuild = builds.next()
      await writeFile(hookPath, 'export function useCounter( {')
      await expect(failedBuild).rejects.toThrow(/FICT-PARSE|Module build failed|Unexpected token/)
      await waitForWatchingReady(watching)

      const recoveredBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        { description: 'the compiler-error recovery output' },
      )
      await writeFile(hookPath, signalHook(4))
      const recoveredStats = await recoveredBuild
      expect(runApp(root)).toBe(8)
      assertSourceMap(recoveredStats)
      await waitForWatchingReady(watching, { files: [entryPath, hookPath] })

      const deletedBuild = builds.next()
      await unlink(hookPath)
      await expect(deletedBuild).rejects.toThrow(/FICT-H003|Module build failed|Module not found/)

      const recreatedBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        { description: 'the delete/recreate recovery output' },
      )
      await writeFile(hookPath, signalHook(7))
      const recreatedStats = await recreatedBuild
      expect(runApp(root)).toBe(14)
      expect(builtFixtureFiles(recreatedStats, root)).toContain(entryPath)
      assertSourceMap(recreatedStats)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })
})
