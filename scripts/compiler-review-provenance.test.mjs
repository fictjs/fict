import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const revisionPattern = /^[0-9a-f]{40}$/
const targetRevision = process.env.FICT_REVIEW_TARGET_REVISION ?? 'HEAD'
const reviewedEvidence = [
  {
    label: 'frozen compiler corpus',
    path: 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json',
  },
  {
    label: 'legacy unrepresented-callsite replay',
    path: 'crates/fict-compiler/tests/legacy_unrepresented_callsite_replay.json',
  },
]

function git(args) {
  return spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const gitRoot = git(['rev-parse', '--show-toplevel'])
const hasRepositoryHistory =
  gitRoot.status === 0 && path.resolve(gitRoot.stdout.trim()) === repositoryRoot

test(
  'binds reviewed compiler evidence to ancestors of the candidate revision',
  {
    skip: hasRepositoryHistory
      ? false
      : 'requires Git history; archive-only fallback checkouts cannot validate ancestry',
  },
  () => {
    for (const evidence of reviewedEvidence) {
      const payload = JSON.parse(readFileSync(path.join(repositoryRoot, evidence.path), 'utf8'))
      const reviewedRevision = payload.provenance?.reviewedRevision
      assert.match(reviewedRevision, revisionPattern, `${evidence.label} reviewed revision`)

      const ancestry = git(['merge-base', '--is-ancestor', reviewedRevision, targetRevision])
      assert.equal(
        ancestry.status,
        0,
        `${evidence.label} reviewed revision ${reviewedRevision} must be an ancestor of ${targetRevision}; use a full-history checkout and rebind rewritten review provenance to the equivalent reachable commit\n${ancestry.stderr.trim()}`,
      )
    }
  },
)
