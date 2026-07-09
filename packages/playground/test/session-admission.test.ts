import { afterEach, describe, expect, it } from 'vitest'

import { createPlaygroundServer } from '../src/server/http-server'
import { PlaygroundSessionManager } from '../src/server/session-manager'
import type { StartedPlaygroundServer } from '../src/server/types'

let activeServer: StartedPlaygroundServer | null = null

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop()
    activeServer = null
  }
})

describe('playground session admission', () => {
  it('enforces tenant session quotas across concurrent requests', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          developer: { tenantId: 'tenant-a', userId: 'alice', role: 'developer' },
        },
      },
      quotas: {
        defaultTenant: {
          maxSessions: 1,
          maxRequestsPerMinute: 100,
        },
      },
    })

    const responses = await Promise.all([
      requestSession(activeServer.url, 'developer'),
      requestSession(activeServer.url, 'developer'),
    ])

    expect(responses.map(response => response.status).sort()).toEqual([201, 429])

    const usageResponse = await fetch(`${activeServer.url}/api/system/tenants/tenant-a/usage`, {
      headers: { Authorization: 'Bearer developer' },
    })
    const usage = (await usageResponse.json()) as {
      usage: { usage: { activeSessions: number } }
    }
    expect(usage.usage.usage.activeSessions).toBe(1)
  })

  it('serializes the manager global capacity check with session creation', async () => {
    const manager = new PlaygroundSessionManager({ maxSessions: 1 })

    try {
      await Promise.all([
        manager.createSession({ templateId: 'counter' }),
        manager.createSession({ templateId: 'counter' }),
      ])

      expect(manager.countSessionsForTenant('system')).toBe(1)
    } finally {
      await manager.disposeAll()
    }
  })
})

function requestSession(serverUrl: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ templateId: 'counter' }),
  })
}
