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

describe('playground preview isolation', () => {
  it('does not serve files from a sibling tenant session', async () => {
    activeServer = await createPlaygroundServer({
      port: 0,
      auth: {
        allowAnonymous: false,
        tokens: {
          tenant_a: { tenantId: 'tenant-a', userId: 'alice', role: 'developer' },
          tenant_b: { tenantId: 'tenant-b', userId: 'bob', role: 'developer' },
        },
      },
    })

    const first = await createSession(activeServer.url, 'tenant_a', {
      'src/tenant-a.ts': `export const owner = 'tenant-a'`,
    })
    const second = await createSession(activeServer.url, 'tenant_b', {
      'src/private.ts': `export const secret = 'tenant-b-private'`,
    })

    const privateFile = `${String(second.rootDir).replace(/\\/g, '/')}/src/private.ts`
    const response = await fetch(new URL(`/@fs${privateFile}`, String(first.previewUrl)))

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('tenant-b-private')
  })
})

async function createSession(
  serverUrl: string,
  token: string,
  files: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${serverUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ templateId: 'counter', files }),
  })
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { session: Record<string, unknown> }
  return payload.session
}
