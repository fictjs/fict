import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'

import { describe, it, expect, vi } from 'vitest'
import { parseHTML } from 'linkedom'

import type { FictNode } from '@fictjs/runtime'
import { ErrorBoundary, Suspense, createSuspenseToken, onDestroy } from '@fictjs/runtime'
import {
  __fictUseContext,
  __fictUseSignal,
  __fictGetCurrentSSRSession,
  __fictIsSSRSessionActive,
  createElement,
  getSlotEnd,
  insertBetween,
  resolvePath,
  template,
} from '@fictjs/runtime/internal'

import { renderToPipeableStream, renderToStream } from '../src/index.node'
import { renderToPartial } from '../src/experimental.node'
import { createPipeBridge, createQueuedTextStream } from '../src/stream-bridge'
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

describe('@fictjs/ssr streaming', () => {
  it('keeps concurrent Node stream sessions across async continuations', async () => {
    let aliceSessionAfterAwait!: Promise<unknown>
    let bobSessionAfterAwait!: Promise<unknown>

    const createView = (label: 'Alice' | 'Bob') => () => {
      const sessionDuringRender = __fictGetCurrentSSRSession()
      expect(sessionDuringRender).not.toBeNull()
      const captured = Promise.resolve().then(async () => {
        await Promise.resolve()
        return __fictGetCurrentSSRSession()
      })
      if (label === 'Alice') aliceSessionAfterAwait = captured
      else bobSessionAfterAwait = captured
      return { type: 'span', props: { children: label } }
    }

    const aliceRead = readReadableStream(renderToStream(createView('Alice')))
    const bobRead = readReadableStream(renderToStream(createView('Bob')))
    const [aliceHtml, bobHtml, aliceSession, bobSession] = await Promise.all([
      aliceRead,
      bobRead,
      aliceSessionAfterAwait,
      bobSessionAfterAwait,
    ])

    expect(aliceHtml).toContain('Alice')
    expect(bobHtml).toContain('Bob')
    expect(aliceSession).not.toBeNull()
    expect(bobSession).not.toBeNull()
    expect(aliceSession).not.toBe(bobSession)
  })

  it('keeps a pending stream marked active until cleanup', async () => {
    const pending = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw pending.token
      return { type: 'span', props: { children: 'done' } }
    }

    const stream = renderToStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'span', props: { children: 'loading' } },
          children: { type: AsyncChild, props: {} },
        },
      }),
      { mode: 'shell' },
    )
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    expect(__fictIsSSRSessionActive()).toBe(true)

    ready = true
    pending.resolve()
    expect(await readAll).toContain('done')
    expect(__fictIsSSRSessionActive()).toBe(false)
  })

  it('contains errors emitted by the internal Node stream on abort', async () => {
    const globals = globalThis as Record<string, unknown>
    const hadRequire = Object.prototype.hasOwnProperty.call(globals, 'require')
    const previousRequire = globals.require

    try {
      // ESM test workers normally have no global require. Supplying one makes
      // this exercise the same Node bridge selected by the published CJS build.
      globals.require = createRequire(import.meta.url)

      const bridge = createPipeBridge()
      const sink = new PassThrough()
      sink.resume()
      bridge.pipe(sink)
      bridge.abort(new Error('manual-cjs-abort'))

      // Node emits the internal PassThrough error asynchronously.
      await new Promise<void>(resolve => setImmediate(resolve))
    } finally {
      if (hadRequire) {
        globals.require = previousRequire
      } else {
        delete globals.require
      }
    }
  })

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

  it('inserts full-document stream chunks at the structural end of body', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'StructuralDone' } }
    }

    const stream = renderToStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'span', props: { children: 'StructuralLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }),
      {
        mode: 'shell',
        fullDocument: true,
        html: `<!doctype html><html><head></head><body><script id="body-text">globalThis.__closingBody = "</body>"</script></body><!-- after </body> marker --></html>`,
      },
    )
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    const streamedDocument = parseHTML(html).document

    expect(html).toContain('<!-- after </body> marker -->')
    expect(streamedDocument.querySelector('#body-text')?.textContent).toContain('"</body>"')
    expect(streamedDocument.querySelector('template[data-fict-suspense]')).not.toBeNull()
    expect(streamedDocument.body?.textContent).toContain('StructuralDone')
  })

  it('settles compiled insertBetween Suspense streams without remounting the boundary', async () => {
    const token = createSuspenseToken()
    let ready = false
    let asyncChildRenders = 0
    const compiledTemplate = template(
      '<main><section><!--fict:slot:start--><!--fict:slot:end--></section></main>',
    )

    function AsyncChild(): FictNode {
      asyncChildRenders += 1
      if (!ready) throw token.token
      return { type: 'strong', props: { children: 'CompiledDone' } }
    }

    function CompilerShapedApp(): FictNode {
      const root = compiledTemplate()
      const start = resolvePath(root, [0, 0])
      if (!start || start.nodeType !== 8) {
        throw new Error('Failed to resolve compiler-style slot start marker')
      }
      const end = getSlotEnd(start as Comment)
      insertBetween(
        start as Comment,
        end,
        () => ({
          type: Suspense,
          props: {
            fallback: { type: 'span', props: { children: 'CompiledLoading' } },
            children: { type: AsyncChild, props: {} },
          },
        }),
        createElement,
      )
      return root
    }

    const { pipe, shellReady, allReady } = renderToPipeableStream(
      () => ({ type: CompilerShapedApp, props: {} }),
      { mode: 'shell', fullDocument: true },
    )
    const sink = new PassThrough()
    const chunks: Buffer[] = []
    const ended = new Promise<void>((resolve, reject) => {
      sink.on('data', chunk => chunks.push(chunk as Buffer))
      sink.once('end', resolve)
      sink.once('error', reject)
    })

    pipe(sink)
    await withTimeout(shellReady, 500, 'compiled Suspense shellReady')

    const shell = Buffer.concat(chunks).toString('utf8')
    expect(shell).toContain('CompiledLoading')
    expect(shell).toContain('fict:suspense-start')
    expect(shell).not.toContain('CompiledDone')
    expect(asyncChildRenders).toBe(1)

    ready = true
    token.resolve()
    await withTimeout(allReady, 500, 'compiled Suspense allReady')
    await withTimeout(ended, 500, 'compiled Suspense output stream')

    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain('CompiledLoading')
    expect(html).toContain('CompiledDone')
    expect(html).toContain('data-fict-suspense')
    expect(asyncChildRenders).toBe(2)
  })

  it('safely serializes raw-text content in deferred patches', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return {
        type: 'script',
        props: {
          children: ['</scr', 'ipt><script data-fict-xss="stream">globalThis.__fictXss=1</script>'],
        },
      }
    }

    const stream = renderToStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'span', props: { children: 'Loading' } },
          children: { type: AsyncChild, props: {} },
        },
      }),
      { mode: 'shell', streamPatchMode: 'observer' },
    )
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    const patch = html.match(/<template data-fict-suspense="[^"]+">([\s\S]*?)<\/template>/)?.[1]
    expect(patch).toBeDefined()

    const { document } = parseHTML(
      `<!doctype html><html><head></head><body>${patch ?? ''}</body></html>`,
    )
    expect(document.querySelector('[data-fict-xss="stream"]')).toBeNull()
  })

  it('aborts and cleans up when a deferred patch contains an invalid DOM name', async () => {
    const token = createSuspenseToken()
    let ready = false
    let destroyed = false
    const errors: unknown[] = []

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      // linkedom permits the invalid name. Returning the already materialized
      // node bypasses runtime VNode validation and exercises the final
      // serializer defense-in-depth boundary.
      return document.createElement('span><script data-fict-xss="deferred">') as unknown as FictNode
    }

    function App(): FictNode {
      onDestroy(() => {
        destroyed = true
      })
      return {
        type: Suspense,
        props: {
          fallback: { type: 'span', props: { children: 'Loading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      fullDocument: false,
      includeSnapshot: false,
      exposeGlobals: true,
      onError(error) {
        errors.push(error)
        throw new Error('DOM name error reporter failed')
      },
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    await expect(readAll).rejects.toThrow('DOM name error reporter failed')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toMatch(/Invalid element name/)
    expect(destroyed).toBe(true)
  })

  it('aborts when a deferred boundary snapshot cannot be serialized', async () => {
    const token = createSuspenseToken()
    const errors: unknown[] = []
    let ready = false
    let destroyed = false

    function InvalidSnapshot(): FictNode {
      const ctx = __fictUseContext()
      __fictUseSignal(ctx, [() => 'not serializable'], { name: 'value' })
      return { type: 'span', props: { children: 'invalid snapshot' } }
    }
    ;(InvalidSnapshot as { __fictMeta?: unknown }).__fictMeta = {
      id: 'DeferredInvalidSnapshot@test',
      resume: 'deferred-invalid-snapshot#resume',
    }

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: InvalidSnapshot, props: {} }
    }

    function App(): FictNode {
      onDestroy(() => {
        destroyed = true
      })
      return {
        type: Suspense,
        props: {
          fallback: { type: 'span', props: { children: 'Loading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      fullDocument: false,
      onError: error => errors.push(error),
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    await expect(withTimeout(readAll, 500, 'deferred snapshot failure')).rejects.toThrow(
      /Cannot serialize function/,
    )
    expect(errors).toHaveLength(1)
    expect(destroyed).toBe(true)
  })

  it('errors the stream and cleans up when a writer and onError callback both throw', () => {
    const NativeReadableStream = globalThis.ReadableStream
    const reported: unknown[] = []
    let streamError: unknown
    let destroyed = false

    class FailingReadableStream {
      constructor(source: UnderlyingSource<Uint8Array>) {
        const controller = {
          desiredSize: 1,
          enqueue() {
            throw new Error('writer failed')
          },
          close() {},
          error(reason: unknown) {
            streamError = reason
          },
        } as unknown as ReadableStreamDefaultController<Uint8Array>
        source.start?.(controller)
      }
    }

    vi.stubGlobal('ReadableStream', FailingReadableStream)
    try {
      expect(() =>
        renderToStream(
          () => {
            onDestroy(() => {
              destroyed = true
            })
            return { type: 'div', props: { children: 'writer failure' } }
          },
          {
            includeSnapshot: false,
            fullDocument: false,
            onError(error) {
              reported.push(error)
              throw new Error('error reporter failed')
            },
          },
        ),
      ).not.toThrow()
    } finally {
      vi.stubGlobal('ReadableStream', NativeReadableStream)
    }

    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('writer failed')
    expect(streamError).toEqual(expect.objectContaining({ message: 'error reporter failed' }))
    expect(destroyed).toBe(true)
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
      streamIdentifierPrefix: 'nonce_test',
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('nonce="nonce-&amp;-&quot;"')
    expect(html).toContain('<script nonce="nonce-&amp;-&quot;">(function(){')
    expect(html).toContain(
      '<script nonce="nonce-&amp;-&quot;">__FICT_STREAM.apply("nonce_test:s1")</script>',
    )
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
      streamIdentifierPrefix: 'observer_test',
    })
    const readAll = readReadableStream(stream)
    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    expect(html).toContain('MutationObserver')
    expect(html).toContain('data-fict-suspense="observer_test:s1"')
    expect(html).toContain('ObserverDone')
    expect(html).not.toContain('__FICT_STREAM.apply(')
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
      streamIdentifierPrefix: 'external_test',
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
    expect(html).toContain('data-fict-suspense="external_test:s1"')
    expect(html).not.toContain('__FICT_STREAM.apply(')
  })

  it('exposes classic stream runtime code for external assets', () => {
    const code = createStreamRuntimeCode({ observerMode: true })

    expect(code).toBe(FICT_STREAM_RUNTIME_CODE)
    expect(code).toContain('(function(){')
    expect(code).toContain('MutationObserver')
    expect(code).toContain('window.__FICT_STREAM')
    expect(code).not.toContain('export ')
  })

  it('keeps observer stream runtime compatible with Trusted Types sinks', () => {
    const code = createStreamRuntimeCode({ observerMode: true })

    expect(code).toContain('tpl.content')
    expect(code).toContain('insertBefore')
    expect(code).not.toMatch(/\binnerHTML\b/)
    expect(code).not.toMatch(/\binsertAdjacentHTML\b/)
    expect(code).not.toMatch(/\beval\s*\(/)
    expect(code).not.toMatch(/\bFunction\s*\(/)
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

  it('keeps a pipeable stream open when one token reveals another token', async () => {
    const first = createSuspenseToken()
    const second = createSuspenseToken()
    let phase = 0

    function AsyncChild(): FictNode {
      if (phase === 0) throw first.token
      if (phase === 1) throw second.token
      return { type: 'span', props: { children: 'ChainedDone' } }
    }

    const { pipe, shellReady, allReady } = renderToPipeableStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ChainedLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }),
      { mode: 'shell' },
    )

    const chunks: Buffer[] = []
    const writable = new PassThrough()
    writable.on('data', chunk => chunks.push(chunk as Buffer))
    const ended = new Promise<void>((resolve, reject) => {
      writable.once('end', resolve)
      writable.once('error', reject)
    })
    pipe(writable)

    await shellReady
    let readiness: 'pending' | 'resolved' | 'rejected' = 'pending'
    void allReady.then(
      () => {
        readiness = 'resolved'
      },
      () => {
        readiness = 'rejected'
      },
    )

    phase = 1
    first.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(readiness).toBe('pending')

    phase = 2
    second.resolve()
    await withTimeout(allReady, 500, 'chained Suspense allReady')
    await withTimeout(ended, 500, 'chained Suspense output stream')

    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain('ChainedLoading')
    expect(html).toContain('ChainedDone')
  })

  it('settles after an outer retry abandons a pending nested boundary', async () => {
    const inner = createSuspenseToken()
    const outer = createSuspenseToken()
    let outerReady = false

    function InnerChild(): FictNode {
      throw inner.token
    }

    function OuterBlocker(): FictNode {
      if (!outerReady) throw outer.token
      return { type: 'span', props: { children: 'OuterDone' } }
    }

    function OuterContent(): FictNode {
      if (outerReady) return { type: 'span', props: { children: 'OuterDone' } }
      return {
        type: 'div',
        props: {
          children: [
            {
              type: Suspense,
              props: {
                fallback: { type: 'span', props: { children: 'InnerLoading' } },
                children: { type: InnerChild, props: {} },
              },
            },
            { type: OuterBlocker, props: {} },
          ],
        },
      }
    }

    const { pipe, shellReady, allReady, abort } = renderToPipeableStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'OuterLoading' } },
          children: { type: OuterContent, props: {} },
        },
      }),
      { mode: 'shell' },
    )
    const chunks: Buffer[] = []
    const writable = new PassThrough()
    writable.on('data', chunk => chunks.push(chunk as Buffer))
    writable.on('error', () => undefined)
    pipe(writable)

    let completed = false
    try {
      await shellReady
      expect(Buffer.concat(chunks).toString('utf8')).toContain('OuterLoading')

      outerReady = true
      outer.resolve()
      await withTimeout(allReady, 500, 'abandoned nested Suspense allReady')
      completed = true

      const html = Buffer.concat(chunks).toString('utf8')
      const streamedDocument = parseHTML(html).document
      const snapshotScopeTypes = Array.from(
        streamedDocument.querySelectorAll('script[data-fict-snapshot]'),
      ).flatMap(script => {
        const snapshot = JSON.parse(script.textContent ?? '') as {
          scopes: Record<string, { t?: string }>
        }
        return Object.values(snapshot.scopes).map(scope => scope.t)
      })
      expect(html).toContain('OuterDone')
      expect(streamedDocument.querySelectorAll('template[data-fict-suspense]')).toHaveLength(1)
      expect(snapshotScopeTypes.sort()).toEqual(['OuterContent', 'Suspense'])
    } finally {
      if (!completed) abort(new Error('abandoned nested Suspense test cleanup'))
    }
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

  // PREVIEW.md degradation row S4 / audit G1 (fixed). A piped sink that errors
  // mid-stream is routed to the render's abort (pipe-bridge `onError`), so
  // `allReady` settles promptly instead of hanging. Regression guard.
  it('aborts the pipeable render when a downstream sink errors', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'SinkDone' } }
    }
    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'SinkLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const { pipe, shellReady, allReady } = renderToPipeableStream(
      () => ({ type: App, props: {} }),
      { mode: 'shell' },
    )
    // shellReady may reject when the sink aborts; we assert on allReady.
    shellReady.catch(() => undefined)

    const { Writable } = await import('node:stream')
    let writes = 0
    let sinkError: unknown
    const failing = new Writable({
      write(_chunk, _enc, cb) {
        writes += 1
        // Accept the shell, then fail every later (post-shell) write.
        cb(writes > 1 ? new Error('sink exploded') : null)
      },
    })
    // Handle the sink's error so it surfaces on the sink, not as an uncaught crash.
    failing.on('error', err => {
      sinkError = err
    })

    pipe(failing)
    await Promise.resolve()
    ready = true
    token.resolve()

    // The downstream sink error is the contract under test: it must be observed,
    // and it must abort the render instead of allowing allReady to resolve.
    await expect(allReady).rejects.toThrow('sink exploded')

    expect(writes).toBeGreaterThan(1)
    expect(sinkError).toBeInstanceOf(Error)
    expect((sinkError as Error).message).toBe('sink exploded')
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

  it.each(['shell', 'all'] as const)(
    'renders an ErrorBoundary fallback when a suspense token rejects in $mode mode',
    async mode => {
      const token = createSuspenseToken()

      function AsyncChild(): FictNode {
        throw token.token
      }

      function App(): FictNode {
        return {
          type: ErrorBoundary,
          props: {
            fallback: { type: 'strong', props: { children: 'HandledReject' } },
            children: {
              type: Suspense,
              props: {
                fallback: { type: 'span', props: { children: 'HandledLoading' } },
                children: { type: AsyncChild, props: {} },
              },
            },
          },
        }
      }

      const stream = renderToStream(() => ({ type: App, props: {} }), {
        mode,
        includeSnapshot: false,
      })
      const readAll = readReadableStream(stream)

      await Promise.resolve()
      token.reject(new Error('handled-reject'))

      const html = await withTimeout(readAll, 500, 'handled rejection stream')
      const window = parseHTML(html) as unknown as Window & {
        __FICT_STREAM?: { apply(id: string): void }
      }
      if (mode === 'all') {
        expect(window.document.body.textContent).toContain('HandledReject')
        expect(window.document.body.textContent).not.toContain('HandledLoading')
        return
      }

      runInNewContext(createStreamRuntimeCode({ observerMode: false }), {
        document: window.document,
        window,
      })
      const patch = Array.from(
        window.document.querySelectorAll('template[data-fict-suspense]'),
      ).find(template => template.content.querySelector('strong')?.textContent === 'HandledReject')

      expect(patch).toBeDefined()
      window.__FICT_STREAM?.apply(patch!.getAttribute('data-fict-suspense')!)
      expect(window.document.body.textContent).toContain('HandledReject')
      expect(window.document.body.textContent).not.toContain('HandledLoading')
    },
  )

  it('aborts a shell stream when Suspense onResolve throws', async () => {
    const token = createSuspenseToken()
    const resolveError = new Error('resolve-hook-boom')
    const errors: unknown[] = []
    let ready = false
    let destroyed = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'ResolveHookDone' } }
    }

    function App(): FictNode {
      onDestroy(() => {
        destroyed = true
      })
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ResolveHookLoading' } },
          onResolve() {
            throw resolveError
          },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), {
      mode: 'shell',
      onError(error) {
        errors.push(error)
      },
    })
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    ready = true
    token.resolve()

    await expect(withTimeout(readAll, 500, 'onResolve stream failure')).rejects.toThrow(
      'resolve-hook-boom',
    )
    expect(errors).toEqual([resolveError])
    expect(destroyed).toBe(true)
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

  it('aborts shell streaming work when the reader cancels', async () => {
    const previousDocument = (globalThis as { document?: Document }).document
    const hadDocument = 'document' in globalThis
    const token = createSuspenseToken()

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'ReaderCancelLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    try {
      const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
      const reader = stream.getReader()
      const first = await reader.read()

      expect(first.done).toBe(false)
      expect(first.value ? decoder.decode(first.value) : '').toContain('ReaderCancelLoading')

      await reader.cancel(new Error('reader-cancel'))

      expect((globalThis as { document?: Document }).document).toBe(previousDocument)
      expect('document' in globalThis).toBe(hadDocument)
    } finally {
      if (!hadDocument) {
        delete (globalThis as { document?: Document }).document
      }
    }
  })

  it('runs streaming teardown before restoring exposed DOM globals', async () => {
    const globals = globalThis as Record<string, unknown>
    const previousDocument = globals.document
    const previousWindow = globals.window
    const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
    const token = createSuspenseToken()
    let cleanupHadDocument = false
    let cleanupHadWindow = false
    let cleanupDocumentCanCreateNodes = false

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      onDestroy(() => {
        const doc = globals.document as Document | undefined
        cleanupHadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
        cleanupHadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
        cleanupDocumentCanCreateNodes = typeof doc?.createElement === 'function'
      })
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'CleanupLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    try {
      delete globals.document
      delete globals.window

      const stream = renderToStream(() => ({ type: App, props: {} }), {
        mode: 'shell',
        exposeGlobals: true,
      })
      const reader = stream.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value ? decoder.decode(first.value) : '').toContain('CleanupLoading')

      await reader.cancel(new Error('cleanup-order'))

      expect(cleanupHadDocument).toBe(true)
      expect(cleanupHadWindow).toBe(true)
      expect(cleanupDocumentCanCreateNodes).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(globals, 'document')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(globals, 'window')).toBe(false)
    } finally {
      if (hadDocument) {
        globals.document = previousDocument
      } else {
        delete globals.document
      }
      if (hadWindow) {
        globals.window = previousWindow
      } else {
        delete globals.window
      }
    }
  })

  it('aborts partial patch rendering when the patch reader cancels', async () => {
    const previousDocument = (globalThis as { document?: Document }).document
    const hadDocument = 'document' in globalThis
    const token = createSuspenseToken()

    function AsyncChild(): FictNode {
      throw token.token
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'PartialCancelLoading' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    try {
      const partial = renderToPartial(() => ({ type: App, props: {} }), {
        fullDocument: true,
        mode: 'shell',
      })
      const allReady = expect(partial.allReady).rejects.toThrow('partial-cancel')
      const reader = partial.stream.getReader()

      expect(partial.shell).toContain('PartialCancelLoading')

      await reader.cancel(new Error('partial-cancel'))
      await allReady

      expect((globalThis as { document?: Document }).document).toBe(previousDocument)
      expect('document' in globalThis).toBe(hadDocument)
    } finally {
      if (!hadDocument) {
        delete (globalThis as { document?: Document }).document
      }
    }
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
