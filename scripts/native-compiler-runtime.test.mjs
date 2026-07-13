#!/usr/bin/env node

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
const binding = require(path.join(root, 'target', 'release', 'fict_compiler_napi.node'))

let dom

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const exposed = [
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
  ]
  for (const name of exposed) {
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
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function compileAndImport(source, name, expectedCode) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
  })
  assert.deepEqual(result.diagnostics, [], result.diagnostics.map(item => item.message).join('\n'))
  if (expectedCode) {
    assert.match(result.code, expectedCode)
  }

  const fixture = path.join(
    root,
    'packages',
    'fict',
    `.native-runtime-${name}-${process.pid}-${Date.now()}.mjs`,
  )
  await writeFile(fixture, result.code, 'utf8')
  try {
    return await import(`${pathToFileURL(fixture).href}?v=${Date.now()}`)
  } finally {
    await unlink(fixture)
  }
}

test('Rust compiler output preserves keyed identity, reactive updates, and cleanup', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let replaceRows = () => {}

      function App() {
        let rows = $state([
          { id: 1, label: 'A' },
          { id: 2, label: 'B' },
          { id: 3, label: 'C' },
        ])
        replaceRows = next => {
          rows = next
        }
        return <ul>{rows.map(row => <li key={row.id} data-id={row.id}>{row.label}</li>)}</ul>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        replaceRows(next)
      }
    `,
    'keyed-list',
    /createKeyedList/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initial = new Map(
    [...container.querySelectorAll('li')].map(node => [node.dataset.id, node]),
  )
  assert.deepEqual([...initial.keys()], ['1', '2', '3'])
  assert.equal(container.textContent, 'ABC')
  assert.equal(container.getAttribute('data-fict-fine-grained'), '1')

  module.update([
    { id: 3, label: 'C2' },
    { id: 1, label: 'A2' },
    { id: 4, label: 'D' },
  ])
  await flushRuntime()

  const updated = [...container.querySelectorAll('li')]
  assert.deepEqual(
    updated.map(node => node.dataset.id),
    ['3', '1', '4'],
  )
  assert.equal(container.textContent, 'C2A2D')
  assert.equal(updated[0], initial.get('3'))
  assert.equal(updated[1], initial.get('1'))
  assert.equal(initial.get('2')?.isConnected, false)

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps destructured component props reactive', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setValue = () => {}

      function Child({ value: renamed, label }) {
        return <p data-label={label}>{label}:{renamed}</p>
      }

      function App() {
        let value = $state('A')
        setValue = next => {
          value = next
        }
        return <Child value={value} label={value.toLowerCase()} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setValue(next)
      }
    `,
    'destructured-props',
    /const renamed = prop\(\(\) => __fictProps\.value\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'a:A')
  assert.equal(child.dataset.label, 'a')

  module.update('B')
  await flushRuntime()

  const updated = container.querySelector('p')
  assert.equal(updated, child)
  assert.equal(updated?.textContent, 'b:B')
  assert.equal(updated?.dataset.label, 'b')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output snapshots destructured prop defaults at invocation', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setValue = () => {}
      export const defaultCalls = []

      function fallback(value) {
        defaultCalls.push(value)
        return value.toLowerCase()
      }

      function Child({ value: renamed, label = fallback(renamed) }) {
        return <p>{String(label)}:{renamed}</p>
      }

      function App() {
        let value = $state('A')
        setValue = next => {
          value = next
        }
        return <section><Child value={value} /><Child value={value} label={null} /></section>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setValue(next)
      }
    `,
    'defaulted-props',
    /__fictProps\.label === void 0/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initial = [...container.querySelectorAll('p')]
  assert.deepEqual(
    initial.map(node => node.textContent),
    ['a:A', 'null:A'],
  )
  assert.deepEqual(module.defaultCalls, ['A'])

  module.update('B')
  await flushRuntime()

  const updated = [...container.querySelectorAll('p')]
  assert.deepEqual(
    updated.map(node => node.textContent),
    ['a:B', 'null:B'],
  )
  assert.equal(updated[0], initial[0])
  assert.equal(updated[1], initial[1])
  assert.deepEqual(module.defaultCalls, ['A'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output materializes JSX prop defaults lazily and reactively', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setLabel = () => {}
      export const defaultCalls = []

      function Child({ label, fallback = (defaultCalls.push(label), <span data-id="fallback">{label}</span>) } = {}) {
        return <div data-id="host">{fallback}</div>
      }

      function App() {
        let label = $state('A')
        setLabel = next => {
          label = next
        }
        return (
          <>
            <Child label={label} />
            <Child label={label} fallback={<em data-id="custom">Custom</em>} />
            <Child label={label} fallback={null} />
          </>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setLabel(next)
      }
    `,
    'jsx-prop-default',
    /__fictProps\.fallback === void 0.*defaultCalls\.push\(label\(\)\)/s,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const hosts = [...container.querySelectorAll('[data-id="host"]')]
  assert.equal(hosts.length, 3)
  const fallback = container.querySelector('[data-id="fallback"]')
  const custom = container.querySelector('[data-id="custom"]')
  assert.ok(fallback)
  assert.ok(custom)
  assert.equal(fallback.textContent, 'A')
  assert.equal(custom.textContent, 'Custom')
  assert.equal(hosts[2].textContent, '')
  assert.deepEqual(module.defaultCalls, ['A'])

  module.update('B')
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="fallback"]'), fallback)
  assert.equal(container.querySelector('[data-id="custom"]'), custom)
  assert.equal(fallback.textContent, 'B')
  assert.equal(custom.textContent, 'Custom')
  assert.equal(hosts[2].textContent, '')
  assert.deepEqual(module.defaultCalls, ['A'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output applies whole-object parameter defaults with intrinsic undefined', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      export const calls = []

      function fallbackProps() {
        calls.push('default')
        return { name: 'Anon' }
      }

      function Greeting({ name } = fallbackProps()) {
        const undefined = 'shadowed'
        return <p>{undefined}:{name}</p>
      }

      export function mount(container) {
        return render(() => Greeting(undefined), container)
      }
    `,
    'parameter-default-props',
    /__fictPropsParam === void 0/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.textContent, 'shadowed:Anon')
  assert.deepEqual(module.calls, ['default'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps nested destructured props reactive and checked', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setUser = () => {}

      function Child({ user: { name, profile: { age = 18 } } }) {
        return <p>{name}:{age}</p>
      }

      function App() {
        let user = $state({ name: 'Ada', profile: {} })
        setUser = next => {
          user = next
        }
        return <Child user={user} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function mountNull(container) {
        return render(() => <Child user={null} />, container)
      }

      export function update(next) {
        setUser(next)
      }
    `,
    'nested-props',
    /const name = prop\(\(\) => __fictProps\.user\.name\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'Ada:18')

  module.update({ name: 'Bea', profile: { age: 20 } })
  await flushRuntime()
  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'Bea:20')

  module.update({ name: 'Cy', profile: {} })
  await flushRuntime()
  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'Cy:18')

  dispose()
  container.remove()

  const invalidContainer = document.createElement('div')
  assert.throws(
    () => module.mountNull(invalidContainer),
    /Cannot destructure prop "user" because it is nullish/,
  )
})

test('Rust compiler output preserves reactive top-level rest props', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setData = () => {}

      function Child({ id, ...rest }) {
        return <p>{String('id' in rest)}:{id}:{rest.title}:{rest.count}</p>
      }

      function App() {
        let data = $state({ title: 'A', count: 1 })
        setData = next => {
          data = next
        }
        return <Child id="row" title={data.title} count={data.count} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setData(next)
      }
    `,
    'rest-props',
    /const rest = __fictPropsRest\(__fictProps, \["id"\]\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'false:row:A:1')

  module.update({ title: 'B', count: 2 })
  await flushRuntime()

  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'false:row:B:2')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps reassigned destructured props as mutable snapshots', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setReactive = () => {}

      function Child({ reactive, local, count = 1, user: { name }, alias }) {
        const assigned = (local = 'changed')
        const before = count++
        name = name.toUpperCase()
        ;({ alias } = { alias: 'reassigned' })
        return <p>{reactive}:{local}:{count}:{assigned}:{before}:{name}:{alias}</p>
      }

      function App() {
        let reactive = $state('A')
        setReactive = next => {
          reactive = next
        }
        return <Child reactive={reactive} local="initial" user={{ name: 'ann' }} alias="initial" />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setReactive(next)
      }
    `,
    'mutated-props',
    /var local = __fictProps\.local/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'A:changed:2:changed:1:ANN:reassigned')

  module.update('B')
  await flushRuntime()

  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'B:changed:2:changed:1:ANN:reassigned')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output snapshots callable props without deactivating value props', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      function Child({ count, onIncrement }) {
        const invoke = onIncrement
        return <div><span>{count}</span><button onClick={() => invoke.call(null)}>+</button></div>
      }

      function App() {
        let count = $state(0)
        return <Child count={count} onIncrement={() => count++} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'callable-props',
    /const onIncrement = __fictProps\.onIncrement/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const value = container.querySelector('span')
  const button = container.querySelector('button')
  assert.ok(value)
  assert.ok(button)
  assert.equal(value.textContent, '0')

  button.click()
  await flushRuntime()

  assert.equal(container.querySelector('span'), value)
  assert.equal(container.querySelector('button'), button)
  assert.equal(value.textContent, '1')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps mixed displayed and called function props reactive', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setLabel = () => {}
      export const calls = []

      function makeLabel(value) {
        const label = () => calls.push(value)
        label.toString = () => value
        return label
      }

      function Child({ label }) {
        return <div><span>{String(label)}</span><button onClick={() => label()}>call</button></div>
      }

      function App() {
        let model = $state({ label: makeLabel('first') })
        setLabel = value => {
          model = { label: makeLabel(value) }
        }
        return <Child label={model.label} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(value) {
        setLabel(value)
      }
    `,
    'mixed-callable-props',
    /const label = prop\(\(\) => __fictProps\.label\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const label = container.querySelector('span')
  const button = container.querySelector('button')
  assert.ok(label)
  assert.ok(button)
  assert.equal(label.textContent, 'first')

  button.click()
  await flushRuntime()
  assert.deepEqual(module.calls, ['first'])

  module.update('second')
  await flushRuntime()
  assert.equal(container.querySelector('span'), label)
  assert.equal(label.textContent, 'second')

  button.click()
  await flushRuntime()
  assert.deepEqual(module.calls, ['first', 'second'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})
