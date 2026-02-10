import { existsSync, promises as fs } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertRole,
  assertTenantAccess,
  AuditLogController,
  AuthController,
  ControlPlaneError,
  MetricsController,
  TenantQuotaController,
} from './control-plane'
import { PlaygroundSessionManager } from './session-manager'
import { decodeSessionSnapshot, encodeSessionSnapshot } from './share'
import type {
  PlaygroundAuthContext,
  PlaygroundConfig,
  PlaygroundServerOptions,
  StartedPlaygroundServer,
} from './types'

interface ServerRuntime {
  host: string
  port: number
  origin: string
  maxRequestBodyBytes: number
}

interface ServerControllers {
  auth: AuthController
  quota: TenantQuotaController
  audit: AuditLogController
  metrics: MetricsController
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024

export async function createPlaygroundServer(
  options: PlaygroundServerOptions = {},
): Promise<StartedPlaygroundServer> {
  const host = options.host ?? '127.0.0.1'
  const managerOptions = {
    previewHost: host === '0.0.0.0' ? '127.0.0.1' : host,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    ...(options.limits?.maxConcurrentVerifications !== undefined
      ? { maxConcurrentVerifications: options.limits.maxConcurrentVerifications }
      : {}),
    ...(options.limits?.verifyTimeoutMs !== undefined
      ? { verifyTimeoutMs: options.limits.verifyTimeoutMs }
      : {}),
  }
  const manager = new PlaygroundSessionManager(managerOptions)
  const controllers: ServerControllers = {
    auth: new AuthController(options.auth),
    quota: new TenantQuotaController(options.quotas),
    audit: new AuditLogController(options.limits?.auditLogEntries),
    metrics: new MetricsController(),
  }

  const assetsRoot = resolveAssetsRoot()
  const rawMaxRequestBodyBytes = options.limits?.maxRequestBodyBytes
  const maxRequestBodyBytes =
    typeof rawMaxRequestBodyBytes === 'number' &&
    Number.isFinite(rawMaxRequestBodyBytes) &&
    rawMaxRequestBodyBytes > 0
      ? Math.floor(rawMaxRequestBodyBytes)
      : DEFAULT_MAX_REQUEST_BODY_BYTES
  const runtime: ServerRuntime = {
    host,
    port: options.port ?? 4173,
    origin: '',
    maxRequestBodyBytes,
  }

  const server = createHttpServer(async (request, response) => {
    await handleRequest({ request, response, manager, assetsRoot, runtime, controllers })
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
  controllers: ServerControllers
}

class RequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

async function handleRequest(context: RequestContext): Promise<void> {
  const method = context.request.method ?? 'GET'
  const requestUrl = new URL(
    context.request.url ?? '/',
    context.runtime.origin || 'http://127.0.0.1',
  )
  const pathname = requestUrl.pathname
  const routeTemplate = toRouteTemplate(pathname)
  const finishRequest = context.controllers.metrics.beginRequest()
  const startedAt = Date.now()
  let status = 500
  let actor: PlaygroundAuthContext | null = null
  let errorMessage: string | undefined

  try {
    if (isApiPath(pathname) && pathname !== '/api/health') {
      actor = context.controllers.auth.authenticate(context.request.headers)
      context.controllers.quota.registerRequest(actor.tenantId)
    }

    if (method === 'GET' && pathname === '/api/health') {
      status = 200
      sendJson(context.response, 200, { ok: true })
      return
    }

    if (method === 'GET' && pathname === '/api/system/me') {
      const principal = requireActor(actor)
      status = 200
      sendJson(context.response, 200, { actor: principal })
      return
    }

    if (method === 'GET' && pathname === '/api/system/metrics') {
      const principal = requireActor(actor)
      assertRole(principal, 'admin')
      status = 200
      sendJson(context.response, 200, {
        metrics: context.controllers.metrics.snapshot(),
      })
      return
    }

    if (method === 'GET' && pathname === '/api/system/audit') {
      const principal = requireActor(actor)
      assertRole(principal, 'admin')
      const limit = toPositiveInteger(requestUrl.searchParams.get('limit'), 100)
      const tenantId = requestUrl.searchParams.get('tenantId') ?? undefined
      const auditQuery = tenantId ? { limit, tenantId } : { limit }
      status = 200
      sendJson(context.response, 200, {
        events: context.controllers.audit.list(auditQuery),
      })
      return
    }

    const tenantUsageMatch = pathname.match(/^\/api\/system\/tenants\/([^/]+)\/usage$/)
    if (tenantUsageMatch && method === 'GET') {
      const principal = requireActor(actor)
      const tenantId = tenantUsageMatch[1]
      if (!tenantId) {
        throw new RequestError(400, 'tenant id is required')
      }
      assertTenantAccess(principal, tenantId)
      if (principal.tenantId === tenantId) {
        assertRole(principal, 'developer')
      } else {
        assertRole(principal, 'admin')
      }
      status = 200
      sendJson(context.response, 200, {
        usage: context.controllers.quota.getTenantUsage(
          tenantId,
          context.manager.countSessionsForTenant(tenantId),
        ),
      })
      return
    }

    if (method === 'GET' && pathname === '/api/templates') {
      assertRole(requireActor(actor), 'viewer')
      status = 200
      sendJson(context.response, 200, { templates: context.manager.templates })
      return
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      context.controllers.quota.assertSessionCapacity(
        principal.tenantId,
        context.manager.countSessionsForTenant(principal.tenantId),
      )

      const body = await readJsonBody(context.request, context.runtime.maxRequestBodyBytes)
      const sessionInput = {
        ...(typeof body.templateId === 'string' ? { templateId: body.templateId } : {}),
        ...(isRecord(body.config) ? { config: toConfigPatch(body.config) } : {}),
        ...(isRecord(body.files) ? { files: toStringMap(body.files) } : {}),
      }
      const session = await context.manager.createSession(sessionInput, principal)
      status = 201
      sendJson(context.response, 201, { session })
      return
    }

    if (method === 'POST' && pathname === '/api/import') {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      context.controllers.quota.assertSessionCapacity(
        principal.tenantId,
        context.manager.countSessionsForTenant(principal.tenantId),
      )

      const body = await readJsonBody(context.request, context.runtime.maxRequestBodyBytes)
      if (typeof body.token !== 'string') {
        status = 400
        sendJson(context.response, 400, { error: 'token is required' })
        return
      }
      const snapshot = decodeSessionSnapshot(body.token)
      const session = await context.manager.importSnapshot(snapshot, principal)
      status = 201
      sendJson(context.response, 201, { session })
      return
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const principal = requireActor(actor)
      const sessionId = sessionMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      if (method === 'GET') {
        assertRole(principal, 'viewer')
        const session = await context.manager.getSessionState(sessionId, principal)
        status = 200
        sendJson(context.response, 200, { session })
        return
      }
      if (method === 'DELETE') {
        assertRole(principal, 'developer')
        await context.manager.disposeSession(sessionId, principal)
        status = 200
        sendJson(context.response, 200, { ok: true })
        return
      }
    }

    const filesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/files$/)
    if (filesMatch) {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      const sessionId = filesMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(context.request, context.runtime.maxRequestBodyBytes)
        if (typeof body.path !== 'string' || typeof body.content !== 'string') {
          status = 400
          sendJson(context.response, 400, { error: 'path and content are required' })
          return
        }
        const session = await context.manager.updateFile(
          sessionId,
          body.path,
          body.content,
          principal,
        )
        status = 200
        sendJson(context.response, 200, { session })
        return
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(context.request, context.runtime.maxRequestBodyBytes)
        if (typeof body.path !== 'string') {
          status = 400
          sendJson(context.response, 400, { error: 'path is required' })
          return
        }
        const session = await context.manager.deleteFile(sessionId, body.path, principal)
        status = 200
        sendJson(context.response, 200, { session })
        return
      }
    }

    const diagnosticsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostics$/)
    if (diagnosticsMatch && method === 'POST') {
      const principal = requireActor(actor)
      assertRole(principal, 'viewer')
      const sessionId = diagnosticsMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const diagnostics = await context.manager.runDiagnostics(sessionId, principal)
      status = 200
      sendJson(context.response, 200, diagnostics)
      return
    }

    const verifyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/verify$/)
    if (verifyMatch && method === 'POST') {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      const sessionId = verifyMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      context.controllers.quota.registerVerification(principal.tenantId)
      const verification = await context.manager.runVerification(sessionId, principal)
      status = 200
      sendJson(context.response, 200, verification)
      return
    }

    const configMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/config$/)
    if (configMatch && method === 'POST') {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      const sessionId = configMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const body = await readJsonBody(context.request, context.runtime.maxRequestBodyBytes)
      const session = await context.manager.updateSessionConfig(
        sessionId,
        isRecord(body.config) ? toConfigPatch(body.config) : {},
        principal,
      )
      status = 200
      sendJson(context.response, 200, { session })
      return
    }

    const shareMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/share$/)
    if (shareMatch && method === 'POST') {
      const principal = requireActor(actor)
      assertRole(principal, 'developer')
      const sessionId = shareMatch[1]
      if (!sessionId) {
        status = 400
        sendJson(context.response, 400, { error: 'session id is required' })
        return
      }
      const snapshot = await context.manager.snapshot(sessionId, principal)
      const token = encodeSessionSnapshot(snapshot)
      const url = `${context.runtime.origin}/?share=${encodeURIComponent(token)}`
      status = 200
      sendJson(context.response, 200, { token, url })
      return
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'index.html'),
        'text/html',
      )
      status = 200
      return
    }

    if (method === 'GET' && pathname === '/styles.css') {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'styles.css'),
        'text/css',
      )
      status = 200
      return
    }

    if (method === 'GET' && pathname === '/app.js') {
      await sendStaticAsset(
        context.response,
        path.join(context.assetsRoot, 'app.js'),
        'text/javascript',
      )
      status = 200
      return
    }

    status = 404
    sendJson(context.response, 404, { error: 'Not found' })
  } catch (error) {
    const mapped = mapRequestError(error)
    status = mapped.status
    errorMessage = mapped.message
    sendJson(context.response, mapped.status, { error: mapped.message })
  } finally {
    const durationMs = Date.now() - startedAt
    finishRequest()

    if (isApiPath(pathname)) {
      context.controllers.metrics.recordRequest({
        method,
        route: routeTemplate,
        status,
        durationMs,
      })

      const auditActor = actor ?? inferFallbackActor(context.request.headers)
      context.controllers.audit.append({
        id: createAuditEventId(),
        timestamp: Date.now(),
        tenantId: auditActor.tenantId,
        userId: auditActor.userId,
        method: method.toUpperCase(),
        route: routeTemplate,
        status,
        durationMs,
        ...(errorMessage ? { message: errorMessage } : {}),
      })
    }
  }
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

function toRouteTemplate(pathname: string): string {
  if (/^\/api\/sessions\/[^/]+\/files$/.test(pathname)) {
    return '/api/sessions/:id/files'
  }
  if (/^\/api\/sessions\/[^/]+\/diagnostics$/.test(pathname)) {
    return '/api/sessions/:id/diagnostics'
  }
  if (/^\/api\/sessions\/[^/]+\/verify$/.test(pathname)) {
    return '/api/sessions/:id/verify'
  }
  if (/^\/api\/sessions\/[^/]+\/config$/.test(pathname)) {
    return '/api/sessions/:id/config'
  }
  if (/^\/api\/sessions\/[^/]+\/share$/.test(pathname)) {
    return '/api/sessions/:id/share'
  }
  if (/^\/api\/sessions\/[^/]+$/.test(pathname)) {
    return '/api/sessions/:id'
  }
  if (/^\/api\/system\/tenants\/[^/]+\/usage$/.test(pathname)) {
    return '/api/system/tenants/:id/usage'
  }
  return pathname
}

function requireActor(actor: PlaygroundAuthContext | null): PlaygroundAuthContext {
  if (!actor) {
    throw new RequestError(401, 'Authorization token is required')
  }
  return actor
}

function inferFallbackActor(headers: IncomingHttpHeaders): PlaygroundAuthContext {
  const authorization = headers.authorization
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  const hasAuthHeader = typeof value === 'string' && value.trim().length > 0
  if (hasAuthHeader) {
    return {
      tenantId: 'unknown',
      userId: 'unknown',
      role: 'viewer',
    }
  }

  return {
    tenantId: 'public',
    userId: 'anonymous',
    role: 'viewer',
  }
}

function createAuditEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function toPositiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RequestError(400, 'Expected a positive integer')
  }
  return parsed
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

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentLengthHeader = request.headers['content-length']
  const contentLengthValue = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader
  const declaredBytes = contentLengthValue ? Number.parseInt(contentLengthValue, 10) : NaN
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new RequestError(413, 'Request payload too large')
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.length
    if (totalBytes > maxBytes) {
      throw new RequestError(413, 'Request payload too large')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  const body = Buffer.concat(chunks).toString('utf8')
  if (!body.trim()) {
    return {}
  }

  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new RequestError(400, 'Invalid JSON payload')
  }
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

function mapRequestError(error: unknown): { status: number; message: string } {
  if (error instanceof ControlPlaneError) {
    return { status: error.status, message: error.message }
  }

  if (error instanceof RequestError) {
    return { status: error.status, message: error.message }
  }

  if (!(error instanceof Error)) {
    return { status: 500, message: 'Unknown playground server error' }
  }

  if (error.message.startsWith('Unknown playground session:')) {
    return { status: 404, message: error.message }
  }

  if (error.message.startsWith('Session access denied for tenant:')) {
    return { status: 403, message: error.message }
  }

  if (error.message.startsWith('Verification timed out after')) {
    return { status: 504, message: error.message }
  }

  if (isClientErrorMessage(error.message)) {
    return { status: 400, message: error.message }
  }

  return { status: 500, message: error.message }
}

function isClientErrorMessage(message: string): boolean {
  return (
    message.startsWith('Unknown playground template:') ||
    message === 'File path cannot be empty' ||
    message === 'Path traversal is not allowed' ||
    message === 'File path escapes session root' ||
    message === 'Invalid snapshot payload' ||
    message === 'Unsupported share payload version' ||
    message === 'Unsupported snapshot schema version' ||
    message === 'Share payload exceeds safe size limits'
  )
}
