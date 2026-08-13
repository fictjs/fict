#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  findUndocumentedExperimentalExports,
  hasLegacyLoaderReference,
} from './preview-boundary-helpers.mjs'
import { discoverRepositoryFiles } from './api-boundary-file-discovery.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(message) {
  failures.push(message)
}

function readText(path) {
  return readFileSync(join(root, path), 'utf8')
}

function readJson(path) {
  return JSON.parse(readText(path))
}

function assertSet(label, actual, expected) {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter(value => !actualSet.has(value))
  const extra = [...actualSet].filter(value => !expectedSet.has(value))
  if (missing.length || extra.length) {
    fail(
      `${label} mismatch` +
        (missing.length ? `; missing ${missing.join(', ')}` : '') +
        (extra.length ? `; extra ${extra.join(', ')}` : ''),
    )
  }
}

function precedingJsdoc(source, index) {
  return source.slice(0, index).match(/\/\*\*[\s\S]*?\*\/\s*$/)?.[0] ?? ''
}

function assertExperimentalProperty(path, property) {
  const source = readText(path)
  const match = new RegExp(`^\\s*${property}\\?:`, 'm').exec(source)
  if (!match) {
    fail(`${path} is missing Preview option ${property}`)
    return
  }
  if (!precedingJsdoc(source, match.index).includes('@experimental')) {
    fail(`${path}#${property} must carry an @experimental JSDoc tag`)
  }
}

const maturity = readJson('maturity.json')
const changesets = readJson('.changeset/config.json')

if (maturity.schemaVersion !== 1) fail('maturity.json schemaVersion must be 1')
if (maturity.sourceOfTruth !== 'SCOPE.md') fail('maturity.json must name SCOPE.md as sourceOfTruth')
if (maturity.core1Release?.previewBlocksRelease !== false) {
  fail('Preview must not block the Core 1.0 release')
}
if (maturity.core1Release?.stablePromiseExcludesPreview !== true) {
  fail('The Core 1.0 stable promise must explicitly exclude Preview')
}

const fixedPackages = changesets.fixed?.flat() ?? []
assertSet(
  'Core package registry vs Changesets fixed group',
  maturity.core1Release?.packages ?? [],
  fixedPackages,
)

const satellitePackages = maturity.satellitePackages ?? []
assertSet('Satellite package registry', satellitePackages, [
  '@fictjs/router',
  '@fictjs/ssr',
  '@fictjs/testing-library',
  '@fictjs/webpack-plugin',
])
for (const packageName of satellitePackages) {
  if (fixedPackages.includes(packageName)) {
    fail(`${packageName} is Satellite and must not enter the Changesets fixed group`)
  }
  if ((changesets.ignore ?? []).includes(packageName)) {
    fail(`${packageName} is a published Satellite and must not enter Changesets ignore`)
  }
}

const previewSurfaces = maturity.previewSurfaces ?? []
assertSet(
  'Preview surface registry',
  previewSurfaces.map(surface => surface.id),
  ['resumability', 'partial-prerendering'],
)

const registeredEntrypoints = []
for (const surface of previewSurfaces) {
  if (surface.status !== 'preview') fail(`${surface.id} must remain status=preview`)
  if (surface.semverGuaranteed !== false) fail(`${surface.id} must declare no semver guarantee`)
  if (surface.core1ReleaseBlocking !== false) {
    fail(`${surface.id} must not block the Core 1.0 release`)
  }
  if (!surface.stableAlternative) fail(`${surface.id} must name a stable alternative`)
  if (surface.graduation?.apiShapeFrozen !== false) {
    fail(`${surface.id} must not claim a frozen API shape before graduation`)
  }

  for (const entrypoint of surface.entrypoints ?? []) {
    if (!entrypoint.subpath?.startsWith('./experimental')) {
      fail(`${surface.id} entrypoint must live below ./experimental: ${entrypoint.subpath}`)
      continue
    }
    const packageJson = readJson(entrypoint.packageJson)
    if (!packageJson.exports?.[entrypoint.subpath]) {
      fail(`${packageJson.name} is missing registered Preview export ${entrypoint.subpath}`)
    }
    registeredEntrypoints.push(`${packageJson.name}:${entrypoint.subpath}`)
  }
}

assertSet('registered Preview entrypoints', registeredEntrypoints, [
  'fict:./experimental/loader',
  '@fictjs/runtime:./experimental/loader',
  '@fictjs/ssr:./experimental',
])

for (const packagePath of ['packages/fict/package.json', 'packages/runtime/package.json']) {
  const packageJson = readJson(packagePath)
  if (packageJson.exports?.['./loader']) {
    fail(`${packageJson.name} must not expose resumability through stable-looking ./loader`)
  }
}

const runtimeLoader = readText('packages/runtime/src/loader.ts')
for (const name of findUndocumentedExperimentalExports(
  runtimeLoader,
  'packages/runtime/src/loader.ts',
)) {
  fail(`Preview loader export ${name} must carry an @experimental JSDoc tag`)
}

const ssrMain = readText('packages/ssr/src/index.ts')
if (ssrMain.includes('renderToPartial') || ssrMain.includes('PartialPrerenderResult')) {
  fail('@fictjs/ssr main entrypoint must not expose Preview PPR symbols')
}
const ssrExperimental = readText('packages/ssr/src/experimental.ts')
for (const symbol of ['renderToPartial', 'PartialPrerenderResult']) {
  if (!ssrExperimental.includes(symbol)) {
    fail(`@fictjs/ssr/experimental must expose ${symbol}`)
  }
}

assertExperimentalProperty('packages/compiler/src/types.ts', 'resumable')
assertExperimentalProperty('packages/compiler/src/types.ts', 'autoExtractHandlers')
assertExperimentalProperty('packages/compiler/src/types.ts', 'autoExtractThreshold')
assertExperimentalProperty('packages/ssr/src/render-core.ts', 'includeSnapshot')
assertExperimentalProperty('packages/ssr/src/render-core.ts', 'snapshotScriptId')
assertExperimentalProperty('packages/ssr/src/render-core.ts', 'snapshotTarget')
assertExperimentalProperty('packages/ssr/src/render-core.ts', 'scopeIdentifierPrefix')

const renderCore = readText('packages/ssr/src/render-core.ts')
if (renderCore.includes('options.includeSnapshot !== false')) {
  fail('Preview snapshots must never be enabled by default')
}
if ((renderCore.match(/options\.includeSnapshot === true/g) ?? []).length !== 2) {
  fail('string and streaming SSR must both require includeSnapshot=true')
}

let repositoryFiles = []
try {
  repositoryFiles = discoverRepositoryFiles(root).files
} catch (error) {
  fail(
    `repository file discovery failed: ${error instanceof Error ? error.message : String(error)}`,
  )
}
if (repositoryFiles.length === 0) {
  fail('repository file discovery returned no files')
}

const filesToScan = repositoryFiles
  .filter(path => !path.endsWith('CHANGELOG.md'))
  .filter(path => path !== 'scripts/check-preview-boundaries.mjs')
  .filter(path => /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml)$/.test(path))
for (const path of filesToScan) {
  const source = readText(path)
  if (hasLegacyLoaderReference(source)) {
    fail(`${path} references a stable-looking legacy resumability entrypoint`)
  }
}

for (const [path, phrases] of [
  [
    'SCOPE.md',
    [
      'does not block Core 1.0',
      'fict/experimental/loader',
      'default-off Preview options',
      'release decision and bump train',
    ],
  ],
  [
    'docs/PREVIEW.md',
    ['does not block Core 1.0', 'fict/experimental/loader', 'includeSnapshot: true'],
  ],
]) {
  const source = readText(path)
  for (const phrase of phrases) {
    if (!source.includes(phrase)) fail(`${path} is missing required maturity phrase: ${phrase}`)
  }
}

if (failures.length) {
  console.error('Preview boundary check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Preview boundary check passed.')
