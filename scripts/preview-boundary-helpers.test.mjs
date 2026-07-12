import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findUndocumentedExperimentalExports,
  hasLegacyLoaderReference,
} from './preview-boundary-helpers.mjs'

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

test('finds undocumented Preview declarations and re-exports', () => {
  const source = `
    /** @experimental documented declaration */
    export interface Documented {}

    export function missingDeclaration() {}

    /** @experimental documented re-export */
    export { documentedHelper } from './documented.js'

    export { helper as missingReExport } from './missing.js'
    export * from './missing-star.js'
  `

  assert.deepEqual(findUndocumentedExperimentalExports(source), [
    'missingDeclaration',
    'missingReExport',
    '*',
  ])
})
