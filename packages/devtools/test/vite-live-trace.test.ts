// @vitest-environment node

import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import fictDevTools from '../src/vite/index'
import {
  DEFAULT_LIVE_TRACE_TOKEN_PATH,
  LIVE_TRACE_ENDPOINT,
  LIVE_TRACE_EVENT,
} from '../src/vite/live-trace-bridge'

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for WebSocket message'))
    }, 5_000)
    const onClose = () => {
      cleanup()
      reject(new Error('WebSocket closed before the expected message'))
    }
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>
        if (!predicate(message)) return
        cleanup()
        resolve(message)
      } catch {
        // Ignore unrelated malformed messages.
      }
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('close', onClose)
      socket.off('message', onMessage)
    }

    socket.on('close', onClose)
    socket.on('message', onMessage)
  })
}

function rejectUnauthorizedConnection(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.terminate()
      reject(new Error('Timed out waiting for unauthorized response'))
    }, 5_000)
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout)
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => {
      clearTimeout(timeout)
      socket.terminate()
      reject(new Error('Unauthenticated live trace connection was accepted'))
    })
    socket.once('error', () => {
      // `ws` may report the rejected handshake after unexpected-response.
    })
  })
}

describe('DevTools Vite live trace bridge', () => {
  let server: ViteDevServer | undefined
  let root: string | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await server?.close()
    server = undefined
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('authenticates editor clients and forwards subscribed runtime updates', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-live-trace-'))
    await fs.writeFile(path.join(root, 'index.html'), '<div id="app"></div>')
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [fictDevTools({ enabled: true })],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()

    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing Vite server address')
    const origin = `ws://127.0.0.1:${address.port}`
    const endpoint = `${origin}/${LIVE_TRACE_ENDPOINT}`
    const tokenPath = path.join(root, DEFAULT_LIVE_TRACE_TOKEN_PATH)
    const token = (await fs.readFile(tokenPath, 'utf8')).trim()

    await expect(rejectUnauthorizedConnection(endpoint)).resolves.toBe(401)

    const editor = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const editorReady = waitForJsonMessage(editor, message => message.type === 'trace/ready')
    sockets.push(editor)
    await once(editor, 'open')
    await editorReady

    const sourceFile = path.join(root, 'src', 'Counter.tsx')
    const subscribed = waitForJsonMessage(editor, message => message.type === 'trace/subscribed')
    editor.send(JSON.stringify({ type: 'trace/subscribe', file: sourceFile }))
    await expect(subscribed).resolves.toMatchObject({ file: sourceFile })

    const browser = new WebSocket(`${origin}/`, 'vite-hmr')
    const browserReady = waitForJsonMessage(browser, message => message.type === 'connected')
    sockets.push(browser)
    await once(browser, 'open')
    await browserReady

    const updatePromise = waitForJsonMessage(editor, message => message.type === 'trace/update')
    browser.send(
      JSON.stringify({
        type: 'custom',
        event: LIVE_TRACE_EVENT,
        data: {
          type: 'trace/update',
          file: sourceFile,
          line: 8,
          kind: 'effect',
          runCount: 3,
          lastDurationMs: 1.25,
        },
      }),
    )

    await expect(updatePromise).resolves.toEqual({
      type: 'trace/update',
      file: sourceFile,
      line: 8,
      kind: 'effect',
      runCount: 3,
      lastDurationMs: 1.25,
    })

    editor.terminate()
    browser.terminate()
    sockets.length = 0
    await server.close()
    server = undefined
    await expect(fs.access(tokenPath)).rejects.toThrow()
  })
})
