#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    archive: {
      type: 'string',
      default: path.join(root, 'docs/benchmarks/runtime-review-fixed-2026-09-14.json'),
    },
    'check-readme': { type: 'boolean', default: false },
  },
})
const archive = JSON.parse(await readFile(values.archive, 'utf8'))
assert.equal(archive.schemaVersion, 1)
assert.equal(archive.rounds.length, 2)
assert.deepEqual(
  archive.rounds.map(round => round.round),
  ['a', 'b'],
)
for (const round of archive.rounds) {
  assert.ok(Date.parse(round.finishedAt) > Date.parse(round.startedAt))
  assert.ok(round.commands.length > 0)
  assert.ok(round.commands.every(command => command.exitCode === 0))
}
assert.ok(Date.parse(archive.rounds[1].startedAt) >= Date.parse(archive.rounds[0].finishedAt))
const cases = [
  ['01_run1k', 'Create rows (1k)'],
  ['02_replace1k', 'Replace all rows (1k)'],
  ['03_update10th1k_x16', 'Partial update (every 10th row)'],
  ['04_select1k', 'Select row'],
  ['05_swap1k', 'Swap rows'],
  ['06_remove-one-1k', 'Remove row'],
  ['07_create10k', 'Create many rows (10k)'],
  ['08_create1k-after1k_x2', 'Append rows (1k to 1k)'],
  ['09_clear1k_x8', 'Clear rows (1k)'],
]
const labels = ['Vue Vapor', 'Solid', 'Svelte 5', 'Fict', 'React Compiler']
assert.deepEqual(archive.frameworks.map(framework => framework.label).sort(), [...labels].sort())
const frameworks = labels.map(label => archive.frameworks.find(item => item.label === label))
const hash = value => createHash('sha256').update(value).digest('hex')
for (const framework of frameworks) {
  assert.match(framework.bundleSha256, /^[0-9a-f]{64}$/)
  for (const round of archive.rounds) {
    const entry = round.entries.find(item => item.label === framework.label)
    assert.ok(entry)
    assert.equal(entry.bundleSha256, framework.bundleSha256)
    assert.equal(`${entry.entry}-v${entry.version}-keyed`, framework.resultName)
  }
}
const fict = frameworks.find(framework => framework.label === 'Fict')
assert.equal(fict.provenance.compilerOptions.strictGuarantee, true)
assert.deepEqual(fict.provenance.diagnostics, [])
assert.equal(fict.provenance.bundleSha256, fict.bundleSha256)
assert.equal(hash(fict.source), fict.provenance.sourceSha256)
assert.equal(hash(fict.compiledSource), fict.provenance.compiledSha256)
assert.equal(
  hash(await readFile(path.join(root, archive.artifactArchive.file))),
  archive.artifactArchive.sha256,
)
const mean = samples => samples.reduce((sum, value) => sum + value, 0) / samples.length
const geometric = samples => Math.exp(mean(samples.map(value => Math.log(value))))
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} != ${expected}`)
assert.equal(archive.memory.exitCode, 0)
assert.equal(archive.memory.records.length, 15)
assert.ok(Date.parse(archive.memory.startedAt) >= Date.parse(archive.rounds[1].finishedAt))
for (const framework of frameworks) {
  for (const benchmark of ['21_ready-memory', '22_run-memory', '25_run-clear-memory']) {
    const matches = archive.memory.records.filter(
      record => record.framework === framework.resultName && record.benchmark === benchmark,
    )
    assert.equal(matches.length, 1)
    assert.equal(matches[0].type, 'memory')
    assert.equal(matches[0].keyed, true)
    const data = matches[0].values.DEFAULT
    assert.equal(data.values.length, 3)
    assert.ok(data.values.every(value => Number.isFinite(value) && value > 0))
    close(data.mean, mean(data.values), `${framework.label} / ${benchmark} memory mean`)
  }
}
const roundMeans = archive.rounds.map(round => {
  assert.equal(round.results.length, frameworks.length * cases.length)
  return cases.map(([id]) =>
    frameworks.map(framework => {
      const matches = round.results.filter(
        result => result.benchmark === id && result.framework === framework.resultName,
      )
      assert.equal(matches.length, 1, `${round.round}: ${framework.label} / ${id}`)
      const result = matches[0]
      assert.equal(result.type, 'cpu')
      assert.equal(result.keyed, true)
      for (const metric of ['total', 'script', 'paint']) {
        const data = result.values[metric]
        assert.equal(data.values.length, id === '04_select1k' ? 25 : 15)
        assert.ok(data.values.every(value => Number.isFinite(value) && value >= 0))
        close(data.mean, mean(data.values), `${id} / ${metric} sample mean`)
      }
      assert.ok(result.values.total.mean > 0)
      return result.values.total.mean
    }),
  )
})
const pooledMeans = cases.map((_, row) =>
  frameworks.map((_, column) => mean(roundMeans.map(round => round[row][column]))),
)
const scores = matrix =>
  frameworks.map((_, column) => geometric(matrix.map(row => row[column] / Math.min(...row))))
const pooledScores = scores(pooledMeans)
const perRoundScores = roundMeans.map(scores)
for (const [index, framework] of frameworks.entries()) {
  close(archive.aggregation.pooledScores[framework.label], pooledScores[index], 'pooled score')
  for (const [roundIndex, round] of archive.rounds.entries()) {
    const recorded = round.scores.find(score => score.label === framework.label)
    assert.ok(recorded)
    close(recorded.score, perRoundScores[roundIndex][index], `${round.round} score`)
  }
}
const fictIndex = labels.indexOf('Fict')
const target = 1.1
assert.equal(archive.aggregation.target, target)
assert.equal(archive.aggregation.pooledTargetPassed, pooledScores[fictIndex] <= target)
assert.deepEqual(
  archive.aggregation.roundTargetsPassed,
  perRoundScores.map(round => round[fictIndex] <= target),
)
const table = [
  `| Benchmark | ${labels.join(' | ')} |`,
  '| :--- | ---: | ---: | ---: | ---: | ---: |',
  ...cases.map(
    ([, label], row) =>
      `| ${label} | ${pooledMeans[row].map(value => value.toFixed(2)).join(' | ')} |`,
  ),
  `| **CPU geometric mean** | ${pooledScores.map(value => value.toFixed(3)).join(' | ')} |`,
].join('\n')
const resultLine = `Fict's pooled score is **${pooledScores[fictIndex].toFixed(6)}**. Complete round scores are **${perRoundScores[0][fictIndex].toFixed(6)}** and **${perRoundScores[1][fictIndex].toFixed(6)}**.`
const targetLine = `The strict **≤1.10** check uses unrounded values: pooled **${archive.aggregation.pooledTargetPassed ? 'PASS' : 'FAIL'}**; rounds **${archive.aggregation.roundTargetsPassed.map(passed => (passed ? 'PASS' : 'FAIL')).join(' / ')}**.`
const versionLine = `**Versions:** ${frameworks.map(framework => (framework.label === 'React Compiler' ? framework.version : `${framework.label} ${framework.version}`)).join(' · ')}.`
const revisionLine = `Fict compiler/runtime revision: \`${fict.provenance.revision.slice(0, 8)}\`; strict compilation with zero diagnostics.`
const create1kMean = (label, metric) => {
  const framework = frameworks.find(item => item.label === label)
  return mean(
    archive.rounds.map(
      round =>
        round.results.find(
          result => result.framework === framework.resultName && result.benchmark === '01_run1k',
        ).values[metric].mean,
    ),
  ).toFixed(2)
}
const creationLine = `Create 1k script time: **${create1kMean('Fict', 'script')} ms** for Fict and **${create1kMean('Solid', 'script')} ms** for Solid; paint time: **${create1kMean('Fict', 'paint')} ms** and **${create1kMean('Solid', 'paint')} ms**, respectively.`
if (values['check-readme']) {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8')
  const block = readme
    .split('<!-- runtime-benchmark:start -->')[1]
    ?.split('<!-- runtime-benchmark:end -->')[0]
  assert.ok(block, 'The README must identify the current benchmark block')
  const rows = text =>
    text
      .split('\n')
      .filter(line => line.startsWith('|'))
      .map(line =>
        line
          .split('|')
          .slice(1, -1)
          .map(cell => cell.trim()),
      )
      .filter(cells => !cells.every(cell => /^:?-+:?$/.test(cell)))
  assert.deepEqual(
    rows(block),
    rows(table),
    'README table must derive from the complete raw batches',
  )
  const normalized = block.replace(/\s+/g, ' ').trim()
  assert.ok(normalized.includes(resultLine), 'README must report pooled and both round scores')
  assert.ok(normalized.includes(targetLine), 'README must report the unrounded target result')
  assert.ok(normalized.includes(versionLine), 'README must identify all measured versions')
  assert.ok(normalized.includes(revisionLine), 'README must identify the qualified strict build')
  assert.ok(
    normalized.includes(creationLine),
    'README creation costs must derive from both batches',
  )
  console.log(
    'README benchmark: both complete batches, sample means, scores, target and creation costs verified',
  )
} else {
  console.log(
    `${table}\n\n${resultLine}\n${targetLine}\n\n${versionLine}\n${revisionLine}\n\n${creationLine}`,
  )
}
