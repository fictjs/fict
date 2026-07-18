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

// Behavioral port of 0.28.0 vnode-props-order.test.ts. These cases execute the native
// CommonJS fallback instead of relying on object-literal text order.
const fixtures = [
  {
    name: 'later spreads override earlier explicit props',
    body: `const spread = { id: 'spread' }
           return <div id="before" {...spread} />`,
    expected: { id: 'spread' },
  },
  {
    name: 'later explicit props override earlier spreads',
    body: `const spread = { id: 'spread' }
           return <div {...spread} id="after" />`,
    expected: { id: 'after' },
  },
  {
    name: 'multiple spreads and explicit props retain authored precedence',
    body: `const first = { id: 'first', class: 'first' }
           const second = { id: 'second' }
           return <div id="start" {...first} class="explicit" {...second} />`,
    expected: { class: 'explicit', id: 'second' },
  },
  {
    name: 'explicit JSX children override spread children',
    body: `const spread = { children: 'spread' }
           return <div {...spread}>child</div>`,
    expected: { children: 'child' },
  },
  {
    name: 'use no memo functions preserve prop precedence',
    body: `'use no memo'
           const spread = { id: 'spread' }
           return <div id="before" {...spread} />`,
    expected: { id: 'spread' },
  },
]

function compileAndExecute(fixture) {
  const result = binding.transformSync({
    code: `export function Scenario() { ${fixture.body} }`,
    filename: `/vnode-props-order/${fixture.name.replaceAll(' ', '-')}.tsx`,
    moduleKind: 'commonjs',
    options: {
      dev: false,
      fineGrainedDom: false,
      optimize: true,
      strictGuarantee: false,
    },
  })
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    result.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
  )
  assert.notEqual(result.code, '')
  const vnode = executeCommonJs(result.code, { exportName: 'Scenario', arguments: [] })
  assert.equal(vnode.type, 'div')
  return vnode.props
}

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const props = compileAndExecute(fixture)
    for (const [key, value] of Object.entries(fixture.expected)) {
      assert.equal(props[key], value)
    }
  })
}
