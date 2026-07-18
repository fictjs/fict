const policyDescriptions = {
  'rust-structured-rejection-diagnostics':
    "Rust exposes structured error diagnostics for a rejected input where Babel's thrown-error/onWarn surface did not expose the same code and severity sequence; acceptance changes are reviewed separately.",
  'diagnostic-severity-reclassification':
    'Rust intentionally assigns a different severity to the same diagnostic code multiset.',
  'rust-warning-addition':
    'Rust intentionally reports additional non-error diagnostics while retaining every Babel diagnostic.',
  'rust-warning-removal':
    'Rust intentionally removes one or more Babel non-error diagnostics without adding a replacement diagnostic.',
  'rust-warning-set-change':
    'Rust intentionally replaces part of the Babel non-error diagnostic set instead of only adding or removing diagnostics.',
}

const diagnosticSignature = diagnostic => `${diagnostic.code}:${diagnostic.severity}`
const diagnosticSignatures = diagnostics => diagnostics.map(diagnosticSignature).sort()
const diagnosticCodes = diagnostics => diagnostics.map(diagnostic => diagnostic.code).sort()

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isMultisetSubset(left, right) {
  const remaining = [...right]
  for (const value of left) {
    const index = remaining.indexOf(value)
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return true
}

export function diagnosticDeviationPolicy(babelDiagnostics, rustDiagnostics) {
  const babelSignatures = diagnosticSignatures(babelDiagnostics)
  const rustSignatures = diagnosticSignatures(rustDiagnostics)
  if (sameValues(babelSignatures, rustSignatures)) return null
  if (sameValues(diagnosticCodes(babelDiagnostics), diagnosticCodes(rustDiagnostics))) {
    return 'diagnostic-severity-reclassification'
  }
  if (rustDiagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return 'rust-structured-rejection-diagnostics'
  }
  if (isMultisetSubset(babelSignatures, rustSignatures)) return 'rust-warning-addition'
  if (isMultisetSubset(rustSignatures, babelSignatures)) return 'rust-warning-removal'
  return 'rust-warning-set-change'
}

export function buildDiagnosticDeviationReview({ sourceAuditSha256, fixtures }) {
  const policyCounts = Object.fromEntries(
    Object.keys(policyDescriptions).map(policy => [policy, 0]),
  )
  const deviations = []
  for (const fixture of fixtures) {
    const policy = diagnosticDeviationPolicy(fixture.babelDiagnostics, fixture.rustDiagnostics)
    if (policy === null) continue
    policyCounts[policy]++
    deviations.push({
      id: fixture.id,
      babelStatus: fixture.babelStatus,
      rustStatus: fixture.rustStatus,
      babelDiagnostics: fixture.babelDiagnostics,
      rustDiagnostics: fixture.rustDiagnostics,
      policy,
    })
  }
  return {
    schemaVersion: 1,
    sourceCorpus: 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json',
    sourceAuditSha256,
    policies: policyDescriptions,
    policyCounts,
    deviationCount: deviations.length,
    deviations,
  }
}

export function corpusDiagnosticReviewFixtures(corpus) {
  return corpus.fixtures.map(fixture => ({
    id: fixture.id,
    babelStatus: fixture.babelAudit.status,
    rustStatus: fixture.expected.status,
    babelDiagnostics: fixture.babelAudit.diagnosticCodes.map(code => ({
      code,
      severity: 'warning',
    })),
    rustDiagnostics: fixture.expected.diagnostics.map(({ code, severity, guaranteeClass }) => ({
      code,
      severity,
      guaranteeClass,
    })),
  }))
}
