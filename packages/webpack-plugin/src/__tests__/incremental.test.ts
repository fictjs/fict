import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import webpack, { type Compiler, type Stats, type Watching } from 'webpack'

import { createFixture, createWebpackConfiguration, runApp, runCompiler } from './fixture'

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

function validateStats(error: Error | null | undefined, stats: Stats | undefined): Stats {
  if (error) throw error
  if (!stats) throw new Error('Webpack returned no stats.')
  if (stats.hasErrors()) {
    throw new Error(stats.toString({ all: false, errors: true }))
  }
  return stats
}

interface BuildQueue {
  next(): Promise<Stats>
  push(error: Error | null | undefined, stats: Stats | undefined): void
}

function createBuildQueue(): BuildQueue {
  const queued: { error: Error | null | undefined; stats: Stats | undefined }[] = []
  const waiters: {
    resolve: (stats: Stats) => void
    reject: (error: unknown) => void
  }[] = []

  const settle = (waiter: (typeof waiters)[number], result: (typeof queued)[number]): void => {
    try {
      waiter.resolve(validateStats(result.error, result.stats))
    } catch (error) {
      waiter.reject(error)
    }
  }

  return {
    next() {
      const result = queued.shift()
      if (result) {
        return Promise.resolve().then(() => validateStats(result.error, result.stats))
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    push(error, stats) {
      const waiter = waiters.shift()
      if (waiter) settle(waiter, { error, stats })
      else queued.push({ error, stats })
    },
  }
}

function closeWatching(watching: Watching, compiler: Compiler): Promise<void> {
  return new Promise((resolve, reject) => {
    watching.close(watchError => {
      if (watchError) {
        reject(watchError)
        return
      }
      compiler.close(closeError => {
        if (closeError) reject(closeError)
        else resolve()
      })
    })
  })
}

function builtFixtureFiles(stats: Stats, root: string): string[] {
  return [...stats.compilation.modules]
    .filter(module => stats.compilation.builtModules.has(module))
    .map(module => (module as { resource?: unknown }).resource)
    .filter(
      (resource): resource is string => typeof resource === 'string' && resource.startsWith(root),
    )
}

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
    const watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      await firstBuild
      expect(runApp(root)).toBe(2)

      const plainBuild = builds.next()
      await writeFile(hookPath, plainHook(3))
      const plainStats = await plainBuild
      expect(runApp(root)).toBe(6)
      expect(builtFixtureFiles(plainStats, root)).toContain(path.join(root, 'entry.ts'))

      const signalBuild = builds.next()
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

    try {
      await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(2)

      const cachedStats = await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(2)
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])

      await writeFile(path.join(root, 'use-counter.ts'), plainHook(4))
      const changedStats = await runCompiler(createWebpackConfiguration(root, { cache }))
      expect(runApp(root)).toBe(8)
      expect(builtFixtureFiles(changedStats, root)).toContain(path.join(root, 'entry.ts'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
