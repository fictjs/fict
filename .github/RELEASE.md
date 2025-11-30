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

#### Step 2: Create and Push a Tag

```bash
# Pull the latest main branch
git checkout main
git pull origin main

# Create a version tag (e.g., v0.1.0)
git tag v0.1.0

# Push the tag to GitHub
git push origin v0.1.0
```

#### Step 3: Automatic Publishing

- Pushing the tag triggers the Release workflow
- Packages are automatically built and published to NPM
- GitHub Release is created

## Important Notes

- ✅ **Push commit** → Only runs CI tests
- ✅ **Merge commit** → Runs CI tests + Creates Version PR
- ✅ **Push tag** → Triggers release and publishes to NPM
- ❌ **NO automatic release** on normal commits

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

Make sure the following secrets are configured in GitHub:

- `NPM_TOKEN` - NPM authentication token for publishing
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions
