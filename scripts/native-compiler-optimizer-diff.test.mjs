import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeCommonJs } from './lib/compiler-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
)
const binding = require(nativePath)

// Behavioral port of 0.28.0 optimizer-diff.test.ts. Every profile runs through the native
// request boundary and the same isolated runtime so equality covers emitted behavior, not text.
const profiles = [
  ['disabled-safe', { optimize: false, optimizeLevel: 'safe' }],
  ['enabled-safe', { optimize: true, optimizeLevel: 'safe' }],
  ['enabled-full', { optimize: true, optimizeLevel: 'full' }],
  ['disabled-full', { optimize: false, optimizeLevel: 'full' }],
]

const cases = [
  {
    id: 'const-fold',
    expected: 10,
    source: `
      import { $state } from 'fict'
      export function Scenario() {
        let count = $state(2)
        const __a = 1 + 2
        const __b = __a + 3
        const doubled = count * 2
        return __b + doubled
      }
    `,
  },
  {
    id: 'stable-member',
    expected: 1,
    source: `
      import { $state } from 'fict'
      export function Scenario() {
        let count = $state(1)
        const __a = Symbol.iterator
        const __b = Symbol.iterator
        return __a === __b ? count : 0
      }
    `,
  },
  {
    id: 'cse-math',
    expected: Math.PI + 2,
    source: `
      import { $state } from 'fict'
      export function Scenario() {
        let count = $state(1)
        const __a = Math.PI
        const __b = Math.PI
        const __c = __b + 1
        return __c + count
      }
    `,
  },
  {
    id: 'inline-const',
    expected: 11,
    source: `
      import { $state } from 'fict'
      export function Scenario() {
        let count = $state(2)
        const __tmp = 4
        const __res = __tmp + 5
        return __res + count
      }
    `,
  },
  {
    id: 'getter-barrier',
    expected: [1, 2, 2],
    source: `
      export function Scenario() {
        let calls = 0
        const object = { get value() { return ++calls } }
        const first = object.value
        const second = object.value
        return [first, second, calls]
      }
    `,
  },
  {
    id: 'signed-zero',
    expected: [true, true, { $type: '-infinity' }],
    source: `
      export function Scenario() {
        const direct = -0
        const product = 0 * -1
        return [Object.is(direct, -0), Object.is(product, -0), 1 / direct]
      }
    `,
  },
]

function compile(fixture, profile, options) {
  const result = binding.transformSync({
    code: fixture.source,
    filename: `/optimizer-diff/${fixture.id}-${profile}.ts`,
    language: 'ts',
    moduleKind: 'commonjs',
    options: { strictGuarantee: false, ...options, dev: false },
  })
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    `${fixture.id}/${profile}: ${result.diagnostics.map(diagnostic => diagnostic.message).join('\n')}`,
  )
  assert.notEqual(result.code, '', `${fixture.id}/${profile}`)
  return result
}

test('optimization on/off and safe/full profiles preserve observable semantics', () => {
  let observedDifferentCode = false
  for (const fixture of cases) {
    const outcomes = []
    const outputs = []
    for (const [profile, options] of profiles) {
      const result = compile(fixture, profile, options)
      outputs.push(result.code)
      outcomes.push(executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }))
    }

    assert.deepEqual(outcomes[0], fixture.expected, `${fixture.id} expected result`)
    for (const [index, outcome] of outcomes.entries()) {
      assert.deepEqual(outcome, outcomes[0], `${fixture.id}/${profiles[index][0]}`)
    }
    observedDifferentCode ||= new Set(outputs).size > 1
  }
  assert.equal(observedDifferentCode, true, 'matrix must exercise distinct optimizer output')
})

const reviewProfiles = profiles.flatMap(([profile, options]) =>
  [false, true].map(strictGuarantee => [
    `${profile}/strict-${strictGuarantee}`,
    { ...options, strictGuarantee },
  ]),
)

const selectedExpressions = [
  ['logical-and', value => `true && (${value})`],
  ['logical-or', value => `false || (${value})`],
  ['nullish', value => `null ?? (${value})`],
  ['conditional-true', value => `true ? (${value}) : null`],
  ['conditional-false', value => `false ? null : (${value})`],
]

test('pure scopes preserve exceptions from primitive coercion and BigInt arithmetic', () => {
  const expressions = [
    ['+1n', 'TypeError'],
    ['1n + 1', 'TypeError'],
    ['1n / 0n', 'RangeError'],
    ['1n % 0n', 'RangeError'],
    ['1n ** -1n', 'RangeError'],
    ['1n >>> 0n', 'TypeError'],
    ['+(true ? 1n : 2n)', 'TypeError'],
    ['`${1n / 0n}`', 'RangeError'],
    ['({ [1n + 1]: 0 })', 'TypeError'],
    ['+Symbol.iterator', 'TypeError'],
    ['Symbol.iterator + ""', 'TypeError'],
    ['`${Symbol.iterator}`', 'TypeError'],
    ['BigInt("\\u00851")', 'SyntaxError'],
    ['BigInt("1\\u0085")', 'SyntaxError'],
    ['BigInt("\\u0085")', 'SyntaxError'],
  ]
  const fixture = {
    id: 'pure-primitive-exceptions',
    source: `export function Scenario() {
      'use pure'
      const outcomes = []
      ${expressions
        .map(
          ([expression]) => `
        try { const unused = ${expression}; outcomes.push('no exception') }
        catch (error) { outcomes.push(error.name) }
      `,
        )
        .join('\n')}
      return outcomes
    }`,
  }
  const expected = expressions.map(([, error]) => error)
  assert.deepEqual(
    executeCommonJs(fixture.source.replace('export function', 'exports.Scenario = function'), {
      exportName: 'Scenario',
      arguments: [],
    }),
    expected,
  )
  for (const [profile, options] of reviewProfiles) {
    const result = compile(fixture, profile, options)
    assert.deepEqual(
      executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }),
      expected,
      profile,
    )
  }
})

test('pure scopes preserve standard builtin call failures', () => {
  const expressions = [
    ['parseInt("1", 2n)', 'TypeError'],
    ['parseInt(1n, 2n)', 'TypeError'],
    ['Number.parseInt("1", 2n)', 'TypeError'],
    ['Math.imul(1n, 2n)', 'TypeError'],
    ['Math.acosh(1n)', 'TypeError'],
    ['Math.atan2(1n, 2)', 'TypeError'],
    ['Math.clz32(1n)', 'TypeError'],
    ['Math.fround(1n)', 'TypeError'],
    ['Math.log1p(1n)', 'TypeError'],
    ['Math.sinh(1n)', 'TypeError'],
    ['isFinite(1n)', 'TypeError'],
    ['isNaN(1n)', 'TypeError'],
    ['Array(1.5)', 'RangeError'],
    ['Map()', 'TypeError'],
    ['Promise()', 'TypeError'],
    ['Object.create(1)', 'TypeError'],
    ['Reflect.get(1, "value")', 'TypeError'],
    ['JSON.parse("invalid")', 'SyntaxError'],
    ['JSON.stringify(1n)', 'TypeError'],
    ['String.fromCodePoint(-1)', 'RangeError'],
    ['Symbol.keyFor(1)', 'TypeError'],
    ['BigInt.asIntN(-1, 1n)', 'RangeError'],
    ['decodeURIComponent("%")', 'URIError'],
    ['encodeURI("\\ud800")', 'URIError'],
    ['Atomics.load(0, 0)', 'TypeError'],
    ['undefined()', 'TypeError'],
  ]
  const fixture = {
    id: 'pure-builtin-exceptions',
    source: `export function Scenario() {
      'use pure'
      const outcomes = []
      ${expressions
        .map(
          ([expression]) => `
        try { const unused = ${expression}; outcomes.push('no exception') }
        catch (error) { outcomes.push(error.name) }
      `,
        )
        .join('\n')}
      return outcomes
    }`,
  }
  const expected = expressions.map(([, error]) => error)
  assert.deepEqual(
    executeCommonJs(fixture.source.replace('export function', 'exports.Scenario = function'), {
      exportName: 'Scenario',
      arguments: [],
    }),
    expected,
  )
  for (const [profile, options] of reviewProfiles) {
    const result = compile(fixture, profile, options)
    assert.deepEqual(
      executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }),
      expected,
      profile,
    )
  }
})

for (const expression of ['Object()', 'Array()', 'RegExp("x")', 'Symbol("x")']) {
  test(`pure scopes preserve builtin allocation identity: ${expression}`, () => {
    const fixture = {
      id: 'pure-builtin-identity',
      source: `export function Scenario() {
        'use pure'
        const first = ${expression}
        const second = ${expression}
        return first === second
      }`,
    }
    for (const [profile, options] of reviewProfiles) {
      const result = compile(fixture, profile, options)
      assert.equal(
        executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }),
        false,
        profile,
      )
    }
  })
}

for (const [id, body] of [
  ['tdz-alias', 'const unused = later; const later = 1'],
  ['tdz-call', 'const unused = later(); const later = () => 1'],
  ['tdz-member', 'const unused = later.value; const later = { value: 1 }'],
  ['tdz-array', 'const unused = [later]; const later = 1'],
  ['tdz-object', 'const unused = { value: later }; const later = 1'],
  ['tdz-typeof', 'const unused = typeof later; const later = 1'],
  ['tdz-void', 'const unused = void later; const later = 1'],
  ['missing-global', 'const unused = __fict_missing_optimizer_binding__'],
  [
    'constructor-this',
    `
    class Base {}
    class Derived extends Base {
      constructor() { 'use pure'; const unused = this; super() }
    }
    new Derived()
  `,
  ],
  [
    'closure-before-initialization',
    `
    function read() { 'use pure'; const unused = later }
    read()
    const later = 1
  `,
  ],
  [
    'switch-entry',
    `
    switch (1) {
      case 0: const earlier = 1; break
      case 1: const unused = earlier
    }
  `,
  ],
]) {
  test(`pure scopes preserve uninitialized reads: ${id}`, () => {
    const fixture = {
      id,
      source: `export function Scenario() {
        'use pure'
        try { ${body}; return 'no exception' }
        catch (error) { return error.name }
      }`,
    }
    for (const [profile, options] of reviewProfiles) {
      const result = compile(fixture, profile, options)
      assert.equal(
        executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }),
        'ReferenceError',
        profile,
      )
    }
  })
}

for (const [selection, select] of selectedExpressions) {
  test(`constant ${selection} selection preserves value semantics`, () => {
    const fixture = {
      id: `selected-value-${selection}`,
      source: `
        export function Scenario() {
          let reads = 0
          const object = {
            get method() { reads++; return function() { return this === undefined } },
            value: 1,
          }
          const called = (${select('object.method')})()
          const optionalCalled = (${select('object?.method')})?.()
          const tagged = (${select('object.method')})\`tag\`
          const deleted = delete (${select('object.value')})
          let missing
          try { missing = typeof (${select('__fict_missing_optimizer_reference__')}) }
          catch (error) { missing = error.name }
          const fn = ${select('function() {}')}
          const arrow = ${select('() => 0')}
          const klass = ${select('class {}')}
          let assigned
          assigned = ${select('function() {}')}
          return [called, optionalCalled, tagged, deleted, object.value, missing,
                  fn.name, arrow.name, klass.name, assigned.name, reads]
        }
      `,
    }
    const expected = [true, true, true, true, 1, 'ReferenceError', '', '', '', '', 3]
    assert.deepEqual(
      executeCommonJs(fixture.source.replace('export function', 'exports.Scenario = function'), {
        exportName: 'Scenario',
        arguments: [],
      }),
      expected,
      `${selection}: authored JavaScript`,
    )
    for (const [profile, options] of reviewProfiles) {
      const result = compile(fixture, profile, options)
      assert.deepEqual(
        executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] }),
        expected,
        `${selection}/${profile}`,
      )
    }
  })

  test(`constant ${selection} selection retains indirect eval`, () => {
    const fixture = {
      id: `selected-eval-${selection}`,
      source: `export function Scenario() {
        const __fict_optimizer_local__ = 1
        return (${select('eval')})('typeof __fict_optimizer_local__')
      }`,
    }
    for (const [profile, options] of reviewProfiles) {
      const result = compile(fixture, profile, options)
      const exports = {}
      new Function('exports', result.code)(exports)
      assert.equal(exports.Scenario(), 'undefined', `${selection}/${profile}`)
    }
  })
}
