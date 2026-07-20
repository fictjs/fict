import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
const binding = require(path.join(root, 'target/release/fict_compiler_napi.node'))
const runtime = require(path.join(root, 'packages/runtime/dist/internal.cjs'))
const corpus = JSON.parse(
  readFileSync(
    path.join(root, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  ),
)
const acceptanceReview = JSON.parse(
  readFileSync(path.join(root, 'scripts/fixtures/compiler_rust_acceptance_reviews.json'), 'utf8'),
)

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

const probes = [
  {
    id: 'packages/compiler/test/alias-reactivity.test.ts:70:transform',
    suffix: 'export function probe() { return Component() }',
    expected: 1,
  },
  {
    id: 'packages/compiler/test/alias-reactivity.test.ts:84:transform',
    suffix: 'export function probe() { return Component() }',
    expected: 1,
  },
  {
    id: 'packages/compiler/test/base-transform.test.ts:586:transformRawTypeScript',
    suffix: 'export function probe() { return [Color.Red, Color[1]] }',
    expected: [1, 'Red'],
  },
  {
    id: 'packages/compiler/test/base-transform.test.ts:594:transformRawTypeScript',
    suffix: 'export function probe() { return [Color.Red, Color[1]] }',
    expected: [1, 'Red'],
  },
  {
    id: 'packages/compiler/test/base-transform.test.ts:1224:transform',
    suffix: `
      export function probe() {
        Component()
        return 'completed'
      }
    `,
    diagnosticCodes: ['FICT-C004'],
    expected: 'completed',
  },
  {
    id: 'packages/compiler/test/control-flow-runtime.test.ts:2959:compileAndRunHook',
    suffix: '',
    exportName: 'useRun',
    expectedError: 'ReferenceError',
  },
  {
    id: 'packages/compiler/test/control-flow-runtime.test.ts:4531:transformCommonJS',
    suffix: `
      export function useProbe() {
        return useRun()
      }
    `,
    exportName: 'useProbe',
    resolveAccessor: true,
    expected: 1,
  },
  {
    id: 'packages/compiler/test/control-flow-runtime.test.ts:4590:compileAndRunHook',
    suffix: `
      export function useProbe() {
        const result = useRun()
        const before = result.view()
        result.set(4)
        return [before, result.view()]
      }
    `,
    exportName: 'useProbe',
    expected: ['01', '01'],
  },
  {
    id: 'packages/compiler/test/control-flow.test.ts:953:runTransform',
    suffix: `
      export function probe() {
        const node = Component()
        return [node.type, node.props.children]
      }
    `,
    diagnosticCodes: ['FICT-R006'],
    expected: ['div', 'none'],
  },
  {
    id: 'packages/compiler/test/do-while-break.test.ts:33:transform',
    suffix: 'export function probe() { return Component() }',
    expected: 5,
  },
  {
    id: 'packages/compiler/test/do-while-break.test.ts:50:transform',
    suffix: 'export function probe() { return Component() }',
    expected: 6,
  },
  {
    id: 'packages/compiler/test/do-while-break.test.ts:82:transform',
    suffix: 'export function probe() { return Component() }',
    expected: 15,
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:500:transform',
    suffix: 'export function probe() { return App() }',
    expected: 0,
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:513:transform',
    suffix: 'export { App as probe }',
    expectedError: 'TypeError',
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:526:transform',
    suffix: 'export { App as probe }',
    expectedError: 'TypeError',
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:1933:transform',
    suffix: 'export function probe() { return App().type }',
    expected: 'div',
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:1948:transform',
    suffix: `
      export function probe() {
        const node = App()
        const read = () =>
          typeof node.props.children === 'function'
            ? node.props.children()
            : node.props.children
        const before = read()
        node.props.onClick()
        return [before, read()]
      }
    `,
    expected: [0, 0],
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:1963:transform',
    suffix: `
      export function probe() {
        const node = App()
        const read = () =>
          typeof node.props.children === 'function'
            ? node.props.children()
            : node.props.children
        const before = read()
        node.props.onClick()
        return [before, read()]
      }
    `,
    expected: [0, 0],
  },
  {
    id: 'packages/compiler/test/semantic-validation.test.ts:2062:transform',
    suffix: 'export { App as probe }',
    expectedError: 'TypeError',
  },
  {
    id: 'packages/compiler/test/spec-complete.test.ts:619:transform',
    suffix: `
      export function probe() {
        Component()
        return 'completed'
      }
    `,
    diagnosticCodes: ['FICT-C004'],
    expected: 'completed',
  },
  {
    id: 'packages/compiler/test/warnings-as-errors.test.ts:156:transform',
    suffix: `
      import { $state } from 'fict'
      let setMode
      function AuditApp() {
        let mode = $state(2)
        setMode = next => { mode = next }
        return <App mode={mode} />
      }
      export function probe() {
        return <AuditApp />
      }
      export function update(next) { setMode(next) }
    `,
    renderToDom: true,
    expected: [
      ['span', '2'],
      ['div', '0'],
      ['div', '1'],
      ['span', '3'],
    ],
    updates: [0, 1, 3],
  },
]

const acceptancePolicies = new Set(Object.keys(acceptanceReview.policies))
const acceptanceFixtures = corpus.fixtures.filter(fixture =>
  acceptancePolicies.has(fixture.deviationPolicy),
)
const fixturesById = new Map(acceptanceFixtures.map(fixture => [fixture.id, fixture]))
const reviewsById = new Map(acceptanceReview.reviews.map(review => [review.id, review]))

test('runtime probes cover every explicitly classified Rust acceptance exactly once', () => {
  assert.equal(probes.length, 21)
  assert.deepEqual(
    probes.map(probe => probe.id).sort(),
    acceptanceFixtures.map(fixture => fixture.id).sort(),
  )
  assert.deepEqual(
    probes.map(probe => probe.id).sort(),
    acceptanceReview.reviews.map(review => review.id).sort(),
  )
  assert.equal(
    acceptanceReview.reviews.filter(
      review => acceptanceReview.policies[review.policy].capabilityClaim,
    ).length,
    6,
  )
})

function compileProbe(probe) {
  const fixture = fixturesById.get(probe.id)
  assert.ok(fixture, probe.id)
  const result = binding.transformSync({
    code: `${fixture.source}\n${probe.suffix}`,
    filename: `/fixtures/capability-expansion-${probes.indexOf(probe)}.tsx`,
    language: 'tsx',
    moduleKind: 'commonjs',
    options: { ...fixture.options, fineGrainedDom: false },
  })
  assert.deepEqual(
    result.diagnostics.map(diagnostic => diagnostic.code),
    probe.diagnosticCodes ?? [],
    `${probe.id}: ${result.diagnostics.map(diagnostic => diagnostic.message).join('\n')}`,
  )
  assert.notEqual(result.code, '', probe.id)
  return result.code
}

function loadProbe(code) {
  const module = { exports: {} }
  const requireRuntime = request => {
    if (request === 'fict/internal' || request === '@fictjs/runtime/internal') return runtime
    throw new Error(`Unexpected capability-expansion import ${JSON.stringify(request)}`)
  }
  new Function('require', 'module', 'exports', code)(requireRuntime, module, module.exports)
  return module.exports
}

for (const probe of probes) {
  const review = reviewsById.get(probe.id)
  assert.ok(review, probe.id)
  test(`executes reviewed Rust acceptance (${review.policy}): ${probe.id}`, async () => {
    const compiled = loadProbe(compileProbe(probe))
    const entry = compiled[probe.exportName ?? 'probe']
    assert.equal(typeof entry, 'function', probe.id)
    runtime.__fictResetContext()
    try {
      const invoke = () => {
        if (probe.renderToDom) {
          const container = document.createElement('div')
          const dispose = runtime.render(
            () => runtime.__fictRender({ slots: [], cursor: 0 }, () => entry()),
            container,
          )
          if (probe.updates === undefined) {
            try {
              return [container.firstElementChild?.tagName.toLowerCase(), container.textContent]
            } finally {
              dispose()
            }
          }
          return (async () => {
            try {
              const snapshot = () => [
                container.firstElementChild?.tagName.toLowerCase(),
                container.textContent,
              ]
              const snapshots = [snapshot()]
              const update = compiled.update
              assert.equal(typeof update, 'function', `${probe.id}: update export`)
              for (const value of probe.updates) {
                update(value)
                await new Promise(resolve => queueMicrotask(resolve))
                snapshots.push(snapshot())
              }
              return snapshots
            } finally {
              dispose()
            }
          })()
        }
        return runtime.__fictRender({ slots: [], cursor: 0 }, () => entry())
      }
      if (probe.expectedError !== undefined) {
        assert.throws(invoke, error => error?.constructor?.name === probe.expectedError)
      } else {
        const value = await invoke()
        assert.deepEqual(probe.resolveAccessor ? value() : value, probe.expected)
      }
    } finally {
      runtime.__fictResetContext()
    }
  })
}
