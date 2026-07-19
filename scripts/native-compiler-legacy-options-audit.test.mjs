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
  readFileSync(path.join(root, 'scripts/fixtures/compiler_legacy_option_behavior.json'), 'utf8'),
)
const corpus = JSON.parse(
  readFileSync(
    path.join(root, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  ),
)
const fixturesById = new Map(corpus.fixtures.map(fixture => [fixture.id, fixture]))

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

function diagnosticSignature(diagnostics) {
  return diagnostics.map(({ code, guaranteeClass, severity }) => ({
    code,
    severity,
    guaranteeClass,
  }))
}

function compileExact(fixture) {
  return binding.transformSync({
    code: fixture.source,
    filename: '/fixtures/legacy-option-audit.tsx',
    language: 'tsx',
    options: fixture.options,
  })
}

function compileBehavior(fixture, source, name) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/legacy-option-${name}.tsx`,
    language: 'tsx',
    moduleKind: 'commonjs',
    options: fixture.options,
  })
  assert.equal(
    result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
    false,
    result.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'),
  )
  assert.notEqual(result.code, '', name)
  return result
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
    throw new Error(`Unexpected legacy-option behavior import ${JSON.stringify(request)}`)
  }
  new Function('require', 'module', 'exports', code)(requireRuntime, module, module.exports)
  return module.exports
}

function normalizeSource(source) {
  return source.replace(/\s+/g, ' ').trim()
}

function normalizeOptions(options) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(options).sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
}

test('accounts for all 38 option-bearing callsites as 37 normalized executable inputs', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.sourceAudit.sha256, corpus.provenance.auditInputSha256)
  assert.equal(manifest.sourceAudit.release, corpus.provenance.babelAuditRelease)
  assert.equal(manifest.sourceAudit.revision, corpus.provenance.babelAuditRevision)
  assert.equal(manifest.sourceCorpus, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json')
  assert.equal(manifest.cases.length, 37)

  const allAuditIds = manifest.cases.flatMap(entry => [entry.id, ...(entry.auditAliases ?? [])])
  assert.equal(allAuditIds.length, 38)
  assert.equal(new Set(allAuditIds).size, 38)
  assert.equal(manifest.summary.auditCallsites, 38)
  assert.equal(manifest.summary.normalizedInputs, 37)

  const optionFamilyCounts = Object.fromEntries(
    Object.entries(Object.groupBy(manifest.cases, entry => entry.optionFamily)).map(
      ([family, entries]) => [family, entries.length],
    ),
  )
  assert.deepEqual(optionFamilyCounts, manifest.summary.optionFamilies)
  const executionLevelCounts = Object.fromEntries(
    Object.entries(Object.groupBy(manifest.cases, entry => entry.execution.kind)).map(
      ([kind, entries]) => [kind, entries.length],
    ),
  )
  assert.deepEqual(executionLevelCounts, manifest.summary.executionLevels)

  for (const entry of manifest.cases) {
    const canonical = fixturesById.get(entry.id)
    assert.ok(canonical, entry.id)
    for (const aliasId of entry.auditAliases ?? []) {
      const alias = fixturesById.get(aliasId)
      assert.ok(alias, aliasId)
      assert.equal(normalizeSource(alias.source), normalizeSource(canonical.source), aliasId)
      assert.equal(normalizeOptions(alias.options), normalizeOptions(canonical.options), aliasId)
    }
  }
})

test('compiles every exact option-bearing audit callsite and checks its live diagnostic contract', () => {
  for (const entry of manifest.cases) {
    for (const id of [entry.id, ...(entry.auditAliases ?? [])]) {
      const fixture = fixturesById.get(id)
      const result = compileExact(fixture)
      assert.deepEqual(diagnosticSignature(result.diagnostics), fixture.expected.diagnostics, id)
      assert.equal(result.code === '', fixture.expected.status === 'error', id)
    }
  }
})

async function executePureFunction(fixture, execution) {
  const result = compileBehavior(
    fixture,
    `${fixture.source}\nexport { ${execution.exportName} as probe }`,
    `pure-${fixture.origin.line}`,
  )
  const module = loadCommonJs(result.code)
  assert.equal(typeof module.probe, 'function', fixture.id)

  if (execution.behaviorProbe === 'preserved-side-effect') {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'sideEffect')
    let calls = 0
    Object.defineProperty(globalThis, 'sideEffect', {
      configurable: true,
      value: () => {
        calls += 1
        return false
      },
      writable: true,
    })
    try {
      assert.equal(module.probe(), 1)
      assert.equal(calls, 1)
    } finally {
      if (previous) Object.defineProperty(globalThis, 'sideEffect', previous)
      else delete globalThis.sideEffect
    }
    return
  }

  for (const invocation of execution.calls) {
    assert.deepEqual(module.probe(...invocation.args), invocation.expected, fixture.id)
  }
}

function executeDiagnosticContract(fixture, execution) {
  const result = compileExact(fixture)
  assert.ok(
    result.diagnostics.some(diagnostic => diagnostic.code === execution.diagnosticCode),
    fixture.id,
  )
  if (execution.diagnosticCode === 'FICT-R006') {
    assert.ok(
      result.diagnostics.some(
        diagnostic => diagnostic.code === 'FICT-R006' && diagnostic.severity === 'warning',
      ),
      fixture.id,
    )
    assert.notEqual(result.code, '', fixture.id)
    assert.doesNotMatch(result.code, /createConditional/)
  } else {
    assert.equal(result.code, '', fixture.id)
  }
}

async function executeRetainedDerivedMemo(fixture) {
  const source = `${fixture.source
    .replace('      function Component() {', '      let setCount\n      function Component() {')
    .replace(
      '        let count = $state(0)',
      '        let count = $state(0)\n        setCount = next => { count = next }',
    )}
    export function probe() { return Component() }
    export function update(next) { setCount(next) }
  `
  const result = compileBehavior(fixture, source, 'retained-derived-memo')
  assert.match(result.code, /const doubled = [^\n]*__fictUseMemo/)
  const module = loadCommonJs(result.code)
  const container = document.createElement('div')
  document.body.append(container)
  runtime.__fictResetContext()
  const dispose = runtime.render(
    () => runtime.__fictRender({ slots: [], cursor: 0 }, () => module.probe()),
    container,
  )
  try {
    await flushRuntime()
    const element = container.firstElementChild
    assert.equal(element?.textContent, '0')
    module.update(2)
    await flushRuntime()
    assert.equal(container.firstElementChild, element)
    assert.equal(element?.textContent, '4')
  } finally {
    dispose()
    runtime.__fictResetContext()
    container.remove()
  }
}

async function executeUncachedReads(fixture) {
  const source = `${fixture.source
    .replace('      function Component() {', '      let setCount\n      function Component() {')
    .replace(
      '        let count = $state(0)',
      '        let count = $state(0)\n        setCount = next => { count = next }',
    )}
    export function probe() { return Component() }
    export function update(next) { setCount(next) }
  `
  const result = compileBehavior(fixture, source, 'uncached-repeated-reads')
  assert.doesNotMatch(result.code, /__cached_count/)
  const module = loadCommonJs(result.code)
  runtime.__fictResetContext()
  try {
    const click = runtime.__fictRender({ slots: [], cursor: 0 }, () => module.probe())
    assert.equal(click(), 0)
    module.update(2)
    assert.equal(click(), 6)
  } finally {
    runtime.__fictResetContext()
  }
}

async function executeDevStateInitializer(fixture) {
  const result = compileBehavior(fixture, fixture.source, 'dev-state-initializer')
  assert.equal(result.code.match(/devToolsSource/g)?.length, 1)
  const module = loadCommonJs(result.code)
  const container = document.createElement('div')
  document.body.append(container)
  runtime.__fictResetContext()
  const dispose = runtime.render(
    () => runtime.__fictRender({ slots: [], cursor: 0 }, () => module.App()),
    container,
  )
  try {
    await flushRuntime()
    assert.equal(container.firstElementChild?.tagName.toLowerCase(), 'button')
    assert.equal(container.firstElementChild?.textContent, '1')
  } finally {
    dispose()
    runtime.__fictResetContext()
    container.remove()
  }
}

async function executeRetainedObservation(fixture) {
  const result = compileBehavior(
    fixture,
    `${fixture.source}\nexport function probe() { return Component() }`,
    'retained-derived-observation',
  )
  assert.match(result.code, /const doubled = [^\n]*__fictUseMemo/)
  assert.match(result.code, /const squared = [^\n]*__fictUseMemo/)
  const module = loadCommonJs(result.code)
  const logs = []
  const originalLog = console.log
  console.log = (...values) => logs.push(values)
  runtime.__fictResetContext()
  try {
    assert.equal(
      runtime.__fictRender({ slots: [], cursor: 0 }, () => module.probe()),
      null,
    )
    await flushRuntime()
    assert.deepEqual(logs, [[0, 0]])
  } finally {
    runtime.__fictResetContext()
    console.log = originalLog
  }
}

for (const entry of manifest.cases) {
  test(`executes legacy option input: ${entry.id}`, async () => {
    const fixture = fixturesById.get(entry.id)
    switch (entry.execution.kind) {
      case 'pure-function':
        await executePureFunction(fixture, entry.execution)
        break
      case 'diagnostic-contract':
        executeDiagnosticContract(fixture, entry.execution)
        break
      case 'dom-reactivity':
        await executeRetainedDerivedMemo(fixture)
        break
      case 'reactive-function':
        await executeUncachedReads(fixture)
        break
      case 'dom-runtime':
        await executeDevStateInitializer(fixture)
        break
      case 'runtime-observation':
        await executeRetainedObservation(fixture)
        break
      default:
        assert.fail(`Unhandled execution level ${entry.execution.kind}`)
    }
  })
}
