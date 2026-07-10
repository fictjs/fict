import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const scriptPath = path.join(repoRoot, 'scripts/optimizer-bench.mjs')

function runBenchmark(args: string[], env: Record<string, string> = {}, entrypoint = scriptPath) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BENCH_ITERS: '1',
      BENCH_WARMUP: '0',
      BENCH_REPEATS: '1',
      ...env,
    },
  })
}

describe('optimizer benchmark CLI', () => {
  it.each([
    ['BENCH_ITERS', '0'],
    ['BENCH_ITERS', 'NaN'],
    ['BENCH_ITERS', '9007199254740992'],
    ['BENCH_WARMUP', '-1'],
    ['BENCH_WARMUP', ''],
    ['BENCH_REPEATS', '1.5'],
  ])('rejects invalid %s=%s before loading the compiler', (name, value) => {
    const result = runBenchmark([], { [name]: value })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${name} must`)
  })

  it('reports a missing comparison baseline without running measurements', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'fict-bench-missing-'))
    try {
      const baselinePath = path.join(tempRoot, 'missing.json')
      const reportPath = path.join(tempRoot, 'report.json')
      const result = runBenchmark(['--compare', '--baseline', baselinePath, '--output', reportPath])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Missing baseline')

      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(report.schemaVersion).toBe(2)
      expect(report.samples).toEqual([])
      expect(report.comparison).toMatchObject({
        status: 'failed',
        runtimeScale: null,
        failureDetails: [{ type: 'missing', sample: baselinePath }],
      })
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects conflicting modes and baseline/output path collisions', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'fict-bench-options-'))
    try {
      const baselinePath = path.join(tempRoot, 'baseline.json')
      const conflictingModes = runBenchmark(['--update', '--compare', '--baseline', baselinePath])
      const collidingPaths = runBenchmark([
        '--update',
        '--baseline',
        baselinePath,
        '--output',
        baselinePath,
      ])

      expect(conflictingModes.status).toBe(1)
      expect(conflictingModes.stderr).toContain('mutually exclusive')
      expect(collidingPaths.status).toBe(1)
      expect(collidingPaths.stderr).toContain('must differ')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('updates an isolated baseline and writes auditable raw timing runs', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'fict-bench-update-'))
    try {
      const runnerPath = path.join(tempRoot, 'benchmark-runner.mjs')
      const baselinePath = path.join(tempRoot, 'baseline.json')
      const reportPath = path.join(tempRoot, 'report.json')
      const budgets = {
        timeRegressionRatio: 0.3,
        timeRegressionMinMs: 0.6,
        sizeRegressionRatio: 0.2,
        slowdownRatio: 0.4,
      }
      writeFileSync(
        runnerPath,
        `
import { runOptimizerBenchmark } from ${JSON.stringify(pathToFileURL(scriptPath).href)}

function fakeFictCompiler() {
  return { visitor: {} }
}

try {
  runOptimizerBenchmark({ compilerPlugin: fakeFictCompiler })
} catch (error) {
  console.error('[optimizer-bench-test] Failed:', error)
  process.exitCode = 1
}
`,
      )
      writeFileSync(baselinePath, `${JSON.stringify({ budgets, samples: {} })}\n`)

      const result = runBenchmark(
        ['--update', '--baseline', baselinePath, '--output', reportPath],
        {},
        runnerPath,
      )

      expect(result.status, result.stderr).toBe(0)
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
      expect(baseline.budgets).toEqual(budgets)
      expect(Object.keys(baseline.samples)).toHaveLength(7)
      expect(baseline.samples['reactive-branch']).not.toHaveProperty('optimized_runs')

      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(report.schemaVersion).toBe(2)
      expect(report.benchmark).toMatchObject({
        iterations: 1,
        warmup: 0,
        repeats: 1,
        sampling: 'paired-interleaved',
      })
      expect(report.samples).toHaveLength(7)
      for (const sample of report.samples) {
        expect(sample.optimized_runs).toHaveLength(1)
        expect(sample.unoptimized_runs).toHaveLength(1)
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
