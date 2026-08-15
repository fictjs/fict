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

const request = Object.freeze({
  code: 'export function App() { return <main>ready</main> }',
  filename: 'request-limits.tsx',
  limits: { maxSourceBytes: 4 },
})

function assertSourceLimit(result, entrypoint) {
  assert.equal(result.diagnostics[0]?.code, 'FICT-REQUEST', entrypoint)
  assert.match(result.diagnostics[0]?.message ?? '', /maxSourceBytes/, entrypoint)
}

test('sync N-API compile, scan, and analyze preserve partial RequestLimits', () => {
  for (const [entrypoint, invoke] of [
    ['transformSync', binding.transformSync],
    ['scanSync', binding.scanSync],
    ['analyzeSync', binding.analyzeSync],
  ]) {
    assertSourceLimit(invoke(request), entrypoint)
  }
})

test('worker-pool N-API compile, scan, and analyze preserve partial RequestLimits', async () => {
  for (const [entrypoint, invoke] of [
    ['transform', binding.transform],
    ['scan', binding.scan],
    ['analyze', binding.analyze],
  ]) {
    assertSourceLimit(await invoke(request), entrypoint)
  }
})

test('N-API rejects unknown and unbounded RequestLimits fail closed', () => {
  const unknown = binding.transformSync({
    ...request,
    limits: { maxParserDepth: 10 },
  })
  assert.equal(unknown.diagnostics[0]?.code, 'FICT-REQUEST')
  assert.match(unknown.diagnostics[0]?.message ?? '', /unknown field `maxParserDepth`/)

  const unbounded = binding.transformSync({
    ...request,
    limits: { maxSourceBytes: 64 * 1024 * 1024 + 1 },
  })
  assert.equal(unbounded.diagnostics[0]?.code, 'FICT-REQUEST')
  assert.match(unbounded.diagnostics[0]?.message ?? '', /supported range/)
})

test('N-API returns a bounded error instead of an oversized compile result', () => {
  const result = binding.transformSync({
    code: `export const value = ${JSON.stringify('output'.repeat(1024))}`,
    filename: 'bounded-output.ts',
    limits: { maxOutputBytes: 4096 },
  })
  assert.equal(result.diagnostics[0]?.code, 'FICT-REQUEST')
  assert.match(result.diagnostics[0]?.message ?? '', /maxOutputBytes/)
  assert.equal(result.code, '')
})
