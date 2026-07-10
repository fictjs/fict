import assert from 'node:assert/strict'

import { __fictGetCurrentSSRSession } from '@fictjs/runtime/internal'
import { renderToString } from '@fictjs/ssr'

let sessionAfterAwait
const html = renderToString(() => {
  sessionAfterAwait = Promise.resolve().then(() => __fictGetCurrentSSRSession())
  return { type: 'div', props: { children: 'NodeAsyncContextOK' } }
})

assert.match(html, /NodeAsyncContextOK/)
assert.ok(await sessionAfterAwait)
