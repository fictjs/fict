export type SourceMinimizerBackend = 'rust' | 'legacy'

export interface SourceMinimizerPredicateContext {
  /** Explicit compiler implementation selected for this reduction run. */
  backend: SourceMinimizerBackend
}

export type SourceMinimizerPredicate = (
  source: string,
  context: SourceMinimizerPredicateContext,
) => boolean | Promise<boolean>

export interface SourceMinimizerOptions {
  source: string
  test: SourceMinimizerPredicate
  /**
   * Compiler implementation the predicate must exercise. Defaults to legacy for compatibility;
   * differential tooling should run the same input once per backend.
   */
  backend?: SourceMinimizerBackend
  /**
   * Lines matching any preserve pattern are never removed.
   * Use this for imports, repro labels, or harness directives.
   */
  preserve?: RegExp[]
  /**
   * Guard against predicates that are expensive or unexpectedly unstable.
   * Counts every predicate evaluation, including the initial reproduction check.
   * Use 0 to return the original source without invoking the predicate.
   * Defaults to 200 evaluations.
   */
  maxPasses?: number
}

export interface SourceMinimizerResult {
  source: string
  removedLines: number
  /** Predicate evaluations consumed. Kept as passes for API compatibility. */
  passes: number
  predicateCalls: number
  chunkPasses: number
  changed: boolean
}

function splitLines(source: string): string[] {
  return source.length === 0 ? [] : source.split(/\r?\n/)
}

function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}

function matchesPreservePattern(pattern: RegExp, line: string): boolean {
  const lastIndex = pattern.lastIndex
  pattern.lastIndex = 0
  const matches = pattern.test(line)
  pattern.lastIndex = lastIndex
  return matches
}

function rangeContainsPreservedLine(
  lines: readonly string[],
  start: number,
  end: number,
  preserve: readonly RegExp[],
): boolean {
  if (preserve.length === 0) return false
  for (let index = start; index < end; index += 1) {
    const line = lines[index]
    if (line !== undefined && preserve.some(pattern => matchesPreservePattern(pattern, line))) {
      return true
    }
  }
  return false
}

function removeRange(lines: readonly string[], start: number, end: number): string[] {
  return [...lines.slice(0, start), ...lines.slice(end)]
}

function normalizePredicateBudget(maxPasses: number): number {
  if (!Number.isFinite(maxPasses)) {
    return maxPasses === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 0
  }
  return Math.max(0, Math.floor(maxPasses))
}

/**
 * Greedy line-oriented regression minimizer.
 *
 * The predicate should return true when a candidate still reproduces the failure.
 * The minimizer first tries large chunks, then narrows to single-line removals.
 */
export async function minimizeSourceByLines({
  source,
  test,
  backend = 'legacy',
  preserve = [],
  maxPasses = 200,
}: SourceMinimizerOptions): Promise<SourceMinimizerResult> {
  let lines = splitLines(source)
  const originalLineCount = lines.length
  const maxPredicateCalls = normalizePredicateBudget(maxPasses)
  let predicateCalls = 0
  let chunkPasses = 0

  const finish = (): SourceMinimizerResult => {
    const removedLines = originalLineCount - lines.length
    return {
      source: joinLines(lines),
      removedLines,
      passes: predicateCalls,
      predicateCalls,
      chunkPasses,
      changed: removedLines > 0,
    }
  }

  const runPredicate = async (candidate: string): Promise<boolean | undefined> => {
    if (predicateCalls >= maxPredicateCalls) {
      return undefined
    }
    predicateCalls += 1
    return await test(candidate, { backend })
  }

  const originalReproduces = await runPredicate(source)
  if (originalReproduces === undefined) {
    return finish()
  }
  if (!originalReproduces) {
    throw new Error('Cannot minimize source because the original input does not reproduce.')
  }

  let chunkSize = Math.max(1, Math.ceil(lines.length / 2))

  while (chunkSize >= 1 && predicateCalls < maxPredicateCalls) {
    chunkPasses += 1
    let removedInPass = false

    for (let start = 0; start < lines.length; ) {
      if (predicateCalls >= maxPredicateCalls) {
        break
      }

      const end = Math.min(lines.length, start + chunkSize)
      if (start === end || rangeContainsPreservedLine(lines, start, end, preserve)) {
        start = Math.max(start + 1, end)
        continue
      }

      const candidateLines = removeRange(lines, start, end)
      const candidate = joinLines(candidateLines)
      const reproduces = await runPredicate(candidate)
      if (reproduces === undefined) {
        break
      }
      if (reproduces) {
        lines = candidateLines
        removedInPass = true
        continue
      }

      start = end
    }

    if (!removedInPass) {
      chunkSize = Math.floor(chunkSize / 2)
    }
  }

  return finish()
}
