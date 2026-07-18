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

// Behavioral port of 0.28.0 codegen-auto-extract.test.ts. These probes exercise the complete
// native Preview pass and emitted artifact boundary instead of a removed TypeScript helper.
function compile(id, code, preview = {}) {
  return binding.transformSync({
    code,
    filename: `/auto-extract/${id}.tsx`,
    moduleId: `/@id/auto-extract/${id}.tsx?client`,
    publicModuleId: `fict:module:auto-extract-${id}`,
    options: {
      strictGuarantee: false,
      preview: {
        resumable: true,
        autoExtractHandlers: true,
        autoExtractThreshold: 100,
        ...preview,
      },
    },
  })
}

function assertExtracted(result, context) {
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    context,
  )
  assert.equal(result.artifacts.length, 1, context)
  assert.equal(result.artifacts[0].kind, 'handlerModule', context)
  assert.match(result.code, /fict:compiler-artifact:handler-0/, context)
  assert.match(result.artifacts[0].code, /export default/, context)
}

function assertEager(result, context) {
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    context,
  )
  assert.deepEqual(result.artifacts, [], context)
  assert.doesNotMatch(result.code, /fict:compiler-artifact:/, context)
}

test('Preview honors the auto-extraction opt-out', () => {
  const result = compile(
    'disabled',
    `export function App() { return <button onClick={() => save()}>save</button> }`,
    { autoExtractHandlers: false, autoExtractThreshold: 1 },
  )
  assertEager(result, 'disabled auto extraction')
})

test('Preview extracts only stable bare handler bindings', () => {
  for (const [kind, declaration] of [
    ['function', `function handle() {}`],
    ['const', `const handle = () => {}`],
    ['class', `class handle {}`],
  ]) {
    assertExtracted(
      compile(
        `stable-${kind}`,
        `${declaration}; export function App() { return <button onClick={handle}>go</button> }`,
      ),
      `stable ${kind} binding`,
    )
  }

  assertEager(
    compile(
      'module-let',
      `let handle = () => {}; export function App() { return <button onClick={handle}>go</button> }`,
    ),
    'module let binding',
  )
  assertEager(
    compile(
      'unresolved-bare',
      `export function App() { return <button onClick={handle}>go</button> }`,
    ),
    'unresolved bare binding',
  )
})

test('Preview rejects mutated function-local handler identifiers', () => {
  assertExtracted(
    compile(
      'stable-local',
      `export function App() { const handle = () => {}; return <button onClick={handle}>go</button> }`,
    ),
    'stable local const',
  )
  assertEager(
    compile(
      'mutated-local',
      `export function App() { let handle = () => {}; handle = () => save(); return <button onClick={handle}>go</button> }`,
      { autoExtractThreshold: 1 },
    ),
    'mutated local binding',
  )
})

test('Preview extracts external, asynchronous, and threshold-complex handlers', () => {
  for (const [id, handler, preview] of [
    ['external-call', `() => save()`, {}],
    ['async-work', `async () => await load()`, {}],
    ['threshold', `() => 1 + 2`, { autoExtractThreshold: 4 }],
    ['block-function', `function () { save() }`, {}],
  ]) {
    assertExtracted(
      compile(
        id,
        `export function App() { return <button onClick={${handler}}>go</button> }`,
        preview,
      ),
      id,
    )
  }
})

test('Preview keeps simple handlers below the threshold eager', () => {
  assertEager(
    compile(
      'simple-below-threshold',
      `export function App() { return <button onClick={() => 1}>go</button> }`,
      { autoExtractThreshold: 4 },
    ),
    'simple handler',
  )
})

test('automatic extraction stays eager when a selected handler cannot be restored', () => {
  const result = compile(
    'nonserializable-capture',
    `export function App() { const local = { value: 1 }; return <button onClick={() => local.value + save()}>go</button> }`,
  )
  assertEager(result, 'non-serializable local capture')
})
