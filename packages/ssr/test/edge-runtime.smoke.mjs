import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function assertEdgeGraphHasNoAsyncHooks(entryUrl) {
  const pending = [entryUrl]
  const visited = new Set()

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current.href)) continue
    visited.add(current.href)
    const source = readFileSync(current, 'utf8')
    assert.doesNotMatch(source, /node:async_hooks/, `${current.pathname} imports node:async_hooks`)

    const staticImport = /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g
    let match
    while ((match = staticImport.exec(source))) {
      pending.push(new URL(match[1], current))
    }
  }
}

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
  assertEdgeGraphHasNoAsyncHooks(new URL('../dist/index.js', import.meta.url))
  assertEdgeGraphHasNoAsyncHooks(new URL('../dist/experimental.js', import.meta.url))

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
