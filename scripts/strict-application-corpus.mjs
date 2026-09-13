#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  CORPUS_APPLICATIONS,
  sha256,
  sourceMetrics,
  summarizeBuild,
  summarizeMetrics,
} from './lib/strict-application-corpus.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { 'build-only': { type: 'boolean', default: false } } })
const outputRoot = path.join(root, 'test-results/strict-application-corpus')
const reportPath = path.join(root, 'test-results/strict-application-corpus.json')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const require = createRequire(import.meta.url)
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
assert.equal(path.extname(nativePath), '.node', 'The corpus requires the actual native artifact')
const compiler = require(nativePath).nativeCompilerInfo()
const git = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

async function fileIdentity(filename) {
  const bytes = await readFile(filename)
  return { file: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }
}

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(filename)))
    else if (entry.isFile()) files.push(filename)
    else throw new Error(`Unexpected non-file build input/output: ${filename}`)
  }
  return files.sort()
}

async function identitiesUnder(directory) {
  return Promise.all((await filesUnder(directory)).map(fileIdentity))
}

await mkdir(outputRoot, { recursive: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'fict-strict-applications-'))
const baseEnv = {
  ...process.env,
  NODE_ENV: 'production',
  FICT_STRICT_GUARANTEE: '1',
  FICT_CORPUS_NATIVE: nativePath,
  FICT_COMPILER_NATIVE_PATH: path.join(root, 'scripts/lib/strict-application-native-capture.cjs'),
}
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  revision: git('rev-parse', 'HEAD') ?? process.env.GITHUB_SHA ?? null,
  workingTree: git('status', '--short'),
  trackedDiffSha256: git('diff', 'HEAD') === null ? null : sha256(git('diff', 'HEAD')),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  compiler,
  nativeArtifact: await fileIdentity(nativePath),
  lockfile: await fileIdentity(path.join(root, 'pnpm-lock.yaml')),
  applications: [],
  fixtures: [],
  limits: [
    'Eight maintained application fixtures, including a Webpack variant of the async-data design; not eight independent external adoptions.',
    'Library publishing and the keyed benchmark compile fixture are reported separately from applications.',
    'Lexical code lines include TypeScript types, JSX and styles. Function-body lines exclude module-level style objects but include helpers and fetchers.',
    'API counts identify imported names, namespace members and direct const aliases by lexical symbol. Dynamic containers, wrapper inference and runtime invocation counts are outside this source-incidence metric.',
    'Snapshot density measures explicit untrack calls, not all potential unknown-call boundaries or false-positive rate.',
    'Build and browser correctness only; no CPU, memory, external migration or remote CI claim.',
  ],
}
const writeReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')

async function command(name, executable, args, { cwd = root, env = baseEnv } = {}) {
  process.stdout.write(`[strict-applications] ${name}\n`)
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5 * 60_000,
  })
  const log = path.join(outputRoot, `${name}.log`)
  await writeFile(log, `${result.stdout ?? ''}${result.stderr ?? ''}`)
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed; see ${path.relative(root, log)}`, {
      cause: result.error ?? new Error(result.stderr || result.stdout || `exit ${result.status}`),
    })
  }
  return {
    executable: executable === process.execPath ? 'node' : executable,
    args,
    cwd: path.relative(root, cwd),
    exitCode: result.status,
    log: await fileIdentity(log),
  }
}

async function buildPhase(application, phase, sourceFiles) {
  const name = `${application.id}-${phase}`
  const directory = path.join(root, 'examples', application.id)
  const journal = path.join(outputRoot, `${name}-native`)
  // Remove only this tool's prior capture. No compiler cache can satisfy this build.
  await rm(journal, { recursive: true, force: true })
  await mkdir(journal)
  const env = { ...baseEnv, FICT_CORPUS_PHASE: name, FICT_CORPUS_JOURNAL: journal }
  let invocation
  if (application.bundler === 'webpack') {
    invocation = await command(name, pnpm, ['exec', 'webpack', '--mode', 'production'], {
      cwd: directory,
      env,
    })
  } else {
    const config = path.join(temporary, `${name}.config.mjs`)
    await writeFile(
      config,
      `import original from ${JSON.stringify(path.join(directory, 'vite.config.ts'))};\n` +
        `export default async env => ({ ...(await (typeof original === 'function' ? original(env) : original)), cacheDir: ${JSON.stringify(path.join(temporary, name, 'cache'))} });\n`,
    )
    const args = ['exec', 'vite', 'build', '--config', config]
    if (application.ssr) args.push('--outDir', `dist/${phase}`)
    if (phase === 'server') args.push('--ssr', 'src/entry-server.tsx')
    invocation = await command(name, pnpm, args, { cwd: directory, env })
  }
  const records = (
    await Promise.all((await filesUnder(journal)).map(file => readFile(file, 'utf8')))
  ).flatMap(text =>
    text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)),
  )
  const expectedSources = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async file => {
        const filename = path.join(directory, 'src', file)
        return [filename, await readFile(filename, 'utf8')]
      }),
    ),
  )
  const summary = summarizeBuild(records, {
    root,
    expectedSources,
    compilerBuildId: compiler.compilerBuildId,
  })
  return {
    phase,
    invocation,
    environment: { NODE_ENV: env.NODE_ENV, FICT_STRICT_GUARANTEE: env.FICT_STRICT_GUARANTEE },
    freshCache: true,
    ...summary,
    journals: await identitiesUnder(journal),
    assets: await identitiesUnder(path.join(directory, 'dist', application.ssr ? phase : '')),
  }
}

try {
  report.qualificationTools = await Promise.all(
    [
      'scripts/strict-application-corpus.mjs',
      'scripts/strict-application-browser.mjs',
      'scripts/lib/strict-application-corpus.mjs',
      'scripts/lib/strict-application-native-capture.cjs',
      'scripts/native-compiler-build-id.test.mjs',
      'scripts/run-real-app-e2e.mjs',
    ].map(file => fileIdentity(path.join(root, file))),
  )
  report.nativeSourceVerification = await command(
    'native-source-identity',
    process.execPath,
    ['--test', 'scripts/native-compiler-build-id.test.mjs'],
    { env: { ...process.env, FICT_COMPILER_NATIVE_PATH: nativePath } },
  )
  // Record the built package inputs, including the real compiler integration code.
  report.packageArtifacts = []
  for (const name of ['compiler', 'runtime', 'fict', 'ssr', 'vite-plugin', 'webpack-plugin']) {
    report.packageArtifacts.push(
      ...(await identitiesUnder(path.join(root, 'packages', name, 'dist'))),
    )
  }
  for (const application of CORPUS_APPLICATIONS) {
    const directory = path.join(root, 'examples', application.id)
    const configFiles = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.(json|[cm]?js|ts|html)$/.test(entry.name))
      .map(entry => path.join(directory, entry.name))
    const sources = await Promise.all(
      application.files.map(async file => {
        const filename = path.join(directory, 'src', file)
        return {
          ...(await fileIdentity(filename)),
          metrics: sourceMetrics(await readFile(filename, 'utf8'), filename),
        }
      }),
    )
    const entry = {
      id: application.id,
      category: application.category,
      tier: application.tier,
      buildInputs: await Promise.all(
        [...configFiles, ...(await filesUnder(path.join(directory, 'src')))]
          .sort()
          .map(fileIdentity),
      ),
      sources,
      metrics: summarizeMetrics(sources),
      builds: [],
    }
    report.applications.push(entry)
    await writeReport()
    if (application.ssr) {
      const clientFiles = application.files.filter(file => !file.startsWith('entry-server'))
      entry.builds.push(
        await buildPhase(
          application,
          'client',
          application.id === 'ssr-streaming' ? ['entry-client.ts'] : clientFiles,
        ),
      )
      entry.builds.push(
        await buildPhase(
          application,
          'server',
          application.files.filter(file => !file.startsWith('entry-client')),
        ),
      )
    } else {
      entry.builds.push(await buildPhase(application, 'production', application.files))
    }
    await writeReport()
  }
  const benchmark = path.join(root, 'scripts/fixtures/runtime-benchmark/main.tsx')
  const source = await readFile(benchmark, 'utf8')
  const request = {
    filename: benchmark,
    code: source,
    options: { dev: false, strictGuarantee: true },
  }
  const result = require(nativePath).transformSync(request)
  const summary = summarizeBuild([{ method: 'transformSync', request, result }], {
    root,
    compilerBuildId: compiler.compilerBuildId,
    expectedSources: { [benchmark]: source },
  })
  assert.deepEqual(result.diagnostics, [], 'Keyed compile fixture must have zero diagnostics')
  const benchmarkSource = {
    ...(await fileIdentity(benchmark)),
    metrics: sourceMetrics(source, benchmark),
  }
  report.fixtures.push({
    id: 'keyed-benchmark',
    category: 'compile fixture',
    source: benchmarkSource,
    ...summary,
  })
  report.applicationMetrics = summarizeMetrics(
    report.applications.filter(app => app.category === 'application').flatMap(app => app.sources),
  )
  report.publisherMetrics = summarizeMetrics(
    report.applications
      .filter(app => app.category === 'library publisher')
      .flatMap(app => app.sources),
  )
  report.status = 'built; browser not run'
  await writeReport()
  if (!values['build-only']) {
    const browserEnv = { ...process.env }
    delete browserEnv.FICT_COMPILER_NATIVE_PATH
    report.browser = []
    report.browser.push(
      await command(
        'application-browser',
        process.execPath,
        ['scripts/strict-application-browser.mjs'],
        { env: browserEnv },
      ),
    )
    const applicationBrowser = JSON.parse(
      await readFile(path.join(outputRoot, 'application-browser.json'), 'utf8'),
    )
    assert.equal(applicationBrowser.status, 'passed')
    assert.deepEqual(
      applicationBrowser.cases.map(item => item.application),
      ['counter-basic', 'todos', 'forms', 'async-data', 'counter-webpack'],
    )
    assert.ok(applicationBrowser.cases.every(item => item.passed && item.errors.length === 0))
    report.applicationBrowser = {
      ...(await fileIdentity(path.join(outputRoot, 'application-browser.json'))),
      cases: applicationBrowser.cases,
      browser: applicationBrowser.browser,
    }
    report.browser.push(
      await command(
        'streaming-production-smoke',
        pnpm,
        ['-C', 'examples/ssr-streaming', 'smoke:production'],
        { env: browserEnv },
      ),
    )
    report.browser.push(
      await command(
        'real-app-browser',
        process.execPath,
        [
          'scripts/run-real-app-e2e.mjs',
          '--output',
          path.join(outputRoot, 'real-app-browser-output'),
          process.env.GITHUB_ACTIONS ? '--reporter=list,github,html,json' : '--reporter=list,json',
        ],
        {
          env: {
            ...browserEnv,
            PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(outputRoot, 'real-app-browser.json'),
            PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outputRoot, 'real-app-browser-html'),
          },
        },
      ),
    )
    const realAppBrowser = JSON.parse(
      await readFile(path.join(outputRoot, 'real-app-browser.json'), 'utf8'),
    )
    assert.equal(realAppBrowser.stats.unexpected, 0)
    assert.equal(realAppBrowser.stats.skipped, 0)
    assert.equal(realAppBrowser.stats.expected + realAppBrowser.stats.flaky, 4)
    report.realAppBrowser = {
      ...(await fileIdentity(path.join(outputRoot, 'real-app-browser.json'))),
      stats: realAppBrowser.stats,
    }
    report.status = 'passed'
  }
  // Browser tests must consume the captured artifacts; detect rebuilds or edits during the gate.
  for (const app of report.applications) {
    for (const identity of [
      ...app.sources,
      ...app.buildInputs,
      ...app.builds.flatMap(build => build.assets),
    ]) {
      assert.equal(
        (await fileIdentity(path.join(root, identity.file))).sha256,
        identity.sha256,
        `Source/build changed during qualification: ${identity.file}`,
      )
    }
  }
  for (const identity of [
    ...report.packageArtifacts,
    ...report.qualificationTools,
    ...report.fixtures.map(fixture => fixture.source),
    report.nativeArtifact,
    report.lockfile,
  ]) {
    assert.equal(
      (await fileIdentity(path.join(root, identity.file))).sha256,
      identity.sha256,
      `Compiler/package changed during qualification: ${identity.file}`,
    )
  }
  report.finishedAt = new Date().toISOString()
  await writeReport()
  process.stdout.write(
    `[strict-applications] ${report.status}: ${path.relative(root, reportPath)}\n`,
  )
} catch (error) {
  report.status = 'failed'
  report.error = { message: error.message, cause: error.cause?.message }
  await writeReport()
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
