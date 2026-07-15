import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advisoriesAtOrAbove,
  collectProductionVersions,
  fetchBulkAdvisories,
  parseBulkAdvisories,
} from './audit-production-dependencies.mjs'

const requested = { alpha: ['1.0.0'], beta: ['2.0.0', '2.1.0'] }

test('collects sorted unique registry versions from the recursive production graph', () => {
  const graph = [
    {
      dependencies: {
        beta: { version: '2.1.0', dependencies: { alpha: { version: '1.0.0' } } },
        workspace: {
          version: 'link:../workspace',
          dependencies: { beta: { version: '2.0.0' } },
        },
        alpha: { version: '1.0.0' },
      },
    },
  ]
  assert.deepEqual(collectProductionVersions(graph), requested)
  assert.throws(
    () =>
      collectProductionVersions([
        { dependencies: { remote: { version: 'github:example/remote' } } },
      ]),
    /unsupported non-registry version/,
  )
})

test('validates and orders npm bulk advisories by severity', () => {
  const advisories = parseBulkAdvisories(
    {
      alpha: [
        {
          id: 7,
          severity: 'low',
          title: 'Low issue',
          url: 'https://github.com/advisories/GHSA-low',
          vulnerable_versions: '<=1.0.0',
        },
      ],
      beta: [
        {
          id: 'GHSA-high',
          severity: 'high',
          title: 'High issue',
          url: 'https://github.com/advisories/GHSA-high',
          vulnerable_versions: '>=2.0.0 <2.2.0',
        },
      ],
    },
    requested,
  )
  assert.deepEqual(
    advisories.map(advisory => advisory.severity),
    ['high', 'low'],
  )
  assert.equal(advisoriesAtOrAbove(advisories, 'moderate').length, 1)
  assert.equal(advisoriesAtOrAbove(advisories, 'low').length, 2)
})

test('fails closed on malformed, unknown, or unrequested advisory data', () => {
  assert.throws(() => parseBulkAdvisories([], requested), /must be an object/)
  assert.throws(() => parseBulkAdvisories({ gamma: [] }, requested), /unrequested package/)
  assert.throws(
    () =>
      parseBulkAdvisories(
        {
          alpha: [
            {
              id: 1,
              severity: 'unknown',
              title: 'Unknown severity',
              url: 'https://example.com/advisory',
              vulnerable_versions: '*',
            },
          ],
        },
        requested,
      ),
    /malformed/,
  )
  assert.throws(() => advisoriesAtOrAbove([], 'unknown'), /Unsupported audit level/)
})

test('posts the production version set to the npm bulk endpoint', async () => {
  const requests = []
  const advisories = await fetchBulkAdvisories({
    registry: 'https://registry.npmjs.org/',
    packages: requested,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.deepEqual(advisories, [])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), requested)
})

test('rejects an empty or non-semver production version set before network access', async () => {
  let requestedNetwork = false
  const fetchImpl = async () => {
    requestedNetwork = true
    return new Response('{}')
  }
  await assert.rejects(
    fetchBulkAdvisories({
      registry: 'https://registry.npmjs.org',
      packages: { alpha: ['link:../alpha'] },
      fetchImpl,
    }),
    /versions for alpha are invalid/,
  )
  assert.equal(requestedNetwork, false)
})

test('retries transient failures and rejects permanent registry errors', async () => {
  let attempts = 0
  const advisories = await fetchBulkAdvisories({
    registry: 'https://registry.npmjs.org',
    packages: requested,
    retryDelaysMs: [0],
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1
      return new Response(attempts === 1 ? 'busy' : '{}', { status: attempts === 1 ? 503 : 200 })
    },
  })
  assert.deepEqual(advisories, [])
  assert.equal(attempts, 2)

  await assert.rejects(
    fetchBulkAdvisories({
      registry: 'https://registry.npmjs.org',
      packages: requested,
      fetchImpl: async () => new Response('gone', { status: 410, statusText: 'Gone' }),
    }),
    /returned 410 Gone: gone/,
  )
})
