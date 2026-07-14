#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
    payload.schemaVersion !== 2 ||
    payload.status !== 'pass' ||
    payload.consecutiveGreenCandidates < 2 ||
    requiredDigests.some(value => !/^sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    computedDigest !== candidateDigest
  ) {
    throw new Error(
      'Rust-default rollout requires two intact consecutive schema-v2 candidate builds',
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
    state.schemaVersion !== 1 ||
    !['beta', 'rust-default', 'legacy-removal'].includes(state.phase)
  ) {
    throw new Error('Compiler rollout state has an unsupported phase')
  }
  if (state.rollbackBackend !== 'legacy' && state.phase !== 'legacy-removal') {
    throw new Error('The compatibility window must retain whole-build legacy rollback')
  }
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

  const requiresApproval = state.phase === 'rust-default' || options.requireDefaultReady === true
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
  if (state.phase === 'rust-default' && state.viteDefaultBackend !== 'rust') {
    throw new Error('rust-default phase must select Rust in Vite')
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
