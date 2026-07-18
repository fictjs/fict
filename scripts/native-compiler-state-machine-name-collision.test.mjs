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

// Behavioral port of 0.28.0 state-machine-name-collision.test.ts. The Rust backend preserves
// reducible JavaScript loops instead of synthesizing Babel's __state switch, so these probes cover
// the same authored bindings plus the generated names that now surround reactive control flow.
function compileAndExecute(id, code, arguments_ = []) {
  const result = binding.transformSync({
    code,
    filename: `/state-machine-name-collision/${id}.ts`,
    language: 'ts',
    moduleKind: 'commonjs',
    options: { strictGuarantee: true, dev: false, optimize: true },
  })
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    result.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
  )
  assert.notEqual(result.code, '')
  return {
    code: result.code,
    value: executeCommonJs(result.code, { exportName: 'Scenario', arguments: arguments_ }),
  }
}

test('legacy state-machine collision scenarios stay structured and preserve authored bindings', () => {
  const cases = [
    [
      'local',
      `import { $state } from 'fict'
       export function Scenario() {
         let __state = 'local'
         let i = $state(0)
         do { i++; if (i === 3) continue } while (i < 5)
         return __state + ':' + i
       }`,
      [],
      'local:5',
    ],
    [
      'parameter',
      `import { $state } from 'fict'
       export function Scenario(__state) {
         let i = $state(0)
         do { i++; if (i === 3) continue } while (i < 5)
         return __state + ':' + i
       }`,
      ['parameter'],
      'parameter:5',
    ],
    [
      'nested',
      `import { $state } from 'fict'
       export function Scenario() {
         function readNested() { let __state = 'nested'; return __state }
         let i = $state(0)
         do { i++; if (i === 3) continue } while (i < 5)
         return readNested() + ':' + i
       }`,
      [],
      'nested:5',
    ],
  ]

  for (const [id, source, arguments_, expected] of cases) {
    const result = compileAndExecute(`legacy-${id}`, source, arguments_)
    assert.equal(result.value, expected, id)
    assert.match(result.code, /do \{/)
    assert.doesNotMatch(result.code, /switch \(__state/)
  }
})

test('current context helper allocation avoids authored parameter collisions', () => {
  const result = compileAndExecute(
    'context-helper',
    `import { $state } from 'fict'
     export function Scenario(__fictCtx) {
       let count = $state(__fictCtx)
       return count
     }`,
    [11],
  )

  assert.equal(result.value, 11)
  assert.match(result.code, /const __fictCtx_1 =/)
})

test('logical reactive updates do not capture user locals or parameters', () => {
  const result = compileAndExecute(
    'logical-updates',
    `import { $state } from 'fict'
     export function Scenario(__fict_previous) {
       let falsy = $state(0)
       falsy ||= __fict_previous
       let truthy = $state(1)
       truthy &&= __fict_previous + 1
       const __fict_previous_1 = 2
       let missing = $state(null)
       missing ??= __fict_previous + __fict_previous_1
       let present = $state(3)
       present ??= 999
       let local = $state(0)
       let localResult
       {
         const __fict_previous = 5
         local ||= __fict_previous
         localResult = local
       }
       return [falsy, truthy, missing, present, localResult]
     }`,
    [7],
  )

  assert.deepEqual(result.value, [7, 8, 9, 3, 5])
  assert.match(result.code, /__fict_previous_1\) => __fict_previous_1 \|\|/)
  assert.match(result.code, /__fict_previous_1\) => __fict_previous_1 &&/)
  assert.match(result.code, /__fict_previous_1_\) => __fict_previous_1_ \?\?/)
})
