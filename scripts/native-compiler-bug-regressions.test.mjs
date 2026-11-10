import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const native = require(
  process.env.FICT_COMPILER_NATIVE_PATH ?? '../target/release/fict_compiler_napi.node',
)

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

for (const fineGrainedDom of [true, false]) {
  test(`bug 7: inline fragments preserve flattened DOM paths and text runs (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let n = $state(1)
        return <div><section><><button id="inc" onClick={() => n++}>inc</button>
          <span title={'t' + n}><><i>{n}</i></></span></></section>
          <p id="text">x<><>{n}</></>y</p>
          <p id="joined">a<>b<></></>c<button id="next" onClick={() => n++}>next</button><em>{n}</em></p>
          <table><><tr><td>{n}</td></tr></><tr><td>{n + 1}</td></tr></table>
        </div>
      }
      export function mount(container) { root = container; return render(() => <App />, root) }
      export function observe() { return {
        title: root.querySelector('span').title, number: root.querySelector('i').textContent,
        text: root.querySelector('#text').textContent, joined: root.querySelector('#joined').textContent,
        cells: Array.from(root.querySelectorAll('td'), el => el.textContent),
        bodies: root.querySelectorAll('tbody').length,
      } }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#inc' },
        { kind: 'record', label: 'updated' },
        { kind: 'click', selector: '#next' },
        { kind: 'record', label: 'again' },
      ],
    })
    assert.deepEqual(
      result,
      [1, 2, 3].map((n, i) => ({
        label: ['initial', 'updated', 'again'][i],
        value: {
          title: 't' + n,
          number: '' + n,
          text: 'x' + n + 'y',
          joined: 'abcnext' + n,
          cells: ['' + n, '' + (n + 1)],
          bodies: fineGrainedDom ? 1 : 0,
        },
      })),
    )
  })
}

for (const fineGrainedDom of [true, false]) {
  for (const ssr of [false, true]) {
    test(`bug 8: AND preserves falsy operands and updates (fineGrainedDom=${fineGrainedDom}, ssr=${ssr})`, async () => {
      const code = compile(
        `
        import { $state, render, hydrate } from 'fict'
        import { renderToString } from '@fictjs/ssr'
        let root, first
        const issues = []
        function App() {
          let n = $state<any>(0)
          return <div>
            <button id="nan" onClick={() => n = NaN}>NaN</button>
            <button id="false" onClick={() => n = false}>false</button>
            <button id="bigint" onClick={() => n = 0n}>0n</button>
            <button id="one" onClick={() => n = 1}>one</button>
            <button id="two" onClick={() => n = 2}>two</button>
            <button id="zero" onClick={() => n = 0}>zero</button>
            <p>{n && <em>x</em>}</p><b>{n && 'txt'}</b>
          </div>
        }
        export function mount(container) {
          root = container
          if (${ssr}) {
            root.innerHTML = renderToString(() => <App />)
            return hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => issues.push(issue.code) })
          }
          return render(() => <App />, root)
        }
        export function observe() {
          const node = root.querySelector('em')
          if (node && !first) first = node
          return [root.querySelector('p').textContent, root.querySelector('b').textContent, issues, ${fineGrainedDom} ? !node || node === first : true]
        }
      `,
        { fineGrainedDom },
      )
      const steps = [{ kind: 'record', label: 'initial' }]
      for (const value of ['nan', 'false', 'bigint', 'one', 'two', 'zero']) {
        steps.push({ kind: 'click', selector: '#' + value }, { kind: 'record', label: value })
      }
      const result = await executeDomCommonJs(code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps,
      })
      assert.deepEqual(
        result,
        [
          ['initial', '0', '0'],
          ['nan', 'NaN', 'NaN'],
          ['false', '', ''],
          ['bigint', '0', '0'],
          ['one', 'x', 'txt'],
          ['two', 'x', 'txt'],
          ['zero', '0', '0'],
        ].map(([label, a, b]) => ({ label, value: [a, b, [], true] })),
      )
    })
  }
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 33: inserted elements and wrapper children claim their SSR range (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root, before
      const issues = []
      function Wrap(props) { return <section>{props.children}</section> }
      function Layout(props) { return <article>{props.children}</article> }
      function header(title) { return <h1>{title}</h1> }
      function row(item) { return <li>{item}</li> }
      function Rows(props) { return <ol>{props.items.map(row)}</ol> }
      function App() {
        let n = $state(0), items = $state(['a', 'b']), empty = $state([])
        const mixed = n ? 'value' : <em>mixed</em>
        return <div><button onClick={() => { n++; items = [...items, 'c']; empty = ['new'] }}>inc</button>
          <Wrap><i>{n}</i></Wrap>
          <Layout><Wrap><strong>{n}</strong></Wrap></Layout>
          <div id="headers">{header('H')}</div>
          <ul>{items.map(row)}</ul>
          <aside>{n || <em>fallback</em>}</aside>
          <Rows items={items}/><div id="mixed">{mixed}</div><div id="empty">{empty.map(row)}</div>
        </div>
      }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App />)
        before = Array.from(root.querySelectorAll('i,strong,h1,li,em'))
        return hydrate(() => <App />, root, { strictHydration: true, onHydrationIssue: issue => issues.push(issue.code) })
      }
      export function observe() {
        return {
          i: root.querySelector('section').textContent, nested: root.querySelector('article').textContent,
          headers: root.querySelector('#headers').textContent, rows: root.querySelector('ul').textContent,
          aside: root.querySelector('aside').textContent, mixed: root.querySelector('#mixed').textContent, empty: root.querySelector('#empty').textContent, delegatedRows: root.querySelector('ol').textContent, issues,
          count: root.querySelectorAll('i,strong,h1,li,em').length,
          initialIdentity: before.every(node => root.contains(node)),
        }
      }
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
      {
        label: 'initial',
        value: {
          i: '0',
          nested: '0',
          headers: 'H',
          rows: 'ab',
          aside: 'fallback',
          mixed: 'mixed',
          empty: '',
          delegatedRows: 'ab',
          issues: [],
          count: 9,
          initialIdentity: true,
        },
      },
      {
        label: 'updated',
        value: {
          i: '1',
          nested: '1',
          headers: 'H',
          rows: 'abc',
          aside: '1',
          mixed: 'value',
          empty: 'new',
          delegatedRows: 'abc',
          issues: [],
          count: 10,
          initialIdentity: false,
        },
      },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 38: forwarded and selected handlers read the latest callback (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function Button({ onSave }) { return <button id="destructured" onClick={onSave}>save</button> }
      function Optional(props) { return <button id="optional" onClick={props.onSave}>optional</button> }
      function Forward(props) { return <><button id="forward" onClick={props.onSave}>forward</button><button id="capture" onClickCapture={props.onSave}>capture</button></> }
      function App() {
        let ready = $state(false), mode = $state('a'), total = $state(0), seen = $state('')
        const saveA = () => { total++ }, saveB = () => { total += 10 }
        const handler = mode === 'a' ? saveA : saveB
        const consume = data => { seen = data }
        return <div>
          <button id="ready" onClick={() => ready = !ready}>ready</button>
          <button id="mode" onClick={() => mode = 'b'}>mode</button>
          <Optional onSave={ready ? saveA : undefined}/><Button onSave={handler}/><Forward onSave={handler}/>
          <button id="derived" onClick={handler}>derived</button>
          <button id="ternary" onClick={mode === 'a' ? saveA : saveB}>ternary</button>
          <button id="tuple" onClick={[consume, mode]}>tuple</button>
          <p>{total}</p><b>{seen}</b>
        </div>
      }
      export function mount(container) { root = container; return render(() => <App />, root) }
      export function observe() { return [root.querySelector('p').textContent, root.querySelector('b').textContent] }
    `,
      { fineGrainedDom },
    )
    const steps = [
      { kind: 'click', selector: '#optional' },
      { kind: 'record', label: 'disabled' },
      { kind: 'click', selector: '#ready' },
      { kind: 'click', selector: '#optional' },
    ]
    for (const selector of ['destructured', 'forward', 'capture', 'derived', 'ternary', 'tuple'])
      steps.push({ kind: 'click', selector: '#' + selector })
    steps.push({ kind: 'record', label: 'first' }, { kind: 'click', selector: '#mode' })
    for (const selector of ['destructured', 'forward', 'capture', 'derived', 'ternary', 'tuple'])
      steps.push({ kind: 'click', selector: '#' + selector })
    steps.push(
      { kind: 'record', label: 'switched' },
      { kind: 'click', selector: '#ready' },
      { kind: 'click', selector: '#optional' },
      { kind: 'record', label: 'disabled-again' },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps,
    })
    assert.deepEqual(result, [
      { label: 'disabled', value: ['0', ''] },
      { label: 'first', value: ['6', 'a'] },
      { label: 'switched', value: ['56', 'b'] },
      { label: 'disabled-again', value: ['56', 'b'] },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 25: single-assignment var derives reactively without changing hoisted storage (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let count = $state(1), read = $state('')
        let a = count * 2
        var b = count * 2
        const c = count * 2
        const earlier = late
        var late = 7
        var duplicate = 1; var duplicate = 2
        var changed = count * 3; changed = 9
        const early = peek()
        var hoisted = count * 5
        function peek() { return hoisted }
        return <div><button onClick={() => count++}>inc</button>
          <p>{a}:{b}:{c}</p><b>{String(earlier)}:{late}:{duplicate}:{changed}</b>
          <button id="read" onClick={() => { read = '' + b }}>read</button><u>{read}</u><small>{'' + early}:{hoisted}</small>
        </div>
      }
      export function mount(container) { root = container; return render(() => <App />, root) }
      export function observe() { return [root.querySelector('p').textContent, root.querySelector('b').textContent, root.querySelector('u').textContent, root.querySelector('small').textContent] }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: 'button' },
        { kind: 'click', selector: '#read' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'initial', value: ['2:2:2', 'undefined:7:2:9', '', 'undefined:5'] },
      { label: 'updated', value: ['4:4:4', 'undefined:7:2:9', '4', 'undefined:5'] },
    ])
  })
}

for (const [update, expected] of [
  ['[...items].reverse()', 'cab'],
  ['[...items].sort()', 'abc'],
  ['items.slice().reverse()', 'cab'],
  ["[...items, 'd'].sort()", 'abcd'],
  ['items.concat([]).reverse()', 'cab'],
  ['items.map(x => x).reverse()', 'cab'],
  ['Array.from(items).reverse()', 'cab'],
]) {
  test(`bug 5: copied array mutation retains array provenance (${update})`, async () => {
    const code = compile(`
      import { $state, render } from 'fict'
      let root
      function App() {
        let items = $state(['b', 'a', 'c'])
        return <div><button onClick={() => { items = ${update} }}>update</button>
          <ul>{items.map(item => <li key={item}>{item}</li>)}</ul></div>
      }
      export function mount(container) { root = container; return render(() => <App />, root) }
      export function observe() { return root.querySelector('ul').textContent }
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
      { label: 'initial', value: 'bac' },
      { label: 'updated', value: expected },
    ])
  })
}

for (const flag of [true, false]) {
  test(`bug 5: conditional array initialization retains array provenance (${flag})`, async () => {
    const code = compile(`
      import { $state, render } from 'fict'
      let root
      function App(props) {
        let items = $state(props.flag ? ['b', 'a', 'c'] : ['b', 'a'])
        return <div><button onClick={() => { items = items.toReversed() }}>update</button>
          <ul>{items.map(item => <li key={item}>{item}</li>)}</ul></div>
      }
      export function mount(container) { root = container; return render(() => <App flag={${flag}}/>, root) }
      export function observe() { return root.querySelector('ul').textContent }
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
      { label: 'initial', value: flag ? 'bac' : 'ba' },
      { label: 'updated', value: flag ? 'cab' : 'ab' },
    ])
  })
}

for (const mutation of [
  'items.reverse()',
  'items.sort()',
  'items.fill({ n: 2 })',
  'items.copyWithin(0, 1)',
  '[...items][0].n++',
  'items.slice()[0].n++',
  'Array.from(items)[0].n++',
]) {
  test(`bug 5: copying does not allow mutations of state identity (${mutation})`, () => {
    const result = native.transformSync({
      code: `import { $state } from 'fict'; export function App() { let items = $state([{ n: 1 }]); return <button onClick={() => { ${mutation} }}>update</button> }`,
      filename: '/bug-5-mutation.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(
      result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-M'),
      JSON.stringify(result.diagnostics),
    )
  })
}

test('bug 5: replaced array factories are not certified as fresh copies', () => {
  for (const replacement of ['Array.from = x => x', 'const A = Array; A.from = x => x']) {
    const result = native.transformSync({
      code: `import { $state } from 'fict'; ${replacement}; export function App() { let items = $state(['a']); return <button onClick={() => { items = Array.from(items).reverse() }}>update</button> }`,
      filename: '/bug-5-factory.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
  }
})

for (const fineGrainedDom of [true, false]) {
  test(`bug 11: controlled select initializes after options and follows option updates (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let choice = $state('b'), opts = $state(['a', 'b', 'c']), other = $state('x')
        return <div>
          <select id="static" value="c"><option value="a">A</option><option value="c">C</option></select>
          <select id="bound" value={choice}><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
          <select id="list" value={choice}>{opts.map(o => <option key={o} value={o}>{o}</option>)}</select>
          <select id="option" value="b"><option value="a">A</option><option value={other}>Other</option></select>
          <button id="choose" onClick={() => { choice = 'c' }}>choose</button>
          <button id="remove" onClick={() => { opts = ['a']; other = 'b' }}>remove</button>
          <button id="restore" onClick={() => { opts = ['c', 'b', 'a'] }}>restore</button>
        </div>
      }
      export function mount(container) {
        root = container
        const dispose = render(() => <App/>, root)
        if (root.querySelector('#static').value !== 'c' || root.querySelector('#bound').value !== 'b' || root.querySelector('#list').value !== 'b') throw new Error('select is incorrect at render return')
        return dispose
      }
      export function observe() { return Array.from(root.querySelectorAll('select'), s => [s.value, s.selectedIndex]) }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#choose' },
        { kind: 'record', label: 'choice' },
        { kind: 'click', selector: '#remove' },
        { kind: 'record', label: 'removed' },
        { kind: 'click', selector: '#restore' },
        { kind: 'record', label: 'restored' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'initial',
        value: [
          ['c', 1],
          ['b', 1],
          ['b', 1],
          ['', -1],
        ],
      },
      {
        label: 'choice',
        value: [
          ['c', 1],
          ['c', 2],
          ['c', 2],
          ['', -1],
        ],
      },
      {
        label: 'removed',
        value: [
          ['c', 1],
          ['c', 2],
          ['', -1],
          ['b', 1],
        ],
      },
      {
        label: 'restored',
        value: [
          ['c', 1],
          ['c', 2],
          ['c', 0],
          ['b', 1],
        ],
      },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 11: controlled select serializes its selection and hydrates (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root, before, same
      function App() {
        let choice = $state('b'), opts = $state(['a', 'b', 'c'])
        return <div><button onClick={() => { choice = 'c' }}>choose</button>
          <select value={choice}><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
          <select value={choice}>{opts.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
      }
      export function mount(container) {
        root = container
        root.innerHTML = renderToString(() => <App/>)
        const first = root.querySelector('option')
        before = Array.from(root.querySelectorAll('select'), s => s.value)
        const dispose = hydrate(() => <App/>, root, { strictHydration: true })
        same = first === root.querySelector('option')
        return dispose
      }
      export function observe() { return { before, same, values: Array.from(root.querySelectorAll('select'), s => s.value) } }
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
      { label: 'initial', value: { before: ['b', 'b'], same: true, values: ['b', 'b'] } },
      { label: 'updated', value: { before: ['b', 'b'], same: true, values: ['c', 'c'] } },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 12: input values survive later constraint and type bindings (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let value = $state(150), limit = $state(200), kind = $state('range')
        return <div>
          <input type="range" value={value} min={0} max={limit}/>
          <input type="range" value={value} max="200"/>
          <input value={value} max={limit} type="range"/>
          <input value={value} type={kind} max={limit}/>
          <input type="number" value={value} max={limit}/>
          <button id="lower" onClick={() => { limit = 100 }}>lower</button>
          <button id="raise" onClick={() => { limit = 200 }}>raise</button>
          <button id="value" onClick={() => { value = 160 }}>value</button>
        </div>
      }
      export function mount(container) { root = container; return render(() => <App/>, root) }
      export function observe() { return Array.from(root.querySelectorAll('input'), i => i.value) }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#lower' },
        { kind: 'record', label: 'lowered' },
        { kind: 'click', selector: '#raise' },
        { kind: 'record', label: 'raised' },
        { kind: 'click', selector: '#value' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'initial', value: ['150', '150', '150', '150', '150'] },
      { label: 'lowered', value: ['100', '150', '100', '100', '150'] },
      { label: 'raised', value: ['150', '150', '150', '150', '150'] },
      { label: 'updated', value: ['160', '160', '160', '160', '160'] },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 16: custom elements retain attributes and dispatch supported properties (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, render } from 'fict'
      let root
      function App() {
        let name = $state('first'), n = $state(1)
        return <div>
          <my-el id="plain" data-testid={name} data-static="s" tabindex="0" for="label" variant="primary" aria-label={name} prop:extra={n}/>
          <x-defined id="defined" foo-bar={n} config={{ count: n }} variant={name}/>
          <button id="built" is="my-btn" data-testid={name} tabindex="0">built</button>
          <button id="update" onClick={() => { name = 'next'; n++ }}>update</button>
        </div>
      }
      export function mount(container) {
        class Defined extends window.HTMLElement { set fooBar(value) { this.current = value } get fooBar() { return this.current } }
        class Built extends window.HTMLButtonElement {}
        window.customElements.define('x-defined', Defined)
        window.customElements.define('my-btn', Built, { extends: 'button' })
        root = container
        return render(() => <App/>, root)
      }
      export function observe() {
        const plain = root.querySelector('#plain'), defined = root.querySelector('#defined'), built = root.querySelector('#built')
        return { plain: [plain.dataset.testid, plain.dataset.static, plain.tabIndex, plain.getAttribute('for'), plain.getAttribute('variant'), plain.getAttribute('aria-label'), plain.extra],
          defined: [defined.fooBar, defined.config.count, defined.getAttribute('variant')],
          built: [built.getAttribute('is'), built.dataset.testid, built.tabIndex, built instanceof window.customElements.get('my-btn')] }
      }
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#update' },
        { kind: 'record', label: 'updated' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'initial',
        value: {
          plain: ['first', 's', 0, 'label', 'primary', 'first', 1],
          defined: [1, 1, 'first'],
          built: ['my-btn', 'first', 0, true],
        },
      },
      {
        label: 'updated',
        value: {
          plain: ['next', 's', 0, 'label', 'primary', 'next', 2],
          defined: [2, 2, 'next'],
          built: ['my-btn', 'next', 0, true],
        },
      },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 16: custom attributes survive SSR and hydration (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, hydrate } from 'fict'
      import { renderToString } from '@fictjs/ssr'
      let root, before, same
      function App() {
        let active = $state(true)
        return <div><my-el data-testid="custom" tabindex="0" variant="primary" data-active={active} active={active}/>
          <button is="fancy-button" data-testid="button" onClick={() => { active = false }}>off</button></div>
      }
      function attrs() { const el = root.querySelector('my-el'); return [el.dataset.testid, el.tabIndex, el.getAttribute('variant'), el.getAttribute('data-active'), el.hasAttribute('active'), root.querySelector('button').getAttribute('is')] }
      export function mount(container) {
        root = container; root.innerHTML = renderToString(() => <App/>)
        const first = root.querySelector('my-el'); before = attrs()
        const dispose = hydrate(() => <App/>, root, { strictHydration: true })
        same = first === root.querySelector('my-el'); return dispose
      }
      export function observe() { return { before, same, attrs: attrs() } }
    `,
      { fineGrainedDom },
    )
    const initial = ['custom', 0, 'primary', 'true', true, 'fancy-button']
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
      { label: 'initial', value: { before: initial, same: true, attrs: initial } },
      {
        label: 'updated',
        value: {
          before: initial,
          same: true,
          attrs: ['custom', 0, 'primary', 'false', false, 'fancy-button'],
        },
      },
    ])
  })
}

for (const strictGuarantee of [true, false]) {
  for (const [declaration, code] of [
    ['let m = $state(100)', 'FICT-PLACEMENT-STATE-CONTROL'],
    ['$effect(() => { document.title = "n=" + n })', 'FICT-PLACEMENT-EFFECT-CONTROL'],
    ['const v = $memo(() => n * 3)', 'FICT-PLACEMENT-MEMO-CONTROL'],
    ['const t = useThing()', 'FICT-PLACEMENT-HOOK-CONTROL'],
  ]) {
    for (const guard of [
      'if (!props.on) return <p>off</p>',
      'switch (props.on) { case false: return <p>off</p> }',
    ]) {
      test(`bug 17: rejects hooks following early exits (${declaration}; ${guard}; strict=${strictGuarantee})`, () => {
        const source = `import { $state, $effect, $memo } from 'fict'; function useThing() { let x = $state(1); return { x } } export function Inner(props) { let n = $state(0); ${guard}; ${declaration}; return <p>{n}</p> }`
        const result = native.transformSync({
          code: source,
          filename: '/bug-17.tsx',
          options: { dev: false, strictGuarantee },
        })
        const diagnostic = result.diagnostics.find(diagnostic => diagnostic.code === code)
        assert.ok(diagnostic, JSON.stringify(result.diagnostics))
        assert.equal(diagnostic.severity, 'error')
        assert.match(diagnostic.message, /early return/)
        assert.ok(
          declaration.includes(
            source.slice(diagnostic.primarySpan.start, diagnostic.primarySpan.end),
          ),
        )
        assert.ok(!result.code)
      })
    }
  }
}

test('bug 17: nested callback returns do not make later top-level hooks conditional', () => {
  compile(`
    import { $state, $effect, $memo } from 'fict'
    function useThing() { let x = $state(1); return { x } }
    export function App(props) {
      const handler = () => { if (props.enabled) return 1; return 0 }
      const result = (() => { return 1 })()
      let n = $state(1)
      $effect(() => { document.title = '' + n })
      const doubled = $memo(() => n * 2)
      const thing = useThing()
      if (!props.on) return <p>off</p>
      const derived = n * 3
      return <button onClick={handler}>{doubled}:{thing.x}:{derived}:{result}</button>
    }
  `)
})

for (const [setup, value] of [
  ['', 'props.prefix'],
  ['const p = props.prefix;', 'p'],
  ['const { prefix: p } = props;', 'p'],
  ['const p = props.prefix; const q = p + "!";', 'q'],
]) {
  test(`bug 13: unknown collection callbacks retain prop capture diagnostics (${setup || 'direct'})`, () => {
    for (const strictGuarantee of [true, false]) {
      const result = native.transformSync({
        code: `function List(props) { ${setup} return <ul>{props.items.map(s => <li key={s}>{${value}}{s}</li>)}</ul> }`,
        filename: '/prop-capture.tsx',
        options: { dev: false, strictGuarantee },
      })
      assert.ok(result.diagnostics.some(d => d.code === 'FICT-R005'))
      assert.ok(result.diagnostics.every(d => ['FICT-R002', 'FICT-R005'].includes(d.code)))
      assert.ok(
        result.diagnostics.every(d => d.severity === (strictGuarantee ? 'error' : 'warning')),
      )
      assert.equal(Boolean(result.code), !strictGuarantee)
    }
  })
}

test('bug 13: known collection and event hosts accept prop aliases and ordinary value arguments remain snapshots', () => {
  compile(`
    import { $state } from 'fict'
    declare function consume(value: string): void
    function List(props) {
      let items = $state(['x', 'y'])
      const prefix = props.prefix
      consume(prefix)
      return <ul onClick={() => consume(prefix)}>{items.map(s => <li key={s}>{prefix}{s}</li>)}</ul>
    }
  `)
})

for (const fineGrainedDom of [true, false]) {
  for (const [family, seed, update] of [
    ['Set', "['a']", "values = new Set([...values, 'b'])"],
    ['Set', "['a']", "values = new Set(values).add('b')"],
    ['Set', "['a']", "const next = new Set(values); next.add('b'); values = next"],
    ['Map', "[['a', 1]]", "values = new Map([...values, ['b', 5]])"],
    ['Map', "[['a', 1]]", "values = new Map(values).set('b', 5)"],
    ['Map', "[['a', 1]]", "const next = new Map(values); next.set('b', 5); values = next"],
  ]) {
    test(`bug 24: ${update} preserves the original collection and updates DOM (fineGrainedDom=${fineGrainedDom})`, async () => {
      const code = compile(
        `
        import { $state, render } from 'fict'
        let root
        const seed = new ${family}(${seed})
        function App() {
          let values = $state<${family}>(seed)
          return <button onClick={() => { ${update} }}>{values.size}:{values.has('b') ? 'yes' : 'no'}</button>
        }
        export function mount(container) { root = container; return render(() => <App />, root) }
        export function observe() { return [root.textContent, seed.size, seed.has('b')] }
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
        { label: 'initial', value: ['1:no', 1, false] },
        { label: 'updated', value: ['2:yes', 1, false] },
      ])
    })
  }
}

for (const update of [
  "values.set('b', { n: 2 })",
  "const copy = values; copy.set('b', { n: 2 })",
  "new Map(values).get('a').n++",
  "const copy = new Map(values); copy.get('a').n++",
  "Map = external; const copy = new Map(values); copy.set('b', { n: 2 })",
  'Map.prototype.set = external; const copy = new Map(values)',
  'const Map = external; const copy = new Map(values)',
]) {
  test(`bug 24: collection copies do not permit shared writes or uncertified constructors (${update})`, () => {
    const result = native.transformSync({
      code: `import { $state } from 'fict'; declare const external: any; function App() { let values = $state(new Map([['a', {n:1}]])); return <button onClick={() => {${update}}}>{values.size}</button> }`,
      filename: '/map-negative.tsx',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(
      result.diagnostics.some(d => ['FICT-M', 'FICT-S002', 'FICT-R002'].includes(d.code)),
      JSON.stringify(result.diagnostics),
    )
    assert.ok(!result.code)
  })
}

for (const fineGrainedDom of [true, false]) {
  for (const factorySetup of [
    "import { mergeProps, prop } from 'fict'",
    "import { mergeProps as merge, prop as memoProp } from 'fict'; const mergeProps = merge; const prop = memoProp",
    "import * as runtime from 'fict'; const mergeProps = runtime.mergeProps; const prop = runtime.prop",
  ]) {
    test(`bug 20: merged defaults and cached props stay live (${factorySetup}; fineGrainedDom=${fineGrainedDom})`, async () => {
      const code = compile(
        `
        import { $state, render } from 'fict'
        ${factorySetup}
        let root
        function Button(props) {
          const merged = mergeProps({ class: 'btn', type: 'button' }, props)
          const title = '[' + merged.class + ']'
          const content = prop(() => props.label + ':' + merged.class)
          return <button class={merged.class} type={merged.type} title={title}>{content}</button>
        }
        function App() {
          let phase = $state(0)
          const kind = phase === 1 ? 'hot' : phase === 2 ? null : undefined
          return <div><a onClick={() => phase++}>next</a><Button class={kind} label={phase}/></div>
        }
        export function mount(container) { root = container; return render(() => <App />, root) }
        export function observe() { const b = root.querySelector('button'); return [b.className, b.type, b.title, b.textContent] }
      `,
        { fineGrainedDom },
      )
      const result = await executeDomCommonJs(code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [
          { kind: 'record', label: 'default' },
          { kind: 'click', selector: 'a' },
          { kind: 'record', label: 'override' },
          { kind: 'click', selector: 'a' },
          { kind: 'record', label: 'null' },
          { kind: 'click', selector: 'a' },
          { kind: 'record', label: 'default again' },
        ],
      })
      assert.deepEqual(result, [
        { label: 'default', value: ['btn', 'button', '[btn]', '0:btn'] },
        { label: 'override', value: ['hot', 'button', '[hot]', '1:hot'] },
        { label: 'null', value: ['', 'button', '[null]', '2:null'] },
        { label: 'default again', value: ['btn', 'button', '[btn]', '3:btn'] },
      ])
    })
  }
}

for (const source of [
  "import { mergeProps } from 'external'; function App(props) { const result = mergeProps({}, props); return <p>{result.title}</p> }",
  "import { prop } from 'external'; function App(props) { const value = prop(() => props.title); return <p>{value}</p> }",
  "import { prop } from 'fict'; function App(props) { const value = prop(async () => { await Promise.resolve(); return props.title }); return <p>{value}</p> }",
  "import { prop as source } from 'fict'; declare const replace: any; function App(props) { let prop = source; prop = replace; const value = prop(() => props.title); return <p>{value}</p> }",
]) {
  test(`bug 20: external, replaced and async prop factories remain escape boundaries (${source})`, () => {
    const result = native.transformSync({
      code: source,
      filename: '/prop-factory.tsx',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(result.diagnostics.some(d => ['FICT-R002', 'FICT-R005'].includes(d.code)))
    assert.ok(!result.code)
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 20: exported props metadata preserves cross-module updates (fineGrainedDom=${fineGrainedDom})`, async () => {
    const dependency = native.transformSync({
      code: `import { mergeProps, prop } from 'fict'; import { createSignal } from 'fict/internal';
        const value = createSignal(undefined);
        export const settings = mergeProps({ title: 'default' }, prop(() => ({ title: value() })));
        export const title = prop(() => settings.title + '!');
        export function update() { value('next') }`,
      filename: '/props-source.ts',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee: true },
    })
    assert.deepEqual(dependency.diagnostics, [])
    assert.deepEqual(dependency.moduleMetadata.exports, { settings: 'store', title: 'memo' })
    const consumer = native.transformSync({
      code: `import { render } from 'fict'; import { settings, title, update } from './props-source';
        let root;
        function App() { const text = settings.title + ':' + title; return <button onClick={update}>{text}</button> }
        export function mount(container) { root=container; return render(() => <App/>, root) }
        export function observe() { return root.textContent }`,
      filename: '/props-consumer.tsx',
      moduleKind: 'commonjs',
      metadata: [
        {
          request: './props-source',
          resolvedId: '/props-source.ts',
          status: 'resolved',
          metadata: dependency.moduleMetadata,
          fingerprint: 'sha256:props-source',
        },
      ],
      options: { dev: false, strictGuarantee: true, fineGrainedDom },
    })
    assert.deepEqual(consumer.diagnostics, [])
    const code = `const dependency = {exports:{}};
      (function(require,module,exports){${dependency.code}\n})(require,dependency,dependency.exports);
      (function(require,module,exports){${consumer.code}\n})(name => name === './props-source' ? dependency.exports : require(name),module,exports);`
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
      { label: 'initial', value: 'default:default!' },
      { label: 'updated', value: 'next:next!' },
    ])
  })
}

for (const fineGrainedDom of [true, false]) {
  test(`bug 21: store keys, manual signal memos, deferred values and lifecycle hosts update (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, $store, createMemo, useDeferredValue, onMount, render } from 'fict'
      import { createSignal } from 'fict/advanced'
      let root
      function App() {
        const store=$store({labels:{a:'A',b:'B'},items:['x','y']})
        const labels=store.labels
        let key=$state('a'), index=$state(0), query=$state('first'), mounted=$state(0)
        const items=createSignal([1,2,3]), threshold=createSignal(1)
        const filtered=createMemo(()=>items().filter(n=>n>threshold()))
        const count=createMemo(()=>items().length)
        const deferred=useDeferredValue(()=>query)
        onMount(()=>{mounted=1})
        return <div><button onClick={()=>{key='b';index=1;query='next';items([1,2,3,4]);threshold(2)}}>update</button>
          <button id="mutate" onClick={()=>{store.labels.b='BB'}}>mutate</button>
          <p>{store.labels[key]}:{labels[key]}:{store.items[index]}:{mounted}</p>
          <b>{filtered().join(',')}:{count()}</b><i>{deferred()}</i></div>
      }
      export function mount(container){root=container;return render(()=><App/>,root)}
      export function observe(){return ['p','b','i'].map(tag=>root.querySelector(tag).textContent)}
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
        { kind: 'click', selector: '#mutate' },
        { kind: 'record', label: 'store write' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'initial', value: ['A:A:x:1', '2,3:3', 'first'] },
      { label: 'updated', value: ['B:B:y:1', '3,4:4', 'next'] },
      { label: 'store write', value: ['BB:BB:y:1', '3,4:4', 'next'] },
    ])
  })

  test(`bug 21: conditional context reads and props resource getters compile and update (fineGrainedDom=${fineGrainedDom})`, async () => {
    const code = compile(
      `
      import { $state, createContext, useContext, hasContext, render } from 'fict'
      import { resource } from 'fict/plus'
      import { reactive } from 'fict/advanced'
      const Ctx=createContext('default')
      const users=resource(async (_, id)=>'user-'+id)
      let root
      function Child(props){
        const user=users.read(reactive(()=>props.id))
        if(hasContext(Ctx)){const theme=useContext(Ctx);return <p><b>{theme}</b><i>{user.data}</i></p>}
        return null
      }
      function App(){let id=$state(1);return <div><button onClick={()=>id++}>next</button><Ctx.Provider value="provided"><Child id={id}/></Ctx.Provider></div>}
      export function mount(container){root=container;return render(()=><App/>,root)}
      export function observe(){return root.querySelector('p').textContent}
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
      { label: 'initial', value: 'provideduser-1' },
      { label: 'updated', value: 'provideduser-2' },
    ])
  })

  const apiReference = readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8')
  test(`bug 21: the published Timer example updates and clears its timer (fineGrainedDom=${fineGrainedDom})`, async () => {
    const source = apiReference
      .slice(apiReference.indexOf('### $effect'))
      .match(/```tsx\n([\s\S]*?)\n```/)[1]
    compile(source, { fineGrainedDom })
    const code = compile(
      `import {render} from 'fict';let root,tick,cleared=0;const setInterval=fn=>{tick=fn;return 1};const clearInterval=()=>{cleared++};
      ${source}
      export function advance(){tick()}
      export function mount(container){root=container;return render(()=><Timer/>,root)}
      export function observe(){return [root.textContent,document.title,cleared]}
    `,
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'call', exportName: 'advance' },
        { kind: 'record', label: 'ticked' },
        { kind: 'dispose' },
        { kind: 'record', label: 'disposed' },
      ],
    })
    assert.deepEqual(result, [
      { label: 'initial', value: ['Elapsed: 0s', 'Timer: 0s', 0] },
      { label: 'ticked', value: ['Elapsed: 1s', 'Timer: 1s', 0] },
      { label: 'disposed', value: ['', 'Timer: 1s', 1] },
    ])
  })

  test(`bug 21: the published Todo example creates, completes and persists todos (fineGrainedDom=${fineGrainedDom})`, async () => {
    const source = apiReference
      .slice(apiReference.indexOf('## Full Example: Todo App'))
      .match(/```tsx\n([\s\S]*?)\n```/)[1]
    compile(source, { fineGrainedDom })
    const code = compile(
      source.replace(
        "render(() => <TodoApp />, document.getElementById('app')!)",
        `let root;
      export function mount(container){root=container;return render(()=><TodoApp/>,root)}
      export function observe(){return {rows:root.querySelectorAll('li').length, text:root.querySelector('li span')?.textContent, saved:JSON.parse(localStorage.getItem('todos'))}}
    `,
      ),
      { fineGrainedDom },
    )
    const result = await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        {
          kind: 'dispatch',
          selector: '.input-section input',
          event: 'input',
          constructor: 'Event',
          init: { bubbles: true },
          assign: { value: 'task' },
        },
        { kind: 'click', selector: '.input-section button' },
        { kind: 'record', label: 'added' },
        {
          kind: 'dispatch',
          selector: 'li input',
          event: 'change',
          constructor: 'Event',
          init: { bubbles: true },
          assign: { checked: true },
        },
        { kind: 'record', label: 'completed' },
      ],
    })
    assert.deepEqual(result, [
      {
        label: 'added',
        value: { rows: 1, text: 'task', saved: [{ id: 1, text: 'task', completed: false }] },
      },
      {
        label: 'completed',
        value: { rows: 1, text: 'task', saved: [{ id: 1, text: 'task', completed: true }] },
      },
    ])
  })
}

for (const [setup, expression] of [
  [
    'const items=createSignal([1,2,3]);',
    "items().filter(n=>{document.title='changed';return true})",
  ],
  ['const items=createSignal([1,2,3]);', 'items([4,5])'],
  ['const items=createSignal([1,2,3]);', 'items().sort()'],
  ['const items=createSignal([1,2,3]);Array.prototype.filter=external;', 'items().filter(n=>n>1)'],
  ['const items=createSignal([1,2,3]);items(external);', 'items().filter(n=>n>1)'],
  ['const items=createSignal([1,2,3]);items().filter=external;', 'items().filter(n=>n>1)'],
  [
    'const items=createSignal([1,2,3]);const alias=items();alias.filter=external;',
    'items().filter(n=>n>1)',
  ],
  ['const items=createSignal([1,2,3]);external(items());', 'items().filter(n=>n>1)'],
]) {
  test(`bug 21: manual memo contracts reject mutations and uncertified receivers (${setup} ${expression})`, () => {
    const result = native.transformSync({
      code: `import{createSignal}from'fict/advanced';import{createMemo}from'fict';declare const external:any;function App(){${setup}const value=createMemo(()=>${expression});return <p>{value()}</p>}`,
      filename: '/memo-contract.tsx',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(
      result.diagnostics.some(d => d.code === 'FICT-M003'),
      JSON.stringify(result.diagnostics),
    )
    assert.ok(!result.code)
  })
}

for (const source of [
  "import{$state}from'fict';import{onMount}from'external';function App(){let n=$state(0);onMount(()=>n++);return <p>{n}</p>}",
  "import{$state,onMount}from'fict';function App(){let n=$state(0);onMount(async()=>{await Promise.resolve();n++});return <p>{n}</p>}",
  "import{$state,useDeferredValue}from'fict';function App(){let n=$state(0);const value=useDeferredValue(async()=>{await Promise.resolve();return n});return <p>{value()}</p>}",
]) {
  test(`bug 21: runtime host contracts exclude foreign and asynchronous callbacks (${source})`, () => {
    const result = native.transformSync({
      code: source,
      filename: '/runtime-host.tsx',
      options: { dev: false, strictGuarantee: true },
    })
    assert.ok(result.diagnostics.some(d => ['FICT-R002', 'FICT-R005'].includes(d.code)))
    assert.ok(!result.code)
  })
}

test('bug 21: useContext placement exemption follows the runtime import identity', () => {
  const result = native.transformSync({
    code: "import{useContext}from'external';function App(props){if(props.on){const value=useContext({});return <p>{value}</p>}return null}",
    filename: '/context-host.tsx',
    options: { dev: false, strictGuarantee: true },
  })
  assert.ok(result.diagnostics.some(d => d.code === 'FICT-PLACEMENT-HOOK-CONTROL'))
  assert.ok(!result.code)
})

for (const [expression, expected] of [
  ['state.label()', /method call.*not proven read-only/],
  ['state.items.map(item => item.name.includes(query))', /method call.*not proven read-only/],
  ["state.name = 'next'", /nested mutation/],
]) {
  test(`bug 14: mutation diagnostics distinguish calls from writes (${expression})`, () => {
    const result = native.transformSync({
      code: `import {$state} from 'fict';function App(){let state=$state({name:'old',items:[{name:'a'}],label(){return 'a'}});let query=$state('a');const value=${expression};return <p>{value}</p>}`,
      filename: '/diagnostic-method.tsx',
      options: { dev: false, strictGuarantee: true },
    })
    const finding = result.diagnostics.find(d => d.code === 'FICT-M' && expected.test(d.message))
    assert.ok(finding, JSON.stringify(result.diagnostics))
    assert.equal(finding.severity, 'error')
    assert.ok(finding.primarySpan)
  })
}

test('bug 14: snapshot help is actionable even inside an effect', () => {
  const result = native.transformSync({
    code: `import {$state,$effect} from 'fict';function App(){let count=$state(0);$effect(()=>console.log(count));return <p>{count}</p>}`,
    filename: '/diagnostic-snapshot.tsx',
    options: { dev: false, strictGuarantee: true },
  })
  const finding = result.diagnostics.find(d => d.code === 'FICT-S002')
  assert.ok(finding, JSON.stringify(result.diagnostics))
  assert.match(finding.help, /primitive snapshot.*untrack/)
  assert.doesNotMatch(finding.help, /place the read inside/)
  compile(
    `import {$state,$effect,untrack} from 'fict';function App(){let count=$state(0);$effect(()=>{const snapshot=count;untrack(()=>console.log(snapshot))});return <p>{count}</p>}`,
  )
})

test('bug 14: inline callback advisory describes identity and documents its actual severity', () => {
  const result = native.transformSync({
    code: `function Child(props){return <p/>}function App(){return <Child renderLabel={()=>'label'}/>}`,
    filename: '/diagnostic-callback.tsx',
    options: { dev: false, strictGuarantee: true },
  })
  const finding = result.diagnostics.find(d => d.code === 'FICT-X003')
  assert.equal(finding?.severity, 'warning')
  assert.match(finding.message, /callback identity/)
  assert.doesNotMatch(finding.message, /re-render/)
  const docs = readFileSync(new URL('../docs/diagnostic-codes.md', import.meta.url), 'utf8')
  assert.match(docs, /### FICT-X003:[\s\S]*?\*\*Severity:\*\* Warning/)
})

test('bug 14: manual signal dependencies update memos without M001', async () => {
  const code = compile(
    `import{createSignal}from'fict/advanced';import{createMemo,render}from'fict';let root;function App(){const items=createSignal([1,2,3]);const length=createMemo(()=>items().length);return <div><button onClick={()=>items([1,2,3,4])}>add</button><p>{length()}</p></div>}export function mount(el){root=el;return render(()=><App/>,el)}export function observe(){return root.querySelector('p').textContent}`,
  )
  assert.deepEqual(
    await executeDomCommonJs(code, {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: 'button' },
        { kind: 'record', label: 'updated' },
      ],
    }),
    [
      { label: 'initial', value: '3' },
      { label: 'updated', value: '4' },
    ],
  )
})

test('bug 14: R006 opt-out can retain a setup snapshot and is documented as unsupported', async () => {
  const source = `import{$state,render}from'fict';let root;function Child(props){if(props.fail)throw new Error('failed');return <p>ready</p>}function App(){let fail=$state(false);return <div><button onClick={()=>fail=true}>fail</button><Child fail={fail}/></div>}export function mount(el){root=el;return render(()=><App/>,el)}export function observe(){return root.querySelector('p').textContent}`
  for (const strictGuarantee of [true, false]) {
    const result = native.transformSync({
      code: source,
      filename: '/diagnostic-control.tsx',
      moduleKind: 'commonjs',
      options: { dev: false, strictGuarantee },
    })
    const finding = result.diagnostics.find(d => d.code === 'FICT-R006')
    assert.equal(
      finding?.severity,
      strictGuarantee ? 'error' : 'warning',
      JSON.stringify(result.diagnostics),
    )
    if (strictGuarantee) assert.ok(!result.code)
    else
      assert.deepEqual(
        await executeDomCommonJs(result.code, {
          mountExport: 'mount',
          observeExport: 'observe',
          steps: [
            { kind: 'click', selector: 'button' },
            { kind: 'record', label: 'snapshot' },
          ],
        }),
        [{ label: 'snapshot', value: 'ready' }],
      )
  }
})
