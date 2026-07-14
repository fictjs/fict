export type FixtureDiagnosticSeverity = 'error' | 'warning' | 'info'

export interface FixtureDiagnostic {
  code: string
  message: string
  severity: FixtureDiagnosticSeverity
  fileName?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

export interface CompileFixture<TOptions = Readonly<Record<string, unknown>>> {
  name: string
  source: string
  filename: string
  options?: TOptions
}

export interface CompilerBackendResult {
  code: string
  diagnostics?: readonly FixtureDiagnostic[]
  sourceMap?: unknown
  metadata?: unknown
  artifacts?: Readonly<Record<string, unknown>>
}

export interface CompilerBackend<TOptions = Readonly<Record<string, unknown>>> {
  name: string
  compile(
    fixture: Readonly<CompileFixture<TOptions>>,
  ): CompilerBackendResult | Promise<CompilerBackendResult>
}

export type NormalizedValue =
  | null
  | boolean
  | number
  | string
  | NormalizedValue[]
  | { [key: string]: NormalizedValue }

export interface NormalizedBackendResult {
  status: 'success'
  code: string
  diagnostics: FixtureDiagnostic[]
  sourceMap?: NormalizedValue
  metadata?: NormalizedValue
  artifacts?: NormalizedValue
}

export interface NormalizedBackendFailure {
  status: 'failure'
  error: {
    name: string
    message: string
    code?: string
    fileName?: string
    line?: number
    column?: number
  }
}

export type NormalizedBackendOutcome = NormalizedBackendResult | NormalizedBackendFailure

export interface BackendOutcome {
  backend: string
  outcome: NormalizedBackendOutcome
}

export type BackendDifferenceField =
  | 'status'
  | 'code'
  | 'diagnostics'
  | 'sourceMap'
  | 'metadata'
  | 'artifacts'
  | 'error'

export interface BackendDifference {
  field: BackendDifferenceField
  baseline: NormalizedValue
  candidate: NormalizedValue
}

export interface BackendComparison {
  baseline: string
  candidate: string
  equivalent: boolean
  differences: BackendDifference[]
}

export interface CompileFixtureReport<TOptions = Readonly<Record<string, unknown>>> {
  fixture: Readonly<CompileFixture<TOptions>>
  outcomes: BackendOutcome[]
  comparisons: BackendComparison[]
}

const UNDEFINED_VALUE: NormalizedValue = { $type: 'undefined' }

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function stableValueKey(value: NormalizedValue): string {
  return JSON.stringify(value)
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Converts backend-owned values into a deterministic, JSON-safe representation.
 * Functions, symbols, non-finite numbers, and cyclic structures fail closed so a
 * differential test cannot accidentally ignore data it does not understand.
 */
export function normalizeComparableValue(value: unknown): NormalizedValue {
  const ancestors = new Set<object>()

  function visit(input: unknown): NormalizedValue {
    if (input === null) return null
    if (input === undefined) return UNDEFINED_VALUE
    if (typeof input === 'string') return normalizeLineEndings(input)
    if (typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new TypeError('Differential values must contain only finite numbers')
      }
      return Object.is(input, -0) ? 0 : input
    }
    if (typeof input === 'bigint') return { $bigint: input.toString() }
    if (typeof input === 'function' || typeof input === 'symbol') {
      throw new TypeError(`Differential values cannot contain ${typeof input} values`)
    }

    if (ancestors.has(input)) {
      throw new TypeError('Differential values cannot contain cycles')
    }
    ancestors.add(input)

    try {
      if (Array.isArray(input)) return input.map(visit)

      if (input instanceof Date) {
        if (Number.isNaN(input.getTime())) {
          throw new TypeError('Differential values cannot contain invalid dates')
        }
        return { $date: input.toISOString() }
      }

      if (input instanceof Map) {
        const entries = [...input.entries()]
          .map(([key, entryValue]) => [visit(key), visit(entryValue)] as const)
          .sort(([left], [right]) =>
            compareStableStrings(stableValueKey(left), stableValueKey(right)),
          )
        return { $map: entries.map(([key, entryValue]) => [key, entryValue]) }
      }

      if (input instanceof Set) {
        const entries = [...input]
          .map(visit)
          .sort((left, right) => compareStableStrings(stableValueKey(left), stableValueKey(right)))
        return { $set: entries }
      }

      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) {
        const constructorName =
          prototype?.constructor?.name && typeof prototype.constructor.name === 'string'
            ? prototype.constructor.name
            : 'unknown'
        throw new TypeError(`Differential values cannot contain ${constructorName} class instances`)
      }

      const normalized: Record<string, NormalizedValue> = {}
      for (const key of Object.keys(input).sort()) {
        normalized[key] = visit((input as Record<string, unknown>)[key])
      }
      return normalized
    } finally {
      ancestors.delete(input)
    }
  }

  return visit(value)
}

function compareDiagnostics(left: FixtureDiagnostic, right: FixtureDiagnostic): number {
  const leftKey = [
    left.fileName ?? '',
    left.line ?? -1,
    left.column ?? -1,
    left.endLine ?? -1,
    left.endColumn ?? -1,
    left.severity,
    left.code,
    left.message,
  ]
  const rightKey = [
    right.fileName ?? '',
    right.line ?? -1,
    right.column ?? -1,
    right.endLine ?? -1,
    right.endColumn ?? -1,
    right.severity,
    right.code,
    right.message,
  ]
  return compareStableStrings(JSON.stringify(leftKey), JSON.stringify(rightKey))
}

function normalizeDiagnostic(diagnostic: FixtureDiagnostic): FixtureDiagnostic {
  return {
    code: diagnostic.code,
    message: normalizeLineEndings(diagnostic.message),
    severity: diagnostic.severity,
    ...(diagnostic.fileName === undefined
      ? {}
      : { fileName: normalizeLineEndings(diagnostic.fileName) }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    ...(diagnostic.endLine === undefined ? {} : { endLine: diagnostic.endLine }),
    ...(diagnostic.endColumn === undefined ? {} : { endColumn: diagnostic.endColumn }),
  }
}

function normalizeResult(result: CompilerBackendResult): NormalizedBackendResult {
  if (typeof result.code !== 'string') {
    throw new TypeError('Compiler backend results must contain string code')
  }
  if (result.diagnostics !== undefined && !Array.isArray(result.diagnostics)) {
    throw new TypeError('Compiler backend diagnostics must be an array')
  }

  return {
    status: 'success',
    code: normalizeLineEndings(result.code),
    diagnostics: [...(result.diagnostics ?? [])].map(normalizeDiagnostic).sort(compareDiagnostics),
    ...(result.sourceMap === undefined
      ? {}
      : { sourceMap: normalizeComparableValue(result.sourceMap) }),
    ...(result.metadata === undefined
      ? {}
      : { metadata: normalizeComparableValue(result.metadata) }),
    ...(result.artifacts === undefined
      ? {}
      : { artifacts: normalizeComparableValue(result.artifacts) }),
  }
}

function readErrorProperty(error: object, property: string): unknown {
  return (error as Record<string, unknown>)[property]
}

function readErrorLocation(error: object): { line?: number; column?: number } {
  const location = readErrorProperty(error, 'loc')
  if (typeof location !== 'object' || location === null) return {}
  const line = readErrorProperty(location, 'line')
  const column = readErrorProperty(location, 'column')
  return {
    ...(typeof line === 'number' ? { line } : {}),
    ...(typeof column === 'number' ? { column } : {}),
  }
}

function normalizeFailure(error: unknown): NormalizedBackendFailure {
  if (typeof error !== 'object' || error === null) {
    return {
      status: 'failure',
      error: {
        name: 'NonErrorThrown',
        message: normalizeLineEndings(String(error)),
      },
    }
  }

  const name = readErrorProperty(error, 'name')
  const message = readErrorProperty(error, 'message')
  const code = readErrorProperty(error, 'code')
  const fileName = readErrorProperty(error, 'filename') ?? readErrorProperty(error, 'fileName')

  return {
    status: 'failure',
    error: {
      name: typeof name === 'string' ? name : 'Error',
      message: normalizeLineEndings(typeof message === 'string' ? message : String(error)),
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof fileName === 'string' ? { fileName: normalizeLineEndings(fileName) } : {}),
      ...readErrorLocation(error),
    },
  }
}

function valuesEqual(left: NormalizedValue, right: NormalizedValue): boolean {
  return stableValueKey(left) === stableValueKey(right)
}

function outcomeField(
  outcome: NormalizedBackendOutcome,
  field: Exclude<BackendDifferenceField, 'status'>,
): NormalizedValue {
  if (outcome.status === 'failure') {
    return field === 'error' ? normalizeComparableValue(outcome.error) : UNDEFINED_VALUE
  }

  if (field === 'error') return UNDEFINED_VALUE
  const value = outcome[field]
  return value === undefined ? UNDEFINED_VALUE : normalizeComparableValue(value)
}

export function compareBackendOutcomes(
  baseline: BackendOutcome,
  candidate: BackendOutcome,
): BackendComparison {
  const differences: BackendDifference[] = []

  if (baseline.outcome.status !== candidate.outcome.status) {
    differences.push({
      field: 'status',
      baseline: baseline.outcome.status,
      candidate: candidate.outcome.status,
    })
  }

  const fields: Exclude<BackendDifferenceField, 'status'>[] =
    baseline.outcome.status === 'failure' || candidate.outcome.status === 'failure'
      ? ['error']
      : ['code', 'diagnostics', 'sourceMap', 'metadata', 'artifacts']

  for (const field of fields) {
    const baselineValue = outcomeField(baseline.outcome, field)
    const candidateValue = outcomeField(candidate.outcome, field)
    if (!valuesEqual(baselineValue, candidateValue)) {
      differences.push({ field, baseline: baselineValue, candidate: candidateValue })
    }
  }

  return {
    baseline: baseline.backend,
    candidate: candidate.backend,
    equivalent: differences.length === 0,
    differences,
  }
}

function validateBackends<TOptions>(backends: readonly CompilerBackend<TOptions>[]): void {
  if (backends.length === 0) {
    throw new TypeError('compileFixture requires at least one compiler backend')
  }

  const names = new Set<string>()
  for (const backend of backends) {
    if (!backend.name.trim()) {
      throw new TypeError('Compiler backend names must not be empty')
    }
    if (names.has(backend.name)) {
      throw new TypeError(`Duplicate compiler backend name: ${backend.name}`)
    }
    names.add(backend.name)
  }
}

/**
 * Runs every requested backend and compares each candidate with the first backend.
 * A backend exception is captured as an explicit failure outcome; it is never skipped.
 */
export async function compileFixture<TOptions>(
  fixture: Readonly<CompileFixture<TOptions>>,
  backends: readonly CompilerBackend<TOptions>[],
): Promise<CompileFixtureReport<TOptions>> {
  validateBackends(backends)

  const outcomes = await Promise.all(
    backends.map(async backend => {
      try {
        return {
          backend: backend.name,
          outcome: normalizeResult(await backend.compile(fixture)),
        } satisfies BackendOutcome
      } catch (error) {
        return {
          backend: backend.name,
          outcome: normalizeFailure(error),
        } satisfies BackendOutcome
      }
    }),
  )

  const baseline = outcomes[0]
  if (!baseline) {
    throw new TypeError('compileFixture requires at least one compiler backend')
  }

  return {
    fixture,
    outcomes,
    comparisons: outcomes.slice(1).map(candidate => compareBackendOutcomes(baseline, candidate)),
  }
}
