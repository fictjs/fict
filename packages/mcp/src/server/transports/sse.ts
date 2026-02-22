import { createServer as createHttpServer } from 'node:http'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'

import { createFictMcpServer, type CreateFictMcpServerOptions } from '../createServer'

interface SessionContext {
  server: McpServer
  transport: SSEServerTransport
}

interface SessionEntry {
  context: SessionContext
  lastSeenAt: number
  closing: boolean
}

export interface StartSseHttpServerOptions extends CreateFictMcpServerOptions {
  host?: string
  port?: number
  ssePath?: string
  messagesPath?: string
  healthPath?: string
  statsPath?: string
  enableCors?: boolean
  maxSessions?: number
  sessionTtlMs?: number
}

export interface SseHttpServerStats {
  startedAt: number
  uptimeMs: number
  requestsTotal: number
  requestsByMethod: {
    GET: number
    POST: number
    OPTIONS: number
    OTHER: number
  }
  responsesByStatus: Record<string, number>
  errorsTotal: number
  sessions: {
    active: number
    created: number
    closed: number
    expired: number
    evicted: number
  }
  config: {
    ssePath: string
    messagesPath: string
    healthPath: string
    statsPath: string
    maxSessions: number
    sessionTtlMs: number
  }
}

export interface StartedSseHttpServer {
  host: string
  port: number
  ssePath: string
  messagesPath: string
  url: string
  messagesUrl: string
  healthUrl: string
  statsUrl: string
  getStats: () => SseHttpServerStats
  close: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8790
const DEFAULT_SSE_PATH = '/sse'
const DEFAULT_MESSAGES_PATH = '/messages'
const DEFAULT_HEALTH_PATH = '/healthz'
const DEFAULT_STATS_PATH = '/stats'
const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

function normalizePath(rawPath: string): string {
  const withLeadingSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (withLeadingSlash === '/') return withLeadingSlash
  return withLeadingSlash.replace(/\/+$/, '')
}

function writeCorsHeaders(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type,last-event-id,authorization')
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || typeof value !== 'number') return fallback
  const rounded = Math.floor(value)
  if (rounded <= 0) return fallback
  return rounded
}

function buildServerOptions(
  options: StartSseHttpServerOptions,
): CreateFictMcpServerOptions | undefined {
  const base: CreateFictMcpServerOptions = {}

  if (options.docsRoot) base.docsRoot = options.docsRoot
  if (options.docsManifestPath) base.docsManifestPath = options.docsManifestPath
  if (options.playgroundOrigin) base.playgroundOrigin = options.playgroundOrigin
  if (options.serverName) base.serverName = options.serverName
  if (options.serverVersion) base.serverVersion = options.serverVersion

  return Object.keys(base).length > 0 ? base : undefined
}

function resolveOldestSessionId(sessions: Map<string, SessionEntry>): string | undefined {
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

async function closeSession(context: SessionContext): Promise<void> {
  await Promise.allSettled([context.server.close(), context.transport.close()])
}

export async function startSseHttpServer(
  options: StartSseHttpServerOptions = {},
): Promise<StartedSseHttpServer> {
  const startedAt = Date.now()
  const host = options.host ?? DEFAULT_HOST
  const configuredPort = options.port ?? DEFAULT_PORT
  const ssePath = normalizePath(options.ssePath ?? DEFAULT_SSE_PATH)
  const messagesPath = normalizePath(options.messagesPath ?? DEFAULT_MESSAGES_PATH)
  const healthPath = normalizePath(options.healthPath ?? DEFAULT_HEALTH_PATH)
  const statsPath = normalizePath(options.statsPath ?? DEFAULT_STATS_PATH)
  const enableCors = options.enableCors ?? true
  const maxSessions = normalizePositiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS)
  const sessionTtlMs = normalizePositiveInt(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS)
  const baseServerOptions = buildServerOptions(options)

  const uniquePaths = new Set([ssePath, messagesPath, healthPath, statsPath])
  if (uniquePaths.size < 4) {
    throw new Error(
      `SSE HTTP paths must be distinct: ssePath=${ssePath}, messagesPath=${messagesPath}, healthPath=${healthPath}, statsPath=${statsPath}`,
    )
  }

  // Validate docs/options eagerly so invalid config fails at startup.
  const preflight = createFictMcpServer(baseServerOptions)
  void preflight.server.close()

  const sessions = new Map<string, SessionEntry>()
  const responsesByStatus = new Map<number, number>()
  const counters = {
    requestsTotal: 0,
    requestsByMethod: {
      GET: 0,
      POST: 0,
      OPTIONS: 0,
      OTHER: 0,
    },
    errorsTotal: 0,
    sessionsCreated: 0,
    sessionsClosed: 0,
    sessionsExpired: 0,
    sessionsEvicted: 0,
  }

  function trackMethod(method: string): void {
    counters.requestsTotal += 1
    if (method === 'GET') {
      counters.requestsByMethod.GET += 1
      return
    }
    if (method === 'POST') {
      counters.requestsByMethod.POST += 1
      return
    }
    if (method === 'OPTIONS') {
      counters.requestsByMethod.OPTIONS += 1
      return
    }
    counters.requestsByMethod.OTHER += 1
  }

  function trackStatus(statusCode: number): void {
    const prev = responsesByStatus.get(statusCode) ?? 0
    responsesByStatus.set(statusCode, prev + 1)
  }

  function getStats(): SseHttpServerStats {
    const responseMap: Record<string, number> = {}
    for (const [status, count] of responsesByStatus.entries()) {
      responseMap[String(status)] = count
    }

    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      requestsTotal: counters.requestsTotal,
      requestsByMethod: { ...counters.requestsByMethod },
      responsesByStatus: responseMap,
      errorsTotal: counters.errorsTotal,
      sessions: {
        active: sessions.size,
        created: counters.sessionsCreated,
        closed: counters.sessionsClosed,
        expired: counters.sessionsExpired,
        evicted: counters.sessionsEvicted,
      },
      config: {
        ssePath,
        messagesPath,
        healthPath,
        statsPath,
        maxSessions,
        sessionTtlMs,
      },
    }
  }

  function respondJson(
    res: {
      statusCode: number
      setHeader: (name: string, value: string) => void
      end: (chunk?: string) => void
    },
    statusCode: number,
    payload: unknown,
  ): void {
    const body = JSON.stringify(payload, null, 2)
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
    trackStatus(statusCode)
  }

  function respondText(
    res: {
      statusCode: number
      setHeader: (name: string, value: string) => void
      end: (chunk?: string) => void
    },
    statusCode: number,
    message: string,
  ): void {
    res.statusCode = statusCode
    if (statusCode !== 204) {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    res.end(message)
    trackStatus(statusCode)
  }

  async function removeSessionById(
    sessionId: string,
    reason: 'closed' | 'expired' | 'evicted' | 'shutdown',
  ): Promise<void> {
    const entry = sessions.get(sessionId)
    if (!entry || entry.closing) return
    entry.closing = true
    sessions.delete(sessionId)
    await closeSession(entry.context)

    if (reason === 'closed') counters.sessionsClosed += 1
    if (reason === 'expired') counters.sessionsExpired += 1
    if (reason === 'evicted') counters.sessionsEvicted += 1
  }

  async function pruneExpiredSessions(now: number): Promise<void> {
    if (sessionTtlMs <= 0) return

    const expiredIds: string[] = []
    for (const [sessionId, entry] of sessions) {
      if (now - entry.lastSeenAt > sessionTtlMs) {
        expiredIds.push(sessionId)
      }
    }

    for (const sessionId of expiredIds) {
      await removeSessionById(sessionId, 'expired')
    }
  }

  async function ensureSessionCapacity(): Promise<void> {
    while (sessions.size >= maxSessions) {
      const oldestSessionId = resolveOldestSessionId(sessions)
      if (!oldestSessionId) break
      await removeSessionById(oldestSessionId, 'evicted')
    }
  }

  const httpServer = createHttpServer(async (req, res) => {
    const method = req.method ?? 'UNKNOWN'
    trackMethod(method)

    if (enableCors) {
      writeCorsHeaders(res)
    }

    if (method === 'OPTIONS') {
      respondText(res, 204, '')
      return
    }

    await pruneExpiredSessions(Date.now())

    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${configuredPort}`}`,
    )

    if (requestUrl.pathname === healthPath) {
      if (method !== 'GET') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      respondJson(res, 200, {
        ok: true,
        service: 'fict-mcp',
        transport: 'sse-http',
        now: new Date().toISOString(),
        stats: {
          uptimeMs: Date.now() - startedAt,
          activeSessions: sessions.size,
        },
      })
      return
    }

    if (requestUrl.pathname === statsPath) {
      if (method !== 'GET') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      respondJson(res, 200, getStats())
      return
    }

    if (requestUrl.pathname === ssePath) {
      if (method !== 'GET') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      await ensureSessionCapacity()

      const { server } = createFictMcpServer(baseServerOptions)
      const transport = new SSEServerTransport(messagesPath, res)
      const sessionId = transport.sessionId
      sessions.set(sessionId, {
        context: { server, transport },
        lastSeenAt: Date.now(),
        closing: false,
      })
      counters.sessionsCreated += 1

      transport.onclose = () => {
        void removeSessionById(sessionId, 'closed')
      }

      try {
        await server.connect(transport as Parameters<McpServer['connect']>[0])
        trackStatus(res.statusCode || 200)
      } catch (error) {
        counters.errorsTotal += 1
        await removeSessionById(sessionId, 'closed')
        if (!res.headersSent) {
          respondText(res, 500, error instanceof Error ? error.message : String(error))
        }
      }
      return
    }

    if (requestUrl.pathname === messagesPath) {
      if (method !== 'POST') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      const sessionId = requestUrl.searchParams.get('sessionId')
      if (!sessionId) {
        respondText(res, 400, 'Missing sessionId query parameter')
        return
      }

      const entry = sessions.get(sessionId)
      if (!entry) {
        respondText(res, 404, 'Session not found')
        return
      }

      try {
        await entry.context.transport.handlePostMessage(req, res)
        entry.lastSeenAt = Date.now()
        trackStatus(res.statusCode || 200)
      } catch (error) {
        counters.errorsTotal += 1
        if (!res.headersSent) {
          respondText(res, 500, error instanceof Error ? error.message : String(error))
        } else {
          res.end()
          trackStatus(res.statusCode || 500)
        }
      }
      return
    }

    respondText(res, 404, 'Not Found')
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(configuredPort, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const address = httpServer.address()
  const resolvedPort = typeof address === 'object' && address ? address.port : configuredPort

  return {
    host,
    port: resolvedPort,
    ssePath,
    messagesPath,
    url: `http://${host}:${resolvedPort}${ssePath}`,
    messagesUrl: `http://${host}:${resolvedPort}${messagesPath}`,
    healthUrl: `http://${host}:${resolvedPort}${healthPath}`,
    statsUrl: `http://${host}:${resolvedPort}${statsPath}`,
    getStats,
    close: async () => {
      for (const sessionId of [...sessions.keys()]) {
        await removeSessionById(sessionId, 'shutdown')
      }

      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
