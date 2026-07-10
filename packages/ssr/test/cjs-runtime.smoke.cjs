const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const { Suspense, createSuspenseToken } = require('../../runtime/dist/index.cjs')
const { __fictGetCurrentSSRSession } = require('../../runtime/dist/internal.cjs')
const { renderToPipeableStream, renderToString } = require('..')

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'fict-ssr-cjs-'))

  try {
    let sessionAfterAwait
    const asyncContextHtml = renderToString(() => {
      sessionAfterAwait = Promise.resolve().then(() => __fictGetCurrentSSRSession())
      return { type: 'div', props: { children: 'CJSAsyncContextOK' } }
    })
    assert.match(asyncContextHtml, /CJSAsyncContextOK/)
    assert.ok(await sessionAfterAwait)

    const manifestPath = path.join(tempDir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ '/src/app.tsx': '/assets/app.js' }))

    const html = renderToString(() => ({ type: 'div', props: { children: 'CJSManifestOK' } }), {
      manifest: manifestPath,
    })
    assert.match(html, /CJSManifestOK/)

    const token = createSuspenseToken()
    function Pending() {
      throw token.token
    }

    const stream = renderToPipeableStream(
      () => ({
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'CJSAbortPending' } },
          children: { type: Pending, props: {} },
        },
      }),
      { mode: 'shell' },
    )

    const sink = new PassThrough()
    let sinkError
    sink.resume()
    sink.on('error', error => {
      sinkError = error
    })

    stream.pipe(sink)
    const abortReason = new Error('cjs-manual-abort')
    stream.abort(abortReason)

    await assert.rejects(stream.allReady, /cjs-manual-abort/)
    await stream.shellReady.catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))

    // The Node build aborts its internal source. It must neither crash on the
    // source's error event nor misroute that internal error to the user's sink.
    assert.equal(sinkError, undefined)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error('[cjs-runtime.smoke] failed:', error)
  process.exitCode = 1
})
