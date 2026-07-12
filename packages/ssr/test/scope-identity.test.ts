import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { __fictUseContext, __fictUseSignal } from '@fictjs/runtime/internal'

import { renderToPartial } from '../src/experimental.node'
import {
  renderToDocument,
  renderToPipeableStream,
  renderToStream,
  renderToString,
  renderToStringAsync,
} from '../src/index.node'

const decoder = new TextDecoder()

function ScopedValue(props: { value: number }): FictNode {
  const ctx = __fictUseContext()
  const value = __fictUseSignal(ctx, props.value, { name: 'value' })
  return { type: 'span', props: { children: String(value()) } }
}

;(ScopedValue as any).__fictMeta = {
  id: 'ScopedValue@scope-identity',
  resume: 'scope-identity#resume',
}

function view(): FictNode {
  return { type: ScopedValue, props: { value: 7 } }
}

function expectScopeIdentity(html: string, expected: string): void {
  expect(html).toContain(`data-fict-s="${expected}"`)
  expect(html).toContain(`"${expected}":{"id":"${expected}"`)
}

function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return (async () => {
    const reader = stream.getReader()
    let html = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) html += decoder.decode(value, { stream: true })
    }
    return html + decoder.decode()
  })()
}

async function readPipeableStream(prefix: string): Promise<string> {
  const stream = renderToPipeableStream(view, {
    mode: 'shell',
    fullDocument: false,
    includeSnapshot: true,
    scopeIdentifierPrefix: prefix,
  })
  const sink = new PassThrough()
  let html = ''
  sink.setEncoding('utf8')
  sink.on('data', chunk => {
    html += String(chunk)
  })
  const ended = new Promise<void>((resolve, reject) => {
    sink.once('end', resolve)
    sink.once('error', reject)
  })
  stream.pipe(sink)
  await Promise.all([stream.allReady, ended])
  return html
}

describe('@fictjs/ssr resumable scope identity', () => {
  it('uses a stable explicit namespace across every render entry point', async () => {
    const prefix = 'account_scope'

    expectScopeIdentity(
      renderToString(view, { includeSnapshot: true, scopeIdentifierPrefix: prefix }),
      `${prefix}:s1`,
    )

    const documentResult = renderToDocument(view, {
      includeSnapshot: true,
      scopeIdentifierPrefix: prefix,
    })
    try {
      expectScopeIdentity(documentResult.html, `${prefix}:s1`)
    } finally {
      documentResult.dispose()
    }

    expectScopeIdentity(
      await renderToStringAsync(view, {
        includeSnapshot: true,
        scopeIdentifierPrefix: prefix,
      }),
      `${prefix}:s1`,
    )

    expectScopeIdentity(
      await readReadableStream(
        renderToStream(view, {
          mode: 'shell',
          fullDocument: false,
          includeSnapshot: true,
          scopeIdentifierPrefix: prefix,
        }),
      ),
      `${prefix}:s1`,
    )

    expectScopeIdentity(await readPipeableStream(prefix), `${prefix}:s1`)

    const partial = renderToPartial(view, {
      fullDocument: false,
      includeSnapshot: true,
      scopeIdentifierPrefix: prefix,
    })
    await Promise.all([partial.shellReady, partial.allReady])
    expectScopeIdentity(partial.shell, `${prefix}:s1`)
  })

  it('assigns a unique default namespace to independent string renders', () => {
    const first = renderToString(view)
    const second = renderToString(view)
    const firstId = first.match(/data-fict-s="([^"]+)"/)?.[1]
    const secondId = second.match(/data-fict-s="([^"]+)"/)?.[1]

    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
  })

  it.each(['', 'x'.repeat(129), 'bad--prefix', '</script>', 'bad"prefix', 'line\nbreak'])(
    'rejects unsafe scope namespace %j before rendering',
    async scopeIdentifierPrefix => {
      const createView = () => vi.fn(() => null)

      const stringView = createView()
      expect(() => renderToString(stringView, { scopeIdentifierPrefix })).toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(stringView).not.toHaveBeenCalled()

      const documentView = createView()
      expect(() => renderToDocument(documentView, { scopeIdentifierPrefix })).toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(documentView).not.toHaveBeenCalled()

      const asyncView = createView()
      await expect(renderToStringAsync(asyncView, { scopeIdentifierPrefix })).rejects.toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(asyncView).not.toHaveBeenCalled()

      const streamView = createView()
      expect(() => renderToStream(streamView, { scopeIdentifierPrefix })).toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(streamView).not.toHaveBeenCalled()

      const pipeableView = createView()
      expect(() => renderToPipeableStream(pipeableView, { scopeIdentifierPrefix })).toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(pipeableView).not.toHaveBeenCalled()

      const partialView = createView()
      expect(() => renderToPartial(partialView, { scopeIdentifierPrefix })).toThrow(
        /scopeIdentifierPrefix must contain 1-128 ASCII letters/,
      )
      expect(partialView).not.toHaveBeenCalled()
    },
  )
})
