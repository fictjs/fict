export type SourceMinimizerPredicate = (source: string) => boolean | Promise<boolean>

export interface SourceMinimizerOptions {
  source: string
  test: SourceMinimizerPredicate
  /**
   * Lines matching any preserve pattern are never removed.
   * Use this for imports, repro labels, or harness directives.
   */
  preserve?: RegExp[]
  /**
   * Guard against predicates that are expensive or unexpectedly unstable.
   * Defaults to 200 passes.
   */
  maxPasses?: number
}

export interface SourceMinimizerResult {
  source: string
  removedLines: number
  passes: number
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

/**
 * Greedy line-oriented regression minimizer.
 *
 * The predicate should return true when a candidate still reproduces the failure.
 * The minimizer first tries large chunks, then narrows to single-line removals.
 */
export async function minimizeSourceByLines({
  source,
  test,
  preserve = [],
  maxPasses = 200,
}: SourceMinimizerOptions): Promise<SourceMinimizerResult> {
  if (!(await test(source))) {
    throw new Error('Cannot minimize source because the original input does not reproduce.')
  }

  let lines = splitLines(source)
  const originalLineCount = lines.length
  let chunkSize = Math.max(1, Math.ceil(lines.length / 2))
  let passes = 0

  while (chunkSize >= 1 && passes < maxPasses) {
    passes += 1
    let removedInPass = false

    for (let start = 0; start < lines.length; ) {
      const end = Math.min(lines.length, start + chunkSize)
      if (start === end || rangeContainsPreservedLine(lines, start, end, preserve)) {
        start = Math.max(start + 1, end)
        continue
      }

      const candidateLines = removeRange(lines, start, end)
      const candidate = joinLines(candidateLines)
      if (await test(candidate)) {
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

  const removedLines = originalLineCount - lines.length
  return {
    source: joinLines(lines),
    removedLines,
    passes,
    changed: removedLines > 0,
  }
}
