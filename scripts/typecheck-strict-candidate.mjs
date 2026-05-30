#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tscBin = require.resolve('typescript/bin/tsc')
const failOnError = process.argv.includes('--fail-on-error')
const maxOutputLines = Number(process.env.FICT_STRICT_CANDIDATE_MAX_LINES ?? 80)

const distBackedTypeDependencies = ['packages/compiler', 'packages/eslint-plugin']

const candidates = [
  {
    packageName: 'compiler',
    flags: ['exactOptionalPropertyTypes', 'noImplicitReturns', 'noUncheckedIndexedAccess'],
  },
  {
    packageName: 'devtools',
    flags: ['exactOptionalPropertyTypes', 'noImplicitReturns', 'noUncheckedIndexedAccess'],
  },
  {
    packageName: 'ssr',
    flags: ['exactOptionalPropertyTypes', 'noImplicitReturns', 'noUncheckedIndexedAccess'],
  },
  {
    packageName: 'vite-plugin',
    flags: ['exactOptionalPropertyTypes', 'noImplicitReturns', 'noUncheckedIndexedAccess'],
  },
  { packageName: 'vscode-extension', flags: ['exactOptionalPropertyTypes'] },
]

function flagArgs(flags) {
  return flags.flatMap(flag => [`--${flag}`, 'true'])
}

function packageManagerInvocation(args) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /pnpm(?:\.cjs|\.js|\.mjs)?$/.test(path.basename(npmExecPath))) {
    return { command: process.execPath, args: [npmExecPath, ...args] }
  }

  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args }
}

function runPnpm(args) {
  const invocation = packageManagerInvocation(args)
  execFileSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
}

function prepareDistBackedTypeDependencies() {
  console.log('Preparing dist-backed type dependencies for strict candidate checks...')
  for (const packageDir of distBackedTypeDependencies) {
    runPnpm(['--dir', packageDir, 'build'])
  }
}

prepareDistBackedTypeDependencies()

let failed = 0

for (const candidate of candidates) {
  const tsconfig = path.join(repoRoot, 'packages', candidate.packageName, 'tsconfig.json')
  const args = [
    tscBin,
    '-p',
    tsconfig,
    '--noEmit',
    '--pretty',
    'false',
    ...flagArgs(candidate.flags),
  ]

  try {
    execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`ok ${candidate.packageName}: strict candidate flags pass`)
  } catch (error) {
    failed++
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    console.log(`fail ${candidate.packageName}: ${candidate.flags.join(', ')}`)
    if (output) {
      const lines = output.split('\n')
      const limit = Number.isFinite(maxOutputLines) && maxOutputLines > 0 ? maxOutputLines : 80
      console.log(lines.slice(0, limit).join('\n'))
      if (lines.length > limit) {
        console.log(
          `... truncated ${lines.length - limit} line(s); set FICT_STRICT_CANDIDATE_MAX_LINES for more.`,
        )
      }
    }
  }
}

if (failed > 0) {
  console.log(
    `Strict candidate report: ${failed}/${candidates.length} package(s) still need hardening.`,
  )
  if (failOnError) {
    process.exit(1)
  }
} else {
  console.log('Strict candidate report: all package overrides can be removed.')
}
