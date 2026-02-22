import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createFictMcpServer, type CreateFictMcpServerOptions } from '../createServer'

interface SessionContext {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

export interface StartStreamableHttpServerOptions extends CreateFictMcpServerOptions {
  host?: string
  port?: number
  path?: string
  enableCors?: boolean
}

export interface StartedStreamableHttpServer {
  host: string
  port: number
  path: string
  url: string
  close: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8788
const DEFAULT_PATH = '/mcp'

function normalizePath(rawPath: string): string {
  const withLeadingSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (withLeadingSlash === '/') return withLeadingSlash
  return withLeadingSlash.replace(/\/+$/, '')
}

function readSessionIdHeader(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0]
  return header
}

function writeCorsHeaders(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader(
    'access-control-allow-headers',
    'content-type,mcp-session-id,mcp-protocol-version,last-event-id,authorization',
  )
  res.setHeader('access-control-expose-headers', 'mcp-session-id')
}

function buildServerOptions(
  options: StartStreamableHttpServerOptions,
): CreateFictMcpServerOptions | undefined {
  const base: CreateFictMcpServerOptions = {}

  if (options.docsRoot) base.docsRoot = options.docsRoot
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
  const host = options.host ?? DEFAULT_HOST
  const configuredPort = options.port ?? DEFAULT_PORT
  const endpointPath = normalizePath(options.path ?? DEFAULT_PATH)
  const enableCors = options.enableCors ?? true
  const baseServerOptions = buildServerOptions(options)

  const sessions = new Map<string, SessionContext>()

  async function createSession(): Promise<SessionContext> {
    const { server } = createFictMcpServer(baseServerOptions)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    await server.connect(transport as Parameters<McpServer['connect']>[0])
    return { server, transport }
  }

  const httpServer = createHttpServer(async (req, res) => {
    if (enableCors) {
      writeCorsHeaders(res)
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const requestMethod = req.method ?? ''
    if (!['GET', 'POST', 'DELETE'].includes(requestMethod)) {
      res.statusCode = 405
      res.setHeader('allow', 'GET,POST,DELETE,OPTIONS')
      res.end('Method Not Allowed')
      return
    }

    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${configuredPort}`}`,
    )
    if (requestUrl.pathname !== endpointPath) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    const sessionId = readSessionIdHeader(req.headers['mcp-session-id'])

    let context = sessionId ? sessions.get(sessionId) : undefined
    let createdThisRequest = false

    if (!context) {
      if (sessionId) {
        res.statusCode = 404
        res.end('Unknown MCP session')
        return
      }

      if (requestMethod !== 'POST') {
        res.statusCode = 400
        res.end('Missing mcp-session-id header')
        return
      }

      context = await createSession()
      createdThisRequest = true
    }

    try {
      await context.transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      } else {
        res.end()
      }

      if (createdThisRequest) {
        await closeSession(context)
      }

      return
    }

    if (createdThisRequest) {
      const newSessionId = context.transport.sessionId
      if (newSessionId) {
        sessions.set(newSessionId, context)
      } else {
        await closeSession(context)
      }
      return
    }

    if (requestMethod === 'DELETE' && sessionId) {
      sessions.delete(sessionId)
      await closeSession(context)
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
    close: async () => {
      for (const context of sessions.values()) {
        await closeSession(context)
      }
      sessions.clear()

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
