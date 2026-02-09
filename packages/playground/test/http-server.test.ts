import { afterEach, describe, expect, it } from 'vitest'

import { createPlaygroundServer } from '../src/server/http-server'
import type { StartedPlaygroundServer } from '../src/server/types'

let activeServer: StartedPlaygroundServer | null = null

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop()
    activeServer = null
  }
})

describe('playground HTTP server', () => {
  it('enforces bearer auth when anonymous access is disabled', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          dev_a: {
            tenantId: 'tenant-a',
            userId: 'alice',
            role: 'developer',
          },
        },
      },
    })

    const noAuth = await fetch(`${activeServer.url}/api/templates`)
    expect(noAuth.status).toBe(401)

    const withAuth = await fetch(`${activeServer.url}/api/templates`, {
      headers: authHeaders('dev_a'),
    })
    expect(withAuth.status).toBe(200)
    const payload = (await withAuth.json()) as Record<string, unknown>
    expect(Array.isArray(payload.templates)).toBe(true)
  })

  it('isolates sessions between tenants', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          dev_a: {
            tenantId: 'tenant-a',
            userId: 'alice',
            role: 'developer',
          },
          dev_b: {
            tenantId: 'tenant-b',
            userId: 'bob',
            role: 'developer',
          },
        },
      },
    })

    const create = await postJson(
      `${activeServer.url}/api/sessions`,
      {
        templateId: 'counter',
      },
      'dev_a',
    )
    const sessionId = create.session?.id as string | undefined
    expect(sessionId).toBeTruthy()

    const forbidden = await fetch(`${activeServer.url}/api/sessions/${sessionId}`, {
      headers: authHeaders('dev_b'),
    })
    expect(forbidden.status).toBe(403)

    const allowed = await fetch(`${activeServer.url}/api/sessions/${sessionId}`, {
      headers: authHeaders('dev_a'),
    })
    expect(allowed.status).toBe(200)
  })

  it('enforces verification quota per tenant', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          dev_a: {
            tenantId: 'tenant-a',
            userId: 'alice',
            role: 'developer',
          },
        },
      },
      quotas: {
        defaultTenant: {
          maxSessions: 5,
          maxRequestsPerMinute: 500,
          maxVerificationsPerHour: 1,
        },
      },
    })

    const create = await postJson(
      `${activeServer.url}/api/sessions`,
      {
        templateId: 'counter',
      },
      'dev_a',
    )
    const sessionId = create.session?.id as string | undefined
    expect(sessionId).toBeTruthy()

    const first = await postJson(
      `${activeServer.url}/api/sessions/${sessionId}/verify`,
      {},
      'dev_a',
    )
    expect(first.summary?.passed).toBe(true)

    const second = await fetch(`${activeServer.url}/api/sessions/${sessionId}/verify`, {
      method: 'POST',
      headers: {
        ...authHeaders('dev_a'),
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(second.status).toBe(429)
  }, 90_000)

  it('exposes audit and metrics endpoints to admins only', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          admin_ops: {
            tenantId: 'ops',
            userId: 'root',
            role: 'admin',
          },
          dev_a: {
            tenantId: 'tenant-a',
            userId: 'alice',
            role: 'developer',
          },
        },
      },
    })

    await postJson(
      `${activeServer.url}/api/sessions`,
      {
        templateId: 'counter',
      },
      'dev_a',
    )

    const denied = await fetch(`${activeServer.url}/api/system/metrics`, {
      headers: authHeaders('dev_a'),
    })
    expect(denied.status).toBe(403)

    const metrics = await getJson(`${activeServer.url}/api/system/metrics`, 'admin_ops')
    expect(metrics.metrics?.counters?.totalRequests).toBeGreaterThan(0)

    const audit = await getJson(`${activeServer.url}/api/system/audit?limit=10`, 'admin_ops')
    expect(Array.isArray(audit.events)).toBe(true)
    expect(audit.events.length).toBeGreaterThan(0)
  })

  it('returns tenant usage snapshots with role gating', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          admin_ops: {
            tenantId: 'ops',
            userId: 'root',
            role: 'admin',
          },
          dev_a: {
            tenantId: 'tenant-a',
            userId: 'alice',
            role: 'developer',
          },
          dev_b: {
            tenantId: 'tenant-b',
            userId: 'bob',
            role: 'developer',
          },
        },
      },
      quotas: {
        defaultTenant: {
          maxSessions: 3,
        },
      },
    })

    await postJson(
      `${activeServer.url}/api/sessions`,
      {
        templateId: 'counter',
      },
      'dev_a',
    )

    const ownUsage = await getJson(`${activeServer.url}/api/system/tenants/tenant-a/usage`, 'dev_a')
    expect(ownUsage.usage?.usage?.activeSessions).toBe(1)

    const crossTenantDenied = await fetch(`${activeServer.url}/api/system/tenants/tenant-b/usage`, {
      headers: authHeaders('dev_a'),
    })
    expect(crossTenantDenied.status).toBe(403)

    const adminCrossTenant = await getJson(
      `${activeServer.url}/api/system/tenants/tenant-b/usage`,
      'admin_ops',
    )
    expect(adminCrossTenant.usage?.tenantId).toBe('tenant-b')
  })

  it('returns 400 for invalid JSON payload', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const response = await fetch(`${activeServer.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{"templateId":',
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.error).toBe('Invalid JSON payload')
  })

  it('returns 404 for unknown session id', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const response = await fetch(`${activeServer.url}/api/sessions/unknown-session/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    expect(response.status).toBe(404)
    const payload = (await response.json()) as Record<string, unknown>
    expect(String(payload.error)).toContain('Unknown playground session')
  })

  it('runs full verification for a session', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const create = await postJson(`${activeServer.url}/api/sessions`, {
      templateId: 'counter',
    })
    const sessionId = create.session?.id as string | undefined
    expect(sessionId).toBeTruthy()

    const verification = await postJson(`${activeServer.url}/api/sessions/${sessionId}/verify`, {})

    expect(verification.summary?.passed).toBe(true)
    expect(verification.summary?.totalErrorCount).toBe(0)
    expect(verification.build?.success).toBe(true)
    expect(Array.isArray(verification.build?.outputFiles)).toBe(true)
    expect(verification.build.outputFiles.length).toBeGreaterThan(0)
  }, 90_000)

  it('reports failed verification for invalid source', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const create = await postJson(`${activeServer.url}/api/sessions`, {
      templateId: 'counter',
    })
    const sessionId = create.session?.id as string | undefined
    expect(sessionId).toBeTruthy()

    await postJson(`${activeServer.url}/api/sessions/${sessionId}/files`, {
      path: 'src/App.tsx',
      content:
        'export function App() {\n  const label: string = 123\n  return <div>{label}</div>\n}\n',
    })

    const verification = await postJson(`${activeServer.url}/api/sessions/${sessionId}/verify`, {})

    expect(verification.summary?.passed).toBe(false)
    expect(verification.summary?.totalErrorCount).toBeGreaterThan(0)
    expect(verification.summary?.diagnosticsErrorCount).toBeGreaterThan(0)
    expect(verification.build?.success).toBe(true)
  }, 90_000)
})

async function postJson(
  url: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? authHeaders(token) : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const payload = (await response.json()) as Record<string, any>
  if (!response.ok) {
    const message = payload?.error ?? `${response.status} ${response.statusText}`
    throw new Error(`Request failed: ${message}`)
  }
  return payload
}

async function getJson(url: string, token?: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: token ? authHeaders(token) : {},
  })

  const payload = (await response.json()) as Record<string, any>
  if (!response.ok) {
    const message = payload?.error ?? `${response.status} ${response.statusText}`
    throw new Error(`Request failed: ${message}`)
  }
  return payload
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  }
}
