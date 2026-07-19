import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAtomicPublishOrder,
  buildPublishPlan,
  fetchRegistryDocument,
  getPublishedVersions,
  normalizeRegistryDocument,
  validateAtomicNativeReleaseConfiguration,
  validateReleaseConfiguration,
  validateReleaseTag,
} from './release-publish-plan.mjs'
import { NATIVE_COMPILER_TARGETS } from './native-compiler-packages.mjs'

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

test('orders every native compiler package before the facade', () => {
  const plan = [
    { name: '@fictjs/compiler', version: '1.2.3', status: 'pending' },
    { name: '@fictjs/runtime', version: '1.2.3', status: 'pending' },
    ...NATIVE_COMPILER_TARGETS.map(target => ({
      name: target.packageName,
      version: '1.2.3',
      status: 'pending',
    })),
  ]
  const ordered = buildAtomicPublishOrder(plan).map(entry => entry.name)
  const facadeIndex = ordered.indexOf('@fictjs/compiler')
  assert.ok(facadeIndex >= NATIVE_COMPILER_TARGETS.length)
  for (const target of NATIVE_COMPILER_TARGETS) {
    assert.ok(ordered.indexOf(target.packageName) < facadeIndex)
  }
})

test('orders workspace dependencies before their publishable consumers', () => {
  const plan = [
    { name: '@fictjs/plugin', version: '1.2.3', status: 'pending' },
    { name: '@fictjs/compiler', version: '1.2.3', status: 'pending' },
    ...NATIVE_COMPILER_TARGETS.map(target => ({
      name: target.packageName,
      version: '1.2.3',
      status: 'pending',
    })),
  ]
  const manifests = [
    { name: '@fictjs/plugin', dependencies: { '@fictjs/compiler': '1.2.3' } },
    {
      name: '@fictjs/compiler',
      optionalDependencies: Object.fromEntries(
        NATIVE_COMPILER_TARGETS.map(target => [target.packageName, '1.2.3']),
      ),
    },
  ]
  const ordered = buildAtomicPublishOrder(plan, manifests).map(entry => entry.name)
  assert.ok(ordered.indexOf('@fictjs/compiler') < ordered.indexOf('@fictjs/plugin'))
})

test('requires native packages, facade optional dependencies, and versions to be atomic', () => {
  const compiler = {
    name: '@fictjs/compiler',
    version: '1.2.3',
    optionalDependencies: Object.fromEntries(
      NATIVE_COMPILER_TARGETS.map(target => [target.packageName, 'workspace:*']),
    ),
  }
  const nativePackages = NATIVE_COMPILER_TARGETS.map(target => ({
    name: target.packageName,
    version: '1.2.3',
  }))
  const allowlist = ['@fictjs/compiler', ...nativePackages.map(pkg => pkg.name)]
  assert.deepEqual(
    validateAtomicNativeReleaseConfiguration([compiler, ...nativePackages], allowlist),
    [],
  )

  assert.deepEqual(
    validateAtomicNativeReleaseConfiguration([compiler, ...nativePackages.slice(1)], allowlist),
    [`native release matrix is missing ${nativePackages[0].name}`],
  )
})

test('retries a cached 404 with a cache-busting registry request', async () => {
  const calls = []
  const responses = [
    { ok: false, status: 404, statusText: 'Not Found' },
    {
      ok: true,
      status: 200,
      async json() {
        return { versions: { '0.26.0': {} } }
      },
    },
  ]
  const delays = []

  const document = await fetchRegistryDocument(
    'https://registry.npmjs.org',
    '@fictjs/webpack-plugin',
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return responses.shift()
      },
      now: () => 1234,
      onRetry: () => {},
      retryDelaysMs: [250],
      sleep: async delay => delays.push(delay),
    },
  )

  assert.deepEqual(document, { versions: { '0.26.0': {} } })
  assert.deepEqual(delays, [250])
  assert.equal(calls[0]?.url, 'https://registry.npmjs.org/@fictjs%2fwebpack-plugin')
  assert.deepEqual(calls[0]?.options.headers, {
    accept: 'application/vnd.npm.install-v1+json',
  })
  assert.equal(
    calls[1]?.url,
    'https://registry.npmjs.org/@fictjs%2fwebpack-plugin?fict-release-check=1234-2',
  )
  assert.deepEqual(calls[1]?.options.headers, {
    accept: 'application/vnd.npm.install-v1+json',
    'cache-control': 'no-cache',
  })
})

test('classifies a package as missing only after all 404 retries', async () => {
  let requests = 0

  const document = await fetchRegistryDocument('https://registry.npmjs.org', '@fictjs/missing', {
    fetchImpl: async () => {
      requests += 1
      return { ok: false, status: 404, statusText: 'Not Found' }
    },
    onRetry: () => {},
    retryDelaysMs: [0, 0],
    sleep: async () => {},
  })

  assert.equal(document, null)
  assert.equal(requests, 3)
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

test('binds a stable release tag to the compiler package version', () => {
  const packages = [{ name: '@fictjs/compiler', version: '1.2.3' }]
  assert.deepEqual(validateReleaseTag(null, packages), [])
  assert.deepEqual(validateReleaseTag('v1.2.3', packages), [])
  assert.deepEqual(validateReleaseTag('v1.2.2', packages), [
    'release tag v1.2.2 must equal compiler package tag v1.2.3',
  ])
})

test('keeps development compiler prereleases out of the stable tag workflow', () => {
  assert.deepEqual(
    validateReleaseTag('v0.32.0-next.0', [{ name: '@fictjs/compiler', version: '0.32.0-next.0' }]),
    [
      'compiler 0.32.0-next.0 is a development prerelease; finalize a stable version before tagging',
    ],
  )
})
