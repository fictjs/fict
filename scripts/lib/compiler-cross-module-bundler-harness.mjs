import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const webpackRequire = createRequire(
  path.join(repositoryRoot, 'packages/webpack-plugin/package.json'),
)
const loadBundle = createRequire(import.meta.url)
const webpack = webpackRequire('webpack')
const webpackPackage = webpackRequire('webpack/package.json')
const runtimePackage = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'packages/runtime/package.json'), 'utf8'),
)

function normalize(value, ancestors = new Set()) {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'nan' }
    if (value === Infinity) return { $type: 'infinity' }
    if (value === -Infinity) return { $type: '-infinity' }
    if (Object.is(value, -0)) return { $type: '-0' }
    return value
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Bundled semantic oracle cannot normalize ${typeof value} values`)
  }
  if (ancestors.has(value)) throw new TypeError('Bundled semantic oracle result contains a cycle')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, entry => normalize(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError(
        `Bundled semantic oracle result contains unsupported ${prototype?.constructor?.name ?? 'object'}`,
      )
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key], ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

function modulePath(sourceRoot, graphRoot, id) {
  const relative = path.relative(graphRoot, id)
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${id}: graph path`,
  )
  return path.join(sourceRoot, relative.replace(/\.[^.\/]+$/, '.js'))
}

function writeGraph(sourceRoot, modules, entryId) {
  const graphRoot = path.dirname(entryId)
  const files = new Map()
  for (const module of modules) {
    const file = modulePath(sourceRoot, graphRoot, module.id)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, module.code, 'utf8')
    files.set(module.id, file)
  }
  for (const module of modules) {
    const importer = files.get(module.id)
    for (const [request, dependencyId] of Object.entries(module.dependencies)) {
      assert.ok(request.startsWith('.'), `${module.id}: non-relative graph request ${request}`)
      const dependency = files.get(dependencyId)
      assert.ok(dependency, `${module.id}: missing graph dependency ${dependencyId}`)
      const resolved = path.resolve(path.dirname(importer), request)
      assert.equal(
        resolved,
        dependency.slice(0, -path.extname(dependency).length),
        `${module.id}: ${request} must resolve to ${dependencyId}`,
      )
    }
  }
  return files.get(entryId)
}

function webpackAliases() {
  const fict = path.join(repositoryRoot, 'packages/fict/dist')
  const runtime = path.join(repositoryRoot, 'packages/runtime/dist')
  return {
    fict$: path.join(fict, 'index.cjs'),
    'fict/advanced$': path.join(fict, 'advanced.cjs'),
    'fict/internal$': path.join(fict, 'internal.cjs'),
    'fict/internal/list$': path.join(fict, 'internal-list.cjs'),
    '@fictjs/runtime$': path.join(runtime, 'index.cjs'),
    '@fictjs/runtime/advanced$': path.join(runtime, 'advanced.cjs'),
    '@fictjs/runtime/internal$': path.join(runtime, 'internal.cjs'),
    '@fictjs/runtime/internal/list$': path.join(runtime, 'internal-list.cjs'),
  }
}

function bundle(entry, outputDirectory) {
  return new Promise((resolve, reject) => {
    webpack(
      {
        context: path.dirname(entry),
        devtool: false,
        entry,
        mode: 'none',
        optimization: { minimize: false },
        output: {
          filename: 'oracle-bundle.cjs',
          library: { type: 'commonjs2' },
          path: outputDirectory,
        },
        resolve: {
          alias: webpackAliases(),
          extensions: ['.js', '.cjs'],
        },
        target: 'node',
      },
      (error, stats) => {
        if (error) {
          reject(error)
          return
        }
        const details = stats?.toJson({ all: false, errorDetails: true, errors: true })
        if (!stats || stats.hasErrors()) {
          reject(
            new Error(`Webpack cross-module oracle failed: ${JSON.stringify(details?.errors)}`),
          )
          return
        }
        resolve(path.join(outputDirectory, 'oracle-bundle.cjs'))
      },
    )
  })
}

export function crossModuleBundlerProvenance() {
  return {
    bundlerPackage: `webpack@${webpackPackage.version}`,
    sharedRuntimePackage: `${runtimePackage.name}@${runtimePackage.version}`,
    bundledRuntimeExecutionModel:
      'frozen-babel-and-live-rust-commonjs-graphs-are-bundled-with-webpack-and-invoke-the-current-runtime-inside-the-bundle',
  }
}

export async function executeBundledCommonJsGraph(modules, entryId, invocation) {
  assert.ok(Array.isArray(modules))
  assert.equal(typeof entryId, 'string')
  assert.equal(typeof invocation?.exportName, 'string')
  assert.ok(Array.isArray(invocation.arguments))

  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'fict-cross-module-oracle-')))
  const sourceRoot = path.join(directory, 'src')
  const outputDirectory = path.join(directory, 'dist')
  mkdirSync(sourceRoot)
  mkdirSync(outputDirectory)
  try {
    const entry = writeGraph(sourceRoot, modules, entryId)
    assert.ok(entry, `missing graph entry ${entryId}`)
    const runner = path.join(sourceRoot, 'oracle-runner.cjs')
    let entryRequest = path.relative(path.dirname(runner), entry).split(path.sep).join('/')
    if (!entryRequest.startsWith('.')) entryRequest = `./${entryRequest}`
    writeFileSync(
      runner,
      `const entry = require(${JSON.stringify(entryRequest)})\n` +
        `const internal = require('fict/internal')\n` +
        `module.exports.run = args => {\n` +
        `  internal.__fictPushContext()\n` +
        `  try { return entry[${JSON.stringify(invocation.exportName)}](...args) }\n` +
        `  finally { internal.__fictPopContext() }\n` +
        `}\n`,
      'utf8',
    )
    const bundlePath = await bundle(runner, outputDirectory)
    const bundled = loadBundle(bundlePath)
    assert.equal(typeof bundled.run, 'function', `${entryId}: bundled runner export`)
    const result = await bundled.run(structuredClone(invocation.arguments))
    return normalize(result)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}
