import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'
import { executeCommonJs } from './lib/compiler-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const binding = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(options => [true, false].map(fineGrainedDom => ({ ...options, fineGrainedDom })))

const source = `
import { $state, render, untrack, onDestroy } from 'fict'
let cleaned = 0
function Label(props: { value: number, fn: () => number, same: () => number }) {
  onDestroy(() => cleaned++)
  return <output id="prop">{props.value * 10}:{props.fn === props.same ? 'same' : 'changed'}</output>
}
function Identity(props: { actual: () => number, children: () => number }) {
  return <output id="identity">{props.actual === props.children ? 'same' : 'changed'}</output>
}
function NumericChildren(props: { children: number }) {
  return <output id="children">{props.children * 100}</output>
}
function App() {
  let count = $state(0)
  let show = $state(true)
  const read = () => count
  function second() { return read() + 1 }
  const alias = second
  const snapshot = () => untrack(() => count)
  return <div>
    <button id="inc" onClick={() => count++}>increment</button>
    <button id="toggle" onClick={() => show = !show}>toggle</button>
    <output id="branch">{show ? read() : 'hidden'}</output>
    {show && <section>
      <span id="read" title={String(read())}>{read()}</span>
      <span id="alias">{alias()}</span>
      <span id="snapshot">{snapshot()}</span>
      {read() > 0 && <b id="positive">positive</b>}
      <Label value={second()} fn={read} same={read} />
      <NumericChildren>{read()}</NumericChildren>
      <Identity actual={read}>{read}</Identity>
    </section>}
  </div>
}
export function mount(root) { return render(() => <App />, root) }
export function observe() {
  return {
    read: document.querySelector('#read')?.textContent ?? null,
    branch: document.querySelector('#branch')?.textContent ?? null,
    title: document.querySelector('#read')?.getAttribute('title') ?? null,
    alias: document.querySelector('#alias')?.textContent ?? null,
    snapshot: document.querySelector('#snapshot')?.textContent ?? null,
    positive: !!document.querySelector('#positive'),
    prop: document.querySelector('#prop')?.textContent ?? null,
    identity: document.querySelector('#identity')?.textContent ?? null,
    children: document.querySelector('#children')?.textContent ?? null,
    cleaned,
  }
}
`
const visible = (read, snapshot, cleaned = 0) => ({
  read: String(read),
  branch: String(read),
  title: String(read),
  alias: String(read + 1),
  snapshot: String(snapshot),
  positive: read > 0,
  prop: `${(read + 1) * 10}:same`,
  identity: 'same',
  children: String(read * 100),
  cleaned,
})
const hidden = (cleaned, disposed = false) => ({
  read: null,
  branch: disposed ? null : 'hidden',
  title: null,
  alias: null,
  snapshot: null,
  positive: false,
  prop: null,
  identity: null,
  children: null,
  cleaned,
})
const scenario = {
  mountExport: 'mount',
  observeExport: 'observe',
  steps: [
    { kind: 'record', label: 'initial' },
    { kind: 'click', selector: '#inc' },
    { kind: 'record', label: 'update' },
    { kind: 'click', selector: '#toggle' },
    { kind: 'record', label: 'hide' },
    { kind: 'click', selector: '#inc' },
    { kind: 'click', selector: '#toggle' },
    { kind: 'record', label: 'remount' },
    { kind: 'dispose' },
    { kind: 'record', label: 'disposed' },
  ],
}
const readers = [
  ['direct', 'const read = () => count'],
  ['default parameter', 'function read(value = count) { return value }'],
  ['nested callback', 'const read = () => [1].map(() => count)[0]'],
  ['object method', 'const holder = { read: () => count }; const read = () => holder.read()'],
  ['alias', 'const original = () => count; const read = original'],
]
for (const [name, reader] of readers)
  for (const profile of profiles) {
    test(`${name} reads track through VNode branches, component props and aliases: ${JSON.stringify(profile)}`, async () => {
      const result = binding.transformSync({
        filename: '/jsx-local-getters.tsx',
        code: source.replace('const read = () => count', reader),
        moduleKind: 'commonjs',
        options: { dev: false, strictGuarantee: true, ...profile },
      })
      assert.deepEqual(result.diagnostics, [])
      assert.deepEqual(await executeDomCommonJs(result.code, scenario), [
        { label: 'initial', value: visible(0, 0) },
        { label: 'update', value: visible(1, 0) },
        { label: 'hide', value: hidden(1) },
        { label: 'remount', value: visible(2, 2, 1) },
        { label: 'disposed', value: hidden(2, true) },
      ])
    })
  }

const callbacks = `
import { $state, render, onDestroy } from 'fict'
const invoked = []
let cleaned = 0
const first = () => invoked.push('first')
const second = () => invoked.push('second')
function Action(props) {
  onDestroy(() => cleaned++)
  return <button id="action" onClick={() => props.onClick()}>{typeof props.onClick}</button>
}
function App() {
  let changed = $state(false)
  let visible = $state(true)
  const choose = () => changed ? second : first
  return <main>
    <button id="change" onClick={() => changed = true}>change</button>
    {visible && <Action onClick={choose()} />}
  </main>
}
export function mount(root) { return render(() => <App />, root) }
export function observe() {
  return { invoked: [...invoked], cleaned, kind: document.querySelector('#action')?.textContent ?? null }
}
`
for (const profile of profiles) {
  test(`function-valued call props preserve callbacks and follow their selector: ${JSON.stringify(profile)}`, async () => {
    const result = binding.transformSync({
      filename: '/jsx-callable-props.tsx',
      code: callbacks,
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true, ...profile },
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(
      await executeDomCommonJs(result.code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [
          { kind: 'record', label: 'initial' },
          { kind: 'click', selector: '#action' },
          { kind: 'record', label: 'first' },
          { kind: 'click', selector: '#change' },
          { kind: 'record', label: 'changed' },
          { kind: 'click', selector: '#action' },
          { kind: 'record', label: 'second' },
          { kind: 'dispose' },
          { kind: 'record', label: 'disposed' },
        ],
      }),
      [
        { label: 'initial', value: { invoked: [], cleaned: 0, kind: 'function' } },
        { label: 'first', value: { invoked: ['first'], cleaned: 0, kind: 'function' } },
        { label: 'changed', value: { invoked: ['first'], cleaned: 0, kind: 'function' } },
        { label: 'second', value: { invoked: ['first', 'second'], cleaned: 0, kind: 'function' } },
        { label: 'disposed', value: { invoked: ['first', 'second'], cleaned: 1, kind: null } },
      ],
    )
  })
}

for (const profile of profiles) {
  test(`component keys evaluate once as values: ${JSON.stringify(profile)}`, () => {
    const result = binding.transformSync({
      code: `let calls = 0; function getKey() { calls++; return 7 }
        function Item() { return null }
        export function Scenario() {
          const vnode = <Item key={getKey()} />
          return { key: vnode.key, calls }
        }`,
      filename: '/jsx-key-value.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true, ...profile },
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }), {
      key: 7,
      calls: 1,
    })
  })
}

for (const profile of profiles) {
  test(`call props share an updated result without invoking function values: ${JSON.stringify(profile)}`, async () => {
    const result = binding.transformSync({
      code: `import { $state, render, untrack } from 'fict'
        let calls = 0
        let invoked = 0
        function Child(props) {
          return <output id="result">{props.value}:{props.value}:{props.fn === props.fn ? 'same' : 'different'}</output>
        }
        function App() {
          let count = $state(0)
          const read = () => { calls++; return count }
          const makeCallback = () => { const snapshot = untrack(() => count); return () => { invoked++; return snapshot } }
          return <main><button id="inc" onClick={() => count++}>inc</button>
            <Child value={read()} fn={makeCallback()} /></main>
        }
        export function mount(el) { return render(() => <App />, el) }
        export function observe() { return { text: document.querySelector('#result')?.textContent ?? null, calls, invoked } }`,
      filename: '/jsx-prop-shared-update.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true, ...profile },
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(
      await executeDomCommonJs(result.code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [
          { kind: 'record', label: 'initial' },
          { kind: 'click', selector: '#inc' },
          { kind: 'record', label: 'update' },
          { kind: 'dispose' },
          { kind: 'record', label: 'disposed' },
        ],
      }),
      [
        { label: 'initial', value: { text: '0:0:same', calls: 1, invoked: 0 } },
        { label: 'update', value: { text: '1:1:same', calls: 2, invoked: 0 } },
        { label: 'disposed', value: { text: null, calls: 2, invoked: 0 } },
      ],
    )
  })

  test(`call props evaluate in order and share values across consumers: ${JSON.stringify(profile)}`, async () => {
    const result = binding.transformSync({
      code: `import { render } from 'fict'
        const events = []
        function make(name) { events.push(name); return events.length }
        function object() { events.push('object'); return {} }
        function callback() { events.push('callback'); return () => 'callback result' }
        function Child(props) {
          events.push('child')
          return <output>{props.value}:{props.value}:{props.object === props.object ? 'same' : 'different'}:{props.callback === props.callback ? 'same' : 'different'}</output>
        }
        function App() {
          return <Child value={make('value')} unused={make('unused')} object={object()} callback={callback()} />
        }
        let root
        export function mount(el) { root = el; return render(() => <App />, el) }
        export function observe() { return { text: root.textContent, events: [...events] } }`,
      filename: '/jsx-prop-evaluation.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true, ...profile },
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(
      await executeDomCommonJs(result.code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [{ kind: 'record', label: 'initial' }, { kind: 'dispose' }],
      }),
      [
        {
          label: 'initial',
          value: {
            text: '1:1:same:same',
            events: ['value', 'unused', 'object', 'callback', 'child'],
          },
        },
      ],
    )
  })

  test(`an unread throwing prop keeps its exception and evaluation position: ${JSON.stringify(profile)}`, async () => {
    const result = binding.transformSync({
      code: `import { render } from 'fict'
        const events = []
        const failure = { message: 'prop failure' }
        function before() { events.push('before'); return 1 }
        function fail() { events.push('fail'); throw failure }
        function after() { events.push('after'); return 3 }
        function Child() { events.push('child'); return null }
        let result
        function Scenario() {
          try { const vnode = <Child before={before()} unused={fail()} after={after()} /> }
          catch (error) { return { same: error === failure, events } }
          return { same: false, events }
        }
        export function mount(el) { return render(() => { result = Scenario(); return null }, el) }
        export function observe() { return result }`,
      filename: '/jsx-prop-exception.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true, ...profile },
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(
      await executeDomCommonJs(result.code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [{ kind: 'record', label: 'initial' }, { kind: 'dispose' }],
      }),
      [{ label: 'initial', value: { same: true, events: ['before', 'fail'] } }],
    )
  })
}
