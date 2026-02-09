import { existsSync, promises as fs } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PlaygroundSessionManager } from './session-manager'
import { decodeSessionSnapshot, encodeSessionSnapshot } from './share'
import type { PlaygroundConfig, PlaygroundServerOptions, StartedPlaygroundServer } from './types'

interface ServerRuntime {
  host: string
  port: number
  origin: string
}

export async function createPlaygroundServer(
  options: PlaygroundServerOptions = {},
): Promise<StartedPlaygroundServer> {
  const host = options.host ?? '127.0.0.1'
  const managerOptions = {
    previewHost: host === '0.0.0.0' ? '127.0.0.1' : host,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  }
  const manager = new PlaygroundSessionManager(managerOptions)

  const assetsRoot = resolveAssetsRoot()
  const runtime: ServerRuntime = {
    host,
    port: options.port ?? 4173,
    origin: '',
  }

  const server = createHttpServer(async (request, response) => {
    await handleRequest({ request, response, manager, assetsRoot, runtime })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(runtime.port, runtime.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine playground server address')
  }

  runtime.port = address.port
  runtime.origin = createOrigin(runtime.host, runtime.port)

  const stop = async (): Promise<void> => {
    await manager.disposeAll()
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  return {
    host: runtime.host,
    port: runtime.port,
    url: runtime.origin,
    stop,
  }
}

interface RequestContext {
  request: IncomingMessage
  response: ServerResponse
  manager: PlaygroundSessionManager
  assetsRoot: string
  runtime: ServerRuntime
}

async function handleRequest(context: RequestContext): Promise<void> {
  const method = context.request.method ?? 'GET'
  const requestUrl = new URL(
    context.request.url ?? '/',
    context.runtime.origin || 'http://127.0.0.1',
  )
  const pathname = requestUrl.pathname

  try {
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(context.response, 200, { ok: true })
      return
    }

    if (method === 'GET' && pathname === '/api/templates') {
      sendJson(context.response, 200, { templates: context.manager.templates })
      return
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      const body = await readJsonBody(context.request)
      const sessionInput = {
        ...(typeof body.templateId === 'string' ? { templateId: body.templateId } : {}),
        ...(isRecord(body.config) ? { config: toConfigPatch(body.config) } : {}),
        ...(isRecord(body.files) ? { files: toStringMap(body.files) } : {}),
      }
      const session = await context.manager.createSession(sessionInput)
      sendJson(context.response, 201, { session })
      return
    }

    if (method === 'POST' && pathname === '/api/import') {
      const body = await readJsonBody(context.request)
      if (typeof body.token !== 'string') {
        sendJson(context.response, 400, { error: 'token is required' })
        return
      }
      const snapshot = decodeSessionSnapshot(body.token)
      const session = await context.manager.importSnapshot(snapshot)
      sendJson(context.response, 201, { session })
      return
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      if (!sessionId) {
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      if (method === 'GET') {
        const session = await context.manager.getSessionState(sessionId)
        sendJson(context.response, 200, { session })
        return
      }
      if (method === 'DELETE') {
        await context.manager.disposeSession(sessionId)
        sendJson(context.response, 200, { ok: true })
        return
      }
    }

    const filesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/files$/)
    if (filesMatch) {
      const sessionId = filesMatch[1]
      if (!sessionId) {
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(context.request)
        if (typeof body.path !== 'string' || typeof body.content !== 'string') {
          sendJson(context.response, 400, { error: 'path and content are required' })
          return
        }
        const session = await context.manager.updateFile(sessionId, body.path, body.content)
        sendJson(context.response, 200, { session })
        return
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(context.request)
        if (typeof body.path !== 'string') {
          sendJson(context.response, 400, { error: 'path is required' })
          return
        }
        const session = await context.manager.deleteFile(sessionId, body.path)
        sendJson(context.response, 200, { session })
        return
      }
    }

    const diagnosticsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostics$/)
    if (diagnosticsMatch && method === 'POST') {
      const sessionId = diagnosticsMatch[1]
      if (!sessionId) {
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const diagnostics = await context.manager.runDiagnostics(sessionId)
      sendJson(context.response, 200, diagnostics)
      return
    }

    const configMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/config$/)
    if (configMatch && method === 'POST') {
      const sessionId = configMatch[1]
      if (!sessionId) {
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const body = await readJsonBody(context.request)
      const session = await context.manager.updateSessionConfig(
        sessionId,
        isRecord(body.config) ? toConfigPatch(body.config) : {},
      )
      sendJson(context.response, 200, { session })
      return
    }

    const shareMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/share$/)
    if (shareMatch && method === 'POST') {
      const sessionId = shareMatch[1]
      if (!sessionId) {
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const snapshot = await context.manager.snapshot(sessionId)
      const token = encodeSessionSnapshot(snapshot)
      const url = `${context.runtime.origin}/?share=${encodeURIComponent(token)}`
      sendJson(context.response, 200, { token, url })
      return
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'index.html'),
        'text/html',
      )
      return
    }

    if (method === 'GET' && pathname === '/styles.css') {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'styles.css'),
        'text/css',
      )
      return
    }

    if (method === 'GET' && pathname === '/app.js') {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'app.js'),
        'text/javascript',
      )
      return
    }

    sendJson(context.response, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown playground server error'
    sendJson(context.response, 500, { error: message })
  }
}

function resolveAssetsRoot(): string {
  const candidates = [
    fileURLToPath(new URL('../web', import.meta.url)),
    fileURLToPath(new URL('./web', import.meta.url)),
    fileURLToPath(new URL('../../src/web', import.meta.url)),
    path.resolve(process.cwd(), 'packages/playground/src/web'),
  ]

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) {
      return candidate
    }
  }

  throw new Error('Unable to locate playground web assets')
}

async function sendStaticAsset(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const content = await fs.readFile(filePath)
  response.writeHead(200, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Cache-Control': 'no-store',
  })
  response.end(content)
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  const body = Buffer.concat(chunks).toString('utf8')
  if (!body.trim()) {
    return {}
  }

  return JSON.parse(body) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toStringMap(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

function toConfigPatch(record: Record<string, unknown>): Partial<PlaygroundConfig> {
  const patch: Partial<PlaygroundConfig> = {}

  if (
    record.profile === 'app-default' ||
    record.profile === 'ci-hard-gate' ||
    record.profile === 'migration'
  ) {
    patch.profile = record.profile
  }

  const booleanKeys: (keyof Omit<PlaygroundConfig, 'profile'>)[] = [
    'strictGuarantee',
    'strictReactivity',
    'lazyConditional',
    'resumable',
    'functionSplitting',
    'devtools',
  ]

  for (const key of booleanKeys) {
    if (typeof record[key] === 'boolean') {
      patch[key] = record[key]
    }
  }

  return patch
}

function createOrigin(host: string, port: number): string {
  const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host
  return `http://${publicHost}:${port}`
}
