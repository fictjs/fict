import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

for (const format of ['esm', 'cjs']) {
  const runtime =
    format === 'esm'
      ? {
          ...(await import('../packages/runtime/dist/index.js')),
          ...(await import('../packages/runtime/dist/advanced.js')),
        }
      : {
          ...require('../packages/runtime/dist/index.cjs'),
          ...require('../packages/runtime/dist/advanced.cjs'),
        }
  for (const chain of [false, true]) {
    test(`distributed ${format} effects handle pending, arbitrary errors and recovery (chain: ${chain})`, async () => {
      const tokenSource = runtime.createAsyncMemo(() => new Promise(() => {}))
      try {
        for (const reason of [
          undefined,
          new Error('failure'),
          Promise.resolve('error value'),
          tokenSource.state().pending,
        ]) {
          const key = runtime.createSignal(0)
          const events = [],
            errors = []
          let reject
          const request = new Promise((_, no) => {
            reject = no
          })
          const owner = runtime.createRoot(() => {
            runtime.registerErrorHandler(error => {
              errors.push(error)
              return true
            })
            const data = runtime.createAsyncMemo(() => (key() === 0 ? 'ready' : request))
            const middle = runtime.createMemo(() => data())
            const read = chain ? runtime.createMemo(() => middle()) : data
            runtime.createEffect(() => {
              try {
                events.push(read())
              } catch (error) {
                events.push(error)
              }
            })
            return data
          })
          try {
            assert.deepEqual(events, ['ready'])
            key(1)
            await drain()
            assert.equal(events.length, 2)
            assert.equal(events[1], owner.value.state().pending)
            reject(reason)
            await drain()
            assert.equal(events.length, 3)
            assert.equal(events[2], reason)
            assert.deepEqual(errors, [])
            key(0)
            await drain()
            assert.equal(events.length, 4)
            assert.equal(events[3], 'ready')
          } finally {
            owner.dispose()
          }
        }
      } finally {
        tokenSource.dispose()
      }
    })
  }
}
