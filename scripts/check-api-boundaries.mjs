#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsStandaloneToken(text, token) {
  return new RegExp(`(^|[^\\w$])${escapeRegExp(token)}(?=$|[^\\w$])`).test(text)
}

function staticImports(text) {
  const imports = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index]
    if (!/^\s*import\s+(?!\()/.test(firstLine)) continue
    let declaration = firstLine
    while (
      !/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/.test(declaration) &&
      !/\bfrom\s*['"][^'"]+['"]\s*;?\s*$/.test(declaration) &&
      index + 1 < lines.length
    ) {
      index += 1
      declaration += `\n${lines[index]}`
    }
    const source = /(?:\bfrom\s*|^\s*import\s*)['"]([^'"]+)['"]\s*;?\s*$/.exec(declaration)?.[1]
    if (!source) continue
    imports.push({
      source,
      typeOnly: /^\s*import\s+type\b/.test(declaration),
    })
  }
  return imports
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

const generatedArtifactFiles = trackedFiles().filter(
  file => file.endsWith('.fict.meta.json') || file.split('/').includes('__fict_cross_module__'),
)
if (generatedArtifactFiles.length > 0) {
  fail(
    `generated compiler artifacts must not be tracked: ${generatedArtifactFiles
      .slice(0, 10)
      .join(', ')}`,
  )
}

for (const [text, token, expected] of [
  ['export { $state }', '$state', true],
  ['const value = $effect(() => {})', '$effect', true],
  ['const value = use$statefulName()', '$state', false],
  ['const value = $statefulName()', '$state', false],
]) {
  if (containsStandaloneToken(text, token) !== expected) {
    fail(`API boundary token matcher regression for ${token}: ${text}`)
  }
}

function assertEqualSet(label, actual, expected) {
  const actualSorted = [...actual].sort()
  const expectedSorted = [...expected].sort()
  const missing = expectedSorted.filter(item => !actualSorted.includes(item))
  const extra = actualSorted.filter(item => !expectedSorted.includes(item))
  if (missing.length || extra.length) {
    fail(
      `${label} mismatch` +
        (missing.length ? `\n  missing: ${missing.join(', ')}` : '') +
        (extra.length ? `\n  extra: ${extra.join(', ')}` : ''),
    )
  }
}

function packageExports(path) {
  return Object.keys(readJson(path).exports ?? {})
}

assertEqualSet('fict package exports', packageExports('packages/fict/package.json'), [
  '.',
  './advanced',
  './experimental/loader',
  './internal',
  './internal/list',
  './jsx-dev-runtime',
  './jsx-runtime',
  './plus',
  './slim',
])

assertEqualSet('runtime package exports', packageExports('packages/runtime/package.json'), [
  '.',
  './advanced',
  './experimental/loader',
  './internal',
  './internal/list',
  './jsx-dev-runtime',
  './jsx-runtime',
])

assertEqualSet('compiler package exports', packageExports('packages/compiler/package.json'), [
  '.',
  './graph-host',
  './legacy',
  './native',
])

const ssrPackage = readJson('packages/ssr/package.json')
for (const [subpath, basename] of [
  ['.', 'index'],
  ['./experimental', 'experimental'],
]) {
  const entry = ssrPackage.exports?.[subpath]
  if (
    entry?.import !== `./dist/${basename}.js` ||
    entry?.require !== `./dist/${basename}.cjs` ||
    entry?.node?.import !== `./dist/${basename}.node.js` ||
    entry?.node?.require !== `./dist/${basename}.node.cjs`
  ) {
    fail(
      `@fictjs/ssr ${subpath} must keep edge-safe defaults and dedicated Node async-context entries`,
    )
  }
}

for (const file of trackedFiles().filter(file => file.startsWith('packages/runtime/src/'))) {
  if (readText(file).includes('node:async_hooks')) {
    fail(`@fictjs/runtime browser graph must not import node:async_hooks: ${file}`)
  }
}
for (const file of ['packages/ssr/src/index.ts', 'packages/ssr/src/experimental.ts']) {
  const source = readText(file)
  if (source.includes('node:async_hooks') || source.includes('node-session-carrier')) {
    fail(`@fictjs/ssr edge entry must not install the Node session carrier: ${file}`)
  }
}
if (!readText('packages/ssr/src/node-session-carrier.ts').includes('node:async_hooks')) {
  fail('@fictjs/ssr Node session carrier must use node:async_hooks')
}

assertEqualSet('devtools package exports', packageExports('packages/devtools/package.json'), [
  '.',
  './core',
  './vite',
])

assertEqualSet(
  'webpack plugin package exports',
  packageExports('packages/webpack-plugin/package.json'),
  ['.', './loader'],
)

for (const packagePath of [
  'packages/compiler/package.json',
  'packages/babel-preset/package.json',
  'packages/vite-plugin/package.json',
  'packages/webpack-plugin/package.json',
  'packages/testing-library/package.json',
]) {
  const packageJson = readJson(packagePath)
  const rootExport = packageJson.exports?.['.']
  if (
    rootExport?.import?.types !== './dist/index.d.ts' ||
    rootExport?.import?.default !== './dist/index.js' ||
    rootExport?.require?.types !== './dist/index.d.cts' ||
    rootExport?.require?.default !== './dist/index.cjs'
  ) {
    fail(
      `${packageJson.name ?? packagePath} must expose format-specific declarations for ESM and CJS consumers`,
    )
  }
}

const compilerPackage = readJson('packages/compiler/package.json')
for (const [subpath, basename] of [
  ['./graph-host', 'graph-host'],
  ['./legacy', 'legacy'],
  ['./native', 'native-loader'],
]) {
  const entry = compilerPackage.exports?.[subpath]
  if (
    entry?.import?.types !== `./dist/${basename}.d.ts` ||
    entry?.import?.default !== `./dist/${basename}.js` ||
    entry?.require?.types !== `./dist/${basename}.d.cts` ||
    entry?.require?.default !== `./dist/${basename}.cjs`
  ) {
    fail(`@fictjs/compiler ${subpath} must expose format-specific declarations and runtime files`)
  }
}

const compilerGraphHost = readText('packages/compiler/src/graph-host.ts')
if (
  compilerGraphHost.includes("from './index'") ||
  compilerGraphHost.includes("from './legacy'") ||
  /from\s+['"]@babel\//.test(compilerGraphHost)
) {
  fail('@fictjs/compiler/graph-host must not load the legacy compiler or Babel')
}

const compilerLegacyEntrypoint = readText('packages/compiler/src/legacy.ts')
if (
  compilerLegacyEntrypoint.includes("from './index'") ||
  !compilerLegacyEntrypoint.includes("from './legacy-compiler'")
) {
  fail('@fictjs/compiler/legacy must own its implementation edge instead of importing the root')
}

const viteForbiddenRuntimeImports = /^@babel\/|^@fictjs\/compiler\/legacy$/
for (const file of [
  'packages/vite-plugin/src/index.ts',
  'packages/vite-plugin/src/legacy-compiler-runtime.ts',
]) {
  for (const imported of staticImports(readText(file))) {
    if (!imported.typeOnly && viteForbiddenRuntimeImports.test(imported.source)) {
      fail(`Vite Rust module graph must not statically load ${imported.source}: ${file}`)
    }
  }
}

for (const [source, expected] of [
  ["import { transformAsync } from '@babel/core'", ['@babel/core']],
  ["import type { PluginItem } from '@babel/core'", []],
  ["type Core = typeof import('@babel/core')", []],
]) {
  const actual = staticImports(source)
    .filter(imported => !imported.typeOnly && viteForbiddenRuntimeImports.test(imported.source))
    .map(imported => imported.source)
  assertEqualSet('Vite static runtime import matcher', actual, expected)
}

for (const packagePath of [
  'packages/compiler/package.json',
  'packages/babel-preset/package.json',
]) {
  const packageJson = readJson(packagePath)
  if (!packageJson.dependencies?.['@types/babel__core']) {
    fail(
      `${packageJson.name ?? packagePath} must publish @types/babel__core because its public declarations reference @babel/core`,
    )
  }
  if (packageJson.peerDependencies?.['@babel/core'] !== '^7.0.0-0') {
    fail(`${packageJson.name ?? packagePath} must match its Babel 7 api.assertVersion contract`)
  }
}

const fictMain = readText('packages/fict/src/index.ts')
const advancedExportRe = /export\s*\{([^}]*)\}\s*from\s*['"]@fictjs\/runtime\/advanced['"]/g
const allowedMainAdvancedExports = ['createSelector', 'createScope', 'runInScope']
const actualMainAdvancedExports = []
let match
while ((match = advancedExportRe.exec(fictMain))) {
  for (const rawPart of match[1].split(',')) {
    const part = rawPart.replace(/\/\/.*$/g, '').trim()
    if (!part) continue
    actualMainAdvancedExports.push(
      part
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim() ?? part,
    )
  }
}
assertEqualSet(
  'fict main advanced re-exports',
  actualMainAdvancedExports,
  allowedMainAdvancedExports,
)

if (/export\s+\*\s+from\s+['"]@fictjs\/runtime\/advanced['"]/.test(fictMain)) {
  fail('fict main entrypoint must not wildcard-export @fictjs/runtime/advanced')
}

const fictAdvanced = readText('packages/fict/src/advanced.ts')
for (const requiredExport of [
  'FICT_DEVTOOLS_MIN_PROTOCOL_VERSION',
  'FICT_DEVTOOLS_PROTOCOL_VERSION',
  'getDevtoolsHook',
  'isDevtoolsHookCompatible',
  'FictDevtoolsCompatibility',
  'FictDevtoolsHook',
]) {
  if (!containsStandaloneToken(fictAdvanced, requiredExport)) {
    fail(`fict/advanced must re-export DevTools protocol API: ${requiredExport}`)
  }
}

const runtimeMain = readText('packages/runtime/src/index.ts')
for (const macro of ['$state', '$effect']) {
  if (containsStandaloneToken(runtimeMain, macro)) {
    fail(`@fictjs/runtime main entrypoint must not export or document ${macro}`)
  }
}
const runtimeSignal = readText('packages/runtime/src/signal.ts')
if (containsStandaloneToken(runtimeSignal, '$state')) {
  fail('@fictjs/runtime signal internals must not define private $state alias')
}
const runtimeEffect = readText('packages/runtime/src/effect.ts')
if (containsStandaloneToken(runtimeEffect, '$effect')) {
  fail('@fictjs/runtime effect internals must not define private $effect alias')
}
for (const devtoolsProtocolExport of [
  'FICT_DEVTOOLS_MIN_PROTOCOL_VERSION',
  'FICT_DEVTOOLS_PROTOCOL_VERSION',
  'isDevtoolsHookCompatible',
  'FictDevtoolsCompatibility',
  'FictDevtoolsHook',
]) {
  if (containsStandaloneToken(runtimeMain, devtoolsProtocolExport)) {
    fail(`@fictjs/runtime main entrypoint must not export ${devtoolsProtocolExport}`)
  }
}

const advancedOnlyFromFict = new Set([
  'createSignal',
  'createVersionedSignal',
  'createTextBinding',
  'createChildBinding',
  'createAttributeBinding',
  'createStyleBinding',
  'createClassBinding',
  'createShow',
  'effectScope',
  'FICT_DEVTOOLS_MIN_PROTOCOL_VERSION',
  'FICT_DEVTOOLS_PROTOCOL_VERSION',
  'FictDevtoolsCompatibility',
  'FictDevtoolsHook',
  'getDevtoolsHook',
  'isDevtoolsHookCompatible',
  'isReactive',
  'nonReactive',
  'reactive',
  'setCycleProtectionOptions',
  'unwrap',
])

const scanRoots = [
  'docs',
  'examples',
  'packages/fict/src',
  'packages/fict/test',
  'packages/fict/e2e/src',
  'packages/runtime/README.md',
  'packages/fict/README.md',
]
const scanExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.md', '.mdx'])
const importFromFictRe = /\bimport\s+(?!type\b)\{([^}]*)\}\s+from\s+['"]fict['"]/g

function extension(path) {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index)
}

function walk(path, files) {
  const absolute = join(root, path)
  if (!existsSync(absolute)) return
  const stats = statSync(absolute)
  if (stats.isFile()) {
    if (scanExtensions.has(extension(path))) files.push(path)
    return
  }
  for (const entry of readdirSync(absolute)) {
    if (entry === 'dist' || entry === 'node_modules' || entry === '.vitepress') continue
    walk(join(path, entry), files)
  }
}

const filesToScan = []
for (const scanRoot of scanRoots) {
  walk(scanRoot, filesToScan)
}

for (const file of filesToScan) {
  const text = readText(file)
  let importMatch
  while ((importMatch = importFromFictRe.exec(text))) {
    const importedNames = importMatch[1]
      .split(',')
      .map(part =>
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim(),
      )
      .filter(Boolean)
    const forbidden = importedNames.filter(name => advancedOnlyFromFict.has(name))
    if (forbidden.length) {
      fail(
        `${relative(root, join(root, file))}: advanced-only import(s) from fict: ${forbidden.join(
          ', ',
        )}`,
      )
    }
  }
}

const apiFreeze = readText('docs/api-freeze-v1.md')
for (const requiredPhrase of [
  'Package Surface Ownership',
  'Tier 2 compiler ABI, not user API',
  'Manual getter markers such as `reactive`',
  '`fict/internal` mirrors this surface',
]) {
  if (!apiFreeze.includes(requiredPhrase)) {
    fail(`docs/api-freeze-v1.md missing required boundary phrase: ${requiredPhrase}`)
  }
}

if (failures.length) {
  console.error('API boundary check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('API boundary check passed.')
