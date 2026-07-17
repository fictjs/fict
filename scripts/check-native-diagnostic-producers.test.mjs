import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredDiagnosticCodes,
  missingNativeDiagnosticProducers,
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
