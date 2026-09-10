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

// Behavioral port of 0.28.0 codegen-reactive-accessors.test.ts. The old suite inspected a
// private dependency collector; these probes execute native CommonJS output and verify the
// observable eager-versus-lazy boundaries that the collector existed to preserve.
function compileAndExecute(id, code, options = {}) {
  const result = binding.transformSync({
    code,
    filename: `/reactive-accessors/${id}.ts`,
    language: 'ts',
    moduleKind: 'commonjs',
    options: { strictGuarantee: false, ...options, dev: false },
  })
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    result.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
  )
  assert.notEqual(result.code, '')
  return executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] })
}

const namedAssignmentProfiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
  { optimize: false, optimizeLevel: 'full' },
].flatMap(options => [false, true].map(strictGuarantee => ({ ...options, strictGuarantee })))

for (const [target, initial, assign] of [
  ['assignment', 'null', expression => `value = ${expression}`],
  ['logical-or', 'null', expression => `value ||= ${expression}`],
  ['logical-and', 'true', expression => `value &&= ${expression}`],
  ['nullish', 'null', expression => `value ??= ${expression}`],
  ['array-default', 'null', expression => `[value = ${expression}] = []`],
  ['object-default', 'null', expression => `({ source: value = ${expression} } = {})`],
  ['shorthand-default', 'null', expression => `({ value = ${expression} } = {})`],
]) {
  test(`reactive ${target} preserves anonymous function and class names`, () => {
    for (const expression of [
      'function () {}',
      'function* () {}',
      'async function () {}',
      'async function* () {}',
      '() => 1',
      'async () => 1',
      'class { static observed = this.name }',
      'class { static name = "custom"; static observed = this.name }',
      'function Authored() {}',
      'class Authored { static observed = this.name }',
      '(0, function () {})',
      '(true ? function () {} : function () {})',
    ]) {
      const code = `import { $state } from 'fict';
        export function Scenario() {
          let value = $state(${initial});
          (${assign(expression)});
          return [value.name, value.observed];
        }`
      const authored = code
        .replace("import { $state } from 'fict';", 'const $state = value => value;')
        .replace('export function', 'exports.Scenario = function')
      const expected = executeCommonJs(authored, { exportName: 'Scenario', arguments: [] })
      for (const options of namedAssignmentProfiles) {
        assert.deepEqual(
          compileAndExecute(`named-${target}`, code, options),
          expected,
          `${expression}/${JSON.stringify(options)}`,
        )
      }
    }
  })
}

test('reactive inferred names preserve outer references and special property names', () => {
  const code = `import { $state } from 'fict';
    export function Scenario() {
      let value = $state(null);
      const fn = (value = function () { return value });
      value = 123;
      let __proto__ = $state(null);
      __proto__ = function () {};
      const direct = __proto__.name;
      ({ __proto__ = class {} } = Object.create(null));
      return [fn.name, fn(), direct, __proto__.name];
    }`
  for (const options of namedAssignmentProfiles) {
    assert.deepEqual(
      compileAndExecute('named-assignment-scope', code, options),
      ['value', 123, '__proto__', '__proto__'],
      JSON.stringify(options),
    )
  }
})

test('object and array function entries remain lazy while eager entries run at creation', () => {
  const actual = compileAndExecute(
    'container-boundaries',
    `import { $state } from 'fict'
     export function Scenario() {
       let count = $state(1)
       let source = 1
       const log = []
       const mark = (label, result) => { log.push(label); return result }
       const computedKey = () => mark('computed-key', 'computed')
       const spread = () => mark('spread', { spread: source })
       const object = {
         [computedKey()]: mark('computed-value', source),
         method() { log.push('method-body'); return count },
         get current() { log.push('getter-body'); return count },
         set current(value) { log.push('setter-body'); count = value },
         arrow: () => { log.push('arrow-body'); return count },
         fn: function () { log.push('fn-body'); return count },
         eager: mark('eager-value', source),
         ...spread(),
         called: (() => mark('object-iife', source))(),
       }
       const array = [
         () => { log.push('array-arrow-body'); return count },
         function () { log.push('array-fn-body'); return count },
         mark('array-eager', source),
         (() => mark('array-iife', source))(),
       ]
       const reactiveIife = {
         data: (() => mark('reactive-iife:' + source, count))(),
       }
       const values = []
       values.push(reactiveIife.data)
       const creation = log.slice()
       source = 2
       count = 2
       values.push(
         object.method(), object.current, object.arrow(), object.fn(),
         object.eager, object.spread, object.called, object.computed,
         array[0](), array[1](), array[2], array[3],
         reactiveIife.data,
       )
       object.current = 3
       return { creation, values, after: log, count }
     }`,
  )

  assert.deepEqual(actual, {
    after: [
      'computed-key',
      'computed-value',
      'eager-value',
      'spread',
      'object-iife',
      'array-eager',
      'array-iife',
      'reactive-iife:1',
      'method-body',
      'getter-body',
      'arrow-body',
      'fn-body',
      'array-arrow-body',
      'array-fn-body',
      'reactive-iife:2',
      'setter-body',
    ],
    count: 3,
    creation: [
      'computed-key',
      'computed-value',
      'eager-value',
      'spread',
      'object-iife',
      'array-eager',
      'array-iife',
      'reactive-iife:1',
    ],
    values: [1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 1, 1, 2],
  })
})

test('IIFEs do not pull returned function bodies across the lazy boundary', () => {
  const actual = compileAndExecute(
    'returned-function-boundary',
    `import { $state } from 'fict'
     export function Scenario() {
       let count = $state(1)
       const returned = (() => () => count)()
       const identities = []
       identities.push(returned)
       count = 2
       return { same: identities[0] === returned, value: returned() }
     }`,
  )

  assert.deepEqual(actual, { same: true, value: 2 })
})

test('class definitions track eager dependencies but exclude method and instance bodies', () => {
  const actual = compileAndExecute(
    'class-definition-boundaries',
    `import { $state } from 'fict'
     export function Scenario() {
       let key = $state('first')
       let staticValue = $state(1)
       let lazyValue = $state(10)
       const log = []
       const mark = (label, result) => { log.push(label); return result }
       class Base {}
       const Class = class extends mark('superclass', Base) {
         [mark('method-key', key)]() { log.push('method-body'); return lazyValue }
         field = (log.push('instance-field'), lazyValue)
         static staticValue = (log.push('static-initializer'), staticValue)
         static { log.push('static-block'); this.blockValue = staticValue }
       }
       log.push('initial-static:' + Class.staticValue)
       log.push('initial-block:' + Class.blockValue)
       const classIdentities = []
       classIdentities.push(Class)
       lazyValue = 20
       log.push('same-after-lazy:' + (classIdentities[0] === Class))
       const lazyInstance = new Class()
       log.push('lazy-field:' + lazyInstance.field)
       log.push('lazy-method:' + lazyInstance.first())
       key = 'second'
       staticValue = 2
       log.push('changed-after-eager:' + (classIdentities[0] !== Class))
       log.push('updated-static:' + Class.staticValue)
       log.push('updated-block:' + Class.blockValue)
       const updatedInstance = new Class()
       log.push('updated-field:' + updatedInstance.field)
       log.push('updated-method:' + updatedInstance.second())
       return log
     }`,
  )

  const definitionLog = ['superclass', 'method-key', 'static-initializer', 'static-block']
  assert.deepEqual(actual, [
    ...definitionLog,
    'initial-static:1',
    'initial-block:1',
    'same-after-lazy:true',
    'instance-field',
    'lazy-field:20',
    'method-body',
    'lazy-method:20',
    ...definitionLog,
    'changed-after-eager:true',
    'updated-static:2',
    'updated-block:2',
    'instance-field',
    'updated-field:20',
    'method-body',
    'updated-method:20',
  ])
})
