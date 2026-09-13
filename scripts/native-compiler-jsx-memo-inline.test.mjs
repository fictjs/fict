import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const native = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const runtime = require(path.join(root, 'packages/runtime/dist/index.cjs'))
const internal = require(path.join(root, 'packages/runtime/dist/internal.cjs'))
const ssr = require(path.join(root, 'packages/ssr/dist/index.node.cjs'))
const { JSDOM } = require(path.join(root, 'packages/runtime/node_modules/jsdom'))
const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(profile => [true, false].map(fineGrainedDom => ({ ...profile, fineGrainedDom })))

function compile(code, profile = {}, strictGuarantee = true) {
  const result = native.transformSync({
    code,
    filename: '/jsx-memo-inline.tsx',
    moduleKind: 'commonjs',
    options: { dev: false, strictGuarantee, ...profile },
  })
  assert.ok(result.code, JSON.stringify(result.diagnostics))
  assert.ok(
    !result.diagnostics.some(d => d.severity === 'error'),
    JSON.stringify(result.diagnostics),
  )
  if (strictGuarantee) assert.deepEqual(result.diagnostics, [])
  return result.code
}

function memoRetained(code, expected, name = 'value') {
  const retained = new RegExp(`const ${name} = .*__fictUseMemo`).test(code)
  assert.equal(retained, expected, code)
}

const fixture = readFileSync(path.join(root, 'scripts/fixtures/jsx-memo-inline/App.tsx'), 'utf8')

test('the documented scalar JSX example compiles with the advertised memo policy', () => {
  const guide = readFileSync(path.join(root, 'docs/derived-memo-inlining.md'), 'utf8')
  const source = guide.match(/```tsx\n([\s\S]*?)\n```/)?.[1]
  assert.ok(source)
  for (const profile of profiles)
    memoRetained(compile(source, profile), !profile.optimize, 'doubled')
})

for (const profile of profiles) {
  test(`one authored text consumer eliminates a scalar memo in both namespace paths: ${JSON.stringify(profile)}`, async () => {
    const code = compile(fixture, profile)
    memoRetained(code, !profile.optimize)
    for (const svg of [false, true]) {
      const namespace = svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml'
      const observed = await executeDomCommonJs(code, {
        mountExport: 'mount',
        observeExport: 'observe',
        props: { svg },
        steps: [
          { kind: 'record', label: 'initial' },
          {
            kind: 'dispatch',
            constructor: 'MouseEvent',
            selector: '#inc',
            event: 'click',
            init: { bubbles: true },
          },
          { kind: 'record', label: 'updated' },
          {
            kind: 'dispatch',
            constructor: 'MouseEvent',
            selector: '#toggle',
            event: 'click',
            init: { bubbles: true },
          },
          { kind: 'record', label: 'hidden' },
          {
            kind: 'dispatch',
            constructor: 'MouseEvent',
            selector: '#inc',
            event: 'click',
            init: { bubbles: true },
          },
          {
            kind: 'dispatch',
            constructor: 'MouseEvent',
            selector: '#toggle',
            event: 'click',
            init: { bubbles: true },
          },
          { kind: 'record', label: 'remounted' },
          { kind: 'dispose' },
          { kind: 'record', label: 'disposed' },
        ],
      })
      assert.deepEqual(observed, [
        { label: 'initial', value: { text: '2', namespace, cleaned: 0 } },
        { label: 'updated', value: { text: '4', namespace, cleaned: 0 } },
        { label: 'hidden', value: { text: null, namespace: null, cleaned: 0 } },
        { label: 'remounted', value: { text: '6', namespace, cleaned: 0 } },
        { label: 'disposed', value: { text: null, namespace: null, cleaned: 1 } },
      ])
    }
  })
}

const scalarExpressions = [
  'count * 2',
  '-count + 1',
  '~count',
  'count / 0',
  'count ** 0.5',
  'count > 0',
  'count === 1',
  'count ? count : "zero"',
  'count || "zero"',
  '`row:${count}`',
  '(count, count + 1)',
  'typeof count',
]
for (const profile of profiles) {
  test(`equal scalar results retain conditional DOM identity and input state: ${JSON.stringify(profile)}`, async () => {
    const source =
      fixture
        .replace('count * 2', 'count % 2')
        .replace('count++', 'count += 2')
        .replace(
          '<span id="value">{value}</span>',
          '<span id="value"><input id="stable" />{value}</span>',
        ) +
      `
        let initialNode
        export function remember() { initialNode = document.querySelector('#value') }
        export function identity() { return { ...observe(), same: initialNode === document.querySelector('#value'), input: document.querySelector('#stable')?.value ?? null } }
      `
    const code = compile(source, profile)
    memoRetained(code, !profile.optimize)
    assert.deepEqual(
      await executeDomCommonJs(code, {
        mountExport: 'mount',
        observeExport: 'identity',
        props: { svg: false },
        steps: [
          { kind: 'call', exportName: 'remember' },
          {
            kind: 'dispatch',
            selector: '#stable',
            constructor: 'Event',
            event: 'input',
            assign: { value: 'retained' },
          },
          { kind: 'click', selector: '#inc' },
          { kind: 'record', label: 'equal update' },
          { kind: 'dispose' },
          { kind: 'record', label: 'dispose' },
        ],
      }),
      [
        {
          label: 'equal update',
          value: {
            text: '1',
            namespace: 'http://www.w3.org/1999/xhtml',
            cleaned: 0,
            same: true,
            input: 'retained',
          },
        },
        {
          label: 'dispose',
          value: { text: null, namespace: null, cleaned: 1, same: false, input: null },
        },
      ],
    )
  })
}

for (const profile of profiles) {
  test(`total scalar operations have source and final-code proofs: ${JSON.stringify(profile)}`, () => {
    for (const expression of scalarExpressions) {
      const code = compile(
        `import {$state} from 'fict'; export function App() {
        let count = $state(1); const value = ${expression}; return <span>{value}</span>
      }`,
        profile,
      )
      memoRetained(code, !profile.optimize)
    }
  })
}

test('user-name and compiler-name inlining options retain their separate contracts', () => {
  for (const fineGrainedDom of [true, false]) {
    memoRetained(compile(fixture, { fineGrainedDom, inlineDerivedMemos: false }), true)
    for (const name of ['__value', '__fictReactive', '__fictUseMemo']) {
      memoRetained(
        compile(fixture.replaceAll('value', name), { fineGrainedDom, inlineDerivedMemos: false }),
        false,
        name,
      )
    }
  }
})

const retainedCases = [
  [
    'two text consumers',
    'const value = count * 2',
    '<main><i>{value}</i><b>{value}</b></main>',
    '',
  ],
  ['attribute consumer', 'const value = count * 2', '<div title={value} />', ''],
  ['component prop', 'const value = count * 2', '<Child value={value} />', ''],
  ['component children', 'const value = count * 2', '<Child>{value}</Child>', ''],
  [
    'captured consumer',
    'const value = count * 2',
    '<main>{[1].map(() => <i>{value}</i>)}</main>',
    '',
  ],
  ['explicit memo', 'const value = $memo(() => count * 2)', '<i>{value}</i>', ''],
  ['opaque call', 'const value = Number(count)', '<i>{value}</i>', ''],
  [
    'unknown later write',
    'const value = count * 2',
    '<main><button onClick={e => count = e.detail} /><i>{value}</i></main>',
    '',
  ],
  [
    'object later write',
    'const value = count * 2',
    '<main><button onClick={() => count = {valueOf() { return 3 }}} /><i>{value}</i></main>',
    '',
  ],
  [
    'destructured later write',
    'const value = count * 2',
    '<main><button onClick={() => [count] = props.items} /><i>{value}</i></main>',
    '',
  ],
  [
    'for-of later write',
    'const value = count * 2',
    '<main><button onClick={() => { for (count of props.items) {} }} /><i>{value}</i></main>',
    '',
  ],
  ['property read', 'const value = count + props.value', '<i>{value}</i>', ''],
  [
    'mutable lexical dependency',
    'const value = count + extra',
    '<i>{value}</i>',
    'let extra = 1; extra = props.value;',
  ],
  [
    'snapshot consumer',
    'const value = count * 2; const snapshot = untrack(() => value)',
    '<i>{snapshot}</i>',
    '',
  ],
]
for (const profile of profiles) {
  test(`materialization boundaries remain conservative: ${JSON.stringify(profile)}`, () => {
    for (const [name, declaration, jsx, before] of retainedCases) {
      const code = compile(
        `
        import {$state, $memo, untrack} from 'fict';
        function Child(props) { return <span>{props.value}:{props.children}</span> }
        export function App(props) {
          let count = $state(1); ${before} ${declaration}; return ${jsx}
        }
      `,
        profile,
        false,
      )
      assert.match(code, /const value = .*__fictUseMemo/, `${name}: ${code}`)
    }
  })
}

test('state proof checks dependency writes transitively and does not trust assertions', () => {
  for (const fineGrainedDom of [true, false]) {
    const source = `import {$state} from 'fict'; export function App(props) {
      let first = $state(1); let count = $state(2); const value = count * 2;
      return <main><button onClick={() => {first = props.value; count = first}}/><i>{value}</i></main>
    }`
    memoRetained(compile(source, { fineGrainedDom }, false), true)
    memoRetained(
      compile(source.replace('first = props.value', 'first = 3'), { fineGrainedDom }),
      false,
    )
    memoRetained(
      compile(
        source.replace('first = props.value', 'first = props.value as number'),
        { fineGrainedDom },
        false,
      ),
      true,
    )
  }
})

test('initialization order, captured ownership and allocation boundaries are preserved', () => {
  for (const profile of profiles) {
    for (const source of [
      `import {$state} from 'fict'; export function App() {
        const value = count * 2; let count = $state(1); return <i>{value}</i>
      }`,
      `import {$state} from 'fict'; export function App() {
        let count = $state(1);
        function Child() { const value = count * 2; return <i>{value}</i> }
        return <Child/>
      }`,
      `import {$state} from 'fict'; export function App() {
        let count = $state(1); const value = count ? /a/g : /b/g; return <i>{value}</i>
      }`,
      `import {$state} from 'fict'; export function App() {
        let count = $state('a'); const value = count + count;
        return <main><button onClick={() => count += count}/><i>{value}</i></main>
      }`,
      `import {$state} from 'fict'; export function App(props) {
        if (props.active) { var count = $state(1) }
        const value = count * 2; return <i>{value}</i>
      }`,
    ]) {
      const request = {
        code: source,
        filename: '/jsx-inline-boundary.tsx',
        options: { dev: false, strictGuarantee: false, ...profile },
      }
      const result = native.transformSync(request)
      const control = native.transformSync({
        ...request,
        options: { ...request.options, inlineDerivedMemos: false },
      })
      assert.equal(result.code, control.code)
      assert.deepEqual(result.diagnostics, control.diagnostics)
    }
  }
})

const coercionFixture = `
  import {$state, $memo, render, onDestroy} from 'fict'
  let coercions = 0, cleaned = 0
  function App() {
    let count = $state({valueOf() { coercions++; return 2 }})
    const value = count * 2
    onDestroy(() => cleaned++)
    return <main><button id="inc" onClick={() => count = {valueOf() {coercions++; return 3}}} /><i id="value">{value}</i></main>
  }
  export function mount(root) { return render(() => <App />, root) }
  export function observe() { return {text: document.querySelector('#value')?.textContent ?? null, coercions, cleaned} }
`
for (const profile of profiles) {
  test(`object coercions preserve memo evaluation counts and cleanup: ${JSON.stringify(profile)}`, async () => {
    const code = compile(coercionFixture, profile, false)
    memoRetained(code, true)
    const scenario = {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#inc' },
        { kind: 'record', label: 'update' },
        { kind: 'dispose' },
        { kind: 'record', label: 'dispose' },
      ],
    }
    const control = compile(coercionFixture, { ...profile, inlineDerivedMemos: false }, false)
    assert.equal(code, control)
    const trace = await executeDomCommonJs(code, scenario)
    assert.deepEqual(trace, await executeDomCommonJs(control, scenario))
    assert.deepEqual(
      trace.map(({ label, value: { text, cleaned } }) => ({ label, text, cleaned })),
      [
        { label: 'initial', text: '4', cleaned: 0 },
        { label: 'update', text: '6', cleaned: 0 },
        { label: 'dispose', text: null, cleaned: 1 },
      ],
    )
    assert.equal(trace[0].value.coercions, 1)
    assert.equal(trace[1].value.coercions, trace[2].value.coercions)
  })
}

function load(code) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      if (request === 'fict') return runtime
      if (request === 'fict/internal') return internal
      throw new Error(`Unexpected test dependency ${request}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

for (const profile of profiles) {
  test(`SSR retains values, errors and request cleanup: ${JSON.stringify(profile)}`, () => {
    for (const [initializer, expression, text, error] of [
      ['2', 'count * 2', '4'],
      ['-1', 'count / 0', '-Infinity'],
      ['2', '$memo(() => count * 2)', '4'],
      ['1n', 'count / 0n', null, RangeError],
      ['Symbol("input")', 'count * 2', null, TypeError],
    ]) {
      const source = `import {$state, $memo, onDestroy} from 'fict'; export let cleaned = 0;
        export function App() {let count = $state(${initializer}); const value = ${expression};
          onDestroy(() => cleaned++); return <i>{value}</i>}`
      const fixture = load(compile(source, profile, false))
      const render = () => ssr.renderToString(() => ({ type: fixture.App, props: {} }))
      if (error) assert.throws(render, error)
      else assert.equal(JSDOM.fragment(render()).querySelector('i').textContent, text)
      assert.equal(fixture.cleaned, 1)
    }
  })
}
