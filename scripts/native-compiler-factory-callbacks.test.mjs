import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const binding = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(options => [true, false].map(fineGrainedDom => ({ ...options, fineGrainedDom })))

function compile(code, options = {}) {
  return binding.transformSync({
    code,
    filename: '/factory-callbacks.tsx',
    options: { dev: false, strictGuarantee: true, ...options },
  })
}

const imports = `import { $state, useTransition } from 'fict';
  import { resource } from 'fict/plus';
  import { reactive } from 'fict/advanced';`

test('published Resource recipes compile with strict guarantees in every output profile', async () => {
  const cookbook = await readFile(path.join(root, 'docs/strict-guarantee-cookbook.md'), 'utf8')
  const readme = await readFile(path.join(root, 'README.md'), 'utf8')
  const examples = [
    cookbook.match(
      /<!-- strict-example: resource-getter -->\s*```tsx\n([\s\S]*?)\n```\s*<!-- \/strict-example -->/,
    ),
    readme.match(/### Suspense\s*```tsx\n([\s\S]*?)\n```/),
  ]
  for (const example of examples) {
    assert.ok(example, 'missing executable Resource recipe')
    for (const profile of profiles) {
      const result = compile(example[1], profile)
      assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics))
      assert.ok(result.code)
    }
  }
})

test('intact runtime factory results own explicitly marked getters and transition callbacks', () => {
  for (const profile of profiles) {
    for (const setup of [
      `const api = resource(async (_, id) => id); const beginRead = api.read;`,
      `const factory = resource; const api = factory(async (_, id) => id); const beginRead = api.read;`,
      `const api = resource(async (_, id) => id); const alias = api; const beginRead = alias.read;`,
      `const api = resource(async (_, id) => id); const { read: beginRead } = api;`,
    ]) {
      const result = compile(
        `${imports} ${setup}
        export function App() {
          let id = $state('one');
          const [pending, start] = useTransition();
          const begin = start;
          const value = beginRead(reactive(() => id));
          return <button onClick={() => begin(() => id = 'two')}>{value.data}:{pending()}</button>
        }`,
        profile,
      )
      assert.deepEqual(result.diagnostics, [], `${setup}: ${JSON.stringify(result.diagnostics)}`)
      assert.ok(result.code)
    }
    const namespaced = compile(
      `import { $state } from 'fict';
      import * as Runtime from 'fict'; import * as Query from 'fict/plus';
      import * as Advanced from 'fict/advanced';
      const api = Query.resource(async (_, id) => id);
      export function App() {
        let id = $state('one'); const transition = Runtime.useTransition();
        const value = api.read(Advanced.reactive(() => id));
        return <button onClick={() => transition[1](() => id = 'two')}>{value.data}</button>
      }`,
      profile,
    )
    assert.deepEqual(namespaced.diagnostics, [])
  }
})

test('unknown, overwritten, escaped and asynchronous factory contracts remain boundaries', () => {
  const cases = [
    `${imports} const api = resource(async (_, id) => id); export function App() { let id=$state(0); api.read(() => id); return <p>{id}</p> }`,
    `import { $state } from 'fict'; import { resource } from 'external'; import { reactive } from 'fict/advanced'; const api=resource(); export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} const api = resource(async (_, id) => id); api.read = fn => fn; export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} const api = resource(async (_, id) => id); const other=api; other.read=fn=>fn; export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} const api = resource(async (_, id) => id); Object.assign(api, {read: fn=>fn}); export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} import { replace } from 'external'; const api = resource(async (_, id) => id); replace(api); export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} export const api = resource(async (_, id) => id); export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    ...[
      'export { api }',
      'const alias = api; export { alias }',
      'export const holder = { api }',
      'export const holder = [{ nested: api }]',
      'globalThis.holder = { api }',
      'export default { api }',
      'export class Holder { value = api }',
      'export function fail() { throw api }',
      'export function* getApi() { yield api }',
      'let holder = api; globalThis.saved = holder; holder = {}',
      'export default [{ api }]',
      'export const getter = () => api',
      'export function getApi() { return api }',
      'export const holder = { get value() { return api } }',
      'export const holder = { api }; holder.api = {}',
      'let holder; export { holder }; holder = api',
      'export function Holder() { return <External api={api}/> }',
      'export function Holder() { return <External {...{ api }}/> }',
      'const holder = { api }; globalThis.holder = holder; holder.api = {}',
      'const holder = [api]; globalThis.holder = holder; holder[0] = {}',
      'function expose() { const holder = { api }; globalThis.holder = holder; holder.api = {} }; expose()',
    ].map(
      exposure =>
        `${imports} const api = resource(async (_, id) => id); ${exposure}; export function App(){let id=$state(0);api.read(reactive(()=>id));return <p>{id}</p>}`,
    ),
    `${imports} const api = resource(async (_, id) => id); export function App(){let id=$state(0);api.read(reactive(async()=>{await Promise.resolve(); return id}));return <p>{id}</p>}`,
    `${imports} const api = resource(async (_, id) => id); export function App(){let id=$state(0);api.read(reactive(function*(){yield id}));return <p>{id}</p>}`,
    `${imports} const api = resource(async (_, id) => id); export function App(){let id=$state(0);const reactive=fn=>fn;api.read(reactive(()=>id));return <p>{id}</p>}`,
    `${imports} export function App(){let id=$state(0);const [pending,start]=useTransition();start(async()=>{await Promise.resolve(); id++});return <p>{id}:{pending()}</p>}`,
    `${imports} export function App(){let id=$state(0);let [pending,start]=useTransition();start=fn=>{globalThis.saved=fn};start(()=>id++);return <p>{id}:{pending()}</p>}`,
    `import { $state } from 'fict';import { useTransition } from 'external';export function App(){let id=$state(0);const [pending,start]=useTransition();start(()=>id++);return <p>{id}:{pending()}</p>}`,
    `${imports} Array.prototype[Symbol.iterator]=function*(){yield false;yield fn=>{globalThis.saved=fn}};export function App(){let id=$state(0);const [pending,start]=useTransition();start(()=>id++);return <p>{id}</p>}`,
  ]
  for (const source of cases) {
    for (const profile of profiles) {
      const result = compile(source, profile)
      assert.equal(result.code, '', source)
      assert.ok(
        result.diagnostics.some(
          d => ['FICT-R002', 'FICT-R005'].includes(d.code) && d.severity === 'error',
        ),
        JSON.stringify(result.diagnostics),
      )
    }
  }
  const ordinary = compile(
    `${imports} const api=resource(async (_, fn) => fn());export function App(){const result=api.read(()=>123);return <p>{result.data}</p>}`,
  )
  assert.deepEqual(ordinary.diagnostics, [])
  assert.match(ordinary.code, /api\.read\(\(\) => 123\)/)
})

async function flush() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

for (const [index, profile] of profiles.entries()) {
  test(`resource keys and causal transitions update through compiled factory callbacks (${index})`, async () => {
    const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
    const globals = [
      'window',
      'document',
      'Node',
      'Element',
      'HTMLElement',
      'SVGElement',
      'Text',
      'Comment',
      'Document',
      'DocumentFragment',
      'Event',
    ]
    const previous = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
    globals.forEach(name =>
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: dom.window[name],
      }),
    )
    const filename = path.join(
      root,
      'packages/fict',
      `.native-factory-callbacks-${process.pid}-${index}.mjs`,
    )
    let stop
    try {
      const transitionSetup = [
        'const [pending,start]=useTransition();',
        'const make=useTransition;const pair=make();const pending=pair[0];const start=pair[1];',
        'const [pending,baseStart]=Runtime.useTransition();const start=baseStart;',
      ][Math.floor(index / 2)]
      const pendingRead = Math.floor(index / 2) === 1 ? 'pair[0]()' : 'pending()'
      const compiled = compile(
        `${imports} import { render } from 'fict'; import * as Runtime from 'fict';
        export const requests = [];
        export const releases = [];
        export const aborted = [];
        export const identities = [];
        const api = resource({ cache: { mode: 'none' }, fetch: ({signal}, id) => {
          requests.push(id);
          signal.addEventListener('abort', () => aborted.push(id));
          return new Promise(resolve => releases.push(() => resolve('loaded:' + id)));
        }});
        function App(){
          let id=$state('one');${transitionSetup}
          const alias=pending;
          identities.push(typeof pending, alias === pending, typeof start);
          const pendingLabel=${pendingRead} ? 'pending' : 'settled';
          const read=api.read;
          const view=read(reactive(()=>id));
          return <section><button onClick={()=>start(()=>id='two')}>Next</button>
            <button onClick={()=>start(()=>id='three')}>Supersede</button>
            <p data-testid="pending">{${pendingRead} ? 'pending' : 'settled'}</p>
            <p data-testid="derived-pending">{pendingLabel}</p>
            <p data-testid="result">{view.loading ? 'loading' : view.data}</p></section>
        }
        export const mount=container=>render(()=> <App/>,container);`,
        profile,
      )
      assert.deepEqual(compiled.diagnostics, [])
      await writeFile(filename, compiled.code)
      const fixture = await import(pathToFileURL(filename).href)
      const container = document.createElement('div')
      document.body.append(container)
      stop = fixture.mount(container)
      await flush()
      assert.deepEqual(fixture.identities, ['function', true, 'function'])
      assert.deepEqual(fixture.requests, ['one'])
      fixture.releases[0]()
      await flush()
      assert.equal(container.querySelector('[data-testid="result"]').textContent, 'loaded:one')
      container.querySelectorAll('button')[0].click()
      await flush()
      assert.deepEqual(fixture.requests, ['one', 'two'])
      assert.equal(container.querySelector('[data-testid="pending"]').textContent, 'pending')
      assert.equal(
        container.querySelector('[data-testid="derived-pending"]').textContent,
        'pending',
      )
      container.querySelectorAll('button')[1].click()
      await flush()
      assert.deepEqual(fixture.requests, ['one', 'two', 'three'])
      assert.ok(fixture.aborted.includes('two'))
      fixture.releases[1]()
      await flush()
      assert.equal(container.querySelector('[data-testid="pending"]').textContent, 'pending')
      fixture.releases[2]()
      await flush()
      assert.equal(container.querySelector('[data-testid="result"]').textContent, 'loaded:three')
      assert.equal(container.querySelector('[data-testid="pending"]').textContent, 'settled')
      assert.equal(
        container.querySelector('[data-testid="derived-pending"]').textContent,
        'settled',
      )
      container.querySelectorAll('button')[0].click()
      await flush()
      assert.equal(fixture.requests.at(-1), 'two')
      stop()
      stop = undefined
      assert.equal(container.childNodes.length, 0)
      assert.equal(fixture.aborted.filter(id => id === 'two').length, 2)
      const requests = fixture.requests.length
      fixture.releases.at(-1)()
      await flush()
      assert.equal(fixture.requests.length, requests)
    } finally {
      stop?.()
      await unlink(filename).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      globals.forEach((name, i) => {
        if (previous[i]) Object.defineProperty(globalThis, name, previous[i])
        else delete globalThis[name]
      })
      dom.window.close()
    }
  })
}
