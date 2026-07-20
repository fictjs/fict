#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { format, resolveConfig } from 'prettier'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const inventoryPath = path.join(
  repositoryRoot,
  'scripts/fixtures/legacy_0_28_compiler_assertion_inventory.json',
)
const rustCodegenCorpusPath = path.join(
  repositoryRoot,
  'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json',
)
const captureConfigPath = path.join(
  repositoryRoot,
  'scripts/legacy-unrepresented-capture.vitest.config.mjs',
)
const generatorPath = path.join(
  repositoryRoot,
  'scripts/generate-legacy-unrepresented-callsite-replay.mjs',
)
const defaultOutput = path.join(
  repositoryRoot,
  'crates/fict-compiler/tests/legacy_unrepresented_callsite_replay.json',
)
const legacyRevision = 'b99ff5b185e3eed701e2d4f3521832dac67c979f'
const legacyCompilerSourceSha256 =
  'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a'
const legacyCompilerIndexSha256 = '4b8e5c1345538098acba95e00f4dee09d0e4f65feb7e3dd61cccb7bc3e98794f'
const legacyLockfileSha256 = '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6'
const expectedCounts = {
  legacyTestFiles: 107,
  selectedTestFiles: 29,
  selectedTestSuites: 147,
  selectedTests: 1917,
  capturedCompilerInvocations: 2327,
  staticCallsites: 214,
  executedCallsites: 212,
  zeroInvocationCallsites: 2,
  matchedCallsiteExecutions: 1444,
  replayFixtures: 1222,
  okToErrorTransitions: 3,
  errorToOkTransitions: 2,
}
const zeroInvocationReviews = new Map([
  [
    'packages/compiler/test/spec-advanced.test.ts:23:18:transform',
    {
      disposition: 'unused-helper-body',
      evidence:
        'transformWithWarnings is declared outside a test callback and is never called by the selected legacy suite.',
    },
  ],
  [
    'packages/compiler/test/transform.test.ts:807:18:transform',
    {
      disposition: 'babel-parser-rejection-before-plugin',
      evidence:
        'The legacy assertion expects Babel to reject `$state(1) = 2` as an invalid assignment target before the compiler Program visitor runs.',
    },
  ],
])
const transitionReviews = new Map([
  [
    'legacy-unrepresented-0c0dd70cc25cf882e0de',
    {
      policy: 'genuine-capability-expansion',
      releaseDisposition: 'allow',
      evidence:
        'The native acceptance oracle proves that the do-while accumulator reruns when its state dependency changes.',
      reviewReference: 'packages/compiler/test/control-flow-runtime.test.ts:4590:compileAndRunHook',
    },
  ],
  [
    'legacy-unrepresented-13c07ffbbeeb71e71bea',
    {
      policy: 'strict-reactivity-fail-closed',
      releaseDisposition: 'allow',
      evidence:
        'Strict guarantee mode intentionally rejects reactive try/catch lowering with FICT-R006 instead of silently accepting a fallback.',
      reviewReference:
        'packages/compiler/test/template-integration.test.ts:1318:compileAndLoad:strictGuarantee=true',
    },
  ],
  [
    'legacy-unrepresented-2fc407522ca3e0b64240',
    {
      policy: 'strict-reactivity-fail-closed',
      releaseDisposition: 'allow',
      evidence:
        'Strict guarantee mode intentionally rejects reactive try/catch branch lowering with FICT-R006 instead of silently accepting a fallback.',
      reviewReference:
        'packages/compiler/test/template-integration.test.ts:1359:compileAndLoad:strictGuarantee=true',
    },
  ],
  [
    'legacy-unrepresented-89ad8d469c7325eab972',
    {
      policy: 'structured-hook-return',
      releaseDisposition: 'allow',
      evidence:
        'Rust intentionally rejects writes through accessor-bearing structured hook returns with FICT-M.',
      reviewReference: 'packages/compiler/test/template-integration.test.ts:1161:compileAndLoad',
    },
  ],
  [
    'legacy-unrepresented-d6ea61baf1cd3c5034bf',
    {
      policy: 'intentional-runtime-error',
      releaseDisposition: 'allow',
      evidence:
        'The emitted eager self-reference preserves JavaScript TDZ behavior and intentionally throws at runtime.',
      reviewReference: 'packages/compiler/test/control-flow-runtime.test.ts:2959:compileAndRunHook',
    },
  ],
])

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments, received ${argv.slice(index).join(' ')}`)
    }
    options[name.slice(2)] = value
  }
  const unknown = Object.keys(options).filter(
    name => !['legacy-root', 'native-path', 'output'].includes(name),
  )
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!options['legacy-root']) throw new Error('--legacy-root is required')
  return {
    legacyRoot: path.resolve(options['legacy-root']),
    nativePath: path.resolve(
      options['native-path'] ?? path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
    ),
    output: path.resolve(options.output ?? defaultOutput),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sourceTreeSha256(root, files = null) {
  const selected = []
  if (files) {
    selected.push(...files.map(file => path.join(root, file)))
  } else {
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile()) selected.push(absolute)
      }
    }
    visit(root)
  }
  selected.sort()
  const hash = createHash('sha256')
  for (const file of selected) {
    hash.update(path.relative(root, file).split(path.sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function copyLegacyWorkspace(sourceRoot, destinationRoot) {
  cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = path.relative(sourceRoot, source)
      if (!relative) return true
      const parts = relative.split(path.sep)
      const rootNodeModules = parts[0] === 'node_modules'
      return !rootNodeModules && !parts.includes('.git') && !parts.includes('.DS_Store')
    },
  })
  symlinkSync(
    path.join(sourceRoot, 'node_modules'),
    path.join(destinationRoot, 'node_modules'),
    'dir',
  )
}

function runLegacySuite({ legacyRoot, selectedFiles, tempRoot }) {
  const capturePath = path.join(tempRoot, 'capture.jsonl')
  const reportPath = path.join(tempRoot, 'vitest-report.json')
  const vitest = path.join(legacyRoot, 'node_modules/.bin/vitest')
  assert.equal(existsSync(vitest), true, 'legacy Vitest installation is required')
  const result = spawnSync(
    vitest,
    [
      'run',
      '--config',
      captureConfigPath,
      '--reporter=json',
      '--outputFile',
      reportPath,
      ...selectedFiles.map(file => path.relative('packages/compiler', file)),
    ],
    {
      cwd: path.join(tempRoot, 'packages/compiler'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FICT_LEGACY_CAPTURE_ROOT: tempRoot,
        FICT_LEGACY_CAPTURE_PATH: capturePath,
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (existsSync(reportPath)) process.stderr.write(readFileSync(reportPath, 'utf8'))
    throw new Error(`legacy Vitest capture failed with status ${String(result.status)}`)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.testResults.length, expectedCounts.selectedTestFiles, 'legacy test files')
  assert.ok(
    report.testResults.every(result => result.status === 'passed'),
    'passing legacy files',
  )
  assert.equal(report.numTotalTestSuites, expectedCounts.selectedTestSuites, 'legacy test suites')
  assert.equal(
    report.numPassedTestSuites,
    expectedCounts.selectedTestSuites,
    'passing legacy suites',
  )
  assert.equal(report.numFailedTestSuites, 0, 'failed legacy suites')
  assert.equal(report.numTotalTests, expectedCounts.selectedTests, 'legacy tests')
  assert.equal(report.numPassedTests, expectedCounts.selectedTests, 'passing legacy tests')
  assert.equal(report.numFailedTests, 0, 'failed legacy tests')
  const entries = readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  return { entries, report }
}

function assembleInvocations(entries) {
  const invocations = new Map()
  for (const entry of entries) {
    assert.equal(typeof entry.invocationId, 'string', `${entry.kind}: invocation id`)
    if (entry.kind === 'enter') {
      assert.equal(invocations.has(entry.invocationId), false, 'duplicate compiler invocation')
      invocations.set(entry.invocationId, {
        ...entry,
        metadataEvents: [],
        warnings: [],
        outcome: null,
      })
      continue
    }
    const invocation = invocations.get(entry.invocationId)
    assert.ok(invocation, `${entry.kind}: enter event must be written first`)
    if (entry.kind === 'metadata') invocation.metadataEvents.push(entry)
    else if (entry.kind === 'warning') invocation.warnings.push(entry.warning)
    else if (entry.kind === 'outcome') {
      assert.equal(invocation.outcome, null, `${entry.invocationId}: duplicate outcome`)
      invocation.outcome = entry
    } else {
      throw new Error(`Unknown capture event: ${entry.kind}`)
    }
  }
  for (const invocation of invocations.values()) {
    if (!invocation.outcome) {
      invocation.outcome = {
        status: 'error',
        phase: 'after-enter',
        inferredFromMissingExit: true,
      }
    }
    assert.equal(typeof invocation.source, 'string', `${invocation.invocationId}: source`)
    assert.notEqual(invocation.source.trim(), '', `${invocation.invocationId}: empty source`)
    assert.equal(typeof invocation.stack, 'string', `${invocation.invocationId}: stack`)
  }
  return [...invocations.values()]
}

function nativeLanguage(filename) {
  const withoutSuffix = filename.split(/[?#]/, 1)[0]
  switch (path.extname(withoutSuffix).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js'
    case '.jsx':
      return 'jsx'
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts'
    case '.tsx':
      return 'tsx'
    default:
      return 'tsx'
  }
}

function stableBasename(filename) {
  const physical = filename.split(/[?#]/, 1)[0]
  const base = /^[A-Za-z]:[\\/]/.test(physical)
    ? path.win32.basename(physical)
    : path.posix.basename(physical.replaceAll('\\', '/'))
  const sanitized = base.replaceAll(/[^A-Za-z0-9._-]/g, '-')
  return sanitized && path.extname(sanitized) ? sanitized : `${sanitized || 'module'}.tsx`
}

function captureFunction(value) {
  return value?.__fictCaptureType === 'Function'
}

function captureMap(value) {
  return value?.__fictCaptureType === 'Map'
}

function hasAuthoritativeMetadataHost(options) {
  return captureMap(options.moduleMetadata) || captureFunction(options.resolveModuleMetadata)
}

function normalizeEphemeralFileUrls(value) {
  return value.replaceAll(
    /file:\/\/\/(?:(?:private\/)?var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T|tmp)\/([A-Za-z0-9._-]+)-[A-Za-z0-9]{6}\//g,
    'file:///fixtures/legacy-temp/$1/',
  )
}

function normalizeCompilerOptions(options) {
  const normalized = {}
  for (const key of [
    'dev',
    'sourcemap',
    'lazyConditional',
    'getterCache',
    'fineGrainedDom',
    'optimize',
    'optimizeLevel',
    'inlineDerivedMemos',
    'strictReactivity',
    'strictGuarantee',
    'warningsAsErrors',
    'warningLevels',
    'reactiveScopes',
  ]) {
    if (options[key] !== undefined) normalized[key] = options[key]
  }
  if (options.explain === true || captureFunction(options.explain)) normalized.explain = true
  if (
    options.resumable !== undefined ||
    options.autoExtractHandlers !== undefined ||
    options.autoExtractThreshold !== undefined
  ) {
    normalized.preview = {}
    if (options.resumable !== undefined) normalized.preview.resumable = options.resumable
    if (options.autoExtractHandlers !== undefined) {
      normalized.preview.autoExtractHandlers = options.autoExtractHandlers
    }
    if (options.autoExtractThreshold !== undefined) {
      normalized.preview.autoExtractThreshold = options.autoExtractThreshold
    }
  }
  return normalized
}

function missingMetadataInput(request) {
  return {
    request,
    resolvedId: null,
    status: 'missing',
    metadata: null,
    fingerprint: `missing:${sha256(request)}`,
  }
}

function resolvedMetadataInputs(invocation, filename, moduleRequests) {
  const inputs = new Map()
  const authoritative = hasAuthoritativeMetadataHost(invocation.options)
  for (const event of invocation.metadataEvents) {
    assert.equal(typeof event.request, 'string', 'legacy metadata request')
    const request = normalizeEphemeralFileUrls(event.request)
    let input
    if (event.resolved) {
      assert.ok(event.metadata && typeof event.metadata === 'object', 'resolved legacy metadata')
      const metadata = normalizeModuleMetadata(event.metadata)
      const fingerprint = sha256(canonicalJson(metadata))
      const identity = `${request}\0${fingerprint}`
      const resolvedId = `${path.posix.dirname(filename)}/__metadata__/${sha256(identity).slice(0, 16)}.ts`
      input = {
        request,
        resolvedId,
        status: 'resolved',
        metadata,
        fingerprint,
      }
    } else {
      if (!authoritative) continue
      input = missingMetadataInput(request)
    }
    const existing = inputs.get(request)
    if (existing) {
      assert.deepEqual(existing, input, `${invocation.invocationId}: metadata resolution changed`)
    } else {
      inputs.set(request, input)
    }
  }
  if (authoritative) {
    for (const moduleRequest of moduleRequests) {
      if (moduleRequest.typeOnly) continue
      const request = normalizeEphemeralFileUrls(moduleRequest.source)
      if (!inputs.has(request)) inputs.set(request, missingMetadataInput(request))
    }
  }
  return [...inputs.values()].sort((left, right) => left.request.localeCompare(right.request))
}

function normalizeHookReturnInfo(info) {
  const normalized = {}
  if (info.objectProps && typeof info.objectProps === 'object') {
    normalized.objectProps = info.objectProps
  }
  if (info.arrayProps && typeof info.arrayProps === 'object') {
    normalized.arrayProps = info.arrayProps
  }
  if (typeof info.directAccessor === 'string') normalized.directAccessor = info.directAccessor
  return normalized
}

function normalizeModuleMetadata(metadata) {
  const normalized = {
    version: metadata.version ?? 1,
    exports: metadata.exports ?? {},
  }
  if (metadata.hooks && typeof metadata.hooks === 'object') {
    normalized.hooks = Object.fromEntries(
      Object.entries(metadata.hooks).map(([name, info]) => [name, normalizeHookReturnInfo(info)]),
    )
  }
  if (metadata.namespaces && typeof metadata.namespaces === 'object') {
    normalized.namespaces = Object.fromEntries(
      Object.entries(metadata.namespaces).map(([name, namespace]) => [
        name,
        normalizeModuleMetadata(namespace),
      ]),
    )
  }
  return normalized
}

function buildRequest(invocation, binding) {
  const originalFilename = invocation.filename ?? 'module.tsx'
  const basename = stableBasename(originalFilename)
  const source = normalizeEphemeralFileUrls(invocation.source)
  const sourceIdentity = sha256(`${source}\0${basename}`).slice(0, 16)
  const filename = `/fixtures/legacy-unrepresented/${sourceIdentity}/${basename}`
  const commonjs =
    invocation.stack.includes('transformCommonJS (') ||
    invocation.stack.includes('compilePresetModule (')
  const language = nativeLanguage(basename)
  const moduleKind = commonjs ? 'commonjs' : 'module'
  const request = {
    protocolVersion: 1,
    code: source,
    filename,
    language,
    moduleKind,
    options: normalizeCompilerOptions(invocation.options),
  }
  let moduleRequests = []
  if (hasAuthoritativeMetadataHost(invocation.options)) {
    const scan = binding.scanSync({
      protocolVersion: 1,
      code: source,
      filename,
      language,
      moduleKind,
    })
    assert.ok(
      scan.diagnostics.every(diagnostic => diagnostic.severity !== 'error'),
      `${invocation.invocationId}: native static module scan failed`,
    )
    moduleRequests = scan.moduleRequests
  }
  const metadata = resolvedMetadataInputs(invocation, filename, moduleRequests)
  if (metadata.length > 0) request.metadata = metadata
  const integrationDiagnostics = invocation.options.integrationDiagnostics
  assert.ok(
    integrationDiagnostics === undefined || integrationDiagnostics.length === 0,
    `${invocation.invocationId}: integration diagnostics need an explicit native mapping`,
  )
  return request
}

function deterministicResult(result) {
  return {
    protocolVersion: result.protocolVersion,
    code: result.code,
    map: result.map,
    diagnostics: result.diagnostics,
    moduleMetadata: result.moduleMetadata,
    metadataDependencies: result.metadataDependencies,
    unresolvedMetadataRequests: result.unresolvedMetadataRequests,
    metadataIncomplete: result.metadataIncomplete,
    explain: result.explain,
    artifacts: result.artifacts,
  }
}

function resultStatus(result) {
  return result.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 'error' : 'ok'
}

function expectedDiagnostics(result) {
  return result.diagnostics.map(({ code, severity, guaranteeClass }) => ({
    code,
    severity,
    guaranteeClass,
  }))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const options = parseArguments(process.argv.slice(2))
const inventoryText = readFileSync(inventoryPath, 'utf8')
const inventory = JSON.parse(inventoryText)
const rustCodegenCorpusText = readFileSync(rustCodegenCorpusPath, 'utf8')
const rustCodegenCorpus = JSON.parse(rustCodegenCorpusText)
assert.equal(rustCodegenCorpus.schemaVersion, 5)
assert.equal(rustCodegenCorpus.provenance.sourceSuiteRelease, '0.28.0')
assert.equal(rustCodegenCorpus.provenance.sourceSuiteRevision, legacyRevision)
const rustDeviationPolicies = new Map(
  rustCodegenCorpus.fixtures
    .filter(fixture => fixture.deviationPolicy)
    .map(fixture => [fixture.id, fixture.deviationPolicy]),
)
for (const review of transitionReviews.values()) {
  assert.equal(
    rustDeviationPolicies.get(review.reviewReference),
    review.policy,
    `${review.reviewReference}: frozen Rust deviation policy`,
  )
}
assert.equal(inventory.schemaVersion, 1)
assert.equal(inventory.baseline.release, '0.28.0')
assert.equal(inventory.baseline.revision, legacyRevision)
assert.equal(inventory.summary.legacyTestFiles, expectedCounts.legacyTestFiles)
assert.equal(inventory.summary.unrepresentedCompilerCallsites, expectedCounts.staticCallsites)
assert.equal(inventory.unrepresentedCompilerCallsites.length, expectedCounts.staticCallsites)
assert.equal(
  new Set(inventory.unrepresentedCompilerCallsites.map(callsite => callsite.id)).size,
  expectedCounts.staticCallsites,
  'duplicate unrepresented callsite id',
)

const legacyCompilerRoot = path.join(options.legacyRoot, 'packages/compiler')
const legacyCompilerSource = path.join(legacyCompilerRoot, 'src')
assert.equal(statSync(legacyCompilerSource).isDirectory(), true, 'missing legacy compiler source')
assert.equal(
  sourceTreeSha256(legacyCompilerSource),
  legacyCompilerSourceSha256,
  'legacy compiler source digest',
)
assert.equal(
  sha256(readFileSync(path.join(legacyCompilerSource, 'index.ts'))),
  legacyCompilerIndexSha256,
  'legacy compiler entry digest',
)
assert.equal(
  sha256(readFileSync(path.join(options.legacyRoot, 'pnpm-lock.yaml'))),
  legacyLockfileSha256,
  'legacy lockfile digest',
)
const legacyTestFiles = inventory.files.map(file => file.file)
assert.equal(
  sourceTreeSha256(options.legacyRoot, legacyTestFiles),
  inventory.baseline.legacyTestSourceSha256,
  'legacy test source digest',
)

const selectedFiles = [
  ...new Set(inventory.unrepresentedCompilerCallsites.map(callsite => callsite.file)),
].sort()
assert.equal(selectedFiles.length, expectedCounts.selectedTestFiles)
const tempParent = mkdtempSync(path.join(realpathSync(tmpdir()), 'fict-legacy-unrepresented-'))
const tempLegacyRoot = path.join(tempParent, 'fict-0.28.0')
let capture
try {
  copyLegacyWorkspace(options.legacyRoot, tempLegacyRoot)
  capture = runLegacySuite({
    legacyRoot: options.legacyRoot,
    selectedFiles,
    tempRoot: tempLegacyRoot,
  })
} finally {
  rmSync(tempParent, { recursive: true, force: true })
}

const invocations = assembleInvocations(capture.entries)
assert.equal(
  invocations.length,
  expectedCounts.capturedCompilerInvocations,
  'captured compiler invocations',
)
const callsiteInvocations = new Map(
  inventory.unrepresentedCompilerCallsites.map(callsite => [callsite.id, []]),
)
const tempRootPattern = escapeRegExp(tempLegacyRoot.split(path.sep).join('/'))
for (const invocation of invocations) {
  const normalizedStack = invocation.stack.replaceAll('\\', '/')
  for (const callsite of inventory.unrepresentedCompilerCallsites) {
    const frame = new RegExp(
      `${tempRootPattern}/${escapeRegExp(callsite.file)}:${callsite.line}:${callsite.column}(?:\\D|$)`,
    )
    if (frame.test(normalizedStack)) callsiteInvocations.get(callsite.id).push(invocation)
  }
}

const zeroInvocationCallsites = inventory.unrepresentedCompilerCallsites.filter(
  callsite => callsiteInvocations.get(callsite.id).length === 0,
)
assert.equal(zeroInvocationCallsites.length, expectedCounts.zeroInvocationCallsites)
assert.deepEqual(
  zeroInvocationCallsites.map(callsite => callsite.id).sort(),
  [...zeroInvocationReviews.keys()].sort(),
  'zero-invocation review drift',
)
const executedCallsites = inventory.unrepresentedCompilerCallsites.filter(
  callsite => callsiteInvocations.get(callsite.id).length > 0,
)
assert.equal(executedCallsites.length, expectedCounts.executedCallsites)
const matchedCallsiteExecutions = executedCallsites.reduce(
  (count, callsite) => count + callsiteInvocations.get(callsite.id).length,
  0,
)
assert.equal(
  matchedCallsiteExecutions,
  expectedCounts.matchedCallsiteExecutions,
  'matched callsite executions',
)

const binding = require(options.nativePath)
const compilerInfo = binding.nativeCompilerInfo()
const fixturesByIdentity = new Map()
const callsites = inventory.unrepresentedCompilerCallsites.map(callsite => {
  const matched = callsiteInvocations.get(callsite.id)
  if (matched.length === 0) {
    return {
      id: callsite.id,
      file: callsite.file,
      line: callsite.line,
      column: callsite.column,
      callee: callsite.callee,
      runtimeInvocations: 0,
      zeroInvocationReview: zeroInvocationReviews.get(callsite.id),
      variants: [],
    }
  }
  const variants = new Map()
  for (const invocation of matched) {
    const request = buildRequest(invocation, binding)
    const legacy = {
      status: invocation.outcome.status,
      warningCodes: invocation.warnings.map(warning => warning.code),
    }
    const identity = canonicalJson({ request, legacy })
    let fixture = fixturesByIdentity.get(identity)
    if (!fixture) {
      const id = `legacy-unrepresented-${sha256(identity).slice(0, 20)}`
      fixture = { id, request, legacy, origins: new Set() }
      fixturesByIdentity.set(identity, fixture)
    }
    fixture.origins.add(callsite.id)
    variants.set(fixture.id, (variants.get(fixture.id) ?? 0) + 1)
  }
  return {
    id: callsite.id,
    file: callsite.file,
    line: callsite.line,
    column: callsite.column,
    callee: callsite.callee,
    runtimeInvocations: matched.length,
    zeroInvocationReview: null,
    variants: [...variants]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fixtureId, executions]) => ({ fixtureId, executions })),
  }
})

const fixtures = [...fixturesByIdentity.values()]
  .sort((left, right) => left.id.localeCompare(right.id))
  .map(fixture => {
    const first = binding.transformSync(fixture.request)
    const second = binding.transformSync(fixture.request)
    assert.equal(
      canonicalJson(deterministicResult(second)),
      canonicalJson(deterministicResult(first)),
      `${fixture.id}: nondeterministic Rust result`,
    )
    const rustStatus = resultStatus(first)
    const statusTransition =
      fixture.legacy.status === rustStatus ? null : `${fixture.legacy.status}-to-${rustStatus}`
    return {
      id: fixture.id,
      origins: [...fixture.origins].sort(),
      request: fixture.request,
      legacy: fixture.legacy,
      expected: {
        status: rustStatus,
        diagnostics: expectedDiagnostics(first),
        codeSha256: sha256(first.code),
        deterministicResultSha256: sha256(canonicalJson(deterministicResult(first))),
      },
      statusTransition,
      transitionPolicy: statusTransition ? (transitionReviews.get(fixture.id) ?? null) : null,
    }
  })

assert.equal(fixtures.length, expectedCounts.replayFixtures, 'replay fixture count')
assert.equal(
  new Set(fixtures.map(fixture => fixture.id)).size,
  fixtures.length,
  'fixture id collision',
)
const fixtureIds = new Set(fixtures.map(fixture => fixture.id))
assert.ok(
  callsites.every(callsite =>
    callsite.variants.every(variant => fixtureIds.has(variant.fixtureId)),
  ),
  'callsite references unknown replay fixture',
)
const transitionedFixtureIds = fixtures
  .filter(fixture => fixture.statusTransition)
  .map(fixture => fixture.id)
  .sort()
assert.deepEqual(
  transitionedFixtureIds,
  [...transitionReviews.keys()].sort(),
  'status transition review drift',
)
assert.ok(
  fixtures.every(fixture =>
    fixture.statusTransition
      ? fixture.transitionPolicy?.releaseDisposition === 'allow'
      : fixture.transitionPolicy === null,
  ),
  'every and only status transitions must carry an allowing policy review',
)
const transitionCounts = Object.fromEntries(
  ['ok-to-error', 'error-to-ok'].map(transition => [
    transition,
    fixtures.filter(fixture => fixture.statusTransition === transition).length,
  ]),
)
assert.deepEqual(
  transitionCounts,
  {
    'ok-to-error': expectedCounts.okToErrorTransitions,
    'error-to-ok': expectedCounts.errorToOkTransitions,
  },
  'status transition counts',
)
const reviewedRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).stdout.trim()
const artifact = {
  schemaVersion: 1,
  claimBoundary: {
    unit: 'runtime-compiler-invocation-associated-with-static-callsite',
    legacyAssertionsExecuted: true,
    legacyGeneratedOutputCompared: false,
    semanticAssertionParityProven: false,
    hostCallbacksCrossNativeBoundary: false,
    ephemeralFileUrlsNormalized: true,
    statusTransitionsPolicyReviewed: true,
    description:
      'The selected legacy tests execute unchanged while an in-memory probe records compiler invocations. Serializable compiler policy and consumed metadata are replayed through Rust; callback and filesystem behavior remain covered by dedicated host oracles. Random temporary file URL roots are normalized to a declared fixture namespace before request identity is computed. When a captured Map or resolver function makes the legacy graph host authoritative, unresolved static requests are replayed with explicit missing metadata snapshots.',
  },
  provenance: {
    sourceSuiteRelease: '0.28.0',
    sourceSuiteRevision: legacyRevision,
    legacyCompilerSourceSha256,
    legacyCompilerIndexSha256,
    legacyLockfileSha256,
    legacyTestSourceSha256: inventory.baseline.legacyTestSourceSha256,
    assertionInventorySha256: sha256(inventoryText),
    rustCodegenCorpusSha256: sha256(rustCodegenCorpusText),
    generatorSha256: sha256(readFileSync(generatorPath)),
    captureConfigSha256: sha256(readFileSync(captureConfigPath)),
    selectedTestFiles: selectedFiles.length,
    selectedTests: capture.report.numTotalTests,
    capturedCompilerInvocations: invocations.length,
    staticCallsites: inventory.unrepresentedCompilerCallsites.length,
    executedCallsites: executedCallsites.length,
    zeroInvocationCallsites: zeroInvocationCallsites.length,
    matchedCallsiteExecutions,
    replayFixtures: fixtures.length,
    reviewedRevision,
    reviewedCompilerBuildId: compilerInfo.compilerBuildId,
  },
  transitionCounts,
  selectedFiles,
  callsites,
  fixtures,
}

writeFileSync(
  options.output,
  await format(JSON.stringify(artifact, null, 2), {
    ...(await resolveConfig(defaultOutput)),
    filepath: defaultOutput,
    parser: 'json',
  }),
)
process.stdout.write(
  `${JSON.stringify({
    output: options.output,
    callsites: callsites.length,
    matchedCallsiteExecutions,
    replayFixtures: fixtures.length,
    transitionCounts,
  })}\n`,
)
