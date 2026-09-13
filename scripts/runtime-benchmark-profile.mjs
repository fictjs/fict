#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    'benchmark-root': { type: 'string', default: path.join(root, 'js-framework-benchmark') },
    name: { type: 'string', default: 'fict-local' },
    url: { type: 'string', default: 'http://localhost:8080' },
    repetitions: { type: 'string', default: '3' },
    output: { type: 'string' },
  },
})
assert.match(values.name, /^fict-[a-z0-9-]+$/)
const repetitions = Number(values.repetitions)
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 20)
const entry = path.resolve(values['benchmark-root'], 'frameworks/keyed', values.name)
const output = path.resolve(
  values.output ?? path.join(root, 'test-results', `${values.name}-profile.json`),
)
const hash = value => createHash('sha256').update(value).digest('hex')
const provenanceText = await readFile(path.join(entry, 'provenance.json'), 'utf8')
const provenance = JSON.parse(provenanceText)
assert.equal(provenance.compilerOptions.strictGuarantee, true)
assert.deepEqual(provenance.diagnostics, [])
assert.equal(provenance.sourceMap, true, 'Build the named entry with --sourcemap')
const bundle = await readFile(path.join(entry, 'dist/main.js'))
const mapText = await readFile(path.join(entry, 'dist/main.js.map'), 'utf8')
assert.equal(hash(bundle), provenance.bundleSha256)
const require = createRequire(import.meta.url)
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')
const sourceMap = new TraceMap(JSON.parse(mapText))
const requireBenchmark = createRequire(
  path.join(values['benchmark-root'], 'webdriver-ts/package.json'),
)
const { chromium } = requireBenchmark('playwright')
const entryUrl = `${values.url}/frameworks/keyed/${values.name}`
const response = await fetch(`${entryUrl}/dist/main.js`)
assert.equal(response.status, 200)
assert.equal(hash(Buffer.from(await response.arrayBuffer())), provenance.bundleSha256)

function frame(callFrame) {
  const { functionName, url, lineNumber, columnNumber } = callFrame
  if (url === `${entryUrl}/dist/main.js` && lineNumber >= 0 && columnNumber >= 0) {
    const original = originalPositionFor(sourceMap, { line: lineNumber + 1, column: columnNumber })
    if (original.source)
      return {
        function: original.name ?? functionName,
        source: original.source,
        line: original.line,
        column: original.column,
      }
  }
  return { function: functionName, source: url, line: lineNumber + 1, column: columnNumber }
}

function summarizeCpu(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map(
    profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])),
  )
  const self = new Map(),
    inclusive = new Map()
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const duration = profile.timeDeltas[index]
    self.set(id, (self.get(id) ?? 0) + duration)
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor))
      inclusive.set(cursor, (inclusive.get(cursor) ?? 0) + duration)
  }
  return [...nodes.values()]
    .map(node => ({
      id: node.id,
      ...frame(node.callFrame),
      selfMicroseconds: self.get(node.id) ?? 0,
      inclusiveMicroseconds: inclusive.get(node.id) ?? 0,
    }))
    .sort((a, b) => b.selfMicroseconds - a.selfMicroseconds)
}

function summarizeAllocations(profile) {
  const rows = []
  function visit(node) {
    const inclusiveBytes =
      node.selfSize + node.children.reduce((total, child) => total + visit(child), 0)
    rows.push({ id: node.id, ...frame(node.callFrame), selfBytes: node.selfSize, inclusiveBytes })
    return inclusiveBytes
  }
  visit(profile.head)
  return rows.sort((a, b) => b.selfBytes - a.selfBytes)
}

const cases = [
  { name: 'create1k', button: 'run', initial: 0, rows: 1000 },
  { name: 'create10k', button: 'runlots', initial: 0, rows: 10000 },
  { name: 'replace1k', button: 'run', initial: 1000, rows: 1000 },
  { name: 'append1k', button: 'add', initial: 1000, rows: 2000 },
  { name: 'clear1k', button: 'clear', initial: 1000, rows: 0 },
]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = {
  schemaVersion: 1,
  profilerSha256: hash(await readFile(new URL(import.meta.url))),
  recordedAt: new Date().toISOString(),
  entry: values.name,
  browser: browser.version(),
  platform: `${process.platform} ${process.arch}`,
  provenance,
  provenanceSha256: hash(provenanceText),
  sourceMapSha256: hash(mapText),
  method: {
    repetitions,
    separateFreshPages: true,
    warmupCreateClearPairs: 2,
    cpuSlowdown: 4,
    cpuSamplingIntervalMicroseconds: 250,
    allocationSamplingIntervalBytes: 4096,
    includesCollectedAllocations: true,
    viewport: { width: 1280, height: 800 },
    scope:
      'Diagnostic sampling with profiler overhead; never included in benchmark scores. CPU capture includes the target click and two animation frames. Allocation estimates include garbage collected during capture and do not represent retained heap or whole-page memory.',
  },
  captures: [],
  errors: [],
}
const settle = page =>
  page.evaluate(
    () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
const click = (page, button) => page.evaluate(id => document.getElementById(id).click(), button)
try {
  for (const mode of ['cpu', 'allocation']) {
    for (const scenario of cases) {
      for (let repeat = 0; repeat < repetitions; repeat++) {
        const context = await browser.newContext({ viewport: report.method.viewport })
        const page = await context.newPage()
        page.on('pageerror', error => report.errors.push(String(error)))
        const client = await context.newCDPSession(page)
        try {
          await page.goto(`${entryUrl}/index.html`)
          await page.locator('#run').waitFor()
          for (let warmup = 0; warmup < 2; warmup++) {
            await click(page, 'run')
            await settle(page)
            await click(page, 'clear')
            await settle(page)
          }
          if (scenario.initial) {
            await click(page, 'run')
            await settle(page)
          }
          assert.equal(await page.locator('tbody > tr').count(), scenario.initial)
          await client.send('HeapProfiler.collectGarbage')
          await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
          if (mode === 'cpu') {
            await client.send('Profiler.enable')
            await client.send('Profiler.setSamplingInterval', { interval: 250 })
            await client.send('Profiler.start')
          } else {
            await client.send('HeapProfiler.startSampling', {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            })
          }
          await click(page, scenario.button)
          await settle(page)
          const { profile } = await client.send(
            mode === 'cpu' ? 'Profiler.stop' : 'HeapProfiler.stopSampling',
          )
          await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
          assert.equal(await page.locator('tbody > tr').count(), scenario.rows)
          assert.deepEqual(report.errors, [])
          const summary = mode === 'cpu' ? summarizeCpu(profile) : summarizeAllocations(profile)
          report.captures.push({
            mode,
            scenario: scenario.name,
            repeat,
            rows: scenario.rows,
            summary,
            profile,
          })
          console.log(`${values.name} ${mode} ${scenario.name} ${repeat + 1}/${repetitions}`)
        } finally {
          await context.close()
        }
      }
    }
  }
  assert.equal(await readFile(path.join(entry, 'provenance.json'), 'utf8'), provenanceText)
  assert.equal(hash(await readFile(path.join(entry, 'dist/main.js'))), provenance.bundleSha256)
  const served = await fetch(`${entryUrl}/dist/main.js`)
  assert.equal(served.status, 200)
  assert.equal(hash(Buffer.from(await served.arrayBuffer())), provenance.bundleSha256)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(`Profile evidence: ${output}`)
} finally {
  await browser.close()
}
