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
      if (show) {
        {
          events.push('on')
          const label = count + 1
          var __fictMig004Hoisted = 'LOCAL'
          events.push('on:' + __fictMig004Hoisted)
          return <p data-id="conditional-return">{label}</p>
        }
      }
      const label = count + 10
      events.push(
        'off:' +
          typeof __fictMig004Hoisted +
          ':' +
          (__fictMig004Hoisted ?? 'local-undefined'),
      )
      return <p data-id="conditional-return">{label}</p>
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update() {
      toggle()
    }
  `
  const compiled = await compileAndImport(source, 'conditional-return-statements')
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="conditional-return"]')?.textContent, '2')
  assert.deepEqual(compiled.events, ['on', 'on:LOCAL'])

  compiled.update()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="conditional-return"]')?.textContent, '12')
  assert.deepEqual(compiled.events, ['on', 'on:LOCAL', 'off:undefined:local-undefined'])

  compiled.update()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="conditional-return"]')?.textContent, '4')
  assert.deepEqual(compiled.events, [
    'on',
    'on:LOCAL',
    'off:undefined:local-undefined',
    'on',
    'on:LOCAL',
  ])

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

test('raw-text and RCDATA expressions bind literal textContent', async () => {
  const compiled = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export let api

      function App() {
        let show = $state(true)
        let css = $state('body { color: red; }')
        let color = $state('red')
        let enabled = $state(false)
        api = {
          hide: () => (show = false),
          setCss: value => (css = value),
          updateMixed: value => {
            enabled = true
            color = value
          },
        }
        return (
          <section>
            <script type="application/json" data-id="script">{show && <span>code</span>}</script>
            <style data-id="style">{css}</style>
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
  const title = container.querySelector('[data-id="title"]')
  const childrenProp = container.querySelector('[data-id="children-prop"]')
  const mixed = container.querySelector('[data-id="mixed"]')
  for (const element of [script, style, title, childrenProp, mixed]) {
    assert.equal(element?.textContent.includes('fict:slot'), false)
  }
  assert.equal(childrenProp?.hasAttribute('children'), false)
  assert.equal(style?.textContent, 'body { color: red; }')
  assert.equal(mixed?.textContent, '.a > .b { color: red }')
  assert.equal(mixed?.textContent.includes('&gt;'), false)

  compiled.api.setCss('body { color: blue; }')
  compiled.api.updateMixed('blue')
  await flushRuntime()
  assert.equal(style?.textContent, 'body { color: blue; }')
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

test('native binding rejects unimplemented non-default compiler options', () => {
  for (const [name, value] of [
    ['dev', true],
    ['lazyConditional', false],
    ['getterCache', false],
    ['optimizeLevel', 'full'],
    ['inlineDerivedMemos', false],
  ]) {
    const result = binding.transformSync({
      code: 'export const value = 1',
      filename: `/fixtures/unimplemented-${name}.ts`,
      options: { [name]: value },
    })
    assert.equal(result.code, '', name)
    assert.equal(result.diagnostics.length, 1, name)
    assert.equal(result.diagnostics[0].code, 'FICT-OPTION-UNIMPLEMENTED', name)
    assert.match(result.diagnostics[0].message, new RegExp(name), name)
  }
})
