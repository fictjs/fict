#!/usr/bin/env node

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const { transformSync } = require('../packages/compiler/node_modules/@babel/core')
const createFictPlugin = require('../packages/compiler/dist/index.cjs').default
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
const binding = require(path.join(root, 'target', 'release', 'fict_compiler_napi.node'))

let dom

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const exposed = [
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
  ]
  for (const name of exposed) {
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
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function importCompiledModule(code, name, backend) {
  const fixture = path.join(
    root,
    'packages',
    'fict',
    `.native-runtime-${backend}-${name}-${process.pid}-${Date.now()}.mjs`,
  )
  await writeFile(fixture, code, 'utf8')
  try {
    return await import(`${pathToFileURL(fixture).href}?v=${Date.now()}`)
  } finally {
    await unlink(fixture)
  }
}

async function compileAndImport(source, name, expectedCode, settings = {}) {
  const request = {
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
  }
  if (settings.options) {
    request.options = settings.options
  }
  const result = binding.transformSync(request)
  const diagnosticCodes = settings.diagnosticCodes ?? []
  if (diagnosticCodes.length === 0) {
    assert.deepEqual(
      result.diagnostics,
      [],
      result.diagnostics.map(item => item.message).join('\n'),
    )
  } else {
    assert.deepEqual(
      result.diagnostics.map(item => item.code),
      diagnosticCodes,
      result.diagnostics.map(item => item.message).join('\n'),
    )
  }
  if (expectedCode) {
    assert.match(result.code, expectedCode)
  }

  return importCompiledModule(result.code, name, 'rust')
}

function compileLegacySource(source, name, settings = {}) {
  const diagnostics = []
  const result = transformSync(source, {
    filename: `/fixtures/${name}.tsx`,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    },
    plugins: [
      [
        createFictPlugin,
        {
          dev: false,
          emitModuleMetadata: false,
          strictGuarantee: settings.strictGuarantee ?? true,
          onWarn: diagnostic => diagnostics.push(diagnostic),
        },
      ],
    ],
    generatorOpts: { compact: false },
  })
  assert.ok(result?.code, 'legacy compiler must produce code')
  return { code: result.code, diagnostics }
}

async function compileLegacyAndImport(source, name, settings = {}) {
  const result = compileLegacySource(source, name, settings)
  assert.deepEqual(
    result.diagnostics.map(diagnostic => diagnostic.code),
    settings.diagnosticCodes ?? [],
  )
  return importCompiledModule(result.code, name, 'legacy')
}

async function exerciseCoreParityModule(module) {
  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initialRows = new Map(
    [...container.querySelectorAll('li')].map(node => [node.dataset.id, node]),
  )
  const snapshot = {
    initial: {
      button: container.querySelector('[data-id="toggle"]')?.textContent,
      effectLog: [...module.effects],
      label: container.querySelector('[data-id="label"]')?.textContent,
      mathNamespace: container.querySelector('mi')?.namespaceURI,
      rowIds: [...initialRows.keys()],
      rowText: [...initialRows.values()].map(node => node.textContent),
      svgNamespace: container.querySelector('circle')?.namespaceURI,
      tableText: container.querySelector('td')?.textContent,
    },
  }

  container.querySelector('[data-id="toggle"]')?.click()
  module.update([
    { id: 3, label: 'C2' },
    { id: 1, label: 'A2' },
    { id: 4, label: 'D' },
  ])
  await flushRuntime()

  const updatedRows = [...container.querySelectorAll('li')]
  snapshot.updated = {
    button: container.querySelector('[data-id="toggle"]')?.textContent,
    effectLog: [...module.effects],
    keyedIdentity: [
      updatedRows[0] === initialRows.get('3'),
      updatedRows[1] === initialRows.get('1'),
    ],
    label: container.querySelector('[data-id="label"]')?.textContent,
    removedRowDisconnected: initialRows.get('2')?.isConnected === false,
    rowIds: updatedRows.map(node => node.dataset.id),
    rowText: updatedRows.map(node => node.textContent),
    tableText: container.querySelector('td')?.textContent,
  }

  dispose()
  snapshot.cleanedUp = container.childNodes.length === 0
  container.remove()
  return snapshot
}

test('legacy and Rust compilers preserve the same Core runtime behavior', async () => {
  const source = `
    import { $effect, $memo, $state, render } from 'fict'

    export const effects = []
    let replaceRows = () => {}

    function Label({ value, suffix = '!' }) {
      return <p data-id="label">{value}{suffix}</p>
    }

    function App() {
      let active = $state(false)
      let rows = $state([
        { id: 1, label: 'A' },
        { id: 2, label: 'B' },
        { id: 3, label: 'C' },
      ])
      const status = $memo(() => active ? 'on' : 'off')
      $effect(() => effects.push(status))
      replaceRows = next => {
        rows = next
      }

      return (
        <main>
          <button data-id="toggle" class={status} onClick={() => { active = !active }}>
            {status}
          </button>
          <Label value={status} />
          <ul>{rows.map(row => <li key={row.id} data-id={row.id}>{row.label}</li>)}</ul>
          <svg viewBox="0 0 10 10"><circle cx={active ? 2 : 1} cy="1" r="1" /></svg>
          <math><mi>{active ? 'y' : 'x'}</mi></math>
          <table><tbody><tr><td>{active ? '1' : '0'}</td></tr></tbody></table>
        </main>
      )
    }

    export function mount(container) {
      return render(() => <App />, container)
    }

    export function update(next) {
      replaceRows(next)
    }
  `
  const [legacy, rust] = await Promise.all([
    compileLegacyAndImport(source, 'core-parity', {
      strictGuarantee: false,
      diagnosticCodes: ['FICT-R002'],
    }),
    compileAndImport(source, 'core-parity', null, {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-R002'],
    }),
  ])

  const legacySnapshot = await exerciseCoreParityModule(legacy)
  const rustSnapshot = await exerciseCoreParityModule(rust)
  assert.deepEqual(rustSnapshot, legacySnapshot)
})

function legacyGuaranteeOutcome(source, name, strictGuarantee) {
  try {
    const result = compileLegacySource(source, name, { strictGuarantee })
    return {
      status: 'success',
      diagnostics: result.diagnostics.map(diagnostic => [diagnostic.code, 'warning']),
    }
  } catch (error) {
    const codes = [...new Set(String(error?.message ?? error).match(/FICT-[A-Z0-9-]+/g) ?? [])]
    assert.notDeepEqual(codes, [], `${name}: legacy error must expose a diagnostic code`)
    return { status: 'error', diagnostics: codes.map(code => [code, 'error']) }
  }
}

function rustGuaranteeOutcome(source, name, strictGuarantee) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
    options: { strictGuarantee },
  })
  return {
    status: result.code === '' ? 'error' : 'success',
    diagnostics: result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
  }
}

test('legacy and Rust compilers agree on the strict guarantee matrix', () => {
  const cases = [
    {
      name: 'guaranteed-state-handler',
      code: null,
      source: `
        import { $state } from 'fict'
        export function Counter() {
          let count = $state(0)
          const increment = () => { count++ }
          return <button onClick={increment}>{count}</button>
        }
      `,
    },
    {
      name: 'guaranteed-props-pattern',
      code: null,
      source: `
        export function Profile(props) {
          const { user: { name = 'Ada' } = {}, title = 'Engineer', ...rest } = props
          return <section data-role={rest.role}>{title}: {name}</section>
        }
      `,
    },
    {
      name: 'fallback-control-flow',
      code: 'FICT-R006',
      source: `
        import { $state } from 'fict'
        export function App() {
          const count = $state(0)
          if (count > 0 && maybe()) return <strong>high</strong>
          return <span>low</span>
        }
      `,
    },
    {
      name: 'fallback-callback-host',
      code: 'FICT-R005',
      source: `
        import { $state } from 'fict'
        function consume(fn) { return fn() }
        export function App() {
          const count = $state(0)
          consume(readCount)
          function readCount() { return count }
          return <span>{count}</span>
        }
      `,
    },
    {
      name: 'fallback-dynamic-property',
      code: 'FICT-H',
      source: `
        import { $state } from 'fict'
        export function App({ key = 'name' }) {
          const user = $state({ name: 'Ada' })
          return <span>{user[key]}</span>
        }
      `,
    },
    {
      name: 'fallback-component-spread',
      code: 'FICT-P005',
      source: `
        function Child(props) { return <span>{props.value}</span> }
        export function App(props) { return <Child {...props()} /> }
      `,
    },
    {
      name: 'fallback-nested-state-mutation',
      code: 'FICT-M',
      source: `
        import { $state } from 'fict'
        export function App() {
          const user = $state({ name: 'Ada' })
          user.name = 'Grace'
          return <span>{user.name}</span>
        }
      `,
    },
    {
      name: 'fallback-jsx-write',
      code: 'FICT-R007',
      source: `
        import { $state } from 'fict'
        export function App() {
          let count = $state(0)
          return <span>{count++}</span>
        }
      `,
    },
    {
      name: 'fallback-intrinsic-spread',
      code: 'FICT-J003',
      source: `
        export function App(props) { return <main {...props} /> }
      `,
    },
    {
      name: 'fallback-memo-side-effect',
      code: 'FICT-M003',
      source: `
        import { $memo } from 'fict'
        export const value = $memo(() => { fetch('/api'); return 1 })
      `,
    },
    {
      name: 'unsupported-nested-state',
      level: 'unsupported',
      rustCode: 'FICT-PLACEMENT-STATE-NESTED',
      legacyMessage: /cannot be declared inside nested functions/,
      source: `
        import { $state } from 'fict'
        export function App() {
          const read = () => {
            const count = $state(0)
            return count
          }
          return <span>{read()}</span>
        }
      `,
    },
    {
      name: 'unsupported-loop-effect',
      level: 'unsupported',
      rustCode: 'FICT-PLACEMENT-EFFECT-CONTROL',
      legacyMessage: /cannot be called inside loops or conditionals/,
      source: `
        import { $effect } from 'fict'
        export function App() {
          while (false) $effect(() => {})
          return <span />
        }
      `,
    },
    {
      name: 'unsupported-module-state',
      level: 'unsupported',
      rustCode: 'FICT-PLACEMENT-STATE-OWNER',
      legacyMessage: /must be declared inside a component or hook function body/,
      source: `
        import { $state } from 'fict'
        export const count = $state(0)
      `,
    },
  ]

  for (const fixture of cases) {
    if (fixture.level === 'unsupported') {
      for (const strictGuarantee of [false, true]) {
        assert.throws(
          () => compileLegacySource(fixture.source, fixture.name, { strictGuarantee }),
          fixture.legacyMessage,
          `${fixture.name}: legacy unsupported`,
        )
        assert.deepEqual(
          rustGuaranteeOutcome(fixture.source, fixture.name, strictGuarantee),
          { status: 'error', diagnostics: [[fixture.rustCode, 'error']] },
          `${fixture.name}: Rust unsupported`,
        )
      }
      continue
    }

    const expectedNonStrict = {
      status: 'success',
      diagnostics: fixture.code === null ? [] : [[fixture.code, 'warning']],
    }
    const expectedStrict =
      fixture.code === null
        ? expectedNonStrict
        : { status: 'error', diagnostics: [[fixture.code, 'error']] }

    const legacyNonStrict = legacyGuaranteeOutcome(fixture.source, fixture.name, false)
    const rustNonStrict = rustGuaranteeOutcome(fixture.source, fixture.name, false)
    assert.deepEqual(legacyNonStrict, expectedNonStrict, `${fixture.name}: legacy non-strict`)
    assert.deepEqual(rustNonStrict, expectedNonStrict, `${fixture.name}: Rust non-strict`)

    const legacyStrict = legacyGuaranteeOutcome(fixture.source, fixture.name, true)
    const rustStrict = rustGuaranteeOutcome(fixture.source, fixture.name, true)
    assert.deepEqual(legacyStrict, expectedStrict, `${fixture.name}: legacy strict`)
    assert.deepEqual(rustStrict, expectedStrict, `${fixture.name}: Rust strict`)
  }
})

async function compileAndRequire(source, name, expectedCode) {
  const result = binding.transformSync({
    code: source,
    filename: `/fixtures/${name}.tsx`,
    moduleId: `/fixtures/${name}.tsx`,
    moduleKind: 'commonjs',
  })
  assert.deepEqual(result.diagnostics, [], result.diagnostics.map(item => item.message).join('\n'))
  if (expectedCode) {
    assert.match(result.code, expectedCode)
  }

  const fixture = path.join(
    root,
    'packages',
    'fict',
    `.native-runtime-${name}-${process.pid}-${Date.now()}.cjs`,
  )
  await writeFile(fixture, result.code, 'utf8')
  try {
    const compiled = require(fixture)
    delete require.cache[require.resolve(fixture)]
    return compiled
  } finally {
    await unlink(fixture)
  }
}

test('Rust compiler emits executable CommonJS with live exports and collision-free helpers', async () => {
  const compiled = await compileAndRequire(
    `
      import { $state, render } from 'fict'
      import path from 'node:path'

      const __fict_cjs_require = 'user-require'
      let updateCount = () => {}
      export let renders = 0
      export const collision = __fict_cjs_require
      export const separator = path.sep

      function App() {
        const __fict_cjs_import = 'user-import'
        let count = $state(0)
        updateCount = () => count++
        renders++
        return <button data-id="commonjs">{__fict_cjs_require}:{__fict_cjs_import}:{count}</button>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update() {
        updateCount()
      }
    `,
    'commonjs-module',
    /const __fict_cjs_require_1 = require/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = compiled.mount(container)
  await flushRuntime()

  const button = container.querySelector('[data-id="commonjs"]')
  assert.equal(compiled.collision, 'user-require')
  assert.equal(compiled.separator, path.sep)
  assert.equal(compiled.renders, 1)
  assert.equal(button?.textContent, 'user-require:user-import:0')

  compiled.update()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="commonjs"]'), button)
  assert.equal(button?.textContent, 'user-require:user-import:1')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler preserves unresolved host places and temporary member update order', async () => {
  let hostReads = 0
  Object.defineProperty(globalThis, '__fictNativeHostSlot', {
    configurable: true,
    value: 1,
    writable: true,
  })
  Object.defineProperty(globalThis, '__fictNativeHostObject', {
    configurable: true,
    value: { fixed: 0 },
    writable: true,
  })
  Object.defineProperty(globalThis, '__fictNativeHostValue', {
    configurable: true,
    get() {
      hostReads += 1
      return 11
    },
  })
  Object.defineProperty(globalThis, '__fictNativeHostCall', {
    configurable: true,
    value: value => value + 1,
    writable: true,
  })

  try {
    const module = await compileAndImport(
      `
        export function mutate(key, value) {
          __fictNativeHostSlot = value
          __fictNativeHostSlot += 2
          __fictNativeHostSlot++
          __fictNativeHostObject.fixed = value
          __fictNativeHostObject[key] = value + 1

          const effects = []
          const made = { field: 9 }
          const make = () => {
            effects.push('make')
            return made
          }
          const previous = make().field--
          const read = __fictNativeHostObject.fixed
          const bare = __fictNativeHostValue
          const called = __fictNativeHostCall(bare)
          return {
            bare,
            called,
            effects,
            field: made.field,
            previous,
            read,
            slot: __fictNativeHostSlot,
          }
        }
      `,
      'host-places',
      /__fictNativeHostSlot \+= 2/,
    )

    assert.deepEqual(module.mutate('dynamic', 5), {
      bare: 11,
      called: 12,
      effects: ['make'],
      field: 8,
      previous: 9,
      read: 5,
      slot: 8,
    })
    assert.equal(hostReads, 1)
    assert.deepEqual(globalThis.__fictNativeHostObject, {
      dynamic: 6,
      fixed: 5,
    })
    assert.equal(globalThis.__fictNativeHostSlot, 8)
  } finally {
    delete globalThis.__fictNativeHostCall
    delete globalThis.__fictNativeHostObject
    delete globalThis.__fictNativeHostValue
    delete globalThis.__fictNativeHostSlot
  }
})

test('Rust compiler preserves method receivers and evaluates computed call references once', async () => {
  const module = await compileAndImport(
    `
      export function invoke(object, key, delta) {
        const effects = []
        const computedKey = () => {
          effects.push('key')
          return key
        }
        const make = () => {
          effects.push('make')
          return object
        }
        const staticResult = object.add(delta)
        const computedResult = object[computedKey()](delta)
        const temporaryResult = make().add(delta)
        const groupedResult = (object?.add)(delta)
        return { staticResult, computedResult, temporaryResult, groupedResult, effects }
      }

      export function invokeOptional(object, delta) {
        return object?.add(delta)
      }
    `,
    'method-call-references',
    /object\[computedKey\(\)\]\(delta\)/,
  )

  const object = {
    base: 5,
    add(delta) {
      return this.base + delta
    },
  }
  assert.deepEqual(module.invoke(object, 'add', 2), {
    staticResult: 7,
    computedResult: 7,
    temporaryResult: 7,
    groupedResult: 7,
    effects: ['key', 'make'],
  })
  assert.equal(module.invokeOptional(object, 3), 8)
  assert.equal(module.invokeOptional(null, 3), undefined)
})

test('Rust compiler preserves method tag receivers and evaluates tag references once', async () => {
  const module = await compileAndImport(
    `
      export function invoke(object, key, value) {
        const effects = []
        const computedKey = () => {
          effects.push('key')
          return key
        }
        const make = () => {
          effects.push('make')
          return object
        }
        const staticResult = object.tag\`static \${value}\`
        const computedResult = object[computedKey()]\`computed \${value}\`
        const temporaryResult = make().tag\`temporary \${value}\`
        return { staticResult, computedResult, temporaryResult, effects }
      }
    `,
    'method-tag-references',
    /object\[computedKey\(\)\]`computed/,
  )

  const object = {
    base: 5,
    tag(strings, value) {
      return `${this.base}:${strings.raw[0]}:${value}`
    },
  }
  assert.deepEqual(module.invoke(object, 'tag', 2), {
    staticResult: '5:static :2',
    computedResult: '5:computed :2',
    temporaryResult: '5:temporary :2',
    effects: ['key', 'make'],
  })
})

test('Rust compiler preserves assignment results and logical-assignment laziness', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export let evaluate = () => null

      function App() {
        let value = $state(0)
        evaluate = initial => {
          const effects = []
          value = initial
          const make = (label, next) => {
            effects.push(label)
            return next
          }
          const assigned = (value = make('assign', 2))
          const compound = (value += make('compound', 3))
          const skippedAnd = (value = 0, value &&= make('and', 9))
          const skippedOr = (value = 1, value ||= make('or', 9))
          const skippedNullish = (value = 'set', value ??= make('nullish', 9))
          const takenNullish = (value = null, value ??= make('taken', 7))
          return {
            assigned,
            compound,
            skippedAnd,
            skippedOr,
            skippedNullish,
            takenNullish,
            value,
            effects,
          }
        }
        return <output data-id="assignment-value">{value}</output>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'assignment-results',
    /value\(__fict_value\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.deepEqual(module.evaluate(1), {
    assigned: 2,
    compound: 5,
    skippedAnd: 0,
    skippedOr: 1,
    skippedNullish: 'set',
    takenNullish: 7,
    value: 7,
    effects: ['assign', 'compound', 'taken'],
  })
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="assignment-value"]')?.textContent, '7')

  dispose()
  container.remove()
})

test('Rust compiler preserves destructuring assignment order, results, and reactive writes', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      export let evaluate = () => null

      function App() {
        let first = $state(0)
        let second = $state(0)
        evaluate = source => {
          const effects = []
          let local = 0
          let rest = {}
          let fallbackObserved = -1
          const holder = { value: 0 }
          const key = () => {
            effects.push('key')
            return 'missing'
          }
          const fallback = () => {
            fallbackObserved = first
            effects.push('fallback')
            return fallbackObserved + 1
          }
          const result = ({
            first,
            [key()]: second = fallback(),
            nested: [local],
            ...rest
          } = source)
          const rhs = [9, undefined, 10, 12]
          const argument = ((value) => value)(
            [first, second = first, first, holder.value] = rhs
          )
          return {
            sameResult: result === source,
            sameArgument: argument === rhs,
            argument: [...argument],
            first,
            second,
            local,
            member: holder.value,
            fallbackObserved,
            rest,
            effects,
          }
        }
        return <output data-id="destructuring-value">{first}:{second}</output>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'destructuring-assignment-results',
    /set __fictValue/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const source = {
    first: 4,
    missing: undefined,
    nested: [7],
    extra: 11,
  }
  assert.deepEqual(module.evaluate(source), {
    sameResult: true,
    sameArgument: true,
    argument: [9, undefined, 10, 12],
    first: 10,
    second: 9,
    local: 7,
    member: 12,
    fallbackObserved: 4,
    rest: { extra: 11 },
    effects: ['key', 'fallback'],
  })
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="destructuring-value"]')?.textContent, '10:9')

  dispose()
  container.remove()
})

test('Rust compiler preserves class definition and instance initializer timing', async () => {
  const module = await compileAndImport(
    `
      export function evaluate() {
        const order = []
        const key = label => {
          order.push('key:' + label)
          return label
        }
        const base = () => {
          order.push('base')
          return class {}
        }
        const instanceValue = () => {
          order.push('instance')
          return order.length
        }
        const staticValue = () => {
          order.push('static')
          return order.length
        }

        class Example extends base() {
          [key('instance')] = instanceValue()
          static [key('static')] = staticValue()
          static { order.push('static-block') }
        }
        order.push('declaration-defined')
        const first = new Example()
        order.push('declaration-constructed')

        const Expression = class extends base() {
          value = instanceValue()
          static value = staticValue()
        }
        order.push('expression-defined')
        const second = new Expression()

        return {
          order,
          declarationInstance: first.instance,
          declarationStatic: Example.static,
          expressionInstance: second.value,
          expressionStatic: Expression.value,
        }
      }
    `,
    'class-initializer-timing',
    /class Example extends base\(\)/,
  )

  assert.deepEqual(module.evaluate(), {
    order: [
      'base',
      'key:instance',
      'key:static',
      'static',
      'static-block',
      'declaration-defined',
      'instance',
      'declaration-constructed',
      'base',
      'static',
      'expression-defined',
      'instance',
    ],
    declarationInstance: 7,
    declarationStatic: 4,
    expressionInstance: 12,
    expressionStatic: 10,
  })
})

test('Rust compiler output executes structured for-of and for-in loops', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      function App() {
        let total = 0
        for (const value of [1, 2, 3]) {
          total += value
        }
        for (const key in { a: 1, bb: 2 }) {
          total += key.length
        }
        return <output data-id="enumeration">{total}</output>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'enumeration-loops',
    /for \(const value of \[\s*1,\s*2,\s*3\s*\]\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="enumeration"]')?.textContent, '9')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves switch test order, deferred default, and fallthrough targets', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      function App() {
        const log = []
        const mark = value => {
          log.push(value)
          return value
        }
        let result = ''
        switch (mark('b')) {
          case mark('a'):
            result = 'a'
            break
          default:
            result = 'default'
            break
          case mark('b'):
            result += 'b'
          case mark('c'):
            result += 'c'
        }
        return <output data-id="switch-order">{log.join(',')}:{result}</output>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'switch-order',
    /switch \(mark\(["']b["']\)\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="switch-order"]')?.textContent, 'b,a,b:bc')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves catch binding and finally completion ordering', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      function App() {
        const audit = []
        const execute = mode => {
          try {
            audit.push('try:' + mode)
            if (mode === 'throw') throw { message: 'boom' }
            if (mode === 'return') return 'returned'
            return 'normal'
          } catch ({ message = 'fallback' }) {
            audit.push('catch:' + message)
            return 'caught:' + message
          } finally {
            audit.push('finally:' + mode)
            if (mode === 'override') return 'overridden'
          }
        }
        const results = ['normal', 'throw', 'return', 'override'].map(execute)
        return <output data-id="try-order">{audit.join(',')}|{results.join(',')}</output>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'try-order',
    /try \{/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(
    container.querySelector('[data-id="try-order"]')?.textContent,
    'try:normal,finally:normal,try:throw,catch:boom,finally:throw,try:return,finally:return,try:override,finally:override|normal,caught:boom,returned,overridden',
  )

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves keyed identity, reactive updates, and cleanup', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let replaceRows = () => {}

      function App() {
        let rows = $state([
          { id: 1, label: 'A' },
          { id: 2, label: 'B' },
          { id: 3, label: 'C' },
        ])
        replaceRows = next => {
          rows = next
        }
        return <ul>{rows.map(row => <li key={row.id} data-id={row.id}>{row.label}</li>)}</ul>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        replaceRows(next)
      }
    `,
    'keyed-list',
    /createKeyedList/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initial = new Map(
    [...container.querySelectorAll('li')].map(node => [node.dataset.id, node]),
  )
  assert.deepEqual([...initial.keys()], ['1', '2', '3'])
  assert.equal(container.textContent, 'ABC')
  assert.equal(container.getAttribute('data-fict-fine-grained'), '1')

  module.update([
    { id: 3, label: 'C2' },
    { id: 1, label: 'A2' },
    { id: 4, label: 'D' },
  ])
  await flushRuntime()

  const updated = [...container.querySelectorAll('li')]
  assert.deepEqual(
    updated.map(node => node.dataset.id),
    ['3', '1', '4'],
  )
  assert.equal(container.textContent, 'C2A2D')
  assert.equal(updated[0], initial.get('3'))
  assert.equal(updated[1], initial.get('1'))
  assert.equal(initial.get('2')?.isConnected, false)

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler keeps direct and optional-call component spreads lazy', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let replaceProps = () => {}

      function Child(props) {
        return <span data-value={props.value}>{props.value}:{props.fixed ?? 'none'}</span>
      }

      function App() {
        let props = $state({ value: 1 })
        replaceProps = value => {
          props = { value }
        }
        return (
          <section>
            <Child {...props} />
            <Child {...props?.()} fixed="yes" />
          </section>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(value) {
        replaceProps(value)
      }
    `,
    'reactive-component-spreads',
    /__fictProp\(\(\) => props\?\.\(\)\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initial = [...container.querySelectorAll('span')]
  assert.deepEqual(
    initial.map(node => node.textContent),
    ['1:none', '1:yes'],
  )

  module.update(2)
  await flushRuntime()

  const updated = [...container.querySelectorAll('span')]
  assert.deepEqual(updated, initial)
  assert.deepEqual(
    updated.map(node => node.textContent),
    ['2:none', '2:yes'],
  )

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps destructured component props reactive', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setValue = () => {}

      function Child({ value: renamed, label }) {
        return <p data-label={label}>{label}:{renamed}</p>
      }

      function App() {
        let value = $state('A')
        setValue = next => {
          value = next
        }
        return <Child value={value} label={value.toLowerCase()} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setValue(next)
      }
    `,
    'destructured-props',
    /const renamed = prop\(\(\) => __fictProps\.value\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'a:A')
  assert.equal(child.dataset.label, 'a')

  module.update('B')
  await flushRuntime()

  const updated = container.querySelector('p')
  assert.equal(updated, child)
  assert.equal(updated?.textContent, 'b:B')
  assert.equal(updated?.dataset.label, 'b')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output snapshots destructured prop defaults at invocation', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setValue = () => {}
      export const defaultCalls = []

      function fallback(value) {
        defaultCalls.push(value)
        return value.toLowerCase()
      }

      function Child({ value: renamed, label = fallback(renamed) }) {
        return <p>{String(label)}:{renamed}</p>
      }

      function App() {
        let value = $state('A')
        setValue = next => {
          value = next
        }
        return <section><Child value={value} /><Child value={value} label={null} /></section>
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setValue(next)
      }
    `,
    'defaulted-props',
    /__fictProps\.label === void 0/,
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-R002'],
    },
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const initial = [...container.querySelectorAll('p')]
  assert.deepEqual(
    initial.map(node => node.textContent),
    ['a:A', 'null:A'],
  )
  assert.deepEqual(module.defaultCalls, ['A'])

  module.update('B')
  await flushRuntime()

  const updated = [...container.querySelectorAll('p')]
  assert.deepEqual(
    updated.map(node => node.textContent),
    ['a:B', 'null:B'],
  )
  assert.equal(updated[0], initial[0])
  assert.equal(updated[1], initial[1])
  assert.deepEqual(module.defaultCalls, ['A'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output materializes JSX prop defaults lazily and reactively', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setLabel = () => {}
      export const defaultCalls = []

      function Child({ label, fallback = (defaultCalls.push(label), <span data-id="fallback">{label}</span>) } = {}) {
        return <div data-id="host">{fallback}</div>
      }

      function App() {
        let label = $state('A')
        setLabel = next => {
          label = next
        }
        return (
          <>
            <Child label={label} />
            <Child label={label} fallback={<em data-id="custom">Custom</em>} />
            <Child label={label} fallback={null} />
          </>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setLabel(next)
      }
    `,
    'jsx-prop-default',
    /__fictProps\.fallback === void 0.*defaultCalls\.push\(label\(\)\)/s,
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-R002'],
    },
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const hosts = [...container.querySelectorAll('[data-id="host"]')]
  assert.equal(hosts.length, 3)
  const fallback = container.querySelector('[data-id="fallback"]')
  const custom = container.querySelector('[data-id="custom"]')
  assert.ok(fallback)
  assert.ok(custom)
  assert.equal(fallback.textContent, 'A')
  assert.equal(custom.textContent, 'Custom')
  assert.equal(hosts[2].textContent, '')
  assert.deepEqual(module.defaultCalls, ['A'])

  module.update('B')
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="fallback"]'), fallback)
  assert.equal(container.querySelector('[data-id="custom"]'), custom)
  assert.equal(fallback.textContent, 'B')
  assert.equal(custom.textContent, 'Custom')
  assert.equal(hosts[2].textContent, '')
  assert.deepEqual(module.defaultCalls, ['A'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output applies whole-object parameter defaults with intrinsic undefined', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      export const calls = []

      function fallbackProps() {
        calls.push('default')
        return { name: 'Anon' }
      }

      function Greeting({ name } = fallbackProps()) {
        const undefined = 'shadowed'
        return <p>{undefined}:{name}</p>
      }

      export function mount(container) {
        return render(() => Greeting(undefined), container)
      }
    `,
    'parameter-default-props',
    /__fictPropsParam === void 0/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.textContent, 'shadowed:Anon')
  assert.deepEqual(module.calls, ['default'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps nested destructured props reactive and checked', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setUser = () => {}

      function Child({ user: { name, profile: { age = 18 } } }) {
        return <p>{name}:{age}</p>
      }

      function App() {
        let user = $state({ name: 'Ada', profile: {} })
        setUser = next => {
          user = next
        }
        return <Child user={user} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function mountNull(container) {
        return render(() => <Child user={null} />, container)
      }

      export function update(next) {
        setUser(next)
      }
    `,
    'nested-props',
    /const name = prop\(\(\) => __fictProps\.user\.name\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'Ada:18')

  module.update({ name: 'Bea', profile: { age: 20 } })
  await flushRuntime()
  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'Bea:20')

  module.update({ name: 'Cy', profile: {} })
  await flushRuntime()
  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'Cy:18')

  dispose()
  container.remove()

  const invalidContainer = document.createElement('div')
  assert.throws(
    () => module.mountNull(invalidContainer),
    /Cannot destructure prop "user" because it is nullish/,
  )
})

test('Rust compiler output reads literal destructuring keys and excludes them from rest props', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      function Child({
        "foo-bar": value,
        0: first,
        nested: { "aria-label": label = 'fallback' },
        ...rest
      }) {
        return <span data-id="literal">{value}:{first}:{label}:{String('extra' in rest)}:{String('foo-bar' in rest)}</span>
      }

      export function mount(container) {
        return render(() => ({
          type: Child,
          props: {
            "foo-bar": "dash",
            0: "zero",
            nested: {},
            extra: "kept",
          },
        }), container)
      }
    `,
    'literal-prop-keys',
    /__fictProps\["foo-bar"\].*__fictProps\["0"\]/s,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(
    container.querySelector('[data-id="literal"]')?.textContent,
    'dash:zero:fallback:true:false',
  )

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves executable props-pattern fallbacks in non-strict mode', async () => {
  const module = await compileAndImport(
    `
      import { render } from 'fict'

      function Child({ list: [first, ...rest], user: { ...userRest } }) {
        return <p>{first}:{rest.join(',')}:{userRest.name}:{userRest.age}</p>
      }

      export function mount(container) {
        return render(() => ({
          type: Child,
          props: {
            list: ['A', 'B', 'C'],
            user: { name: 'Ada', age: 37 },
          },
        }), container)
      }
    `,
    'props-pattern-fallback',
    /function Child\(\{ list: \[first, \.\.\.rest\], user: \{ \.\.\.userRest \} \}\)/,
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-P002', 'FICT-P004'],
    },
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.textContent, 'A:B,C:Ada:37')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves reactive top-level rest props', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setData = () => {}

      function Child({ id, ...rest }) {
        return <p>{String('id' in rest)}:{id}:{rest.title}:{rest.count}</p>
      }

      function App() {
        let data = $state({ title: 'A', count: 1 })
        setData = next => {
          data = next
        }
        return <Child id="row" title={data.title} count={data.count} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setData(next)
      }
    `,
    'rest-props',
    /const rest = __fictPropsRest\(__fictProps, \["id"\]\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'false:row:A:1')

  module.update({ title: 'B', count: 2 })
  await flushRuntime()

  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'false:row:B:2')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps reassigned destructured props as mutable snapshots', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setReactive = () => {}

      function Child({ reactive, local, count = 1, user: { name }, alias }) {
        const assigned = (local = 'changed')
        const before = count++
        name = name.toUpperCase()
        ;({ alias } = { alias: 'reassigned' })
        return <p>{reactive}:{local}:{count}:{assigned}:{before}:{name}:{alias}</p>
      }

      function App() {
        let reactive = $state('A')
        setReactive = next => {
          reactive = next
        }
        return <Child reactive={reactive} local="initial" user={{ name: 'ann' }} alias="initial" />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(next) {
        setReactive(next)
      }
    `,
    'mutated-props',
    /var local = __fictProps\.local/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const child = container.querySelector('p')
  assert.ok(child)
  assert.equal(child.textContent, 'A:changed:2:changed:1:ANN:reassigned')

  module.update('B')
  await flushRuntime()

  assert.equal(container.querySelector('p'), child)
  assert.equal(child.textContent, 'B:changed:2:changed:1:ANN:reassigned')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output snapshots callable props without deactivating value props', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      function Child({ count, onIncrement }) {
        const invoke = onIncrement
        return <div><span>{count}</span><button onClick={() => invoke.call(null)}>+</button></div>
      }

      function App() {
        let count = $state(0)
        return <Child count={count} onIncrement={() => count++} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'callable-props',
    /const onIncrement = __fictProps\.onIncrement/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const value = container.querySelector('span')
  const button = container.querySelector('button')
  assert.ok(value)
  assert.ok(button)
  assert.equal(value.textContent, '0')

  button.click()
  await flushRuntime()

  assert.equal(container.querySelector('span'), value)
  assert.equal(container.querySelector('button'), button)
  assert.equal(value.textContent, '1')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps mixed displayed and called function props reactive', async () => {
  const module = await compileAndImport(
    `
      import { $state, render } from 'fict'

      let setLabel = () => {}
      export const calls = []

      function makeLabel(value) {
        const label = () => calls.push(value)
        label.toString = () => value
        return label
      }

      function Child({ label }) {
        return <div><span>{String(label)}</span><button onClick={() => label()}>call</button></div>
      }

      function App() {
        let model = $state({ label: makeLabel('first') })
        setLabel = value => {
          model = { label: makeLabel(value) }
        }
        return <Child label={model.label} />
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update(value) {
        setLabel(value)
      }
    `,
    'mixed-callable-props',
    /const label = prop\(\(\) => __fictProps\.label\)/,
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const label = container.querySelector('span')
  const button = container.querySelector('button')
  assert.ok(label)
  assert.ok(button)
  assert.equal(label.textContent, 'first')

  button.click()
  await flushRuntime()
  assert.deepEqual(module.calls, ['first'])

  module.update('second')
  await flushRuntime()
  assert.equal(container.querySelector('span'), label)
  assert.equal(label.textContent, 'second')

  button.click()
  await flushRuntime()
  assert.deepEqual(module.calls, ['first', 'second'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output preserves store, resource, and selector runtime reactivity', async () => {
  const module = await compileAndImport(
    `
      import { $store, createSelector, render } from 'fict'
      import { resource } from 'fict/plus'

      export const fetches = []
      let updateModel = () => {}

      const greeting = resource(async (_context, name) => {
        fetches.push(name)
        return 'hello ' + name
      })

      function App() {
        const model = $store({ selected: 'a', label: 'A' })
        const selected = createSelector(() => model.selected)
        const result = greeting.read('world')
        updateModel = () => {
          model.label = 'B'
          model.selected = 'b'
        }
        return (
          <main>
            <p data-id="store">{model.label}</p>
            <i data-id="a" class={selected('a') ? 'selected' : ''}>A</i>
            <i data-id="b" class={selected('b') ? 'selected' : ''}>B</i>
            <b data-id="resource">{result.loading ? 'loading' : result.data}</b>
          </main>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }

      export function update() {
        updateModel()
      }
    `,
    'runtime-reactive-primitives',
    /const model = \$store\(.*const selected = createSelector\(\(\) => model\.selected\)/s,
    {
      options: { strictGuarantee: false },
      diagnosticCodes: ['FICT-R002', 'FICT-R005'],
    },
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  const store = container.querySelector('[data-id="store"]')
  const first = container.querySelector('[data-id="a"]')
  const second = container.querySelector('[data-id="b"]')
  const resourceNode = container.querySelector('[data-id="resource"]')
  assert.ok(store)
  assert.ok(first)
  assert.ok(second)
  assert.ok(resourceNode)
  assert.equal(store.textContent, 'A')
  assert.equal(first.className, 'selected')
  assert.equal(second.className, '')
  assert.equal(resourceNode.textContent, 'hello world')
  assert.deepEqual(module.fetches, ['world'])

  module.update()
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="store"]'), store)
  assert.equal(container.querySelector('[data-id="a"]'), first)
  assert.equal(container.querySelector('[data-id="b"]'), second)
  assert.equal(container.querySelector('[data-id="resource"]'), resourceNode)
  assert.equal(store.textContent, 'B')
  assert.equal(first.className, '')
  assert.equal(second.className, 'selected')
  assert.equal(resourceNode.textContent, 'hello world')
  assert.deepEqual(module.fetches, ['world'])

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler output keeps ErrorBoundary children lazy and reset keys reactive', async () => {
  const module = await compileAndImport(
    `
      import { $state, ErrorBoundary, render } from 'fict'

      export const errors = []

      function Risky({ fail }) {
        if (fail) {
          throw new Error('render boom')
        }
        return (
          <div>
            <p data-id="safe">safe</p>
            <button data-id="explode" onClick={() => { throw new Error('event boom') }}>
              explode
            </button>
          </div>
        )
      }

      function App() {
        let fail = $state(true)
        let resetKey = $state(0)
        return (
          <ErrorBoundary
            fallback={error => (
              <button
                data-id="retry"
                onClick={() => {
                  fail = false
                  resetKey++
                }}
              >
                retry:{error.message}
              </button>
            )}
            onError={error => errors.push(error.message)}
            resetKeys={() => resetKey}
          >
            <Risky fail={fail} />
          </ErrorBoundary>
        )
      }

      export function mount(container) {
        return render(() => <App />, container)
      }
    `,
    'error-boundary',
    /resetKeys: __fictReactive\(\(\) => resetKey\(\)\)/,
    { diagnosticCodes: ['FICT-X003', 'FICT-X003'] },
  )

  const container = document.createElement('div')
  document.body.append(container)
  const dispose = module.mount(container)
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="retry"]')?.textContent, 'retry:render boom')
  assert.deepEqual(module.errors, ['render boom'])

  container.querySelector('[data-id="retry"]')?.click()
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="safe"]')?.textContent, 'safe')
  assert.ok(container.querySelector('[data-id="explode"]'))

  container.querySelector('[data-id="explode"]')?.click()
  await flushRuntime()

  assert.equal(container.querySelector('[data-id="retry"]')?.textContent, 'retry:event boom')
  assert.deepEqual(module.errors, ['render boom', 'event boom'])

  container.querySelector('[data-id="retry"]')?.click()
  await flushRuntime()
  assert.equal(container.querySelector('[data-id="safe"]')?.textContent, 'safe')

  dispose()
  assert.equal(container.childNodes.length, 0)
  container.remove()
})

test('Rust compiler rejects call-based reactive control flow at the native boundary', () => {
  const source = `
    import { $state } from 'fict'
    export function App() {
      const count = $state(0)
      if (count > 10 && maybe?.()) return <Big />
      return <Small />
    }
  `
  const request = {
    code: source,
    filename: '/fixtures/reactive-control-flow.tsx',
    moduleId: '/fixtures/reactive-control-flow.tsx',
  }

  const strict = binding.transformSync(request)
  assert.equal(strict.code, '')
  assert.deepEqual(
    strict.diagnostics.map(diagnostic => [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.guaranteeClass,
    ]),
    [['FICT-R006', 'error', 'fallback']],
  )
  assert.ok(strict.diagnostics[0].primarySpan)
  assert.match(strict.diagnostics[0].message, /count/)

  const fallback = binding.transformSync({
    ...request,
    options: { strictGuarantee: false },
  })
  assert.notEqual(fallback.code, '')
  assert.deepEqual(
    fallback.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['FICT-R006', 'warning']],
  )

  const safe = binding.transformSync({
    ...request,
    code: source.replace('count > 10 && maybe?.()', 'count > 10'),
  })
  assert.notEqual(safe.code, '')
  assert.ok(safe.diagnostics.every(diagnostic => diagnostic.code !== 'FICT-R006'))
})

test('Rust compiler rejects reactive writes in JSX children at the native boundary', () => {
  const source = `
    import { $state } from 'fict'
    export function App() {
      let count = $state(0)
      let local = 0
      return <main>{count++}{count += 1}<button onClick={() => count++}>{local++}</button></main>
    }
  `
  const request = {
    code: source,
    filename: '/fixtures/reactive-jsx-write.tsx',
    moduleId: '/fixtures/reactive-jsx-write.tsx',
  }

  const strict = binding.transformSync(request)
  assert.equal(strict.code, '')
  assert.deepEqual(
    strict.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [
      ['FICT-R007', 'error'],
      ['FICT-R007', 'error'],
    ],
  )
  assert.ok(strict.diagnostics.every(diagnostic => diagnostic.primarySpan))

  const fallback = binding.transformSync({
    ...request,
    options: { strictGuarantee: false },
  })
  assert.notEqual(fallback.code, '')
  assert.deepEqual(
    fallback.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [
      ['FICT-R007', 'warning'],
      ['FICT-R007', 'warning'],
    ],
  )
})

test('Rust compiler rejects intrinsic JSX spreads at the native boundary', () => {
  const source = `
    function Widget(props) {
      return <span>{props.title}</span>
    }
    export function App(props) {
      return <><div {...props} {...props} /><Widget {...props} /></>
    }
  `
  const request = {
    code: source,
    filename: '/fixtures/native-jsx-spread.tsx',
    moduleId: '/fixtures/native-jsx-spread.tsx',
  }

  const strict = binding.transformSync(request)
  assert.equal(strict.code, '')
  assert.deepEqual(
    strict.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['FICT-J003', 'error']],
  )

  const fallback = binding.transformSync({
    ...request,
    options: { strictGuarantee: false },
  })
  assert.notEqual(fallback.code, '')
  assert.deepEqual(
    fallback.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['FICT-J003', 'warning']],
  )
})

test('Rust compiler reports inline non-event function props at the native boundary', () => {
  const source = `
    function Button(_props) {
      return null
    }
    export function Panel({ label, stable }) {
      return <><Button renderLabel={() => label} /><Button renderLabel={stable} /><button onClick={() => label} /></>
    }
  `
  const request = {
    code: source,
    filename: '/fixtures/inline-function-props.tsx',
    moduleId: '/fixtures/inline-function-props.tsx',
  }

  const advisory = binding.transformSync(request)
  assert.notEqual(advisory.code, '')
  assert.deepEqual(
    advisory.diagnostics.map(diagnostic => [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.guaranteeClass,
    ]),
    [['FICT-X003', 'warning', 'advisory']],
  )

  const escalated = binding.transformSync({
    ...request,
    options: { warningLevels: { 'FICT-X003': 'error' } },
  })
  assert.equal(escalated.code, '')
  assert.deepEqual(
    escalated.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['FICT-X003', 'error']],
  )
})

test('Rust compiler rejects side-effecting memos at the native boundary', () => {
  const source = `
    import { $memo } from 'fict'
    export const value = $memo(() => {
      fetch('/api')
      return 1
    })
  `
  const request = {
    code: source,
    filename: '/fixtures/memo-side-effect.ts',
    moduleId: '/fixtures/memo-side-effect.ts',
  }

  const strict = binding.transformSync(request)
  assert.equal(strict.code, '')
  assert.deepEqual(
    strict.diagnostics.map(diagnostic => [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.guaranteeClass,
    ]),
    [['FICT-M003', 'error', 'fallback']],
  )
  assert.ok(strict.diagnostics[0].primarySpan)

  const fallback = binding.transformSync({
    ...request,
    options: { strictGuarantee: false },
  })
  assert.notEqual(fallback.code, '')
  assert.deepEqual(
    fallback.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['FICT-M003', 'warning']],
  )

  const pure = binding.transformSync({
    ...request,
    code: "import { $memo } from 'fict'; export const value = $memo(() => Math.max(1, 2));",
  })
  assert.notEqual(pure.code, '')
  assert.ok(pure.diagnostics.every(diagnostic => diagnostic.code !== 'FICT-M003'))
})
