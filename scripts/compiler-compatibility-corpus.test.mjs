import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const readJson = relative => JSON.parse(read(relative))
const sha256Pattern = /^[0-9a-f]{64}$/
const revisionPattern = /^[0-9a-f]{40}$/
const compileCorpusPath = 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'
const sha256 = value => createHash('sha256').update(value).digest('hex')

test('retains the Rust-only frozen codegen corpus and reviewed Babel audit deviations', () => {
  const corpus = readJson(compileCorpusPath)
  assert.equal(corpus.schemaVersion, 2)
  assert.deepEqual(
    {
      sourceSuiteRelease: corpus.provenance.sourceSuiteRelease,
      sourceSuiteRevision: corpus.provenance.sourceSuiteRevision,
      babelAuditRelease: corpus.provenance.babelAuditRelease,
      babelAuditRevision: corpus.provenance.babelAuditRevision,
      rustAuditRelease: corpus.provenance.rustAuditRelease,
      rustAuditRevision: corpus.provenance.rustAuditRevision,
      auditInputSha256: corpus.provenance.auditInputSha256,
      extractedCalls: corpus.provenance.extractedCalls,
      uniqueFixtures: corpus.provenance.uniqueFixtures,
      scannedLegacyTestFiles: corpus.provenance.scannedLegacyTestFiles,
      representedLegacyTestFiles: corpus.provenance.representedLegacyTestFiles,
    },
    {
      sourceSuiteRelease: '0.28.0',
      sourceSuiteRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
      babelAuditRelease: '0.30.1',
      babelAuditRevision: '8d4008929d46fc5f2c1e578423ff38ef95a5d084',
      rustAuditRelease: '0.30.1',
      rustAuditRevision: '8d4008929d46fc5f2c1e578423ff38ef95a5d084',
      auditInputSha256: '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f',
      extractedCalls: 1974,
      uniqueFixtures: 1892,
      scannedLegacyTestFiles: 107,
      representedLegacyTestFiles: 73,
    },
  )
  assert.match(corpus.provenance.reviewedRevision, revisionPattern)
  assert.match(
    corpus.provenance.reviewedCompilerBuildId,
    /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/,
  )
  assert.equal(corpus.fixtures.length, 1892)

  const ids = new Set()
  const inputs = new Set()
  const representedFiles = new Set()
  const policyCounts = Object.fromEntries(
    Object.keys(corpus.deviationPolicies).map(policy => [policy, 0]),
  )
  for (const fixture of corpus.fixtures) {
    assert.equal(
      fixture.id,
      `${fixture.origin.file}:${fixture.origin.line}:${fixture.origin.callee}`,
    )
    assert.equal(ids.has(fixture.id), false, fixture.id)
    ids.add(fixture.id)
    assert.match(fixture.origin.file, /^packages\/compiler\/test\/.*\.test\.ts$/)
    representedFiles.add(fixture.origin.file)
    const input = JSON.stringify([fixture.source, fixture.options])
    assert.equal(inputs.has(input), false, fixture.id)
    inputs.add(input)
    assert.ok(fixture.source.trim(), fixture.id)
    assert.ok(['ok', 'error'].includes(fixture.babelAudit.status), fixture.id)
    assert.ok(['ok', 'error'].includes(fixture.expected.status), fixture.id)
    assert.ok(
      fixture.babelAudit.diagnosticCodes.every(code => /^FICT-[A-Z0-9-]+$/.test(code)),
      fixture.id,
    )
    if (fixture.babelAudit.codeSha256 !== null) {
      assert.match(fixture.babelAudit.codeSha256, sha256Pattern, fixture.id)
    }
    assert.match(fixture.expected.codeSha256, sha256Pattern, fixture.id)
    assert.ok(
      fixture.expected.diagnostics.every(
        diagnostic =>
          /^FICT-[A-Z0-9-]+$/.test(diagnostic.code) &&
          ['error', 'warning', 'info'].includes(diagnostic.severity) &&
          ['notApplicable', 'advisory', 'fallback', 'unsupported', 'internal'].includes(
            diagnostic.guaranteeClass,
          ),
      ),
      fixture.id,
    )
    assert.equal(
      fixture.expected.status,
      fixture.expected.diagnostics.some(diagnostic => diagnostic.severity === 'error')
        ? 'error'
        : 'ok',
      fixture.id,
    )
    const statusChanged = fixture.babelAudit.status !== fixture.expected.status
    assert.equal(fixture.deviationPolicy !== null, statusChanged, fixture.id)
    if (fixture.deviationPolicy !== null) {
      assert.ok(corpus.deviationPolicies[fixture.deviationPolicy], fixture.id)
      policyCounts[fixture.deviationPolicy]++
    }
  }

  assert.equal(ids.size, 1892)
  assert.equal(inputs.size, 1892)
  assert.equal(representedFiles.size, 73)
  assert.deepEqual(policyCounts, corpus.deviationPolicyCounts)
  assert.deepEqual(corpus.deviationPolicyCounts, {
    'rust-capability-expansion': 22,
    'narrow-component-role': 24,
    'structured-hook-return': 6,
    'namespace-macro-fail-closed': 1,
  })
})

test('retains normalized frontend and analysis compatibility oracles', () => {
  const frontend = readJson('crates/fict-compiler-oxc/tests/frontend_compatibility.json')
  const analysis = readJson('crates/fict-compiler/tests/analysis_compatibility.json')
  assert.equal(frontend.length, 13)
  assert.equal(frontend.filter(fixture => fixture.accepted).length, 6)
  assert.equal(frontend.filter(fixture => !fixture.accepted).length, 7)
  assert.ok(
    frontend
      .filter(fixture => !fixture.accepted)
      .every(fixture => fixture.legacyMessage && /^FICT-/.test(fixture.rustCode)),
  )
  assert.equal(analysis.length, 7)
  assert.deepEqual(
    analysis
      .filter(fixture => fixture.deviationPolicy)
      .map(fixture => [fixture.name, fixture.deviationPolicy]),
    [['closed object shape and property mutation', 'narrow-component-role']],
  )
  assert.ok(analysis.every(fixture => fixture.expected))

  const frontendTest = read('crates/fict-compiler-oxc/tests/frontend_compatibility.rs')
  const analysisTest = read('crates/fict-compiler/tests/analysis_compatibility.rs')
  const compileTest = read('crates/fict-compiler/tests/rust_codegen_corpus.rs')
  assert.match(frontendTest, /include_str!\("frontend_compatibility\.json"\)/)
  assert.match(analysisTest, /include_str!\("analysis_compatibility\.json"\)/)
  assert.match(compileTest, /include_str!\(\s*"rust_frozen_codegen_corpus\.json"\s*\)/)
  assert.match(compileTest, /frozen_rust_codegen_corpus/)
})

test('retains the independently generated Babel 0.28 semantic oracle', () => {
  const inputsText = read('scripts/fixtures/babel_0_28_semantic_inputs.json')
  const inputs = JSON.parse(inputsText)
  const oracle = readJson('crates/fict-compiler/tests/babel_0_28_semantic_oracle.json')
  assert.equal(inputs.schemaVersion, 1)
  assert.equal(oracle.schemaVersion, 1)
  assert.deepEqual(
    {
      legacyRelease: oracle.provenance.legacyRelease,
      legacyRevision: oracle.provenance.legacyRevision,
      legacyCompilerSourceSha256: oracle.provenance.legacyCompilerSourceSha256,
      legacyCompilerArtifactSha256: oracle.provenance.legacyCompilerArtifactSha256,
      legacyLockfileSha256: oracle.provenance.legacyLockfileSha256,
      legacyPackageManager: oracle.provenance.legacyPackageManager,
      oracleInputsSha256: oracle.provenance.oracleInputsSha256,
    },
    {
      legacyRelease: '0.28.0',
      legacyRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
      legacyCompilerSourceSha256:
        'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a',
      legacyCompilerArtifactSha256:
        '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789',
      legacyLockfileSha256: '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6',
      legacyPackageManager: 'pnpm@9.1.1',
      oracleInputsSha256: sha256(inputsText),
    },
  )
  assert.equal(inputs.fixtures.length, 12)
  assert.equal(oracle.fixtures.length, 12)
  assert.deepEqual(
    oracle.fixtures.map(fixture => fixture.id),
    inputs.fixtures.map(fixture => fixture.id),
  )
  for (const fixture of oracle.fixtures) {
    assert.match(fixture.babelCodeSha256, sha256Pattern, fixture.id)
    assert.equal(sha256(fixture.babelCode), fixture.babelCodeSha256, fixture.id)
    assert.ok(fixture.babelCode.includes('exports.Scenario'), fixture.id)
    assert.ok(fixture.expected !== undefined, fixture.id)
  }

  const semanticTest = read('scripts/babel-compiler-semantic-oracle.test.mjs')
  assert.match(semanticTest, /executeCommonJs\(expected\.babelCode/)
  assert.match(semanticTest, /executeCommonJs\(result\.code/)
  assert.match(semanticTest, /binding\.transformSync\(fixture\.request\)/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:babel-semantic-oracle/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /babel-compiler-semantic-oracle\.test\.mjs/)
})

test('retains full request dimensions with an exact Babel preset oracle', () => {
  const inputsText = read('scripts/fixtures/compiler_request_matrix.json')
  const inputs = JSON.parse(inputsText)
  const oracle = readJson('crates/fict-compiler/tests/babel_0_28_request_oracle.json')
  assert.equal(inputs.schemaVersion, 1)
  assert.equal(oracle.schemaVersion, 1)
  assert.equal(inputs.cases.length, 27)
  assert.equal(oracle.fixtures.length, 17)
  assert.equal(oracle.provenance.legacyRelease, '0.28.0')
  assert.equal(oracle.provenance.legacyRevision, 'b99ff5b185e3eed701e2d4f3521832dac67c979f')
  for (const field of [
    'compilerSourceSha256',
    'compilerArtifactSha256',
    'presetSourceSha256',
    'presetArtifactSha256',
    'lockfileSha256',
    'requestInputsSha256',
  ]) {
    assert.match(oracle.provenance[field], sha256Pattern, field)
  }
  assert.equal(oracle.provenance.requestInputsSha256, sha256(inputsText))
  assert.deepEqual(
    oracle.fixtures.map(fixture => fixture.id),
    inputs.cases.filter(fixture => fixture.legacy).map(fixture => fixture.id),
  )

  const inferredExtensions = inputs.cases
    .filter(fixture => fixture.id.startsWith('infer-'))
    .map(fixture => path.extname(fixture.request.filename.split(/[?#]/, 1)[0]))
    .sort()
  assert.deepEqual(inferredExtensions, [
    '.cjs',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.ts',
    '.tsx',
  ])
  assert.ok(inputs.cases.some(fixture => fixture.request.options === undefined))
  for (const field of [
    'language',
    'moduleKind',
    'inputSourceMap',
    'moduleId',
    'publicModuleId',
    'metadata',
  ]) {
    assert.ok(
      inputs.cases.some(fixture => fixture.request[field] !== undefined),
      field,
    )
  }
  assert.ok(inputs.cases.some(fixture => fixture.request.options?.explain === true))
  assert.deepEqual(
    Object.fromEntries(
      Array.from(new Set(inputs.cases.map(fixture => fixture.compatibilityPolicy)))
        .sort()
        .map(policy => [
          policy,
          inputs.cases.filter(fixture => fixture.compatibilityPolicy === policy).length,
        ]),
    ),
    {
      'explain-normalization': 1,
      'feature-parity': 9,
      'jsx-extension-required': 1,
      'native-host-protocol': 10,
      'rust-capability-expansion': 1,
      'source-map-normalization': 1,
      'strict-policy-parity': 2,
      'syntax-rejection-parity': 2,
    },
  )

  const runtimeTest = read('scripts/native-compiler-request-matrix.test.mjs')
  assert.match(runtimeTest, /binding\.transformSync\(fixture\.request\)/)
  assert.match(runtimeTest, /normalizedSource\(first\.map\)/)
  const generator = read('scripts/generate-babel-request-oracle.mjs')
  assert.match(generator, /packages\/babel-preset/)
  assert.match(generator, /presetArtifactSha256/)
  assert.match(generator, /'reactiveScopes'/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:request-matrix/)
  assert.match(packageJson, /native-compiler-request-matrix\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-request-matrix\.test\.mjs/)
})

test('ports the unrepresented Babel auto-extraction domain through the native Preview pipeline', () => {
  const runtime = read('scripts/native-compiler-auto-extract.test.mjs')
  for (const behavior of [
    'auto-extraction opt-out',
    'stable bare handler bindings',
    'mutated function-local handler identifiers',
    'external, asynchronous, and threshold-complex handlers',
    'simple handlers below the threshold',
    'selected handler cannot be restored',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /result\.artifacts\.length, 1/)
  assert.match(runtime, /result\.artifacts, \[\]/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:auto-extract/)
  assert.match(packageJson, /native-compiler-auto-extract\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-auto-extract\.test\.mjs/)
})

test('ports the unrepresented Babel expression-dependency domain through Preview artifacts', () => {
  const runtime = read('scripts/native-compiler-expression-deps.test.mjs')
  for (const behavior of [
    'optional member chains restore the base',
    'every supported expression family',
    'yield expressions restore their argument',
    'computed members restore both the object and key',
    'block-bodied function closures include branch, phi-source, and return dependencies',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /__scopeProps/)
  assert.match(runtime, /__fictUseLexicalScope/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:expression-deps/)
  assert.match(packageJson, /native-compiler-expression-deps\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-expression-deps\.test\.mjs/)
})

test('ports the unrepresented Babel reactive-accessor domain through executable output', () => {
  const runtime = read('scripts/native-compiler-reactive-accessors.test.mjs')
  for (const behavior of [
    'object and array function entries remain lazy while eager entries run at creation',
    'IIFEs do not pull returned function bodies across the lazy boundary',
    'class definitions track eager dependencies but exclude method and instance bodies',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /executeCommonJs/)
  assert.match(runtime, /instance-field/)
  assert.match(runtime, /object-iife/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:reactive-accessors/)
  assert.match(packageJson, /native-compiler-reactive-accessors\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-reactive-accessors\.test\.mjs/)
})

test('ports the unrepresented Babel optimizer differential domain through executable output', () => {
  const runtime = read('scripts/native-compiler-optimizer-diff.test.mjs')
  for (const behavior of [
    'optimization on/off and safe/full profiles preserve observable semantics',
    'disabled-safe',
    'enabled-safe',
    'enabled-full',
    'disabled-full',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /executeCommonJs/)
  assert.match(runtime, /observedDifferentCode/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:optimizer-diff/)
  assert.match(packageJson, /native-compiler-optimizer-diff\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-optimizer-diff\.test\.mjs/)
})

test('maps the Babel delegated-event parity domain to the generated runtime ABI guard', () => {
  const parity = read('packages/runtime/test/delegated-events-parity.test.ts')
  assert.match(parity, /runtime-abi\.json/)
  assert.match(parity, /DelegatedEvents as RuntimeDelegatedEvents/)
  assert.match(parity, /expect\(runtimeEvents\)\.toEqual\(compilerEvents\)/)
  assert.match(parity, /both sets contain the expected core events/)

  const generator = read('scripts/generate-runtime-abi.mjs')
  assert.match(generator, /DELEGATED_EVENTS/)
  assert.match(generator, /delegatedEvents must be a unique canonical event-name array/)
  const packageJson = read('package.json')
  assert.match(packageJson, /guardrails:runtime-abi[^\n]+delegated-events-parity\.test\.ts/)
})

test('ports the Babel runtime ABI domain to live generated-manifest exports', () => {
  const runtimeAbi = read('packages/runtime/test/runtime-abi.test.ts')
  for (const behavior of [
    'exports every manifest helper from its declared runtime subpath',
    'exports callable compiler helpers with the declared value shape',
    'keeps signal, memo, and effect helper contracts usable',
  ]) {
    assert.match(runtimeAbi, new RegExp(behavior))
  }
  assert.match(runtimeAbi, /runtime-abi\.json/)
  assert.match(runtimeAbi, /Object\.prototype\.hasOwnProperty\.call/)
  assert.match(runtimeAbi, /__resetReactiveState/)
  const packageJson = read('package.json')
  assert.match(packageJson, /guardrails:runtime-abi[^\n]+test\/runtime-abi\.test\.ts/)
  const testConfig = read('packages/runtime/tsconfig.test.json')
  assert.match(testConfig, /test\/runtime-abi\.test\.ts/)
})

test('ports the Babel module-metadata safety domain to the native graph host', () => {
  const safety = read('packages/compiler/test/module-metadata-safety.test.ts')
  for (const behavior of [
    'fails closed for malformed, non-canonical, unknown, and over-deep schemas',
    'preserves reserved names as own data without prototype pollution',
    'rejects relative escapes, absolute paths, file URLs, /@fs paths, and NULs',
    'rejects metadata symlinks that leave the declared package root',
    'ignores invalid package payloads and observes a valid replacement immediately',
    'normalizes package suffixes but gives exact suffix declarations precedence',
    'does not cache package misses or stale metadata assets',
    'never probes source-adjacent or cwd metadata for undeclared imports',
  ]) {
    assert.match(safety, new RegExp(behavior))
  }
  assert.match(safety, /resolvePackageModuleMetadata/)
  assert.match(safety, /parseModuleReactiveMetadata/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:metadata-safety/)
  assert.match(packageJson, /module-metadata-safety\.test\.ts/)
})

test('ports the Babel state-machine collision domain to structured native control flow', () => {
  const runtime = read('scripts/native-compiler-state-machine-name-collision.test.mjs')
  for (const behavior of [
    'legacy state-machine collision scenarios stay structured and preserve authored bindings',
    'current context helper allocation avoids authored parameter collisions',
    'logical reactive updates do not capture user locals or parameters',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /executeCommonJs/)
  assert.match(runtime, /__fict_previous_1_/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:state-machine-name-collision/)
  assert.match(packageJson, /native-compiler-state-machine-name-collision\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-state-machine-name-collision\.test\.mjs/)
})

test('ports the Babel template extractor domain through serialized and live DOM paths', () => {
  const runtime = read('scripts/native-compiler-runtime.test.mjs')
  assert.match(runtime, /native template extraction preserves static HTML and live binding paths/)
  assert.match(runtime, /const __fict_tmpl\\d\+ = template/)
  assert.match(runtime, /resolvePath/)
  assert.match(runtime, /data-case="dynamic-attr"/)
  assert.match(runtime, /Text Grace Static/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:native-runtime[^\n]+native-compiler-runtime\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-runtime\.test\.mjs/)
})

test('maps the Babel release strict-scope domain to the explicit release gate', () => {
  const strictScope = read('packages/compiler/test/release-strict-scope.test.ts')
  for (const behavior of [
    'owns strict compiler gates in explicit root scripts',
    'keeps behavior-first test entrypoints outside strict mode',
    'composes release verification from scoped strict gates',
    'keeps workflow-level release and CI scope aligned with root scripts',
  ]) {
    assert.match(strictScope, new RegExp(behavior))
  }
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:release-strict-scope/)
  assert.match(packageJson, /vitest run test\/release-strict-scope\.test\.ts/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /pnpm test:compiler:release-strict-scope/)
})

test('ports the Babel VNode prop-order domain through executable native output', () => {
  const runtime = read('scripts/native-compiler-vnode-props-order.test.mjs')
  for (const behavior of [
    'later spreads override earlier explicit props',
    'later explicit props override earlier spreads',
    'multiple spreads and explicit props retain authored precedence',
    'explicit JSX children override spread children',
    'use no memo functions preserve prop precedence',
  ]) {
    assert.match(runtime, new RegExp(behavior))
  }
  assert.match(runtime, /executeCommonJs/)
  assert.match(runtime, /fineGrainedDom: false/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:vnode-props-order/)
  assert.match(packageJson, /native-compiler-vnode-props-order\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-vnode-props-order\.test\.mjs/)
})

test('binds native cache identity to the complete Rust build input set', () => {
  const runtime = read('scripts/native-compiler-build-id.test.mjs')
  for (const marker of [
    'fict-compiler-build-id-v1',
    'rust-toolchain.toml',
    "entry.name.startsWith('fict-')",
    'compilerBuildRevision',
    'simulated source change',
  ]) {
    assert.match(runtime, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(runtime, /assert\.equal\(info\.compilerBuildId/)
  assert.match(runtime, /assert\.notEqual\(changed, baseline\)/)
  const packageJson = read('package.json')
  assert.match(packageJson, /test:compiler:build-id/)
  assert.match(packageJson, /native-compiler-build-id\.test\.mjs/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /native-compiler-build-id\.test\.mjs/)
})

test('documents every reviewed Babel status and request-identity deviation', () => {
  const corpus = readJson(compileCorpusPath)
  const migrationGuide = read('docs/migration-guide.md')
  for (const [policy, count] of Object.entries(corpus.deviationPolicyCounts)) {
    const row = migrationGuide.split('\n').find(line => line.includes(`\`${policy}\``))
    assert.ok(row, `${policy} migration row`)
    assert.match(row, new RegExp(`\\|\\s+${count}\\s+\\|`), `${policy} migration count`)
  }
  for (const policy of [
    'jsx-extension-required',
    'cts-top-level-return',
    'source-map-normalization',
    'explain-normalization',
  ]) {
    assert.ok(migrationGuide.includes('`' + policy + '`'), policy)
  }
  for (const option of [
    'dev: true',
    'lazyConditional: false',
    'getterCache: false',
    'optimizeLevel: "full"',
    'inlineDerivedMemos: false',
  ]) {
    assert.match(migrationGuide, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const statusDifferenceCount = Object.values(corpus.deviationPolicyCounts).reduce(
    (sum, count) => sum + count,
    0,
  )
  const rustRejectionCount =
    statusDifferenceCount - corpus.deviationPolicyCounts['rust-capability-expansion']
  assert.match(migrationGuide, /37 option-driven Babel-success\/Rust-fail/)
  assert.match(
    migrationGuide,
    new RegExp(`${statusDifferenceCount} intentional success/error status differences`),
  )
  assert.match(migrationGuide, new RegExp(`${rustRejectionCount} inputs accepted by Babel`))
  assert.match(migrationGuide, /language: "jsx"/)
})

test('keeps native recovery diagnostics free of removed legacy paths', () => {
  const pipeline = read('crates/fict-compiler/src/pipeline.rs')
  const scanner = read('crates/fict-compiler/src/scan.rs')
  const recovery = read('crates/fict-compiler/src/result.rs')
  const passthrough = read('crates/fict-compiler-oxc/src/compile.rs')
  for (const source of [pipeline, scanner, recovery, passthrough]) {
    assert.doesNotMatch(source, /retry (?:with|the build with) the legacy/)
    assert.doesNotMatch(source, /use the legacy backend/)
  }
  for (const field of [
    'compilerBuildId',
    'protocolVersion',
    'nativeTarget',
    'source language',
    'complete verified 0.30.1 application unit',
    'without mixing compiler/runtime versions',
  ]) {
    assert.match(recovery, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(pipeline, /Some\(INTERNAL_RECOVERY_HELP\)/)
  assert.match(scanner, /Some\(INTERNAL_RECOVERY_HELP\)/)
  assert.match(passthrough, /route JSX through the complete Fict EmitIR pipeline/)
  assert.match(passthrough, /syntax-only OXC pass-through entrypoint does not lower JSX/)
})

test('retains native runtime and option compatibility outcomes', () => {
  const runtime = read('scripts/native-compiler-runtime.test.mjs')
  for (const name of [
    'Rust compiler output preserves Core reactive runtime behavior',
    'native template extraction preserves static HTML and live binding paths',
    'captured reactive aliases remain mutable after an event',
    'projected reactive mutations preserve JavaScript evaluation semantics',
    'reactive conditional returns preserve branch statements and local scope',
    'named function expression hooks use their public binding role',
    'runtime reactive creators preserve calls and enforce configurable R004',
    'derived cycles fail closed even when strict guarantees are disabled',
    'reserved compiler macros fail closed without direct Fict imports',
    'same-module hook metadata protects structured reactive members',
    'compile and analyze consume the same resolved metadata snapshot',
    'semantic EmitIR identities preserve destructuring and authored export names',
    'intrinsic children props become child content without leaking attributes',
    'raw-text and RCDATA expressions bind literal textContent',
    'dynamic annotation-xml children use the final live encoding namespace',
    'optimizeLevel full applies opt-in authored algebraic folding safely',
    'native binding honors derived memo inline policy',
  ]) {
    assert.ok(runtime.includes(`test('${name}'`), name)
  }
})

test('keeps corpus regeneration bound to the audited input digest', () => {
  const generator = read('scripts/generate-rust-codegen-corpus.mjs')
  assert.match(generator, /676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f/)
  assert.match(generator, /Unreviewed compatibility deviation/)
  assert.doesNotMatch(generator, /@babel\/|compiler\/legacy/)
})
