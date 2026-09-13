import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import checks from '../.size-limit.mjs'
import { verifySizeInputs } from './verify-size-inputs.mjs'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fict-size-inputs-'))
  const write = (filename, text) => {
    const target = path.join(root, filename)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  write('package.json', JSON.stringify({ type: 'module' }))
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@fictjs/runtime': ['packages/runtime/src/index.ts'] },
      },
    }),
  )
  write('packages/runtime/src/index.ts', "export const marker = 'WORKSPACE SOURCE'\n")
  write(
    'node_modules/@fictjs/runtime/package.json',
    JSON.stringify({
      name: '@fictjs/runtime',
      type: 'module',
      exports: './dist/index.js',
    }),
  )
  write(
    'node_modules/@fictjs/runtime/dist/index.js',
    "export const marker = 'DISTRIBUTED PACKAGE'\n",
  )
  const esm = "import { marker } from '@fictjs/runtime'; console.log(marker)\n"
  write('packages/fict/dist/index.js', esm)
  write('packages/fict/dist/advanced.js', esm)
  write('packages/fict/dist/plus.js', esm)
  write('packages/fict/dist/index.cjs', "console.log(require('@fictjs/runtime').marker)\n")
  write('packages/fict/src/index.ts', esm)
  return root
}

test('every size budget uses distributed modules despite a conflicting workspace alias', async () => {
  const root = fixture()
  try {
    for (const check of checks) {
      const inputs = await verifySizeInputs(check, { root })
      assert.ok(inputs.includes('node_modules/@fictjs/runtime/dist/index.js'), check.name)
      assert.ok(!inputs.includes('packages/runtime/src/index.ts'), check.name)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removing the production alias boundary fails against the actual esbuild input graph', async () => {
  const root = fixture()
  try {
    for (const check of checks.slice(0, 2)) {
      const regressed = {
        ...check,
        modifyEsbuildConfig: config => {
          const production = check.modifyEsbuildConfig(config)
          delete production.tsconfigRaw
          return production
        },
      }
      await assert.rejects(
        verifySizeInputs(regressed, { root }),
        /loads workspace source.*packages\/runtime\/src\/index\.ts/,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a source entrypoint is rejected even when path aliases are disabled', async () => {
  const root = fixture()
  try {
    await assert.rejects(
      verifySizeInputs({ ...checks[0], path: 'packages/fict/src/index.ts' }, { root }),
      /loads workspace source.*packages\/fict\/src\/index\.ts/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
