#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertCliArguments } from './strict-cli-arguments.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const registry = 'https://registry.npmjs.org'
export const REQUIRED_REAL_CONSUMER_CORE_PACKAGES = [
  '@fictjs/compiler',
  '@fictjs/runtime',
  '@fictjs/vite-plugin',
  'fict',
].sort()
export const REQUIRED_REAL_CONSUMER_SATELLITE_PACKAGES = ['@fictjs/ssr'].sort()
export const REQUIRED_REAL_CONSUMER_PACKAGES = [
  ...REQUIRED_REAL_CONSUMER_CORE_PACKAGES,
  ...REQUIRED_REAL_CONSUMER_SATELLITE_PACKAGES,
].sort()
const requiredCorePackages = new Set(REQUIRED_REAL_CONSUMER_CORE_PACKAGES)
const REQUIRED_PROJECT_SCRIPTS = ['build', 'typecheck', 'verify:compiler']

function assertStableVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error(`Compiler consumer evidence requires a stable semver version: ${version}`)
  }
}

function assertCommitSha(commitSha) {
  if (!/^[0-9a-f]{40}$/.test(commitSha ?? '')) {
    throw new Error('Compiler consumer evidence requires an exact Git commit SHA')
  }
}

function assertRepositoryName(repositoryName) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName ?? '')) {
    throw new Error('Compiler consumer evidence requires an owner/repository name')
  }
  if (repositoryName.toLowerCase() === 'fictjs/fict') {
    throw new Error('Compiler consumer evidence requires a repository separate from fictjs/fict')
  }
}

function normalizeRepositoryPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must remain inside the consumer repository`)
  }
  return normalized.replace(/^\.\//, '') || '.'
}

function projectFile(projectPath, relativePath) {
  return projectPath === '.' ? relativePath : path.posix.join(projectPath, relativePath)
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function evidenceDigest(payload) {
  return sha256(JSON.stringify(payload))
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
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`)
  return response.json()
}

function decodeGitHubFile(document, label) {
  if (
    document?.type !== 'file' ||
    document.encoding !== 'base64' ||
    typeof document.content !== 'string' ||
    !/^[0-9a-f]{40}$/.test(document.sha ?? '')
  ) {
    throw new Error(`${label} is not a digest-addressed GitHub file`)
  }
  return Buffer.from(document.content.replace(/\s/g, ''), 'base64').toString('utf8')
}

function selectConsumerWorkflowRun(workflowRuns, workflowPath, defaultBranch, commitSha) {
  const matches = (workflowRuns?.workflow_runs ?? [])
    .filter(
      run =>
        run?.path === workflowPath &&
        run.event === 'push' &&
        run.head_branch === defaultBranch &&
        run.head_sha === commitSha &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        Number.isFinite(Date.parse(run.updated_at ?? '')),
    )
    .sort((left, right) => right.id - left.id)
  if (matches.length === 0) {
    throw new Error(`No successful default-branch workflow binds ${workflowPath} to ${commitSha}`)
  }
  return matches[0]
}

function requiredDependencyVersion(manifest, packageName) {
  const declarations = ['dependencies', 'devDependencies', 'peerDependencies']
    .map(group => manifest?.[group]?.[packageName])
    .filter(value => value !== undefined)
  if (declarations.length !== 1) {
    throw new Error(`Real consumer must declare ${packageName} exactly once`)
  }
  return declarations[0]
}

function assertLockfilePackage(lockfile, packageName, version, integrity) {
  const needle = `${packageName}@${version}`
  let offset = lockfile.indexOf(needle)
  while (offset !== -1) {
    if (lockfile.slice(offset, offset + 1_200).includes(`integrity: ${integrity}`)) return
    offset = lockfile.indexOf(needle, offset + needle.length)
  }
  throw new Error(`Real consumer lockfile does not bind ${packageName}@${version} to npm integrity`)
}

function assertConsumerSources(
  { manifest, lockfile, viteConfig, verification, workflow },
  options,
) {
  for (const script of REQUIRED_PROJECT_SCRIPTS) {
    if (typeof manifest?.scripts?.[script] !== 'string' || !manifest.scripts[script].trim()) {
      throw new Error(`Real consumer package.json requires a ${script} script`)
    }
    const command = `pnpm --dir ${options.projectPath} ${script}`
    if (!workflow.includes(command)) {
      throw new Error(`Real consumer workflow must execute ${command}`)
    }
  }
  const installCommand = `pnpm --dir ${options.projectPath} install --frozen-lockfile`
  if (!workflow.includes(installCommand)) {
    throw new Error(`Real consumer workflow must execute ${installCommand}`)
  }
  if (/(?:specifier|version):\s*link:/.test(lockfile)) {
    throw new Error('Real consumer lockfile cannot use workspace links for released packages')
  }
  if (!/from\s+['"]@fictjs\/vite-plugin['"]/.test(viteConfig)) {
    throw new Error('Real consumer Vite config must import @fictjs/vite-plugin')
  }
  if (/FICT_COMPILER_BACKEND|\bbackend\s*:|\/legacy\b|\bshadow\b/.test(viteConfig)) {
    throw new Error('Real consumer Vite config must exercise the published Rust default')
  }
  if (
    !/from\s+['"]@fictjs\/compiler['"]/.test(verification) ||
    !/nativeCompilerInfo\s*\(\s*\)/.test(verification) ||
    !/transformSync\s*\(/.test(verification) ||
    !/backend/.test(verification) ||
    !/['"]rust['"]/.test(verification)
  ) {
    throw new Error('Real consumer verification must prove a Rust native transform')
  }
}

export function buildCompilerConsumerEvidence({
  version,
  repositoryName,
  commitSha,
  workflowPath,
  projectPath,
  repository,
  commit,
  workflowRuns,
  files,
  packuments,
}) {
  assertStableVersion(version)
  assertRepositoryName(repositoryName)
  assertCommitSha(commitSha)
  workflowPath = normalizeRepositoryPath(workflowPath, 'workflow')
  projectPath = normalizeRepositoryPath(projectPath, 'project')
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)) {
    throw new Error('Compiler consumer evidence requires one GitHub Actions workflow file')
  }

  const repositoryUrl = `https://github.com/${repositoryName}`
  if (
    repository?.full_name !== repositoryName ||
    repository.html_url !== repositoryUrl ||
    repository.private !== false ||
    repository.archived !== false ||
    repository.disabled !== false ||
    typeof repository.default_branch !== 'string' ||
    !repository.default_branch
  ) {
    throw new Error('Real consumer repository must be public, active, and reviewable')
  }
  if (commit?.sha !== commitSha || commit.html_url !== `${repositoryUrl}/commit/${commitSha}`) {
    throw new Error('Real consumer commit does not match the requested immutable revision')
  }

  const workflowRun = selectConsumerWorkflowRun(
    workflowRuns,
    workflowPath,
    repository.default_branch,
    commitSha,
  )
  if (workflowRun.html_url !== `${repositoryUrl}/actions/runs/${workflowRun.id}`) {
    throw new Error('Real consumer workflow does not have the canonical GitHub run URL')
  }

  const expectedFilePaths = {
    manifest: projectFile(projectPath, 'package.json'),
    lockfile: projectFile(projectPath, 'pnpm-lock.yaml'),
    viteConfig: projectFile(projectPath, 'vite.config.mjs'),
    verification: projectFile(projectPath, 'scripts/verify-compiler.mjs'),
    workflow: workflowPath,
  }
  const decodedFiles = Object.fromEntries(
    Object.entries(expectedFilePaths).map(([key, filePath]) => [
      key,
      decodeGitHubFile(files?.[key], `Real consumer ${filePath}`),
    ]),
  )
  let manifest
  try {
    manifest = JSON.parse(decodedFiles.manifest)
  } catch {
    throw new Error('Real consumer package.json is not valid JSON')
  }
  if (typeof manifest?.name !== 'string' || !manifest.name) {
    throw new Error('Real consumer package.json requires a package name')
  }
  assertConsumerSources(
    {
      manifest,
      lockfile: decodedFiles.lockfile,
      viteConfig: decodedFiles.viteConfig,
      verification: decodedFiles.verification,
      workflow: decodedFiles.workflow,
    },
    { projectPath },
  )

  const packages = REQUIRED_REAL_CONSUMER_PACKAGES.map(packageName => {
    const declaredVersion = requiredDependencyVersion(manifest, packageName)
    if (requiredCorePackages.has(packageName) && declaredVersion !== version) {
      throw new Error(`Real consumer must pin ${packageName} to exact release ${version}`)
    }
    if (
      !requiredCorePackages.has(packageName) &&
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(declaredVersion)
    ) {
      throw new Error(`Real consumer must pin ${packageName} to one exact stable version`)
    }
    const packageVersion = requiredCorePackages.has(packageName) ? version : declaredVersion
    const packument = packuments?.[packageName]
    const published = packument?.versions?.[packageVersion]
    if (
      published?.name !== packageName ||
      published.version !== packageVersion ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(published.dist?.integrity ?? '') ||
      !Number.isFinite(Date.parse(packument?.time?.[packageVersion] ?? ''))
    ) {
      throw new Error(
        `npm does not prove published real-consumer package ${packageName}@${packageVersion}`,
      )
    }
    assertLockfilePackage(
      decodedFiles.lockfile,
      packageName,
      packageVersion,
      published.dist.integrity,
    )
    return {
      name: packageName,
      version: packageVersion,
      integrity: published.dist.integrity,
      publishedAt: packument.time[packageVersion],
    }
  })
  if (
    packages.some(
      packageEntry => Date.parse(packageEntry.publishedAt) > Date.parse(workflowRun.updated_at),
    )
  ) {
    throw new Error('Real consumer workflow must complete after the compatibility packages publish')
  }

  const payload = {
    schemaVersion: 1,
    status: 'pass',
    release: version,
    repository: repositoryUrl,
    defaultBranch: repository.default_branch,
    commitSha,
    workflow: {
      runId: String(workflowRun.id),
      runAttempt: String(workflowRun.run_attempt),
      path: workflowPath,
      url: workflowRun.html_url,
      completedAt: workflowRun.updated_at,
    },
    project: {
      path: projectPath,
      name: manifest.name,
      scripts: {
        build: manifest.scripts.build,
        typecheck: manifest.scripts.typecheck,
        verifyCompiler: manifest.scripts['verify:compiler'],
      },
    },
    files: Object.fromEntries(
      Object.entries(expectedFilePaths).map(([key, filePath]) => [
        key,
        { path: filePath, digest: sha256(decodedFiles[key]) },
      ]),
    ),
    packages,
  }
  return { ...payload, evidenceDigest: evidenceDigest(payload) }
}

function contentApiPath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

export async function collectCompilerConsumerEvidence(
  options,
  { fetchImpl = fetch, githubToken = process.env.GITHUB_TOKEN } = {},
) {
  const { version, repositoryName, commitSha } = options
  assertStableVersion(version)
  assertRepositoryName(repositoryName)
  assertCommitSha(commitSha)
  const workflowPath = normalizeRepositoryPath(options.workflowPath, 'workflow')
  const projectPath = normalizeRepositoryPath(options.projectPath, 'project')
  const filePaths = {
    manifest: projectFile(projectPath, 'package.json'),
    lockfile: projectFile(projectPath, 'pnpm-lock.yaml'),
    viteConfig: projectFile(projectPath, 'vite.config.mjs'),
    verification: projectFile(projectPath, 'scripts/verify-compiler.mjs'),
    workflow: workflowPath,
  }
  const githubApi = `https://api.github.com/repos/${repositoryName}`
  const headers = githubHeaders(githubToken)
  const [repository, commit, workflowRuns, fileEntries, packageEntries] = await Promise.all([
    fetchJson(githubApi, 'GitHub consumer repository', { fetchImpl, headers }),
    fetchJson(`${githubApi}/commits/${commitSha}`, 'GitHub consumer commit', {
      fetchImpl,
      headers,
    }),
    fetchJson(
      `${githubApi}/actions/runs?event=push&status=completed&per_page=100`,
      'GitHub consumer workflow runs',
      { fetchImpl, headers },
    ),
    Promise.all(
      Object.entries(filePaths).map(async ([key, filePath]) => [
        key,
        await fetchJson(
          `${githubApi}/contents/${contentApiPath(filePath)}?ref=${commitSha}`,
          `GitHub consumer ${filePath}`,
          { fetchImpl, headers },
        ),
      ]),
    ),
    Promise.all(
      REQUIRED_REAL_CONSUMER_PACKAGES.map(async packageName => [
        packageName,
        await fetchJson(
          `${registry}/${encodeURIComponent(packageName)}`,
          `npm ${packageName} packument`,
          { fetchImpl },
        ),
      ]),
    ),
  ])
  return buildCompilerConsumerEvidence({
    version,
    repositoryName,
    commitSha,
    workflowPath,
    projectPath,
    repository,
    commit,
    workflowRuns,
    files: Object.fromEntries(fileEntries),
    packuments: Object.fromEntries(packageEntries),
  })
}

function argumentValue(arguments_, name) {
  const prefix = `--${name}=`
  const inline = arguments_.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = arguments_.indexOf(`--${name}`)
  return index === -1 ? undefined : arguments_[index + 1]
}

function resolveOutputPath(version, output) {
  const relative = output ?? `.github/compiler-consumer-evidence/v${version}.json`
  if (path.isAbsolute(relative))
    throw new Error('Compiler consumer evidence output must be relative')
  const resolved = path.resolve(root, relative)
  const workspaceRelative = path.relative(root, resolved)
  if (
    workspaceRelative === '..' ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative)
  ) {
    throw new Error('Compiler consumer evidence output must remain inside the workspace')
  }
  return resolved
}

export function persistCompilerConsumerEvidence(outputPath, evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`
  if (existsSync(outputPath)) {
    if (readFileSync(outputPath, 'utf8') !== serialized) {
      throw new Error(`Refusing to replace existing compiler consumer evidence: ${outputPath}`)
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
    command: 'compiler consumer evidence',
    valueArguments: ['version', 'repository', 'commit', 'workflow', 'project', 'output'],
  })
  const options = {
    version: argumentValue(arguments_, 'version'),
    repositoryName: argumentValue(arguments_, 'repository'),
    commitSha: argumentValue(arguments_, 'commit'),
    workflowPath: argumentValue(arguments_, 'workflow'),
    projectPath: argumentValue(arguments_, 'project'),
  }
  for (const [name, value] of [
    ['version', options.version],
    ['repository', options.repositoryName],
    ['commit', options.commitSha],
    ['workflow', options.workflowPath],
    ['project', options.projectPath],
  ]) {
    if (!value) throw new Error(`Compiler consumer evidence requires --${name}`)
  }
  const outputPath = resolveOutputPath(options.version, argumentValue(arguments_, 'output'))
  const evidence = await collectCompilerConsumerEvidence(options)
  const action = persistCompilerConsumerEvidence(outputPath, evidence)
  process.stdout.write(
    `[compiler-consumer-evidence] ${action} ${evidence.repository}@${evidence.commitSha} for ${evidence.release} as ${path.relative(root, outputPath)} (${evidence.evidenceDigest}).\n`,
  )
}
