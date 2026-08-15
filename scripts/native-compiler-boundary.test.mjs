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

const requestEntrypoints = [
  ['transformSync', binding.transformSync],
  ['scanSync', binding.scanSync],
  ['analyzeSync', binding.analyzeSync],
]
const asyncRequestEntrypoints = [
  ['transform', binding.transform],
  ['scan', binding.scan],
  ['analyze', binding.analyze],
]

function cyclicRequest() {
  const request = {
    code: 'export const value = 1',
    filename: 'cyclic-request.js',
  }
  request.self = request
  return request
}

function deeplyNestedRequest() {
  let nested = {}
  for (let depth = 0; depth < 140; depth += 1) nested = { nested }
  return {
    code: 'export const value = 1',
    filename: 'deep-request.js',
    nested,
  }
}

function assertBoundaryRequestError(result, entrypoint, pattern) {
  assert.equal(result.diagnostics[0]?.code, 'FICT-REQUEST', entrypoint)
  assert.match(result.diagnostics[0]?.message ?? '', pattern, entrypoint)
  assert.equal(result.internalError, undefined, entrypoint)
}

test('sync request entrypoints reject cyclic and deeply nested JS graphs without an ICE', () => {
  for (const [entrypoint, invoke] of requestEntrypoints) {
    assertBoundaryRequestError(invoke(cyclicRequest()), entrypoint, /cyclic object graph/)
    assertBoundaryRequestError(invoke(deeplyNestedRequest()), entrypoint, /nesting depth 128/)
  }
})

test('worker-pool request entrypoints reject cyclic and deeply nested JS graphs without an ICE', async () => {
  for (const [entrypoint, invoke] of asyncRequestEntrypoints) {
    assertBoundaryRequestError(await invoke(cyclicRequest()), entrypoint, /cyclic object graph/)
    assertBoundaryRequestError(await invoke(deeplyNestedRequest()), entrypoint, /nesting depth 128/)
  }
})

test('shared acyclic metadata objects remain valid JSON-compatible request input', () => {
  const metadata = { version: 1, exports: {} }
  const result = binding.transformSync({
    code: 'export const value = 1',
    filename: 'shared-metadata.js',
    metadata: [
      {
        request: './first.js',
        resolvedId: '/first.js',
        status: 'resolved',
        metadata,
        fingerprint: 'sha256:first',
      },
      {
        request: './second.js',
        resolvedId: '/second.js',
        status: 'resolved',
        metadata,
        fingerprint: 'sha256:second',
      },
    ],
  })

  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.internalError, undefined)
})

test('request decoding ignores inherited enumerable properties like JSON serialization', () => {
  const prototype = {}
  prototype.cycle = prototype
  const request = Object.assign(Object.create(prototype), {
    code: 'export const value = 1',
    filename: 'inherited-properties.js',
  })

  const result = binding.transformSync(request)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.internalError, undefined)
})

test('sync and worker-pool parser probes share the bounded native boundary shape', async () => {
  const expected = { statementCount: 1, diagnosticCount: 0, internalError: null }
  assert.deepEqual(binding.parseTsxProbeSync('export const value = 1'), expected)
  assert.deepEqual(await binding.parseTsxProbeAsync('export const value = 1'), expected)

  assert.throws(() => binding.parseTsxProbeSync({ source: 'not a string' }))
  assert.throws(() => binding.parseTsxProbeAsync({ source: 'not a string' }))
})
