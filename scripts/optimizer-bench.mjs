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

import {
  evaluateBaseline,
  parseBenchmarkCount,
  resolveBenchmarkBudgets,
  retryTimingFailures,
  runInterleavedMeasurements,
  validateBenchmarkRows,
} from './optimizer-bench-sampling.mjs'

const require = createRequire(import.meta.url)
const iterations = parseBenchmarkCount('BENCH_ITERS', process.env.BENCH_ITERS, 50)
const warmup = parseBenchmarkCount('BENCH_WARMUP', process.env.BENCH_WARMUP, 5, {
  allowZero: true,
})
const repeats = parseBenchmarkCount('BENCH_REPEATS', process.env.BENCH_REPEATS, 5)
const updateBaseline = process.argv.includes('--update')
const compareBaseline = process.argv.includes('--compare')
const outputPath = getOutputPath(process.argv, process.env.BENCH_OUTPUT)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const baselinePath = getBaselinePath(
  process.argv,
  path.join(__dirname, 'optimizer-bench.baseline.json'),
)
let createFictPlugin

if (updateBaseline && compareBaseline) {
  throw new Error('--update and --compare are mutually exclusive')
}
if (outputPath && path.resolve(process.cwd(), outputPath) === baselinePath) {
  throw new Error('Benchmark output path must differ from the baseline path')
}

const DEFAULT_BUDGETS = {
  timeRegressionRatio: 0.25,
  timeRegressionMinMs: 0.5,
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
  {
    name: 'keyed-list-dom',
    options: { fineGrainedDom: true },
    source: `
      import { $state } from 'fict'
      export function Menu() {
        let selected = $state(1)
        const items = [1, 2, 3]
        return (
          <ul>
            {items.map(item => (
              <li
                key={item}
                class={{ active: item === selected }}
                style={{ order: item }}
                onClick={() => selected = item}
              >
                {item === selected ? <span>{selected}</span> : item}
              </li>
            ))}
          </ul>
        )
      }
    `,
  },
  {
    name: 'props-destructure-rest',
    options: { fineGrainedDom: true },
    source: `
      export function Profile(props) {
        const {
          user: { name = 'Ada' } = {},
          title = 'Engineer',
          ...rest
        } = props
        return <section data-role={rest.role}>{title}: {name}</section>
      }
    `,
  },
  {
    name: 'cross-module-metadata',
    options: {
      fineGrainedDom: true,
      resolveModuleMetadata: source =>
        source === 'counter-lib'
          ? {
              version: 1,
              exports: {},
              hooks: {
                useCounter: { directAccessor: 'signal' },
              },
            }
          : undefined,
    },
    source: `
      import { useCounter } from 'counter-lib'
      export function App() {
        const count = useCounter()
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `,
  },
  {
    name: 'resumable-handler',
    options: { fineGrainedDom: true, resumable: true },
    source: `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `,
  },
]

function getOutputPath(argv, envOutputPath) {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--output' || arg === '--json') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a file path`)
      }
      return value
    }
    if (arg.startsWith('--output=')) {
      return arg.slice('--output='.length)
    }
    if (arg.startsWith('--json=')) {
      return arg.slice('--json='.length)
    }
  }

  return envOutputPath?.trim() ? envOutputPath : null
}

function getBaselinePath(argv, fallbackPath) {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--baseline') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--baseline requires a file path')
      }
      return path.resolve(process.cwd(), value)
    }
    if (arg.startsWith('--baseline=')) {
      const value = arg.slice('--baseline='.length)
      if (!value) throw new Error('--baseline requires a file path')
      return path.resolve(process.cwd(), value)
    }
  }

  return path.resolve(fallbackPath)
}

function getFictPlugin() {
  if (createFictPlugin) return createFictPlugin

  const modulePath = path.join(__dirname, '../packages/compiler/dist/legacy.cjs')
  const loaded = require(modulePath)
  createFictPlugin = loaded?.default ?? loaded
  if (typeof createFictPlugin !== 'function') {
    throw new Error(`Benchmark compiler module must export a plugin function: ${modulePath}`)
  }
  return createFictPlugin
}

function compile(sample, optimize) {
  return transformSync(sample.source, {
    filename: 'bench.tsx',
    // Perf benchmark should compare optimizer output/latency, not fail on policy escalation.
    plugins: [
      [
        getFictPlugin(),
        {
          dev: false,
          optimize,
          fineGrainedDom: false,
          strictGuarantee: false,
          ...(sample.options ?? {}),
        },
      ],
    ],
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    configFile: false,
    babelrc: false,
  })
}

function warmSample(sample, optimize) {
  for (let i = 0; i < warmup; i++) {
    compile(sample, optimize)
  }
}

function runSample(sample, optimize) {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    compile(sample, optimize)
  }
  const end = performance.now()
  return (end - start) / iterations
}

function runSampleStable(sample) {
  return runInterleavedMeasurements({
    repeats,
    warmup: optimize => warmSample(sample, optimize),
    measure: optimize => runSample(sample, optimize),
  })
}

function measureSize(sample, optimize) {
  const result = compile(sample, optimize)
  const code = result?.code ?? ''
  return Buffer.byteLength(code, 'utf8')
}

function assertBaselineComparison(comparison) {
  if (!comparison || comparison.failures.length === 0) {
    return
  }
  const message = comparison.failures.join('\n')
  const runtimeScale =
    typeof comparison.runtimeScale === 'number' ? `${comparison.runtimeScale.toFixed(2)}x` : 'n/a'
  throw new Error(
    `[optimizer-bench] Baseline regressions (runtimeScale=${runtimeScale}):\n${message}`,
  )
}

function writeBenchmarkReport(targetPath, rows, baseline, comparison) {
  const resolvedPath = path.resolve(process.cwd(), targetPath)
  const budgets = comparison?.budgets ?? resolveBenchmarkBudgets(baseline, DEFAULT_BUDGETS)
  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    benchmark: {
      iterations,
      warmup,
      repeats,
      sampling: 'paired-interleaved',
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    budgets,
    baseline: baseline
      ? {
          path: path.relative(process.cwd(), baselinePath),
          samples: baseline.samples ?? {},
        }
      : null,
    comparison,
    samples: rows,
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`Optimizer benchmark raw output written to ${resolvedPath}`)
}

function measureBenchmarkSample(sample) {
  const timings = runSampleStable(sample)
  const optimized = Number(timings.optimized.toFixed(2))
  const unoptimized = Number(timings.unoptimized.toFixed(2))
  const optimizedBytes = measureSize(sample, true)
  const unoptimizedBytes = measureSize(sample, false)
  return {
    sample: sample.name,
    optimized_ms: optimized,
    unoptimized_ms: unoptimized,
    optimized_runs: timings.optimizedRuns,
    unoptimized_runs: timings.unoptimizedRuns,
    delta_ms: Number((optimized - unoptimized).toFixed(2)),
    optimized_bytes: optimizedBytes,
    unoptimized_bytes: unoptimizedBytes,
    delta_bytes: optimizedBytes - unoptimizedBytes,
  }
}

function main() {
  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    : null
  if (compareBaseline && !baseline) {
    const message = `Missing baseline at ${baselinePath}. Run with --update to generate.`
    const comparison = {
      status: 'failed',
      runtimeScale: null,
      budgets: resolveBenchmarkBudgets(null, DEFAULT_BUDGETS),
      failures: [message],
      failureDetails: [{ type: 'missing', sample: baselinePath, message }],
    }
    if (outputPath) writeBenchmarkReport(outputPath, [], null, comparison)
    assertBaselineComparison(comparison)
  }

  let rows = samples.map(measureBenchmarkSample)
  validateBenchmarkRows(rows)
  let reportBaseline = baseline
  let comparison = null

  if (updateBaseline) {
    const payload = {
      budgets: resolveBenchmarkBudgets(baseline, DEFAULT_BUDGETS),
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
    reportBaseline = payload
    console.log(`Optimizer bench baseline updated at ${baselinePath}`)
  } else {
    if (compareBaseline) {
      comparison = evaluateBaseline(rows, baseline, DEFAULT_BUDGETS)
      const retry = retryTimingFailures({
        rows,
        comparison,
        measureSample: sampleName => {
          const sample = samples.find(candidate => candidate.name === sampleName)
          if (!sample) throw new Error(`Unknown optimizer benchmark sample: ${sampleName}`)
          return measureBenchmarkSample(sample)
        },
        evaluate: (retriedRows, runtimeScale) =>
          evaluateBaseline(retriedRows, baseline, DEFAULT_BUDGETS, { runtimeScale }),
      })
      rows = retry.rows
      comparison = retry.comparison
      if (retry.retriedSamples.length > 0) {
        console.warn(
          `[optimizer-bench] Re-measured timing-only failures with fixed calibration: ${retry.retriedSamples.join(', ')}`,
        )
      }
    }

    if (outputPath) {
      writeBenchmarkReport(outputPath, rows, reportBaseline, comparison)
    }

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
      assertBaselineComparison(comparison)
      console.log('Optimizer bench baseline check passed.')
    }
  }

  if (updateBaseline && outputPath) {
    writeBenchmarkReport(outputPath, rows, reportBaseline, comparison)
  }
}

export function runOptimizerBenchmark({ compilerPlugin } = {}) {
  if (compilerPlugin !== undefined) {
    if (typeof compilerPlugin !== 'function') {
      throw new Error('Injected benchmark compiler must be a plugin function')
    }
    createFictPlugin = compilerPlugin
  }
  return main()
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    runOptimizerBenchmark()
  } catch (err) {
    console.error('[optimizer-bench] Failed:', err)
    process.exitCode = 1
  }
}
