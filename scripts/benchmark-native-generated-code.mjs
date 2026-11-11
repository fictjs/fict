// Run identical default-option inputs against saved native artifacts. Each
// sample gets its own process, timeout, and crash status; timing is observational.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { generatedCode, generatedCodeSizes } from './lib/native-generated-code-fixtures.mjs'

const { values } = parseArgs({
  options: {
    native: { type: 'string' },
    case: { type: 'string' },
    sizes: { type: 'string' },
    samples: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '60000' },
    child: { type: 'boolean', default: false },
  },
})
const nativePath = resolve(
  values.native ??
    process.env.FICT_COMPILER_NATIVE_PATH ??
    'target/release/fict_compiler_napi.node',
)
if (values.child) {
  const native = createRequire(import.meta.url)(nativePath)
  const source = generatedCode(values.case, Number(values.sizes))
  const start = performance.now()
  const result = native.transformSync({ code: source, filename: '/generated.tsx' })
  const ms = performance.now() - start
  if (result.diagnostics.length === 0 && ['branches', 'switch'].includes(values.case)) {
    const output = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`
    )
    const size = Number(values.sizes)
    for (let index = 0; index < size; index++) assert.equal(output.f(index), index)
    assert.equal(output.f(size), -1)
  }
  console.log(
    JSON.stringify({
      bytes: Buffer.byteLength(source),
      ms,
      diagnostics: result.diagnostics,
      outputBytes: Buffer.byteLength(result.code ?? ''),
      stats: result.stats,
    }),
  )
} else {
  const samples = Number(values.samples),
    timeout = Number(values.timeout)
  if (
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1
  )
    throw new Error('samples and timeout must be positive integers')
  const cases = values.case ? [values.case] : Object.keys(generatedCodeSizes)
  for (const kind of cases) {
    const sizes = values.sizes?.split(',').map(Number) ?? generatedCodeSizes[kind]
    if (!sizes?.length || sizes.some(size => !Number.isSafeInteger(size) || size < 1))
      throw new Error(`Invalid sizes for ${kind}`)
    for (const size of sizes) {
      const results = []
      for (let sample = 0; sample < samples; sample++) {
        const child = spawnSync(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            '--child',
            '--native',
            nativePath,
            '--case',
            kind,
            '--sizes',
            String(size),
          ],
          { timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        )
        results.push({
          status: child.status,
          signal: child.signal,
          error: child.error?.code,
          stderr: child.stderr,
          ...(child.stdout.trim() ? JSON.parse(child.stdout) : {}),
        })
      }
      const valid = results.filter(
        result => result.status === 0 && result.diagnostics?.length === 0 && result.outputBytes > 0,
      )
      const times = valid.map(result => result.ms).sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          kind,
          size,
          nativePath,
          medianMs:
            valid.length === samples
              ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) /
                2
              : null,
          samples: results,
        }),
      )
      if (valid.length !== samples) process.exitCode = 1
    }
  }
}
