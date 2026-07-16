#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

function outputCode(result) {
  return (Array.isArray(result) ? result : [result])
    .flatMap(output => ('output' in output ? output.output : []))
    .filter(output => output.type === 'chunk')
    .map(output => output.code)
    .join('\n')
}

function nativePlugin() {
  return fict({
    nativeCompilerPath,
    cache: false,
    functionSplitting: false,
    useTypeScriptProject: false,
  })
}

async function buildLibrary(root, entry, resolve = undefined) {
  return build({
    root,
    logLevel: 'silent',
    plugins: [nativePlugin()],
    resolve,
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'app.js' },
      rollupOptions: { external: id => id === 'fict' || id.startsWith('fict/') },
    },
  })
}

async function buildSsr(root, entry, resolve = undefined) {
  return build({
    root,
    logLevel: 'silent',
    plugins: [nativePlugin()],
    resolve,
    build: {
      write: false,
      minify: false,
      ssr: entry,
      rollupOptions: { external: id => id === 'fict' || id.startsWith('fict/') },
    },
  })
}

const root = await mkdtemp(path.join(tmpdir(), 'fict-native-graph-'))
try {
  const cycleRoot = path.join(root, 'cycle')
  const cycleSource = path.join(cycleRoot, 'src')
  await mkdir(cycleSource, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(cycleRoot, 'package.json'),
      JSON.stringify({ name: 'native-cycle-smoke', private: true, type: 'module' }),
    ),
    writeFile(
      path.join(cycleSource, 'a.ts'),
      `
        import { markerB } from './b?import#cycle'
        import { $state } from 'fict'
        export const markerA = markerB
        export function useCycle() {
          const count = $state(2)
          return { count }
        }
      `,
    ),
    writeFile(
      path.join(cycleSource, 'b.ts'),
      `
        import { markerA } from './a?import#cycle'
        export const markerB = typeof markerA === 'number' ? markerA : 1
      `,
    ),
    writeFile(
      path.join(cycleSource, 'main.ts'),
      `
        import { useCycle } from './a?import#cycle'
        export function App() {
          const api = useCycle()
          return api.count
        }
      `,
    ),
  ])
  const cycleCode = outputCode(await buildLibrary(cycleRoot, path.join(cycleSource, 'main.ts')))
  assert.match(cycleCode, /api\.count\(\)/)

  const linkedSource = path.join(root, 'linked-package')
  const linkedApp = path.join(root, 'linked-app')
  const linkedAppSource = path.join(linkedApp, 'src')
  const linkedDirectory = path.join(linkedApp, 'linked-source')
  await Promise.all([
    mkdir(linkedSource, { recursive: true }),
    mkdir(linkedAppSource, { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      path.join(linkedSource, 'package.json'),
      JSON.stringify({ name: 'native-linked-hooks', version: '1.0.0', type: 'module' }),
    ),
    writeFile(
      path.join(linkedSource, 'hooks.ts'),
      `
        import { $state } from 'fict'
        export function useLinked() {
          const value = $state(3)
          return { value }
        }
      `,
    ),
    writeFile(
      path.join(linkedApp, 'package.json'),
      JSON.stringify({ name: 'native-linked-app', private: true, type: 'module' }),
    ),
    writeFile(
      path.join(linkedAppSource, 'main.ts'),
      `
        import { useLinked } from '@linked/hooks?import#client'
        export function App() {
          const api = useLinked()
          return api.value
        }
      `,
    ),
  ])
  await symlink(linkedSource, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const resolve = {
    alias: { '@linked': linkedDirectory },
    preserveSymlinks: true,
  }
  const linkedEntry = path.join(linkedAppSource, 'main.ts')
  const linkedClientCode = outputCode(await buildLibrary(linkedApp, linkedEntry, resolve))
  const linkedSsrCode = outputCode(await buildSsr(linkedApp, linkedEntry, resolve))
  assert.match(linkedClientCode, /api\.value\(\)/)
  assert.match(linkedSsrCode, /api\.value\(\)/)

  process.stdout.write(
    `${JSON.stringify({
      backend: 'rust',
      cycleOutputBytes: cycleCode.length,
      linkedClientOutputBytes: linkedClientCode.length,
      linkedSsrOutputBytes: linkedSsrCode.length,
      queryFragment: '?import#client',
      preserveSymlinks: true,
    })}\n`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
