import { describe, it, expect } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'
import { __fictUseContext, __fictUseSignal } from '@fictjs/runtime/internal'

import { renderToPartial, renderToPipeableStream, renderToStream } from '../src/index'
import { createQueuedTextStream } from '../src/stream-bridge'
import { FICT_STREAM_RUNTIME_CODE, createStreamRuntimeCode } from '../src/stream-runtime'

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
  it('waits for queued text stream pulls under backpressure', async () => {
    const { stream, writer } = createQueuedTextStream()
    let released = false

    const writeReady = Promise.resolve(writer.write('blocked')).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value ? decoder.decode(first.value) : '').toBe('blocked')

    await writeReady
    expect(released).toBe(true)
    writer.close()
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
  })

  it('escapes incremental snapshot payloads in shell mode', async () => {
    const attack = '</script><script>globalThis.__fict_stream_xss=1</script>'

    function Counter(): FictNode {
      const ctx = __fictUseContext()
      const message = __fictUseSignal(ctx, attack, { name: 'message' })
      return { type: 'span', props: { children: String(message()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@stream-xss', resume: 'counter#resume' }

    const stream = renderToStream(() => ({ type: Counter, props: {} }), {
      mode: 'shell',
      fullDocument: true,
    })
    const html = await readReadableStream(stream)

    expect(html).toContain('data-fict-snapshot')
    expect(html).not.toContain('</script><script>globalThis.__fict_stream_xss=1</script>')
    expect(html).toContain(
      '\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.__fict_stream_xss=1\\u003c/script\\u003e',
    )
  })

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

  it('applies CSP nonces to generated streaming scripts', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'NonceDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'NonceLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      scriptNonce: 'nonce-&-"',
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('nonce="nonce-&amp;-&quot;"')
    expect(html).toContain('<script nonce="nonce-&amp;-&quot;">(function(){')
    expect(html).toContain('<script nonce="nonce-&amp;-&quot;">__FICT_STREAM.apply("s1")</script>')
    expect(html).toContain('<script nonce="nonce-&amp;-&quot;" type="application/json"')
  })

  it('can stream observer patches without inline patch scripts', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'ObserverDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ObserverLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      streamPatchMode: 'observer',
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('MutationObserver')
    expect(html).toContain('data-fict-suspense="s1"')
    expect(html).toContain('ObserverDone')
    expect(html).not.toContain('__FICT_STREAM.apply("s1")')
  })

  it('can reference an external stream runtime for strict CSP', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'ExternalDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ExternalLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      streamRuntime: 'external',
      streamRuntimeSrc: '/assets/fict-stream-runtime.js',
      scriptNonce: 'external-nonce',
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain(
      '<script nonce="external-nonce" src="/assets/fict-stream-runtime.js" data-fict-stream-runtime data-fict-stream-observer></script>',
    )
    expect(html).toContain('ExternalDone')
    expect(html).not.toContain('__FICT_STREAM.apply("s1")')
  })

  it('exposes classic stream runtime code for external assets', () => {
    const code = createStreamRuntimeCode({ observerMode: true })

    expect(code).toBe(FICT_STREAM_RUNTIME_CODE)
    expect(code).toContain('(function(){')
    expect(code).toContain('MutationObserver')
    expect(code).toContain('window.__FICT_STREAM')
    expect(code).not.toContain('export ')
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

  it('pipeable stream buffers output before pipe() and flushes after attach', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'LatePipeDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'LatePipeLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const { pipe, shellReady, allReady } = renderToPipeableStream(
      () => ({ type: App, props: {} }),
      {
        mode: 'shell',
      },
    )

    // Wait until shell has been produced before attaching writable.
    await shellReady
    await Promise.resolve()
    ready = true
    token.resolve()

    const chunks: Buffer[] = []
    const { PassThrough } = await import('node:stream')
    const writable = new PassThrough()
    writable.on('data', chunk => chunks.push(chunk as Buffer))
    pipe(writable)

    await allReady
    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain('LatePipeLoading')
    expect(html).toContain('LatePipeDone')
  })

  it('resolves pipeable shellReady for large shells before pipe()', async () => {
    const largeText = 'x'.repeat(1024 * 1024)
    const { pipe, shellReady, allReady } = renderToPipeableStream(
      () => ({ type: 'div', props: { children: largeText } }),
      {
        mode: 'shell',
      },
    )

    const shellState = await Promise.race([
      shellReady.then(() => 'ready'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 200)),
    ])
    expect(shellState).toBe('ready')

    const chunks: Buffer[] = []
    const { PassThrough } = await import('node:stream')
    const writable = new PassThrough()
    const ended = new Promise<void>(resolve => writable.on('end', resolve))
    writable.on('data', chunk => chunks.push(chunk as Buffer))

    pipe(writable)
    await allReady
    await ended

    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain(largeText.slice(0, 128))
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

  it('escapes script nonce literals in head-target incremental snapshots', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'HeadNonceDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'HeadNonceLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      fullDocument: true,
      snapshotTarget: 'head',
      scriptNonce: '</script><script>globalThis.__fict_nonce_xss=1</script>',
    })

    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('data-fict-snapshot')
    expect(html).toContain('s.setAttribute')
    expect(html).toContain('\\u003c/script\\u003e')
    expect(html).not.toContain(
      's.setAttribute(\'nonce\',"</script><script>globalThis.__fict_nonce_xss=1</script>");',
    )
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

  it('aborts shell stream when suspense token rejects without a boundary', async () => {
    const token = createSuspenseToken()

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'RejectLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    let error: unknown
    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      onError(err) {
        error = err
      },
    })
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    token.reject(new Error('reject-boom'))

    await expect(readAll).rejects.toThrow('reject-boom')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('reject-boom')
  })

  it('streams multiple suspense boundaries in resolve order', async () => {
    const first = createSuspenseToken()
    const second = createSuspenseToken()
    let firstReady = false
    let secondReady = false

    function FirstChild(): FictNode {
      if (!firstReady) throw first.token
      return { type: 'span', props: { children: 'FirstDone' } }
    }

    function SecondChild(): FictNode {
      if (!secondReady) throw second.token
      return { type: 'span', props: { children: 'SecondDone' } }
    }

    function App(): FictNode {
      return {
        type: 'div',
        props: {
          children: [
            {
              type: Suspense,
              props: {
                fallback: { type: 'div', props: { children: 'FirstLoading' } },
                children: { type: FirstChild, props: {} },
              },
            },
            {
              type: Suspense,
              props: {
                fallback: { type: 'div', props: { children: 'SecondLoading' } },
                children: { type: SecondChild, props: {} },
              },
            },
          ],
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    secondReady = true
    second.resolve()
    await Promise.resolve()
    firstReady = true
    first.resolve()

    const html = await readAll
    expect(html).toContain('FirstLoading')
    expect(html).toContain('SecondLoading')
    expect(html).toContain('FirstDone')
    expect(html).toContain('SecondDone')
    expect((html.match(/data-fict-suspense=/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html.indexOf('SecondDone')).toBeLessThan(html.indexOf('FirstDone'))
  })

  it('isolates resumable state across concurrent streams', async () => {
    const first = createSuspenseToken()
    const second = createSuspenseToken()
    let firstReady = false
    let secondReady = false

    function Counter(props: { label: string }): FictNode {
      const ctx = __fictUseContext()
      const label = __fictUseSignal(ctx, props.label, { name: 'label' })
      return { type: 'span', props: { children: `resolved:${String(label())}` } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@concurrent', resume: 'counter#resume' }

    function FirstChild(): FictNode {
      if (!firstReady) throw first.token
      return { type: Counter, props: { label: 'first-stream' } }
    }

    function SecondChild(): FictNode {
      if (!secondReady) throw second.token
      return { type: Counter, props: { label: 'second-stream' } }
    }

    function App(props: { child: () => FictNode }): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ConcurrentLoading' } },
          children: { type: props.child, props: {} },
        },
      }
    }

    const firstStream = renderToStream(() => ({ type: App, props: { child: FirstChild } }), {
      mode: 'shell',
    })
    const firstRead = readReadableStream(firstStream)

    const secondStream = renderToStream(() => ({ type: App, props: { child: SecondChild } }), {
      mode: 'shell',
    })
    const secondRead = readReadableStream(secondStream)

    await Promise.resolve()
    secondReady = true
    second.resolve()
    const secondHtml = await secondRead

    firstReady = true
    first.resolve()
    const firstHtml = await firstRead

    expect(secondHtml).toContain('resolved:second-stream')
    expect(secondHtml).toContain('data-fict-s=')
    expect(secondHtml).toContain('second-stream')
    expect(secondHtml).not.toContain('first-stream')

    expect(firstHtml).toContain('resolved:first-stream')
    expect(firstHtml).toContain('data-fict-s=')
    expect(firstHtml).toContain('first-stream')
    expect(firstHtml).not.toContain('second-stream')
  })

  it('renderToPartial returns full shell and patch stream separately', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'PartialDone' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'PartialLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const partial = renderToPartial(() => ({ type: App, props: {} }), {
      fullDocument: true,
      mode: 'shell',
    })

    expect(partial.shell).toContain('<!DOCTYPE html')
    expect(partial.shell).toContain('PartialLoading')
    expect(partial.shell).toContain('__FICT_STREAM')
    expect(partial.shell).toContain('data-fict-snapshot')
    expect(partial.shell).toContain('</html>')
    expect(partial.shell).not.toContain('PartialDone')

    const readPatches = readReadableStream(partial.stream)
    await Promise.resolve()
    ready = true
    token.resolve()
    await partial.shellReady

    const patches = await readPatches
    expect(patches).toContain('PartialDone')
    expect(patches).toContain('data-fict-suspense')
    await expect(partial.allReady).resolves.toBeUndefined()
  })

  it('respects AbortSignal cancellation in shell mode', async () => {
    const token = createSuspenseToken()
    const controller = new AbortController()

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'AbortLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      signal: controller.signal,
    })
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    controller.abort(new Error('abort-shell'))

    await expect(readAll).rejects.toThrow('abort-shell')
  })

  it('does not render or leak globals when a web stream signal is already aborted', async () => {
    const previousDocument = (globalThis as { document?: Document }).document
    const hadDocument = 'document' in globalThis
    const controller = new AbortController()
    controller.abort(new Error('pre-abort-web'))
    let rendered = false

    try {
      const stream = renderToStream(
        () => {
          rendered = true
          return { type: 'div', props: { children: 'should-not-render' } }
        },
        { signal: controller.signal },
      )

      await expect(readReadableStream(stream)).rejects.toThrow('pre-abort-web')
      expect(rendered).toBe(false)
      expect((globalThis as { document?: Document }).document).toBe(previousDocument)
      expect('document' in globalThis).toBe(hadDocument)
    } finally {
      if (!hadDocument) {
        delete (globalThis as { document?: Document }).document
      }
    }
  })

  it('rejects pipeable readiness without rendering when a signal is already aborted', async () => {
    const previousDocument = (globalThis as { document?: Document }).document
    const hadDocument = 'document' in globalThis
    const controller = new AbortController()
    controller.abort(new Error('pre-abort-pipe'))
    let rendered = false

    try {
      const { shellReady, allReady } = renderToPipeableStream(
        () => {
          rendered = true
          return { type: 'div', props: { children: 'should-not-render' } }
        },
        { signal: controller.signal },
      )

      await expect(shellReady).rejects.toThrow('pre-abort-pipe')
      await expect(allReady).rejects.toThrow('pre-abort-pipe')
      expect(rendered).toBe(false)
      expect((globalThis as { document?: Document }).document).toBe(previousDocument)
      expect('document' in globalThis).toBe(hadDocument)
    } finally {
      if (!hadDocument) {
        delete (globalThis as { document?: Document }).document
      }
    }
  })
})
