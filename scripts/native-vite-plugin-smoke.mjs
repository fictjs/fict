#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import fict from '../packages/vite-plugin/dist/index.js'

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

const root = await mkdtemp(path.join(tmpdir(), 'fict-native-vite-'))
const sourceDirectory = path.join(root, 'src')
try {
  await mkdir(sourceDirectory, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fict-native-vite-smoke', version: '1.0.0', private: true }),
    ),
    writeFile(
      path.join(sourceDirectory, 'hooks.ts'),
      `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(1)
          return { count }
        }
      `,
    ),
    writeFile(
      path.join(sourceDirectory, 'main.ts'),
      `
        import { useCounter } from './hooks'
        export function App() {
          const api = useCounter()
          return api.count
        }
      `,
    ),
  ])

  const result = await build({
    root,
    logLevel: 'silent',
    plugins: [
      fict({
        backend: 'rust',
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
        entry: path.join(sourceDirectory, 'main.ts'),
        formats: ['es'],
        fileName: () => 'app.js',
      },
      rollupOptions: {
        external: id => id === 'fict' || id.startsWith('fict/'),
      },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const code = outputs
    .flatMap(output => ('output' in output ? output.output : []))
    .filter(output => output.type === 'chunk')
    .map(output => output.code)
    .join('\n')

  assert.doesNotMatch(code, /\$state\s*\(/)
  assert.match(code, /api\.count\(\)/)
  assert.match(code, /__fictUseSignal/)

  const runtimeImport = /import\s*\{[^}]*\}\s*from\s*["']fict\/internal["'];?/
  assert.match(code, runtimeImport)
  const executableCode = code.replace(
    runtimeImport,
    `
      const __fictUseContext = () => ({})
      const __fictUseSignal = (_context, initial) => {
        let value = initial
        return function signal(next) {
          if (arguments.length > 0) value = next
          return value
        }
      }
    `,
  )
  const compiledModule = await import(
    `data:text/javascript;base64,${Buffer.from(executableCode).toString('base64')}`
  )
  assert.equal(compiledModule.App(), 1)

  process.stdout.write(
    `${JSON.stringify({ backend: 'rust', nativeCompilerPath, outputBytes: code.length })}\n`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
