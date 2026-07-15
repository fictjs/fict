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
  REQUIRED_REAL_CONSUMER_PACKAGES,
} from './compiler-consumer-evidence.mjs'

const version = '0.30.0'
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
      '@fictjs/ssr': version,
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
    `  '${packageName}@${version}':\n    resolution: {integrity: ${integrities[packageName]}}`,
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
            [version]: {
              name: packageName,
              version,
              dist: { integrity: integrities[packageName] },
            },
          },
          time: { [version]: '2026-07-31T10:00:00.000Z' },
        },
      ]),
    ),
  }
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
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/)
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
