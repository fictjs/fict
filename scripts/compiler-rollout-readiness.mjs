#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

function readJson(filename, label) {
  if (!existsSync(filename)) throw new Error(`${label} does not exist: ${filename}`)
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function assertReview(review, evidence) {
  if (
    review.schemaVersion !== 2 ||
    review.status !== 'approved' ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim()
  ) {
    throw new Error('Rust-default rollout requires an explicit human reviewer approval')
  }
  if (review.candidateDigest !== evidence.candidateDigest) {
    throw new Error('Reviewer approval does not bind the current candidate evidence')
  }
  const reviewAreas = review.areas ?? {}
  const areaNames = Object.keys(reviewAreas).sort()
  if (JSON.stringify(areaNames) !== JSON.stringify(REQUIRED_REVIEW_AREAS)) {
    throw new Error('Reviewer checklist does not use the required rollout areas')
  }
  const missingAreas = Object.entries(reviewAreas)
    .filter(([, approved]) => approved !== true)
    .map(([area]) => area)
  if (missingAreas.length > 0) {
    throw new Error(`Reviewer checklist is incomplete: ${missingAreas.join(', ')}`)
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
  if (removal.major <= rustDefault.major || removal.minor !== 0 || removal.patch !== 0) {
    throw new Error('Legacy removal must occur in a later stable semver major release at x.0.0')
  }
  if (compareRelease(removal, compatibility) <= 0) {
    throw new Error('Legacy removal release must follow the completed compatibility release')
  }
}

function assertLegacyRemovalReview(review, state) {
  if (
    review.schemaVersion !== 1 ||
    review.status !== 'approved' ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim()
  ) {
    throw new Error('Legacy removal requires an explicit human reviewer approval')
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
  const areaNames = Object.keys(reviewAreas).sort()
  if (JSON.stringify(areaNames) !== JSON.stringify(REQUIRED_LEGACY_REMOVAL_AREAS)) {
    throw new Error('Legacy-removal checklist does not use the required review areas')
  }
  const missingAreas = Object.entries(reviewAreas)
    .filter(([, approved]) => approved !== true)
    .map(([area]) => area)
  if (missingAreas.length > 0) {
    throw new Error(`Legacy-removal checklist is incomplete: ${missingAreas.join(', ')}`)
  }
}

function assertLegacySourcesRemoved(workspaceRoot) {
  const retainedPaths = ['packages/babel-preset', 'packages/compiler/src/ir'].filter(relative =>
    existsSync(path.join(workspaceRoot, relative)),
  )
  const dependencyEdges = []
  const controlPlaneReferences = []
  const packagesRoot = path.join(workspaceRoot, 'packages')
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
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
  if (retainedPaths.length > 0 || dependencyEdges.length > 0 || controlPlaneReferences.length > 0) {
    throw new Error(
      `Legacy compiler removal is incomplete: ${[
        ...retainedPaths,
        ...dependencyEdges,
        ...controlPlaneReferences,
      ].join(', ')}`,
    )
  }
}

function assertCandidate(evidence) {
  const { candidateDigest, ...payload } = evidence
  const requiredDigests = [
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
    payload.schemaVersion !== 3 ||
    payload.status !== 'pass' ||
    payload.promotionEligible !== true ||
    payload.workflowEvent !== 'push' ||
    payload.sourceRef !== 'refs/heads/main' ||
    !Number.isSafeInteger(payload.consecutiveGreenCandidates) ||
    payload.consecutiveGreenCandidates < 2 ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.previousCandidateDigest ?? '') ||
    !/^\d+$/.test(String(payload.runId)) ||
    !/^\d+$/.test(String(payload.runAttempt)) ||
    !/^[0-9a-f]{40}$/.test(payload.sourceRevision ?? '') ||
    typeof payload.compilerBuildId !== 'string' ||
    !payload.compilerBuildId ||
    requiredDigests.some(value => !/^sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    computedDigest !== candidateDigest
  ) {
    throw new Error(
      'Rust-default rollout requires two intact consecutive main-push schema-v3 candidates',
    )
  }
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
    state.schemaVersion !== 2 ||
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
  const source = readFileSync(sourcePath, 'utf8')
  const defaultMatch = source.match(
    /backendOption\s*\?\?\s*backendFromEnvironment\s*\?\?\s*'(legacy|rust)'/,
  )
  if (!defaultMatch) throw new Error('Unable to identify the Vite compiler default backend')
  if (defaultMatch[1] !== state.viteDefaultBackend) {
    throw new Error(
      `Rollout state says ${state.viteDefaultBackend}, but Vite defaults to ${defaultMatch[1]}`,
    )
  }
  if (state.phase === 'legacy-removal') {
    assertLegacySourcesRemoved(workspaceRoot)
  }

  const requiresApproval = state.phase !== 'beta' || options.requireDefaultReady === true
  if (requiresApproval) {
    const evidence = readJson(
      path.resolve(workspaceRoot, state.candidateEvidencePath),
      'Compiler candidate evidence',
    )
    const review = readJson(
      path.resolve(workspaceRoot, state.reviewPath),
      'Compiler rollout review',
    )
    assertCandidate(evidence)
    assertReview(review, evidence)
  }
  if (state.phase === 'legacy-removal') {
    const removalReview = readJson(
      path.resolve(workspaceRoot, state.legacyRemovalReviewPath),
      'Compiler legacy-removal review',
    )
    assertLegacyRemovalReview(removalReview, state)
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
  validateCompilerRolloutReadiness({
    requireDefaultReady: process.argv.includes('--require-default-ready'),
  })
  process.stdout.write('[compiler-rollout-readiness] Rollout phase and evidence are consistent.\n')
}
