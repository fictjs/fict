---
type: test-plan
title: Release Verification
description: Required clean-checkout evidence for browser, SSR, native compiler, and publishable package compatibility.
owner: NEEDS_OWNER
status: proposed
tags: [release, e2e, ssr, packaging]
---

# Release Verification

## Purpose

A release candidate MUST pass from committed source in a detached checkout. Local build products, workspace links, and untracked files cannot count as release evidence.

The authoritative command is:

```bash
pnpm release:verify:clean
```

The command refuses a dirty source checkout, creates a temporary worktree at `HEAD`, installs `pnpm-lock.yaml` with `--frozen-lockfile`, runs `pnpm release:verify` with `CI=true`, and removes the worktree on success or failure. It may reuse pnpm's content-addressed download store, but it MUST NOT share `node_modules`, build output, Turbo task output, or an existing Playwright web server with the source checkout. CI mode also forbids focused browser tests and applies the release gate's CI retry and worker settings.

## Required evidence

The inner release gate MUST retain all of these checks:

| Evidence                     | Command                              | Contract                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review regressions           | `pnpm test:review-regressions`       | Confirmed high- and medium-risk repository findings retain focused behavioral coverage, including test-file existence checks.                                                                                                                             |
| Browser behavior             | `pnpm test:e2e`                      | Chromium exercises the core fixture plus three production-shaped applications, including mixed-workload soak.                                                                                                                                             |
| SSR portability              | `pnpm test:ssr-matrix`               | Node and edge-oriented SSR configurations retain their supported rendering behavior.                                                                                                                                                                      |
| JavaScript package archives  | `pnpm test:package-tarballs`         | Every non-native package in `.github/npm-publish-packages.json` is packed, installed outside the workspace, and consumed through Node ESM and CJS; non-Node ESM branches shadowed by a `node` condition are consumed directly from the installed archive. |
| Declaration consumption      | `pnpm test:package-tarballs`         | The installed JavaScript archives compile from both `.mts` and `.cts` consumers with strict TypeScript checking and `skipLibCheck` disabled.                                                                                                              |
| Native package clean install | `pnpm test:compiler:native-packages` | The host package is checksummed, packed with the facade, installed with lifecycle scripts disabled and Rust unavailable, then exercised through ESM/CJS plus synchronous/asynchronous compilation.                                                        |
| Native release matrix        | Release workflow                     | All eight ADR-0002 targets execute on Node 22.18/24 on the target architecture/libc. Each of the 16 lanes uploads machine-readable evidence; a missing or skipped lane blocks facade publication.                                                         |

The JavaScript tarball gate also MUST reject unresolved `workspace:` dependency ranges and exported files absent from the archive. Native packages use the stricter native gate because one host cannot execute all architectures and libc variants. Native artifacts MUST contain the `.node` binary, `binding-manifest.json`, `SHASUMS256.txt`, the npm tarball, and its SHA-256 sidecar.

## Failure policy

- A missing browser binary is an environment failure, not permission to skip E2E. Install the Playwright Chromium bundle and rerun the complete command.
- Registry or audit failures MUST be recorded and rerun; a partial green gate is not release evidence.
- A native build or runtime lane cannot be marked non-blocking. Publish preflight must see all eight version-matched tarballs before any npm mutation.
- Do not copy an existing `dist` directory into the temporary worktree. Builds have to originate from the committed candidate.
- Do not remove a required command from `release:verify` without updating `scripts/release-verification.test.mjs` and receiving explicit release-owner review.

## Human review focus

Before tagging, a release owner MUST review the final command exit status, the
Rust complexity/performance/RSS evidence, native certification, and any warnings
emitted while packing or installing the consumer project. Changes to compiler
protocols, package `exports`, the publish allowlist, SSR matrix membership, or
Playwright coverage deserve focused review even when automation passes.
