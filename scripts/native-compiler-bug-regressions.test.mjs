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

for (const expression of [
  'name ? <Profile name={name} /> : <i>login</i>',
  'name && <Profile name={name} />',
]) {
  test(`bug 31: truthy updates preserve conditional component identity (${expression})`, async () => {
    const code = compile(`
      import { $state, render, onMount } from 'fict'
      let root, first, mounts = 0
      function Profile(props) {
        let edits = $state(0)
        onMount(() => { mounts++ })
        return <b onClick={() => edits++}>{props.name}:{edits}</b>
      }
      function App() {
        let name = $state('ann')
        return <div><button onClick={() => { name += '!' }}>rename</button>
          <section>{${expression}}</section></div>
      }
      export function mount(container) {
        root = container
        const dispose = render(() => <App />, root)
        first = root.querySelector('b')
        return dispose
      }
      export function observe() {
        return { text: root.querySelector('b').textContent, same: root.querySelector('b') === first, mounts }
      }
    `)
    assert.match(code, /createConditional/)
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'click', selector: 'b' },
        { kind: 'click', selector: 'b' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'renamed' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'renamed', value: { text: 'ann!:2', same: true, mounts: 1 } },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 39: empty text hydrates strictly and updates (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root, first, preserved
      const issues = []
      function App() {
        let n = $state(1)
        return <div><button onClick={() => n++}>inc</button>
          {n > 0 && <span>{n} item{n !== 1 ? 's' : ''} left</span>}</div>
      }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App />)
        first = root.querySelector('span')
        const dispose = hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => { issues.push(issue.code) } })
        preserved = root.querySelector('span') === first
        return dispose
      }
      export function observe() { return { text: root.querySelector('span').textContent, same: preserved, issues } }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'hydrated' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'hydrated', value: { text: '1 item left', same: true, issues: [] } },
      { label: 'updated', value: { text: '2 items left', same: true, issues: [] } },
    ])
  })
}

for (const initial of ['x', '']) {
  test(`bug 9: adjacent dynamic text claims SSR nodes (initial=${JSON.stringify(initial)})`, async () => {
    const code = compile(`
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root
      const issues = []
      function Pair(props) { return <><b>{props.a}</b><i>!</i></> }
      function App() {
        let a = $state(${JSON.stringify(initial)}), b = $state(1)
        const rows = [1, 2]
        return <div><button onClick={() => { a += 'y'; b++ }}>inc</button>
          <p>{a}{b}{a}</p><p>{a} {b}</p><p><b>static</b>{b}</p>
          <p>{b > 0 && <i>yes</i>}{b}</p><p><Pair a={a}/>{b}</p>
          <ul>{rows.map(k => <li key={k}>{k}{b}</li>)}</ul>
        </div>
      }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App />)
        return hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => { issues.push(issue.code) } })
      }
      export function observe() { return { text: Array.from(root.querySelectorAll('p,li'), element => element.textContent), issues } }
    `)
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'hydrated' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'hydrated',
        value: {
          text: [
            `${initial}1${initial}`,
            `${initial} 1`,
            'static1',
            'yes1',
            `${initial}!1`,
            '11',
            '21',
          ],
          issues: [],
        },
      },
      {
        label: 'updated',
        value: {
          text: [
            `${initial}y2${initial}y`,
            `${initial}y 2`,
            'static2',
            'yes2',
            `${initial}y!2`,
            '12',
            '22',
          ],
          issues: [],
        },
      },
    ])
  })
}

for (const control of ['if', 'switch']) {
  test(`bug 32: ${control} return ranges hydrate and switch branches`, async () => {
    const small = `<div><button onClick={() => { n = (n + 1) % 3 }}>next</button>small{n}</div>`
    const big = `<p><button onClick={() => { n = (n + 1) % 3 }}>next</button>big{n}</p>`
    const body =
      control === 'if'
        ? `if (n > 1) return ${big}; return ${small}`
        : `switch(n) { case 2: return ${big}; default: return ${small} }`
    const code = compile(`
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root, preserved
      const issues = []
      function App() { let n = $state(0); ${body} }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App />)
        const first = root.querySelector('button')
        const dispose = hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => { issues.push(issue.code) } })
        preserved = root.querySelector('button') === first
        return dispose
      }
      export function observe() { return { text: root.textContent, preserved, issues } }
    `)
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'hydrated' },
        { kind: 'click', selector: 'button' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'big' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'small' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'hydrated', value: { text: 'nextsmall0', preserved: true, issues: [] } },
      { label: 'big', value: { text: 'nextbig2', preserved: true, issues: [] } },
      { label: 'small', value: { text: 'nextsmall0', preserved: true, issues: [] } },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 34: context providers hydrate their live subtree (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, createContext, useContext, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      const Theme = createContext('default')
      let root, preserved
      const issues = []
      function Leaf() { const theme = useContext(Theme); return ${fineGrainedDom ? '<span>leaf:{theme}</span>' : '<span>leaf:<em>{theme}</em></span>'} }
      function App() {
        let theme = $state('dark')
        return <div><button onClick={() => { theme = 'light' }}>light</button>
          <Theme.Provider value={theme}><Leaf/><b>static</b>
            <Theme.Provider value="inner"><Leaf/></Theme.Provider>
          </Theme.Provider><i>tail</i></div>
      }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App />)
        const first = root.querySelector('span')
        const dispose = hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => { issues.push(issue.code) } })
        preserved = root.querySelector('span') === first
        return dispose
      }
      export function observe() { return { text: root.textContent, preserved, issues } }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'hydrated' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'hydrated',
        value: { text: 'lightleaf:darkstaticleaf:innertail', preserved: true, issues: [] },
      },
      {
        label: 'updated',
        value: { text: 'lightleaf:lightstaticleaf:innertail', preserved: true, issues: [] },
      },
    ])
  })
}

for (const Boundary of ['Suspense', 'ErrorBoundary']) {
  for (const fineGrainedDom of [true, false]) {
    test(`bug 23: ${Boundary} direct children remain reactive (fineGrainedDom=${fineGrainedDom})`, async () => {
      const code = compile(
        `
        import { $state, render, ${Boundary} } from 'fict'
        let root
        function A() { return <b>A</b> }
        function B() { return <b>B</b> }
        function App() {
          let n = $state(1), items = $state(['x'])
          return <div><button onClick={() => { n++; items = [...items, 'y' + n] }}>inc</button>
            <p><${Boundary} fallback="fallback">{n}</${Boundary}></p>
            <p><${Boundary} fallback="fallback">{items.map(item => <span key={item}>{item}</span>)}</${Boundary}></p>
            <p><${Boundary} fallback="fallback">{n % 2 ? <A/> : <B/>}</${Boundary}></p>
            <p><${Boundary} fallback="fallback">{n % 2 > 0 && <i>shown</i>}</${Boundary}></p>
            <p><${Boundary} fallback="fallback"><span>{n}</span></${Boundary}></p>
          </div>
        }
        export function mount(container) { root = container; return render(() => <App />, root) }
        export function observe() { return Array.from(root.querySelectorAll('p'), element => element.textContent) }
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
          { kind: 'click', selector: 'button' },
          { kind: 'record', label: 'again' },
        ],
      })
      assert.deepEqual(result, [
        { label: 'initial', value: ['1', 'x', 'A', 'shown', '1'] },
        { label: 'updated', value: ['2', 'xy2', 'B', '', '2'] },
        { label: 'again', value: ['3', 'xy2y3', 'A', 'shown', '3'] },
      ])
    })
  }
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 35: SSR preserves boolean form and media properties (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root
      function App() {
        let on = $state(true), off = $state(false)
        return <div><input id="static" type="checkbox" checked readOnly />
          <input id="dynamic" type="checkbox" checked={on} readOnly={on} />
          <input id="off" type="checkbox" checked={off} readOnly={off} />
          <select multiple><option value="a" selected>A</option><option value="b" selected={on}>B</option><option value="c" selected={off}>C</option></select>
          <video id="muted" muted/><audio id="sound" muted={off}/>
        </div>
      }
      export function mount(container) {
        root = container; root.innerHTML = renderToString(() => <App />)
        return () => root.replaceChildren()
      }
      export function observe() {
        return {
          inputs: Array.from(root.querySelectorAll('input'), input => [input.checked, input.readOnly]),
          multiple: root.querySelector('select').multiple,
          options: Array.from(root.querySelectorAll('option'), option => [option.selected, option.hasAttribute('selected')]),
          media: [root.querySelector('video').hasAttribute('muted'), root.querySelector('audio').hasAttribute('muted')],
        }
      }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [{ kind: 'record', label: 'server' }],
    })
    assert.deepEqual(result, [
      {
        label: 'server',
        value: {
          inputs: [
            [true, true],
            [true, true],
            [false, false],
          ],
          multiple: true,
          options: [
            [true, true],
            [true, true],
            [false, false],
          ],
          media: [true, false],
        },
      },
    ])
  })
}
