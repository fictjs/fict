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
const manifest = JSON.parse(
  readFileSync(path.join(root, 'scripts/fixtures/compiler_r006_audit_behavior.json'), 'utf8'),
)
const capabilityManifest = JSON.parse(
  readFileSync(path.join(root, 'packages/compiler/compiler-capabilities.json'), 'utf8'),
)
const corpus = JSON.parse(
  readFileSync(
    path.join(root, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  ),
)
const fixturesById = new Map(corpus.fixtures.map(fixture => [fixture.id, fixture]))

const expectedIds = [
  'packages/compiler/test/codegen.test.ts:1286:transform',
  'packages/compiler/test/control-flow.test.ts:670:runTransform',
  'packages/compiler/test/control-flow.test.ts:1189:runTransform',
  'packages/compiler/test/control-flow.test.ts:1270:runTransformWithWarnings',
  'packages/compiler/test/default-options.test.ts:170:transform',
  'packages/compiler/test/sourcemap.test.ts:1325:compileWithSourcemap',
  'packages/compiler/test/sourcemap.test.ts:1951:compileWithSourcemap',
  'packages/compiler/test/spec-advanced.test.ts:115:transform',
  'packages/compiler/test/spec-advanced.test.ts:314:transform',
  'packages/compiler/test/spec-complete.test.ts:417:transform',
  'packages/compiler/test/spec-complete.test.ts:445:transform',
  'packages/compiler/test/spec-complete.test.ts:472:transform',
  'packages/compiler/test/spec-complete.test.ts:491:transform',
  'packages/compiler/test/spec-complete.test.ts:520:transform',
  'packages/compiler/test/spec-complete.test.ts:578:transform',
  'packages/compiler/test/spec-rules.test.ts:343:transform',
  'packages/compiler/test/spec-rules.test.ts:374:transform',
  'packages/compiler/test/spec-rules.test.ts:2033:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2052:transform',
  'packages/compiler/test/spec-rules.test.ts:2120:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2204:transform',
  'packages/compiler/test/spec-rules.test.ts:2219:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2302:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2385:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2405:transform',
  'packages/compiler/test/spec-rules.test.ts:2500:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:2519:transform',
  'packages/compiler/test/spec-rules.test.ts:2593:transform',
  'packages/compiler/test/spec-rules.test.ts:3548:transform',
]

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

async function flushRuntime() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function compileExact(fixture, options = fixture.options) {
  return binding.transformSync({
    code: fixture.source,
    filename: '/fixtures/legacy-r006-audit.tsx',
    language: 'tsx',
    options,
  })
}

function loadCommonJs(code) {
  const module = { exports: {} }
  const requireRuntime = request => {
    if (
      request === 'fict' ||
      request === 'fict/internal' ||
      request === '@fictjs/runtime/internal'
    ) {
      return runtime
    }
    throw new Error(`Unexpected R006 behavior-probe import ${JSON.stringify(request)}`)
  }
  new Function('require', 'module', 'exports', code)(requireRuntime, module, module.exports)
  return module.exports
}

const behaviorProbes = {
  'nested-conditional-prop-return': {
    adapt: source => `
      import { $state } from 'fict'
      ${source}
      let setMode
      function AuditApp() {
        let mode = $state(0)
        setMode = next => { mode = next }
        return <Component mode={mode} />
      }
      export function probe() { return <AuditApp /> }
      export function update() { setMode(2) }
    `,
    initial: { tag: 'div', text: '0' },
    updated: { tag: 'span', text: '2' },
  },
  'captured-derived-closure': {
    adapt: source =>
      `${source
        .replace('      function Factory() {', '      let setCount\n      function Factory() {')
        .replace(
          '        let count = $state(0)',
          '        let count = $state(0)\n        setCount = next => { count = next }',
        )}
      function AuditApp() {
        const view = Factory()
        return view()
      }
      export function probe() { return <AuditApp /> }
      export function update() { setCount(2) }
    `,
    initial: { tag: 'span', text: 'low', title: 'Small' },
    updated: { tag: 'span', text: 'high', title: 'Big' },
    preservesElement: true,
  },
}

test('accounts for the exact 29 lost-R006 audit fixtures and their claim boundaries', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(capabilityManifest.schemaVersion, 2)
  assert.equal(capabilityManifest.scope, 'certified-behavior-variant-options')
  assert.deepEqual(capabilityManifest.options.lazyConditional, {
    default: true,
    supported: [false, true],
  })
  assert.equal(manifest.sourceAudit.sha256, corpus.provenance.auditInputSha256)
  assert.equal(manifest.sourceAudit.release, corpus.provenance.babelAuditRelease)
  assert.equal(manifest.sourceAudit.revision, corpus.provenance.babelAuditRevision)
  assert.equal(manifest.sourceCorpus, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json')
  assert.deepEqual(
    manifest.cases.map(fixture => fixture.id),
    expectedIds,
  )
  assert.equal(new Set(expectedIds).size, 29)

  const counts = Object.groupBy(manifest.cases, fixture => fixture.disposition)
  assert.equal(counts['strict-reactivity-fail-closed']?.length, 27)
  assert.equal(counts['verified-emit-capability']?.length, 2)
  assert.deepEqual(manifest.summary, {
    fixtureCount: 29,
    strictReactivityFailClosed: 27,
    verifiedEmitCapability: 2,
  })
  assert.deepEqual(
    counts['verified-emit-capability']?.map(fixture => fixture.behaviorProbe).sort(),
    Object.keys(behaviorProbes).sort(),
  )

  for (const entry of manifest.cases) {
    const fixture = fixturesById.get(entry.id)
    assert.ok(fixture, entry.id)
    assert.ok(fixture.babelAudit.diagnosticCodes.includes('FICT-R006'), entry.id)
    assert.equal(fixture.origin.requestVariant, 'audit-baseline', entry.id)
  }
})

for (const entry of manifest.cases.filter(
  fixture => fixture.disposition === 'strict-reactivity-fail-closed',
)) {
  test(`fails closed for audited unsupported R006 shape: ${entry.id}`, () => {
    const fixture = fixturesById.get(entry.id)
    const current = compileExact(fixture)
    assert.ok(
      current.diagnostics.some(
        diagnostic => diagnostic.code === 'FICT-R006' && diagnostic.severity === 'warning',
      ),
      `${entry.id}: ${current.diagnostics.map(diagnostic => diagnostic.code).join(', ')}`,
    )
    assert.notEqual(current.code, '', entry.id)

    const strict = compileExact(fixture, { ...fixture.options, strictReactivity: true })
    assert.ok(
      strict.diagnostics.some(
        diagnostic => diagnostic.code === 'FICT-R006' && diagnostic.severity === 'error',
      ),
      `${entry.id}: ${strict.diagnostics.map(diagnostic => diagnostic.code).join(', ')}`,
    )
    assert.equal(strict.code, '', entry.id)
  })
}

for (const entry of manifest.cases.filter(
  fixture => fixture.disposition === 'verified-emit-capability',
)) {
  test(`mounts, mutates, and updates audited R006 suppression: ${entry.id}`, async () => {
    const fixture = fixturesById.get(entry.id)
    const exact = compileExact(fixture, { ...fixture.options, strictReactivity: true })
    assert.equal(
      exact.diagnostics.some(diagnostic => diagnostic.code === 'FICT-R006'),
      false,
      entry.id,
    )
    assert.notEqual(exact.code, '', entry.id)

    const probe = behaviorProbes[entry.behaviorProbe]
    assert.ok(probe, entry.id)
    const compiled = binding.transformSync({
      code: probe.adapt(fixture.source),
      filename: `/fixtures/${entry.behaviorProbe}.tsx`,
      language: 'tsx',
      moduleKind: 'commonjs',
      options: { ...fixture.options, strictReactivity: true },
    })
    assert.equal(
      compiled.diagnostics.some(diagnostic => diagnostic.code === 'FICT-R006'),
      false,
      entry.id,
    )
    assert.notEqual(compiled.code, '', entry.id)

    const module = loadCommonJs(compiled.code)
    const container = document.createElement('div')
    document.body.append(container)
    runtime.__fictResetContext()
    const dispose = runtime.render(() => module.probe(), container)
    try {
      await flushRuntime()
      const initialElement = container.firstElementChild
      assert.deepEqual(
        {
          tag: initialElement?.tagName.toLowerCase(),
          text: initialElement?.textContent,
          ...(probe.initial.title === undefined ? {} : { title: initialElement?.title }),
        },
        probe.initial,
      )

      module.update()
      await flushRuntime()
      const updatedElement = container.firstElementChild
      assert.deepEqual(
        {
          tag: updatedElement?.tagName.toLowerCase(),
          text: updatedElement?.textContent,
          ...(probe.updated.title === undefined ? {} : { title: updatedElement?.title }),
        },
        probe.updated,
      )
      if (probe.preservesElement) assert.equal(updatedElement, initialElement)
    } finally {
      dispose()
      runtime.__fictResetContext()
      container.remove()
    }
  })
}
