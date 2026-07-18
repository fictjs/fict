import assert from 'node:assert/strict'
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

test('accounts for the exact 34 legacy test domains missing from the extracted corpus', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.baseline, '@fictjs/compiler@0.28.0')
  assert.equal(manifest.unrepresentedFileCount, expectedDomains.length)
  assert.deepEqual(manifest.domains.map(domain => domain.name).sort(), [...expectedDomains].sort())
  assert.equal(new Set(manifest.domains.map(domain => domain.name)).size, expectedDomains.length)
})

test('keeps every replacement or removal claim bound to live repository evidence', () => {
  for (const domain of manifest.domains) {
    assert.ok(dispositions.has(domain.disposition), `${domain.name}: unknown disposition`)
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
      assert.ok(retiredArtifacts.length > 0, `${domain.name}: removed artifacts are required`)
      assert.ok(
        domain.evidence.some(evidence => evidence.path.startsWith('docs/')),
        `${domain.name}: intentional removal needs a documented decision`,
      )
    } else {
      assert.deepEqual(retiredArtifacts, [], `${domain.name}: only removals may retire artifacts`)
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

test('runs the domain ledger in compatibility and Rust guardrail gates', () => {
  const packageJson = readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  assert.match(packageJson, /test:compiler:legacy-domain-coverage/)
  assert.match(
    packageJson,
    /test:compiler:compatibility-corpus[^\n]+legacy-test-domain-coverage\.test\.mjs/,
  )
  assert.match(packageJson, /guardrails:rust-crates[^\n]+legacy-test-domain-coverage\.test\.mjs/)
})
