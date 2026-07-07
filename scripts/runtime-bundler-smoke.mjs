#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(rootDir, 'packages/runtime')
const smokeDir = path.join(runtimeDir, '.tmp-bundler-smoke')
const entryPath = path.join(smokeDir, 'entry.js')
const bundleDir = path.join(smokeDir, 'out')
const bundlePath = path.join(bundleDir, 'entry.js')
const packageJson = JSON.parse(readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'))

function fail(message) {
  console.error(`[runtime-bundler-smoke] ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : '.'}`)
  }
  return result
}

if (packageJson.sideEffects !== false) {
  fail(
    'Expected @fictjs/runtime to keep sideEffects:false; update this smoke if the policy changes.',
  )
}

for (const file of ['dist/internal.js']) {
  const target = path.join(runtimeDir, file)
  if (!existsSync(target)) {
    fail(
      `Missing runtime build artifact: ${path.relative(rootDir, target)}. Run pnpm --filter @fictjs/runtime build first.`,
    )
  }
}

if (!readdirSync(path.join(runtimeDir, 'dist')).some(file => /^dom-[\w-]+\.js$/.test(file))) {
  fail('Missing runtime DOM chunk. Run pnpm --filter @fictjs/runtime build first.')
}

rmSync(smokeDir, { recursive: true, force: true })
mkdirSync(smokeDir, { recursive: true })

try {
  writeFileSync(
    entryPath,
    `import { assign, reactive, spread } from '@fictjs/runtime/internal'

const host = document.createElement('section')
const assigned = document.createElement('section')

spread(
  host,
  {
    children: reactive(() => ({
      type: 'span',
      props: { id: 'child', children: 'ok' },
      key: undefined,
    })),
  },
  false,
  false,
)

assign(
  assigned,
  {
    children: reactive(() => ({
      type: 'span',
      props: { id: 'assigned-child', children: 'assigned' },
      key: undefined,
    })),
  },
  false,
  false,
  {},
)

await Promise.resolve()

const child = host.querySelector('#child')
if (!child || child.textContent !== 'ok' || host.innerHTML !== '<span id="child">ok</span>') {
  throw new Error(\`Expected tree-shaken internal spread bundle to preserve createElement registration, got: \${host.innerHTML}\`)
}

const assignedChild = assigned.querySelector('#assigned-child')
if (
  !assignedChild ||
  assignedChild.textContent !== 'assigned' ||
  assigned.innerHTML !== '<span id="assigned-child">assigned</span>'
) {
  throw new Error(\`Expected tree-shaken internal assign bundle to preserve createElement registration, got: \${assigned.innerHTML}\`)
}
`,
  )

  run('pnpm', [
    '-C',
    runtimeDir,
    'exec',
    'tsdown',
    entryPath,
    '--no-config',
    '--format',
    'esm',
    '--out-dir',
    bundleDir,
    '--platform',
    'browser',
    '--logLevel',
    'silent',
    '--no-sourcemap',
  ])

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
    await import(pathToFileURL(bundlePath).href)
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
} finally {
  rmSync(smokeDir, { recursive: true, force: true })
}

console.log('[runtime-bundler-smoke] Runtime internal bundle preserves DOM registration.')
