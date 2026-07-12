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
- Packages are automatically built and published to NPM
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
