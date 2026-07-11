import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import webpack, {
  type Compilation,
  type Compiler,
  type Configuration,
  type Stats,
  type Watching,
} from 'webpack'

import { FictWebpackPlugin } from '../index'

const require = createRequire(import.meta.url)
const loaderPath = fileURLToPath(new URL('../../dist/loader.cjs', import.meta.url))
const fictEntry = require.resolve('fict')
const fictInternalEntry = require.resolve('fict/internal')
const capturedAssets = new WeakMap<Compilation, Map<string, string>>()
const assetCapturePlugin = {
  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap('FictFixtureAssetCapture', compilation => {
      compilation.hooks.processAssets.tap(
        {
          name: 'FictFixtureAssetCapture',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
        },
        assets => {
          capturedAssets.set(
            compilation,
            new Map(
              Object.entries(assets).map(([name, source]) => [name, source.source().toString()]),
            ),
          )
        },
      )
    })
  },
}

interface RuntimeInternal {
  __fictPopContext(): void
  __fictPushContext(): unknown
}

export async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-webpack-')))
  for (const [relativePath, source] of Object.entries(files)) {
    const filename = path.join(root, relativePath)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, source)
  }
  return root
}

export async function backdateFixtureInputs(filenames: readonly string[]): Promise<void> {
  // Webpack rejects snapshots when mtime + its filesystem-accuracy window is newer than the
  // compilation start. Baseline filesystem-cache tests must not depend on fixture creation timing.
  const stableTimestamp = new Date(Date.now() - 10_000)
  await Promise.all(filenames.map(filename => utimes(filename, stableTimestamp, stableTimestamp)))
}

export function createWebpackConfiguration(
  root: string,
  options: {
    alias?: Record<string, string>
    cache?: Configuration['cache']
    externals?: Record<string, string | string[]>
    loaderOptions?: Record<string, unknown>
    plugins?: NonNullable<Configuration['plugins']>
    snapshot?: Configuration['snapshot']
  } = {},
): Configuration {
  return {
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    context: root,
    devtool: false,
    entry: './entry.ts',
    externals: {
      fict: `commonjs ${fictEntry}`,
      'fict/internal': `commonjs ${fictInternalEntry}`,
      ...options.externals,
    },
    mode: 'development',
    module: {
      rules: [
        {
          include: root,
          test: /\.[cm]?[jt]sx?$/,
          use: [{ loader: loaderPath, options: { dev: false, ...options.loaderOptions } }],
        },
      ],
    },
    optimization: { minimize: false },
    output: {
      filename: 'bundle.cjs',
      library: { type: 'commonjs2' },
      path: path.join(root, 'dist'),
    },
    plugins: [assetCapturePlugin, new FictWebpackPlugin(), ...(options.plugins ?? [])],
    resolve: {
      ...(options.alias ? { alias: options.alias } : {}),
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
    },
    target: 'node',
  }
}

function validateStats(error: Error | null | undefined, stats: Stats | undefined): Stats {
  if (error) throw error
  if (!stats) throw new Error('Webpack returned no stats.')
  if (stats.hasErrors()) {
    throw new Error(stats.toString({ all: false, errors: true }))
  }
  return stats
}

export interface BuildQueue {
  next(): Promise<Stats>
  nextMatching(
    predicate: (stats: Stats) => boolean,
    options: { description: string; timeoutMs?: number },
  ): Promise<Stats>
  push(error: Error | null | undefined, stats: Stats | undefined): void
}

export function createBuildQueue(): BuildQueue {
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

  const waitNext = (signal?: AbortSignal): Promise<Stats> => {
    const abortReason = (): Error =>
      signal?.reason instanceof Error ? signal.reason : new Error('Build wait aborted.')
    if (signal?.aborted) return Promise.reject(abortReason())
    const result = queued.shift()
    if (result) {
      return Promise.resolve().then(() => validateStats(result.error, result.stats))
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
      const waiter = {
        resolve(stats: Stats): void {
          cleanup()
          resolve(stats)
        },
        reject(error: unknown): void {
          cleanup()
          reject(error)
        },
      }
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter)
        if (index < 0) return
        waiters.splice(index, 1)
        cleanup()
        reject(abortReason())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  return {
    next() {
      return waitNext()
    },
    async nextMatching(predicate, { description, timeoutMs = 10_000 }) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Build match timeout must be a positive finite number.')
      }
      let skippedBuilds = 0
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${description}; ` +
              `observed ${skippedBuilds} non-matching build(s).`,
          ),
        )
      }, timeoutMs)
      try {
        while (true) {
          const stats = await waitNext(controller.signal)
          if (predicate(stats)) return stats
          skippedBuilds++
        }
      } finally {
        clearTimeout(timeout)
      }
    },
    push(error, stats) {
      const waiter = waiters.shift()
      if (waiter) settle(waiter, { error, stats })
      else queued.push({ error, stats })
    },
  }
}

export function closeWatching(watching: Watching, compiler: Compiler): Promise<void> {
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

export function waitForWatchingReady(watching: Watching, timeoutMs = 10_000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Watch readiness timeout must be a positive finite number.'))
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const check = (): void => {
      if (watching.watcher) {
        finish()
        return
      }
      if (watching.closed) {
        finish(new Error('Webpack watcher closed before it became ready.'))
        return
      }
      if (Date.now() >= deadline) {
        finish(new Error(`Timed out after ${timeoutMs}ms waiting for the Webpack watcher.`))
        return
      }
      timer = setTimeout(check, 5)
    }
    check()
  })
}

export function builtFixtureFiles(stats: Stats, root: string): string[] {
  return [...stats.compilation.modules]
    .filter(module => stats.compilation.builtModules.has(module))
    .map(module => (module as { resource?: unknown }).resource)
    .filter(
      (resource): resource is string => typeof resource === 'string' && resource.startsWith(root),
    )
}

export function buildAssetMatches(
  stats: Stats,
  pattern: RegExp,
  assetName = 'bundle.cjs',
): boolean {
  const source = capturedAssets.get(stats.compilation)?.get(assetName)
  if (source === undefined) {
    throw new Error(`No captured Webpack asset named "${assetName}".`)
  }
  pattern.lastIndex = 0
  return pattern.test(source)
}

export function runCompiler(configuration: Configuration): Promise<Stats> {
  const compiler = webpack(configuration)
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error || closeError) {
          reject(error ?? closeError)
          return
        }
        if (!stats) {
          reject(new Error('Webpack returned no stats.'))
          return
        }
        if (stats.hasErrors()) {
          reject(new Error(stats.toString({ all: false, errors: true })))
          return
        }
        resolve(stats)
      })
    })
  })
}

export function runApp(root: string): number {
  const bundlePath = path.join(root, 'dist', 'bundle.cjs')
  delete require.cache[bundlePath]
  const bundle = require(bundlePath) as { App(): number }
  const runtime = require(fictInternalEntry) as RuntimeInternal
  runtime.__fictPushContext()
  try {
    return bundle.App()
  } finally {
    runtime.__fictPopContext()
  }
}
