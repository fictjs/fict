import type { LiveTraceLineUpdate, TraceMarkerKind } from './types'

interface LiveTraceUpdatePayload {
  type: 'trace/update'
  file: string
  line: number
  kind?: TraceMarkerKind | undefined
  runCount?: number | undefined
  lastDuration?: number | undefined
  lastDurationMs?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export function normalizeLiveTracePayload(raw: unknown): LiveTraceUpdatePayload | null {
  if (!isRecord(raw)) return null
  if (raw.type !== 'trace/update') return null
  if (typeof raw.file !== 'string' || !raw.file) return null
  if (typeof raw.line !== 'number' || !Number.isFinite(raw.line)) return null

  const kind =
    raw.kind === 'once' || raw.kind === 'reactive' || raw.kind === 'effect' ? raw.kind : undefined
  const runCount =
    typeof raw.runCount === 'number' && Number.isFinite(raw.runCount) ? raw.runCount : undefined
  const explicitDuration =
    typeof raw.lastDurationMs === 'number' && Number.isFinite(raw.lastDurationMs)
      ? raw.lastDurationMs
      : undefined
  const legacyDuration =
    explicitDuration === undefined &&
    typeof raw.lastDuration === 'number' &&
    Number.isFinite(raw.lastDuration)
      ? raw.lastDuration
      : undefined

  return {
    type: 'trace/update',
    file: raw.file,
    line: Math.max(1, Math.floor(raw.line)),
    kind,
    runCount,
    lastDurationMs: explicitDuration ?? legacyDuration,
  }
}

export class LiveTraceStore {
  private readonly updatesByFile = new Map<string, Map<number, LiveTraceLineUpdate>>()

  getLineUpdates(file: string): Map<number, LiveTraceLineUpdate> {
    return this.updatesByFile.get(file) ?? new Map<number, LiveTraceLineUpdate>()
  }

  apply(payload: LiveTraceUpdatePayload): boolean {
    const existing = this.updatesByFile.get(payload.file) ?? new Map<number, LiveTraceLineUpdate>()
    const lineUpdate = existing.get(payload.line)

    if (lineUpdate) {
      lineUpdate.kind = payload.kind ?? lineUpdate.kind
      lineUpdate.runCount = payload.runCount ?? lineUpdate.runCount
      lineUpdate.lastDurationMs = payload.lastDurationMs ?? lineUpdate.lastDurationMs
    } else {
      existing.set(payload.line, {
        line: payload.line,
        kind: payload.kind,
        runCount: payload.runCount,
        lastDurationMs: payload.lastDurationMs,
      })
    }

    this.updatesByFile.set(payload.file, existing)
    return true
  }

  clearFile(file: string): void {
    this.updatesByFile.delete(file)
  }

  reset(): void {
    this.updatesByFile.clear()
  }
}
