#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateWorkflowGateArtifact } from './compiler-rollout-workflow-contract.mjs'

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

function assertReviewDocumentShape(review) {
  if (review.schemaVersion !== 2 || !['pending', 'approved'].includes(review.status)) {
    throw new Error('Compiler rollout review has an unsupported schema or status')
  }
  assertAreaShape(review.areas, REQUIRED_REVIEW_AREAS, 'Reviewer checklist')
  if (
    review.status === 'pending' &&
    (review.candidateDigest !== null ||
      review.reviewer !== null ||
      Object.values(review.areas).some(Boolean))
  ) {
    throw new Error('Pending compiler rollout review cannot contain partial approval')
  }
  if (
    review.status === 'approved' &&
    (typeof review.reviewer !== 'string' ||
      !review.reviewer.trim() ||
      !/^sha256:[0-9a-f]{64}$/.test(review.candidateDigest ?? ''))
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
  if (review.schemaVersion !== 1 || !['pending', 'approved'].includes(review.status)) {
    throw new Error('Compiler legacy-removal review has an unsupported schema or status')
  }
  assertAreaShape(review.areas, REQUIRED_LEGACY_REMOVAL_AREAS, 'Legacy-removal checklist')
  if (
    review.status === 'pending' &&
    (review.reviewer !== null ||
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
    if (typeof review.reviewer !== 'string' || !review.reviewer.trim()) {
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
  const missingAreas = Object.entries(reviewAreas)
    .filter(([, approved]) => approved !== true)
    .map(([area]) => area)
  if (missingAreas.length > 0) {
    throw new Error(`Legacy-removal checklist is incomplete: ${missingAreas.join(', ')}`)
  }
}

function assertLegacySourcesRemoved(workspaceRoot) {
  const retainedPaths = [
    '.github/compiler-shadow-allowlist.json',
    'packages/babel-preset',
    'packages/compiler/src/ir',
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
              pending.push(filename)
              continue
            }
            if (!sourceEntry.isFile() || !/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(sourceEntry.name)) {
              continue
            }
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
    const missingNativeApis = ['transformSync', 'transform', 'scan', 'analyze'].filter(
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
    payload.schemaVersion !== 4 ||
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
      'Rust-default rollout requires two intact consecutive main-push schema-v4 candidates',
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
  const candidateEvidencePath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.candidateEvidencePath,
    'candidateEvidencePath',
  )
  const reviewPath = resolveWorkspaceStatePath(workspaceRoot, state.reviewPath, 'reviewPath')
  const legacyRemovalReviewPath = resolveWorkspaceStatePath(
    workspaceRoot,
    state.legacyRemovalReviewPath,
    'legacyRemovalReviewPath',
  )
  const review = readJson(reviewPath, 'Compiler rollout review')
  const legacyRemovalReview = readJson(legacyRemovalReviewPath, 'Compiler legacy-removal review')
  assertReviewDocumentShape(review)
  assertLegacyRemovalReviewDocumentShape(legacyRemovalReview)
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
    const evidence = readJson(candidateEvidencePath, 'Compiler candidate evidence')
    assertCandidate(evidence)
    assertReview(review, evidence)
  }
  if (state.phase === 'legacy-removal') {
    assertLegacyRemovalReview(legacyRemovalReview, state)
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
