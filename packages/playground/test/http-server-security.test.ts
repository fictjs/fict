import { request } from 'node:http'

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
  it('rejects DNS-rebinding Host headers', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const response = await requestWithHost(`${activeServer.url}/api/health`, 'attacker.example')

    expect(response.status).toBe(403)
    expect(response.payload).toEqual({ error: 'Invalid Host header' })
  })

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

function requestWithHost(url: string, host: string): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(url, { headers: { Host: host } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        } catch (error) {
          reject(error)
        }
      })
    })
    clientRequest.once('error', reject)
    clientRequest.end()
  })
}
