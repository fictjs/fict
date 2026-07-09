import { access } from 'node:fs/promises'
import { request, type ClientRequest } from 'node:http'

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

describe('playground server lifecycle', () => {
  it('waits for active requests before disposing sessions they create', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })
    const pendingCreate = beginPartialSessionCreate(activeServer.url)
    await pendingCreate.connected
    await new Promise(resolve => setTimeout(resolve, 20))

    const stopPromise = activeServer.stop()
    pendingCreate.request.end('"counter"}')

    const session = await pendingCreate.response
    await stopPromise
    activeServer = null

    await expect(access(String(session.rootDir))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('makes repeated stop calls share one shutdown', async () => {
    activeServer = await createPlaygroundServer({ port: 0 })

    const firstStop = activeServer.stop()
    const secondStop = activeServer.stop()

    expect(secondStop).toBe(firstStop)
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined])
    activeServer = null
  })
})

function beginPartialSessionCreate(serverUrl: string): {
  request: ClientRequest
  connected: Promise<void>
  response: Promise<Record<string, unknown>>
} {
  let resolveConnected!: () => void
  let pendingRequest!: ClientRequest
  const connected = new Promise<void>(resolve => {
    resolveConnected = resolve
  })
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const clientRequest = request(
      `${serverUrl}/api/sessions`,
      {
        method: 'POST',
        headers: {
          Connection: 'close',
          'Content-Type': 'application/json',
        },
      },
      incoming => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
        incoming.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              session: Record<string, unknown>
            }
            resolve(payload.session)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    clientRequest.once('error', reject)
    clientRequest.once('socket', socket => {
      if (socket.connecting) {
        socket.once('connect', resolveConnected)
      } else {
        resolveConnected()
      }
    })
    clientRequest.write('{"templateId":')
    clientRequest.flushHeaders()
    pendingRequest = clientRequest
  })

  return {
    get request() {
      return pendingRequest
    },
    connected,
    response,
  }
}
