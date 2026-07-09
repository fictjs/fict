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

describe('playground HTTP security', () => {
  it('rejects JSON-shaped bodies sent with a cross-origin safelisted media type', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const response = await fetch(`${activeServer.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ templateId: 'counter' }),
    })

    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toEqual({
      error: 'Content-Type must be application/json',
    })
  })
})
