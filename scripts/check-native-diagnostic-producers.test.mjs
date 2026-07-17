import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredDiagnosticCodes,
  documentedDiagnosticCodes,
  missingNativeDiagnosticProducers,
  parseDiagnosticRegistry,
  validateDiagnosticRegistry,
} from './check-native-diagnostic-producers.mjs'

const policy = codes => `
  const CONFIGURABLE_DIAGNOSTIC_CODES: &[&str] = &[${codes.map(code => `"${code}"`).join(', ')}];
`

test('extracts the reviewed configurable diagnostic registry', () => {
  assert.deepEqual(configuredDiagnosticCodes(policy(['FICT-A001', 'FICT-B002'])), [
    'FICT-A001',
    'FICT-B002',
  ])
})

test('requires every configurable code to appear in native production sources', () => {
  assert.deepEqual(
    missingNativeDiagnosticProducers(policy(['FICT-A001', 'FICT-B002']), [
      'DiagnosticCode::new("FICT-A001")',
    ]),
    ['FICT-B002'],
  )
})

test('rejects a missing or renamed registry instead of passing open', () => {
  assert.throws(() => configuredDiagnosticCodes('const OTHER: &[&str] = &[];'))
})

test('rejects null and array registry maps with a structural error', () => {
  assert.throws(
    () =>
      parseDiagnosticRegistry(
        JSON.stringify({ schemaVersion: 1, active: null, aliases: {}, retired: {} }),
      ),
    /define active producers/,
  )
  assert.throws(
    () =>
      parseDiagnosticRegistry(
        JSON.stringify({ schemaVersion: 1, active: {}, aliases: [], retired: {} }),
      ),
    /define aliases and retired maps/,
  )
})

const registry = JSON.stringify({
  schemaVersion: 1,
  active: {
    rust: { documented: ['FICT-A001'], additional: ['FICT-B002'] },
    vscode: { documented: ['FICT-NATIVE-HOST'], additional: [] },
  },
  aliases: { 'FICT-A-ALIAS': 'FICT-A001' },
  retired: { 'FICT-OLD': { replacements: ['FICT-A001'] } },
  integrations: {
    vscodeStaticAnalysisFallback: {
      includePrefixes: ['FICT-B'],
      excludePrefixes: ['FICT-B0'],
    },
  },
})

test('validates active, alias, retired, documentation, and integration registry states', () => {
  assert.equal(parseDiagnosticRegistry(registry).schemaVersion, 1)
  assert.deepEqual(documentedDiagnosticCodes('### FICT-A001: A\n### FICT-NATIVE-HOST: Host'), [
    'FICT-A001',
    'FICT-NATIVE-HOST',
  ])
  const result = validateDiagnosticRegistry({
    registrySource: registry,
    policySource: policy(['FICT-A001']),
    rustProducerSources: ['DiagnosticCode::new("FICT-A001"); emit("FICT-B002")'],
    vscodeProducerSources: ["const code = 'FICT-NATIVE-HOST'"],
    docsSource: '### FICT-A001: A\n### FICT-NATIVE-HOST: Host',
  })
  assert.deepEqual(result.retiredCodes, ['FICT-OLD'])
})

test('rejects retired diagnostic use in integrations', () => {
  assert.throws(
    () =>
      validateDiagnosticRegistry({
        registrySource: registry,
        policySource: policy(['FICT-A001']),
        rustProducerSources: ['"FICT-A001" "FICT-B002"'],
        vscodeProducerSources: ["'FICT-NATIVE-HOST'"],
        docsSource: '### FICT-A001: A\n### FICT-NATIVE-HOST: Host',
        integrationSources: ["const code = 'FICT-OLD'"],
      }),
    /retired diagnostic remains/,
  )
})

test('rejects active registry codes without a production source', () => {
  assert.throws(
    () =>
      validateDiagnosticRegistry({
        registrySource: registry,
        policySource: policy(['FICT-A001']),
        rustProducerSources: ['"FICT-A001"'],
        vscodeProducerSources: ["'FICT-NATIVE-HOST'"],
        docsSource: '### FICT-A001: A\n### FICT-NATIVE-HOST: Host',
      }),
    /active rust diagnostic has no production source: FICT-B002/,
  )
})
