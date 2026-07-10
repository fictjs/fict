import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

function runCompiler(configuration: Configuration): Promise<Stats> {
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

async function buildFixture(
  files: Record<string, string>,
  options: { alias?: Record<string, string> | ((root: string) => Record<string, string>) } = {},
): Promise<{ bundlePath: string; root: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-webpack-cold-')))
  for (const [relativePath, source] of Object.entries(files)) {
    const filename = path.join(root, relativePath)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, source)
  }

  const outputPath = path.join(root, 'dist')
  const alias = typeof options.alias === 'function' ? options.alias(root) : options.alias
  try {
    await runCompiler({
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
        path: outputPath,
      },
      plugins: [new FictWebpackPlugin()],
      resolve: {
        ...(alias ? { alias } : {}),
        extensions: ['.tsx', '.ts', '.jsx', '.js'],
      },
      target: 'node',
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  return { bundlePath: path.join(outputPath, 'bundle.cjs'), root }
}

function runApp(bundlePath: string): number {
  const bundle = require(bundlePath) as { App(): number }
  const runtime = require(fictInternalEntry) as RuntimeInternal
  runtime.__fictPushContext()
  try {
    return bundle.App()
  } finally {
    runtime.__fictPopContext()
  }
}

describe('@fictjs/webpack-plugin cold metadata graph', () => {
  it('rebuilds an importer after its hook metadata becomes available', async () => {
    const fixture = await buildFixture({
      'entry.ts': `
        import { useCounter } from './use-counter'
        export function App() {
          const count = useCounter()
          return count * 2
        }
      `,
      'use-counter.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
    })

    try {
      expect(runApp(fixture.bundlePath)).toBe(2)
      const bundle = await readFile(fixture.bundlePath, 'utf8')
      expect(bundle).toMatch(/count\(\) \* 2/)
      expect(bundle).not.toMatch(/return count \* 2/)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('converges hook metadata through an aliased circular barrel', async () => {
    const fixture = await buildFixture(
      {
        'entry.ts': `
          import { useCounter } from '@hooks'
          export function App() {
            const count = useCounter()
            return count * 2
          }
        `,
        'hooks/index.ts': `
          export { useCounter } from './use-counter'
          export const marker = 1
        `,
        'hooks/use-counter.ts': `
          import { $state } from 'fict'
          import { marker } from './index'
          export function useCounter() {
            const count = $state(marker)
            return count
          }
        `,
      },
      { alias: root => ({ '@hooks': path.join(root, 'hooks') }) },
    )

    try {
      expect(runApp(fixture.bundlePath)).toBe(2)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
