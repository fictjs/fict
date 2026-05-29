import assert from 'node:assert/strict'

import { Suspense, createSuspenseToken } from '../../runtime/dist/index.js'
import { renderToStream, renderToString } from '../dist/index.js'
import { renderToPartial } from '../dist/experimental.js'

async function readReadableStream(stream) {
  const decoder = new TextDecoder()
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

async function run() {
  const streamHtml = await readReadableStream(
    renderToStream(
      () => ({
        type: 'div',
        props: { children: 'EdgeStreamOK' },
      }),
      {
        fullDocument: true,
        manifest: { 'file:///app.tsx': '/assets/app.js' },
      },
    ),
  )
  assert.match(streamHtml, /EdgeStreamOK/)

  const token = createSuspenseToken()
  let ready = false

  function AsyncChild() {
    if (!ready) throw token.token
    return { type: 'span', props: { children: 'EdgePartialDone' } }
  }

  function App() {
    return {
      type: Suspense,
      props: {
        fallback: { type: 'div', props: { children: 'EdgePartialLoading' } },
        children: { type: AsyncChild, props: {} },
      },
    }
  }

  const partial = renderToPartial(() => ({ type: App, props: {} }), {
    mode: 'shell',
    fullDocument: true,
  })

  assert.match(partial.shell, /EdgePartialLoading/)
  const patchRead = readReadableStream(partial.stream)
  ready = true
  token.resolve()
  const patches = await patchRead
  assert.match(patches, /EdgePartialDone/)

  assert.throws(
    () =>
      renderToString(
        () => ({
          type: 'div',
          props: { children: 'ManifestPathFail' },
        }),
        { manifest: '/tmp/fict-manifest.json' },
      ),
    /manifest.*file path.*CommonJS require/i,
  )
}

run().catch(error => {
  console.error('[edge-runtime.smoke] failed:', error)
  process.exitCode = 1
})
