import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import {
  LiveTraceClient,
  normalizeLiveTraceServerUrl,
  readLiveTraceToken,
} from '../src/analysis/live-client'
import { LiveTraceStore } from '../src/analysis/live-trace'

describe('live trace client', () => {
  it('resolves the configured token and canonical bridge URL', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-vscode-live-token-'))
    try {
      const tokenPath = path.join(root, '.fict-cache', 'devtools-token')
      await fs.mkdir(path.dirname(tokenPath), { recursive: true })
      await fs.writeFile(tokenPath, 'test-token\n')

      await expect(readLiveTraceToken('.fict-cache/devtools-token', root)).resolves.toBe(
        'test-token',
      )
      expect(normalizeLiveTraceServerUrl('http://localhost:5173')).toBe(
        'ws://localhost:5173/__fict-trace__',
      )
      expect(normalizeLiveTraceServerUrl('https://example.test/app/')).toBe(
        'wss://example.test/app/__fict-trace__',
      )
      expect(normalizeLiveTraceServerUrl('ftp://example.test')).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('authenticates, subscribes, and applies updates from the bridge', async () => {
    const token = 'bridge-token'
    const file = path.resolve('/tmp/Counter.tsx')
    const bridgeFile = path.resolve('/private/tmp/Counter.tsx')
    const httpServer = createServer()
    const webSocketServer = new WebSocketServer({ noServer: true })
    let authorized = false

    httpServer.on('upgrade', (request, socket, head) => {
      if (request.url !== '/__fict-trace__') return
      authorized = request.headers.authorization === `Bearer ${token}`
      if (!authorized) {
        socket.destroy()
        return
      }
      webSocketServer.handleUpgrade(request, socket, head, client => {
        webSocketServer.emit('connection', client, request)
      })
    })

    webSocketServer.on('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type?: string; file?: string }
        if (message.type !== 'trace/subscribe' || message.file !== file) return
        socket.send(
          JSON.stringify({
            type: 'trace/update',
            file: bridgeFile,
            line: 9,
            kind: 'effect',
            runCount: 2,
            lastDurationMs: 0.75,
          }),
        )
      })
    })

    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')

    const store = new LiveTraceStore()
    const onFileUpdate = vi.fn()
    const client = new LiveTraceClient(store, { onFileUpdate })

    try {
      expect(client.connect(`http://127.0.0.1:${address.port}`, token)).toBe(true)
      client.subscribe(file)

      await vi.waitFor(() => {
        expect(onFileUpdate).toHaveBeenCalledWith(file)
      })
      expect(authorized).toBe(true)
      expect(store.getLineUpdates(file).get(9)).toEqual({
        line: 9,
        kind: 'effect',
        runCount: 2,
        lastDurationMs: 0.75,
      })
      expect(client.connect(`http://127.0.0.1:${address.port}`, token)).toBe(true)
      expect(webSocketServer.clients.size).toBe(1)
    } finally {
      client.dispose()
      for (const socket of webSocketServer.clients) socket.terminate()
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()))
      })
    }
  })
})
