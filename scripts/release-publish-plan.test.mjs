import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPublishPlan,
  getPublishedVersions,
  normalizeRegistryDocument,
  validateReleaseConfiguration,
} from './release-publish-plan.mjs'

const publicPackage = {
  name: '@fictjs/example',
  path: 'packages/example',
  version: '1.2.3',
  publishConfig: { access: 'public', provenance: true },
  repository: {
    type: 'git',
    url: 'https://github.com/fictjs/fict.git',
    directory: 'packages/example',
  },
}

test('normalizes npm 12 array-wrapped package information', () => {
  const document = [{ name: '@fictjs/example', versions: ['1.2.2', '1.2.3'] }]

  assert.deepEqual(normalizeRegistryDocument(document), document[0])
  assert.deepEqual(getPublishedVersions(document), ['1.2.2', '1.2.3'])
})

test('reads versions from npm registry packuments', () => {
  const document = { versions: { '1.2.2': {}, '1.2.3': {} } }

  assert.deepEqual(getPublishedVersions(document), ['1.2.2', '1.2.3'])
  assert.equal(
    buildPublishPlan([publicPackage], new Map([[publicPackage.name, document]]))[0]?.status,
    'already-published',
  )
})

test('distinguishes pending versions from first publications', () => {
  const pending = buildPublishPlan(
    [publicPackage],
    new Map([[publicPackage.name, { versions: { '1.2.2': {} } }]]),
  )
  const firstPublication = buildPublishPlan([publicPackage], new Map([[publicPackage.name, null]]))

  assert.equal(pending[0]?.status, 'pending')
  assert.equal(firstPublication[0]?.status, 'new-package')
})

test('requires every non-private workspace package to be allowlisted', () => {
  const failures = validateReleaseConfiguration({
    packages: [publicPackage, { name: '@fictjs/internal', path: 'packages/internal' }],
    allowedPackageNames: [publicPackage.name],
    registry: 'https://registry.npmjs.org',
  })

  assert.deepEqual(failures, [
    '@fictjs/internal is outside the npm publish allowlist and must set private: true',
  ])
})

test('rejects contradictory private package publish metadata', () => {
  const failures = validateReleaseConfiguration({
    packages: [
      publicPackage,
      {
        name: '@fictjs/internal',
        path: 'packages/internal',
        private: true,
        publishConfig: { access: 'public' },
      },
    ],
    allowedPackageNames: [publicPackage.name],
    registry: 'https://registry.npmjs.org',
  })

  assert.deepEqual(failures, ['@fictjs/internal is private and must not define publishConfig'])
})
