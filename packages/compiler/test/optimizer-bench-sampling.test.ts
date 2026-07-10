import { describe, expect, it } from 'vitest'

interface SamplingResult {
  optimized: number
  unoptimized: number
  optimizedRuns: number[]
  unoptimizedRuns: number[]
}

type BenchmarkRow = Record<string, string | number>

interface BenchmarkComparison {
  status: string
  runtimeScale: number
  failures: string[]
  failureDetails: Array<{ type: string; sample: string; message: string }>
}

interface SamplingModule {
  runInterleavedMeasurements(options: {
    repeats: number
    warmup: (optimize: boolean) => void
    measure: (optimize: boolean) => number
  }): SamplingResult
  evaluateBaseline(
    rows: BenchmarkRow[],
    baseline: {
      budgets?: Record<string, number>
      samples: Record<string, Record<string, number>>
    },
    budgets: Record<string, number>,
    options?: { runtimeScale?: number },
  ): BenchmarkComparison
  retryTimingFailures(options: {
    rows: BenchmarkRow[]
    comparison: BenchmarkComparison
    measureSample: (sample: string) => BenchmarkRow
    evaluate: (rows: BenchmarkRow[], runtimeScale: number) => BenchmarkComparison
  }): {
    rows: BenchmarkRow[]
    comparison: BenchmarkComparison & {
      retry?: {
        samples: string[]
        initialRuntimeScale: number
        initialFailures: string[]
        observedFailures: string[]
      }
    }
    retriedSamples: string[]
  }
}

async function loadSamplingModule(): Promise<SamplingModule> {
  const moduleUrl = new URL('../../../scripts/optimizer-bench-sampling.mjs', import.meta.url).href
  return (await import(moduleUrl)) as SamplingModule
}

describe('optimizer benchmark sampling', () => {
  it('warms both modes and alternates their measurement order', async () => {
    const { runInterleavedMeasurements } = await loadSamplingModule()
    const warmups: boolean[] = []
    const measurements: boolean[] = []

    runInterleavedMeasurements({
      repeats: 4,
      warmup: optimize => warmups.push(optimize),
      measure: optimize => {
        measurements.push(optimize)
        return optimize ? 2 : 1
      },
    })

    expect(warmups).toEqual([true, false])
    expect(measurements).toEqual([true, false, false, true, true, false, false, true])
  })

  it('uses per-mode medians so a single scheduling spike does not fail the sample', async () => {
    const { runInterleavedMeasurements } = await loadSamplingModule()
    const optimized = [100, 2, 2, 2, 2]
    const unoptimized = [1, 1, 1, 1, 1]

    const result = runInterleavedMeasurements({
      repeats: 5,
      warmup: () => undefined,
      measure: optimize => (optimize ? optimized.shift() : unoptimized.shift()) ?? 0,
    })

    expect(result.optimized).toBe(2)
    expect(result.unoptimized).toBe(1)
    expect(result.optimizedRuns).toHaveLength(5)
    expect(result.unoptimizedRuns).toHaveLength(5)
  })

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive or non-finite measured timing (%s)',
    async timing => {
      const { runInterleavedMeasurements } = await loadSamplingModule()

      expect(() =>
        runInterleavedMeasurements({
          repeats: 1,
          warmup: () => undefined,
          measure: () => timing,
        }),
      ).toThrow('timing must be a finite number')
    },
  )

  it('fails closed for malformed rows, baselines, budgets, and fixed scales', async () => {
    const { evaluateBaseline } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const row = {
      sample: 'fixture',
      optimized_ms: 1,
      unoptimized_ms: 1,
      optimized_bytes: 100,
      unoptimized_bytes: 100,
    }
    const expected = {
      optimized_ms: 1,
      unoptimized_ms: 1,
      optimized_bytes: 100,
      unoptimized_bytes: 100,
    }

    expect(() =>
      evaluateBaseline(
        [{ ...row, optimized_ms: Number.NaN }],
        {
          samples: { fixture: expected },
        },
        budgets,
      ),
    ).toThrow('fixture optimized_ms')
    expect(() =>
      evaluateBaseline(
        [row],
        {
          samples: { fixture: { ...expected, optimized_ms: undefined as unknown as number } },
        },
        budgets,
      ),
    ).toThrow('Baseline fixture optimized_ms')
    expect(() =>
      evaluateBaseline(
        [row],
        { budgets: { slowdownRatio: -1 }, samples: { fixture: expected } },
        budgets,
      ),
    ).toThrow('Benchmark budget slowdownRatio')
    expect(() =>
      evaluateBaseline([row], { samples: { fixture: expected } }, budgets, {
        runtimeScale: Number.POSITIVE_INFINITY,
      }),
    ).toThrow('Benchmark runtime scale')
    expect(() =>
      evaluateBaseline(
        [{ ...row, unoptimized_ms: Number.MAX_VALUE }],
        {
          samples: {
            fixture: { ...expected, unoptimized_ms: Number.EPSILON },
          },
        },
        budgets,
      ),
    ).toThrow('fixture runtime scale factor')
    expect(() =>
      evaluateBaseline(
        [row],
        {
          samples: {
            fixture: { ...expected, optimized_ms: Number.MAX_VALUE },
          },
        },
        budgets,
        { runtimeScale: Number.MAX_VALUE },
      ),
    ).toThrow('fixture scaled expected time')
  })

  it('continues to reject real timing and output-size regressions', async () => {
    const { evaluateBaseline } = await loadSamplingModule()
    const comparison = evaluateBaseline(
      [
        {
          sample: 'fixture',
          optimized_ms: 2,
          unoptimized_ms: 1,
          optimized_bytes: 120,
          unoptimized_bytes: 100,
        },
      ],
      {
        samples: {
          fixture: {
            optimized_ms: 1,
            unoptimized_ms: 1,
            optimized_bytes: 100,
            unoptimized_bytes: 100,
          },
        },
      },
      {
        timeRegressionRatio: 0.25,
        timeRegressionMinMs: 0.5,
        sizeRegressionRatio: 0.15,
        slowdownRatio: 0.35,
      },
    )

    expect(comparison.status).toBe('failed')
    expect(comparison.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('optimized_ms'),
        expect.stringContaining('optimized_bytes'),
        expect.stringContaining('slowdown'),
      ]),
    )
  })

  it('retries timing-only failures once and requires the retry to pass', async () => {
    const { evaluateBaseline, retryTimingFailures } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const baseline = {
      samples: {
        fixture: {
          optimized_ms: 1,
          unoptimized_ms: 1,
          optimized_bytes: 100,
          unoptimized_bytes: 100,
        },
      },
    }
    const initialRows: BenchmarkRow[] = [
      {
        sample: 'fixture',
        optimized_ms: 2,
        unoptimized_ms: 1,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
    ]
    const initialComparison = evaluateBaseline(initialRows, baseline, budgets)
    let measurements = 0

    const result = retryTimingFailures({
      rows: initialRows,
      comparison: initialComparison,
      measureSample: sample => {
        measurements++
        return {
          sample,
          optimized_ms: 1,
          unoptimized_ms: 1,
          optimized_bytes: 100,
          unoptimized_bytes: 100,
        }
      },
      evaluate: (rows, runtimeScale) => evaluateBaseline(rows, baseline, budgets, { runtimeScale }),
    })

    expect(measurements).toBe(1)
    expect(result.retriedSamples).toEqual(['fixture'])
    expect(result.comparison.status).toBe('passed')
    expect(result.comparison.retry?.initialFailures).not.toHaveLength(0)
  })

  it('keeps the first calibration when the same sample fails both rounds', async () => {
    const { evaluateBaseline, retryTimingFailures } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const baseline = {
      samples: Object.fromEntries(
        ['fixture', 'control-a', 'control-b'].map(sample => [
          sample,
          {
            optimized_ms: 1,
            unoptimized_ms: 1,
            optimized_bytes: 100,
            unoptimized_bytes: 100,
          },
        ]),
      ),
    }
    const rows: BenchmarkRow[] = [
      {
        sample: 'fixture',
        optimized_ms: 1.6,
        unoptimized_ms: 1.3,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
      {
        sample: 'control-a',
        optimized_ms: 1,
        unoptimized_ms: 1,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
      {
        sample: 'control-b',
        optimized_ms: 1,
        unoptimized_ms: 1,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
    ]
    const initialComparison = evaluateBaseline(rows, baseline, budgets)
    let retryScale = 0

    const result = retryTimingFailures({
      rows,
      comparison: initialComparison,
      measureSample: () => rows[0]!,
      evaluate: (retriedRows, runtimeScale) => {
        retryScale = runtimeScale
        return evaluateBaseline(retriedRows, baseline, budgets, { runtimeScale })
      },
    })

    expect(initialComparison.runtimeScale).toBe(1)
    expect(retryScale).toBe(initialComparison.runtimeScale)
    expect(result.comparison.retry?.initialRuntimeScale).toBe(1)
    expect(result.comparison.status).toBe('failed')
    expect(result.comparison.failures).toEqual(
      expect.arrayContaining([expect.stringContaining('fixture')]),
    )
  })

  it('re-measures only initially failing samples and preserves passing rows', async () => {
    const { evaluateBaseline, retryTimingFailures } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const baseline = {
      samples: Object.fromEntries(
        ['first', 'second'].map(sample => [
          sample,
          {
            optimized_ms: 1,
            unoptimized_ms: 1,
            optimized_bytes: 100,
            unoptimized_bytes: 100,
          },
        ]),
      ),
    }
    const row = (sample: string, optimizedMs: number): BenchmarkRow => ({
      sample,
      optimized_ms: optimizedMs,
      unoptimized_ms: 1,
      optimized_bytes: 100,
      unoptimized_bytes: 100,
    })
    const rows = [row('first', 2), row('second', 1)]
    const measuredSamples: string[] = []

    const result = retryTimingFailures({
      rows,
      comparison: evaluateBaseline(rows, baseline, budgets),
      measureSample: sample => {
        measuredSamples.push(sample)
        return row(sample, 1)
      },
      evaluate: (retriedRows, runtimeScale) =>
        evaluateBaseline(retriedRows, baseline, budgets, { runtimeScale }),
    })

    expect(measuredSamples).toEqual(['first'])
    expect(result.comparison.status).toBe('passed')
    expect(result.comparison.failures).toEqual([])
    expect(result.comparison.retry?.observedFailures).toEqual([])
    expect(result.rows).toEqual([row('first', 1), row('second', 1)])
  })

  it('still rejects a deterministic failure first observed during a timing retry', async () => {
    const { evaluateBaseline, retryTimingFailures } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const baseline = {
      samples: Object.fromEntries(
        ['first', 'second'].map(sample => [
          sample,
          {
            optimized_ms: 1,
            unoptimized_ms: 1,
            optimized_bytes: 100,
            unoptimized_bytes: 100,
          },
        ]),
      ),
    }
    const rows: BenchmarkRow[] = [
      {
        sample: 'first',
        optimized_ms: 2,
        unoptimized_ms: 1,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
      {
        sample: 'second',
        optimized_ms: 1,
        unoptimized_ms: 1,
        optimized_bytes: 100,
        unoptimized_bytes: 100,
      },
    ]

    const result = retryTimingFailures({
      rows,
      comparison: evaluateBaseline(rows, baseline, budgets),
      measureSample: sample => ({
        sample,
        optimized_ms: 1,
        unoptimized_ms: 1,
        optimized_bytes: 120,
        unoptimized_bytes: 100,
      }),
      evaluate: (retriedRows, runtimeScale) =>
        evaluateBaseline(retriedRows, baseline, budgets, { runtimeScale }),
    })

    expect(result.comparison.status).toBe('failed')
    expect(result.comparison.failures).toEqual([expect.stringContaining('first: optimized_bytes')])
  })

  it('does not retry deterministic output-size failures', async () => {
    const { evaluateBaseline, retryTimingFailures } = await loadSamplingModule()
    const budgets = {
      timeRegressionRatio: 0.25,
      timeRegressionMinMs: 0.5,
      sizeRegressionRatio: 0.15,
      slowdownRatio: 0.35,
    }
    const baseline = {
      samples: {
        fixture: {
          optimized_ms: 1,
          unoptimized_ms: 1,
          optimized_bytes: 100,
          unoptimized_bytes: 100,
        },
      },
    }
    const rows: BenchmarkRow[] = [
      {
        sample: 'fixture',
        optimized_ms: 1,
        unoptimized_ms: 1,
        optimized_bytes: 120,
        unoptimized_bytes: 100,
      },
    ]
    const comparison = evaluateBaseline(rows, baseline, budgets)
    let measurements = 0

    const result = retryTimingFailures({
      rows,
      comparison,
      measureSample: () => {
        measurements++
        return rows[0]!
      },
      evaluate: (retriedRows, runtimeScale) =>
        evaluateBaseline(retriedRows, baseline, budgets, { runtimeScale }),
    })

    expect(measurements).toBe(0)
    expect(result.retriedSamples).toEqual([])
    expect(result.comparison.status).toBe('failed')
  })
})
