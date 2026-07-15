import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildCompilerReleaseEvidence,
  collectCompilerReleaseEvidence,
  persistCompilerReleaseEvidence,
  REQUIRED_COMPILER_RELEASE_ASSETS,
} from './compiler-release-evidence.mjs'

const version = '0.29.0'
const tag = `v${version}`
const commitSha = 'a'.repeat(40)
const attestationUrl = 'https://registry.npmjs.org/-/npm/v1/attestations/@fictjs%2fcompiler@0.29.0'

function fixtures() {
  return {
    version,
    release: {
      id: 101,
      tag_name: tag,
      html_url: `https://github.com/fictjs/fict/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
      published_at: '2026-07-16T10:00:00Z',
      assets: REQUIRED_COMPILER_RELEASE_ASSETS.map((name, index) => ({
        name,
        id: 201 + index,
        size: 1_000 + index,
        state: 'uploaded',
        digest: `sha256:${String(index + 1).repeat(64)}`,
      })),
    },
    commit: { sha: commitSha },
    workflowRuns: {
      workflow_runs: [
        {
          id: 301,
          path: '.github/workflows/release.yml',
          event: 'push',
          head_branch: tag,
          head_sha: commitSha,
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
    packument: {
      versions: {
        [version]: {
          name: '@fictjs/compiler',
          version,
          dist: {
            integrity: 'sha512-QUJDRA==',
            attestations: {
              url: attestationUrl,
              provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
            },
          },
        },
      },
      time: { [version]: '2026-07-16T10:05:00.000Z' },
    },
  }
}

test('builds one digest-bound record from the tag workflow, GitHub Release, and npm', () => {
  const evidence = buildCompilerReleaseEvidence(fixtures())
  assert.equal(evidence.version, version)
  assert.equal(evidence.commitSha, commitSha)
  assert.equal(evidence.workflowRunId, '301')
  assert.equal(evidence.githubRelease.assets.length, 3)
  assert.equal(evidence.npm.attestationUrl, attestationUrl)
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/)
})

test('rejects incomplete assets, cross-revision workflows, and missing npm provenance', () => {
  const missingAsset = fixtures()
  missingAsset.release.assets.pop()
  assert.throws(
    () => buildCompilerReleaseEvidence(missingAsset),
    /missing the exact compiler evidence assets/,
  )

  const crossRevision = fixtures()
  crossRevision.workflowRuns.workflow_runs[0].head_sha = 'b'.repeat(40)
  assert.throws(
    () => buildCompilerReleaseEvidence(crossRevision),
    /No successful tag-push Release workflow binds/,
  )

  const missingProvenance = fixtures()
  delete missingProvenance.packument.versions[version].dist.attestations
  assert.throws(
    () => buildCompilerReleaseEvidence(missingProvenance),
    /npm does not prove an integrity- and provenance-bound/,
  )
})

test('collects only the canonical public GitHub and npm documents', async () => {
  const source = fixtures()
  const responses = new Map([
    [`https://api.github.com/repos/fictjs/fict/releases/tags/${tag}`, source.release],
    [`https://api.github.com/repos/fictjs/fict/commits/${tag}`, source.commit],
    [
      'https://api.github.com/repos/fictjs/fict/actions/workflows/release.yml/runs?event=push&status=completed&per_page=100',
      source.workflowRuns,
    ],
    ['https://registry.npmjs.org/@fictjs%2fcompiler', source.packument],
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
  const evidence = await collectCompilerReleaseEvidence(version, {
    fetchImpl,
    githubToken: 'test-token',
  })
  assert.equal(evidence.evidenceDigest.length, 71)
  assert.equal(requested.length, 4)
  assert.equal(
    requested.filter(request => request.url.startsWith('https://api.github.com'))[0].options.headers
      .authorization,
    'Bearer test-token',
  )
  assert.equal(
    requested.find(request => request.url.startsWith('https://registry.npmjs.org')).options.headers
      .authorization,
    undefined,
  )
})

test('writes release evidence once, verifies idempotently, and never clobbers it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-release-evidence-'))
  t.after(() => rm(directory, { recursive: true }))
  const outputPath = path.join(directory, 'v0.29.0.json')
  const evidence = buildCompilerReleaseEvidence(fixtures())
  assert.equal(persistCompilerReleaseEvidence(outputPath, evidence), 'Recorded')
  assert.equal(persistCompilerReleaseEvidence(outputPath, evidence), 'Verified')
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidence)
  assert.throws(
    () => persistCompilerReleaseEvidence(outputPath, { ...evidence, workflowRunId: '999' }),
    /Refusing to replace existing compiler release evidence/,
  )
})
