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

async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
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
