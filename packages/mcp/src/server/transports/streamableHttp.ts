import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createFictMcpServer, type CreateFictMcpServerOptions } from '../createServer'
import {
  createResponseHelpers,
  normalizeHttpPath,
  normalizePositiveInt,
  resolveOldestSessionId,
  writeCorsHeaders,
} from './httpShared'

interface SessionContext {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

interface SessionEntry {
  context: SessionContext
  lastSeenAt: number
}

export interface StartStreamableHttpServerOptions extends CreateFictMcpServerOptions {
  host?: string
  port?: number
  path?: string
  healthPath?: string
  statsPath?: string
  enableCors?: boolean
  maxSessions?: number
  sessionTtlMs?: number
}

export interface StreamableHttpServerStats {
  startedAt: number
  uptimeMs: number
  requestsTotal: number
  requestsByMethod: {
    GET: number
    POST: number
    DELETE: number
    OPTIONS: number
    OTHER: number
  }
  responsesByStatus: Record<string, number>
  errorsTotal: number
  sessions: {
    active: number
    created: number
    reused: number
    deleted: number
    expired: number
    evicted: number
  }
  config: {
    endpointPath: string
    healthPath: string
    statsPath: string
    maxSessions: number
    sessionTtlMs: number
  }
}

export interface StartedStreamableHttpServer {
  host: string
  port: number
  path: string
  url: string
  healthUrl: string
  statsUrl: string
  getStats: () => StreamableHttpServerStats
  close: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8788
const DEFAULT_PATH = '/mcp'
const DEFAULT_HEALTH_PATH = '/healthz'
const DEFAULT_STATS_PATH = '/stats'
const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

function readSessionIdHeader(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0]
  return header
}

function buildServerOptions(
  options: StartStreamableHttpServerOptions,
): CreateFictMcpServerOptions | undefined {
  const base: CreateFictMcpServerOptions = {}

  if (options.docsRoot) base.docsRoot = options.docsRoot
  if (options.docsManifestPath) base.docsManifestPath = options.docsManifestPath
  if (options.playgroundOrigin) base.playgroundOrigin = options.playgroundOrigin
  if (options.serverName) base.serverName = options.serverName
  if (options.serverVersion) base.serverVersion = options.serverVersion

  return Object.keys(base).length > 0 ? base : undefined
}

async function closeSession(context: SessionContext): Promise<void> {
  await Promise.allSettled([context.server.close(), context.transport.close()])
}

export async function startStreamableHttpServer(
  options: StartStreamableHttpServerOptions = {},
): Promise<StartedStreamableHttpServer> {
  const startedAt = Date.now()
  const host = options.host ?? DEFAULT_HOST
  const configuredPort = options.port ?? DEFAULT_PORT
  const endpointPath = normalizeHttpPath(options.path ?? DEFAULT_PATH)
  const healthPath = normalizeHttpPath(options.healthPath ?? DEFAULT_HEALTH_PATH)
  const statsPath = normalizeHttpPath(options.statsPath ?? DEFAULT_STATS_PATH)
  const enableCors = options.enableCors ?? true
  const maxSessions = normalizePositiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS)
  const sessionTtlMs = normalizePositiveInt(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS)
  const baseServerOptions = buildServerOptions(options)

  const uniquePaths = new Set([endpointPath, healthPath, statsPath])
  if (uniquePaths.size < 3) {
    throw new Error(
      `HTTP paths must be distinct: path=${endpointPath}, healthPath=${healthPath}, statsPath=${statsPath}`,
    )
  }

  // Validate docs/options eagerly so invalid config fails at startup instead of first MCP request.
  const preflight = createFictMcpServer(baseServerOptions)
  void preflight.server.close()

  const sessions = new Map<string, SessionEntry>()
  const responsesByStatus = new Map<number, number>()
  const counters = {
    requestsTotal: 0,
    requestsByMethod: {
      GET: 0,
      POST: 0,
      DELETE: 0,
      OPTIONS: 0,
      OTHER: 0,
    },
    errorsTotal: 0,
    sessionsCreated: 0,
    sessionsReused: 0,
    sessionsDeleted: 0,
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
    if (method === 'DELETE') {
      counters.requestsByMethod.DELETE += 1
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

  const { respondJson, respondText } = createResponseHelpers(trackStatus)

  function getStats(): StreamableHttpServerStats {
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
        reused: counters.sessionsReused,
        deleted: counters.sessionsDeleted,
        expired: counters.sessionsExpired,
        evicted: counters.sessionsEvicted,
      },
      config: {
        endpointPath,
        healthPath,
        statsPath,
        maxSessions,
        sessionTtlMs,
      },
    }
  }

  async function removeSessionById(
    sessionId: string,
    reason: 'expired' | 'evicted' | 'deleted' | 'shutdown',
  ): Promise<void> {
    const entry = sessions.get(sessionId)
    if (!entry) return
    sessions.delete(sessionId)
    await closeSession(entry.context)

    if (reason === 'expired') counters.sessionsExpired += 1
    if (reason === 'evicted') counters.sessionsEvicted += 1
    if (reason === 'deleted') counters.sessionsDeleted += 1
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

  async function createSession(): Promise<SessionContext> {
    await ensureSessionCapacity()

    const { server } = createFictMcpServer(baseServerOptions)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    await server.connect(transport as Parameters<McpServer['connect']>[0])
    return { server, transport }
  }

  const httpServer = createHttpServer(async (req, res) => {
    const requestMethod = req.method ?? 'UNKNOWN'
    trackMethod(requestMethod)

    if (enableCors) {
      writeCorsHeaders(res, {
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        headers: [
          'content-type',
          'mcp-session-id',
          'mcp-protocol-version',
          'last-event-id',
          'authorization',
        ],
        exposeHeaders: ['mcp-session-id'],
      })
    }

    if (requestMethod === 'OPTIONS') {
      respondText(res, 204, '')
      return
    }

    await pruneExpiredSessions(Date.now())

    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${configuredPort}`}`,
    )

    if (requestUrl.pathname === healthPath) {
      if (requestMethod !== 'GET') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      respondJson(res, 200, {
        ok: true,
        service: 'fict-mcp',
        transport: 'streamable-http',
        now: new Date().toISOString(),
        stats: {
          uptimeMs: Date.now() - startedAt,
          activeSessions: sessions.size,
        },
      })
      return
    }

    if (requestUrl.pathname === statsPath) {
      if (requestMethod !== 'GET') {
        respondText(res, 405, 'Method Not Allowed')
        return
      }

      respondJson(res, 200, getStats())
      return
    }

    if (!['GET', 'POST', 'DELETE'].includes(requestMethod)) {
      res.setHeader('allow', 'GET,POST,DELETE,OPTIONS')
      respondText(res, 405, 'Method Not Allowed')
      return
    }

    if (requestUrl.pathname !== endpointPath) {
      respondText(res, 404, 'Not Found')
      return
    }

    const sessionId = readSessionIdHeader(req.headers['mcp-session-id'])

    let sessionEntry = sessionId ? sessions.get(sessionId) : undefined
    let createdThisRequest = false

    if (!sessionEntry) {
      if (sessionId) {
        respondText(res, 404, 'Unknown MCP session')
        return
      }

      if (requestMethod !== 'POST') {
        respondText(res, 400, 'Missing mcp-session-id header')
        return
      }

      const context = await createSession()
      sessionEntry = {
        context,
        lastSeenAt: Date.now(),
      }
      createdThisRequest = true
      counters.sessionsCreated += 1
    } else {
      counters.sessionsReused += 1
    }

    try {
      await sessionEntry.context.transport.handleRequest(req, res)
      sessionEntry.lastSeenAt = Date.now()
      trackStatus(res.statusCode || 200)
    } catch (error) {
      counters.errorsTotal += 1
      if (!res.headersSent) {
        respondText(res, 500, error instanceof Error ? error.message : String(error))
      } else {
        res.end()
        trackStatus(res.statusCode || 500)
      }

      if (createdThisRequest) {
        await closeSession(sessionEntry.context)
      }

      return
    }

    if (createdThisRequest) {
      const newSessionId = sessionEntry.context.transport.sessionId
      if (newSessionId) {
        sessions.set(newSessionId, sessionEntry)
      } else {
        await closeSession(sessionEntry.context)
      }
      return
    }

    if (requestMethod === 'DELETE' && sessionId) {
      await removeSessionById(sessionId, 'deleted')
    }
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
    path: endpointPath,
    url: `http://${host}:${resolvedPort}${endpointPath}`,
    healthUrl: `http://${host}:${resolvedPort}${healthPath}`,
    statsUrl: `http://${host}:${resolvedPort}${statsPath}`,
    getStats,
    close: async () => {
      for (const sessionId of sessions.keys()) {
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
