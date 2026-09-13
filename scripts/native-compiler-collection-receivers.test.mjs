import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const binding = require(path.join(root, 'target/release/fict_compiler_napi.node'))
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
let dom
const files = []
before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'Document',
    'DocumentFragment',
    'Text',
    'Comment',
    'Event',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
      writable: true,
    })
  }
})
after(async () => {
  dom.window.close()
  await Promise.all(files.map(file => unlink(file)))
})

const profiles = [
  { optimize: false },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(options => [true, false].map(fineGrainedDom => ({ ...options, fineGrainedDom })))
const compile = (code, options = {}) =>
  binding.transformSync({
    code,
    filename: '/fixtures/collection-receivers.tsx',
    options: { strictGuarantee: true, dev: false, ...options },
  })
const load = async (id, source, options = {}) => {
  const result = compile(source, options)
  assert.deepEqual(result.diagnostics, [])
  const file = path.join(root, `packages/fict/.native-collection-${process.pid}-${id}.mjs`)
  files.push(file)
  await writeFile(file, result.code)
  return import(pathToFileURL(file).href)
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
const source = `
  import { $state, render } from 'fict'
  export function Collection() {
    let rows: { id: number; label: string }[] = $state([{id: 1, label: 'A'}, {id: 2, label: 'B'}])
    let index = $state(0)
    const chosen = rows[index]
    const swap = () => {
      const list = rows
      const copy = list.slice()
      const previous = copy[0]
      copy[0] = copy[1]
      copy[1] = previous
      rows = copy
    }
    const remove = () => {
      const list = rows
      const position = list.findIndex(row => row.id === 1)
      if (position < 0) return
      const copy = list.slice()
      copy.splice(position, 1)
      rows = copy
    }
    const replace = () => { rows = [{ id: 2, label: 'B replaced' }] }
    return <section>
      <button data-action="swap" onClick={swap}>Swap</button>
      <button data-action="remove" onClick={remove}>Remove</button>
      <button data-action="replace" onClick={replace}>Replace</button>
      <button data-action="index" onClick={() => index = index ? 0 : 1}>Choose row</button>
      <p>{chosen?.label ?? 'empty'}:{rows.length}</p>
      <ul>{rows.map(row => <li key={row.id}>{row.label}</li>)}</ul>
    </section>
  }
  export const mount = container => render(() => <Collection />, container)
`

for (const [index, profile] of profiles.entries()) {
  test(`typed array copies and dynamic reads preserve live consumers (${index})`, async t => {
    const fixture = await load(index, source, profile)
    const container = document.createElement('div')
    document.body.append(container)
    const dispose = fixture.mount(container)
    t.after(() => {
      dispose()
      container.remove()
    })
    await settle()
    const click = async action => {
      container.querySelector(`[data-action="${action}"]`).click()
      await settle()
    }
    const first = container.querySelectorAll('li')[0]
    const second = container.querySelectorAll('li')[1]
    assert.equal(container.querySelector('p').textContent, 'A:2')
    await click('index')
    assert.equal(container.querySelector('p').textContent, 'B:2')
    await click('index')
    assert.equal(container.querySelector('p').textContent, 'A:2')
    await click('swap')
    assert.equal(container.querySelector('p').textContent, 'B:2')
    assert.deepEqual(
      [...container.querySelectorAll('li')].map(row => row.textContent),
      ['B', 'A'],
    )
    // The direct DOM backend lowers map to a keyed owner; the generic VNode
    // backend preserves its existing array replacement behavior.
    if (profile.fineGrainedDom) {
      assert.equal(container.querySelectorAll('li')[0], second)
      assert.equal(container.querySelectorAll('li')[1], first)
    }
    await click('swap')
    await click('remove')
    assert.equal(container.querySelector('p').textContent, 'B:1')
    await click('replace')
    assert.equal(container.querySelector('p').textContent, 'B replaced:1')
    assert.equal(container.querySelector('li').textContent, 'B replaced')
    dispose()
    assert.equal(container.childNodes.length, 0)
    container.remove()
  })
}

const signalRows = `
  import { $state, render, createSelector, untrack, batch, onCleanup } from 'fict'
  import { createSignal, type Signal } from 'fict/advanced'
  export const cleanups = []
  function SignalRow(props) {
    const id = untrack(() => '' + props.row.id)
    onCleanup(() => cleanups.push(id))
    return <li class={props.isSelected(+id) ? 'selected' : ''} textContent={props.row.label()} />
  }
  export function SignalRows() {
    let rows: {id: number; label: Signal<string>}[] = $state([
      {id: 1, label: createSignal('A')}, {id: 2, label: createSignal('B')}
    ])
    let selected = $state(1)
    const isSelected = createSelector(() => selected)
    const original = untrack(() => rows[0])
    const update = () => batch(() => untrack(() => {
      for (let i = 0, current = rows; i < current.length; i++) {
        const label = current[i].label
        label(label() + '!')
      }
    }))
    return <section>
      <button data-action="update" onClick={update}>Update</button>
      <button data-action="replace" onClick={() => rows = [{id: 1, label: createSignal('fresh')}, rows[1]]}>Replace</button>
      <button data-action="old" onClick={() => original.label('old changed')}>Old</button>
      <button data-action="select" onClick={() => selected = 2}>Select</button>
      <button data-action="clear" onClick={() => rows = []}>Clear</button>
      <ul>{rows.map(row => <SignalRow key={row.id} row={row} isSelected={isSelected} />)}</ul>
    </section>
  }
  export const mount = container => render(() => <SignalRows />, container)
`
for (const [index, profile] of profiles.filter(options => options.fineGrainedDom).entries()) {
  test(`per-row accessors update across keyed replacement and dispose (${index})`, async t => {
    const fixture = await load(`signals-${index}`, signalRows, profile)
    const container = document.createElement('div')
    document.body.append(container)
    const dispose = fixture.mount(container)
    t.after(() => {
      dispose()
      container.remove()
    })
    await settle()
    const click = async action => {
      container.querySelector(`[data-action="${action}"]`).click()
      await settle()
    }
    const nodes = [...container.querySelectorAll('li')]
    const labels = () => [...container.querySelectorAll('li')].map(row => row.textContent)
    assert.deepEqual(labels(), ['A', 'B'])
    assert.equal(nodes[0].className, 'selected')
    await click('update')
    assert.deepEqual(labels(), ['A!', 'B!'])
    await click('replace')
    assert.deepEqual(labels(), ['fresh', 'B!'])
    assert.equal(container.querySelectorAll('li')[0], nodes[0])
    assert.equal(container.querySelectorAll('li')[1], nodes[1])
    await click('old')
    assert.deepEqual(labels(), ['fresh', 'B!'])
    await click('update')
    assert.deepEqual(labels(), ['fresh!', 'B!!'])
    await click('select')
    assert.equal(nodes[0].className, '')
    assert.equal(nodes[1].className, 'selected')
    assert.deepEqual(fixture.cleanups, [])
    await click('clear')
    assert.deepEqual(labels(), [])
    assert.deepEqual([...fixture.cleanups].sort(), ['1', '2'])
    await click('old')
    assert.equal(container.querySelectorAll('li').length, 0)
    dispose()
    assert.deepEqual([...fixture.cleanups].sort(), ['1', '2'])
    assert.equal(container.childNodes.length, 0)
  })
}

test('the maintained optimized benchmark compiles without guarantee opt-outs', async () => {
  const fixture = await readFile(
    path.join(root, 'scripts/fixtures/runtime-benchmark/main.tsx'),
    'utf8',
  )
  for (const profile of profiles) assert.deepEqual(compile(fixture, profile).diagnostics, [])
})

test('collection proofs retain nested mutation, unknown receiver and escape boundaries', () => {
  const cases = [
    [
      'let rows: {value: number}[] = $state([{value: 1}]); const copy = rows.slice(); copy[0].value++;',
      'FICT-M',
    ],
    ['let rows: number[] = $state([1]); const alias = rows; alias[0] = 2;', 'FICT-M'],
    [
      'let rows = $state([{value: 1, slice() { return this }}]); const copy = rows[0].slice(); copy.value++;',
      'FICT-M',
    ],
    [
      'let rows = $state([1]); rows = props.unknown(); const alias = rows; alias.map(x => x);',
      'FICT-M',
    ],
    [
      'let rows: number[] = $state([1]); const alias = rows; alias.slice = function () { return this }; const copy = alias.slice(); copy[0] = 2;',
      'FICT-M',
    ],
    [
      'let rows: number[] = $state([1]); Array.prototype.slice = function () { return this }; const alias = rows; const copy = alias.slice(); copy[0] = 2;',
      'FICT-M',
    ],
    [
      'let rows: number[] = $state([1]); const alias = rows; alias.constructor = props.constructor; const copy = alias.slice(); copy[0] = 2;',
      'FICT-M',
    ],
    [
      'let rows: {value: number}[] = $state([{value: 1}]); const copy = rows.slice(); props.escape(copy[0]);',
      'FICT-R002',
    ],
    [
      'let rows: {value: number}[] = $state([{value: 1}]); const copy = rows.slice(); copy.splice(0, 0, () => rows[0].value);',
      'FICT-R005',
    ],
    [
      'let rows: {value: number}[] = $state([{value: 1}]); const position = rows.find(row => true); const copy = rows.slice(); copy.splice(position, 1);',
      'FICT-R002',
    ],
    [
      'let rows: number[] = $state([1]); const copy = rows.slice(); copy.splice = props.splice; const position = rows.findIndex(row => row === 1); copy.splice(position, 1);',
      'FICT-R002',
    ],
    ['let index = $state(0); const rows = props.rows; const value = rows[index];', 'FICT-H'],
  ]
  for (const [setup, code] of cases) {
    const result = compile(
      `import {$state} from 'fict'; export function Collection(props) { ${setup} return <div/> }`,
    )
    assert.ok(
      result.diagnostics.some(d => d.code === code && d.severity === 'error'),
      `${setup}\n${JSON.stringify(result.diagnostics)}`,
    )
    assert.equal(result.code, '')
  }
})
