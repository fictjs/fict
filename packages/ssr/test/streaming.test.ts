import { describe, it, expect } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'

import { renderToPipeableStream, renderToStream } from '../src/index'

const decoder = new TextDecoder()

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe('@fictjs/ssr streaming', () => {
  it('streams shell and patches Suspense boundaries', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'Done' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'Loading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
    const readAll = readReadableStream(stream)

    // Resolve after microtask to ensure shell is emitted first.
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('Loading')
    expect(html).toContain('__FICT_STREAM')
    expect(html).toContain('data-fict-snapshot')
    expect(html).toContain('data-fict-suspense')
    expect(html).toContain('Done')
  })

  it('pipeable stream emits shell and completes on resolve', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'PipeDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'PipeLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const { pipe, allReady } = renderToPipeableStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
    })

    const chunks: Buffer[] = []
    const { PassThrough } = await import('node:stream')
    const writable = new PassThrough()
    writable.on('data', chunk => chunks.push(chunk as Buffer))

    pipe(writable)

    await Promise.resolve()
    ready = true
    token.resolve()

    await allReady
    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain('PipeLoading')
    expect(html).toContain('PipeDone')
    expect(html).toContain('data-fict-snapshot')
    expect(html).toContain('data-fict-suspense')
  })

  it('all-ready mode emits single HTML with snapshot', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'AllReadyDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'AllReadyLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'all',
      fullDocument: true,
    })

    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('AllReadyDone')
    expect(html).toContain('__FICT_SNAPSHOT__')
    expect(html).not.toContain('data-fict-suspense')
  })

  it('streaming snapshotTarget=head injects into head via script', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'HeadDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'HeadLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      fullDocument: true,
      snapshotTarget: 'head',
    })

    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('data-fict-snapshot')
    expect(html).toContain('document.head')
  })

  it('all-ready mode respects snapshotTarget=head for full documents', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'HeadAllReady' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'HeadAllLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'all',
      fullDocument: true,
      snapshotTarget: 'head',
    })

    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    const headIndex = html.indexOf('<head')
    const snapshotIndex = html.indexOf('__FICT_SNAPSHOT__')
    expect(headIndex).toBeGreaterThan(-1)
    expect(snapshotIndex).toBeGreaterThan(headIndex)
  })
})
