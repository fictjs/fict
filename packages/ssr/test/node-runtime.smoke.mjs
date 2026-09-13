import assert from 'node:assert/strict'
import * as runtime from '@fictjs/runtime'
import * as advanced from '@fictjs/runtime/advanced'
import * as ssr from '@fictjs/ssr'
import { verifyAsyncRuntime } from './async-runtime-contract.mjs'

import { __fictGetCurrentSSRSession } from '@fictjs/runtime/internal'
import { renderToString } from '@fictjs/ssr'

let sessionAfterAwait
const html = renderToString(() => {
  sessionAfterAwait = Promise.resolve().then(() => __fictGetCurrentSSRSession())
  return { type: 'div', props: { children: 'NodeAsyncContextOK' } }
})

assert.match(html, /NodeAsyncContextOK/)
assert.ok(await sessionAfterAwait)
await verifyAsyncRuntime(runtime, advanced, ssr)
