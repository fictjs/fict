import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'

import { renderToPipeableStream, renderToStream } from '../src/index'
import { createStreamRuntimeCode } from '../src/stream-runtime'

const decoder = new TextDecoder()

interface StreamRuntimeWindow extends Window {
  __FICT_STREAM?: {
    apply: (id: string) => void
  }
}

interface RenderedBoundary {
  id: string
  outputHtml: string
  patchHtml: string
  rootHtml: string
}

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let output = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) output += decoder.decode(value, { stream: true })
  }
  return output + decoder.decode()
}

async function renderBoundary(
  label: string,
  streamIdentifierPrefix?: string,
): Promise<RenderedBoundary> {
  const token = createSuspenseToken()
  let ready = false

  function AsyncChild(): FictNode {
    if (!ready) throw token.token
    return {
      type: 'strong',
      props: { 'data-resolved': label, children: `${label} resolved` },
    }
  }

  function App(): FictNode {
    return {
      type: 'section',
      props: {
        'data-stream-root': label,
        children: {
          type: Suspense,
          props: {
            fallback: {
              type: 'span',
              props: { 'data-pending': label, children: `${label} pending` },
            },
            children: { type: AsyncChild, props: {} },
          },
        },
      },
    }
  }

  const readAll = readReadableStream(
    renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      streamIdentifierPrefix,
    }),
  )
  await Promise.resolve()
  ready = true
  token.resolve()

  const outputHtml = await readAll
  const window = parseHTML(outputHtml)
  const root = window.document.querySelector(`[data-stream-root="${label}"]`)
  const patch = window.document.querySelector(
    'template[data-fict-suspense]',
  ) as HTMLTemplateElement | null
  const id = patch?.getAttribute('data-fict-suspense')
  if (!root || !patch || !id) throw new Error(`Missing streamed boundary output for ${label}`)

  return { id, outputHtml, patchHtml: patch.outerHTML, rootHtml: root.outerHTML }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__FICT_STREAM
})

describe('@fictjs/ssr stream boundary identity', () => {
  it('keeps patches isolated when independent streams share a document', async () => {
    const first = await renderBoundary('first')
    const second = await renderBoundary('second')
    const window = parseHTML(`
      <!doctype html>
      <html>
        <body>
          ${first.rootHtml}
          ${second.rootHtml}
          ${second.patchHtml}
        </body>
      </html>
    `) as unknown as StreamRuntimeWindow

    delete window.__FICT_STREAM
    runInNewContext(createStreamRuntimeCode({ observerMode: false }), {
      document: window.document,
      window,
    })
    window.__FICT_STREAM?.apply(second.id)

    const firstRoot = window.document.querySelector('[data-stream-root="first"]')!
    const secondRoot = window.document.querySelector('[data-stream-root="second"]')!
    expect(firstRoot.querySelector('[data-pending]')?.textContent).toBe('first pending')
    expect(firstRoot.querySelector('[data-resolved]')).toBeNull()
    expect(secondRoot.querySelector('[data-pending]')).toBeNull()
    expect(secondRoot.querySelector('[data-resolved]')?.textContent).toBe('second resolved')
    expect(first.id).not.toBe(second.id)
  })

  it('uses a caller-provided stable patch namespace', async () => {
    const rendered = await renderBoundary('configured', 'account_shell')
    const document = parseHTML(rendered.outputHtml).document
    const scopeIds = Array.from(document.querySelectorAll('script[data-fict-snapshot]'), script =>
      Object.keys(JSON.parse(script.textContent ?? '{}').scopes ?? {}),
    ).flat()

    expect(rendered.id).toBe('account_shell:s1')
    expect(rendered.rootHtml).toContain('fict:suspense-start:account_shell:s1')
    expect(rendered.patchHtml).toContain('data-fict-suspense="account_shell:s1"')
    expect(rendered.outputHtml).toContain('__FICT_STREAM.apply("account_shell:s1")')
    expect(scopeIds).toContain('s1')
    expect(scopeIds).not.toContain('account_shell:s1')
  })

  it.each(['', 'x'.repeat(129), 'bad--prefix', '</script>', 'bad"prefix', 'line\nbreak'])(
    'rejects unsafe patch namespace %j before rendering',
    streamIdentifierPrefix => {
      const webView = vi.fn(() => null)
      expect(() =>
        renderToStream(webView, {
          mode: 'shell',
          streamIdentifierPrefix,
        }),
      ).toThrow(/streamIdentifierPrefix must contain 1-128 ASCII letters/)
      expect(webView).not.toHaveBeenCalled()

      const pipeableView = vi.fn(() => null)
      expect(() =>
        renderToPipeableStream(pipeableView, {
          mode: 'shell',
          streamIdentifierPrefix,
        }),
      ).toThrow(/streamIdentifierPrefix must contain 1-128 ASCII letters/)
      expect(pipeableView).not.toHaveBeenCalled()
    },
  )
})
