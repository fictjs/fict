import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const native = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const runtime = require(path.join(root, 'packages/runtime/dist/index.cjs'))
const internal = require(path.join(root, 'packages/runtime/dist/internal.cjs'))
const ssr = require(path.join(root, 'packages/ssr/dist/index.node.cjs'))
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const source = readme.split('### Async data fetching\n')[1]?.match(/```tsx\n([\s\S]*?)\n```/)?.[1]
assert.ok(source, 'The README async example must remain executable')

for (const optimizeLevel of ['disabled', 'safe', 'full'])
  for (const fineGrainedDom of [true, false]) {
    test(`README async example owns successful and rejected requests: ${optimizeLevel}, DOM=${fineGrainedDom}`, async () => {
      const result = native.transformSync({
        code: source + '\nexport { UserProfile }',
        filename: '/readme-async.tsx',
        moduleKind: 'commonjs',
        options: {
          dev: false,
          strictGuarantee: true,
          optimize: optimizeLevel !== 'disabled',
          optimizeLevel: optimizeLevel === 'full' ? 'full' : 'safe',
          fineGrainedDom,
        },
      })
      assert.ok(result.code, JSON.stringify(result.diagnostics))
      assert.ok(
        result.diagnostics.every(d => d.guaranteeClass === 'advisory'),
        JSON.stringify(result.diagnostics),
      )
      assert.match(result.code, /__fictUseAsyncMemo/)
      const module = { exports: {} }
      new Function('require', 'module', 'exports', result.code)(
        name => {
          if (name === 'fict') return runtime
          if (name === 'fict/internal') return internal
          throw new Error(`Unexpected dependency ${name}`)
        },
        module,
        module.exports,
      )
      const previousFetch = globalThis.fetch
      try {
        for (const ok of [true, false]) {
          const requests = []
          globalThis.fetch = async (url, options) => {
            requests.push({ url, signal: options.signal })
            return { ok, status: ok ? 200 : 503, json: async () => ({ name: 'Alice' }) }
          }
          const html = await ssr.renderToStringAsync(() => ({
            type: module.exports.UserProfile,
            props: {},
          }))
          assert.match(html, ok ? /Alice/ : /Request failed: 503/)
          assert.equal(requests.length, 1)
          assert.equal(requests[0].url, '/api/user/1')
          assert.ok(requests[0].signal instanceof AbortSignal)
          assert.equal(
            requests[0].signal.aborted,
            true,
            'The completed SSR request releases transport ownership',
          )
        }
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  }
