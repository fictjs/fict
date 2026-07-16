---
type: runbook
title: Compiler Release Rollback
description: Whole-release recovery from the Rust-only compiler to the final 0.30.1 compatibility unit.
owner: unadlib
status: active
risk_level: critical
tags: [compiler, rollback, cache, incident]
---

# Compiler Release Rollback

## Boundary

Fict 1.0 has no code-level compiler rollback. There is no backend selector,
environment override, Babel preset, `./legacy` export, or per-file retry path.
The only legacy recovery boundary is a complete application release whose Fict
dependency graph and generated artifacts are pinned to the final legacy release,
`0.30.1`.

Use this runbook for an unexplained semantic change, strict-guarantee downgrade,
metadata/runtime ABI mismatch, source-map regression, native panic, unsupported
platform installation, or release-budget regression.

## Safety rules

- Stop the affected build or deployment before changing dependencies.
- Prefer redeploying a previously verified 0.30.1 application artifact and
  lockfile.
- Never combine a 0.30.1 compiler/preset with a 1.0 runtime, Vite integration,
  native platform package, metadata asset, or Preview manifest.
- Do not retry one failed source file with Babel.
- Preserve the failing compiler build ID, platform, lockfile, logs, and
  privacy-safe evidence for diagnosis.
- Third-party package metadata is source input; purge only application-owned
  caches and generated output.

## Procedure

1. Record the incident release, application revision, compiler build ID,
   platform/Node version, diagnostic or panic, and affected routes.
2. Select the last verified application revision whose lockfile resolves the
   complete Fict compatibility unit to 0.30.1. Do not hand-edit only
   `@fictjs/compiler`.
3. Restore that revision in a clean checkout or deployment workspace and run a
   frozen install:

   ```bash
   pnpm install --frozen-lockfile
   ```

4. Confirm the lockfile contains no Fict 1.0 package and that the compiler,
   runtime, Vite integration, optional native packages, SSR/Preview consumers,
   and any historical preset match the known-good release unit.
5. Remove application-owned Vite/webpack/Turbo caches, `.fict-cache`, output
   directories, generated metadata assets, handler chunks, SSR snapshots,
   service-worker caches, and CDN objects from the failed 1.0 build.
6. Build and test from the restored checkout. Do not copy an earlier `dist`
   directory into a new build.
7. Deploy the complete restored artifact set atomically. Preview manifest, QRL,
   SSR snapshot, client chunks, and server output must move together.
8. Keep 1.0 promotion stopped until a maintainer reviews the evidence and the
   corrected Rust candidate passes the full release gate.

## Verification

Run the application's normal strict production build, bundler tests, browser
tests, and SSR matrix from the restored checkout. At minimum, verify:

- the installed compiler package is exactly the lockfile-selected 0.30.1
  facade;
- no 1.0 native package or generated asset appears in the deployment;
- package metadata and runtime helper versions are internally consistent;
- the original failing behavior is covered by a retained regression fixture.

For a repository release candidate, the current Rust-only gates remain:

```bash
pnpm test:compiler:rollout-state
pnpm release:compiler:verify
pnpm release:verify:clean
```

These commands validate the replacement candidate; they do not manufacture or
authorize a legacy build.

## Escalation

Keep the deployment stopped when no verified 0.30.1 application artifact is
available, the compatibility unit cannot be restored atomically, third-party
metadata is incompatible, or the restored build also fails. A maintainer must
approve both the rollback artifact and any return to 1.0.

## Related documents

- [Migration guide](../../migration-guide.md)
- [Rust compiler architecture](../../architecture/rust-compiler.md)
- [Release verification](../../testing/release-verification.md)
- [SSR deployment cache rules](../../ssr-deployment.md)
