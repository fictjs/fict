#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import fict from '../packages/vite-plugin/dist/index.js'
import { isolatedNpmEnvironment } from './lib/npm-smoke-environment.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const requireFromVitePlugin = createRequire(
  path.join(repositoryRoot, 'packages', 'vite-plugin', 'package.json'),
)
const { build } = await import(pathToFileURL(requireFromVitePlugin.resolve('vite')).href)
const nativeCompilerPath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target', 'release', 'fict_compiler_napi.node'),
)
await access(nativeCompilerPath)

function parsePackEntry(stdout) {
  const parsed = JSON.parse(stdout)
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed)
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.equal(typeof entry?.filename, 'string')
  assert.ok(Array.isArray(entry?.files))
  return entry
}

function outputCode(result) {
  return (Array.isArray(result) ? result : [result])
    .flatMap(output => ('output' in output ? output.output : []))
    .filter(output => output.type === 'chunk')
    .map(output => output.code)
    .join('\n')
}

const root = await mkdtemp(path.join(tmpdir(), 'fict-native-library-'))
const libraryRoot = path.join(root, 'library')
const consumerRoot = path.join(root, 'consumer')
const packDirectory = path.join(root, 'pack')
const npmUserConfigPath = path.join(root, 'npmrc')
const npmEnvironment = isolatedNpmEnvironment(process.env, npmUserConfigPath)

try {
  await Promise.all([
    mkdir(path.join(libraryRoot, 'src'), { recursive: true }),
    mkdir(path.join(consumerRoot, 'src'), { recursive: true }),
    mkdir(packDirectory, { recursive: true }),
  ])
  await Promise.all([
    writeFile(npmUserConfigPath, ''),
    writeFile(
      path.join(libraryRoot, 'package.json'),
      JSON.stringify({
        name: 'fict-native-hook-lib',
        version: '0.0.0-smoke',
        type: 'module',
        files: ['dist'],
        exports: { '.': { import: './dist/index.js' } },
      }),
    ),
    writeFile(
      path.join(libraryRoot, 'src', 'index.ts'),
      `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(1)
          return { count }
        }
      `,
    ),
  ])

  await build({
    root: libraryRoot,
    logLevel: 'silent',
    plugins: [
      fict({
        nativeCompilerPath,
        library: true,
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
      }),
    ],
    build: {
      emptyOutDir: true,
      outDir: 'dist',
      minify: false,
      lib: {
        entry: path.join(libraryRoot, 'src', 'index.ts'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
      },
    },
  })

  const libraryPackage = JSON.parse(await readFile(path.join(libraryRoot, 'package.json'), 'utf8'))
  assert.deepEqual(libraryPackage.fict, { metadata: './dist/index.fict.meta.json' })
  const metadataPath = path.join(libraryRoot, 'dist', 'index.fict.meta.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  assert.equal(metadata.version, 1)
  assert.equal(metadata.hooks?.useCounter?.objectProps?.count, 'signal')

  const packed = parsePackEntry(
    (
      await execFileAsync(
        'npm',
        ['pack', libraryRoot, '--json', '--pack-destination', packDirectory],
        { env: npmEnvironment },
      )
    ).stdout,
  )
  assert.ok(packed.files.some(file => file.path === 'dist/index.fict.meta.json'))
  const tarballPath = path.join(packDirectory, packed.filename)

  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({ name: 'native-metadata-consumer', private: true, type: 'module' }),
  )
  await execFileAsync(
    'npm',
    ['install', tarballPath, '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'],
    { cwd: consumerRoot, env: npmEnvironment },
  )
  await writeFile(
    path.join(consumerRoot, 'src', 'main.ts'),
    `
      import { useCounter } from 'fict-native-hook-lib'
      export function App() {
        const api = useCounter()
        return api.count
      }
    `,
  )

  const consumerBuild = await build({
    root: consumerRoot,
    logLevel: 'silent',
    plugins: [
      fict({
        nativeCompilerPath,
        cache: false,
        functionSplitting: false,
        useTypeScriptProject: false,
      }),
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(consumerRoot, 'src', 'main.ts'),
        formats: ['es'],
        fileName: () => 'consumer.js',
      },
      rollupOptions: {
        external: id => id === 'fict-native-hook-lib' || id === 'fict' || id.startsWith('fict/'),
      },
    },
  })
  const consumerCode = outputCode(consumerBuild)
  assert.match(consumerCode, /api\.count\(\)/)

  process.stdout.write(
    `${JSON.stringify({
      backend: 'rust',
      metadata: libraryPackage.fict.metadata,
      packedFiles: packed.files.length,
      consumerOutputBytes: consumerCode.length,
    })}\n`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
