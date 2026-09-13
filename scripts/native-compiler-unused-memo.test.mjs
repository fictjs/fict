import assert from 'node:assert/strict'
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

function compile(code, options = {}, moduleKind = 'commonjs') {
  const result = native.transformSync({
    code,
    filename: '/unused-memo.tsx',
    moduleKind,
    options: { dev: false, strictGuarantee: true, explain: true, ...options },
  })
  assert.ok(result.code, JSON.stringify(result.diagnostics))
  assert.ok(
    !result.diagnostics.some(d => d.severity === 'error'),
    JSON.stringify(result.diagnostics),
  )
  return result
}

function decision(result, name) {
  const graph = result.explain.reactiveGraph
  const binding = graph.bindings.find(binding => binding.name === name)
  assert.ok(binding, `missing binding ${name}`)
  return graph.decisions.find(decision => decision.binding === binding.id)
}

function load(code) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      if (request === 'fict') return runtime
      if (request === 'fict/internal') return internal
      throw new Error(`Unexpected dependency ${request}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

const simple = `import {$state} from 'fict'; export function App() {
  let count=$state(1); const dead=count*7;
  return <button onClick={()=>count++}>{count}</button>
}`

test('SSA counters distinguish analyzed candidates from unconsumed rewrite plans', () => {
  const source = 'export function f(flag,value){let x=value;if(flag)x=value;return x}'
  for (const profile of profiles) {
    const result = compile(source, profile)
    const counters = result.stats.counters
    assert.equal(counters.dceInlineCandidatesAnalyzed > 0, profile.optimize)
    assert.equal(counters.dceTrivialPhisAnalyzed, profile.optimize ? 1 : 0)
    assert.equal(counters.dceInlineCandidatesRewritten, 0)
    assert.equal(counters.dceTrivialPhisRewritten, 0)
    assert.match(result.code, /if \(flag\) x = value;/)
    const compiled = load(result.code)
    for (const flag of [true, false])
      for (const value of [undefined, null, -0, NaN, {}, Symbol('value')])
        assert.ok(Object.is(compiled.f(flag, value), value))
  }
})

for (const profile of profiles) {
  test(`unused scalar elimination removes the declaration and helper import: ${JSON.stringify(profile)}`, () => {
    for (const moduleKind of ['module', 'commonjs']) {
      const result = compile(simple, profile, moduleKind)
      assert.deepEqual(result.diagnostics, [])
      const optimized = profile.optimize
      assert.equal(decision(result, 'dead').action, optimized ? 'eliminate' : 'retain')
      assert.equal(
        decision(result, 'dead').reason,
        optimized ? 'unused-total-scalar-derived' : 'optimizer-disabled',
      )
      assert.equal(/const dead\b/.test(result.code), !optimized, result.code)
      assert.equal(/__fictUseMemo/.test(result.code), !optimized, result.code)
      const graph = result.explain.reactiveGraph
      assert.equal(
        graph.calls.some(call => call.helper === 'useMemo'),
        !optimized,
      )
      assert.ok(graph.operations.some(operation => operation.kind === 'create-derived'))
      assert.equal(graph.sourceAnchorsVerified, true)
    }
  })
}

test('unused memo elimination respects optimizer, name, uncached and Preview policies', () => {
  for (const profile of profiles) {
    const retained = compile(simple, { ...profile, inlineDerivedMemos: false })
    assert.match(retained.code, /const dead = .*__fictUseMemo/)
    const uncached = compile(
      simple.replace('function App() {', 'function App() { "use no memo";'),
      profile,
    )
    assert.equal(decision(uncached, 'dead').action, 'accessor')
    assert.match(uncached.code, /const dead =/)
    const preview = compile(simple, { ...profile, preview: { resumable: true } }, 'module')
    assert.notEqual(decision(preview, 'dead').action, 'eliminate')
  }
})

const retainedCases = [
  ['unknown call', '1', 'Number(count)', ''],
  ['object coercion', '{valueOf(){return 2}}', 'count*2', ''],
  ['BigInt division', '1n', 'count/0n', ''],
  ['Symbol coercion', 'Symbol("value")', 'count*2', ''],
  ['property input', '1', 'count+props.value', ''],
  ['allocation', '1', 'count ? /a/g : /b/g', ''],
  ['string recurrence', '"a"', 'count+count', 'count+=count'],
  ['unknown write', '1', 'count*2', 'count=props.value'],
  ['asserted write', '1', 'count*2', 'count=props.value as number'],
  ['destructured write', '1', 'count*2', '[count]=props.values'],
  ['explicit memo', '1', '$memo(()=>count*2)', ''],
]
for (const profile of profiles) {
  test(`unproved unused work remains materialized: ${JSON.stringify(profile)}`, () => {
    for (const [name, initial, expression, write] of retainedCases) {
      const source = `import {$state,$memo} from 'fict'; export function App(props) {
        let count=$state(${initial}); const dead=${expression};
        return <button onClick={()=>{${write}}}>unused</button>
      }`
      const result = compile(source, { ...profile, strictGuarantee: false })
      assert.match(result.code, /const dead = .*__fictUseMemo/, `${name}: ${result.code}`)
      assert.notEqual(decision(result, 'dead').action, 'eliminate', name)
    }
  })
}

test('initialization, transitive writes, captured values and derived chains retain their boundaries', () => {
  for (const source of [
    `import {$state} from 'fict'; export function App(){const dead=count*2;let count=$state(1);return <i/>}`,
    `import {$state} from 'fict'; export function App(){let count=$state(1);function Child(){const dead=count*2;return <i/>}return <Child/>}`,
    `import {$state} from 'fict'; export function App(props){let input=$state(1);let count=$state(1);const dead=count*2;return <button onClick={()=>{input=props.value;count=input}}/>}`,
    `import {$state} from 'fict'; export function App(){let count=$state(1);const first=count*2;const dead=first*2;return <i/>}`,
    `import {$state} from 'fict'; export function useValue(){let count=$state(1);const dead=count*2;return dead}`,
  ]) {
    const result = compile(source, { strictGuarantee: false })
    assert.match(result.code, /const dead =/)
    const graph = result.explain.reactiveGraph
    const binding = graph.bindings.find(binding => binding.name === 'dead')
    if (binding) assert.notEqual(decision(result, 'dead')?.action, 'eliminate', result.code)
  }
  const conditional = `import {$state} from 'fict'; export function App(props){if(props.active){var count=$state(1)} const dead=count*2;return <i/>}`
  const rejected = options =>
    native.transformSync({
      code: conditional,
      filename: '/unused-memo.tsx',
      options: { dev: false, ...options },
    })
  const result = rejected({})
  const control = rejected({ inlineDerivedMemos: false })
  assert.equal(result.code, '')
  assert.deepEqual(result.diagnostics, control.diagnostics)
  assert.ok(result.diagnostics.some(d => d.code === 'FICT-PLACEMENT-STATE-CONTROL'))
})

const fixture = `import {$state,$effect,render,onDestroy} from 'fict';
  let cleaned=0;const events=[];
  function App(){
    let count=$state(1);const dead=count*7, live=count%2;
    $effect(()=>{events[events.length]=count;return ()=>events.push('cleanup')});
    onDestroy(()=>cleaned++);
    return <main><button id="inc" onClick={()=>count++}/><i id="value">{live}:{live}</i></main>
  }
  export function mount(root){return render(()=> <App/>,root)}
  export function observe(){return {text:document.querySelector('#value')?.textContent??null,cleaned,events:[...events]}}
`
for (const profile of profiles) {
  test(`mixed live/dead declarators preserve updates, effect order and cleanup: ${JSON.stringify(profile)}`, async () => {
    const optimized = compile(fixture, profile)
    const control = compile(fixture, { ...profile, inlineDerivedMemos: false })
    assert.equal(/\bdead =/.test(optimized.code), !profile.optimize, optimized.code)
    assert.match(optimized.code, /\blive = .*__fictUseMemo/)
    const scenario = {
      mountExport: 'mount',
      observeExport: 'observe',
      steps: [
        { kind: 'record', label: 'initial' },
        { kind: 'click', selector: '#inc' },
        { kind: 'record', label: 'updated' },
        { kind: 'click', selector: '#inc' },
        { kind: 'record', label: 'restored' },
        { kind: 'dispose' },
        { kind: 'record', label: 'disposed' },
      ],
    }
    const trace = await executeDomCommonJs(optimized.code, scenario)
    assert.deepEqual(trace, await executeDomCommonJs(control.code, scenario))
    assert.deepEqual(
      trace.map(entry => entry.value.text),
      ['1:1', '0:0', '1:1', null],
    )
    assert.equal(trace.at(-1).value.cleaned, 1)
    assert.deepEqual(trace.at(-1).value.events, [1, 'cleanup', 2, 'cleanup', 3, 'cleanup'])
  })

  test(`SSR preserves unused-work evaluation, errors and request cleanup: ${JSON.stringify(profile)}`, () => {
    for (const [initial, expression] of [
      ['1', 'count*2'],
      ['{valueOf(){events.push("coerce");return 2}}', 'count*2'],
      ['1n', 'count/0n'],
      ['Symbol("input")', 'count*2'],
    ]) {
      const source = `import {$state,onDestroy} from 'fict';export let cleaned=0;export const events=[];
        export function App(){let count=$state(${initial});onDestroy(()=>cleaned++);
          const dead=${expression};return <i>ok</i>}`
      const run = options => {
        const result = compile(source, { ...options, strictGuarantee: false })
        const loaded = load(result.code)
        let text, error
        try {
          text = JSDOM.fragment(
            ssr.renderToString(() => ({ type: loaded.App, props: {} })),
          ).querySelector('i').textContent
        } catch (caught) {
          error = { name: caught.name, message: caught.message }
        }
        return { text, error, cleaned: loaded.cleaned, events: loaded.events }
      }
      const observed = run(profile)
      assert.deepEqual(observed, run({ ...profile, inlineDerivedMemos: false }))
      assert.equal(observed.cleaned, 1)
    }
  })
}
