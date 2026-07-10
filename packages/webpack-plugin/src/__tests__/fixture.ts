import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import webpack, { type Configuration, type Stats } from 'webpack'

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
  } = {},
): Configuration {
  return {
    ...(options.cache ? { cache: options.cache } : {}),
    context: root,
    devtool: false,
    entry: './entry.ts',
    externals: {
      fict: `commonjs ${fictEntry}`,
      'fict/internal': `commonjs ${fictInternalEntry}`,
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
    plugins: [new FictWebpackPlugin()],
    resolve: {
      ...(options.alias ? { alias: options.alias } : {}),
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
    },
    target: 'node',
  }
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
