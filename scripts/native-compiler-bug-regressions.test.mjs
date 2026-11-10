import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const native = require('../target/release/fict_compiler_napi.node')

function compile(code, options = {}) {
  const result = native.transformSync({
    code,
    filename: '/bug-regressions.tsx',
    moduleKind: 'commonjs',
    options: { dev: false, strictGuarantee: true, ...options },
  })
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.code)
  return result.code
}

for (const detached of [false, true]) {
  test(`bug 1: keyed rows and refs exist synchronously at mount (detached=${detached})`, async () => {
    const code = compile(`
      import { $state, render, onMount } from 'fict'
      let root, atMount, afterRender, rowMounts = []
      const refs = []
      function Row(props) {
        let element
        onMount(() => { rowMounts.push(root.contains(element)) })
        return <li ref={el => { element = el; refs[props.id] = el }}>{props.id}</li>
      }
      function App() {
        let items = $state([0, 1])
        onMount(() => { atMount = [root.querySelectorAll('li').length, refs.length] })
        return <div><button onClickCapture={() => { items = [...items, items.length] }}>add</button>
          <ul>{items.map(id => <Row key={id} id={id} />)}</ul></div>
      }
      export function mount(container) {
        if (${detached}) container.remove()
        root = container
        const dispose = render(() => <App />, root)
        afterRender = root.querySelector('ul').textContent
        return dispose
      }
      export function observe() {
        return { atMount, afterRender, text: root.querySelector('ul').textContent, rowMounts }
      }
    `)
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'initial',
        value: { atMount: [2, 2], afterRender: '01', text: '01', rowMounts: [true, true] },
      },
      {
        label: 'updated',
        value: { atMount: [2, 2], afterRender: '01', text: '012', rowMounts: [true, true, true] },
      },
    ])
  })
}
