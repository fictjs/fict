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
    options: { ...options, strictGuarantee: false, dev: false },
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
