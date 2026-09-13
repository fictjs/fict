import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  sourceMetrics,
  summarizeBuild,
  summarizeMetrics,
} from './lib/strict-application-corpus.mjs'

test('source incidence uses lexical imported identity, including aliases and namespaces', () => {
  const metrics = sourceMetrics(`
import { untrack as snapshot, $memo } from 'fict'
import * as Fict from 'fict'
import { reactive as key } from 'fict/advanced'
import { untrack } from 'unrelated'
import type { $state } from 'fict'
const alias = snapshot
const namespace = Fict
function App() {
  snapshot(() => 1)
  alias(() => 2)
  namespace.untrack(() => 3)
  Fict['untrack'](() => 4)
  const value = $memo(() => 1)
  key(() => value)
  untrack(() => 5)
  $state(0)
  function shadow(snapshot) { snapshot(() => 6) }
  { const alias = external; alias(() => 7) }
}
`)
  assert.deepEqual(metrics.counts, { untrack: 4, $memo: 1, reactive: 1 })
  assert.equal(metrics.explicitSnapshots, 4)
  assert.equal(metrics.snapshotsInsideFunctions, 4)
  assert.ok(metrics.totalCalls > metrics.identifiedApiCalls)
})

test('comments, strings, object spellings, type-only namespaces and dynamic aliases do not count', () => {
  const metrics = sourceMetrics(`
import { untrack } from 'fict'
import type * as F from 'fict'
// untrack(() => live)
/** untrack(() => live) */
const text = 'untrack(() => live)'
const methods = { untrack }
let mutable = untrack
mutable = external
function App() {
  methods.untrack(() => 1)
  mutable(() => 2)
  F.untrack(() => 3)
  const untrack = external
  untrack(() => 4)
  return <p>untrack(() =&gt; live)</p>
}
`)
  assert.equal(metrics.explicitSnapshots, 0)
  assert.equal(metrics.identifiedApiCalls, 0)
  assert.ok(metrics.lexicalCodeLines > metrics.functionBodyCodeLines)
  assert.throws(() => sourceMetrics('const = syntax error'), /invalid source/)
})

test('separate function-body denominator excludes module styles and matches its numerator', () => {
  const metrics = sourceMetrics(`
import { untrack } from 'fict'
const captured = untrack(() => 1)
const styles = {
  color: 'red',
  margin: '2px',
}
function App() {
  return untrack(() => captured)
}
`)
  assert.equal(metrics.explicitSnapshots, 2)
  assert.equal(metrics.snapshotsInsideFunctions, 1)
  assert.equal(metrics.functionBodyCodeLines, 4)
  const summary = summarizeMetrics([{ metrics }, { metrics }])
  assert.equal(summary.explicitSnapshots, 4)
  assert.equal(summary.snapshotsInsideFunctions, 2)
  assert.equal(summary.counts.untrack, 4)
  assert.equal(summary.snapshotsPerThousandFunctionBodyCodeLines, 250)
  assert.equal(summarizeMetrics([]).snapshotsPerThousandCodeLines, null)
})

const fixtureRecord = () => ({
  method: 'transform',
  request: {
    filename: '/repo/app.tsx',
    code: 'source',
    options: { dev: false, strictGuarantee: true },
  },
  result: {
    code: 'output',
    compilerBuildId: 'identity',
    diagnostics: [],
    metadataIncomplete: false,
  },
})
const summarize = records =>
  summarizeBuild(records, {
    root: '/repo',
    compilerBuildId: 'identity',
    expectedSources: { '/repo/app.tsx': 'source' },
  })

test('build evidence rejects cache bypass, weakened policy, stale input, missing output and errors', () => {
  assert.throws(() => summarize([]), /No observed native transforms/)
  const mutations = [
    [
      record => {
        record.request.options.strictGuarantee = false
      },
      /Strict policy/,
    ],
    [
      record => {
        delete record.request.options.strictGuarantee
      },
      /Strict policy/,
    ],
    [
      record => {
        record.request.options.dev = true
      },
      /development compile/,
    ],
    [
      record => {
        record.result.compilerBuildId = 'other'
      },
      /identity changed/,
    ],
    [
      record => {
        record.result.internalError = { message: 'broken' }
      },
      /internal error/,
    ],
    [
      record => {
        record.result.diagnostics.push({ code: 'FICT-R005', severity: 'error' })
      },
      /FICT-R005/,
    ],
    [
      record => {
        record.result.diagnostics.push({
          code: 'FICT-R002',
          severity: 'warning',
          guaranteeClass: 'fallback',
        })
      },
      /Invalid guarantee diagnostics/,
    ],
    [
      record => {
        record.result.metadataIncomplete = true
      },
      /No final native output/,
    ],
    [
      record => {
        record.request.code = 'changed'
      },
      /Source drift/,
    ],
    [
      record => {
        record.request.filename = '/repo/different.tsx'
      },
      /No final native output/,
    ],
    [
      record => {
        record.result.code = ''
      },
      /Missing code/,
    ],
    [
      record => {
        record.error = { message: 'thrown' }
      },
      /Native invocation threw/,
    ],
  ]
  for (const [mutate, expected] of mutations) {
    const record = fixtureRecord()
    mutate(record)
    assert.throws(() => summarize([record]), expected)
  }
})

test('build aggregation preserves provisional stages, strict options and warning provenance', () => {
  const first = fixtureRecord()
  first.result.metadataIncomplete = true
  first.result.diagnostics.push({
    code: 'FICT-X003',
    severity: 'warning',
    guaranteeClass: 'advisory',
    primarySpan: { start: 0, end: 1 },
  })
  const final = fixtureRecord()
  final.result.diagnostics = first.result.diagnostics
  const report = summarize([first, final])
  assert.equal(report.requests.transform, 2)
  assert.equal(report.compilations.length, 2)
  assert.equal(report.compilations[0].metadataIncomplete, true)
  assert.equal(report.compilations[1].metadataIncomplete, false)
  assert.equal(report.compilations[1].options.strictGuarantee, true)
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].file, 'app.tsx')
})

test('analysis requests retain their nested strict policy and may not hide errors', () => {
  const analyze = {
    method: 'analyzeSync',
    request: { options: { compilerOptions: { dev: false, strictGuarantee: true } } },
    result: { diagnostics: [] },
  }
  assert.equal(summarize([fixtureRecord(), analyze]).requests.analyze, 1)
  analyze.request.options.strictGuarantee = true
  analyze.request.options.compilerOptions.strictGuarantee = false
  assert.throws(() => summarize([fixtureRecord(), analyze]), /Strict policy/)
  analyze.request.options.compilerOptions.strictGuarantee = true
  analyze.result.diagnostics.push({ severity: 'error', guaranteeClass: 'fallback' })
  assert.throws(() => summarize([fixtureRecord(), analyze]), /Invalid guarantee diagnostics/)
})

test('capture forwards native identity, results and both sync/async failures without mutation', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fict-native-capture-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fake = path.join(directory, 'binding.cjs')
  writeFileSync(
    fake,
    `
const result = { code: 'unchanged' }
const info = { compilerBuildId: 'real identity' }
module.exports = {
  result, info, nativeCompilerInfo: () => info,
  transformSync: request => { if (request.fail) throw new TypeError('sync failure'); return result },
  transform: async request => { if (request.fail) throw new RangeError('async failure'); return result },
  analyzeSync: () => result, analyze: async () => result,
  scanSync: () => result, scan: async () => result,
}
`,
  )
  const capture = fileURLToPath(
    new URL('./lib/strict-application-native-capture.cjs', import.meta.url),
  )
  execFileSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
const assert = require('node:assert/strict')
const binding = require(process.env.FICT_CORPUS_NATIVE)
const capture = require(${JSON.stringify(capture)})
;(async () => {
  assert.equal(capture.nativeCompilerInfo(), binding.info)
  const request = { code: 'original' }
  assert.equal(capture.transformSync(request), binding.result)
  assert.equal(await capture.transform(request), binding.result)
  assert.deepEqual(request, { code: 'original' })
  assert.throws(() => capture.transformSync({ fail: true }), TypeError)
  await assert.rejects(capture.transform({ fail: true }), RangeError)
})().catch(error => { console.error(error); process.exitCode = 1 })
`,
    ],
    {
      env: {
        ...process.env,
        FICT_CORPUS_NATIVE: fake,
        FICT_CORPUS_JOURNAL: directory,
        FICT_CORPUS_PHASE: 'contract',
      },
    },
  )
  const records = readdirSync(directory)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file =>
      readFileSync(path.join(directory, file), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    )
  assert.equal(records.length, 4)
  assert.deepEqual(
    records.map(record => record.phase),
    Array(4).fill('contract'),
  )
  assert.deepEqual(
    records.slice(0, 2).map(record => record.result),
    Array(2).fill({ code: 'unchanged' }),
  )
  assert.equal(records[2].error.name, 'TypeError')
  assert.equal(records[3].error.name, 'RangeError')
})
