import assert from 'node:assert/strict'
import test from 'node:test'

import { hasLegacyLoaderReference } from './preview-boundary-helpers.mjs'

const runtimeLoaderSegments = ['@fictjs', 'runtime', 'loader']

test('detects literal and escaped legacy loader references', () => {
  for (const separator of ['/', '\\/', '\\x2f', '\\u002f', '\\u{2f}']) {
    assert.equal(hasLegacyLoaderReference(runtimeLoaderSegments.join(separator)), true)
  }
  assert.equal(hasLegacyLoaderReference(['fict', 'loader'].join('\\/')), true)
})

test('allows experimental loader references', () => {
  assert.equal(
    hasLegacyLoaderReference(['@fictjs', 'runtime', 'experimental', 'loader'].join('/')),
    false,
  )
  assert.equal(hasLegacyLoaderReference(['fict', 'experimental', 'loader'].join('\\/')), false)
})
