# Release Process

This document describes the release process for the Fict monorepo.

## Workflow Overview

### 1. Development Phase

- Make changes to packages
- Create changesets for your changes:
  ```bash
  pnpm changeset
  ```
- Commit and push to a feature branch
- Create a Pull Request

### 2. Version Management (Automated)

When you merge PRs to `main` with changesets:

- GitHub Actions will automatically create a "Version Packages" PR
- This PR updates package versions and CHANGELOG files
- Review the version changes in this PR

### 3. Release Phase (Manual)

To release packages to NPM:

#### Step 1: Merge the Version Packages PR

```bash
# Merge the "Version Packages" PR created by changesets
```

#### Step 2: Run Release Verification

```bash
# Verify the full v1 release gate locally before tagging.
# BENCH_OUTPUT captures the raw optimizer benchmark JSON used as release evidence.
export BENCH_OUTPUT="${TMPDIR:-/tmp}/fict-optimizer-bench.json"
pnpm release:verify:clean

# Compare every allowlisted package version with the public registry. This must
# report no `new-package` entries before a tag is pushed.
pnpm release:plan --tag v0.27.0 --require-existing-packages
```

`release:verify:clean` refuses tracked or untracked changes, creates a detached
temporary worktree at `HEAD`, installs the frozen lockfile, and runs the complete
`release:verify` gate there. That gate includes the SSR runtime matrix, browser
E2E, the focused repository-review regression suite, and install-and-consume
checks for the actual package tarballs in Node ESM, generic ESM targets shadowed
by `node` conditions, CJS, and TypeScript projects.
Only pnpm's content-addressed download store is shared;
`node_modules`, build output, and Turbo output remain isolated. The temporary
checkout is always removed. The inner gate runs with `CI=true`, so Playwright
starts fresh fixture servers instead of reusing local listeners, forbids focused
tests, and uses the same retry and worker behavior as CI.

Do not export `FICT_STRICT_GUARANTEE` around either verification command. The
root release scripts scope it to the compiler contract, build, and bundler gates
so behavior-first test suites keep their documented non-strict configuration.

### Rust compiler rollout evidence

The `compiler-rollout` CI job first uploads raw privacy-safe shadow,
performance/RSS, runtime parity, native package clean-install/size, and
rollback-drill evidence. The `compiler-rollout-finalize` job can seal and upload
the `compiler-rollout-candidate` artifact only after every required native,
integration, lint, typecheck, strict-guarantee, performance, test, browser,
real-app, SSR, opt-out, and build job passes. Candidate schema v5 binds all five
evidence digests plus the canonical finalizer identity, workflow event/ref,
compiled Git revision, and the exact required-job result map. Every evidence
producer must report the revision embedded in its native binary, and it must
equal the workflow source revision. Schema v4 and older candidates restart the
chain. Pull-request and scheduled candidates remain useful diagnostics but
record zero promotion-eligible builds. A successful main-branch run chains the
previous green candidate digest when one exists. The chain is fail-closed: the
immediately preceding main-branch push must be completed with an overall
workflow conclusion of `success` and an unexpired candidate artifact. A failed
or artifact-less intervening run resets the count instead of allowing CI to
skip backward to an older green run. If the immediately preceding push is
still running, the newer run also starts a fresh count rather than racing its
unfinished evidence.

Before changing the Vite default to Rust, download the latest candidate and
confirm `consecutiveGreenCandidates >= 2`. Copy the reviewed candidate record
to the candidate path named by `.github/compiler-rollout-state.json`. Manually
dispatch `release.yml` for that exact candidate source revision, download its
`fict-native-certification-<sha>` artifact, and copy the JSON record to the
state's native-certification path. The certification digest, source revision,
compiler build ID, 16 raw-evidence digests, and recorded Node versions must
remain intact, and the source/build must match the candidate. Then
have a maintainer bind every item in `.github/compiler-rollout-review.json` to
both the exact `candidateDigest` and `nativeCertificationDigest`.
`node scripts/compiler-rollout-readiness.mjs --require-default-ready` MUST pass
before the state may enter `rust-default`. Review schema v3 includes an explicit
`nativePackageSizeBudget` approval; the two bound digests make that approval
cover both the candidate host measurement and the exact size gates for all
eight release bundles.
Rollout evidence/review paths are restricted to the repository, and CI validates
the exact pending/approved checklist shape even during beta. Do not stage a
partial approval: update both digests, reviewer, status, and all areas
atomically. The state schema is v3; older state or review documents fail closed.

Do not manufacture a second candidate by running the sealer twice locally.
Controlled CI and release builds embed `github.sha`; a local binary without an
embedded revision cannot be sealed. Injecting a value during a local contract
smoke still does not turn that output into canonical CI evidence. Only distinct
CI runs from committed source count. Likewise, a locally assembled native
certification cannot replace the retained 8×2 Release workflow artifact. Raw
benchmark values remain in CI artifacts and are not copied into release prose.

Legacy removal is a later release operation, not part of candidate approval.
Before entering `legacy-removal`, update the four exact stable release fields
in `.github/compiler-rollout-state.json` and complete
`.github/compiler-legacy-removal-review.json`. The readiness check requires a
completed subsequent `x.y.0` compatibility release, a final legacy release,
and a later breaking `x.0.0` removal release, with the removal review bound to
those exact versions. It also rejects retained preset/legacy-IR paths,
`./legacy` exports, production Babel or legacy-subpath imports, Vite shadow and
dual-backend harnesses, old Webpack cache readers, and a compiler root missing
the Rust request API, plus stale scope, maturity, Changesets, publish allowlist,
CI, and API-boundary references.

For an emergency reversal, follow
`docs/operations/runbooks/compiler-backend-rollback.md`. Roll back the whole
build, purge compiler/metadata/bundler/generated caches, and retain the failing
candidate artifact.

#### Step 3: Create and Push a Tag

```bash
# Pull the latest main branch
git checkout main
git pull origin main

# Create a version tag (e.g., v0.1.0)
git tag v0.1.0

# Push the tag to GitHub
git push origin v0.1.0
```

#### Step 4: Automatic Publishing

- Pushing the tag triggers the Release workflow
- Eight native compiler packages are built and certified on Node 22.18/24
- Native packages are published first; the facade and remaining packages follow
- GitHub Release is created

## Important Notes

- ✅ **Push commit** → Only runs CI tests
- ✅ **Merge commit** → Runs CI tests + Creates Version PR
- ✅ **Push tag** → Triggers release and publishes to NPM
- ❌ **NO automatic release** on normal commits
- CI and release workflows upload the raw optimizer benchmark JSON as an artifact
  (`optimizer-benchmark-*` / `release-optimizer-benchmark-*`).

## Changeset Commands

```bash
# Add a changeset for your changes
pnpm changeset

# Preview version bumps
pnpm changeset status

# Manually update versions (usually done by GitHub Actions)
pnpm changeset version
```

## Security

NPM publishing uses Trusted Publishing through GitHub Actions OIDC. Do not add a
long-lived NPM publishing token to the workflow.

The release workflow pins npm `11.18.0`. Changesets 2.x reads
`npm info --json` as an object, while npm 12 returns an array and causes already
published versions to be misclassified as pending. Do not upgrade the release
npm major until the publish-plan regression test and Changesets both support the
new output contract.

The authoritative public-package allowlist is
`.github/npm-publish-packages.json`. Every workspace package outside that list
must set `private: true` and must not define `publishConfig`. The release plan
queries the registry directly, records `already-published`, `pending`, and
`new-package` states, and runs both before and immediately after the full release
gate.

### Native compiler release unit

`@fictjs/compiler` and its eight `@fictjs/compiler-<target>` optional packages
are one release unit. Their versions must match exactly. The release workflow:

1. builds every ADR-0002 target on its native OS and architecture, using a
   native Linux host plus an Alpine container for musl runtime evidence;
2. emits a package-local binary checksum, npm tarball checksum, and build
   evidence for every target;
3. installs each tarball with lifecycle scripts disabled and no Rust toolchain,
   then executes ESM/CJS and sync/async compiler calls on Node 22.18 and 24;
4. aggregates all 16 runtime evidence documents and rejects missing or duplicate
   target/Node pairs, mixed compiler build IDs or source revisions, and Node
   lanes that did not execute the exact same target tarball; every evidence
   hash, byte count, version, and size result must match the eight downloaded
   bundles that will be published; this dedicated certification job runs for
   both manual dispatches and tag pushes and retains a machine-readable result;
5. preflights all eight artifacts before any npm publish;
6. publishes every pending tarball in dependency order, waiting for registry
   visibility after each package; all native packages precede `@fictjs/compiler`.

Npm has no multi-package transaction. Fict's atomicity guarantee therefore
means complete preflight plus native-first, resumable publication. If a native
publish succeeds and a later one fails, rerun the failed workflow: already
published platform versions are skipped and missing ones resume. If the facade
is visible while a same-version platform package is missing, automation fails
closed; publish the missing certified tarball, confirm registry visibility, and
only then rerun. Never move the tag or publish a different binary under the same
version.

The `fict-native-package-*`, `fict-native-evidence-*`, and
`fict-native-certification-*` workflow artifacts are retained for 90 days.
Preserve them with the release plan when investigating a registry-side partial
publication. The publishing job runs only after certification proves that all
16 documents embed `GITHUB_SHA`, share one compiler build ID and package
version, and the two Node lanes for each target report identical bundle hashes
and size measurements that match the downloaded release bundle.

Before tagging a release, make sure each publishable NPM package is configured
on npmjs.com with:

- Publisher: GitHub Actions
- Organization/repository: `fictjs/fict`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`
- Environment: leave blank unless the release job also declares the same GitHub
  environment

The Release workflow grants `id-token: write` so npm can exchange the GitHub OIDC
identity for short-lived publish credentials. Package provenance is enabled by
the workflow and each package's `publishConfig.provenance`.

### First publication of a new package

Trusted publishing cannot create a package: npm requires the package to exist
before a trusted publisher can be configured. Bootstrap a new allowlisted
package once with an authenticated maintainer account before pushing the release
tag:

```bash
# npm trust requires npm 11.15 or newer; use the same pinned toolchain as CI.
npm install -g npm@11.18.0

# Build the package and all local workspace dependencies.
pnpm --filter @fictjs/webpack-plugin... build

# Run from the package directory while logged in to npm with 2FA. The one-time
# bootstrap cannot carry CI provenance, so override the manifest setting only
# for this first publish.
cd packages/webpack-plugin
npm publish --access public --provenance=false

# After the package exists, configure the normal tokenless release workflow.
npm trust github @fictjs/webpack-plugin \
  --file release.yml \
  --repo fictjs/fict \
  --allow-publish
```

Return to the repository root and rerun:

```bash
pnpm release:plan --require-existing-packages
```

The public registry may briefly serve a cached `404` after the first publish.
The release planner retries missing packages with cache-busting requests before
classifying them as `new-package`, but the local command above must still pass
before a tag is pushed. If a tag was pushed during that visibility window, wait
until the local plan reports the package as `pending` or `already-published`,
then rerun the failed workflow.

Do not push or move the release tag until the new package is no longer reported
as `new-package` and its trusted publisher is configured.

For the eight native compiler packages, manually dispatch `release.yml`. Manual
dispatch builds and certifies the full matrix but deliberately skips the npm
release job. Confirm that `fict-native-certification-<sha>` exists and reports
all 16 certifications and eight matching bundles, then download every
`fict-native-package-*` artifact, publish its `.tgz` once with an authenticated
maintainer account and `--provenance=false`, and configure the same
`release.yml` trusted publisher for each package. Run
`pnpm release:plan --require-existing-packages` only after all eight names are
visible. A partial bootstrap is not sufficient to tag a release.
