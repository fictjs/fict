import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
