import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const native = require('../target/release/fict_compiler_napi.node')
const { build } = createRequire(require.resolve('@size-limit/esbuild'))('esbuild')
const { renderToPipeableStream } = await import('../packages/ssr/dist/index.node.js')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test(
  'production browser hands a streamed async graph to hydration and owns future work',
  { timeout: 90_000 },
  async () => {
    const temporary = await mkdtemp(path.join(root, 'packages/fict/.native-async-browser-'))
    let browser, server
    const streams = []
    const pending = new Map()
    const errors = []
    const fixturePath = path.join(root, 'scripts/fixtures/async-ssr/App.tsx')
    const source = await readFile(fixturePath, 'utf8')
    const compile = (code, filename) => {
      const result = native.transformSync({
        code,
        filename,
        options: {
          dev: false,
          strictGuarantee: true,
          optimize: true,
          optimizeLevel: 'full',
        },
      })
      assert.ok(result.code, JSON.stringify(result.diagnostics))
      assert.deepEqual(
        result.diagnostics.filter(d => d.severity === 'error'),
        [],
      )
      return result.code
    }
    try {
      await writeFile(path.join(temporary, 'App.mjs'), compile(source, fixturePath))
      const fixture = await import(pathToFileURL(path.join(temporary, 'App.mjs')).href)
      const client = `
      import { hydrate } from 'fict'
      import { App, signals, cleanups } from './App.mjs'
      function start() {
        const container = document.getElementById('app')
        const data = JSON.parse(document.getElementById('app-data').textContent)
        const serverNode = container.querySelector('[data-value]')
        window.hydrationHTML = container.innerHTML
        window.hydrationIssues = []
        let resolve, reject
        const request = () => new Promise((yes, no) => { resolve = yes; reject = no })
        const stop = hydrate(() => <App input={data.value} request={request}/>, container, {
          strictHydration:true, onHydrationIssue:issue => window.hydrationIssues.push({code:issue.code,expected:issue.expected,actual:issue.actual})
        })
        window.asyncProbe = {serverNode, signals, cleanups, stop, name:App.name,
          resolve: value => resolve(value), reject: value => reject(value),
          reused: serverNode === container.querySelector('[data-value]')}
      }
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true})
      else start()
    `
      await writeFile(
        path.join(temporary, 'client.mjs'),
        compile(client, path.join(temporary, 'client.tsx')),
      )
      const bundle = await build({
        entryPoints: [path.join(temporary, 'client.mjs')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        minify: true,
        target: 'es2022',
        tsconfigRaw: { compilerOptions: {} },
        metafile: true,
        define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
      })
      assert.ok(
        Object.keys(bundle.metafile.inputs).some(name => name.includes('packages/runtime/dist/')),
      )
      assert.ok(
        !Object.keys(bundle.metafile.inputs).some(name =>
          /packages\/(?:runtime|fict)\/src\//.test(name),
        ),
      )
      server = createServer((req, res) => {
        if (req.url === '/client.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript' })
          res.end(bundle.outputFiles[0].text)
          return
        }
        const tenant = req.url?.match(/^\/page\/([ABC])$/)?.[1]
        if (!tenant) {
          res.writeHead(404)
          res.end()
          return
        }
        const input = deferred()
        pending.set(tenant, input)
        const data = JSON.stringify({ value: `tenant-${tenant}-private` }).replaceAll(
          '<',
          '\\u003c',
        )
        const html = `<!doctype html><html><head><script type="module" src="/client.js"></script></head><body><script type="application/json" id="app-data">${data}</script></body></html>`
        const stream = renderToPipeableStream(
          () => ({ type: fixture.App, props: { input: input.promise } }),
          {
            mode: 'shell',
            fullDocument: true,
            html,
            containerId: 'app',
            includeContainer: true,
            includeSnapshot: false,
          },
        )
        streams.push(stream)
        void stream.shellReady.catch(() => {})
        void stream.allReady.catch(() => {})
        res.once('close', () => {
          if (!res.writableEnded) stream.abort(new Error('client disconnected'))
        })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        stream.pipe(res)
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${server.address().port}`
      browser = await chromium.launch({ headless: true })
      const a = await browser.newPage(),
        b = await browser.newPage(),
        c = await browser.newPage()
      for (const page of [a, b, c])
        page.on('pageerror', error => {
          errors.push(String(error))
          console.error(error.stack)
        })
      await Promise.all([
        a.goto(`${origin}/page/A`, { waitUntil: 'commit' }),
        b.goto(`${origin}/page/B`, { waitUntil: 'commit' }),
      ])
      await Promise.all([
        a.locator('[data-pending]').waitFor(),
        b.locator('[data-pending]').waitFor(),
      ])
      assert.equal(await a.evaluate(() => !!window.asyncProbe), false)
      assert.equal(await b.evaluate(() => !!window.asyncProbe), false)
      pending.get('B').resolve('tenant-B-private')
      await b.waitForFunction(() => !!window.asyncProbe || window.hydrationIssues?.length)
      assert.deepEqual(
        await b.evaluate(() => window.hydrationIssues),
        [],
        await b.evaluate(() => window.hydrationHTML),
      )
      assert.equal(await b.locator('[data-value]').textContent(), 'tenant-B-private')
      assert.equal(await b.evaluate(() => window.asyncProbe.reused), true)
      assert.notEqual(await b.evaluate(() => window.asyncProbe.name), fixture.App.name)
      assert.equal(await a.locator('[data-pending]').textContent(), 'Loading')
      pending.get('A').resolve('tenant-A-private')
      await a.waitForFunction(() => !!window.asyncProbe)
      assert.equal(await a.locator('[data-value]').textContent(), 'tenant-A-private')
      assert.equal(await a.evaluate(() => window.asyncProbe.reused), true)
      for (const page of [a, b]) {
        assert.equal(await page.locator('template[data-fict-suspense]').count(), 0)
        assert.equal(await page.locator('script[id^="__FICT_SNAPSHOT__"]').count(), 0)
      }
      await b.getByRole('button', { name: 'Refresh' }).click()
      await b.locator('[data-pending]').waitFor()
      await b.evaluate(() => window.asyncProbe.resolve('client-B-refreshed'))
      await b.waitForFunction(
        () => document.querySelector('[data-value]')?.textContent === 'client-B-refreshed',
      )
      assert.equal(
        await b.evaluate(
          () => document.querySelector('[data-value]') === window.asyncProbe.serverNode,
        ),
        true,
      )
      await b.getByRole('button', { name: 'Refresh' }).click()
      await b.evaluate(() => window.asyncProbe.reject('client-B-failure'))
      await b.locator('[data-error]').waitFor()
      assert.equal(await b.locator('[data-error]').textContent(), 'client-B-failure')
      await a.getByRole('button', { name: 'Refresh' }).click()
      await a.locator('[data-pending]').waitFor()
      await a.evaluate(() => {
        window.asyncProbe.stop()
        window.asyncProbe.resolve('obsolete')
      })
      assert.equal(await a.locator('#app').textContent(), '')
      assert.equal(
        await a.evaluate(() => window.asyncProbe.signals.every(signal => signal.aborted)),
        true,
      )
      await c.goto(`${origin}/page/C`, { waitUntil: 'commit' })
      await c.locator('[data-pending]').waitFor()
      const lastSignal = fixture.signals.at(-1)
      assert.equal(lastSignal.aborted, false)
      await c.goto('about:blank')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(lastSignal.aborted, true)
      pending.get('C').resolve('abandoned-tenant-C-private')
      await b.evaluate(() => window.asyncProbe.stop())
      assert.equal(await b.locator('#app').textContent(), '')
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify({
          browser: 'chromium',
          profiles: 'full/strict/templates',
          tenants: 3,
          hydration: 'server node identity preserved',
          client: 'minified distributed modules',
          cases: [
            'shell-first',
            'out-of-order requests',
            'refresh',
            'error',
            'unmount',
            'disconnect',
          ],
        }),
      )
    } finally {
      for (const stream of streams) stream.abort()
      await browser?.close()
      if (server) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
      await rm(temporary, { recursive: true, force: true })
    }
  },
)
