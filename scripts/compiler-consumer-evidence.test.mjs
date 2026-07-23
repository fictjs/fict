import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildCompilerConsumerEvidence,
  collectCompilerConsumerEvidence,
  persistCompilerConsumerEvidence,
  REQUIRED_CANDIDATE_FEATURES,
  REQUIRED_CANDIDATE_NATIVE_PACKAGE,
  REQUIRED_CANDIDATE_VALIDATIONS,
  REQUIRED_REAL_CONSUMER_PACKAGES,
} from './compiler-consumer-evidence.mjs'

const version = '0.30.0'
const satelliteVersion = '0.28.2'
const candidateVersion = '0.32.0-next.0'
const repositoryName = 'fictjs/real-consumer'
const repositoryUrl = `https://github.com/${repositoryName}`
const commitSha = 'a'.repeat(40)
const workflowPath = '.github/workflows/ci.yml'
const projectPath = 'apps/site'
const evidenceScript = fileURLToPath(new URL('./compiler-consumer-evidence.mjs', import.meta.url))
const integrities = Object.fromEntries(
  REQUIRED_REAL_CONSUMER_PACKAGES.map((packageName, index) => [
    packageName,
    `sha512-${Buffer.from(`package-${index}`).toString('base64')}`,
  ]),
)
const packageVersions = Object.fromEntries(
  REQUIRED_REAL_CONSUMER_PACKAGES.map(packageName => [
    packageName,
    packageName === '@fictjs/ssr' ? satelliteVersion : version,
  ]),
)

function fileDocument(content, index) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
    sha: (index + 1).toString(16).repeat(40),
  }
}

function fixture() {
  const manifest = JSON.stringify({
    name: '@fictjs/real-consumer-site',
    private: true,
    scripts: {
      build: 'vite build',
      typecheck: 'tsc --noEmit',
      'verify:compiler': 'node scripts/verify-compiler.mjs',
    },
    dependencies: {
      '@fictjs/runtime': version,
      '@fictjs/ssr': satelliteVersion,
      fict: version,
    },
    devDependencies: {
      '@fictjs/compiler': version,
      '@fictjs/vite-plugin': version,
    },
  })
  const lockfile = `lockfileVersion: '9.0'

packages:
${REQUIRED_REAL_CONSUMER_PACKAGES.map(
  packageName =>
    `  '${packageName}@${packageVersions[packageName]}':\n    resolution: {integrity: ${integrities[packageName]}}`,
).join('\n')}
`
  const viteConfig = `import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
export default defineConfig({ plugins: [fict()] })
`
  const verification = `import assert from 'node:assert/strict'
import { nativeCompilerInfo, transformSync } from '@fictjs/compiler'
assert.equal(nativeCompilerInfo().backend, 'rust')
assert.match(transformSync({ protocolVersion: 1, code: 'export const n: number = 1', filename: '/consumer.ts', options: {} }).code, /n = 1/)
`
  const workflow = `name: CI
on: push
jobs:
  consumer:
    steps:
      - run: pnpm --dir ${projectPath} install --frozen-lockfile
      - run: pnpm --dir ${projectPath} verify:compiler
      - run: pnpm --dir ${projectPath} typecheck
      - run: pnpm --dir ${projectPath} build
`
  return {
    version,
    repositoryName,
    commitSha,
    workflowPath,
    projectPath,
    repository: {
      full_name: repositoryName,
      html_url: repositoryUrl,
      private: false,
      archived: false,
      disabled: false,
      default_branch: 'main',
    },
    commit: { sha: commitSha, html_url: `${repositoryUrl}/commit/${commitSha}` },
    workflowRuns: {
      workflow_runs: [
        {
          id: 301,
          run_attempt: 2,
          path: workflowPath,
          html_url: `${repositoryUrl}/actions/runs/301`,
          event: 'push',
          head_branch: 'main',
          head_sha: commitSha,
          status: 'completed',
          conclusion: 'success',
          updated_at: '2026-08-01T10:00:00Z',
        },
      ],
    },
    files: {
      manifest: fileDocument(manifest, 0),
      lockfile: fileDocument(lockfile, 1),
      viteConfig: fileDocument(viteConfig, 2),
      verification: fileDocument(verification, 3),
      workflow: fileDocument(workflow, 4),
    },
    packuments: Object.fromEntries(
      REQUIRED_REAL_CONSUMER_PACKAGES.map(packageName => [
        packageName,
        {
          versions: {
            [packageVersions[packageName]]: {
              name: packageName,
              version: packageVersions[packageName],
              dist: { integrity: integrities[packageName] },
            },
          },
          time: { [packageVersions[packageName]]: '2026-07-31T10:00:00.000Z' },
        },
      ]),
    ),
  }
}

function candidateFixture() {
  const source = fixture()
  source.version = candidateVersion

  const manifest = JSON.parse(Buffer.from(source.files.manifest.content, 'base64').toString('utf8'))
  for (const packageName of REQUIRED_REAL_CONSUMER_PACKAGES) {
    if (packageName === '@fictjs/ssr') continue
    const group = manifest.dependencies?.[packageName] ? 'dependencies' : 'devDependencies'
    manifest[group][packageName] = candidateVersion
  }
  Object.assign(manifest.scripts, {
    'test:unit': 'vitest run',
    'test:e2e': 'playwright test',
    'test:ssr': 'node scripts/verify-ssr-hydration.mjs',
    'test:hmr': 'node scripts/verify-dev-hmr.mjs',
  })
  source.files.manifest = fileDocument(JSON.stringify(manifest), 5)

  const candidatePackages = [
    ...REQUIRED_REAL_CONSUMER_PACKAGES,
    REQUIRED_CANDIDATE_NATIVE_PACKAGE,
  ].sort()
  const candidateIntegrities = Object.fromEntries(
    candidatePackages.map((packageName, index) => [
      packageName,
      `sha512-${Buffer.from(`candidate-package-${index}`).toString('base64')}`,
    ]),
  )
  const candidateVersions = Object.fromEntries(
    candidatePackages.map(packageName => [
      packageName,
      packageName === '@fictjs/ssr' ? satelliteVersion : candidateVersion,
    ]),
  )
  const lockfile = `lockfileVersion: '9.0'

packages:
${candidatePackages
  .map(
    packageName =>
      `  '${packageName}@${candidateVersions[packageName]}':\n    resolution: {integrity: ${candidateIntegrities[packageName]}}`,
  )
  .join('\n')}
`
  source.files.lockfile = fileDocument(lockfile, 6)

  const coverageDocument = {
    schemaVersion: 1,
    features: Object.fromEntries(
      REQUIRED_CANDIDATE_FEATURES.map(name => [name, ['src/candidate-coverage.tsx']]),
    ),
    validations: Object.fromEntries(
      REQUIRED_CANDIDATE_VALIDATIONS.map(name => [name, ['e2e/candidate.spec.ts']]),
    ),
  }
  source.files.coverage = fileDocument(JSON.stringify(coverageDocument), 7)
  source.files.coverageEntries = {
    [`${projectPath}/src/candidate-coverage.tsx`]: fileDocument(
      'export function useCandidateCoverage() { return new Map() }',
      8,
    ),
    [`${projectPath}/e2e/candidate.spec.ts`]: fileDocument(
      "test('candidate coverage', () => {})",
      9,
    ),
  }
  source.files.workflow = fileDocument(
    `name: CI
on: push
jobs:
  consumer:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --dir ${projectPath} install --frozen-lockfile
      - run: pnpm --dir ${projectPath} verify:compiler
      - run: pnpm --dir ${projectPath} typecheck
      - run: pnpm --dir ${projectPath} build
      - run: pnpm --dir ${projectPath} test:unit
      - run: pnpm --dir ${projectPath} test:e2e
      - run: pnpm --dir ${projectPath} test:ssr
      - run: pnpm --dir ${projectPath} test:hmr
`,
    10,
  )

  source.packuments = Object.fromEntries(
    candidatePackages.map(packageName => {
      const packageVersion = candidateVersions[packageName]
      return [
        packageName,
        {
          versions: {
            [packageVersion]: {
              name: packageName,
              version: packageVersion,
              dist: { integrity: candidateIntegrities[packageName] },
            },
          },
          time: { [packageVersion]: '2026-07-31T10:00:00.000Z' },
        },
      ]
    }),
  )
  return source
}

test('consumer evidence CLI rejects unknown and incomplete arguments', () => {
  const unknown = spawnSync(process.execPath, [evidenceScript, '--unknown'], { encoding: 'utf8' })
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /Unknown compiler consumer evidence argument: --unknown/)

  const incomplete = spawnSync(process.execPath, [evidenceScript, '--version', version], {
    encoding: 'utf8',
  })
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /requires --repository/)
})

test('builds one digest-bound record from a published Rust-default consumer', () => {
  const evidence = buildCompilerConsumerEvidence(fixture())
  assert.equal(evidence.release, version)
  assert.equal(evidence.repository, repositoryUrl)
  assert.equal(evidence.commitSha, commitSha)
  assert.equal(evidence.workflow.runId, '301')
  assert.equal(evidence.workflow.runAttempt, '2')
  assert.equal(evidence.project.path, projectPath)
  assert.equal(evidence.packages.length, REQUIRED_REAL_CONSUMER_PACKAGES.length)
  assert.equal(
    evidence.packages.find(packageEntry => packageEntry.name === '@fictjs/ssr').version,
    satelliteVersion,
  )
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/)
})

test('binds a prerelease candidate to native integrity and full external validation', () => {
  const evidence = buildCompilerConsumerEvidence(candidateFixture())
  assert.equal(evidence.schemaVersion, 2)
  assert.equal(evidence.release, candidateVersion)
  assert.equal(evidence.profile, 'release-candidate')
  assert.equal(evidence.project.scripts.unit, 'vitest run')
  assert.equal(evidence.project.scripts.browserE2E, 'playwright test')
  assert.deepEqual(Object.keys(evidence.project.coverage.features), REQUIRED_CANDIDATE_FEATURES)
  assert.deepEqual(
    Object.keys(evidence.project.coverage.validations),
    REQUIRED_CANDIDATE_VALIDATIONS,
  )
  assert.equal(
    evidence.packages.find(packageEntry => packageEntry.name === REQUIRED_CANDIDATE_NATIVE_PACKAGE)
      .version,
    candidateVersion,
  )
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/)
})

test('candidate evidence fails closed on missing workflows, coverage, and native integrity', () => {
  const missingHmr = candidateFixture()
  const manifest = JSON.parse(
    Buffer.from(missingHmr.files.manifest.content, 'base64').toString('utf8'),
  )
  delete manifest.scripts['test:hmr']
  missingHmr.files.manifest = fileDocument(JSON.stringify(manifest), 11)
  assert.throws(
    () => buildCompilerConsumerEvidence(missingHmr),
    /package\.json requires a test:hmr script/,
  )

  const missingFeature = candidateFixture()
  const coverage = JSON.parse(
    Buffer.from(missingFeature.files.coverage.content, 'base64').toString('utf8'),
  )
  delete coverage.features.customHooks
  missingFeature.files.coverage = fileDocument(JSON.stringify(coverage), 12)
  assert.throws(
    () => buildCompilerConsumerEvidence(missingFeature),
    /coverage features\.customHooks requires file paths/,
  )

  const unboundNative = candidateFixture()
  unboundNative.files.lockfile = fileDocument(
    Buffer.from(unboundNative.files.lockfile.content, 'base64')
      .toString('utf8')
      .replace(
        unboundNative.packuments[REQUIRED_CANDIDATE_NATIVE_PACKAGE].versions[candidateVersion].dist
          .integrity,
        'sha512-unbound',
      ),
    13,
  )
  assert.throws(
    () => buildCompilerConsumerEvidence(unboundNative),
    /lockfile does not bind @fictjs\/compiler-linux-x64-gnu/,
  )
})

test('rejects links, overrides, ranges, cross-revision runs, and pre-publication evidence', () => {
  const linked = fixture()
  linked.files.lockfile = fileDocument(
    `${Buffer.from(linked.files.lockfile.content, 'base64').toString('utf8')}specifier: link:../../../packages/compiler\n`,
    5,
  )
  assert.throws(
    () => buildCompilerConsumerEvidence(linked),
    /cannot use workspace links for released packages/,
  )

  const overridden = fixture()
  overridden.files.viteConfig = fileDocument(
    `import fict from '@fictjs/vite-plugin'\nexport default { plugins: [fict({ backend: 'rust' })] }\n`,
    6,
  )
  assert.throws(
    () => buildCompilerConsumerEvidence(overridden),
    /must exercise the published Rust default/,
  )

  const ranged = fixture()
  const rangedManifest = JSON.parse(
    Buffer.from(ranged.files.manifest.content, 'base64').toString('utf8'),
  )
  rangedManifest.dependencies.fict = `^${version}`
  ranged.files.manifest = fileDocument(JSON.stringify(rangedManifest), 7)
  assert.throws(
    () => buildCompilerConsumerEvidence(ranged),
    /must pin fict to exact release 0\.30\.0/,
  )

  const rangedSatellite = fixture()
  const rangedSatelliteManifest = JSON.parse(
    Buffer.from(rangedSatellite.files.manifest.content, 'base64').toString('utf8'),
  )
  rangedSatelliteManifest.dependencies['@fictjs/ssr'] = `^${satelliteVersion}`
  rangedSatellite.files.manifest = fileDocument(JSON.stringify(rangedSatelliteManifest), 8)
  assert.throws(
    () => buildCompilerConsumerEvidence(rangedSatellite),
    /must pin @fictjs\/ssr to one exact published version/,
  )

  const crossRevision = fixture()
  crossRevision.workflowRuns.workflow_runs[0].head_sha = 'b'.repeat(40)
  assert.throws(
    () => buildCompilerConsumerEvidence(crossRevision),
    /No successful default-branch workflow binds/,
  )

  const prePublication = fixture()
  prePublication.packuments.fict.time[version] = '2026-08-02T10:00:00.000Z'
  assert.throws(
    () => buildCompilerConsumerEvidence(prePublication),
    /must complete after the compatibility packages publish/,
  )

  assert.throws(
    () =>
      buildCompilerConsumerEvidence({
        ...fixture(),
        repositoryName: 'fictjs/fict',
      }),
    /requires a repository separate from fictjs\/fict/,
  )
})

test('collects only immutable GitHub files, one successful run, and npm packuments', async () => {
  const source = fixture()
  const githubApi = `https://api.github.com/repos/${repositoryName}`
  const filePaths = {
    manifest: `${projectPath}/package.json`,
    lockfile: `${projectPath}/pnpm-lock.yaml`,
    viteConfig: `${projectPath}/vite.config.mjs`,
    verification: `${projectPath}/scripts/verify-compiler.mjs`,
    workflow: workflowPath,
  }
  const responses = new Map([
    [githubApi, source.repository],
    [`${githubApi}/commits/${commitSha}`, source.commit],
    [`${githubApi}/actions/runs?event=push&status=completed&per_page=100`, source.workflowRuns],
    ...Object.entries(filePaths).map(([key, filePath]) => [
      `${githubApi}/contents/${filePath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?ref=${commitSha}`,
      source.files[key],
    ]),
    ...REQUIRED_REAL_CONSUMER_PACKAGES.map(packageName => [
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      source.packuments[packageName],
    ]),
  ])
  const requested = []
  const fetchImpl = async (url, options) => {
    requested.push({ url, options })
    return {
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
      async json() {
        return responses.get(url)
      },
    }
  }
  const evidence = await collectCompilerConsumerEvidence(
    { version, repositoryName, commitSha, workflowPath, projectPath },
    { fetchImpl, githubToken: 'test-token' },
  )
  assert.equal(evidence.evidenceDigest.length, 71)
  assert.equal(requested.length, 13)
  assert.equal(
    requested.find(request => request.url === githubApi).options.headers.authorization,
    'Bearer test-token',
  )
  assert.equal(
    requested.find(request => request.url.startsWith('https://registry.npmjs.org')).options.headers
      .authorization,
    undefined,
  )
})

test('collects candidate coverage files from the same immutable revision', async () => {
  const source = candidateFixture()
  const githubApi = `https://api.github.com/repos/${repositoryName}`
  const filePaths = {
    manifest: `${projectPath}/package.json`,
    lockfile: `${projectPath}/pnpm-lock.yaml`,
    viteConfig: `${projectPath}/vite.config.mjs`,
    verification: `${projectPath}/scripts/verify-compiler.mjs`,
    workflow: workflowPath,
    coverage: `${projectPath}/compiler-candidate-coverage.json`,
  }
  const responses = new Map([
    [githubApi, source.repository],
    [`${githubApi}/commits/${commitSha}`, source.commit],
    [`${githubApi}/actions/runs?event=push&status=completed&per_page=100`, source.workflowRuns],
    ...Object.entries(filePaths).map(([key, filePath]) => [
      `${githubApi}/contents/${filePath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?ref=${commitSha}`,
      source.files[key],
    ]),
    ...Object.entries(source.files.coverageEntries).map(([filePath, document]) => [
      `${githubApi}/contents/${filePath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?ref=${commitSha}`,
      document,
    ]),
    ...Object.entries(source.packuments).map(([packageName, packument]) => [
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      packument,
    ]),
  ])
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    return {
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
      async json() {
        return responses.get(url)
      },
    }
  }
  const evidence = await collectCompilerConsumerEvidence(
    {
      version: candidateVersion,
      repositoryName,
      commitSha,
      workflowPath,
      projectPath,
    },
    { fetchImpl },
  )
  assert.equal(evidence.schemaVersion, 2)
  assert.equal(requested.length, 17)
  assert.ok(
    requested.includes(
      `${githubApi}/contents/${projectPath}/src/candidate-coverage.tsx?ref=${commitSha}`,
    ),
  )
})

test('writes consumer evidence once, verifies idempotently, and never clobbers it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-consumer-evidence-'))
  t.after(() => rm(directory, { recursive: true }))
  const outputPath = path.join(directory, 'v0.30.0.json')
  const evidence = buildCompilerConsumerEvidence(fixture())
  assert.equal(persistCompilerConsumerEvidence(outputPath, evidence), 'Recorded')
  assert.equal(persistCompilerConsumerEvidence(outputPath, evidence), 'Verified')
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidence)
  assert.throws(
    () => persistCompilerConsumerEvidence(outputPath, { ...evidence, commitSha: 'f'.repeat(40) }),
    /Refusing to replace existing compiler consumer evidence/,
  )
})
