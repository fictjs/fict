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

async function compileAndImport(source, name, settings = {}) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
    options: settings.options ?? {},
  })
  assert.deepEqual(
    result.diagnostics.map(diagnostic => diagnostic.code),
    settings.diagnosticCodes ?? [],
    result.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
  )
  assert.match(result.compilerBuildId, /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/)
  assert.notEqual(result.code, '')
  return importCompiledModule(result.code, name)
}

async function exerciseCoreModule(module) {
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initialRows = new Map(
    [...container.querySelectorAll('li')].map(node => [node.dataset.id, node]),
  )
  const snapshot = {
    initial: {
      button: container.querySelector('[data-id="toggle"]')?.textContent,
      effectLog: [...module.effects],
      label: container.querySelector('[data-id="label"]')?.textContent,
      mathNamespace: container.querySelector('mi')?.namespaceURI,
      rowIds: [...initialRows.keys()],
      rowText: [...initialRows.values()].map(node => node.textContent),
      svgNamespace: container.querySelector('circle')?.namespaceURI,
      tableText: container.querySelector('td')?.textContent,
    },
  }

  container.querySelector('[data-id="toggle"]')?.click()
  module.update([
    { id: 3, label: 'C2' },
    { id: 1, label: 'A2' },
    { id: 4, label: 'D' },
  ])
  await flushRuntime()

  const updatedRows = [...container.querySelectorAll('li')]
  snapshot.updated = {
    button: container.querySelector('[data-id="toggle"]')?.textContent,
    effectLog: [...module.effects],
    keyedIdentity: [
      updatedRows[0] === initialRows.get('3'),
      updatedRows[1] === initialRows.get('1'),
    ],
    label: container.querySelector('[data-id="label"]')?.textContent,
    removedRowDisconnected: initialRows.get('2')?.isConnected === false,
    rowIds: updatedRows.map(node => node.dataset.id),
    rowText: updatedRows.map(node => node.textContent),
    tableText: container.querySelector('td')?.textContent,
  }

  dispose()
  snapshot.cleanedUp = container.childNodes.length === 0
  container.remove()
  return snapshot
}

test('Rust compiler output preserves Core reactive runtime behavior', async () => {
  const source = `
    import { $effect, $memo, $state, render } from 'fict'

    export const effects = []
    let replaceRows = () => {}

    function Label({ value, suffix = '!' }) {
      return <p data-id="label">{value}{suffix}</p>
    }

    function App() {
      let active = $state(false)
      let rows = $state([
        { id: 1, label: 'A' },
        { id: 2, label: 'B' },
        { id: 3, label: 'C' },
      ])
      const status = $memo(() => active ? 'on' : 'off')
      $effect(() => effects.push(status))
      replaceRows = next => {
        rows = next
      }

      return (
        <main>
          <button data-id="toggle" class={status} onClick={() => { active = !active }}>
            {status}
          </button>
          <Label value={status} />
          <ul>{rows.map(row => <li key={row.id} data-id={row.id}>{row.label}</li>)}</ul>
          <svg viewBox="0 0 10 10"><circle cx={active ? 2 : 1} cy="1" r="1" /></svg>
          <math><mi>{active ? 'y' : 'x'}</mi></math>
          <table><tbody><tr><td>{active ? '1' : '0'}</td></tr></tbody></table>
        </main>
      )
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update(next) {
      replaceRows(next)
    }
  `
  const compiled = await compileAndImport(source, 'core-runtime', {
    options: { strictGuarantee: false },
    diagnosticCodes: ['FICT-R002'],
  })
  const snapshot = await exerciseCoreModule(compiled)

  assert.deepEqual(snapshot, {
    initial: {
      button: 'off',
      effectLog: ['off'],
      label: 'off!',
      mathNamespace: 'http://www.w3.org/1998/Math/MathML',
      rowIds: ['1', '2', '3'],
      rowText: ['A', 'B', 'C'],
      svgNamespace: 'http://www.w3.org/2000/svg',
      tableText: '0',
    },
    updated: {
      button: 'on',
      effectLog: ['off', 'on'],
      keyedIdentity: [true, true],
      label: 'on!',
      removedRowDisconnected: true,
      rowIds: ['3', '1', '4'],
      rowText: ['C2', 'A2', 'D'],
      tableText: '1',
    },
    cleanedUp: true,
  })
})

test('later explicit JSX props keep precedence when an earlier spread reruns', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let replaceFirst = () => {}

      function App() {
        let first = $state({ title: 'first' })
        const second = { 'data-role': 'second' }
        replaceFirst = value => (first = value)
        return <div data-testid="target" {...first} title="explicit" {...second}>x</div>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update() {
        replaceFirst({ title: 'first-updated' })
      }
    `,
    'jsx-spread-explicit-precedence',
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-J003'],
    },
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const target = container.querySelector('[data-testid="target"]')
  assert.equal(target?.getAttribute('title'), 'explicit')
  assert.equal(target?.getAttribute('data-role'), 'second')

  compiled.update()
  await flushRuntime()
  assert.equal(target?.getAttribute('title'), 'explicit')
  assert.equal(target?.getAttribute('data-role'), 'second')

  dispose()
  container.remove()
})

test('legacy DOM binding targets and forced prefixes update through native output', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let updateBindings = () => {}

      function App() {
        let mode = $state(0)
        let leading = $state({
          title: 'spread-title',
          textContent: 'spread text',
          'data-active': true,
          someProp: 'spread custom',
        })
        updateBindings = () => {
          mode = 1
          leading = {
            title: 'spread-title-updated',
            textContent: 'spread text updated',
            'data-active': false,
            someProp: 'spread custom updated',
          }
        }
        return (
          <main>
            <div data-id="html" dangerouslySetInnerHTML={{ __html: mode ? '<b>on</b>' : '<i>off</i>' }} />
            <textarea data-id="default-value" defaultValue="seed" />
            <input data-id="default-checked" type="checkbox" defaultChecked indeterminate={mode} />
            <select data-id="multiple" multiple={mode}><option defaultSelected>one</option></select>
            <audio data-id="muted" defaultMuted muted={mode} />
            <div data-id="inner-text" innerText="label" />
            <div data-id="class-list" classList={{ active: mode === 1, idle: mode === 0 }} />
            <div
              data-id="forced"
              {...leading}
              attr:title={mode ? 'forced-on' : 'forced-off'}
              bool:data-active={mode}
              prop:textContent={mode ? 'forced on' : 'forced off'}
            />
            <my-widget data-id="custom" {...leading} some-prop={mode} config={{ value: mode }} />
          </main>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update() {
        updateBindings()
      }
    `,
    'dom-binding-targets',
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-J003', 'FICT-J003'],
    },
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const html = container.querySelector('[data-id="html"]')
  const defaultValue = container.querySelector('[data-id="default-value"]')
  const defaultChecked = container.querySelector('[data-id="default-checked"]')
  const multiple = container.querySelector('[data-id="multiple"]')
  const muted = container.querySelector('[data-id="muted"]')
  const innerText = container.querySelector('[data-id="inner-text"]')
  const classList = container.querySelector('[data-id="class-list"]')
  const forced = container.querySelector('[data-id="forced"]')
  const custom = container.querySelector('my-widget')

  assert.equal(html?.innerHTML, '<i>off</i>')
  assert.equal(defaultValue?.defaultValue, 'seed')
  assert.equal(defaultChecked?.defaultChecked, true)
  assert.equal(defaultChecked?.indeterminate, false)
  assert.equal(multiple?.multiple, false)
  assert.equal(multiple?.querySelector('option')?.defaultSelected, true)
  assert.equal(muted?.defaultMuted, true)
  assert.equal(muted?.muted, false)
  assert.equal(innerText?.innerText, 'label')
  assert.equal(classList?.className, 'idle')
  assert.equal(forced?.getAttribute('title'), 'forced-off')
  assert.equal(forced?.hasAttribute('data-active'), false)
  assert.equal(forced?.textContent, 'forced off')
  assert.equal(custom?.someProp, 0)
  assert.deepEqual(custom?.config, { value: 0 })

  compiled.update()
  await flushRuntime()

  assert.equal(html?.innerHTML, '<b>on</b>')
  assert.equal(defaultChecked?.indeterminate, true)
  assert.equal(multiple?.multiple, true)
  assert.equal(muted?.muted, true)
  assert.equal(classList?.className, 'active')
  assert.equal(forced?.getAttribute('title'), 'forced-on')
  assert.equal(forced?.getAttribute('data-active'), '')
  assert.equal(forced?.textContent, 'forced on')
  assert.equal(custom?.someProp, 1)
  assert.deepEqual(custom?.config, { value: 1 })

  dispose()
  container.remove()
})

test('native template extraction preserves static HTML and live binding paths', async () => {
  const result = binding.transformSync({
    code: `
      import { $state, render } from 'fict'

      export let api

      function App() {
        let dynamic = $state('first')
        let name = $state('Ada')
        let item = $state('one')
        api = {
          update() {
            dynamic = 'second'
            name = 'Grace'
            item = 'two'
          },
        }
        return (
          <section>
            <div data-case="static" id="test" class="foo">Hello</div>
            <button data-case="boolean" disabled>Click</button>
            <div data-case="dynamic-attr" id={dynamic}></div>
            <div data-case="child">Text {name} <span>Static</span></div>
            <ul data-case="nested"><li>{item}</li></ul>
          </section>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    filename: '/fixtures/template-extractor.tsx',
    moduleId: '/fixtures/template-extractor.tsx',
    options: {},
  })
  assert.deepEqual(result.diagnostics, [])
  assert.match(result.compilerBuildId, /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/)

  const template = result.code.match(/const __fict_tmpl\d+ = template\(("(?:\\.|[^"\\])*")\);/)
  assert.ok(template)
  assert.equal(
    JSON.parse(template[1]),
    '<section><div data-case="static" id="test" class="foo">Hello</div><button data-case="boolean">Click</button><div data-case="dynamic-attr"></div><div data-case="child">Text <!----> <span>Static</span></div><ul data-case="nested"><li><!----></li></ul></section>',
  )
  const paths = [...result.code.matchAll(/resolvePath\([^,]+,\s*(\[[\s\d,]*\])\)/g)].map(match =>
    JSON.parse(match[1]),
  )
  assert.deepEqual(paths, [[1], [2], [3], [3, 1], [4, 0], [4, 0, 0]])

  const compiled = await importCompiledModule(result.code, 'template-extractor')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const staticElement = container.querySelector('[data-case="static"]')
  const booleanElement = container.querySelector('[data-case="boolean"]')
  const dynamicElement = container.querySelector('[data-case="dynamic-attr"]')
  const childElement = container.querySelector('[data-case="child"]')
  const nestedElement = container.querySelector('[data-case="nested"] li')
  assert.equal(staticElement?.id, 'test')
  assert.equal(staticElement?.className, 'foo')
  assert.equal(staticElement?.textContent, 'Hello')
  assert.equal(booleanElement?.hasAttribute('disabled'), true)
  assert.equal(dynamicElement?.id, 'first')
  assert.equal(childElement?.textContent, 'Text Ada Static')
  assert.equal(childElement?.querySelector('span')?.textContent, 'Static')
  assert.equal(nestedElement?.textContent, 'one')

  compiled.api.update()
  await flushRuntime()
  assert.equal(dynamicElement?.id, 'second')
  assert.equal(childElement?.textContent, 'Text Grace Static')
  assert.equal(nestedElement?.textContent, 'two')

  dispose()
  container.remove()
})

test('captured reactive aliases remain mutable after an event', async () => {
  const source = `
    import { $state, render } from 'fict'

    let readAlias = () => -1

    function App() {
      let count = $state(0)
      let alias = count

      function update() {
        alias = 2
      }

      readAlias = () => alias
      return <button data-id="captured-alias" onClick={update}>{count}</button>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function read() {
      return readAlias()
    }
  `
  const compiled = await compileAndImport(source, 'captured-alias-write')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  assert.equal(compiled.read(), 0)
  container.querySelector('[data-id="captured-alias"]')?.click()
  await flushRuntime()
  assert.equal(compiled.read(), 2)

  dispose()
  container.remove()
})

test('projected reactive mutations preserve JavaScript evaluation semantics', async () => {
  const source = `
    import { $state, render } from 'fict'

    let readSnapshot = () => null

    function App() {
      const events = []
      const target = {
        assigned: 1,
        compound: 2,
        postfix: 4,
        prefix: 6,
        postdec: 8,
        predec: 10,
        removed: 11,
      }
      const state = $state({
        get nested() {
          events.push('root')
          return target
        },
      })
      const key = name => {
        events.push('key:' + name)
        return name
      }
      const rhs = (name, value) => {
        events.push('rhs:' + name)
        return value
      }

      function mutate() {
        const assigned = (state.nested.assigned = rhs('assigned', 3))
        const compound = (state.nested[key('compound')] += rhs('delta', 5))
        const postfix = state.nested[key('postfix')]++
        const prefix = ++state.nested[key('prefix')]
        const postdec = state.nested[key('postdec')]--
        const predec = --state.nested[key('predec')]
        const removed = delete state.nested[key('removed')]
        readSnapshot = () => ({
          events: [...events],
          results: { assigned, compound, postfix, prefix, postdec, predec, removed },
          target: { ...target },
        })
      }

      return <button data-id="projected-mutations" onClick={mutate}>mutate</button>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function read() {
      return readSnapshot()
    }
  `
  const compiled = await compileAndImport(source, 'projected-mutations', {
    options: { strictGuarantee: false },
    diagnosticCodes: [
      'FICT-M',
      'FICT-H',
      'FICT-M',
      'FICT-H',
      'FICT-M',
      'FICT-M',
      'FICT-H',
      'FICT-H',
      'FICT-M',
      'FICT-M',
      'FICT-H',
      'FICT-M',
      'FICT-H',
    ],
  })
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  assert.equal(compiled.read(), null)
  container.querySelector('[data-id="projected-mutations"]')?.click()
  await flushRuntime()
  assert.deepEqual(compiled.read(), {
    events: [
      'root',
      'rhs:assigned',
      'root',
      'key:compound',
      'rhs:delta',
      'root',
      'key:postfix',
      'root',
      'key:prefix',
      'root',
      'key:postdec',
      'root',
      'key:predec',
      'root',
      'key:removed',
    ],
    results: {
      assigned: 3,
      compound: 7,
      postfix: 4,
      prefix: 7,
      postdec: 8,
      predec: 9,
      removed: true,
    },
    target: {
      assigned: 3,
      compound: 7,
      postfix: 5,
      prefix: 7,
      postdec: 7,
      predec: 9,
    },
  })

  dispose()
  container.remove()
})

test('reactive conditional returns preserve branch statements and local scope', async () => {
  const source = `
    import { $state, render } from 'fict'

    export const events = []
    globalThis.__fictMig004Hoisted = 'GLOBAL'
    let toggle = () => {}

    function App() {
      let show = $state(true)
      let count = $state(1)
      toggle = () => {
        show = !show
        count++
      }
      __fictMig004Hoisted = 'BEFORE'
      events.push('before:' + __fictMig004Hoisted)
      if (show) {
        {
          const label = count + 1
          var __fictMig004Hoisted = 'LOCAL'
          var { seed = 2, ...details } = { seed: 1, extra: 'REST' }
          var [first, ...tail] = [1, 2]
          var total = tail[0] + 1
          events.push(
            'on:' +
              __fictMig004Hoisted +
              ':' +
              seed +
              ':' +
              first +
              ':' +
              total +
              ':' +
              details.extra,
          )
          return (
            <p data-id="conditional-return">
              {label}:{seed}:{first}:{total}:{details.extra}
            </p>
          )
        }
      }
      const label = count + 10
      events.push(
        'off:' +
          typeof __fictMig004Hoisted +
          ':' +
          (__fictMig004Hoisted ?? 'local-undefined') +
          ':' +
          seed +
          ':' +
          first +
          ':' +
          total +
          ':' +
          details.extra,
      )
      return <p data-id="conditional-return">{label}</p>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update() {
      toggle()
    }

    export function globalValue() {
      return globalThis.__fictMig004Hoisted
    }
  `
  const compiled = await compileAndImport(source, 'conditional-return-statements')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  assert.equal(
    container.querySelector('[data-id="conditional-return"]')?.textContent,
    '2:1:1:3:REST',
  )
  assert.equal(compiled.globalValue(), 'GLOBAL')
  assert.deepEqual(compiled.events, ['before:BEFORE', 'on:LOCAL:1:1:3:REST'])

  compiled.update()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="conditional-return"]')?.textContent, '12')
  assert.deepEqual(compiled.events, [
    'before:BEFORE',
    'on:LOCAL:1:1:3:REST',
    'off:string:LOCAL:1:1:3:REST',
  ])

  compiled.update()
  await flushRuntime()
  assert.equal(
    container.querySelector('[data-id="conditional-return"]')?.textContent,
    '4:1:1:3:REST',
  )
  assert.deepEqual(compiled.events, [
    'before:BEFORE',
    'on:LOCAL:1:1:3:REST',
    'off:string:LOCAL:1:1:3:REST',
    'on:LOCAL:1:1:3:REST',
  ])

  dispose()
  container.remove()
})

test('reactive switch assignments re-execute as one fallback region', async () => {
  const source = `
    import { $state, render } from 'fict'

    let setMode = () => {}

    function App() {
      let mode = $state(0)
      setMode = value => { mode = value }
      let out

      switch (mode) {
        case 0:
          out = 'zero'
          break
        case 1:
          out = 'one'
          break
        default:
          out = 'many'
      }

      return <div data-id="control-region">{out}</div>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update(value) {
      setMode(value)
    }
  `

  const strict = binding.transformSync({
    code: source,
    filename: '/fixtures/control-flow-region-strict.tsx',
  })
  assert.equal(strict.code, '')
  assert.deepEqual(
    strict.diagnostics.map(({ code, severity }) => [code, severity]),
    [['FICT-R006', 'error']],
  )

  const compiled = await compileAndImport(source, 'control-flow-region-fallback', {
    options: { strictGuarantee: false },
    diagnosticCodes: ['FICT-R006'],
  })
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const value = () => container.querySelector('[data-id="control-region"]')?.textContent
  assert.equal(value(), 'zero')
  for (const [mode, expected] of [
    [1, 'one'],
    [2, 'many'],
    [0, 'zero'],
  ]) {
    compiled.update(mode)
    await flushRuntime()
    assert.equal(value(), expected)
  }

  dispose()
  container.remove()
})

test('named function expression hooks use their public binding role', async () => {
  const source = `
    import { $state, render } from 'fict'

    const useNamed = function inner() {
      let count = $state(0)
      return typeof inner + ':' + count
    }

    function App() {
      return <p data-id="named-hook">{useNamed()}</p>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }
  `
  const compiled = await compileAndImport(source, 'named-function-expression-hook')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="named-hook"]')?.textContent, 'function:0')

  dispose()
  container.remove()
})

test('const-asserted hook tuples preserve live accessor identity', async () => {
  const source = `
    import { $state, render } from 'fict'

    let toggle = () => {}

    function useToggle() {
      let on = $state(false)
      toggle = () => { on = !on }
      return [on, toggle] as const
    }

    function App() {
      const tuple = useToggle()
      return <span data-id="const-hook">{tuple[0] ? 'on' : 'off'}</span>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update() {
      toggle()
    }
  `

  const compiled = await compileAndImport(source, 'const-asserted-hook-return')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const value = () => container.querySelector('[data-id="const-hook"]')?.textContent
  assert.equal(value(), 'off')
  compiled.update()
  await flushRuntime()
  assert.equal(value(), 'on')
  compiled.update()
  await flushRuntime()
  assert.equal(value(), 'off')

  dispose()
  container.remove()
})

test('runtime reactive creators preserve calls and enforce configurable R004', async () => {
  const compiled = await compileAndImport(
    `
      import { createMemo } from '@fictjs/runtime'
      export const memo = createMemo?.(() => 41)
      export const value = memo() + 1
    `,
    'runtime-optional-memo',
    { diagnosticCodes: ['FICT-M001'] },
  )
  assert.equal(compiled.value, 42)

  const source = `
    import { createEffect, createMemo } from '@fictjs/runtime'
    import { createSelector } from 'fict'
    export function setup(ready) {
      if (ready) createEffect(() => ready)
      if (ready) createMemo?.(() => ready)
      if (ready) createSelector(() => ready)
    }
  `
  const strict = binding.transformSync({
    code: source,
    filename: '/fixtures/runtime-reactive-control.ts',
    options: {},
  })
  assert.equal(strict.code, '')
  assert.equal(strict.diagnostics.filter(({ code }) => code === 'FICT-R004').length, 3)

  const fallback = binding.transformSync({
    code: source,
    filename: '/fixtures/runtime-reactive-control.ts',
    options: {
      strictGuarantee: false,
      warningLevels: { 'FICT-R004': 'warn' },
    },
  })
  assert.notEqual(fallback.code, '')
  const lifecycleWarnings = fallback.diagnostics.filter(({ code }) => code === 'FICT-R004')
  assert.equal(lifecycleWarnings.length, 3)
  assert.ok(lifecycleWarnings.every(({ severity }) => severity === 'warning'))

  const mutedOptions = {
    strictGuarantee: false,
    warningLevels: { 'FICT-R004': 'off' },
  }
  const muted = binding.transformSync({
    code: source,
    filename: '/fixtures/runtime-reactive-control.ts',
    options: mutedOptions,
  })
  assert.notEqual(muted.code, '')
  assert.equal(
    muted.diagnostics.some(({ code }) => code === 'FICT-R004'),
    false,
  )
  assert.equal(
    muted.diagnostics.some(({ code }) => code === 'FICT-M001'),
    true,
  )

  const analysis = binding.analyzeSync({
    code: source,
    filename: '/fixtures/runtime-reactive-control.ts',
    options: { compilerOptions: mutedOptions },
  })
  assert.equal(
    analysis.diagnostics.some(({ code }) => code === 'FICT-R004'),
    false,
  )
})

test('derived cycles fail closed even when strict guarantees are disabled', () => {
  const result = binding.transformSync({
    code: `
      import { $state } from 'fict'
      export function App() {
        let source = $state(0)
        const first = second + source
        const second = first + 1
        return <div>{first}{second}</div>
      }
    `,
    filename: '/fixtures/derived-cycle.tsx',
    options: {
      strictGuarantee: false,
      warningLevels: { 'FICT-R-CYCLE': 'off' },
    },
  })

  assert.equal(result.code, '')
  assert.deepEqual(
    result.diagnostics.map(({ code, guaranteeClass, severity }) => ({
      code,
      guaranteeClass,
      severity,
    })),
    [{ code: 'FICT-R-CYCLE', guaranteeClass: 'unsupported', severity: 'error' }],
  )
})

test('standard decorators fail closed before emitting unsupported syntax', () => {
  const result = binding.transformSync({
    code: `
      function sealed(value: unknown) { return value }
      @sealed
      export class Service {}
    `,
    filename: '/fixtures/standard-decorator.ts',
  })

  assert.equal(result.code, '')
  assert.deepEqual(
    result.diagnostics.map(({ code, help, severity }) => ({ code, help, severity })),
    [
      {
        code: 'FICT-TS-DECORATOR-STANDARD',
        help: 'lower standard decorators with a target-compatible transform, or remove them, before native Fict compilation',
        severity: 'error',
      },
    ],
  )
})

test('reserved compiler macros fail closed without direct Fict imports', () => {
  for (const [name, source, expectedCode] of [
    [
      'unbound',
      `export function App() { let value = $state(0); return value }`,
      'FICT-HIR-MACRO-UNBOUND',
    ],
    [
      'computed-namespace',
      `import * as Fict from 'fict'; export function App() { let value = Fict['$state'](0); return value }`,
      'FICT-HIR-MACRO-NAMESPACE',
    ],
  ]) {
    const result = binding.transformSync({
      code: source,
      filename: `/fixtures/${name}-macro.tsx`,
      options: { strictGuarantee: false },
    })
    assert.equal(result.code, '', name)
    assert.deepEqual(
      result.diagnostics.map(({ code, severity }) => ({ code, severity })),
      [{ code: expectedCode, severity: 'error' }],
      name,
    )
  }

  for (const [name, source] of [
    ['local', `function $state(value) { return value }; export const value = $state(1)`],
    ['other-module', `import { $state } from 'other'; export const value = $state(1)`],
    ['other-namespace', `import * as Other from 'other'; export const value = Other['$state'](1)`],
  ]) {
    const result = binding.transformSync({
      code: source,
      filename: `/fixtures/${name}-macro.ts`,
      options: { strictGuarantee: false },
    })
    assert.notEqual(result.code, '', name)
    assert.deepEqual(result.diagnostics, [], name)
  }
})

test('same-module hook metadata protects structured reactive members', () => {
  const valid = binding.transformSync({
    code: `
      import { $memo, $state, $store } from 'fict'
      function useThing() {
        const count = $state(1)
        const doubled = $memo(() => count * 2)
        const state = $store({ value: 1 })
        return { count, doubled, state, plain: 1 }
      }
      export function App() {
        const thing = useThing()
        thing.count(2)
        thing.state.value = 2
        return [thing.count, thing.doubled, thing.state.value, thing.plain]
      }
    `,
    filename: '/fixtures/local-structured-hook-valid.tsx',
    options: { strictGuarantee: false },
  })
  assert.deepEqual(valid.diagnostics, [])
  assert.match(valid.code, /thing\.count\(2\)/)
  assert.doesNotMatch(valid.code, /thing\.count\(\)\(2\)/)
  assert.match(valid.code, /thing\.count\(\)/)
  assert.match(valid.code, /thing\.doubled\(\)/)
  assert.match(valid.code, /thing\.state\.value = 2/)

  for (const [name, mutation, expectedCode] of [
    ['memo-write', 'thing.doubled = 5', 'FICT-METADATA-READONLY'],
    ['memo-delete', 'delete thing.doubled', 'FICT-METADATA-READONLY'],
    ['signal-write', 'thing.count = 2', 'FICT-M'],
    ['store-replace', 'thing.state = { value: 2 }', 'FICT-METADATA-READONLY'],
  ]) {
    const result = binding.transformSync({
      code: `
        import { $memo, $state, $store } from 'fict'
        function useThing() {
          const count = $state(1)
          const doubled = $memo(() => count * 2)
          const state = $store({ value: 1 })
          return { count, doubled, state }
        }
        export function App() {
          const thing = useThing()
          ${mutation}
          return thing
        }
      `,
      filename: `/fixtures/local-structured-hook-${name}.tsx`,
      options: { strictGuarantee: false },
    })
    assert.equal(result.code, '', name)
    assert.ok(
      result.diagnostics.some(
        ({ code, severity }) => code === expectedCode && severity === 'error',
      ),
      `${name}: ${JSON.stringify(result.diagnostics)}`,
    )
  }
})

test('compile and analyze consume the same resolved metadata snapshot', () => {
  const code = `
    import { count, useCounter } from './dep.js'
    export function App() {
      const api = useCounter()
      return <div>{count}{api.count}</div>
    }
  `
  const metadata = [
    {
      request: './dep.js',
      resolvedId: '/fixtures/dep.js',
      status: 'resolved',
      metadata: {
        version: 1,
        exports: { count: 'signal' },
        hooks: { useCounter: { objectProps: { count: 'signal' } } },
      },
      fingerprint: 'sha256:dep',
    },
  ]
  const compilerOptions = { strictGuarantee: false }
  const compiled = binding.transformSync({
    code,
    filename: '/fixtures/metadata-consumer.tsx',
    metadata,
    options: compilerOptions,
  })
  const analyzed = binding.analyzeSync({
    code,
    filename: '/fixtures/metadata-consumer.tsx',
    metadata,
    options: { compilerOptions },
  })

  assert.deepEqual(compiled.diagnostics, [])
  assert.match(compiled.code, /count\(\)/)
  assert.match(compiled.code, /api\.count\(\)/)
  assert.deepEqual(analyzed.diagnostics, [])
  const app = analyzed.components.find(component => component.name === 'App')
  assert.ok(app)
  const dependencies = app.trace.flatMap(({ markers }) =>
    markers.flatMap(marker => marker.deps ?? []),
  )
  assert.ok(dependencies.includes('count'))
  assert.ok(dependencies.includes('api.count'))
})

test('semantic EmitIR identities preserve destructuring and authored export names', async () => {
  const destructured = await compileAndImport(
    `
      declare const ambient: number
      import { $state, render } from 'fict'

      let update = () => {}

      function App() {
        let state = $state({ count: 1, nested: { value: 2 } })
        let fallback = $state(0)
        const { count, nested: { value } } = state
        const source = {}
        const { snapshot = fallback } = source
        update = () => {
          state = { count: 3, nested: { value: 4 } }
          fallback = 5
        }
        return <p data-id="semantic-identity">{count}:{value}:{snapshot}</p>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function refresh() {
        update()
      }
    `,
    'semantic-identity-destructuring',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = destructured.mount(container)
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="semantic-identity"]')?.textContent, '1:2:0')

  destructured.refresh()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="semantic-identity"]')?.textContent, '3:4:0')
  dispose()
  container.remove()

  const exported = await compileAndImport(
    `
      import { createMemo } from '@fictjs/runtime'
      import { createSignal } from 'fict/advanced'
      const zero = createSignal(1)
      const decimal = createMemo(() => 2)
      export { zero as "0", decimal as "1.5", decimal as "00", decimal as named }
    `,
    'semantic-identity-exports',
    { diagnosticCodes: ['FICT-M001'] },
  )
  assert.equal(exported['0'](), 1)
  assert.equal(exported['1.5'](), 2)
  assert.equal(exported['00'](), 2)
  assert.equal(exported.named(), 2)

  for (const [name, source] of [
    [
      'conditional-store-destructuring',
      `
        import { $state, $store } from 'fict'
        export function App() {
          const show = $state(true)
          const store = $store({ n: 0 })
          if (show) {
            const { n } = store
            return <div>{n}</div>
          }
          return <div>OFF</div>
        }
      `,
    ],
    [
      'local-props-destructuring',
      `
        import { $effect } from 'fict'
        export function App(props) {
          const { count } = props
          $effect(() => console.log(props.count, count))
          return <div />
        }
      `,
    ],
    [
      'dangerous-export-aliases',
      `
        type Erased = { value: number }
        import { createMemo } from 'fict'
        const value = createMemo(() => 1)
        export { value as "__proto__", value as "constructor", value as "toString" }
      `,
    ],
  ]) {
    const result = binding.transformSync({
      code: source,
      filename: `/fixtures/${name}.tsx`,
      options: { strictGuarantee: false },
    })
    assert.notEqual(result.code, '', name)
    assert.deepEqual(
      result.diagnostics.filter(({ severity }) => severity === 'error'),
      [],
      name,
    )
    assert.equal(
      result.diagnostics.some(({ code }) => code.startsWith('FICT-OXC-EMIT-')),
      false,
      name,
    )
  }
})

test('derived values from destructured component props stay reactive', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let update = () => {}

      function FunctionChild({ count }) {
        const doubled = count * 2
        return <b data-id="function-derived">{doubled}</b>
      }

      const ArrowChild = ({ count }) => {
        const tripled = count * 3
        return <i data-id="arrow-derived">{tripled}</i>
      }

      function App() {
        let count = $state(1)
        update = value => (count = value)
        return <main><FunctionChild count={count} /><ArrowChild count={count} /></main>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function refresh(value) {
        update(value)
      }
    `,
    'destructured-prop-derived',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="function-derived"]')?.textContent, '2')
  assert.equal(container.querySelector('[data-id="arrow-derived"]')?.textContent, '3')

  compiled.refresh(4)
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="function-derived"]')?.textContent, '8')
  assert.equal(container.querySelector('[data-id="arrow-derived"]')?.textContent, '12')

  dispose()
  container.remove()
})

test('intrinsic children props become child content without leaking attributes', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export let api

      function App() {
        let text = $state('hello')
        api = { set: value => (text = value) }
        return (
          <section>
            <div data-id="static" children="static" />
            <div data-id="reactive" children={text} />
            <div data-id="array" children={['a', 'b']} />
            <div data-id="node" children={<span>node</span>} />
            <div data-id="conflict" children="ignored">explicit</div>
          </section>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'intrinsic-children-props',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const staticElement = container.querySelector('[data-id="static"]')
  const reactiveElement = container.querySelector('[data-id="reactive"]')
  const arrayElement = container.querySelector('[data-id="array"]')
  const nodeElement = container.querySelector('[data-id="node"]')
  const conflictElement = container.querySelector('[data-id="conflict"]')

  assert.equal(staticElement?.textContent, 'static')
  assert.equal(reactiveElement?.textContent, 'hello')
  assert.equal(arrayElement?.textContent, 'ab')
  assert.equal(nodeElement?.querySelector('span')?.textContent, 'node')
  assert.equal(conflictElement?.textContent, 'explicit')
  for (const element of [
    staticElement,
    reactiveElement,
    arrayElement,
    nodeElement,
    conflictElement,
  ]) {
    assert.equal(element?.hasAttribute('children'), false)
  }

  compiled.api.set('updated')
  await flushRuntime()
  assert.equal(reactiveElement?.textContent, 'updated')

  dispose()
  container.remove()
})

test('shared derived destructuring evaluates its initializer once per revision', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export const evaluations = []
      let update = () => {}

      function makePair(value) {
        evaluations.push(value)
        return { first: value, second: value + 1 }
      }

      function App() {
        let value = $state(1)
        const { first, second } = makePair(value)
        update = next => (value = next)
        return <p data-id="shared-destructuring">{first}:{second}</p>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function refresh(value) {
        update(value)
      }
    `,
    'shared-derived-destructuring',
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-S002'],
    },
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="shared-destructuring"]')?.textContent, '1:2')
  assert.deepEqual(compiled.evaluations, [1])

  compiled.refresh(4)
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="shared-destructuring"]')?.textContent, '4:5')
  assert.deepEqual(compiled.evaluations, [1, 4])

  dispose()
  container.remove()
})

test('raw-text and RCDATA expressions bind literal textContent', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export let api

      function App() {
        let show = $state(true)
        let css = $state('body { color: red; }')
        let draft = $state('hello')
        let color = $state('red')
        let enabled = $state(false)
        api = {
          hide: () => (show = false),
          setCss: value => (css = value),
          setDraft: value => (draft = value),
          updateMixed: value => {
            enabled = true
            color = value
          },
        }
        return (
          <section>
            <script type="application/json" data-id="script">{show && <span>code</span>}</script>
            <style data-id="style">{css}</style>
            <textarea data-id="textarea">{draft}</textarea>
            <title data-id="title">{show && <span>title</span>}</title>
            <script
              type="application/json"
              data-id="children-prop"
              children={show && <span>child</span>}
            />
            <style data-id="mixed">{'.a > .b '}{enabled && 'display:block; '}{'{'}{' color: '}{color}{null}{undefined}{false}{' }'}</style>
          </section>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'raw-text-content',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const script = container.querySelector('[data-id="script"]')
  const style = container.querySelector('[data-id="style"]')
  const textarea = container.querySelector('[data-id="textarea"]')
  const title = container.querySelector('[data-id="title"]')
  const childrenProp = container.querySelector('[data-id="children-prop"]')
  const mixed = container.querySelector('[data-id="mixed"]')
  for (const element of [script, style, textarea, title, childrenProp, mixed]) {
    assert.equal(element?.textContent.includes('fict:slot'), false)
    assert.equal(element?.textContent.includes('<!---->'), false)
  }
  assert.equal(childrenProp?.hasAttribute('children'), false)
  assert.equal(style?.textContent, 'body { color: red; }')
  assert.equal(textarea?.textContent, 'hello')
  assert.equal(textarea?.value, 'hello')
  assert.equal(mixed?.textContent, '.a > .b { color: red }')
  assert.equal(mixed?.textContent.includes('&gt;'), false)

  compiled.api.setCss('body { color: blue; }')
  compiled.api.setDraft('updated')
  compiled.api.updateMixed('blue')
  await flushRuntime()
  assert.equal(style?.textContent, 'body { color: blue; }')
  assert.equal(textarea?.textContent, 'updated')
  assert.equal(textarea?.value, 'updated')
  assert.equal(mixed?.textContent, '.a > .b display:block; { color: blue }')

  compiled.api.hide()
  await flushRuntime()
  assert.equal(script?.textContent, '')
  assert.equal(title?.textContent, '')
  assert.equal(childrenProp?.textContent, '')

  dispose()
  container.remove()
})

test('dynamic annotation-xml children use the final live encoding namespace', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'
      import { createElement } from 'fict/internal'

      export const evaluations = []
      let updateToken = () => {}

      function makeDom(id) {
        return createElement({ type: 'mi', props: { 'data-id': id, children: id } })
      }

      function Token({ id }) {
        let label = $state(id)
        updateToken = value => (label = value)
        return <mi data-id={id} data-label={label}>{label}</mi>
      }

      function App() {
        const htmlEncoding = 'text/html'
        const mathEncoding = 'application/xml'
        const htmlAttrs = { encoding: htmlEncoding }
        const mathAttrs = { encoding: mathEncoding }
        const beforeMath = { encoding: mathEncoding }
        const show = true
        const items = ['list']
        return (
          <math>
            <annotation-xml {...beforeMath} encoding={htmlEncoding}>
              <mi data-id="html-static">static</mi>
              {makeDom('html-direct')}
              {show ? makeDom('html-conditional') : null}
              {items.map(item => makeDom('html-' + item))}
              <><mi data-id="html-fragment">fragment</mi></>
              <Token id="html-component" />
            </annotation-xml>
            <annotation-xml
              encoding={(evaluations.push('dynamic-static:first'), htmlEncoding)}
              EnCoDiNg="application/xml"
            >
              <mi data-id="dynamic-static" />
            </annotation-xml>
            <annotation-xml
              encoding="application/xml"
              ENCODING={(evaluations.push('static-dynamic:last'), htmlEncoding)}
            >
              <mi data-id="static-dynamic" />
            </annotation-xml>
            <annotation-xml
              encoding={(evaluations.push('dynamic-dynamic:first'), mathEncoding)}
              ENCODING={(evaluations.push('dynamic-dynamic:last'), htmlEncoding)}
            >
              <mi data-id="dynamic-dynamic" />
            </annotation-xml>
            <annotation-xml encoding="application/xml" {...htmlAttrs}>
              <mi data-id="spread-last" />
            </annotation-xml>
            <annotation-xml {...htmlAttrs} EnCoDiNg="application/xml">
              <mi data-id="explicit-last" />
            </annotation-xml>
            <annotation-xml {...mathAttrs} EnCoDiNg={htmlEncoding}>
              <mi data-id="dynamic-after-spread" />
            </annotation-xml>
          </math>
        )
      }

      export function mount(container) {
        evaluations.length = 0
        return render(() => <App />, container)
      }

      export function update(value) {
        updateToken(value)
      }
    `,
    'dynamic-annotation-namespace',
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-J003', 'FICT-J003', 'FICT-J003', 'FICT-J003'],
    },
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const htmlNamespace = 'http://www.w3.org/1999/xhtml'
  const mathNamespace = 'http://www.w3.org/1998/Math/MathML'
  for (const id of [
    'html-static',
    'html-direct',
    'html-conditional',
    'html-list',
    'html-fragment',
    'html-component',
  ]) {
    assert.equal(container.querySelector(`[data-id="${id}"]`)?.namespaceURI, htmlNamespace, id)
  }
  for (const [id, encoding, namespace] of [
    ['dynamic-static', 'application/xml', mathNamespace],
    ['static-dynamic', 'text/html', htmlNamespace],
    ['dynamic-dynamic', 'text/html', htmlNamespace],
    ['spread-last', 'text/html', htmlNamespace],
    ['explicit-last', 'application/xml', mathNamespace],
    ['dynamic-after-spread', 'text/html', htmlNamespace],
  ]) {
    const child = container.querySelector(`[data-id="${id}"]`)
    assert.equal(child?.parentElement?.getAttribute('encoding'), encoding, `${id} encoding`)
    assert.equal(child?.namespaceURI, namespace, `${id} namespace`)
  }
  assert.deepEqual(compiled.evaluations, [
    'dynamic-static:first',
    'static-dynamic:last',
    'dynamic-dynamic:first',
    'dynamic-dynamic:last',
  ])
  const component = container.querySelector('[data-id="html-component"]')
  assert.equal(component?.getAttribute('data-label'), 'html-component')
  assert.equal(component?.textContent, 'html-component')
  compiled.update('updated')
  await flushRuntime()
  assert.equal(component?.getAttribute('data-label'), 'updated')
  assert.equal(component?.textContent, 'updated')

  dispose()
  container.remove()
})

test('native binding reports the Rust-only compiler protocol', () => {
  const info = binding.nativeCompilerInfo()
  assert.equal(info.backend, 'rust')
  assert.equal(info.compilerProtocolVersion, 1)
  assert.equal(info.metadataSchemaVersion, 1)
  assert.equal(info.oxcVersion, '0.139.0')
})

test('native pipeline follows the authored runtime helper package family', () => {
  const cases = [
    [
      'fict-only',
      `import { $state } from 'fict'; export function App() { let value = $state(0); return <div>{value}</div> }`,
      'fict/internal',
    ],
    [
      'runtime-only',
      `import { render } from '@fictjs/runtime'; export function mount(node) { return render(() => <div />, node) }`,
      '@fictjs/runtime/internal',
    ],
    [
      'mixed',
      `import { $state } from 'fict'; import { render } from '@fictjs/runtime'; export function App() { let value = $state(0); return <div>{value}</div> }`,
      'fict/internal',
    ],
    ['default', `export function App() { return <div /> }`, 'fict/internal'],
    [
      'runtime-side-effect',
      `import '@fictjs/runtime/advanced'; export function App() { return <div /> }`,
      '@fictjs/runtime/internal',
    ],
  ]

  for (const [name, code, expected] of cases) {
    const result = binding.transformSync({
      code,
      filename: `/fixtures/runtime-family-${name}.tsx`,
      options: { strictGuarantee: false },
    })
    assert.deepEqual(result.diagnostics, [], name)
    assert.match(result.code, new RegExp(`from ["']${expected}["']`), name)
    const rejected = expected === 'fict/internal' ? '@fictjs/runtime/internal' : 'fict/internal'
    assert.doesNotMatch(result.code, new RegExp(`from ["']${rejected}["']`), name)
  }
})

test('program compiler-disable preserves authored Fict syntax and wins over enable', () => {
  const result = binding.transformSync({
    code: `
      'use fict-compiler'
      'use fict-compiler-disable'
      import { $state } from 'fict'
      export enum Color { Red = 1 }
      export function App() {
        const count = $state(0)
        return <div>{count}</div>
      }
    `,
    filename: '/fixtures/compiler-disabled.tsx',
  })

  assert.deepEqual(result.diagnostics, [])
  assert.match(result.code.trimStart(), /^['"]use fict-compiler['"];/)
  assert.match(result.code, /['"]use fict-compiler-disable['"];/)
  assert.match(result.code, /\$state\(0\)/)
  assert.match(result.code, /<div>\{count\}<\/div>/)
  assert.match(result.code, /export let Color/)
  assert.doesNotMatch(result.code, /__fict|template\(/)
  assert.deepEqual(result.moduleMetadata, { exports: {}, version: 1 })
})

test('fict-ignore suppressions apply before compile and analyze escalation', () => {
  const code = `
    import { $memo } from 'fict' // fict-ignore FICT-R006
    // fict-ignore-next-line FICT-M\u2028    const value = $memo(() => { console.log('side') })
  `
  const compilerOptions = {
    strictGuarantee: false,
    warningsAsErrors: true,
  }
  const compiled = binding.transformSync({
    code,
    filename: '/fixtures/suppressed.ts',
    options: compilerOptions,
  })
  assert.notEqual(compiled.code, '')
  assert.equal(
    compiled.diagnostics.some(({ code: diagnosticCode }) => diagnosticCode === 'FICT-M003'),
    false,
  )

  const analyzed = binding.analyzeSync({
    code,
    filename: '/fixtures/suppressed.ts',
    options: { compilerOptions },
    integrationDiagnostics: [
      {
        code: 'FICT-R006',
        severity: 'warning',
        message: 'integration warning',
        primarySpan: { start: code.indexOf('import'), end: code.indexOf('import') },
        secondaryLabels: [],
        help: null,
        notes: [],
        guaranteeClass: 'advisory',
      },
    ],
  })
  assert.equal(
    analyzed.diagnostics.some(({ code: diagnosticCode }) => diagnosticCode === 'FICT-M003'),
    false,
  )
  assert.equal(
    analyzed.diagnostics.some(({ code: diagnosticCode }) => diagnosticCode === 'FICT-R006'),
    false,
  )

  const integration = binding.transformSync({
    code: `export const value = 1 // fict-ignore FICT-R006`,
    filename: '/fixtures/suppressed-integration.js',
    options: compilerOptions,
    integrationDiagnostics: [
      {
        code: 'FICT-R006',
        severity: 'warning',
        message: 'integration warning',
        primarySpan: { start: 0, end: 0 },
        secondaryLabels: [],
        help: null,
        notes: [],
        guaranteeClass: 'advisory',
      },
    ],
  })
  assert.notEqual(integration.code, '')
  assert.deepEqual(integration.diagnostics, [])
})

test('analysis indexes every ECMAScript line terminator with UTF-16 columns', () => {
  const code =
    "import { $state } from 'fict';\r" +
    'export function useCounter() {\u2028' +
    '  let count = $state(0);\u2029' +
    '  return count;\r\n' +
    '}'
  const analyzed = binding.analyzeSync({
    code,
    filename: '/fixtures/mixed-lines.ts',
  })
  assert.deepEqual(analyzed.diagnostics, [])
  const hook = analyzed.components.find(component => component.name === 'useCounter')
  assert.ok(hook)
  assert.equal(hook.endLine, 5)
  assert.ok(
    hook.trace.some(
      trace =>
        trace.line === 3 &&
        trace.markers.some(marker => marker.label === 'Signal initialization runs once'),
    ),
  )

  const broken = binding.analyzeSync({
    code: "const emoji = '😀';\rconst ok = 1;\u2028export const =",
    filename: '/fixtures/mixed-lines-broken.ts',
  })
  assert.equal(broken.diagnostics[0]?.line, 3)
  assert.ok(broken.diagnostics[0]?.column > 1)
})

test('analysis labels component, hook, and reactive-scope execution accurately', () => {
  const analyzed = binding.analyzeSync({
    code: `
      import { $state } from 'fict'
      export function App() {
        const count = $state(0)
        return <div>{count}</div>
      }
      export function useCounter() {
        const count = $state(0)
        return count
      }
      renderHook(() => {
        const count = $state(0)
        return count
      })
    `,
    filename: '/fixtures/analysis-function-kinds.tsx',
    options: { compilerOptions: { reactiveScopes: ['renderHook'] } },
  })
  assert.deepEqual(analyzed.diagnostics, [])

  const setupLabels = component =>
    component.trace.flatMap(({ markers }) => markers.map(marker => marker.label))
  const app = analyzed.components.find(component => component.name === 'App')
  const hook = analyzed.components.find(component => component.name === 'useCounter')
  assert.ok(app)
  assert.ok(hook)
  assert.ok(setupLabels(app).includes('Component setup runs on mount'))
  assert.ok(setupLabels(hook).includes('Hook body runs when called'))
  assert.ok(
    analyzed.components.some(component =>
      setupLabels(component).includes('Reactive scope callback runs when invoked'),
    ),
  )
})

test('module no-memo policy reaches top-level and nested lowering', () => {
  const result = binding.transformSync({
    code: `
      'use no memo'
      import { $state } from 'fict'
      export function App() {
        let count = $state(1)
        const doubled = count * 2
        const renderNested = () => {
          const tripled = count * 3
          return <span>{tripled}</span>
        }
        return <div>{doubled}{renderNested()}</div>
      }
    `,
    filename: '/fixtures/module-no-memo.tsx',
  })

  assert.deepEqual(result.diagnostics, [])
  assert.doesNotMatch(result.code, /__fictUseMemo/)
  assert.match(result.code, /\(\) => count\(\) \* 2/)
  assert.match(result.code, /const renderNested = \(\) => \{\s*const tripled = count\(\) \* 3/)
})

test('dev compiler mode labels authored reactive creations for DevTools', () => {
  const source = `
    import { $effect, $memo, $state } from 'fict'

    export function App() {
      let count = $state(1)
      const doubled = $memo(() => count * 2)
      $effect(() => console.log(doubled))
      return <div>{doubled}</div>
    }
  `
  const development = binding.transformSync({
    code: source,
    filename: '/fixtures/dev-option.tsx',
    options: { dev: true },
  })
  assert.deepEqual(development.diagnostics, [])
  assert.equal(development.code.match(/devToolsSource/g)?.length, 3)
  assert.match(development.code, /devToolsSource:\s*"\/fixtures\/dev-option\.tsx:5:\d+"/)
  assert.match(development.code, /devToolsSource:\s*"\/fixtures\/dev-option\.tsx:6:\d+"/)
  assert.match(development.code, /devToolsSource:\s*"\/fixtures\/dev-option\.tsx:7:\d+"/)

  const production = binding.transformSync({
    code: source,
    filename: '/fixtures/dev-option.tsx',
    options: { dev: false },
  })
  assert.deepEqual(production.diagnostics, [])
  assert.doesNotMatch(production.code, /devToolsSource/)
})

test('lazyConditional false preserves authored control-flow returns', () => {
  const source = `
    import { $state } from 'fict'
    export function App() {
      const count = $state(0)
      if (count > 10) return <Big />
      return <Small />
    }
  `
  const enabled = binding.transformSync({
    code: source,
    filename: '/fixtures/lazy-conditional.tsx',
  })
  assert.deepEqual(enabled.diagnostics, [])
  assert.match(enabled.code, /createConditional\(\(\) => count\(\) > 10/)

  const disabled = binding.transformSync({
    code: source,
    filename: '/fixtures/lazy-conditional.tsx',
    options: { lazyConditional: false },
  })
  assert.deepEqual(disabled.diagnostics, [])
  assert.doesNotMatch(disabled.code, /createConditional/)
  assert.match(disabled.code, /if \(count\(\) > 10\)/)
})

test('else-if chains and switch returns rerender reactively', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setElseIf = () => {}
      let setSwitch = () => {}

      function ElseIfApp() {
        let mode = $state(0)
        setElseIf = value => (mode = value)
        if (mode === 0) return <p data-id="else-if">zero</p>
        else if (mode === 1) return <p data-id="else-if">one</p>
        else return <p data-id="else-if">many</p>
      }

      function SwitchApp() {
        let mode = $state(0)
        setSwitch = value => (mode = value)
        switch (mode) {
          case 0: return <p data-id="switch">zero</p>
          case 1: return <p data-id="switch">one</p>
          default: return <p data-id="switch">many</p>
        }
      }

      function App() {
        return <main><ElseIfApp /><SwitchApp /></main>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function refresh(value) {
        setElseIf(value)
        setSwitch(value)
      }
    `,
    'compound-conditional-returns',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  for (const [mode, expected] of [
    [0, 'zero'],
    [1, 'one'],
    [2, 'many'],
    [0, 'zero'],
  ]) {
    compiled.refresh(mode)
    await flushRuntime()
    assert.equal(container.querySelector('[data-id="else-if"]')?.textContent, expected)
    assert.equal(container.querySelector('[data-id="switch"]')?.textContent, expected)
  }

  dispose()
  container.remove()
})

test('getterCache controls safe repeated synchronous accessor reads', async () => {
  const source = `
    import { $memo, $state } from 'fict'
    export function useGetterCache() {
      const count = $state(1)
      const doubled = $memo(() => count * 2)
      const repeated = (__cached_count_0) => count + count + count + __cached_count_0
      const functionRepeated = function () { return count + count + count }
      const memoRepeated = () => doubled + doubled + doubled
      const segmented = () => count + count + count + touch() + count + count + count
      const branch = (ok) => ok ? count + count : 0
      const asynchronous = async () => count + count
      const generated = function* () { return count + count }
      const written = () => { count = 2; return count + count }
      return {
        repeated, functionRepeated, memoRepeated, segmented, branch,
        asynchronous, generated, written
      }
    }
  `
  const enabled = binding.transformSync({
    code: source,
    filename: '/fixtures/getter-cache.ts',
  })
  assert.deepEqual(enabled.diagnostics, [])
  const cacheName = enabled.code.match(/let (__cached_count_\d+);/)?.[1]
  assert.equal(cacheName, '__cached_count_1')
  assert.match(enabled.code, new RegExp(`${cacheName} = count\\(\\)`))
  assert.match(enabled.code, /let __cached_count_2;/)
  assert.match(enabled.code, /let __cached_count_3;/)
  assert.equal(enabled.code.match(/let __cached_count_/g)?.length, 3)
  assert.equal(enabled.code.match(/= count\(\)/g)?.length, 4)
  assert.doesNotMatch(enabled.code, /__cached_doubled_/)

  const disabled = binding.transformSync({
    code: source,
    filename: '/fixtures/getter-cache.ts',
    options: { getterCache: false },
  })
  assert.deepEqual(disabled.diagnostics, [])
  assert.doesNotMatch(disabled.code, /let __cached_count_/)

  const runtime = await compileAndImport(
    `
      import { $state, render } from 'fict'
      let runCase = () => ''
      function App() {
        let count = $state(1)
        const touch = () => { count = 2; return 'touch' }
        runCase = () => count + ':' + count + ':' + touch() + ':' + count + ':' + count
        return <span />
      }
      export const mount = container => render(() => <App />, container)
      export const run = () => runCase()
    `,
    'getter-cache-runtime',
  )
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = runtime.mount(container)
  await flushRuntime()
  assert.equal(runtime.run(), '1:1:touch:2:2')
  dispose()
  container.remove()
})

test('optimizeLevel full applies opt-in authored algebraic folding safely', async () => {
  const source = `
    export function probe(x, check) {
      const a = 2 + 3
      const b = a + 0
      return [b, true && x, - -x, x + 0, x * 0, check() ? 7 : 7, 0 === -0]
    }

    export function negativeZero() {
      const direct = -0
      const propagated = direct
      const product = 0 * -1
      const positive = -0 + 0
      return [
        Object.is(direct, -0),
        Object.is(propagated, -0),
        1 / propagated,
        Object.is(product, -0),
        Object.is(positive, -0),
      ]
    }

    export function shorthand() {
      const value = 2 + 3
      return { value }
    }

    export function shadowedUndefined(undefined) {
      return undefined ?? 9
    }

    export function branchEffects(select) {
      const log = []
      const left = () => { log.push('left'); return 1 }
      const right = () => { log.push('right'); return 1 }
      const value = select ? (left(), 7) : (right(), 7)
      return [value, log.join(',')]
    }

    export function switchTdz(which) {
      switch (which) {
        case 0:
          const local = 5
          return local
        case 1:
          try { return local } catch (error) { return error instanceof ReferenceError }
      }
    }
  `
  const safe = binding.transformSync({
    code: source,
    filename: '/fixtures/optimize-full.ts',
    options: { optimizeLevel: 'safe' },
  })
  assert.deepEqual(safe.diagnostics, [])
  assert.match(safe.code, /const a = 2 \+ 3/)
  assert.match(safe.code, /true && x/)
  assert.match(safe.code, /- -x/)

  const full = binding.transformSync({
    code: source,
    filename: '/fixtures/optimize-full.ts',
    options: { optimizeLevel: 'full' },
  })
  assert.deepEqual(full.diagnostics, [])
  assert.match(full.code, /const a = 5/)
  assert.match(full.code, /const b = 5/)
  assert.match(full.code, /check\(\), 7/)
  assert.match(full.code, /x \+ 0/)
  assert.match(full.code, /x \* 0/)
  assert.doesNotMatch(full.code, /true && x/)
  assert.doesNotMatch(full.code, /- -x/)
  assert.match(full.code, /return \{\s*value\s*\}/)
  assert.match(full.code, /return undefined \?\? 9/)
  assert.match(full.code, /select \? \(left\(\), 7\) : \(right\(\), 7\)/)
  assert.match(full.code, /case 1:[\s\S]*return local/)

  const disabled = binding.transformSync({
    code: source,
    filename: '/fixtures/optimize-full-disabled.ts',
    options: { optimize: false, optimizeLevel: 'full' },
  })
  assert.deepEqual(disabled.diagnostics, [])
  assert.match(disabled.code, /const a = 2 \+ 3/)

  const runtime = await compileAndImport(source, 'optimize-full-runtime', {
    options: { optimizeLevel: 'full' },
  })
  let checks = 0
  assert.deepEqual(
    runtime.probe(4, () => (++checks, false)),
    [5, 4, 4, 4, 0, 7, true],
  )
  assert.equal(checks, 1)
  assert.deepEqual(runtime.negativeZero(), [true, true, -Infinity, true, false])
  assert.deepEqual(runtime.shorthand(), { value: 5 })
  assert.equal(runtime.shadowedUndefined(3), 3)
  assert.deepEqual(runtime.branchEffects(true), [7, 'left'])
  assert.deepEqual(runtime.branchEffects(false), [7, 'right'])
  assert.equal(runtime.switchTdz(0), 5)
  assert.equal(runtime.switchTdz(1), true)

  const dynamicScope = binding.transformSync({
    code: `
      let result
      const value = 1
      with ({ value: 2, undefined: 3 }) {
        result = [value, undefined ?? 9]
      }
    `,
    filename: '/fixtures/optimize-full-with.js',
    moduleKind: 'script',
    options: { optimizeLevel: 'full' },
  })
  assert.deepEqual(dynamicScope.diagnostics, [])
  assert.match(dynamicScope.code, /result = \[\s*value,\s*undefined \?\? 9\s*\]/)
  assert.deepEqual(new Function(`${dynamicScope.code}\nreturn result`)(), [2, 3])
})

test('use pure drives DCE and CSE while preserving mutation and coercion barriers', async () => {
  const source = `
    "use pure"

    export function probe() {
      const log = []
      const object = { value: 1 }
      const read = argument => {
        log.push(object.value)
        return object.value + (argument ?? 0)
      }
      const first = read()
      const second = read()
      object.value = 99
      const third = read()
      let written = 0
      const preserved = read(written = 7)
      return [first, second, third, preserved, written, log]
    }

    export function aliasBarrier() {
      const object = { value: 1 }
      const alias = object
      const before = object.value
      alias.value = 3
      const after = object.value
      return [before, after]
    }

    export function destructuringBarrier() {
      const object = { value: 1 }
      const source = {
        get value() {
          object.value = 5
          return 0
        },
      }
      const before = object.value
      const { value } = source
      const after = object.value
      return [before, value, after]
    }

    export function coercionBarrier() {
      const value = {
        toString() {
          throw new Error('coerced')
        },
      }
      const unused = String(value)
      return 1
    }

    export function spreadBarrier() {
      const source = {
        get value() {
          throw new Error('spread getter')
        },
      }
      const unused = { ...source }
      return 1
    }
  `
  const transformed = binding.transformSync({
    code: source,
    filename: '/fixtures/function-pure-runtime.js',
  })
  assert.deepEqual(transformed.diagnostics, [])
  assert.equal(transformed.code.match(/read\(\)/g)?.length, 2)
  assert.match(transformed.code, /const second = first/)
  assert.match(transformed.code, /const preserved = read\(written = 7\)/)

  const disabled = binding.transformSync({
    code: source,
    filename: '/fixtures/function-pure-runtime-disabled.js',
    options: { optimize: false },
  })
  assert.deepEqual(disabled.diagnostics, [])
  assert.equal(disabled.code.match(/read\(\)/g)?.length, 3)

  const runtime = await compileAndImport(source, 'function-pure-runtime')
  assert.deepEqual(runtime.probe(), [1, 1, 99, 106, 7, [1, 99, 99]])
  assert.deepEqual(runtime.aliasBarrier(), [1, 3])
  assert.deepEqual(runtime.destructuringBarrier(), [1, 0, 5])
  assert.throws(() => runtime.coercionBarrier(), /coerced/)
  assert.throws(() => runtime.spreadBarrier(), /spread getter/)

  const memo = binding.transformSync({
    code: `
      import { $memo } from 'fict'
      export function probe() {
        "use pure"
        const unused = $memo(() => 1)
        return 1
      }
    `,
    filename: '/fixtures/function-pure-memo.js',
  })
  assert.deepEqual(
    memo.diagnostics.map(diagnostic => diagnostic.code),
    ['FICT-M001'],
  )
  assert.doesNotMatch(memo.code, /__fictUse(?:Memo|Context)/)
  assert.doesNotMatch(memo.code, /fict\/internal/)

  const effect = binding.transformSync({
    code: `
      import { createEffect } from '@fictjs/runtime'
      export function probe() {
        "use pure"
        const unused = createEffect(() => 1)
        return 1
      }
    `,
    filename: '/fixtures/function-pure-effect.js',
  })
  assert.deepEqual(
    effect.diagnostics.map(diagnostic => diagnostic.code),
    ['FICT-E001'],
  )
  assert.match(effect.code, /createEffect\(\(\) => 1\)/)
})

test('configured reactive scopes accept member, optional member, and global hosts', () => {
  const result = binding.transformSync({
    code: `
      import { $state } from 'fict'
      import * as utils from './host.js'

      utils.renderHook(() => {
        const member = $state(1)
        return member
      })
      utils?.renderHook(() => {
        const optional = $state(2)
        return optional
      })
      globalRenderHook(() => {
        const global = $state(3)
        return global
      })
    `,
    filename: '/fixtures/configured-reactive-scopes.js',
    options: { reactiveScopes: ['renderHook', 'globalRenderHook'] },
  })
  assert.deepEqual(result.diagnostics, [])
  assert.match(result.code, /utils\.renderHook\(\(\) =>/)
  assert.match(result.code, /utils\?\.renderHook\(\(\) =>/)
  assert.match(result.code, /globalRenderHook\(\(\) =>/)
  assert.equal(result.code.match(/__fictUseSignal\(/g)?.length, 3)
})

test('native binding honors derived memo inline policy', () => {
  const source = `
    import { $state } from 'fict'
    export function Counter() {
      let count = $state(2)
      const doubled = count * 2
      return doubled
    }
  `
  const transform = (code, inlineDerivedMemos) =>
    binding.transformSync({
      code,
      filename: '/fixtures/inline-derived.ts',
      options: { inlineDerivedMemos },
    })

  const enabled = transform(source, true)
  assert.deepEqual(enabled.diagnostics, [])
  assert.match(enabled.code, /return count\(\) \* 2/)
  assert.doesNotMatch(enabled.code, /__fictUseMemo/)

  const disabled = transform(source, false)
  assert.deepEqual(disabled.diagnostics, [])
  assert.match(disabled.code, /const doubled = __fictUseMemo/)
  assert.match(disabled.code, /return doubled\(\)/)

  const generated = transform(source.replaceAll('doubled', '__doubled'), false)
  assert.deepEqual(generated.diagnostics, [])
  assert.match(generated.code, /return count\(\) \* 2/)
  assert.doesNotMatch(generated.code, /__fictUseMemo/)
})
