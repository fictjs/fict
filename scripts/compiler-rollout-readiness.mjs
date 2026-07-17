#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NATIVE_COMPILER_NODE_LANES,
  NATIVE_COMPILER_TARGETS,
  nativeNodeVersionMatchesLane,
} from './native-compiler-packages.mjs'
import {
  REQUIRED_REAL_CONSUMER_CORE_PACKAGES,
  REQUIRED_REAL_CONSUMER_PACKAGES,
} from './compiler-consumer-evidence.mjs'
import { assertCliArguments } from './strict-cli-arguments.mjs'

// The rollout-candidate CI harness was retired with the legacy backend. Keep the
// historical schema validator here because the immutable M7 approval remains an
// input to the M9 removal decision.
export const REQUIRED_ROLLOUT_JOBS = Object.freeze([
  'rust-fuzz',
  'rust-native',
  'compiler-rollout',
  'lint',
  'typecheck',
  'strict-guarantee',
  'perf-guardrails',
  'test',
  'e2e',
  'test-opt-out',
  'test-ssr-edge',
  'build',
])

const HISTORICAL_WORKFLOW_GATE_FIELDS = Object.freeze([
  'jobs',
  'repository',
  'runAttempt',
  'runId',
  'schemaVersion',
  'sourceRef',
  'sourceRevision',
  'status',
  'workflowEvent',
  'workflowJob',
  'workflowName',
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requiredRealConsumerCorePackages = new Set(REQUIRED_REAL_CONSUMER_CORE_PACKAGES)
const REQUIRED_REVIEW_AREAS = [
  'coreSemantics',
  'strictGuarantee',
  'typescriptNamespacesAndCts',
  'runtimeAndMetadataAbi',
  'sourceMaps',
  'nativePlatformsAndRelease',
  'nativePackageSizeBudget',
  'performanceAndRss',
  'rollbackDrill',
].sort()
const REQUIRED_LEGACY_REMOVAL_AREAS = [
  'replacementAvailability',
  'migrationGuidance',
  'candidateAndRollbackEvidence',
  'rustDefaultPublished',
  'subsequentMinorCompleted',
  'finalPresetPublished',
  'coreScopeChanges',
  'legacyDependencyRemoval',
].sort()
const REQUIRED_NATIVE_ROOT_APIS = [
  'nativeCompilerInfo',
  'transformSync',
  'transform',
  'scanSync',
  'scan',
  'analyzeSync',
  'analyze',
]
const REQUIRED_RELEASE_EVIDENCE_ASSETS = [
  'native-certification.json',
  'npm-publish-plan.json',
  'release-artifacts.json',
].sort()

function readJson(filename, label) {
  if (!existsSync(filename)) throw new Error(`${label} does not exist: ${filename}`)
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function resolveWorkspaceStatePath(workspaceRoot, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty workspace-relative path`)
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must remain inside the workspace`)
  }
  const resolved = path.resolve(workspaceRoot, value)
  const relative = path.relative(workspaceRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the workspace`)
  }
  return resolved
}

function assertAreaShape(areas, requiredAreas, label) {
  const areaNames = Object.keys(areas ?? {}).sort()
  if (JSON.stringify(areaNames) !== JSON.stringify(requiredAreas)) {
    throw new Error(`${label} does not use the required review areas`)
  }
  if (Object.values(areas).some(value => typeof value !== 'boolean')) {
    throw new Error(`${label} review areas must be boolean`)
  }
}

function isSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? '')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateWorkflowGateArtifact(artifact, expected = {}) {
  if (!isRecord(artifact)) throw new Error('Compiler rollout workflow gate must be an object')
  if (
    JSON.stringify(Object.keys(artifact).sort()) !==
    JSON.stringify([...HISTORICAL_WORKFLOW_GATE_FIELDS])
  ) {
    throw new Error('Compiler rollout workflow gate has an unsupported field shape')
  }
  if (artifact.schemaVersion !== 1 || artifact.status !== 'pass') {
    throw new Error('Compiler rollout workflow gate did not pass')
  }
  if (
    artifact.repository !== 'fictjs/fict' ||
    artifact.workflowName !== 'CI' ||
    artifact.workflowJob !== 'compiler-rollout-finalize'
  ) {
    throw new Error('Workflow gate must originate from the canonical Fict CI finalizer')
  }
  if (typeof artifact.runId !== 'string' || !/^\d+$/.test(artifact.runId)) {
    throw new Error('Workflow gate run id must be numeric')
  }
  if (
    typeof artifact.runAttempt !== 'string' ||
    !/^\d+$/.test(artifact.runAttempt) ||
    BigInt(artifact.runAttempt) < 1n
  ) {
    throw new Error('Workflow gate run attempt must be a positive integer')
  }
  if (!/^[0-9a-f]{40}$/.test(artifact.sourceRevision ?? '')) {
    throw new Error('Workflow gate source revision must be a git SHA-1')
  }
  if (typeof artifact.workflowEvent !== 'string' || !artifact.workflowEvent) {
    throw new Error('Workflow gate event is required')
  }
  if (!/^refs\//.test(artifact.sourceRef ?? '')) {
    throw new Error('Workflow gate source ref must be a full Git ref')
  }

  if (!isRecord(artifact.jobs)) {
    throw new Error('Compiler rollout workflow jobs must be an object')
  }
  const actualJobs = Object.keys(artifact.jobs).sort()
  const expectedJobs = [...REQUIRED_ROLLOUT_JOBS].sort()
  if (JSON.stringify(actualJobs) !== JSON.stringify(expectedJobs)) {
    throw new Error('Compiler rollout finalizer does not bind the exact required CI job set')
  }
  for (const job of REQUIRED_ROLLOUT_JOBS) {
    const result = artifact.jobs[job]
    const allowed = job === 'rust-fuzz' ? ['success', 'skipped'] : ['success']
    if (typeof result !== 'string' || !allowed.includes(result)) {
      throw new Error(`Compiler rollout CI job ${job} did not pass: ${String(result)}`)
    }
  }

  for (const field of ['runId', 'runAttempt', 'sourceRevision', 'workflowEvent', 'sourceRef']) {
    if (expected[field] !== undefined && String(artifact[field]) !== String(expected[field])) {
      throw new Error(`Compiler rollout workflow gate does not bind ${field}`)
    }
  }
}

function assertPublishedReleaseEvidence(entry, version, label, workspaceRoot) {
  const expectedUrl = `https://github.com/fictjs/fict/releases/tag/v${version}`
  const expectedAttestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/@fictjs%2fcompiler@${version}`
  const releaseAssets = entry?.githubRelease?.assets
  const expectedKeys = [
    'commitSha',
    'evidenceDigest',
    'githubRelease',
    'npm',
    'schemaVersion',
    'status',
    'tag',
    'version',
    'workflowRunId',
  ].sort()
  const { evidenceDigest, ...payload } = entry ?? {}
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  if (
    !entry ||
    entry.schemaVersion !== 1 ||
    entry.status !== 'pass' ||
    JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys) ||
    evidenceDigest !== computedDigest ||
    entry.version !== version ||
    entry.tag !== `v${version}` ||
    !/^[0-9a-f]{40}$/.test(entry.commitSha ?? '') ||
    typeof entry.workflowRunId !== 'string' ||
    !/^\d+$/.test(entry.workflowRunId) ||
    !Number.isSafeInteger(entry.githubRelease?.id) ||
    entry.githubRelease.id <= 0 ||
    entry.githubRelease.url !== expectedUrl ||
    !Number.isFinite(Date.parse(entry.githubRelease.publishedAt ?? '')) ||
    !Array.isArray(releaseAssets) ||
    JSON.stringify(releaseAssets.map(asset => asset?.name).sort()) !==
      JSON.stringify(REQUIRED_RELEASE_EVIDENCE_ASSETS) ||
    releaseAssets.some(
      asset =>
        !Number.isSafeInteger(asset?.id) ||
        asset.id <= 0 ||
        !Number.isSafeInteger(asset?.size) ||
        asset.size <= 0 ||
        !isSha256(asset?.digest),
    ) ||
    entry.npm?.packageName !== '@fictjs/compiler' ||
    entry.npm.version !== version ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.npm.integrity ?? '') ||
    entry.npm.provenance !== true ||
    entry.npm.attestationUrl !== expectedAttestationUrl ||
    !Number.isFinite(Date.parse(entry.npm.publishedAt ?? ''))
  ) {
    throw new Error(`Legacy-removal evidence has invalid ${label} publication proof`)
  }
  const recordedPath = path.join(
    workspaceRoot,
    '.github',
    'compiler-release-evidence',
    `v${version}.json`,
  )
  const recorded = readJson(recordedPath, `${label} recorded publication evidence`)
  if (JSON.stringify(recorded) !== JSON.stringify(entry)) {
    throw new Error(`Legacy-removal evidence does not match the recorded ${label} publication`)
  }
}

function isRepositoryRelativePath(value, allowRoot = false) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) return false
  return allowRoot || normalized !== '.'
}

function consumerProjectFile(projectPath, relativePath) {
  return projectPath === '.' ? relativePath : path.posix.join(projectPath, relativePath)
}

function assertRecordedConsumerEvidence(summary, version, workspaceRoot) {
  const recordedPath = path.join(
    workspaceRoot,
    '.github',
    'compiler-consumer-evidence',
    `v${version}.json`,
  )
  const entry = readJson(recordedPath, 'real-consumer recorded evidence')
  const expectedKeys = [
    'commitSha',
    'defaultBranch',
    'evidenceDigest',
    'files',
    'packages',
    'project',
    'release',
    'repository',
    'schemaVersion',
    'status',
    'workflow',
  ].sort()
  const { evidenceDigest, ...payload } = entry ?? {}
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  const expectedFileKeys = ['lockfile', 'manifest', 'verification', 'viteConfig', 'workflow'].sort()
  const expectedPackageNames = [...REQUIRED_REAL_CONSUMER_PACKAGES].sort()
  const projectPath = entry?.project?.path
  const workflowPath = entry?.workflow?.path
  const files = entry?.files
  const packages = entry?.packages
  const projectScripts = entry?.project?.scripts
  const repositoryUrl = entry?.repository
  if (
    entry?.schemaVersion !== 1 ||
    entry.status !== 'pass' ||
    JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys) ||
    evidenceDigest !== computedDigest ||
    entry.release !== version ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repositoryUrl ?? '') ||
    repositoryUrl.toLowerCase() === 'https://github.com/fictjs/fict' ||
    typeof entry.defaultBranch !== 'string' ||
    !entry.defaultBranch ||
    !/^[0-9a-f]{40}$/.test(entry.commitSha ?? '') ||
    !entry.workflow ||
    JSON.stringify(Object.keys(entry.workflow).sort()) !==
      JSON.stringify(['completedAt', 'path', 'runAttempt', 'runId', 'url'].sort()) ||
    typeof entry.workflow.runId !== 'string' ||
    !/^\d+$/.test(entry.workflow.runId) ||
    typeof entry.workflow.runAttempt !== 'string' ||
    !/^\d+$/.test(entry.workflow.runAttempt) ||
    !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath ?? '') ||
    entry.workflow.url !== `${repositoryUrl}/actions/runs/${entry.workflow.runId}` ||
    !Number.isFinite(Date.parse(entry.workflow.completedAt ?? '')) ||
    !entry.project ||
    JSON.stringify(Object.keys(entry.project).sort()) !==
      JSON.stringify(['name', 'path', 'scripts'].sort()) ||
    !isRepositoryRelativePath(projectPath, true) ||
    typeof entry.project.name !== 'string' ||
    !entry.project.name ||
    JSON.stringify(Object.keys(projectScripts ?? {}).sort()) !==
      JSON.stringify(['build', 'typecheck', 'verifyCompiler'].sort()) ||
    Object.values(projectScripts ?? {}).some(value => typeof value !== 'string' || !value) ||
    !files ||
    JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(expectedFileKeys) ||
    Object.values(files).some(
      file =>
        !file ||
        JSON.stringify(Object.keys(file).sort()) !== JSON.stringify(['digest', 'path']) ||
        !isRepositoryRelativePath(file.path) ||
        !isSha256(file.digest),
    ) ||
    files.manifest.path !== consumerProjectFile(projectPath, 'package.json') ||
    files.lockfile.path !== consumerProjectFile(projectPath, 'pnpm-lock.yaml') ||
    files.viteConfig.path !== consumerProjectFile(projectPath, 'vite.config.mjs') ||
    files.verification.path !== consumerProjectFile(projectPath, 'scripts/verify-compiler.mjs') ||
    files.workflow.path !== workflowPath ||
    !Array.isArray(packages) ||
    JSON.stringify(packages.map(packageEntry => packageEntry?.name).sort()) !==
      JSON.stringify(expectedPackageNames) ||
    packages.some(
      packageEntry =>
        !packageEntry ||
        JSON.stringify(Object.keys(packageEntry).sort()) !==
          JSON.stringify(['integrity', 'name', 'publishedAt', 'version'].sort()) ||
        (requiredRealConsumerCorePackages.has(packageEntry.name)
          ? packageEntry.version !== version
          : !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageEntry.version ?? '')) ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packageEntry.integrity ?? '') ||
        !Number.isFinite(Date.parse(packageEntry.publishedAt ?? '')) ||
        Date.parse(packageEntry.publishedAt) > Date.parse(entry.workflow.completedAt),
    )
  ) {
    throw new Error('Legacy-removal evidence has invalid recorded real-consumer validation')
  }
  const expectedSummary = {
    release: version,
    repository: entry.repository,
    commitSha: entry.commitSha,
    status: 'pass',
    evidenceDigest: entry.evidenceDigest,
  }
  if (JSON.stringify(summary) !== JSON.stringify(expectedSummary)) {
    throw new Error('Legacy-removal evidence does not match the recorded real-consumer validation')
  }
}

function assertPassArtifact(artifact, label, release, sourceRevision, workspaceRoot, kind) {
  const proofPath = path.join(
    workspaceRoot,
    '.github',
    'compiler-legacy-removal-evidence',
    `v${release}-${kind}.json`,
  )
  const proof = readJson(proofPath, `${label} record`)
  const expectedProofKeys = [
    'artifacts',
    'command',
    'evidenceDigest',
    'inputs',
    'kind',
    'release',
    'schemaVersion',
    'sourceRevision',
    'status',
    'workflow',
  ].sort()
  const { evidenceDigest, ...payload } = proof ?? {}
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  const workflow = proof?.workflow
  const job = workflow?.job
  const step = job?.step
  const inputs = proof?.inputs
  const artifacts = proof?.artifacts
  const expectedRunUrl = `https://github.com/fictjs/fict/actions/runs/${workflow?.runId}`
  const expectedJobUrl = `${expectedRunUrl}/job/${job?.id}`
  const validInputs =
    Array.isArray(inputs) &&
    inputs.length > 0 &&
    inputs.every(
      input =>
        input &&
        JSON.stringify(Object.keys(input).sort()) === JSON.stringify(['digest', 'path']) &&
        isRepositoryRelativePath(input.path) &&
        isSha256(input.digest),
    )
  const validArtifacts =
    Array.isArray(artifacts) &&
    artifacts.every(
      entry =>
        entry &&
        JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify(['createdAt', 'digest', 'id', 'name', 'sizeBytes'].sort()) &&
        Number.isSafeInteger(entry.id) &&
        entry.id > 0 &&
        typeof entry.name === 'string' &&
        Boolean(entry.name) &&
        Number.isSafeInteger(entry.sizeBytes) &&
        entry.sizeBytes > 0 &&
        isSha256(entry.digest) &&
        Number.isFinite(Date.parse(entry.createdAt ?? '')),
    )
  const requiresRawArtifact = kind === 'rollback-drill' || kind === 'performance-rss'
  if (
    !artifact ||
    artifact.release !== release ||
    artifact.status !== 'pass' ||
    artifact.evidenceDigest !== proof?.evidenceDigest ||
    proof?.schemaVersion !== 1 ||
    proof.status !== 'pass' ||
    proof.kind !== kind ||
    proof.release !== release ||
    proof.sourceRevision !== sourceRevision ||
    JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedProofKeys) ||
    evidenceDigest !== computedDigest ||
    typeof proof.command !== 'string' ||
    !proof.command ||
    !validInputs ||
    !validArtifacts ||
    (requiresRawArtifact &&
      !artifacts.some(entry => entry.name === 'compiler-rollout-raw-evidence')) ||
    workflow?.repository !== 'fictjs/fict' ||
    workflow.event !== 'push' ||
    workflow.conclusion !== 'success' ||
    typeof workflow.runId !== 'string' ||
    !/^\d+$/.test(workflow.runId) ||
    typeof workflow.runAttempt !== 'string' ||
    !/^\d+$/.test(workflow.runAttempt) ||
    BigInt(workflow.runAttempt) < 1n ||
    workflow.url !== expectedRunUrl ||
    !Number.isSafeInteger(job?.id) ||
    job.id <= 0 ||
    typeof job.name !== 'string' ||
    !job.name ||
    job.url !== expectedJobUrl ||
    job.conclusion !== 'success' ||
    !Number.isFinite(Date.parse(job.startedAt ?? '')) ||
    !Number.isFinite(Date.parse(job.completedAt ?? '')) ||
    Date.parse(job.completedAt) < Date.parse(job.startedAt) ||
    typeof step?.name !== 'string' ||
    !step.name ||
    step.conclusion !== 'success'
  ) {
    throw new Error(`Legacy-removal evidence has invalid ${label}`)
  }
}

function assertLegacyRemovalEvidenceDocumentShape(evidence, workspaceRoot) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Compiler legacy-removal evidence has an unsupported schema or status')
  }
  if (evidence.status === 'pending') {
    const pendingKeys = Object.keys(evidence).sort()
    if (
      evidence.schemaVersion !== 1 ||
      evidence.evidenceDigest !== null ||
      JSON.stringify(pendingKeys) !== JSON.stringify(['evidenceDigest', 'schemaVersion', 'status'])
    ) {
      throw new Error('Pending legacy-removal evidence cannot contain partial claims')
    }
    return
  }

  const expectedKeys = [
    'compatibilityRelease',
    'consumerValidation',
    'evidenceDigest',
    'finalLegacyRelease',
    'finalPreset',
    'legacyRemovalRelease',
    'migrationGuidance',
    'nativeCertification',
    'performanceAndRss',
    'publishedReleases',
    'rollbackDrill',
    'rustDefaultRelease',
    'schemaVersion',
    'sourceMaps',
    'status',
  ].sort()
  const { evidenceDigest, ...payload } = evidence
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  if (
    payload.schemaVersion !== 1 ||
    payload.status !== 'pass' ||
    JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys) ||
    evidenceDigest !== computedDigest
  ) {
    throw new Error('Legacy-removal evidence must be one intact digest-bound record')
  }

  const rustDefault = parseStableRelease(payload.rustDefaultRelease, 'evidence rustDefaultRelease')
  const compatibility = parseStableRelease(
    payload.compatibilityRelease,
    'evidence compatibilityRelease',
  )
  const finalLegacy = parseStableRelease(payload.finalLegacyRelease, 'evidence finalLegacyRelease')
  parseStableRelease(payload.legacyRemovalRelease, 'evidence legacyRemovalRelease')
  assertPublishedReleaseEvidence(
    payload.publishedReleases?.rustDefault,
    rustDefault.value,
    'Rust-default release',
    workspaceRoot,
  )
  assertPublishedReleaseEvidence(
    payload.publishedReleases?.compatibility,
    compatibility.value,
    'compatibility release',
    workspaceRoot,
  )
  assertPublishedReleaseEvidence(
    payload.publishedReleases?.finalLegacy,
    finalLegacy.value,
    'final legacy release',
    workspaceRoot,
  )

  const native = payload.nativeCertification
  const finalLegacyPublication = payload.publishedReleases.finalLegacy
  if (
    !native ||
    native.release !== finalLegacy.value ||
    typeof native.workflowRunId !== 'string' ||
    !/^\d+$/.test(native.workflowRunId) ||
    !/^[0-9a-f]{40}$/.test(native.sourceRevision ?? '') ||
    native.workflowRunId !== finalLegacyPublication.workflowRunId ||
    native.sourceRevision !== finalLegacyPublication.commitSha ||
    !isSha256(native.certificationDigest) ||
    native.targets !== NATIVE_COMPILER_TARGETS.length ||
    JSON.stringify(native.nodeLanes) !== JSON.stringify(NATIVE_COMPILER_NODE_LANES) ||
    native.certifications !== NATIVE_COMPILER_TARGETS.length * NATIVE_COMPILER_NODE_LANES.length
  ) {
    throw new Error('Legacy-removal evidence has invalid native certification proof')
  }

  assertRecordedConsumerEvidence(payload.consumerValidation, compatibility.value, workspaceRoot)
  assertPassArtifact(
    payload.rollbackDrill,
    'rollback drill proof',
    finalLegacy.value,
    finalLegacyPublication.commitSha,
    workspaceRoot,
    'rollback-drill',
  )
  assertPassArtifact(
    payload.sourceMaps,
    'source-map proof',
    finalLegacy.value,
    finalLegacyPublication.commitSha,
    workspaceRoot,
    'source-maps',
  )
  assertPassArtifact(
    payload.performanceAndRss,
    'performance/RSS proof',
    finalLegacy.value,
    finalLegacyPublication.commitSha,
    workspaceRoot,
    'performance-rss',
  )

  const guidance = payload.migrationGuidance
  const guidancePath = resolveWorkspaceStatePath(
    workspaceRoot,
    guidance?.path,
    'migrationGuidance.path',
  )
  if (!existsSync(guidancePath)) {
    throw new Error('Legacy-removal migration guidance does not exist')
  }
  const guidanceDigest = `sha256:${createHash('sha256')
    .update(readFileSync(guidancePath))
    .digest('hex')}`
  if (guidance.digest !== guidanceDigest) {
    throw new Error('Legacy-removal migration guidance digest does not match')
  }

  const preset = payload.finalPreset
  if (
    !preset ||
    preset.packageName !== '@fictjs/babel-preset' ||
    preset.version !== finalLegacy.value ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(preset.integrity ?? '') ||
    preset.provenance !== true
  ) {
    throw new Error('Legacy-removal evidence has invalid final preset publication proof')
  }
}

function assertReviewDocumentShape(review) {
  if (review.schemaVersion !== 3 || !['pending', 'approved'].includes(review.status)) {
    throw new Error('Compiler rollout review has an unsupported schema or status')
  }
  assertAreaShape(review.areas, REQUIRED_REVIEW_AREAS, 'Reviewer checklist')
  if (
    review.status === 'pending' &&
    (review.candidateDigest !== null ||
      review.nativeCertificationDigest !== null ||
      review.reviewer !== null ||
      Object.values(review.areas).some(Boolean))
  ) {
    throw new Error('Pending compiler rollout review cannot contain partial approval')
  }
  if (
    review.status === 'approved' &&
    (typeof review.reviewer !== 'string' ||
      !review.reviewer.trim() ||
      !/^sha256:[0-9a-f]{64}$/.test(review.candidateDigest ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(review.nativeCertificationDigest ?? ''))
  ) {
    throw new Error('Approved compiler rollout review must be complete and digest-bound')
  }
  if (review.status === 'approved') {
    const missingAreas = Object.entries(review.areas)
      .filter(([, approved]) => approved !== true)
      .map(([area]) => area)
    if (missingAreas.length > 0) {
      throw new Error(`Approved compiler rollout review is incomplete: ${missingAreas.join(', ')}`)
    }
  }
}

function assertLegacyRemovalReviewDocumentShape(review) {
  if (review.schemaVersion !== 2 || !['pending', 'approved'].includes(review.status)) {
    throw new Error('Compiler legacy-removal review has an unsupported schema or status')
  }
  assertAreaShape(review.areas, REQUIRED_LEGACY_REMOVAL_AREAS, 'Legacy-removal checklist')
  if (
    review.status === 'pending' &&
    (review.reviewer !== null ||
      review.evidenceDigest !== null ||
      [
        review.rustDefaultRelease,
        review.compatibilityRelease,
        review.finalLegacyRelease,
        review.legacyRemovalRelease,
      ].some(value => value !== null) ||
      Object.values(review.areas).some(Boolean))
  ) {
    throw new Error('Pending legacy-removal review cannot contain partial approval')
  }
  if (review.status === 'approved') {
    if (
      typeof review.reviewer !== 'string' ||
      !review.reviewer.trim() ||
      !isSha256(review.evidenceDigest)
    ) {
      throw new Error('Approved legacy-removal review must have a complete human checklist')
    }
    const missingAreas = Object.entries(review.areas)
      .filter(([, approved]) => approved !== true)
      .map(([area]) => area)
    if (missingAreas.length > 0) {
      throw new Error(`Approved legacy-removal review is incomplete: ${missingAreas.join(', ')}`)
    }
    for (const field of [
      'rustDefaultRelease',
      'compatibilityRelease',
      'finalLegacyRelease',
      'legacyRemovalRelease',
    ]) {
      parseStableRelease(review[field], `legacy-removal review ${field}`)
    }
  }
}

function assertReview(review, evidence, nativeCertification) {
  if (
    review.schemaVersion !== 3 ||
    review.status !== 'approved' ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim()
  ) {
    throw new Error('Rust-default rollout requires an explicit human reviewer approval')
  }
  if (review.candidateDigest !== evidence.candidateDigest) {
    throw new Error('Reviewer approval does not bind the current candidate evidence')
  }
  if (review.nativeCertificationDigest !== nativeCertification.certificationDigest) {
    throw new Error('Reviewer approval does not bind the current native certification')
  }
  const reviewAreas = review.areas ?? {}
  const missingAreas = Object.entries(reviewAreas)
    .filter(([, approved]) => approved !== true)
    .map(([area]) => area)
  if (missingAreas.length > 0) {
    throw new Error(`Reviewer checklist is incomplete: ${missingAreas.join(', ')}`)
  }
}

function assertNativeCertification(certification, evidence) {
  if (!certification || typeof certification !== 'object' || Array.isArray(certification)) {
    throw new Error('Rust-default rollout requires one intact complete native certification')
  }
  const { certificationDigest, ...payload } = certification
  const expectedPairs = NATIVE_COMPILER_TARGETS.flatMap(target =>
    NATIVE_COMPILER_NODE_LANES.map(nodeLane => `${target.target}:node-${nodeLane}`),
  )
  const expectedRuntimeEvidence = NATIVE_COMPILER_TARGETS.flatMap(target =>
    NATIVE_COMPILER_NODE_LANES.map(nodeLane => ({
      pair: `${target.target}:node-${nodeLane}`,
      target: target.target,
      nodeLane,
    })),
  )
  const releaseBundles = payload.releaseBundles
  const runtimeEvidence = payload.runtimeEvidence
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  const hasValidEnvelope =
    payload.schemaVersion === 2 &&
    payload.status === 'pass' &&
    payload.targets === NATIVE_COMPILER_TARGETS.length &&
    JSON.stringify(payload.nodeLanes) === JSON.stringify(NATIVE_COMPILER_NODE_LANES) &&
    payload.certifications === expectedPairs.length &&
    payload.bundles === NATIVE_COMPILER_TARGETS.length &&
    JSON.stringify(payload.certifiedPairs) === JSON.stringify(expectedPairs) &&
    Array.isArray(runtimeEvidence) &&
    runtimeEvidence.length === expectedRuntimeEvidence.length &&
    runtimeEvidence.every((entry, index) => {
      const expected = expectedRuntimeEvidence[index]
      return (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        entry.pair === expected.pair &&
        entry.target === expected.target &&
        entry.nodeLane === expected.nodeLane &&
        nativeNodeVersionMatchesLane(entry.node, entry.nodeLane) &&
        /^sha256:[0-9a-f]{64}$/.test(entry.evidenceDigest ?? '')
      )
    }) &&
    typeof payload.packageVersion === 'string' &&
    Boolean(payload.packageVersion) &&
    typeof payload.compilerBuildId === 'string' &&
    Boolean(payload.compilerBuildId) &&
    /^[0-9a-f]{40}$/.test(payload.compilerBuildRevision ?? '') &&
    /^sha256:[0-9a-f]{64}$/.test(certificationDigest ?? '') &&
    certificationDigest === computedDigest &&
    Array.isArray(releaseBundles) &&
    releaseBundles.length === NATIVE_COMPILER_TARGETS.length &&
    releaseBundles.every(
      bundle => bundle && typeof bundle === 'object' && !Array.isArray(bundle),
    ) &&
    JSON.stringify(releaseBundles.map(bundle => bundle.target)) ===
      JSON.stringify(NATIVE_COMPILER_TARGETS.map(target => target.target))

  if (!hasValidEnvelope) {
    throw new Error('Rust-default rollout requires one intact complete native certification')
  }

  for (const [index, bundle] of releaseBundles.entries()) {
    const target = NATIVE_COMPILER_TARGETS[index]
    const sizeGate = bundle.sizeGate
    if (
      bundle.target !== target.target ||
      bundle.packageVersion !== payload.packageVersion ||
      !/^[0-9a-f]{64}$/.test(bundle.binarySha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(bundle.tarballSha256 ?? '') ||
      !Number.isSafeInteger(bundle.tarballBytes) ||
      bundle.tarballBytes <= 0 ||
      !Number.isSafeInteger(bundle.unpackedBytes) ||
      bundle.unpackedBytes <= 0 ||
      sizeGate?.schemaVersion !== 1 ||
      sizeGate.target !== target.target ||
      typeof sizeGate.profile !== 'string' ||
      !sizeGate.profile ||
      sizeGate.tarballBytes !== bundle.tarballBytes ||
      sizeGate.unpackedBytes !== bundle.unpackedBytes ||
      !Number.isSafeInteger(sizeGate.maximumTarballBytes) ||
      sizeGate.maximumTarballBytes <= 0 ||
      !Number.isSafeInteger(sizeGate.maximumUnpackedBytes) ||
      sizeGate.maximumUnpackedBytes <= 0 ||
      bundle.tarballBytes > sizeGate.maximumTarballBytes ||
      bundle.unpackedBytes > sizeGate.maximumUnpackedBytes ||
      sizeGate.passed !== true ||
      !Array.isArray(sizeGate.violations) ||
      sizeGate.violations.length !== 0
    ) {
      throw new Error('Rust-default rollout requires one intact complete native certification')
    }
  }

  if (
    payload.compilerBuildRevision !== evidence.sourceRevision ||
    payload.compilerBuildId !== evidence.compilerBuildId
  ) {
    throw new Error('Native certification does not bind the rollout candidate source and build')
  }
}

function parseStableRelease(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '')
  if (!match) throw new Error(`${label} must be an exact stable semver release`)
  const version = {
    value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
  if (![version.major, version.minor, version.patch].every(Number.isSafeInteger)) {
    throw new Error(`${label} contains an unsafe semver component`)
  }
  return version
}

function compareRelease(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

function assertReleaseWindow(state) {
  const releaseFields = [
    state.rustDefaultRelease,
    state.compatibilityRelease,
    state.finalLegacyRelease,
    state.legacyRemovalRelease,
  ]
  if (state.phase === 'beta') {
    if (releaseFields.some(value => value !== null)) {
      throw new Error('Beta rollout state cannot claim Rust-default compatibility releases')
    }
    return
  }

  const rustDefault = parseStableRelease(state.rustDefaultRelease, 'rustDefaultRelease')
  let compatibility = null
  if (state.compatibilityRelease !== null) {
    compatibility = parseStableRelease(state.compatibilityRelease, 'compatibilityRelease')
    if (
      compatibility.major !== rustDefault.major ||
      compatibility.minor <= rustDefault.minor ||
      compatibility.patch !== 0
    ) {
      throw new Error(
        'compatibilityRelease must be a complete subsequent stable minor after Rust default',
      )
    }
  }

  if (state.phase === 'rust-default') {
    if (state.finalLegacyRelease !== null || state.legacyRemovalRelease !== null) {
      throw new Error('Rust-default compatibility phase cannot claim legacy removal')
    }
    return
  }

  if (!compatibility) {
    throw new Error('Legacy removal requires a completed subsequent stable minor')
  }
  const finalLegacy = parseStableRelease(state.finalLegacyRelease, 'finalLegacyRelease')
  const removal = parseStableRelease(state.legacyRemovalRelease, 'legacyRemovalRelease')
  if (
    finalLegacy.major !== rustDefault.major ||
    compareRelease(finalLegacy, compatibility) < 0 ||
    compareRelease(finalLegacy, removal) >= 0
  ) {
    throw new Error(
      'finalLegacyRelease must be at or after the compatibility minor and before removal',
    )
  }
  const isPreOneMinorRemoval =
    rustDefault.major === 0 &&
    removal.major === 0 &&
    removal.minor === finalLegacy.minor + 1 &&
    removal.patch === 0
  const isLaterMajorRemoval =
    removal.major > rustDefault.major && removal.minor === 0 && removal.patch === 0
  if (!isPreOneMinorRemoval && !isLaterMajorRemoval) {
    throw new Error(
      'Legacy removal must occur in the next stable pre-1.0 minor at 0.y.0 or a later stable semver major release at x.0.0',
    )
  }
  if (compareRelease(removal, compatibility) <= 0) {
    throw new Error('Legacy removal release must follow the completed compatibility release')
  }
}

function assertCompilerRootMatchesPhase(workspaceRoot, phase) {
  const manifestPath = path.join(workspaceRoot, 'packages/compiler/package.json')
  const manifest = readJson(manifestPath, 'Compiler package manifest')
  if (!manifest.exports?.['.']) {
    throw new Error('Compiler package must expose its package root during rollout')
  }

  const compilerRootPath = path.join(workspaceRoot, 'packages/compiler/src/index.ts')
  if (!existsSync(compilerRootPath)) {
    throw new Error('Compiler package root source does not exist')
  }
  const compilerRoot = readFileSync(compilerRootPath, 'utf8')
  const importsLegacyImplementation = compilerRoot.includes("from './legacy-compiler'")
  const importsNativeFacade = compilerRoot.includes("from './native-loader'")

  if (phase === 'beta') {
    if (
      !importsLegacyImplementation ||
      importsNativeFacade ||
      !/\bcreateFictPlugin\b/.test(compilerRoot)
    ) {
      throw new Error('Beta rollout must preserve the legacy compiler package root facade')
    }
    return
  }

  const missingNativeApis = REQUIRED_NATIVE_ROOT_APIS.filter(
    api => !new RegExp(`\\b${api}\\b`).test(compilerRoot),
  )
  if (
    !importsNativeFacade ||
    importsLegacyImplementation ||
    /\bcreateFictPlugin\b/.test(compilerRoot) ||
    missingNativeApis.length > 0
  ) {
    const missing =
      missingNativeApis.length > 0 ? `: missing-native-api(${missingNativeApis.join(',')})` : ''
    throw new Error(
      `Rust-default compiler package root must expose only the native request API${missing}`,
    )
  }
}

function assertViteCompilerMatchesPhase(source, state) {
  if (state.phase === 'legacy-removal') {
    const retainedSelector = [
      ['backend option', /\bbackendOption\b/],
      ['backend environment fallback', /\bbackendFromEnvironment\b/],
      ['FICT_COMPILER_BACKEND', /\bFICT_COMPILER_BACKEND\b/],
      ['compiler backend type', /\bFictCompilerBackend\b/],
      ['compiler backend option', /\bbackend\s*\?:/],
      ['compiler backend selection', /\b(?:options|compilerOptions)\.backend\b/],
      ['legacy or shadow backend branch', /['"](?:legacy|shadow)['"]/],
    ].find(([, pattern]) => pattern.test(source))
    if (retainedSelector) {
      throw new Error(
        `Legacy-removal Vite compiler must be native-only without ${retainedSelector[0]}`,
      )
    }
    if (!/\bloadNativeCompilerBinding\s*\(/.test(source)) {
      throw new Error('Legacy-removal Vite compiler must load the native compiler directly')
    }
    return
  }

  const defaultMatch = source.match(
    /backendOption\s*\?\?\s*backendFromEnvironment\s*\?\?\s*'(legacy|rust)'/,
  )
  if (!defaultMatch) throw new Error('Unable to identify the Vite compiler default backend')
  if (defaultMatch[1] !== state.viteDefaultBackend) {
    throw new Error(
      `Rollout state says ${state.viteDefaultBackend}, but Vite defaults to ${defaultMatch[1]}`,
    )
  }
}

function assertLegacyRemovalEvidence(evidence, state) {
  for (const field of [
    'rustDefaultRelease',
    'compatibilityRelease',
    'finalLegacyRelease',
    'legacyRemovalRelease',
  ]) {
    if (evidence[field] !== state[field]) {
      throw new Error(`Legacy-removal evidence does not bind ${field}`)
    }
  }
}

function assertLegacyRemovalReview(review, state, evidence) {
  if (
    review.schemaVersion !== 2 ||
    review.status !== 'approved' ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim()
  ) {
    throw new Error('Legacy removal requires an explicit human reviewer approval')
  }
  if (review.evidenceDigest !== evidence.evidenceDigest) {
    throw new Error('Legacy-removal review does not bind the current release evidence')
  }
  for (const field of [
    'rustDefaultRelease',
    'compatibilityRelease',
    'finalLegacyRelease',
    'legacyRemovalRelease',
  ]) {
    if (review[field] !== state[field]) {
      throw new Error(`Legacy-removal review does not bind ${field}`)
    }
  }
  const reviewAreas = review.areas ?? {}
  const missingAreas = Object.entries(reviewAreas)
    .filter(([, approved]) => approved !== true)
    .map(([area]) => area)
  if (missingAreas.length > 0) {
    throw new Error(`Legacy-removal checklist is incomplete: ${missingAreas.join(', ')}`)
  }
}

function assertLegacySourcesRemoved(workspaceRoot) {
  const nonProductionSourceDirectories = new Set(['__fixtures__', '__tests__', 'test', 'tests'])
  const retainedPaths = [
    '.github/compiler-shadow-allowlist.json',
    'packages/babel-preset',
    'packages/compiler/src/ir',
    'packages/compiler/src/legacy-compiler.ts',
    'packages/compiler/src/legacy.ts',
    'packages/compiler/test/babel-typescript-integration.test.ts',
    'packages/compiler/test/differential',
    'packages/vite-plugin/src/shadow-rollout.ts',
    'packages/vite-plugin/src/__tests__/shadow-rollout.test.ts',
    'scripts/compiler-backend-bench.mjs',
    'scripts/compiler-backend-rollback-drill.mjs',
    'scripts/compiler-runtime-parity-gate.mjs',
    'scripts/compiler-shadow-gate.mjs',
  ].filter(relative => existsSync(path.join(workspaceRoot, relative)))
  const missingReplacementPaths = [
    'packages/compiler/package.json',
    'packages/compiler/src/index.ts',
  ].filter(relative => !existsSync(path.join(workspaceRoot, relative)))
  const dependencyEdges = []
  const controlPlaneReferences = []
  const productionSourceReferences = []
  const legacyCompatibilityMarkers = []
  const packagesRoot = path.join(workspaceRoot, 'packages')
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sourceRoot = path.join(packagesRoot, entry.name, 'src')
      if (existsSync(sourceRoot)) {
        const pending = [sourceRoot]
        while (pending.length > 0) {
          const directory = pending.pop()
          for (const sourceEntry of readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, sourceEntry.name)
            if (sourceEntry.isDirectory()) {
              if (nonProductionSourceDirectories.has(sourceEntry.name)) continue
              pending.push(filename)
              continue
            }
            if (!sourceEntry.isFile() || !/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(sourceEntry.name)) {
              continue
            }
            if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(sourceEntry.name)) continue
            const source = readFileSync(filename, 'utf8')
            if (source.includes('@babel/') || source.includes('@fictjs/compiler/legacy')) {
              productionSourceReferences.push(path.relative(workspaceRoot, filename))
            }
          }
        }
      }

      const manifestPath = path.join(packagesRoot, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath, `${entry.name} package manifest`)
      for (const section of [
        'dependencies',
        'optionalDependencies',
        'peerDependencies',
        'devDependencies',
      ]) {
        for (const dependency of Object.keys(manifest[section] ?? {})) {
          const isPresetEdge = dependency === '@fictjs/babel-preset'
          const isProductionBabelEdge =
            section !== 'devDependencies' && dependency.startsWith('@babel/')
          if (isPresetEdge || isProductionBabelEdge) {
            dependencyEdges.push(`${manifest.name ?? entry.name}:${section}.${dependency}`)
          }
        }
      }
    }
  }

  const compilerManifestPath = path.join(workspaceRoot, 'packages/compiler/package.json')
  if (existsSync(compilerManifestPath)) {
    const compilerManifest = readJson(compilerManifestPath, 'Compiler package manifest')
    if (!compilerManifest.exports?.['.']) {
      legacyCompatibilityMarkers.push('packages/compiler/package.json:missing-root-export')
    }
    if (compilerManifest.exports?.['./legacy']) {
      legacyCompatibilityMarkers.push('packages/compiler/package.json:exports[./legacy]')
    }
  }

  const compilerRootPath = path.join(workspaceRoot, 'packages/compiler/src/index.ts')
  if (existsSync(compilerRootPath)) {
    const compilerRoot = readFileSync(compilerRootPath, 'utf8')
    const missingNativeApis = REQUIRED_NATIVE_ROOT_APIS.filter(
      api => !new RegExp(`\\b${api}\\b`).test(compilerRoot),
    )
    if (missingNativeApis.length > 0) {
      legacyCompatibilityMarkers.push(
        `packages/compiler/src/index.ts:missing-native-api(${missingNativeApis.join(',')})`,
      )
    }
    if (/\bcreateFictPlugin\b/.test(compilerRoot)) {
      legacyCompatibilityMarkers.push('packages/compiler/src/index.ts:createFictPlugin')
    }
  }

  for (const [relative, marker] of [
    ['packages/compiler/src/tooling/minimize.ts', "'rust' | 'legacy'"],
    ['packages/vite-plugin/src/index.ts', "'legacy' | 'rust' | 'shadow'"],
    ['packages/webpack-plugin/src/shared.ts', 'isLegacyV'],
  ]) {
    const filename = path.join(workspaceRoot, relative)
    if (existsSync(filename) && readFileSync(filename, 'utf8').includes(marker)) {
      legacyCompatibilityMarkers.push(`${relative}:${marker}`)
    }
  }

  for (const [relative, marker] of [
    ['package.json', 'test:compiler:differential'],
    ['package.json', 'test:compiler:shadow'],
    ['package.json', 'test:compiler:rollback-drill'],
    ['package.json', 'bench:compiler:backends'],
    ['package.json', 'release:compiler:rust-rollout'],
    ['.github/workflows/ci.yml', 'compiler-rollout-candidate'],
  ]) {
    const filename = path.join(workspaceRoot, relative)
    if (existsSync(filename) && readFileSync(filename, 'utf8').includes(marker)) {
      legacyCompatibilityMarkers.push(`${relative}:${marker}`)
    }
  }

  for (const relative of [
    'package.json',
    'SCOPE.md',
    'maturity.json',
    '.changeset/config.json',
    '.github/npm-publish-packages.json',
    '.github/workflows/ci.yml',
    'scripts/check-api-boundaries.mjs',
  ]) {
    const filename = path.join(workspaceRoot, relative)
    if (!existsSync(filename)) continue
    const source = readFileSync(filename, 'utf8')
    if (source.includes('@fictjs/babel-preset') || source.includes('packages/babel-preset')) {
      controlPlaneReferences.push(relative)
    }
  }
  if (
    retainedPaths.length > 0 ||
    missingReplacementPaths.length > 0 ||
    dependencyEdges.length > 0 ||
    controlPlaneReferences.length > 0 ||
    productionSourceReferences.length > 0 ||
    legacyCompatibilityMarkers.length > 0
  ) {
    throw new Error(
      `Legacy compiler removal is incomplete: ${[
        ...retainedPaths,
        ...missingReplacementPaths.map(relative => `missing:${relative}`),
        ...dependencyEdges,
        ...controlPlaneReferences,
        ...productionSourceReferences,
        ...legacyCompatibilityMarkers,
      ].join(', ')}`,
    )
  }
}

function assertCandidate(evidence) {
  const { candidateDigest, ...payload } = evidence
  const requiredDigests = [
    payload.workflowGateDigest,
    payload.shadowDigest,
    payload.benchmarkDigest,
    payload.runtimeDigest,
    payload.rollbackDigest,
    payload.nativePackageDigest,
  ]
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`
  if (
    payload.schemaVersion !== 5 ||
    payload.status !== 'pass' ||
    payload.promotionEligible !== true ||
    payload.workflowEvent !== 'push' ||
    payload.sourceRef !== 'refs/heads/main' ||
    !Number.isSafeInteger(payload.consecutiveGreenCandidates) ||
    payload.consecutiveGreenCandidates < 2 ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.previousCandidateDigest ?? '') ||
    typeof payload.runId !== 'string' ||
    !/^\d+$/.test(payload.runId) ||
    typeof payload.runAttempt !== 'string' ||
    !/^\d+$/.test(payload.runAttempt) ||
    !/^[0-9a-f]{40}$/.test(payload.sourceRevision ?? '') ||
    payload.compilerBuildRevision !== payload.sourceRevision ||
    typeof payload.compilerBuildId !== 'string' ||
    !payload.compilerBuildId ||
    requiredDigests.some(value => !/^sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    typeof payload.workflowGate !== 'object' ||
    payload.workflowGate === null ||
    `sha256:${createHash('sha256').update(JSON.stringify(payload.workflowGate)).digest('hex')}` !==
      payload.workflowGateDigest ||
    computedDigest !== candidateDigest
  ) {
    throw new Error(
      'Rust-default rollout requires two intact consecutive main-push schema-v5 candidates',
    )
  }
  validateWorkflowGateArtifact(payload.workflowGate, payload)
}

export function validateCompilerRolloutReadiness(options = {}) {
  const workspaceRoot = path.resolve(options.root ?? root)
  const statePath = path.resolve(
    workspaceRoot,
    options.statePath ?? '.github/compiler-rollout-state.json',
  )
  const sourcePath = path.resolve(
    workspaceRoot,
    options.sourcePath ?? 'packages/vite-plugin/src/index.ts',
  )
  const state = readJson(statePath, 'Compiler rollout state')
  if (
    state.schemaVersion !== 4 ||
    !['beta', 'rust-default', 'legacy-removal'].includes(state.phase)
  ) {
    throw new Error('Compiler rollout state has an unsupported phase')
  }
  if (!['legacy', 'rust'].includes(state.rollbackBackend)) {
    throw new Error('Compiler rollout state has an unsupported rollback backend')
  }
  if (state.rollbackBackend !== 'legacy' && state.phase !== 'legacy-removal') {
    throw new Error('The compatibility window must retain whole-build legacy rollback')
  }
  if (state.phase === 'legacy-removal' && state.rollbackBackend !== 'rust') {
    throw new Error('Legacy-removal phase cannot retain the removed legacy rollback backend')
  }
  assertReleaseWindow(state)
  const candidateEvidencePath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.candidateEvidencePath,
    'candidateEvidencePath',
  )
  const nativeCertificationPath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.nativeCertificationPath,
    'nativeCertificationPath',
  )
  const reviewPath = resolveWorkspaceStatePath(workspaceRoot, state.reviewPath, 'reviewPath')
  const legacyRemovalReviewPath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.legacyRemovalReviewPath,
    'legacyRemovalReviewPath',
  )
  const legacyRemovalEvidencePath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.legacyRemovalEvidencePath,
    'legacyRemovalEvidencePath',
  )
  const review = readJson(reviewPath, 'Compiler rollout review')
  const legacyRemovalReview = readJson(legacyRemovalReviewPath, 'Compiler legacy-removal review')
  const legacyRemovalEvidence = readJson(
    legacyRemovalEvidencePath,
    'Compiler legacy-removal evidence',
  )
  assertReviewDocumentShape(review)
  assertLegacyRemovalReviewDocumentShape(legacyRemovalReview)
  assertLegacyRemovalEvidenceDocumentShape(legacyRemovalEvidence, workspaceRoot)
  assertCompilerRootMatchesPhase(workspaceRoot, state.phase)
  const source = readFileSync(sourcePath, 'utf8')
  assertViteCompilerMatchesPhase(source, state)
  if (state.phase === 'legacy-removal') {
    assertLegacySourcesRemoved(workspaceRoot)
  }

  const requiresApproval = state.phase !== 'beta' || options.requireDefaultReady === true
  if (requiresApproval) {
    const evidence = readJson(candidateEvidencePath, 'Compiler candidate evidence')
    const nativeCertification = readJson(nativeCertificationPath, 'Compiler native certification')
    assertCandidate(evidence)
    assertNativeCertification(nativeCertification, evidence)
    assertReview(review, evidence, nativeCertification)
  }
  if (state.phase === 'legacy-removal') {
    assertLegacyRemovalEvidence(legacyRemovalEvidence, state)
    assertLegacyRemovalReview(legacyRemovalReview, state, legacyRemovalEvidence)
  }
  if (state.phase !== 'beta' && state.viteDefaultBackend !== 'rust') {
    throw new Error(`${state.phase} phase must select Rust in Vite`)
  }
  if (state.phase === 'beta' && state.viteDefaultBackend !== 'legacy') {
    throw new Error('beta phase must keep legacy as the Vite default')
  }
  return state
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const cliArguments = process.argv.slice(2)
  assertCliArguments(cliArguments, {
    command: 'compiler rollout readiness',
    flagArguments: ['require-default-ready'],
  })
  validateCompilerRolloutReadiness({
    requireDefaultReady: cliArguments.includes('--require-default-ready'),
  })
  process.stdout.write('[compiler-rollout-readiness] Rollout phase and evidence are consistent.\n')
}
