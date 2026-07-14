#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function readArgument(name, fallback) {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function readPositiveInteger(name, fallback) {
  const value = Number(readArgument(name, fallback))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`--${name} must be a positive integer`)
  }
  return value
}

function moduleSource(index, rows) {
  const rowComponents = Array.from(
    { length: rows },
    (_, row) => `
      function Row${row}({ value, active }: { value: number; active: boolean }) {
        const label = active ? value * ${row + 2} : value + ${row + 1}
        return <li data-module="${index}" data-row="${row}">{label}</li>
      }
    `,
  ).join('\n')
  const rowElements = Array.from(
    { length: rows },
    (_, row) => `<Row${row} value={doubled} active={active} />`,
  ).join('')
  return `
    import { $effect, $memo, $state } from 'fict'
    ${rowComponents}
    export function Module${index}() {
      let count = $state(${index})
      let active = $state(false)
      const doubled = $memo(() => count * 2)
      $effect(() => void doubled)
      return (
        <section data-module="${index}">
          <button onClick={() => { count++; active = !active }}>{count}</button>
          <ul>${rowElements}</ul>
        </section>
      )
    }
  `
}

function corpus(modules, rows) {
  return Array.from({ length: modules }, (_, index) => moduleSource(index, rows))
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

function median(values) {
  return percentile(values, 0.5)
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

async function runWorker() {
  const backend = readArgument('backend')
  assert.ok(backend === 'legacy' || backend === 'rust', '--backend must be legacy or rust')
  const modules = readPositiveInteger('modules', 480)
  const rows = readPositiveInteger('rows', 10)
  const warmup = readPositiveInteger('warmup', 8)
  const sourcemap = readArgument('sourcemap', 'true') !== 'false'
  const sources = corpus(modules, rows)
  let compile
  let compilerBuildId = 'legacy-babel'
  let compilerBuildRevision = null
  const loadStarted = performance.now()

  if (backend === 'legacy') {
    const { transformSync } = require('../packages/compiler/node_modules/@babel/core')
    const transformTypeScript =
      require('../packages/compiler/node_modules/@babel/plugin-transform-typescript').default
    const createFictPlugin = require('../packages/compiler/dist/legacy.cjs').default
    compile = (source, index) => {
      const result = transformSync(source, {
        filename: `/bench/module-${index}.tsx`,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        sourceMaps: sourcemap,
        sourceFileName: `module-${index}.tsx`,
        parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
        plugins: [
          [
            transformTypeScript,
            {
              isTSX: true,
              allExtensions: true,
              allowNamespaces: true,
              onlyRemoveTypeImports: true,
            },
          ],
          [
            createFictPlugin,
            {
              dev: false,
              emitModuleMetadata: false,
              strictGuarantee: true,
              sourcemap,
            },
          ],
        ],
        generatorOpts: { compact: false },
      })
      return result?.code ?? ''
    }
  } else {
    const nativePath = path.resolve(
      readArgument('native-path', path.join(root, 'target', 'release', 'fict_compiler_napi.node')),
    )
    if (!existsSync(nativePath)) throw new Error(`Native compiler does not exist: ${nativePath}`)
    const binding = require(nativePath)
    const info = binding.nativeCompilerInfo()
    compilerBuildId = info.compilerBuildId
    compilerBuildRevision = info.compilerBuildRevision
    compile = (source, index) => {
      const result = binding.transformSync({
        code: source,
        filename: `/bench/module-${index}.tsx`,
        moduleId: `/bench/module-${index}.tsx`,
        options: { dev: false, sourcemap, strictGuarantee: true },
      })
      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
      if (errors.length > 0) throw new Error(errors.map(diagnostic => diagnostic.code).join(','))
      return result.code
    }
  }

  const loadDurationMs = performance.now() - loadStarted
  const coldStarted = performance.now()
  compile(sources[0], 0)
  const coldCompileDurationMs = performance.now() - coldStarted

  for (let index = 0; index < warmup; index += 1) compile(sources[index % sources.length], index)
  let outputBytes = 0
  const outputs = []
  const started = performance.now()
  for (let index = 0; index < sources.length; index += 1) {
    const output = compile(sources[index], index)
    outputs.push(output)
    outputBytes += Buffer.byteLength(output)
  }
  const durationMs = performance.now() - started
  const gzipOutputBytes = gzipSync(outputs.join('\n'), { level: 9 }).byteLength
  const inputBytes = sources.reduce((total, source) => total + Buffer.byteLength(source), 0)
  const usage = process.resourceUsage()
  process.stdout.write(
    `${JSON.stringify({
      backend,
      compilerBuildId,
      compilerBuildRevision,
      modules,
      rows,
      sourcemap,
      loadDurationMs,
      coldCompileDurationMs,
      durationMs,
      throughputModulesPerSecond: (modules * 1000) / durationMs,
      maxRssBytes: usage.maxRSS * 1024,
      inputBytes,
      outputBytes,
      gzipOutputBytes,
    })}\n`,
  )
}

function runBackend(backend, options) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--worker',
      `--backend=${backend}`,
      `--modules=${options.modules}`,
      `--rows=${options.rows}`,
      `--warmup=${options.warmup}`,
      `--sourcemap=${options.sourcemap}`,
      `--native-path=${options.nativePath}`,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    throw new Error(
      `${backend} benchmark failed (${result.status ?? 'signal'}):\n${result.stderr || result.stdout}`,
    )
  }
  return JSON.parse(result.stdout.trim())
}

function summarize(samples) {
  return {
    durationMedianMs: round(median(samples.map(sample => sample.durationMs))),
    durationP95Ms: round(
      percentile(
        samples.map(sample => sample.durationMs),
        0.95,
      ),
    ),
    throughputMedianModulesPerSecond: round(
      median(samples.map(sample => sample.throughputModulesPerSecond)),
    ),
    loadDurationP95Ms: round(
      percentile(
        samples.map(sample => sample.loadDurationMs),
        0.95,
      ),
    ),
    coldCompileDurationP95Ms: round(
      percentile(
        samples.map(sample => sample.coldCompileDurationMs),
        0.95,
      ),
    ),
    maxRssP95Bytes: Math.round(
      percentile(
        samples.map(sample => sample.maxRssBytes),
        0.95,
      ),
    ),
    inputBytes: samples[0].inputBytes,
    outputBytes: samples[0].outputBytes,
    gzipOutputBytes: samples[0].gzipOutputBytes,
  }
}

function loadBudget(filename, profile) {
  const document = JSON.parse(readFileSync(filename, 'utf8'))
  if (document.schemaVersion !== 1 || !document.profiles?.[profile]) {
    throw new Error(`Unknown compiler benchmark budget profile ${profile}`)
  }
  const budget = document.profiles[profile]
  for (const name of [
    'minimumP95Speedup',
    'maximumRssRatio',
    'maximumOutputRatio',
    'maximumGzipOutputRatio',
  ]) {
    if (!Number.isFinite(budget[name]) || budget[name] <= 0) {
      throw new TypeError(`Compiler benchmark budget ${profile}.${name} must be positive`)
    }
  }
  return budget
}

async function runParent() {
  const modules = readPositiveInteger('modules', 480)
  const rows = readPositiveInteger('rows', 10)
  const warmup = readPositiveInteger('warmup', 8)
  const sampleCount = readPositiveInteger('samples', 5)
  const sourcemap = readArgument('sourcemap', 'true') !== 'false'
  const nativePath = path.resolve(
    readArgument('native-path', path.join(root, 'target', 'release', 'fict_compiler_napi.node')),
  )
  const budgetPath = path.resolve(
    readArgument('budget', path.join(root, '.github', 'compiler-backend-budget.json')),
  )
  const profile = readArgument('profile', 'ci')
  const outputPath = readArgument('output', process.env.FICT_COMPILER_BENCH_OUTPUT)
  const samples = { legacy: [], rust: [] }

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const order = sample % 2 === 0 ? ['legacy', 'rust'] : ['rust', 'legacy']
    for (const backend of order) {
      samples[backend].push(runBackend(backend, { modules, rows, warmup, sourcemap, nativePath }))
    }
  }

  const legacy = summarize(samples.legacy)
  const rust = summarize(samples.rust)
  const metrics = {
    p95Speedup: round(legacy.durationP95Ms / rust.durationP95Ms),
    medianSpeedup: round(legacy.durationMedianMs / rust.durationMedianMs),
    rssRatio: round(rust.maxRssP95Bytes / legacy.maxRssP95Bytes),
    outputRatio: round(rust.outputBytes / legacy.outputBytes),
    gzipOutputRatio: round(rust.gzipOutputBytes / legacy.gzipOutputBytes),
  }
  const budget = loadBudget(budgetPath, profile)
  const violations = []
  if (metrics.p95Speedup < budget.minimumP95Speedup) {
    violations.push(`p95 speedup ${metrics.p95Speedup}x < ${budget.minimumP95Speedup}x`)
  }
  if (metrics.rssRatio > budget.maximumRssRatio) {
    violations.push(`RSS ratio ${metrics.rssRatio} > ${budget.maximumRssRatio}`)
  }
  if (metrics.outputRatio > budget.maximumOutputRatio) {
    violations.push(`output ratio ${metrics.outputRatio} > ${budget.maximumOutputRatio}`)
  }
  if (metrics.gzipOutputRatio > budget.maximumGzipOutputRatio) {
    violations.push(
      `gzip output ratio ${metrics.gzipOutputRatio} > ${budget.maximumGzipOutputRatio}`,
    )
  }
  const compilerBuildIds = new Set(samples.rust.map(sample => sample.compilerBuildId))
  if (compilerBuildIds.size !== 1 || compilerBuildIds.has(undefined)) {
    violations.push('Rust benchmark samples used different compiler build identifiers')
  }
  const compilerBuildId = samples.rust[0].compilerBuildId
  const compilerBuildRevisions = new Set(samples.rust.map(sample => sample.compilerBuildRevision))
  if (compilerBuildRevisions.size !== 1) {
    violations.push('Rust benchmark samples used different compiler build revisions')
  }
  const compilerBuildRevision = samples.rust[0].compilerBuildRevision
  const artifact = {
    schemaVersion: 2,
    corpus: {
      modules,
      rowsPerModule: rows,
      inputBytes: rust.inputBytes,
      sourcemap,
      digest: `sha256:${createHash('sha256')
        .update(JSON.stringify({ modules, rows, sourcemap, generator: 1 }))
        .digest('hex')}`,
    },
    samples: sampleCount,
    compilerBuildId,
    compilerBuildRevision,
    legacy,
    rust,
    metrics,
    budget: { profile, ...budget },
    status: violations.length === 0 ? 'pass' : 'fail',
    violations,
    rawSamples: samples,
  }
  if (outputPath) {
    const resolved = path.resolve(outputPath)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(
    `[compiler-backend-bench] p95 ${metrics.p95Speedup}x, median ${metrics.medianSpeedup}x, ` +
      `RSS ${metrics.rssRatio}x, raw ${metrics.outputRatio}x, gzip ${metrics.gzipOutputRatio}x ` +
      `(${artifact.status}).\n`,
  )
  if (violations.length > 0) throw new Error(violations.join('; '))
}

if (process.argv.includes('--worker')) {
  await runWorker()
} else {
  await runParent()
}
