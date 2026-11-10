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

for (const fineGrainedDom of [true, false]) {
  test(`bug 2: bigint children render and update (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let count = $state(1n)
        return <div><button onClick={() => count++}>inc</button>
          <p>{count}</p><b>{0n}</b><i>{[2n, 3n]}</i></div>
      }
      export function mount(container) { root = container; return render(() => <App />, root) }
      export function observe() { return ['p','b','i'].map(tag => root.querySelector(tag).textContent) }
    `,
      { fineGrainedDom },
    )
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
      { label: 'initial', value: ['1', '0', '23'] },
      { label: 'updated', value: ['2', '0', '23'] },
    ])
  })
}
