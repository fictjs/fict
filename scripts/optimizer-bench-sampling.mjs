export function median(values) {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return sorted[mid - 1] + (sorted[mid] - sorted[mid - 1]) / 2
}

export function parseBenchmarkCount(name, rawValue, fallback, { allowZero = false } = {}) {
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    throw new Error(`${name} must not be empty`)
  }
  const value = rawValue === undefined ? fallback : Number(rawValue)
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) {
    const requirement = allowZero ? 'a non-negative integer' : 'a positive integer'
    throw new Error(`${name} must be ${requirement}, received ${String(rawValue ?? fallback)}`)
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertFiniteNumber(value, label, { minimum, safeInteger = false }) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    (safeInteger && !Number.isSafeInteger(value))
  ) {
    const kind = safeInteger ? 'safe integer' : 'number'
    throw new Error(`${label} must be a finite ${kind} >= ${minimum}, received ${String(value)}`)
  }
}

const BUDGET_FIELDS = [
  'timeRegressionRatio',
  'timeRegressionMinMs',
  'sizeRegressionRatio',
  'slowdownRatio',
]

export function resolveBenchmarkBudgets(baseline, defaultBudgets) {
  if (!isRecord(defaultBudgets)) {
    throw new Error('Default benchmark budgets must be an object')
  }
  if (baseline !== null && baseline !== undefined && !isRecord(baseline)) {
    throw new Error('Benchmark baseline must be an object')
  }
  if (baseline?.budgets !== undefined && !isRecord(baseline.budgets)) {
    throw new Error('Benchmark baseline budgets must be an object')
  }

  const budgets = { ...defaultBudgets, ...(baseline?.budgets ?? {}) }
  for (const field of BUDGET_FIELDS) {
    assertFiniteNumber(budgets[field], `Benchmark budget ${field}`, { minimum: 0 })
  }
  return budgets
}

export function validateBenchmarkRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Optimizer benchmark comparison requires at least one sample row')
  }

  for (const row of rows) {
    if (!isRecord(row) || typeof row.sample !== 'string' || row.sample.trim() === '') {
      throw new Error('Each optimizer benchmark row must have a non-empty sample name')
    }
    assertFiniteNumber(row.optimized_ms, `${row.sample} optimized_ms`, { minimum: Number.EPSILON })
    assertFiniteNumber(row.unoptimized_ms, `${row.sample} unoptimized_ms`, {
      minimum: Number.EPSILON,
    })
    assertFiniteNumber(row.optimized_bytes, `${row.sample} optimized_bytes`, {
      minimum: 1,
      safeInteger: true,
    })
    assertFiniteNumber(row.unoptimized_bytes, `${row.sample} unoptimized_bytes`, {
      minimum: 1,
      safeInteger: true,
    })
  }
}

function validateBenchmarkInputs(rows, baseline) {
  validateBenchmarkRows(rows)
  if (!isRecord(baseline) || !isRecord(baseline.samples)) {
    throw new Error('Optimizer benchmark baseline must contain a samples object')
  }

  for (const row of rows) {
    const expected = baseline.samples[row.sample]
    if (expected === undefined) continue
    if (!isRecord(expected)) {
      throw new Error(`Benchmark baseline sample ${row.sample} must be an object`)
    }
    assertFiniteNumber(expected.optimized_ms, `Baseline ${row.sample} optimized_ms`, {
      minimum: Number.EPSILON,
    })
    assertFiniteNumber(expected.unoptimized_ms, `Baseline ${row.sample} unoptimized_ms`, {
      minimum: Number.EPSILON,
    })
    assertFiniteNumber(expected.optimized_bytes, `Baseline ${row.sample} optimized_bytes`, {
      minimum: 1,
      safeInteger: true,
    })
    assertFiniteNumber(expected.unoptimized_bytes, `Baseline ${row.sample} unoptimized_bytes`, {
      minimum: 1,
      safeInteger: true,
    })
  }
}

export function runInterleavedMeasurements({ repeats, warmup, measure }) {
  if (!Number.isSafeInteger(repeats) || repeats <= 0) {
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
      assertFiniteNumber(result, optimize ? 'Optimized timing' : 'Unoptimized timing', {
        minimum: Number.EPSILON,
      })
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
    const factor = row.unoptimized_ms / expected.unoptimized_ms
    assertFiniteNumber(factor, `${row.sample} runtime scale factor`, {
      minimum: Number.EPSILON,
    })
    factors.push(factor)
  }
  // Only relax limits on slower machines/runners; never tighten on faster ones.
  const runtimeScale = Math.max(1, median(factors))
  assertFiniteNumber(runtimeScale, 'Derived benchmark runtime scale', {
    minimum: Number.EPSILON,
  })
  return runtimeScale
}

export function evaluateBaseline(rows, baseline, defaultBudgets, options = {}) {
  const budgets = resolveBenchmarkBudgets(baseline, defaultBudgets)
  validateBenchmarkInputs(rows, baseline)
  const failures = []
  const failureDetails = []
  const hasRuntimeScale = Object.prototype.hasOwnProperty.call(options ?? {}, 'runtimeScale')
  if (hasRuntimeScale) {
    assertFiniteNumber(options.runtimeScale, 'Benchmark runtime scale', {
      minimum: Number.EPSILON,
    })
  }
  const runtimeScale = hasRuntimeScale ? options.runtimeScale : deriveRuntimeScale(rows, baseline)

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
    assertFiniteNumber(scaledExpectedMs, `${row.sample} scaled expected time`, {
      minimum: Number.EPSILON,
    })
    const ratioTimeLimit = scaledExpectedMs * (1 + budgets.timeRegressionRatio)
    const absoluteTimeLimit = scaledExpectedMs + budgets.timeRegressionMinMs
    assertFiniteNumber(ratioTimeLimit, `${row.sample} ratio time limit`, {
      minimum: Number.EPSILON,
    })
    assertFiniteNumber(absoluteTimeLimit, `${row.sample} absolute time limit`, {
      minimum: Number.EPSILON,
    })
    const timeLimit = Math.max(ratioTimeLimit, absoluteTimeLimit)
    if (row.optimized_ms > timeLimit) {
      addFailure(
        'time',
        row.sample,
        `${row.sample}: optimized_ms ${row.optimized_ms} > ${timeLimit.toFixed(2)}`,
      )
    }

    const sizeLimit = expected.optimized_bytes * (1 + budgets.sizeRegressionRatio)
    assertFiniteNumber(sizeLimit, `${row.sample} output size limit`, {
      minimum: Number.EPSILON,
    })
    if (row.optimized_bytes > sizeLimit) {
      addFailure(
        'size',
        row.sample,
        `${row.sample}: optimized_bytes ${row.optimized_bytes} > ${Math.round(sizeLimit)}`,
      )
    }

    const slowdown = row.optimized_ms / row.unoptimized_ms
    const baselineSlowdown = expected.optimized_ms / expected.unoptimized_ms
    assertFiniteNumber(slowdown, `${row.sample} optimizer slowdown`, {
      minimum: Number.EPSILON,
    })
    assertFiniteNumber(baselineSlowdown, `${row.sample} baseline optimizer slowdown`, {
      minimum: Number.EPSILON,
    })
    const slowdownLimit = baselineSlowdown + budgets.slowdownRatio
    assertFiniteNumber(slowdownLimit, `${row.sample} optimizer slowdown limit`, {
      minimum: Number.EPSILON,
    })
    if (slowdown > slowdownLimit) {
      addFailure(
        'slowdown',
        row.sample,
        `${row.sample}: slowdown ${slowdown.toFixed(2)} > ${slowdownLimit.toFixed(2)}`,
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
