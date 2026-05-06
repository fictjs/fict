#!/usr/bin/env node
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
  './internal',
  './internal/list',
  './jsx-dev-runtime',
  './jsx-runtime',
  './loader',
  './plus',
  './slim',
])

assertEqualSet('runtime package exports', packageExports('packages/runtime/package.json'), [
  '.',
  './advanced',
  './internal',
  './internal/list',
  './jsx-dev-runtime',
  './jsx-runtime',
  './loader',
])

assertEqualSet('devtools package exports', packageExports('packages/devtools/package.json'), [
  '.',
  './core',
  './vite',
])

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
