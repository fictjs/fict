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

test('native binding reports the Rust-only compiler protocol', () => {
  const info = binding.nativeCompilerInfo()
  assert.equal(info.backend, 'rust')
  assert.equal(info.compilerProtocolVersion, 1)
  assert.equal(info.metadataSchemaVersion, 1)
  assert.equal(info.oxcVersion, '0.139.0')
})
