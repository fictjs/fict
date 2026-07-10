export function median(values) {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

export function runInterleavedMeasurements({ repeats, warmup, measure }) {
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Benchmark repeats must be a positive integer, received ${repeats}`)
  }

  warmup(true)
  warmup(false)

  const optimizedRuns = []
  const unoptimizedRuns = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    const modes = repeat % 2 === 0 ? [true, false] : [false, true]
    for (const optimize of modes) {
      const result = measure(optimize)
      if (optimize) optimizedRuns.push(result)
      else unoptimizedRuns.push(result)
    }
  }

  return {
    optimized: median(optimizedRuns),
    unoptimized: median(unoptimizedRuns),
    optimizedRuns,
    unoptimizedRuns,
  }
}

function deriveRuntimeScale(rows, baseline) {
  const factors = []
  for (const row of rows) {
    const expected = baseline?.samples?.[row.sample]
    if (!expected) continue
    if (
      typeof row.unoptimized_ms !== 'number' ||
      typeof expected.unoptimized_ms !== 'number' ||
      !Number.isFinite(row.unoptimized_ms) ||
      !Number.isFinite(expected.unoptimized_ms) ||
      row.unoptimized_ms <= 0 ||
      expected.unoptimized_ms <= 0
    ) {
      continue
    }
    factors.push(row.unoptimized_ms / expected.unoptimized_ms)
  }
  // Only relax limits on slower machines/runners; never tighten on faster ones.
  return Math.max(1, median(factors))
}

export function evaluateBaseline(rows, baseline, defaultBudgets, options = {}) {
  const budgets = { ...defaultBudgets, ...(baseline?.budgets ?? {}) }
  const failures = []
  const failureDetails = []
  const runtimeScale =
    typeof options.runtimeScale === 'number' &&
    Number.isFinite(options.runtimeScale) &&
    options.runtimeScale > 0
      ? options.runtimeScale
      : deriveRuntimeScale(rows, baseline)

  function addFailure(type, sample, message) {
    failures.push(message)
    failureDetails.push({ type, sample, message })
  }

  for (const row of rows) {
    const expected = baseline?.samples?.[row.sample]
    if (!expected) {
      addFailure('missing', row.sample, `Missing baseline for ${row.sample}`)
      continue
    }

    const scaledExpectedMs = expected.optimized_ms * runtimeScale
    const timeLimit = Math.max(
      scaledExpectedMs * (1 + budgets.timeRegressionRatio),
      scaledExpectedMs + budgets.timeRegressionMinMs,
    )
    if (row.optimized_ms > timeLimit) {
      addFailure(
        'time',
        row.sample,
        `${row.sample}: optimized_ms ${row.optimized_ms} > ${timeLimit.toFixed(2)}`,
      )
    }

    const sizeLimit = expected.optimized_bytes * (1 + budgets.sizeRegressionRatio)
    if (row.optimized_bytes > sizeLimit) {
      addFailure(
        'size',
        row.sample,
        `${row.sample}: optimized_bytes ${row.optimized_bytes} > ${Math.round(sizeLimit)}`,
      )
    }

    const slowdown = row.optimized_ms / row.unoptimized_ms
    const baselineSlowdown = expected.optimized_ms / expected.unoptimized_ms
    if (slowdown > baselineSlowdown + budgets.slowdownRatio) {
      addFailure(
        'slowdown',
        row.sample,
        `${row.sample}: slowdown ${slowdown.toFixed(2)} > ${(baselineSlowdown + budgets.slowdownRatio).toFixed(2)}`,
      )
    }
  }

  return {
    status: failures.length > 0 ? 'failed' : 'passed',
    runtimeScale,
    budgets,
    failures,
    failureDetails,
  }
}

export function retryTimingFailures({ rows, comparison, measureSample, evaluate }) {
  const failureDetails = comparison?.failureDetails ?? []
  if (
    comparison?.status !== 'failed' ||
    failureDetails.length === 0 ||
    failureDetails.some(detail => detail.type !== 'time' && detail.type !== 'slowdown')
  ) {
    return { rows, comparison, retriedSamples: [] }
  }

  const retriedSamples = [...new Set(failureDetails.map(detail => detail.sample))]
  const retriedSet = new Set(retriedSamples)
  const retriedRows = rows.map(row =>
    retriedSet.has(row.sample) ? measureSample(row.sample) : row,
  )
  // Keep one calibration for both attempts. Otherwise unrelated runner noise during the
  // retry could relax the limit and hide a persistent regression in the failed sample.
  const retryComparison = evaluate(retriedRows, comparison.runtimeScale)

  return {
    rows: retriedRows,
    comparison: {
      ...retryComparison,
      retry: {
        samples: retriedSamples,
        initialSamples: rows,
        initialRuntimeScale: comparison.runtimeScale,
        initialFailures: comparison.failures,
        initialFailureDetails: failureDetails,
        observedFailures: retryComparison.failures,
        observedFailureDetails: retryComparison.failureDetails ?? [],
      },
    },
    retriedSamples,
  }
}
