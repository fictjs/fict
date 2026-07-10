import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import webpack, { type Compiler, type Configuration, type Stats, type Watching } from 'webpack'

import { FictWebpackPlugin } from '../index'

const require = createRequire(import.meta.url)
const loaderPath = fileURLToPath(new URL('../../dist/loader.cjs', import.meta.url))
const fictEntry = require.resolve('fict')
const fictInternalEntry = require.resolve('fict/internal')

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

export function createWebpackConfiguration(
  root: string,
  options: {
    alias?: Record<string, string>
    cache?: Configuration['cache']
    externals?: Record<string, string>
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
          use: [{ loader: loaderPath, options: { dev: false } }],
        },
      ],
    },
    optimization: { minimize: false },
    output: {
      filename: 'bundle.cjs',
      library: { type: 'commonjs2' },
      path: path.join(root, 'dist'),
    },
    plugins: [new FictWebpackPlugin(), ...(options.plugins ?? [])],
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

export function builtFixtureFiles(stats: Stats, root: string): string[] {
  return [...stats.compilation.modules]
    .filter(module => stats.compilation.builtModules.has(module))
    .map(module => (module as { resource?: unknown }).resource)
    .filter(
      (resource): resource is string => typeof resource === 'string' && resource.startsWith(root),
    )
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
