#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertCliArguments } from './strict-cli-arguments.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repository = 'fictjs/fict'
const compilerPackage = '@fictjs/compiler'
const registry = 'https://registry.npmjs.org'
export const REQUIRED_COMPILER_RELEASE_ASSETS = [
  'native-certification.json',
  'npm-publish-plan.json',
  'release-artifacts.json',
].sort()

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertStableVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error(`Compiler release evidence requires a stable semver version: ${version}`)
  }
}

function assertSha256(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) {
    throw new Error(`${label} must be a sha256 digest`)
  }
}

function evidenceDigest(payload) {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchJson(url, label, { fetchImpl, headers = {} }) {
  const response = await fetchImpl(url, { headers })
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`)
  }
  return response.json()
}

function selectReleaseWorkflowRun(workflowRuns, tag, commitSha) {
  const matches = (workflowRuns?.workflow_runs ?? [])
    .filter(
      run =>
        run?.path === '.github/workflows/release.yml' &&
        run.event === 'push' &&
        run.head_branch === tag &&
        run.head_sha === commitSha &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        Number.isSafeInteger(run.id) &&
        run.id > 0,
    )
    .sort((left, right) => right.id - left.id)
  if (matches.length === 0) {
    throw new Error(`No successful tag-push Release workflow binds ${tag} to ${commitSha}`)
  }
  return matches[0]
}

export function buildCompilerReleaseEvidence({
  version,
  release,
  commit,
  workflowRuns,
  packument,
}) {
  assertStableVersion(version)
  const tag = `v${version}`
  const expectedReleaseUrl = `https://github.com/${repository}/releases/tag/${tag}`
  if (
    !isRecord(release) ||
    release.tag_name !== tag ||
    release.html_url !== expectedReleaseUrl ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Number.isFinite(Date.parse(release.published_at ?? ''))
  ) {
    throw new Error(`GitHub Release does not prove published stable tag ${tag}`)
  }
  if (!/^[0-9a-f]{40}$/.test(commit?.sha ?? '')) {
    throw new Error(`GitHub tag ${tag} does not resolve to a commit SHA`)
  }

  const assets = release.assets
  if (
    !Array.isArray(assets) ||
    JSON.stringify(assets.map(asset => asset?.name).sort()) !==
      JSON.stringify(REQUIRED_COMPILER_RELEASE_ASSETS)
  ) {
    throw new Error(`GitHub Release ${tag} is missing the exact compiler evidence assets`)
  }
  const normalizedAssets = assets
    .map(asset => {
      assertSha256(asset?.digest, `GitHub Release asset ${asset?.name}`)
      if (
        !Number.isSafeInteger(asset?.id) ||
        asset.id <= 0 ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        asset.state !== 'uploaded'
      ) {
        throw new Error(
          `GitHub Release asset ${asset?.name} is not an uploaded digest-bound record`,
        )
      }
      return { name: asset.name, id: asset.id, size: asset.size, digest: asset.digest }
    })
    .sort((left, right) => left.name.localeCompare(right.name))

  const workflowRun = selectReleaseWorkflowRun(workflowRuns, tag, commit.sha)
  const manifest = packument?.versions?.[version]
  const attestationUrl = `${registry}/-/npm/v1/attestations/@fictjs%2fcompiler@${version}`
  if (
    !isRecord(manifest) ||
    manifest.name !== compilerPackage ||
    manifest.version !== version ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.dist?.integrity ?? '') ||
    manifest.dist?.attestations?.url !== attestationUrl ||
    manifest.dist.attestations.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !Number.isFinite(Date.parse(packument?.time?.[version] ?? ''))
  ) {
    throw new Error(
      `npm does not prove an integrity- and provenance-bound ${compilerPackage}@${version}`,
    )
  }

  const payload = {
    schemaVersion: 1,
    status: 'pass',
    version,
    tag,
    commitSha: commit.sha,
    workflowRunId: String(workflowRun.id),
    githubRelease: {
      id: release.id,
      url: release.html_url,
      publishedAt: release.published_at,
      assets: normalizedAssets,
    },
    npm: {
      packageName: compilerPackage,
      version,
      integrity: manifest.dist.integrity,
      provenance: true,
      attestationUrl,
      publishedAt: packument.time[version],
    },
  }
  return { ...payload, evidenceDigest: evidenceDigest(payload) }
}

export async function collectCompilerReleaseEvidence(
  version,
  { fetchImpl = fetch, githubToken = process.env.GITHUB_TOKEN } = {},
) {
  assertStableVersion(version)
  const tag = `v${version}`
  const githubApi = `https://api.github.com/repos/${repository}`
  const headers = githubHeaders(githubToken)
  const [release, commit, workflowRuns, packument] = await Promise.all([
    fetchJson(`${githubApi}/releases/tags/${tag}`, 'GitHub Release', { fetchImpl, headers }),
    fetchJson(`${githubApi}/commits/${tag}`, 'GitHub tag commit', { fetchImpl, headers }),
    fetchJson(
      `${githubApi}/actions/workflows/release.yml/runs?event=push&status=completed&per_page=100`,
      'GitHub Release workflow runs',
      { fetchImpl, headers },
    ),
    fetchJson(`${registry}/@fictjs%2fcompiler`, 'npm compiler packument', { fetchImpl }),
  ])
  return buildCompilerReleaseEvidence({ version, release, commit, workflowRuns, packument })
}

function argumentValue(arguments_, name) {
  const prefix = `--${name}=`
  const inline = arguments_.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = arguments_.indexOf(`--${name}`)
  return index === -1 ? undefined : arguments_[index + 1]
}

function resolveOutputPath(version, output) {
  const relative = output ?? `.github/compiler-release-evidence/v${version}.json`
  if (path.isAbsolute(relative))
    throw new Error('Compiler release evidence output must be relative')
  const resolved = path.resolve(root, relative)
  const workspaceRelative = path.relative(root, resolved)
  if (
    workspaceRelative === '..' ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative)
  ) {
    throw new Error('Compiler release evidence output must remain inside the workspace')
  }
  return resolved
}

export function persistCompilerReleaseEvidence(outputPath, evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`
  if (existsSync(outputPath)) {
    const existing = readFileSync(outputPath, 'utf8')
    if (existing !== serialized) {
      throw new Error(`Refusing to replace existing compiler release evidence: ${outputPath}`)
    }
    return 'Verified'
  }
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, serialized)
  return 'Recorded'
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const arguments_ = process.argv.slice(2)
  assertCliArguments(arguments_, {
    command: 'compiler release evidence',
    valueArguments: ['version', 'output'],
  })
  const version = argumentValue(arguments_, 'version')
  if (!version) throw new Error('Compiler release evidence requires --version')
  const outputPath = resolveOutputPath(version, argumentValue(arguments_, 'output'))
  const evidence = await collectCompilerReleaseEvidence(version)
  const action = persistCompilerReleaseEvidence(outputPath, evidence)
  process.stdout.write(
    `[compiler-release-evidence] ${action} ${evidence.tag} as ${path.relative(root, outputPath)} (${evidence.evidenceDigest}).\n`,
  )
}
