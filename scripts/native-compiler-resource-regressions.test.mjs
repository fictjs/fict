import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { generatedCode } from './lib/native-generated-code-fixtures.mjs'
import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'

const nativePath = resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ?? 'target/release/fict_compiler_napi.node',
)
const native = createRequire(import.meta.url)(nativePath)
const depthCases = [
  ['jsx', 1500],
  ['parens', 4000],
  ['object', 5000],
]
if (process.argv[2] === '--depth-child') {
  const [api, kind, rawSize] = process.argv.slice(3)
  const result = await native[api]({
    code: generatedCode(kind, Number(rawSize)),
    filename: '/deep.tsx',
  })
  assert.ok(
    result.diagnostics.some(diagnostic => diagnostic.code === 'FICT-RESOURCE-LIMIT'),
    JSON.stringify(result.diagnostics),
  )
  assert.ok(
    result.diagnostics.every(diagnostic => diagnostic.message.includes('syntax depth limit')),
  )
  assert.equal(result.internalError ?? null, null)
  const next = native.transformSync({ code: 'export const healthy = 42', filename: '/healthy.ts' })
  assert.deepEqual(next.diagnostics, [])
  assert.ok(next.code.includes('42'))
  console.log('depth rejected; compiler still usable')
} else {
  for (const api of ['transformSync', 'transform', 'analyzeSync', 'analyze', 'scanSync', 'scan']) {
    for (const [kind, size] of depthCases) {
      test(`bug 29: ${api} contains ${size} nested ${kind} nodes`, () => {
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), '--depth-child', api, kind, String(size)],
          {
            encoding: 'utf8',
            timeout: 30000,
            env: { ...process.env, FICT_COMPILER_NATIVE_PATH: nativePath },
          },
        )
        assert.equal(child.error, undefined)
        assert.equal(child.signal, null, child.stderr)
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stderr, '')
        assert.match(child.stdout, /compiler still usable/)
      })
    }
  }
  for (const kind of ['branches', 'switch']) {
    test(`bug 29: large plain ${kind} keeps every branch`, () => {
      const result = native.transformSync({
        code: generatedCode(kind, 800),
        filename: '/dispatch.ts',
        moduleKind: 'commonjs',
      })
      assert.deepEqual(result.diagnostics, [])
      const context = { exports: {} }
      vm.runInNewContext(result.code, context)
      for (let i = 0; i < 800; i++) assert.equal(context.exports.f(i), i)
      assert.equal(context.exports.f(800), -1)
      for (const stage of ['frontend', 'metadata', 'lowering', 'codegen'])
        assert.ok(result.stats.stageDurationsNs[stage] > 0, stage)
    })
  }
  for (const kind of ['sum', 'states', 'derived']) {
    test(`bug 29: long ${kind} graph still updates its full result`, async () => {
      const size = 300
      const source = `${generatedCode(kind, size)}\nimport {render} from 'fict'; let root; export function mount(container){root=container;return render(()=><App/>,root)} export function observe(){return root.textContent}`
      const result = native.transformSync({
        code: source,
        filename: '/long.tsx',
        moduleKind: 'commonjs',
        options: { dev: false, strictGuarantee: true },
      })
      assert.deepEqual(result.diagnostics, [])
      const observations = await executeDomCommonJs(result.code, {
        mountExport: 'mount',
        observeExport: 'observe',
        steps: [
          { kind: 'record', label: 'initial' },
          { kind: 'click', selector: 'button' },
          { kind: 'record', label: 'updated' },
        ],
      })
      assert.deepEqual(observations, [
        { label: 'initial', value: String(kind === 'derived' ? size : 0) },
        { label: 'updated', value: String(kind === 'derived' ? size + 1 : size) },
      ])
    })
  }
}
