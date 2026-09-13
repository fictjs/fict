#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
const binding = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target', 'release', 'fict_compiler_napi.node'),
)

test('shared conditional alias graphs have bounded traversal and retain conflicting branches', () => {
  const code = `import {createAsyncMemo} from 'fict/advanced';
    const flag=Math.random()>0.5;
    const v0=createAsyncMemo(()=>1);
    ${Array.from({ length: 48 }, (_, i) => `const v${i + 1}=flag?v${i}:v${i};`).join('\n')}
    export {v48}; export const mixed=flag?v48:1;`
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      `const binding=require(process.argv[1]);
       const result=binding.transformSync({code:process.argv[2],filename:'/shared-aliases.tsx',options:{strictGuarantee:true,optimize:false}});
       process.stdout.write(JSON.stringify(result));`,
      process.env.FICT_COMPILER_NATIVE_PATH ??
        path.join(root, 'target', 'release', 'fict_compiler_napi.node'),
      code,
    ],
    { cwd: root, encoding: 'utf8', timeout: 10000 },
  )
  const compiled = JSON.parse(result)
  assert.deepEqual(compiled.diagnostics, [])
  assert.ok(compiled.code)
  assert.deepEqual(compiled.moduleMetadata.exports, { v48: 'asyncAccessor' })
})

let dom

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  for (const name of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'MathMLElement',
    'Text',
    'Comment',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'Event',
    'CustomEvent',
  ]) {
    if (name in dom.window) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: dom.window[name],
        writable: true,
      })
    }
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
})

after(() => {
  dom.window.close()
})

async function flushRuntime() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function importCompiledModule(code, name) {
  const fixture = path.join(
    root,
    'packages',
    'fict',
    `.native-runtime-rust-${name}-${process.pid}-${Date.now()}.mjs`,
  )
  await writeFile(fixture, code, 'utf8')
  try {
    return await import(`${pathToFileURL(fixture).href}?v=${Date.now()}`)
  } finally {
    await unlink(fixture)
  }
}

const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(options => [true, false].map(fineGrainedDom => ({ ...options, fineGrainedDom })))

function compile(code, options = {}, extra = {}) {
  const result = binding.transformSync({
    code,
    filename: '/fixtures/async-graph.tsx',
    language: 'tsx',
    options: { strictGuarantee: true, dev: false, ...options },
    ...extra,
  })
  assert.deepEqual(
    result.diagnostics.filter(d => d.severity === 'error'),
    [],
    JSON.stringify(result.diagnostics),
  )
  assert.notEqual(result.code, '')
  return result
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

for (const [index, profile] of profiles.entries()) {
  test(`async macro tracks inputs, parks DOM and cancels owned generations (${index})`, async () => {
    const requests = []
    globalThis.__fictAsyncRequest = (id, signal) => {
      const request = { id, signal, ...deferred() }
      requests.push(request)
      return request.promise
    }
    const result = compile(
      `
      import { $async, $state, render, Suspense } from 'fict'
      function Child() {
        let id = $state(1)
        const value = $async(context => globalThis.__fictAsyncRequest(id, context.signal))
        const doubled = value * 2
        return <section><button onClick={() => id++}>next</button><Suspense fallback={<i>loading</i>}><span>{doubled}</span></Suspense></section>
      }
      export const mount = container => render(() => <Child />, container)
    `,
      profile,
    )
    const fixture = await importCompiledModule(result.code, `async-${index}`)
    const container = document.createElement('div')
    document.body.append(container)
    const stop = fixture.mount(container)
    try {
      assert.equal(container.textContent, 'nextloading')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].id, 1)
      requests[0].resolve(10)
      await flushRuntime()
      assert.equal(container.querySelector('span').textContent, '20')
      const button = container.querySelector('button')
      button.click()
      await flushRuntime()
      assert.equal(container.textContent, 'nextloading')
      assert.equal(requests[0].signal.aborted, true)
      assert.equal(requests[1].id, 2)
      button.click()
      await flushRuntime()
      assert.equal(requests[1].signal.aborted, true)
      assert.equal(requests[2].id, 3)
      requests[1].resolve(200)
      await flushRuntime()
      assert.equal(container.textContent, 'nextloading')
      requests[2].resolve(30)
      await flushRuntime()
      assert.equal(container.querySelector('span').textContent, '60')
      assert.equal(container.querySelector('button'), button)
      stop()
      assert.equal(requests[2].signal.aborted, true)
      assert.equal(container.textContent, '')
    } finally {
      stop()
      container.remove()
      delete globalThis.__fictAsyncRequest
    }
  })

  test(`resolved functions and manual async accessor methods keep distinct call semantics (${index})`, async () => {
    const result = compile(
      `
      import { $async } from 'fict'
      import { createAsyncMemo } from 'fict/advanced'
      export const value = $async(() => (n => n + 1))
      export const manual = createAsyncMemo(() => 42)
      export function invoke() { return value(2) }
      export function inspect() { return [manual(), manual.state().status, manual.latest()] }
      export function refresh() { manual.refresh() }
      export function dispose() { manual.dispose() }
    `,
      profile,
    )
    const fixture = await importCompiledModule(result.code, `async-call-${index}`)
    try {
      assert.equal(fixture.invoke(), 3)
      assert.deepEqual(fixture.inspect(), [42, 'ready', 42])
      fixture.refresh()
      assert.deepEqual(fixture.inspect(), [42, 'ready', 42])
      fixture.dispose()
      assert.equal(fixture.manual.state().status, 'disposed')
    } finally {
      fixture.value.dispose()
      fixture.manual.dispose()
    }
  })
}

for (const [index, profile] of profiles.entries()) {
  test(`async aliases preserve reactive function values and accessor identity (${index})`, async () => {
    const result = compile(
      `
      import { $async, $state, render } from 'fict'
      import { createAsyncMemo } from 'fict/advanced'
      export const moduleAccessor = createAsyncMemo(() => 42)
      export const moduleAlias = moduleAccessor
      export const moduleValue = $async(() => 7)
      export const snapshot = moduleValue
      function useRequest() {
        const request = createAsyncMemo(() => 40)
        const alias = request
        return alias
      }
      function App() {
        let id = $state(1)
        const value = $async(() => (n => n + 2))
        const alias = value
        const request = createAsyncMemo(() => id * 10)
        const requestAlias = request
        const hook = useRequest()
        return <button onClick={() => id++}>{alias(3)}:{requestAlias()}:{requestAlias.state().status}:{hook()}</button>
      }
      export const mount = container => render(() => <App />, container)
    `,
      profile,
    )
    assert.equal(result.moduleMetadata.exports.moduleAlias, 'asyncAccessor')
    assert.equal(result.moduleMetadata.exports.snapshot, undefined)
    const fixture = await importCompiledModule(result.code, `async-alias-${index}`)
    const container = document.createElement('div')
    document.body.append(container)
    const stop = fixture.mount(container)
    try {
      assert.equal(fixture.moduleAlias, fixture.moduleAccessor)
      assert.equal(fixture.snapshot, 7)
      assert.equal(container.textContent, '5:10:ready:40')
      container.querySelector('button').click()
      await flushRuntime()
      assert.equal(container.textContent, '5:20:ready:40')
    } finally {
      stop()
      container.remove()
      fixture.moduleAccessor.dispose()
      fixture.moduleValue.dispose()
    }
  })
}

test('async macro and runtime producers retain strict continuation, identity and readonly boundaries', () => {
  const cases = [
    [
      "import {$async,$state} from 'fict';function App(){let n=$state(1);const v=$async(async()=>{await 0;return n});return <b>{v}</b>}",
      'FICT-ASYNC-PRODUCER',
    ],
    ["import {$async} from 'fict';const v=$async(function*(){yield 1})", 'FICT-ASYNC-PRODUCER'],
    ["import {$async} from 'fict';let v=$async(()=>1)", 'FICT-PLACEMENT-ASYNC-CONST'],
    ["import {$async} from 'fict';const v=$async(()=>1, 2)", 'FICT-ASYNC-ARGUMENTS'],
    [
      "import {$async} from 'fict';import {createAsyncMemo} from 'fict/advanced';const v=$async(()=>{const child=createAsyncMemo(()=>Promise.resolve(1));return child()})",
      'FICT-ASYNC-NESTED',
    ],
    ["import {$async} from 'fict';const v=$async(()=>1);v=2", 'FICT-ASYNC-READONLY'],
    ["import {$async} from 'fict';const v=$async(()=>({x:1}));v.x++", 'FICT-M'],
    ["import {$async} from 'fict';const v=$async(()=>({x:1}));delete v.x", 'FICT-M'],
    ["import {$async} from 'fict';const v=$async(()=>1);[v]=[2]", 'FICT-ASYNC-READONLY'],
    ["import * as f from 'fict';const v=f.$async(()=>1)", 'FICT-HIR-MACRO-NAMESPACE'],
    ["import {$async} from 'fict';const v=$async?.(()=>1)", 'FICT-HIR-MACRO-OPTIONAL'],
    ["import {$async} from 'fict';const alias=$async;const v=alias(()=>1)", 'FICT-HIR-MACRO-VALUE'],
    ["import {$async} from 'fict';const v=()=>{$async(()=>1)}", 'FICT-PLACEMENT-ASYNC-OWNER'],
    [
      "import {$async,$state} from 'fict';function App(){let n=$state(1);const v=$async(()=>external(()=>n));return <b>{v}</b>}",
      'FICT-R005',
    ],
    [
      "import {$async,$state} from 'fict';function App(){let n=$state({x:1});const v=$async(()=>external(n));return <b>{v}</b>}",
      'FICT-S002',
    ],
    [
      "import {$state} from 'fict';import {createAsyncMemo} from 'fict/advanced';function App(){let n=$state(1);const v=createAsyncMemo(async()=>{await 0;return n});return <b>{v()}</b>}",
      'FICT-R005',
    ],
    [
      "import {$state} from 'fict';import {createAsyncMemo} from 'foreign';function App(){let n=$state(1);const v=createAsyncMemo(()=>n);return <b>{v()}</b>}",
      'FICT-R005',
    ],
  ]
  for (const [code, expected] of cases) {
    const result = binding.transformSync({
      code,
      filename: '/async-boundary.tsx',
      options: { strictGuarantee: true, dev: false },
    })
    assert.equal(result.code, '', code)
    assert.ok(
      result.diagnostics.some(d => d.code === expected && d.severity === 'error'),
      JSON.stringify(result.diagnostics),
    )
  }
})

for (const [index, profile] of profiles.entries()) {
  test(`async module and hook metadata execute across real ESM modules (${index})`, async () => {
    const dependencyName = `.native-async-dependency-${process.pid}-${index}.mjs`
    const dependencyPath = path.join(root, 'packages', 'fict', dependencyName)
    const dependency = compile(
      `
      import { $async } from 'fict/slim'
      import { createAsyncMemo } from 'fict/advanced'
      export const direct = $async(() => 'module')
      export { direct as renamed }
      export const manual = createAsyncMemo(() => 7)
      export function usePair() {
        const value = $async(() => (n => n * 3))
        const request = createAsyncMemo(() => 5)
        return { value, request }
      }
    `,
      profile,
    )
    assert.deepEqual(dependency.moduleMetadata, {
      version: 1,
      exports: { direct: 'async', renamed: 'async', manual: 'asyncAccessor' },
      hooks: { usePair: { objectProps: { value: 'async', request: 'asyncAccessor' } } },
    })
    const consumer = compile(
      `
      import { render } from 'fict'
      import { direct, renamed, manual, usePair } from './${dependencyName}'
      function App() {
        const pair = usePair()
        return <span>{direct}:{renamed}:{manual()}:{pair.value(2)}:{pair.request()}:{pair.request.state().status}</span>
      }
      export const mount = container => render(() => <App />, container)
    `,
      profile,
      {
        metadata: [
          {
            request: `./${dependencyName}`,
            resolvedId: dependencyPath,
            status: 'resolved',
            metadata: dependency.moduleMetadata,
            fingerprint: `async-${index}`,
          },
        ],
      },
    )
    await writeFile(dependencyPath, dependency.code)
    let library
    let stop
    try {
      const fixture = await importCompiledModule(consumer.code, `async-consumer-${index}`)
      library = await import(pathToFileURL(dependencyPath).href)
      const container = document.createElement('div')
      stop = fixture.mount(container)
      assert.equal(container.textContent, 'module:module:7:6:5:ready')
    } finally {
      stop?.()
      library?.direct.dispose()
      library?.manual.dispose()
      await unlink(dependencyPath)
    }
  })
}

test('CommonJS output keeps async readiness and resolved callable values', async () => {
  const source = `
    import { $async, $memo } from 'fict'
    export const value = $async(() => Promise.resolve(n => n + 1))
    export const ordinary = $memo(() => Promise.resolve(9))
    export function invoke() { return value?.(2) }
  `
  const result = compile(
    source,
    { optimize: true, optimizeLevel: 'full' },
    { moduleKind: 'commonjs' },
  )
  assert.equal(result.moduleMetadata.exports.value, 'async')
  assert.equal(result.moduleMetadata.exports.ordinary, 'memo')
  const filename = path.join(root, 'packages', 'fict', `.native-async-${process.pid}.cjs`)
  await writeFile(filename, result.code)
  let fixture
  try {
    fixture = require(filename)
    assert.ok(fixture.ordinary() instanceof Promise)
    let pending
    try {
      fixture.invoke()
    } catch (error) {
      pending = error
    }
    assert.equal(typeof pending?.then, 'function')
    await pending
    assert.equal(fixture.invoke(), 3)
  } finally {
    fixture?.value.dispose()
    delete require.cache[filename]
    await unlink(filename)
  }
})

test('async producer source maps and explanations identify the authored creation and read', async () => {
  const { sourcePosition, traceGeneratedPosition } =
    await import('./lib/compiler-source-map-semantic-harness.mjs')
  const source = `// 😀 async ownership\nimport { $async } from 'fict'\nexport const value = $async(() => Promise.resolve(41))\nexport const read = () => value + 1\n`
  const result = compile(source, { explain: true, sourcemap: true })
  assert.equal(result.map.sourcesContent[0], source)
  const event = result.explain.events.find(event => event.kind === 'source-async')
  assert.equal(event.name, '$async')
  assert.equal(
    Buffer.from(source).subarray(event.span.start, event.span.end).toString(),
    '$async(() => Promise.resolve(41))',
  )
  const actual = traceGeneratedPosition(result.code, result.map, {
    needle: 'Promise.resolve',
  }).original
  assert.deepEqual(
    actual,
    sourcePosition(source, '/fixtures/async-graph.tsx', { needle: 'Promise.resolve' }),
  )
  assert.ok(result.explain.helpers.includes('asyncMemo'))
})

test('unfrozen resumable serialization rejects async graph slots explicitly', () => {
  const source = `import { $async } from 'fict';export function App(){const value=$async(()=>1);return <button onClick$={()=>console.log(value)}>x</button>}`
  const result = binding.transformSync({
    code: source,
    filename: '/async-preview.tsx',
    options: { strictGuarantee: true, preview: { resumable: true } },
  })
  assert.equal(result.code, '')
  assert.ok(result.diagnostics.some(d => d.code === 'FICT-PREVIEW-ASYNC' && d.severity === 'error'))
})

test('the documented async declaration compiles with default strict guarantees', async () => {
  const docs = await readFile(path.join(root, 'docs/async-declarations.md'), 'utf8')
  const source = docs.match(/```tsx\n([\s\S]*?)\n```/)?.[1]
  assert.ok(source)
  const result = compile(source)
  assert.deepEqual(result.diagnostics, [])
})

for (const [index, profile] of profiles.entries()) {
  test(`async generations create nested computations without a render hook context (${index})`, async () => {
    const result = compile(
      `
      import { $async, $state, $memo, onCleanup, render } from 'fict'
      export const trace = []
      function App() {
        let id = $state(1)
        const value = $async(() => {
          const doubled = $memo(() => id * 2)
          onCleanup(() => trace.push('cleanup'))
          return doubled
        })
        return <button onClick={() => id++}>{value}</button>
      }
      export const mount = container => render(() => <App />, container)
    `,
      profile,
    )
    const fixture = await importCompiledModule(result.code, `async-generation-${index}`)
    const container = document.createElement('div')
    document.body.append(container)
    const stop = fixture.mount(container)
    try {
      assert.equal(container.textContent, '2')
      container.querySelector('button').click()
      await flushRuntime()
      assert.equal(container.textContent, '4')
      assert.deepEqual(fixture.trace, ['cleanup'])
      stop()
      assert.deepEqual(fixture.trace, ['cleanup', 'cleanup'])
    } finally {
      stop()
      container.remove()
    }
  })
}

for (const [index, profile] of profiles.entries()) {
  test(`intact runtime import aliases retain async accessor reactivity (${index})`, async () => {
    const result = compile(
      `
      import { $state, render } from 'fict'
      import * as runtime from 'fict/advanced'
      const make = runtime.createAsyncMemo
      function App() {
        let id = $state(1)
        const request = make(() => id * 3)
        return <button onClick={() => id++}>{request()}:{request.state().status}</button>
      }
      export const mount = container => render(() => <App />, container)
    `,
      profile,
    )
    const fixture = await importCompiledModule(result.code, `async-import-${index}`)
    const container = document.createElement('div')
    document.body.append(container)
    const stop = fixture.mount(container)
    try {
      assert.equal(container.textContent, '3:ready')
      container.querySelector('button').click()
      await flushRuntime()
      assert.equal(container.textContent, '6:ready')
    } finally {
      stop()
      container.remove()
    }
  })
}

for (const [index, profile] of profiles.entries()) {
  test(`conditional async accessor and function aliases keep their materialized ABI (${index})`, async () => {
    const result = compile(
      `
      import { $async, $state, render } from 'fict'
      import { createAsyncMemo } from 'fict/advanced'
      export const record = $async(() => ({ n: 7, method() { return this.n } }))
      export const fieldSnapshot = record.n
      export const manual = createAsyncMemo(() => 1)
      export const statusSnapshot = manual.state()
      export const selectedModule = true ? manual : manual
      export const orModule = manual || manual
      export const andModule = manual && manual
      export const nullishModule = manual ?? manual
      export function useChoice() {
        let flag = $state(true)
        const first = createAsyncMemo(() => 1)
        const second = createAsyncMemo(() => 2)
        const selected = flag ? first : second
        const alias = selected
        return { alias, toggle() { flag = !flag } }
      }
      function App() {
        let flag = $state(true)
        const choice = useChoice()
        const first = $async(() => (x => x + 1))
        const second = $async(() => (x => x + 2))
        const selected = flag ? first : second
        const alias = selected
        return <button onClick={() => {flag = !flag; choice.toggle()}}>{alias(3)}:{choice.alias()}:{choice.alias.state().status}:{record.method()}</button>
      }
      export const mount = container => render(() => <App />, container)
    `,
      profile,
    )
    assert.equal(result.moduleMetadata.exports.fieldSnapshot, undefined)
    assert.equal(result.moduleMetadata.exports.statusSnapshot, undefined)
    assert.equal(result.moduleMetadata.exports.selectedModule, 'asyncAccessor')
    for (const name of ['orModule', 'andModule', 'nullishModule']) {
      assert.equal(result.moduleMetadata.exports[name], 'asyncAccessor')
    }
    assert.equal(result.moduleMetadata.hooks.useChoice.objectProps.alias, 'async')
    const fixture = await importCompiledModule(result.code, `async-selection-${index}`)
    const container = document.createElement('div')
    document.body.append(container)
    const stop = fixture.mount(container)
    try {
      assert.equal(fixture.fieldSnapshot, 7)
      assert.equal(fixture.statusSnapshot.status, 'ready')
      assert.equal(fixture.selectedModule, fixture.manual)
      for (const name of ['orModule', 'andModule', 'nullishModule']) {
        assert.equal(fixture[name], fixture.manual)
      }
      assert.equal(container.textContent, '4:1:ready:7')
      container.querySelector('button').click()
      await flushRuntime()
      assert.equal(container.textContent, '5:2:ready:7')
    } finally {
      stop()
      container.remove()
      fixture.record.dispose()
      fixture.manual.dispose()
    }
  })
}
