import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { ViteDevServer } from 'vite'
import { WebSocket, WebSocketServer } from 'ws'

export const LIVE_TRACE_EVENT = 'fict:trace-update'
export const LIVE_TRACE_ENDPOINT = '__fict-trace__'
export const DEFAULT_LIVE_TRACE_TOKEN_PATH = '.fict-cache/devtools-token'

interface LiveTraceUpdate {
  type: 'trace/update'
  file: string
  line: number
  kind?: 'once' | 'reactive' | 'effect' | undefined
  runCount?: number | undefined
  lastDurationMs?: number | undefined
}

interface LiveTraceBridgeOptions {
  tokenPath?: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function resolveEndpointPath(base: string): string {
  let pathname = base
  try {
    if (base.includes('://')) pathname = new URL(base).pathname
  } catch {
    pathname = '/'
  }

  const normalizedBase = `/${pathname}`.replace(/\/+/g, '/').replace(/\/+$/, '')
  return `${normalizedBase === '/' ? '' : normalizedBase}/${LIVE_TRACE_ENDPOINT}`
}

function readRequestPath(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    return null
  }
}

function getBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() || null
}

function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  )
}

function rejectUpgrade(socket: Duplex, status: 400 | 401): void {
  const label = status === 401 ? 'Unauthorized' : 'Bad Request'
  try {
    socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}

function writeTokenFile(tokenPath: string, token: string): void {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryPath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    rmSync(tokenPath, { force: true })
    renameSync(temporaryPath, tokenPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function removeOwnedTokenFile(tokenPath: string, token: string): void {
  try {
    if (readFileSync(tokenPath, 'utf8').trim() === token) {
      rmSync(tokenPath, { force: true })
    }
  } catch {
    // The token may already have been replaced or removed by another server.
  }
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function normalizeLiveTraceFile(file: string, root: string): string | null {
  let value = file.trim()
  if (!value || value.length > 8192) return null

  try {
    if (value.startsWith('file://')) {
      value = fileURLToPath(value)
    } else if (/^https?:\/\//i.test(value)) {
      value = new URL(value).pathname
    }
  } catch {
    return null
  }

  const suffixIndex = value.search(/[?#]/)
  if (suffixIndex >= 0) value = value.slice(0, suffixIndex)
  value = decodePath(value)
  if (value.startsWith('/@fs/')) value = value.slice('/@fs'.length)
  if (!value) return null

  const normalizedPath = normalize(isAbsolute(value) ? value : resolve(root, value))
  try {
    return realpathSync.native(normalizedPath)
  } catch {
    return normalizedPath
  }
}

function normalizeUpdate(raw: unknown, root: string): LiveTraceUpdate | null {
  if (!isRecord(raw) || raw.type !== 'trace/update') return null
  if (typeof raw.file !== 'string' || typeof raw.line !== 'number') return null
  if (!Number.isFinite(raw.line) || raw.line <= 0) return null

  const file = normalizeLiveTraceFile(raw.file, root)
  if (!file) return null

  const kind =
    raw.kind === 'once' || raw.kind === 'reactive' || raw.kind === 'effect' ? raw.kind : undefined
  const runCount =
    typeof raw.runCount === 'number' && Number.isFinite(raw.runCount) && raw.runCount >= 0
      ? raw.runCount
      : undefined
  const lastDurationMs =
    typeof raw.lastDurationMs === 'number' &&
    Number.isFinite(raw.lastDurationMs) &&
    raw.lastDurationMs >= 0
      ? raw.lastDurationMs
      : undefined

  return {
    type: 'trace/update',
    file,
    line: Math.floor(raw.line),
    kind,
    runCount,
    lastDurationMs,
  }
}

function updateSubscription(
  subscriptions: Set<string>,
  raw: unknown,
  root: string,
): { type: 'trace/subscribed' | 'trace/unsubscribed'; file: string } | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || typeof raw.file !== 'string') return null
  const file = normalizeLiveTraceFile(raw.file, root)
  if (!file) return null

  if (raw.type === 'trace/subscribe') {
    subscriptions.add(file)
    return { type: 'trace/subscribed', file }
  }
  if (raw.type === 'trace/unsubscribe') {
    subscriptions.delete(file)
    return { type: 'trace/unsubscribed', file }
  }
  return null
}

export function installLiveTraceBridge(
  server: ViteDevServer,
  options: LiveTraceBridgeOptions = {},
): (() => void) | undefined {
  const httpServer = server.httpServer
  if (!httpServer) {
    server.config.logger.warn(
      '[fict-devtools] Live trace is unavailable because the Vite HTTP server is disabled.',
    )
    return undefined
  }
  const activeHttpServer = httpServer

  const configuredTokenPath = options.tokenPath?.trim() || DEFAULT_LIVE_TRACE_TOKEN_PATH
  const tokenPath = isAbsolute(configuredTokenPath)
    ? configuredTokenPath
    : resolve(server.config.root, configuredTokenPath)
  const token = randomBytes(32).toString('hex')

  try {
    writeTokenFile(tokenPath, token)
  } catch (error) {
    server.config.logger.warn(
      `[fict-devtools] Failed to create the live trace token at ${tokenPath}: ${String(error)}`,
    )
    return undefined
  }

  const endpointPath = resolveEndpointPath(server.config.base)
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const subscriptions = new WeakMap<WebSocket, Set<string>>()
  let disposed = false

  webSocketServer.on('connection', socket => {
    const files = new Set<string>()
    subscriptions.set(socket, files)
    socket.on('message', message => {
      try {
        const acknowledgement = updateSubscription(
          files,
          JSON.parse(message.toString()),
          server.config.root,
        )
        if (acknowledgement && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(acknowledgement))
        }
      } catch {
        // Ignore malformed client messages while keeping the connection usable.
      }
    })
    socket.on('error', () => {
      // Individual client errors are isolated from the Vite server.
    })
    socket.send(JSON.stringify({ type: 'trace/ready' }))
  })

  webSocketServer.on('error', error => {
    server.config.logger.warn(`[fict-devtools] Live trace WebSocket error: ${error.message}`)
  })

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const requestPath = readRequestPath(request)
    if (requestPath !== endpointPath) return
    if (!tokensMatch(getBearerToken(request), token)) {
      rejectUpgrade(socket, 401)
      return
    }

    try {
      webSocketServer.handleUpgrade(request, socket, head, client => {
        webSocketServer.emit('connection', client, request)
      })
    } catch {
      rejectUpgrade(socket, 400)
    }
  }

  const publishUpdate = (raw: unknown): void => {
    const update = normalizeUpdate(raw, server.config.root)
    if (!update) return
    const message = JSON.stringify(update)

    for (const client of webSocketServer.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        subscriptions.get(client)?.has(update.file) === true
      ) {
        client.send(message)
      }
    }
  }

  activeHttpServer.on('upgrade', handleUpgrade)
  activeHttpServer.once('close', dispose)
  server.ws.on(LIVE_TRACE_EVENT, publishUpdate)
  server.config.logger.info(
    `  \x1b[32m➜\x1b[0m  \x1b[1mFict live trace:\x1b[0m ${endpointPath} (token: ${tokenPath})`,
  )

  function dispose(): void {
    if (disposed) return
    disposed = true
    server.ws.off(LIVE_TRACE_EVENT, publishUpdate)
    activeHttpServer.off('upgrade', handleUpgrade)
    activeHttpServer.off('close', dispose)
    for (const client of webSocketServer.clients) client.terminate()
    try {
      webSocketServer.close()
    } catch {
      // The no-server WebSocket may already have been closed by its HTTP owner.
    }
    removeOwnedTokenFile(tokenPath, token)
  }

  return dispose
}
