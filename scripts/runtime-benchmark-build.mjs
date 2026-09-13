#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    'benchmark-root': {
      type: 'string',
      default: path.join(repositoryRoot, 'js-framework-benchmark'),
    },
    name: { type: 'string', default: 'fict-local' },
    source: { type: 'string' },
    sourcemap: { type: 'boolean', default: false },
  },
})
assert.match(values.name, /^fict-[a-z0-9-]+$/)
const benchmarkRoot = path.resolve(values['benchmark-root'])
const outputRoot = path.join(benchmarkRoot, 'frameworks/keyed', values.name)
const fixtureRoot = path.join(import.meta.dirname, 'fixtures/runtime-benchmark')
const sourcePath = path.resolve(values.source ?? path.join(fixtureRoot, 'main.tsx'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sourceIdentity = () => ({
  revision: git(repositoryRoot, 'rev-parse', 'HEAD'),
  runtimeDiff: git(repositoryRoot, 'diff', 'HEAD', '--', 'packages/runtime/src'),
  compilerDiff: git(repositoryRoot, 'diff', 'HEAD', '--', 'crates'),
  fixtureDiff: git(repositoryRoot, 'diff', 'HEAD', '--', path.relative(repositoryRoot, sourcePath)),
  toolingDiff: git(repositoryRoot, 'diff', 'HEAD', '--', 'scripts/runtime-benchmark-build.mjs'),
})
const initialIdentity = sourceIdentity()
for (const args of [
  ['build:compiler:native-host'],
  ['--filter', '@fictjs/runtime', 'build'],
  ['--filter', 'fict', 'build'],
]) {
  execFileSync('pnpm', args, { cwd: repositoryRoot, stdio: 'inherit' })
}
const require = createRequire(import.meta.url)
const requireVite = createRequire(path.join(repositoryRoot, 'packages/vite-plugin/package.json'))
const { build } = await import(pathToFileURL(requireVite.resolve('vite')).href)
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
)
const binding = require(nativePath)
const source = await readFile(sourcePath, 'utf8')
const compilerOptions = { dev: false, strictGuarantee: true }
const result = binding.transformSync({
  code: source,
  filename: '/js-framework-benchmark/main.tsx',
  options: compilerOptions,
})
assert.ok(result.code, JSON.stringify(result.diagnostics))
assert.deepEqual(result.diagnostics, [], 'Benchmark compilation must have no diagnostics')
assert.doesNotMatch(result.code, /\$state\s*\(/)
await mkdir(outputRoot, { recursive: true })
await writeFile(path.join(outputRoot, 'source.tsx'), source)
await writeFile(path.join(outputRoot, 'compiled.js'), result.code)
await copyFile(path.join(fixtureRoot, 'index.html'), path.join(outputRoot, 'index.html'))

const aliases = []
for (const packageName of ['fict', '@fictjs/runtime']) {
  const directory = packageName === 'fict' ? 'fict' : 'runtime'
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages', directory, 'package.json'), 'utf8'),
  )
  for (const [key, entry] of Object.entries(manifest.exports)) {
    const file = typeof entry.import === 'string' ? entry.import : entry.import?.default
    if (file)
      aliases.push({
        find: key === '.' ? new RegExp(`^${packageName}$`) : `${packageName}${key.slice(1)}`,
        replacement: path.resolve(repositoryRoot, 'packages', directory, file),
      })
  }
}
// Resolve longer subpaths before prefixes such as fict/internal.
aliases.sort((a, b) => String(b.find).length - String(a.find).length)
const bundle = await build({
  configFile: false,
  root: outputRoot,
  logLevel: 'warn',
  resolve: { alias: aliases },
  define: { __DEV__: 'false', 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
    sourcemap: values.sourcemap,
    lib: {
      entry: path.join(outputRoot, 'compiled.js'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
  },
})
const modules = (Array.isArray(bundle) ? bundle : [bundle])
  .flatMap(output => output.output)
  .filter(output => output.type === 'chunk')
  .flatMap(chunk => chunk.moduleIds)
assert.ok(modules.some(id => id.startsWith(path.join(repositoryRoot, 'packages/runtime/dist/'))))
assert.ok(
  !modules.some(
    id => id.includes('/node_modules/fict/') || id.includes('/node_modules/@fictjs/runtime/'),
  ),
)
const runtime = JSON.parse(
  await readFile(path.join(repositoryRoot, 'packages/runtime/package.json'), 'utf8'),
)
await writeFile(
  path.join(outputRoot, 'package.json'),
  JSON.stringify(
    {
      name: `js-framework-benchmark-${values.name}`,
      version: '1.0.0',
      private: true,
      type: 'module',
      'js-framework-benchmark': {
        frameworkVersion: runtime.version,
        frameworkHomeURL: 'https://github.com/fictjs/fict',
      },
    },
    null,
    2,
  ) + '\n',
)
// The benchmark server discovers entries only when both manifests exist.
// This generated bundle has no install-time dependencies; its workspace inputs
// and their lockfile identity are recorded separately below.
await writeFile(
  path.join(outputRoot, 'package-lock.json'),
  JSON.stringify(
    {
      name: `js-framework-benchmark-${values.name}`,
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: `js-framework-benchmark-${values.name}`, version: '1.0.0' } },
    },
    null,
    2,
  ) + '\n',
)
const sha256 = value => createHash('sha256').update(value).digest('hex')
assert.deepEqual(sourceIdentity(), initialIdentity, 'Benchmark inputs changed during the build')
const provenance = {
  ...initialIdentity,
  sourcePath: path.relative(repositoryRoot, sourcePath),
  compilerOptions,
  sourceMap: values.sourcemap,
  benchmarkRevision: git(benchmarkRoot, 'rev-parse', 'HEAD'),
  compilerBuildId: result.compilerBuildId,
  nativeSha256: sha256(await readFile(nativePath)),
  sourceSha256: sha256(source),
  compiledSha256: sha256(result.code),
  lockfileSha256: sha256(await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'))),
  bundleSha256: sha256(await readFile(path.join(outputRoot, 'dist/main.js'))),
  diagnostics: result.diagnostics,
  modules: await Promise.all(
    modules.map(async id => ({
      path: path.relative(repositoryRoot, id),
      sha256: sha256(await readFile(id)),
    })),
  ),
}
await writeFile(
  path.join(outputRoot, 'provenance.json'),
  JSON.stringify(provenance, null, 2) + '\n',
)
console.log(`Built keyed/${values.name} with runtime ${runtime.version} at ${provenance.revision}`)
console.log(`Bundle SHA-256: ${provenance.bundleSha256}`)
