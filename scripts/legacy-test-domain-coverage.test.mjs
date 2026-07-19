import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const manifestPath = path.join(
  repositoryRoot,
  'scripts/fixtures/legacy_0_28_test_domain_coverage.json',
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const expectedDomains = [
  'api-type-contract',
  'cache-fingerprint-path',
  'cache-fingerprint',
  'codegen-auto-extract',
  'codegen-expression-deps',
  'codegen-reactive-accessors',
  'compiler-complexity-report',
  'conformance-matrix',
  'delegated-events-parity',
  'dependency-key',
  'diagnostic-docs',
  'directives',
  'fine-grained-dom',
  'hir-builder',
  'hir-fuzzing',
  'module-metadata-safety',
  'optimizer-bench-cli',
  'optimizer-bench-sampling',
  'optimizer-diff',
  'optimizer',
  'regions',
  'release-strict-scope',
  'runtime-abi',
  'scopes',
  'shapes',
  'ssa',
  'state-machine-name-collision',
  'structurize',
  'template-extractor',
  'tooling-export-surface',
  'tooling-minimize',
  'using-declaration',
  'validation',
  'vnode-props-order',
]
const dispositions = new Set([
  'architecture-replacement',
  'behavior-port',
  'host-migration',
  'intentional-removal',
])
const assertionLevels = new Set([
  'runtime-behavior',
  'output-contract',
  'host-contract',
  'structural-invariant',
  'type-contract',
  'gate-contract',
  'intentional-removal',
])

test('accounts for the exact 34 legacy test domains missing from the extracted corpus', () => {
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.baseline, '@fictjs/compiler@0.28.0')
  assert.equal(manifest.unrepresentedFileCount, expectedDomains.length)
  assert.deepEqual(manifest.domains.map(domain => domain.name).sort(), [...expectedDomains].sort())
  assert.equal(new Set(manifest.domains.map(domain => domain.name)).size, expectedDomains.length)
  assert.match(manifest.claimBoundary, /structural and gate evidence are not runtime-equivalence/)
  assert.deepEqual(
    Object.keys(manifest.assertionLevelDefinitions).sort(),
    [...assertionLevels].sort(),
  )
  assert.deepEqual(Object.keys(manifest.domainAssertionLevels).sort(), [...expectedDomains].sort())
  assert.ok(
    Object.values(manifest.assertionLevelDefinitions).every(definition => definition.length >= 60),
  )
})

test('binds every domain review to the exact legacy test and assertion surface', () => {
  const review = manifest.legacySurfaceReview
  const inventory = JSON.parse(readFileSync(path.join(repositoryRoot, review.inventoryArtifact)))
  const unrepresentedFiles = inventory.files.filter(file => file.corpusBaseFixtureCount === 0)
  const domainByFile = new Map(manifest.domains.map(domain => [domain.legacyFile, domain]))

  assert.equal(
    review.inventoryArtifact,
    'scripts/fixtures/legacy_0_28_compiler_assertion_inventory.json',
  )
  assert.equal(review.legacyTestFiles, unrepresentedFiles.length)
  assert.equal(
    review.testDeclarationSites,
    unrepresentedFiles.reduce((count, file) => count + file.testDeclarationSiteCount, 0),
  )
  assert.equal(
    review.staticAssertionCallsites,
    unrepresentedFiles.reduce((count, file) => count + file.staticAssertionCallsiteCount, 0),
  )
  assert.deepEqual(
    Object.keys(review.domainDigests).sort(),
    manifest.domains.map(domain => domain.name).sort(),
  )
  assert.deepEqual(
    {
      legacyTestFiles: review.legacyTestFiles,
      testDeclarationSites: review.testDeclarationSites,
      staticAssertionCallsites: review.staticAssertionCallsites,
    },
    { legacyTestFiles: 34, testDeclarationSites: 467, staticAssertionCallsites: 1009 },
  )

  for (const file of unrepresentedFiles) {
    const domain = domainByFile.get(file.file)
    assert.ok(domain, `${file.file}: missing reviewed domain`)
    assert.equal(file.domainLedgerName, domain.name, `${domain.name}: inventory identity`)
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(file)).digest('hex')}`
    assert.equal(review.domainDigests[domain.name], digest, `${domain.name}: legacy surface drift`)
  }
})

test('keeps every replacement or removal claim bound to live repository evidence', () => {
  for (const domain of manifest.domains) {
    assert.ok(dispositions.has(domain.disposition), `${domain.name}: unknown disposition`)
    const assertionLevel = manifest.domainAssertionLevels[domain.name]
    assert.ok(assertionLevels.has(assertionLevel), `${domain.name}: unknown assertion level`)
    assert.equal(
      domain.legacyFile,
      `packages/compiler/test/${domain.name}.test.ts`,
      `${domain.name}: unexpected legacy path`,
    )
    assert.ok(domain.summary.length >= 40, `${domain.name}: summary is too weak`)
    assert.ok(domain.evidence.length > 0, `${domain.name}: evidence is required`)

    for (const evidence of domain.evidence) {
      assert.ok(
        !evidence.path.includes('rust_frozen_codegen_corpus'),
        `${domain.name}: a Rust-authored golden cannot be the migration evidence`,
      )
      const evidencePath = path.join(repositoryRoot, evidence.path)
      assert.ok(existsSync(evidencePath), `${domain.name}: missing evidence ${evidence.path}`)
      const content = readFileSync(evidencePath, 'utf8')
      assert.ok(evidence.markers.length > 0, `${domain.name}: markers are required`)
      for (const marker of evidence.markers) {
        assert.ok(content.includes(marker), `${domain.name}: missing marker ${marker}`)
      }
    }

    const retiredArtifacts = domain.retiredArtifacts ?? []
    if (domain.disposition === 'intentional-removal') {
      assert.equal(assertionLevel, 'intentional-removal', `${domain.name}: removal assertion level`)
      assert.ok(retiredArtifacts.length > 0, `${domain.name}: removed artifacts are required`)
      assert.ok(
        domain.evidence.some(evidence => evidence.path.startsWith('docs/')),
        `${domain.name}: intentional removal needs a documented decision`,
      )
    } else {
      assert.notEqual(assertionLevel, 'intentional-removal', `${domain.name}: live domain level`)
      assert.deepEqual(retiredArtifacts, [], `${domain.name}: only removals may retire artifacts`)
      assert.ok(
        domain.evidence.some(evidence => /(?:test|pipeline\.rs|package\.json)/.test(evidence.path)),
        `${domain.name}: executable or compiled evidence is required`,
      )
    }
    for (const artifact of retiredArtifacts) {
      assert.equal(
        existsSync(path.join(repositoryRoot, artifact)),
        false,
        `${artifact} still exists`,
      )
    }
  }
})

test('uses behavioral evidence for observable legacy semantics', () => {
  for (const domain of manifest.domains) {
    const assertionLevel = manifest.domainAssertionLevels[domain.name]
    if (domain.disposition === 'behavior-port') {
      assert.ok(
        ['runtime-behavior', 'output-contract', 'host-contract', 'gate-contract'].includes(
          assertionLevel,
        ),
        `${domain.name}: behavior ports cannot rely on ${assertionLevel}`,
      )
    }
    if (domain.disposition === 'host-migration') {
      assert.equal(assertionLevel, 'host-contract', `${domain.name}: host contract`)
    }
    if (assertionLevel === 'runtime-behavior') {
      assert.ok(
        domain.evidence.some(evidence => /test(?:s)?[/.]|\.test\./.test(evidence.path)),
        `${domain.name}: runtime behavior needs executable test evidence`,
      )
    }
  }

  const directives = manifest.domains.find(domain => domain.name === 'directives')
  assert.equal(directives.disposition, 'behavior-port')
  assert.equal(manifest.domainAssertionLevels.directives, 'runtime-behavior')
  const directiveMarkers = directives.evidence.flatMap(evidence => evidence.markers)
  for (const marker of [
    'program compiler-disable preserves authored Fict syntax and wins over enable',
    'module no-memo policy reaches top-level and nested lowering',
    'use pure drives DCE and CSE while preserving mutation and coercion barriers',
    'consumes_only_fict_optimization_directives_in_every_scope',
    'consumed-optimization-directives',
  ]) {
    assert.ok(directiveMarkers.includes(marker), `directives: missing ${marker}`)
  }

  const optimizer = manifest.domains.find(domain => domain.name === 'optimizer')
  assert.equal(manifest.domainAssertionLevels.optimizer, 'runtime-behavior')
  assert.ok(
    optimizer.evidence.some(evidence =>
      evidence.markers.includes(
        'use pure drives DCE and CSE while preserving mutation and coercion barriers',
      ),
    ),
  )
})

test('runs the domain ledger in compatibility and Rust guardrail gates', () => {
  const packageJson = readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  assert.match(packageJson, /test:compiler:legacy-domain-coverage/)
  assert.match(
    packageJson,
    /test:compiler:compatibility-corpus[^\n]+legacy-test-domain-coverage\.test\.mjs/,
  )
  assert.match(packageJson, /guardrails:rust-crates[^\n]+legacy-test-domain-coverage\.test\.mjs/)
})
