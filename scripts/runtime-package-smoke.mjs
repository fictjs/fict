#!/usr/bin/env node

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(rootDir, 'packages/runtime')
const runtimeDist = path.join(runtimeDir, 'dist')
const typeSmokeDir = path.join(runtimeDir, '.tmp-package-smoke')
const runtimePackageJson = JSON.parse(readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'))

const requiredDistFiles = [
  'index.js',
  'index.cjs',
  'index.d.ts',
  'internal.js',
  'internal.cjs',
  'internal.d.ts',
  'internal-list.js',
  'internal-list.cjs',
  'internal-list.d.ts',
  'advanced.js',
  'advanced.cjs',
  'advanced.d.ts',
  'experimental/loader.js',
  'experimental/loader.cjs',
  'experimental/loader.d.ts',
  'jsx-runtime.js',
  'jsx-runtime.cjs',
  'jsx-runtime.d.ts',
  'jsx-dev-runtime.js',
  'jsx-dev-runtime.cjs',
  'jsx-dev-runtime.d.ts',
]

const forbiddenDistFiles = ['index.dev.js', 'index.dev.js.map']

const exportChecks = [
  ['.', ['render', 'createEffect', 'useContextAccessor']],
  ['./internal', ['insertBetween', 'hydrateComponent', '__fictRunWithSSRSession']],
  ['./internal/list', ['createKeyedList', 'toNodeArray']],
  ['./advanced', ['createRenderEffect', 'createContext', 'useContextAccessor']],
  ['./experimental/loader', ['installResumableLoader', 'waitForPendingHandlers']],
  ['./jsx-runtime', ['jsx', 'jsxs', 'Fragment']],
  ['./jsx-dev-runtime', ['jsxDEV', 'Fragment']],
]
const esmEntries = new Map()
const cjsEntries = new Map()

function fail(message) {
  console.error(`[runtime-package-smoke] ${message}`)
  process.exitCode = 1
}

for (const file of requiredDistFiles) {
  const filePath = path.join(runtimeDist, file)
  if (!existsSync(filePath)) {
    fail(`Missing runtime build artifact: ${path.relative(rootDir, filePath)}`)
  }
}

for (const file of forbiddenDistFiles) {
  const filePath = path.join(runtimeDist, file)
  if (existsSync(filePath)) {
    fail(`Unexpected non-exported runtime artifact: ${path.relative(rootDir, filePath)}`)
  }
}

if (process.exitCode) {
  console.error('[runtime-package-smoke] Run `pnpm --filter @fictjs/runtime build` first.')
  process.exit()
}

for (const [subpath, names] of exportChecks) {
  const entry = runtimePackageJson.exports?.[subpath]
  if (!entry?.import || !entry?.require || !entry?.types) {
    fail(`Package export ${subpath} must define import, require, and types targets.`)
    continue
  }

  const importTarget = path.join(runtimeDir, entry.import)
  const requireTarget = path.join(runtimeDir, entry.require)
  const typesTarget = path.join(runtimeDir, entry.types)
  if (!existsSync(typesTarget)) {
    fail(`Types target for ${subpath} is missing: ${path.relative(rootDir, typesTarget)}`)
  }

  const esm = await import(pathToFileURL(importTarget).href)
  const cjs = require(requireTarget)
  esmEntries.set(subpath, esm)
  cjsEntries.set(subpath, cjs)
  for (const name of names) {
    if (!(name in esm)) {
      fail(`ESM export ${subpath}#${name} is missing.`)
    }
    if (!(name in cjs)) {
      fail(`CJS export ${subpath}#${name} is missing.`)
    }
  }
}

const productionCycleSmoke = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const variants = [
  [
    'ESM',
    await import(${JSON.stringify(pathToFileURL(path.join(runtimeDist, 'index.js')).href)}),
    await import(${JSON.stringify(pathToFileURL(path.join(runtimeDist, 'advanced.js')).href)}),
  ],
  [
    'CJS',
    require(${JSON.stringify(path.join(runtimeDist, 'index.cjs'))}),
    require(${JSON.stringify(path.join(runtimeDist, 'advanced.cjs'))}),
  ],
]

for (const [label, runtime, advanced] of variants) {
  const warnings = []
  console.warn = (message, detail) => warnings.push({ message, detail })
  const value = advanced.createSignal(0)
  let runs = 0
  runtime.createEffect(() => {
    const current = value()
    runs++
    if (runs < 200000) value(current + 1)
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  const warning = warnings.find(entry => entry.message.includes('flush-budget-exceeded'))
  if (
    runs !== 100001 ||
    warning?.detail?.effectRuns !== 100001 ||
    warning?.detail?.limit !== 100000 ||
    warning?.detail?.hardLimit !== true
  ) {
    throw new Error(
      label + ' production cycle guard did not stop at its immutable limit: ' +
        JSON.stringify({ runs, warnings }),
    )
  }
}
`,
  ],
  {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  },
)
if (productionCycleSmoke.status !== 0) {
  const output = [productionCycleSmoke.stdout, productionCycleSmoke.stderr]
    .filter(Boolean)
    .join('\n')
    .trim()
  fail(`Production package cycle guard failed:\n${output}`)
}

const fragmentEntries = [
  ['ESM root', esmEntries.get('.')],
  ['ESM jsx-runtime', esmEntries.get('./jsx-runtime')],
  ['ESM jsx-dev-runtime', esmEntries.get('./jsx-dev-runtime')],
  ['CJS root', cjsEntries.get('.')],
  ['CJS jsx-runtime', cjsEntries.get('./jsx-runtime')],
  ['CJS jsx-dev-runtime', cjsEntries.get('./jsx-dev-runtime')],
]
const canonicalFragment = esmEntries.get('.')?.Fragment
for (const [label, entry] of fragmentEntries) {
  if (entry?.Fragment !== canonicalFragment) {
    fail(`${label} must share the root Fragment identity.`)
  }
}

rmSync(typeSmokeDir, { recursive: true, force: true })
mkdirSync(typeSmokeDir, { recursive: true })
try {
  const typeSmokePath = path.join(typeSmokeDir, 'fragment-types.ts')
  writeFileSync(
    typeSmokePath,
    `import { Fragment as RootFragment } from '../dist/index.js'
import { Fragment as JsxFragment, jsx } from '../dist/jsx-runtime.js'
import { Fragment as DevFragment, jsxDEV } from '../dist/jsx-dev-runtime.js'

const rootFromJsx: typeof RootFragment = JsxFragment
const rootFromDev: typeof RootFragment = DevFragment
const jsxFromRoot: typeof JsxFragment = RootFragment
const devFromRoot: typeof DevFragment = RootFragment
jsx(RootFragment, {})
jsxDEV(RootFragment, {})
void [rootFromJsx, rootFromDev, jsxFromRoot, devFromRoot]
`,
  )
  const typecheck = spawnSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeSmokePath,
    ],
    { cwd: rootDir, encoding: 'utf8' },
  )
  if (typecheck.status !== 0) {
    const output = [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n').trim()
    fail(`Runtime Fragment declarations are incompatible across entries:\n${output}`)
  }
} finally {
  rmSync(typeSmokeDir, { recursive: true, force: true })
}

const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'))
const { JSDOM } = runtimeRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const previousGlobals = new Map()
for (const name of [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'SVGElement',
  'DocumentFragment',
  'Text',
  'Comment',
]) {
  previousGlobals.set(name, globalThis[name])
  globalThis[name] = dom.window[name]
}

try {
  for (const [label, runtime, jsxRuntime, factoryName] of [
    ['ESM production', esmEntries.get('.'), esmEntries.get('./jsx-runtime'), 'jsxs'],
    ['ESM development', esmEntries.get('.'), esmEntries.get('./jsx-dev-runtime'), 'jsxDEV'],
    ['CJS production', cjsEntries.get('.'), cjsEntries.get('./jsx-runtime'), 'jsxs'],
    ['CJS development', cjsEntries.get('.'), cjsEntries.get('./jsx-dev-runtime'), 'jsxDEV'],
  ]) {
    const container = document.createElement('main')
    const dispose = runtime.render(
      () =>
        jsxRuntime[factoryName](jsxRuntime.Fragment, {
          children: [
            jsxRuntime.jsx('span', { children: 'a' }),
            jsxRuntime.jsx('span', { children: 'b' }),
          ],
        }),
      container,
    )
    if (container.innerHTML !== '<span>a</span><span>b</span>') {
      fail(`${label} JSX Fragment rendered an unexpected wrapper: ${container.innerHTML}`)
    }
    dispose()
  }
} finally {
  for (const [name, value] of previousGlobals) {
    if (value === undefined) {
      delete globalThis[name]
    } else {
      globalThis[name] = value
    }
  }
  dom.window.close()
}

if (!process.exitCode) {
  console.log('[runtime-package-smoke] Runtime package exports are usable.')
}
