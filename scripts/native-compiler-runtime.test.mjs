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

async function compileAndImport(source, name) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
  })
  assert.deepEqual(result.diagnostics, [], result.diagnostics.map(item => item.message).join('\n'))
  assert.match(result.code, /createKeyedList/)

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
