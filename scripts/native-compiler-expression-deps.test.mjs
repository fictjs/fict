import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
)
const binding = require(nativePath)

// Behavioral port of 0.28.0 codegen-expression-deps.test.ts. The removed helper exposed
// dependency names; these probes verify that the complete Preview pipeline restores those
// dependencies in the emitted handler module where a missed dependency breaks at runtime.
function compile(id, code) {
  return binding.transformSync({
    code,
    filename: `/expression-deps/${id}.tsx`,
    moduleId: `/@id/expression-deps/${id}.tsx?client`,
    publicModuleId: `fict:module:expression-deps-${id}`,
    options: {
      strictGuarantee: false,
      preview: {
        resumable: true,
        autoExtractHandlers: false,
        autoExtractThreshold: 100,
      },
    },
  })
}

function artifactFor(result, context) {
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    context,
  )
  assert.equal(result.artifacts.length, 1, context)
  assert.equal(result.artifacts[0].kind, 'handlerModule', context)
  return result.artifacts[0].code
}

function restoredProps(code) {
  return Array.from(code.matchAll(/__scopeProps\["([^"]+)"\]/g), match => match[1]).sort()
}

test('optional member chains restore the base without inventing path captures', () => {
  const artifact = artifactFor(
    compile(
      'optional-chain',
      `export function App({ user }) {
        return <button onClick$={() => user?.profile?.name}>read</button>
      }`,
    ),
    'optional member chain',
  )

  assert.deepEqual(restoredProps(artifact), ['user'])
  assert.match(artifact, /user\(\)\?\.profile\?\.name/)
  assert.doesNotMatch(artifact, /__scopeProps\["(?:profile|name|user\.profile)/)
})

test('Preview restores dependencies from every supported expression family', () => {
  const result = compile(
    'expression-families',
    `import { $state } from 'fict'
     import { maybeCall, Ctor, tag, Base } from './deps'
     export function App({ callArg, awaited, ctorArg, spreadArg, rhs, tplArg, importPath }) {
       let lhs = $state(0)
       let counter = $state(0)
       return <button onClick$={async () => {
         maybeCall?.(callArg)
         await awaited
         new Ctor(ctorArg)
         ;[...spreadArg]
         lhs = rhs
         counter++
         tag\`\${tplArg}\`
         class Child extends Base {}
         return import(importPath)
       }}>run</button>
     }`,
  )
  const artifact = artifactFor(result, 'expression families')

  assert.deepEqual(restoredProps(artifact), [
    'awaited',
    'callArg',
    'ctorArg',
    'importPath',
    'rhs',
    'spreadArg',
    'tplArg',
  ])
  assert.match(artifact, /__fictUseLexicalScope\(scopeId, \["lhs", "counter"\]\)/)
  for (const dependency of ['maybeCall', 'Ctor', 'tag', 'Base']) {
    assert.match(result.code, new RegExp(`export \\{ ${dependency} as __fict_dep_\\d+ \\}`))
    assert.match(artifact, new RegExp(`__fict_dep_\\d+ as ${dependency}`))
  }
  for (const expression of [
    'maybeCall?.(callArg())',
    'await awaited()',
    'new Ctor(ctorArg())',
    '[...spreadArg()]',
    'rhs()',
    'counter()',
    'tag`${tplArg()}`',
    'class Child extends Base',
    'import(importPath())',
  ]) {
    assert.ok(artifact.includes(expression), expression)
  }
})

test('yield expressions restore their argument in generator handlers', () => {
  const artifact = artifactFor(
    compile(
      'yield',
      `export function App({ yieldArg }) {
        return <button onClick$={function* () { yield yieldArg }}>next</button>
      }`,
    ),
    'yield expression',
  )

  assert.deepEqual(restoredProps(artifact), ['yieldArg'])
  assert.match(artifact, /function\* \(\) \{\s*yield yieldArg\(\)/)
})

test('computed members restore both the object and key at base granularity', () => {
  const artifact = artifactFor(
    compile(
      'computed-member',
      `export function App({ obj, key }) {
        return <button onClick$={() => obj[key]}>read</button>
      }`,
    ),
    'computed member',
  )

  assert.deepEqual(restoredProps(artifact), ['key', 'obj'])
  assert.match(artifact, /obj\(\)\[key\(\)\]/)
  assert.doesNotMatch(artifact, /__scopeProps\["obj\.key"\]/)
})

test('block-bodied function closures include branch, phi-source, and return dependencies', () => {
  const artifact = artifactFor(
    compile(
      'block-closure',
      `export function App({ condition, inner, left, right, ret }) {
        const helper = flag => {
          const local = inner
          let merged
          if (flag) merged = left
          else merged = right
          return merged + local + ret
        }
        return <button onClick$={() => helper(condition)}>read</button>
      }`,
    ),
    'block-bodied function closure',
  )

  assert.deepEqual(restoredProps(artifact), ['condition', 'inner', 'left', 'ret', 'right'])
  assert.match(artifact, /const helper = \(flag\) =>/)
  assert.match(artifact, /if \(flag\) merged = left\(\)/)
  assert.match(artifact, /else merged = right\(\)/)
  assert.match(artifact, /return merged \+ local \+ ret\(\)/)
  assert.match(artifact, /helper\(condition\(\)\)/)
})
