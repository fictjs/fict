import type { IncomingHttpHeaders } from 'node:http'

import type {
  PlaygroundAuthContext,
  PlaygroundAuthOptions,
  PlaygroundRole,
  PlaygroundTenantQuota,
  PlaygroundTenantQuotaOptions,
} from './types'

const roleRank: Record<PlaygroundRole, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
}

const defaultTenantQuota: PlaygroundTenantQuota = {
  maxSessions: 8,
  maxRequestsPerMinute: 240,
  maxVerificationsPerHour: 120,
}

export class AuthController {
  private readonly allowAnonymous: boolean
  private readonly anonymousContext: PlaygroundAuthContext
  private readonly tokenMap = new Map<string, PlaygroundAuthContext>()

  constructor(options: PlaygroundAuthOptions | undefined) {
    this.allowAnonymous = options?.allowAnonymous ?? true
    this.anonymousContext = {
      tenantId: options?.anonymousTenantId ?? 'public',
      userId: options?.anonymousUserId ?? 'anonymous',
      role: 'developer',
    }

    const entries = Object.entries(options?.tokens ?? {})
    for (const [token, principal] of entries) {
      const normalized = token.trim()
      if (!normalized) continue
      this.tokenMap.set(normalized, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        role: principal.role,
      })
    }
  }

  authenticate(headers: IncomingHttpHeaders): PlaygroundAuthContext {
    const token = extractBearerToken(headers.authorization)
    if (token) {
      const principal = this.tokenMap.get(token)
      if (!principal) {
        throw new ControlPlaneError(401, 'Invalid authorization token')
      }
      return principal
    }

    if (this.tokenMap.size > 0 && !this.allowAnonymous) {
      throw new ControlPlaneError(401, 'Authorization token is required')
    }

    return this.anonymousContext
  }
}

export class TenantQuotaController {
  private readonly defaultQuota: PlaygroundTenantQuota
  private readonly tenantOverrides: Record<string, Partial<PlaygroundTenantQuota>>
  private readonly requestWindows = new Map<string, number[]>()
  private readonly verificationWindows = new Map<string, number[]>()

  constructor(options: PlaygroundTenantQuotaOptions | undefined) {
    this.defaultQuota = {
      ...defaultTenantQuota,
      ...(options?.defaultTenant ?? {}),
    }
    this.tenantOverrides = options?.tenants ?? {}
  }

  registerRequest(tenantId: string, now: number = Date.now()): void {
    const quota = this.getTenantQuota(tenantId)
    const entries = this.compactWindow(this.requestWindows, tenantId, now, 60_000)
    if (entries.length >= quota.maxRequestsPerMinute) {
      throw new ControlPlaneError(429, 'Request rate limit exceeded for tenant')
    }
    entries.push(now)
  }

  registerVerification(tenantId: string, now: number = Date.now()): void {
    const quota = this.getTenantQuota(tenantId)
    const entries = this.compactWindow(this.verificationWindows, tenantId, now, 60 * 60_000)
    if (entries.length >= quota.maxVerificationsPerHour) {
      throw new ControlPlaneError(429, 'Verification quota exceeded for tenant')
    }
    entries.push(now)
  }

  assertSessionCapacity(tenantId: string, activeSessions: number): void {
    const quota = this.getTenantQuota(tenantId)
    if (activeSessions >= quota.maxSessions) {
      throw new ControlPlaneError(429, 'Active session quota exceeded for tenant')
    }
  }

  getTenantUsage(tenantId: string, activeSessions: number): PlaygroundTenantUsageSnapshot {
    const now = Date.now()
    const requests = this.compactWindow(this.requestWindows, tenantId, now, 60_000)
    const verifications = this.compactWindow(this.verificationWindows, tenantId, now, 60 * 60_000)
    const quota = this.getTenantQuota(tenantId)

    return {
      tenantId,
      quota,
      usage: {
        activeSessions,
        requestsInCurrentMinute: requests.length,
        verificationsInCurrentHour: verifications.length,
      },
      capturedAt: now,
    }
  }

  getTenantQuota(tenantId: string): PlaygroundTenantQuota {
    const override = this.tenantOverrides[tenantId]
    return {
      ...this.defaultQuota,
      ...(override ?? {}),
    }
  }

  private compactWindow(
    map: Map<string, number[]>,
    tenantId: string,
    now: number,
    windowMs: number,
  ): number[] {
    const cutoff = now - windowMs
    const existing = map.get(tenantId) ?? []
    const compacted = existing.filter(value => value >= cutoff)
    map.set(tenantId, compacted)
    return compacted
  }
}

export interface PlaygroundAuditEvent {
  id: string
  timestamp: number
  tenantId: string
  userId: string
  method: string
  route: string
  status: number
  durationMs: number
  message?: string
}

export class AuditLogController {
  private readonly maxEntries: number
  private readonly events: PlaygroundAuditEvent[] = []

  constructor(maxEntries = 2_000) {
    this.maxEntries = Math.max(100, maxEntries)
  }

  append(event: PlaygroundAuditEvent): void {
    this.events.push(event)
    if (this.events.length <= this.maxEntries) return
    this.events.splice(0, this.events.length - this.maxEntries)
  }

  list(input: { tenantId?: string; limit?: number } = {}): PlaygroundAuditEvent[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000)
    const filtered = input.tenantId
      ? this.events.filter(event => event.tenantId === input.tenantId)
      : this.events
    const sliceStart = Math.max(0, filtered.length - limit)
    return filtered.slice(sliceStart).reverse()
  }
}

interface RouteMetric {
  count: number
  errorCount: number
  totalDurationMs: number
}

export interface PlaygroundMetricsSnapshot {
  counters: {
    totalRequests: number
    errorRequests: number
  }
  activeRequests: number
  perRoute: Record<string, RouteMetric>
  capturedAt: number
}

export class MetricsController {
  private totalRequests = 0
  private errorRequests = 0
  private activeRequests = 0
  private readonly perRoute = new Map<string, RouteMetric>()

  beginRequest(): () => void {
    this.activeRequests += 1
    return () => {
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
  }

  recordRequest(input: {
    method: string
    route: string
    status: number
    durationMs: number
  }): void {
    this.totalRequests += 1
    if (input.status >= 400) {
      this.errorRequests += 1
    }

    const key = `${input.method.toUpperCase()} ${input.route}`
    const metric = this.perRoute.get(key) ?? {
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
    }

    metric.count += 1
    metric.totalDurationMs += input.durationMs
    if (input.status >= 400) {
      metric.errorCount += 1
    }
    this.perRoute.set(key, metric)
  }

  snapshot(): PlaygroundMetricsSnapshot {
    const perRoute: Record<string, RouteMetric> = {}
    for (const [key, metric] of this.perRoute.entries()) {
      perRoute[key] = metric
    }

    return {
      counters: {
        totalRequests: this.totalRequests,
        errorRequests: this.errorRequests,
      },
      activeRequests: this.activeRequests,
      perRoute,
      capturedAt: Date.now(),
    }
  }
}

export interface PlaygroundTenantUsageSnapshot {
  tenantId: string
  quota: PlaygroundTenantQuota
  usage: {
    activeSessions: number
    requestsInCurrentMinute: number
    verificationsInCurrentHour: number
  }
  capturedAt: number
}

export class ControlPlaneError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
  }
}

export function assertRole(actor: PlaygroundAuthContext, required: PlaygroundRole): void {
  if (roleRank[actor.role] >= roleRank[required]) return
  throw new ControlPlaneError(403, `Role ${actor.role} cannot perform this operation`)
}

export function assertTenantAccess(actor: PlaygroundAuthContext, tenantId: string): void {
  if (actor.tenantId === tenantId || actor.role === 'admin') return
  throw new ControlPlaneError(403, `Tenant access denied for ${tenantId}`)
}

function extractBearerToken(authorization: string | string[] | undefined): string {
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const prefix = 'bearer '
  if (!trimmed.toLowerCase().startsWith(prefix)) return ''
  return trimmed.slice(prefix.length).trim()
}
