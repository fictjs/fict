export interface SessionEntryLike {
  lastSeenAt: number
}

export interface ResponseLike {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: (chunk?: string) => void
}

export function normalizeHttpPath(rawPath: string): string {
  const withLeadingSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (withLeadingSlash === '/') return withLeadingSlash
  return withLeadingSlash.replace(/\/+$/, '')
}

export function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || typeof value !== 'number') return fallback
  const rounded = Math.floor(value)
  if (rounded <= 0) return fallback
  return rounded
}

export function resolveOldestSessionId<T extends SessionEntryLike>(
  sessions: Map<string, T>,
): string | undefined {
  let oldestId: string | undefined
  let oldestSeen = Number.POSITIVE_INFINITY

  for (const [id, entry] of sessions) {
    if (entry.lastSeenAt < oldestSeen) {
      oldestSeen = entry.lastSeenAt
      oldestId = id
    }
  }

  return oldestId
}

export async function pruneExpiredSessions<T extends SessionEntryLike>(options: {
  sessions: Map<string, T>
  sessionTtlMs: number
  now: number
  removeSessionById: (sessionId: string) => Promise<void>
}): Promise<void> {
  if (options.sessionTtlMs <= 0) return

  const expiredIds: string[] = []
  for (const [sessionId, entry] of options.sessions) {
    if (options.now - entry.lastSeenAt > options.sessionTtlMs) {
      expiredIds.push(sessionId)
    }
  }

  for (const sessionId of expiredIds) {
    await options.removeSessionById(sessionId)
  }
}

export async function evictSessionsToCapacity<T extends SessionEntryLike>(options: {
  sessions: Map<string, T>
  maxSessions: number
  removeSessionById: (sessionId: string) => Promise<void>
}): Promise<void> {
  while (options.sessions.size >= options.maxSessions) {
    const oldestSessionId = resolveOldestSessionId(options.sessions)
    if (!oldestSessionId) break
    await options.removeSessionById(oldestSessionId)
  }
}

export function writeCorsHeaders(
  res: { setHeader: (name: string, value: string) => void },
  options: {
    methods: string[]
    headers: string[]
    exposeHeaders?: string[]
  },
): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', options.methods.join(','))
  res.setHeader('access-control-allow-headers', options.headers.join(','))
  if (options.exposeHeaders && options.exposeHeaders.length > 0) {
    res.setHeader('access-control-expose-headers', options.exposeHeaders.join(','))
  }
}

export function createResponseHelpers(trackStatus: (statusCode: number) => void): {
  respondJson: (res: ResponseLike, statusCode: number, payload: unknown) => void
  respondText: (res: ResponseLike, statusCode: number, message: string) => void
} {
  const respondJson = (res: ResponseLike, statusCode: number, payload: unknown): void => {
    const body = JSON.stringify(payload, null, 2)
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
    trackStatus(statusCode)
  }

  const respondText = (res: ResponseLike, statusCode: number, message: string): void => {
    res.statusCode = statusCode
    if (statusCode !== 204) {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    res.end(message)
    trackStatus(statusCode)
  }

  return {
    respondJson,
    respondText,
  }
}
