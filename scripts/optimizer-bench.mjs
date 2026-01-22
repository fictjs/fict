#!/usr/bin/env node

/**
 * Optimizer benchmark: compare compile time with optimize on/off.
 * Requires built compiler output: `pnpm --filter @fictjs/compiler build`.
 */
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from '@babel/core'

const require = createRequire(import.meta.url)
const { default: createFictPlugin } = require('../packages/compiler/dist/index.cjs')

const iterations = Number(process.env.BENCH_ITERS ?? 50)
const warmup = Number(process.env.BENCH_WARMUP ?? 5)
const updateBaseline = process.argv.includes('--update')
const compareBaseline = process.argv.includes('--compare')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const baselinePath = path.join(__dirname, 'optimizer-bench.baseline.json')

const DEFAULT_BUDGETS = {
  timeRegressionRatio: 0.25,
  sizeRegressionRatio: 0.15,
  slowdownRatio: 0.35,
}

const samples = [
  {
    name: 'reactive-branch',
    source: `
      import { $state } from 'fict'
      export function Demo(flag) {
        let count = $state(1)
        const doubled = count * 2
        if (flag) return doubled + count
        return doubled + count
      }
    `,
  },
  {
    name: 'array-map',
    source: `
      import { $state } from 'fict'
      export function Demo(items) {
        let count = $state(0)
        const mapped = items.map(item => item + count)
        return mapped
      }
    `,
  },
  {
    name: 'no-jsx',
    source: `
      import { $state } from 'fict'
      export function useCounter() {
        let count = $state(0)
        const doubled = count * 2
        return { count, doubled }
      }
    `,
  },
]

function compile(source, optimize) {
  return transformSync(source, {
    filename: 'bench.tsx',
    plugins: [[createFictPlugin, { dev: false, optimize, fineGrainedDom: false }]],
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    configFile: false,
    babelrc: false,
  })
}

function runSample(sample, optimize) {
  for (let i = 0; i < warmup; i++) {
    compile(sample.source, optimize)
  }
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    compile(sample.source, optimize)
  }
  const end = performance.now()
  return (end - start) / iterations
}

function measureSize(sample, optimize) {
  const result = compile(sample.source, optimize)
  const code = result?.code ?? ''
  return Buffer.byteLength(code, 'utf8')
}

function compareWithBaseline(rows, baseline) {
  const budgets = { ...DEFAULT_BUDGETS, ...(baseline?.budgets ?? {}) }
  const failures = []

  for (const row of rows) {
    const expected = baseline?.samples?.[row.sample]
    if (!expected) {
      failures.push(`Missing baseline for ${row.sample}`)
      continue
    }

    const timeLimit = expected.optimized_ms * (1 + budgets.timeRegressionRatio)
    if (row.optimized_ms > timeLimit) {
      failures.push(`${row.sample}: optimized_ms ${row.optimized_ms} > ${timeLimit.toFixed(2)}`)
    }

    const sizeLimit = expected.optimized_bytes * (1 + budgets.sizeRegressionRatio)
    if (row.optimized_bytes > sizeLimit) {
      failures.push(
        `${row.sample}: optimized_bytes ${row.optimized_bytes} > ${Math.round(sizeLimit)}`,
      )
    }

    const slowdown = row.optimized_ms / row.unoptimized_ms
    const baselineSlowdown = expected.optimized_ms / expected.unoptimized_ms
    if (slowdown > baselineSlowdown + budgets.slowdownRatio) {
      failures.push(
        `${row.sample}: slowdown ${slowdown.toFixed(2)} > ${(baselineSlowdown + budgets.slowdownRatio).toFixed(2)}`,
      )
    }
  }

  if (failures.length > 0) {
    const message = failures.join('\n')
    throw new Error(`[optimizer-bench] Baseline regressions:\n${message}`)
  }
}

function main() {
  const rows = []
  for (const sample of samples) {
    const optimized = Number(runSample(sample, true).toFixed(2))
    const unoptimized = Number(runSample(sample, false).toFixed(2))
    const optimizedBytes = measureSize(sample, true)
    const unoptimizedBytes = measureSize(sample, false)
    rows.push({
      sample: sample.name,
      optimized_ms: optimized,
      unoptimized_ms: unoptimized,
      delta_ms: Number((optimized - unoptimized).toFixed(2)),
      optimized_bytes: optimizedBytes,
      unoptimized_bytes: unoptimizedBytes,
      delta_bytes: optimizedBytes - unoptimizedBytes,
    })
  }

  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    : null

  if (updateBaseline) {
    const payload = {
      budgets: baseline?.budgets ?? DEFAULT_BUDGETS,
      samples: Object.fromEntries(
        rows.map(row => [
          row.sample,
          {
            optimized_ms: row.optimized_ms,
            unoptimized_ms: row.unoptimized_ms,
            optimized_bytes: row.optimized_bytes,
            unoptimized_bytes: row.unoptimized_bytes,
          },
        ]),
      ),
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`Optimizer bench baseline updated at ${baselinePath}`)
  } else {
    console.log('Optimizer benchmark (avg ms per compile):')
    console.table(
      rows.map(row => ({
        sample: row.sample,
        optimized_ms: row.optimized_ms.toFixed(2),
        unoptimized_ms: row.unoptimized_ms.toFixed(2),
        delta_ms: row.delta_ms.toFixed(2),
        optimized_bytes: row.optimized_bytes,
        unoptimized_bytes: row.unoptimized_bytes,
        delta_bytes: row.delta_bytes,
      })),
    )

    if (compareBaseline) {
      if (!baseline) {
        throw new Error(`Missing baseline at ${baselinePath}. Run with --update to generate.`)
      }
      compareWithBaseline(rows, baseline)
      console.log('Optimizer bench baseline check passed.')
    }
  }
}

try {
  main()
} catch (err) {
  console.error('[optimizer-bench] Failed:', err)
  process.exitCode = 1
}
