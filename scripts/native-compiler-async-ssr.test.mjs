import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import { writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'package.json'))
const native = require(path.join(root, 'target/release/fict_compiler_napi.node'))
const ssr = await import(pathToFileURL(path.join(root, 'packages/ssr/dist/index.node.js')))
const files = []
after(async () => {
  await Promise.all(files.map(file => unlink(file)))
})

async function compile(source, profile = {}, minify = false) {
  const filename = path.join(
    root,
    `packages/fict/.native-async-server-${process.pid}-${files.length}.mjs`,
  )
  const result = native.transformSync({
    code: source,
    filename: filename.replace(/\.mjs$/, '.tsx'),
    options: { strictGuarantee: true, dev: false, ...profile },
  })
  assert.ok(result.code, JSON.stringify(result.diagnostics))
  assert.ok(
    !result.diagnostics.some(d => d.severity === 'error'),
    JSON.stringify(result.diagnostics),
  )
  files.push(filename)
  const code = minify
    ? (
        await createRequire(require.resolve('@size-limit/esbuild'))('esbuild').transform(
          result.code,
          {
            minify: true,
            format: 'esm',
            target: 'es2022',
          },
        )
      ).code
    : result.code
  await writeFile(filename, code)
  return import(pathToFileURL(filename).href)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function readRest(reader) {
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

const source = `
  import { $async, Suspense, ErrorBoundary, onCleanup } from 'fict'
  export const signals = []
  export const cleanups = []
  export function App(props) {
    const value = $async(context => {
      signals.push(context.signal)
      onCleanup(() => cleanups.push(context.signal.aborted))
      return props.input
    })
    return <ErrorBoundary fallback={error => <em>{String(error)}</em>}>
      <Suspense fallback={<i>pending</i>}><b>{value}</b></Suspense>
    </ErrorBoundary>
  }
`

for (const [index, profile] of [
  { optimize: false },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
  { optimize: false, fineGrainedDom: false },
  { optimize: true, optimizeLevel: 'safe', fineGrainedDom: false },
  { optimize: true, optimizeLevel: 'full', fineGrainedDom: false },
].entries()) {
  test(`explicit async graph resolves in SSR and disposes its generation (${index})`, async () => {
    const fixture = await compile(source, profile)
    const html = await ssr.renderToStringAsync(() => ({
      type: fixture.App,
      props: { input: Promise.resolve('resolved') },
    }))
    assert.match(html, /<b><!--fict:child-start-->resolved<!--fict:child--><\/b>/)
    assert.doesNotMatch(html, /<i>pending/)
    assert.equal(fixture.signals.length, 1)
    assert.deepEqual(fixture.cleanups, [true])
    assert.doesNotMatch(html, /__FICT_SNAPSHOT__|async-pending|AbortController/)
  })
}

test('overlapping streams settle out of order without leaking request values', async () => {
  const fixture = await compile(source)
  const a = deferred(),
    b = deferred()
  const start = input =>
    ssr
      .renderToStream(() => ({ type: fixture.App, props: { input } }), {
        mode: 'shell',
        fullDocument: false,
      })
      .getReader()
  const left = start(a.promise),
    right = start(b.promise)
  const [aShell, bShell] = await Promise.all([left.read(), right.read()])
  assert.match(new TextDecoder().decode(aShell.value), /pending/)
  assert.match(new TextDecoder().decode(bShell.value), /pending/)
  b.resolve('tenant-B-private')
  const bBody = await readRest(right)
  assert.match(bBody, /tenant-B-private/)
  assert.doesNotMatch(bBody, /tenant-A-private/)
  a.resolve('tenant-A-private')
  const aBody = await readRest(left)
  assert.match(aBody, /tenant-A-private/)
  assert.doesNotMatch(aBody, /tenant-B-private/)
  assert.deepEqual(fixture.cleanups, [true, true])
})

test('abandoning a stream aborts its owned generation and ignores late transport completion', async () => {
  const fixture = await compile(source)
  const pending = deferred()
  const reader = ssr
    .renderToStream(() => ({ type: fixture.App, props: { input: pending.promise } }), {
      mode: 'shell',
    })
    .getReader()
  await reader.read()
  assert.equal(fixture.signals[0].aborted, false)
  await reader.cancel('client left')
  assert.equal(fixture.signals[0].aborted, true)
  assert.deepEqual(fixture.cleanups, [true])
  pending.resolve('obsolete-private-value')
  const next = await ssr.renderToStringAsync(() => ({
    type: fixture.App,
    props: { input: 'new-request' },
  }))
  assert.match(next, /new-request/)
  assert.doesNotMatch(next, /obsolete-private-value/)
})

test('current async rejection reaches the server error boundary', async () => {
  const fixture = await compile(source)
  const pending = deferred()
  const response = ssr.renderToStringAsync(() => ({
    type: fixture.App,
    props: { input: pending.promise },
  }))
  pending.reject('request-failed')
  const html = await response
  assert.match(html, /<em>request-failed/)
  assert.doesNotMatch(html, /<i>pending/)
  assert.deepEqual(fixture.cleanups, [true])
})

test('SSR takes the first stream value and closes its iterator with the request', async () => {
  const fixture = await compile(source)
  let returned = 0,
    reads = 0
  const input = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return ++reads === 1
        ? Promise.resolve({ value: 'first-value', done: false })
        : new Promise(() => {})
    },
    return() {
      returned++
      return Promise.resolve({ done: true })
    },
  }
  const html = await ssr.renderToStringAsync(() => ({ type: fixture.App, props: { input } }))
  assert.match(html, /first-value/)
  assert.equal(returned, 1)
  assert.deepEqual(fixture.cleanups, [true])
})

const hydrationSource = `
  import {$async,$state,Suspense,onCleanup} from 'fict'
  export const signals = []
  export const cleanups = []
  function Label(props) { return <span>{props.value}</span> }
  export function App(props) {
    let input = $state(props.input)
    const value = $async(context => {
      signals.push(context.signal)
      onCleanup(() => cleanups.push(context.signal.aborted))
      return input
    })
    return <section><button onClick={() => input = Promise.resolve('refreshed')}>Refresh</button>
      <Suspense fallback={<i>pending</i>}><Label value={value}/></Suspense>
    </section>
  }
`

async function withClientDom(html, run) {
  const { JSDOM } = require(path.join(root, 'packages/runtime/node_modules/jsdom'))
  const dom = new JSDOM(`<div id="app">${html}</div>`, { url: 'http://localhost/' })
  const prior = new Map()
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Text',
    'Comment',
  ]) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: dom.window[name],
    })
  }
  const cleanups = []
  try {
    const { hydrate: hydrateView } = await import(
      pathToFileURL(path.join(root, 'packages/runtime/dist/index.js'))
    )
    const container = dom.window.document.querySelector('#app')
    const hydrate = (App, input = 'resolved', options = { strictHydration: true }) => {
      const stop = hydrateView(() => ({ type: App, props: { input } }), container, options)
      cleanups.push(stop)
      return stop
    }
    await run({ container, hydrate, window: dom.window })
  } finally {
    try {
      for (const stop of cleanups.reverse()) stop()
    } finally {
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
      dom.window.close()
    }
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('Core async slots reject accidental Preview snapshot serialization', async () => {
  const fixture = await compile(source)
  await assert.rejects(
    ssr.renderToStringAsync(() => ({ type: fixture.App, props: { input: 'resolved' } }), {
      includeSnapshot: true,
    }),
    /Preview snapshots cannot serialize async graph slots/,
  )
  assert.ok(fixture.signals.every(signal => signal.aborted))
})

for (const fineGrainedDom of [true, false]) {
  test(`async prop consumers retain namespace fallback reactivity (templates=${fineGrainedDom})`, async () => {
    const fixture = await compile(
      `
      import {$async,$state,Suspense} from 'fict'
      function Value(props){return <span>{props.value}</span>}
      export function App(){
        let count=$state(0)
        const value=$async(()=>count===0?'first':Promise.resolve('second'))
        return <div><button onClick={()=>count++}>Change</button>
          <Suspense fallback={<i>pending</i>}><svg><Value value={value}/></svg></Suspense>
        </div>
      }
    `,
      { fineGrainedDom, optimize: true, optimizeLevel: 'full' },
    )
    await withClientDom('', async ({ container }) => {
      const { render } = await import(
        pathToFileURL(path.join(root, 'packages/runtime/dist/index.js'))
      )
      const stop = render(() => ({ type: fixture.App, props: {} }), container)
      try {
        const span = container.querySelector('span')
        assert.equal(span.namespaceURI, 'http://www.w3.org/2000/svg')
        assert.equal(span.textContent, 'first')
        container.querySelector('button').click()
        await tick()
        assert.equal(container.querySelector('span'), span)
        assert.equal(span.textContent, 'second')
      } finally {
        stop()
      }
    })
  })
}
for (const fineGrainedDom of [true, false]) {
  test(`eager hydration reuses nested server DOM across independent minification (templates=${fineGrainedDom})`, async () => {
    const profile = { fineGrainedDom, optimize: true, optimizeLevel: 'full' }
    const server = await compile(hydrationSource, profile)
    const client = await compile(hydrationSource, profile, true)
    assert.notEqual(server.App.name, client.App.name)
    const html = await ssr.renderToStringAsync(() => ({
      type: server.App,
      props: { input: Promise.resolve('resolved') },
    }))
    await withClientDom(html, async ({ container, hydrate }) => {
      const span = container.querySelector('span'),
        button = container.querySelector('button')
      const stop = hydrate(client.App)
      assert.equal(container.querySelector('span'), span)
      assert.equal(container.querySelector('button'), button)
      assert.equal(span.textContent, 'resolved')
      button.click()
      await tick()
      assert.equal(container.querySelector('span'), span)
      assert.equal(span.textContent, 'refreshed')
      stop()
      assert.ok(client.signals.every(signal => signal.aborted))
      assert.deepEqual(client.cleanups, [true, true])
    })
  })

  test(`initial client pending parks server content and disposes abandoned generations (templates=${fineGrainedDom})`, async () => {
    const fixture = await compile(hydrationSource, { fineGrainedDom })
    const html = await ssr.renderToStringAsync(() => ({
      type: fixture.App,
      props: { input: 'resolved' },
    }))
    const pending = deferred()
    await withClientDom(html, async ({ container, hydrate }) => {
      const span = container.querySelector('span')
      const stop = hydrate(fixture.App, pending.promise)
      assert.equal(container.querySelector('i')?.textContent, 'pending')
      assert.equal(span.isConnected, false)
      pending.resolve('resolved')
      await tick()
      assert.equal(container.querySelector('span'), span)
      assert.equal(span.textContent, 'resolved')
      assert.equal(container.querySelector('i'), null)
      stop()
      assert.ok(fixture.signals.every(signal => signal.aborted))
    })
  })
}

for (const strictHydration of [true, false]) {
  test(`malformed server boundary ${strictHydration ? 'fails closed' : 'repairs its owning component'}`, async () => {
    const fixture = await compile(hydrationSource)
    const html = (
      await ssr.renderToStringAsync(() => ({ type: fixture.App, props: { input: 'resolved' } }))
    ).replace(/<!--fict:suspense-end:[^>]+-->/, '')
    await withClientDom(html, async ({ container, hydrate }) => {
      const issues = []
      const start = () =>
        hydrate(fixture.App, 'resolved', {
          strictHydration,
          onHydrationIssue: issue => issues.push(issue),
        })
      if (strictHydration) {
        assert.throws(start, /Missing or unbalanced server Suspense markers/)
        assert.ok(fixture.signals.every(signal => signal.aborted))
      } else {
        start()
        assert.equal(container.querySelector('span')?.textContent, 'resolved')
        container.querySelector('button').click()
        await tick()
        assert.equal(container.querySelector('span')?.textContent, 'refreshed')
      }
      assert.equal(issues.length, 1)
      assert.equal(issues[0].code, 'node_type_mismatch')
    })
  })
}
