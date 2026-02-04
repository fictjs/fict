import { describe, it, expect } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'

import { renderToPipeableStream } from '../src/index'

import { createServer } from 'node:http'

const decoder = new TextDecoder()

describe('@fictjs/ssr streaming e2e', () => {
  it('streams shell first, then patches boundary', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'StreamDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'StreamLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const server = createServer((req, res) => {
      const { pipe, shellReady, allReady } = renderToPipeableStream(
        () => ({ type: App, props: {} }),
        { mode: 'shell', fullDocument: true },
      )

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      pipe(res)

      shellReady.then(() => {
        setTimeout(() => {
          ready = true
          token.resolve()
        }, 50)
      })

      allReady.catch(() => {
        // ignore; client side asserts
      })
    })

    await new Promise<void>(resolve => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Failed to bind test server')
    }
    const url = `http://127.0.0.1:${address.port}/`

    const response = await fetch(url)
    if (!response.body) {
      server.close()
      throw new Error('Missing response body stream')
    }

    const reader = response.body.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    const firstChunk = decoder.decode(first.value)

    let rest = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) rest += decoder.decode(value, { stream: true })
    }
    rest += decoder.decode()

    const html = firstChunk + rest

    expect(firstChunk).toContain('StreamLoading')
    expect(firstChunk).toContain('fict:suspense-start')
    expect(firstChunk).toContain('__FICT_STREAM')
    expect(firstChunk).not.toContain('StreamDone')

    expect(html).toContain('StreamDone')
    expect(html).toContain('data-fict-suspense')
    expect(html).toContain('__FICT_STREAM.apply')

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
