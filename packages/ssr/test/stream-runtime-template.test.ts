import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'

import { renderToStream } from '../src/index'
import { createStreamRuntimeCode } from '../src/stream-runtime'

const decoder = new TextDecoder()

interface StreamRuntimeWindow extends Window {
  __FICT_STREAM?: {
    apply: (id: string) => void
  }
}

function installStreamRuntime(window: StreamRuntimeWindow, observerMode = false): void {
  delete window.__FICT_STREAM
  runInNewContext(createStreamRuntimeCode({ observerMode }), {
    document: window.document,
    window,
  })
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

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__FICT_STREAM
})

describe('@fictjs/ssr stream runtime template boundaries', () => {
  it('rejects a streamed resumable boundary nested in template content', async () => {
    const token = createSuspenseToken()

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      return {
        type: 'template',
        props: {
          id: 'outer',
          children: {
            type: 'template',
            props: {
              id: 'inner',
              children: {
                type: Suspense,
                props: {
                  fallback: {
                    type: 'span',
                    props: { 'data-pending': '', children: 'Pending' },
                  },
                  children: { type: AsyncChild, props: {} },
                },
              },
            },
          },
        },
      }
    }

    await expect(
      readReadableStream(renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })),
    ).rejects.toThrowError(/Cannot serialize <template> content containing a resumable scope/)
  })

  it('discovers pre-parsed patch templates in template content on DOMContentLoaded', () => {
    const window = parseHTML(`
      <main>
        <!--fict:suspense-start:s1-->
        <span data-pending>Pending</span>
        <!--fict:suspense-end:s1-->
      </main>
      <template id="transport">
        <template data-fict-suspense="s1">
          <strong data-resolved>Resolved</strong>
        </template>
      </template>
    `) as unknown as StreamRuntimeWindow
    const document = window.document
    const transport = document.querySelector('#transport') as HTMLTemplateElement

    expect(document.querySelector('template[data-fict-suspense]')).toBeNull()
    expect(transport.content.querySelector('template[data-fict-suspense]')).not.toBeNull()

    installStreamRuntime(window, true)
    document.dispatchEvent(new window.Event('DOMContentLoaded'))

    expect(document.querySelector('[data-pending]')).toBeNull()
    expect(document.querySelector('[data-resolved]')?.textContent).toBe('Resolved')
    expect(transport.content.querySelector('template[data-fict-suspense]')).toBeNull()
  })

  it('upgrades an existing inline runtime when an observer runtime loads later', () => {
    const window = parseHTML(`
      <main>
        <!--fict:suspense-start:s1-->
        <span data-pending>Pending</span>
        <!--fict:suspense-end:s1-->
      </main>
      <template data-fict-suspense="s1">
        <strong data-resolved>Resolved</strong>
      </template>
    `) as unknown as StreamRuntimeWindow
    const context = { document: window.document, window }

    runInNewContext(createStreamRuntimeCode({ observerMode: false }), context)
    const inlineRuntime = window.__FICT_STREAM
    runInNewContext(createStreamRuntimeCode({ observerMode: true }), context)
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'))

    expect(window.__FICT_STREAM).toBe(inlineRuntime)
    expect(window.document.querySelector('[data-pending]')).toBeNull()
    expect(window.document.querySelector('[data-resolved]')?.textContent).toBe('Resolved')
  })

  it('matches patch ids as attribute values instead of selector source', () => {
    const id = 's1"][data-fict-suspense="other'
    const window = parseHTML(
      '<!doctype html><html><body><main></main></body></html>',
    ) as unknown as StreamRuntimeWindow
    const document = window.document
    const main = document.querySelector('main')!
    const pending = document.createElement('span')
    pending.setAttribute('data-pending', '')
    pending.textContent = 'Pending'
    main.append(
      document.createComment(`fict:suspense-start:${id}`),
      pending,
      document.createComment(`fict:suspense-end:${id}`),
    )

    const patch = document.createElement('template')
    patch.setAttribute('data-fict-suspense', id)
    const resolved = document.createElement('strong')
    resolved.setAttribute('data-resolved', '')
    resolved.textContent = 'Resolved'
    patch.content.appendChild(resolved)
    document.body.appendChild(patch)

    installStreamRuntime(window)
    window.__FICT_STREAM?.apply(id)

    expect(main.querySelector('[data-pending]')).toBeNull()
    expect(main.querySelector('[data-resolved]')?.textContent).toBe('Resolved')
    expect(patch.isConnected).toBe(false)
  })

  it('leaves the DOM unchanged when boundary markers are not siblings', () => {
    const window = parseHTML(`
      <main>
        <!--fict:suspense-start:s1-->
        <span data-pending>Pending</span>
      </main>
      <footer><!--fict:suspense-end:s1--></footer>
      <template data-fict-suspense="s1">
        <strong data-resolved>Resolved</strong>
      </template>
    `) as unknown as StreamRuntimeWindow
    const document = window.document
    const patch = document.querySelector('template[data-fict-suspense="s1"]') as HTMLTemplateElement

    installStreamRuntime(window)
    window.__FICT_STREAM?.apply('s1')

    expect(document.querySelector('[data-pending]')?.textContent).toBe('Pending')
    expect(document.querySelector('[data-resolved]')).toBeNull()
    expect(patch.isConnected).toBe(true)
    expect(patch.content.querySelector('[data-resolved]')?.textContent).toBe('Resolved')
  })
})
