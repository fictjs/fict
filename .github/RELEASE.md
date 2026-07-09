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
pnpm release:verify
```

Do not export `FICT_STRICT_GUARANTEE` around `release:verify`. The root release
scripts scope it to the compiler contract, build, and bundler gates so
behavior-first test suites keep their documented non-strict configuration.

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
