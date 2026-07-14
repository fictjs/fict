---
type: adr
title: ADR-0003 — Retire the Babel preset after a bounded compatibility window
description: Deprecation, compatibility, release, scope, and removal rules for replacing the legacy Fict Babel preset with native compiler integrations.
owner: unadlib
status: accepted
risk_level: high
tags: [compiler, babel, migration, deprecation, scope]
---

# ADR-0003 — Retire the Babel preset after a bounded compatibility window

## Context

`@fictjs/babel-preset` is currently a Core package in Fict's Changesets fixed
group. It performs an isolated TypeScript and module prepass before the legacy
Babel compiler and is used directly by the Webpack integration and Babel
consumers.

The native compiler is an entire-file OXC pipeline. A Babel `Program` visitor
cannot faithfully replace the current AST with native output while preserving
arbitrary sibling-plugin ordering, `file.code`, source-map ownership, comments,
and a single parse/codegen lifecycle. Keeping such a bridge as a permanent
Core API would preserve Babel runtime dependencies and advertise compatibility
that Fict cannot actually guarantee.

Removing the preset before native integrations are usable would strand current
consumers. Keeping it indefinitely would leave two production compilers and
make semantic drift permanent. The migration therefore needs a release-based,
auditable compatibility window.

## Decision

`@fictjs/babel-preset` will remain a legacy-only adapter during migration and
will then be retired. It MUST NOT call the Rust compiler from a Babel visitor,
print and reparse native output, or select backends per file.

The lifecycle has four phases.

### Phase A — Supported legacy adapter

Through M1–M6, while no complete native replacement is available, the preset
remains supported, stays in the Core fixed group, and receives semantic,
security, and compatibility fixes. It MUST continue to run the existing Babel
compiler. No deprecation warning is emitted before users have a viable native
integration path.

### Phase B — Announced deprecation

The first Core release that exposes a usable Rust opt-in and migration path in
Vite, Webpack, and `@fictjs/compiler` starts deprecation. That release MUST:

- mark the preset API and package documentation deprecated;
- emit at most one development-time deprecation warning per process;
- publish a migration guide for Vite, Webpack, and direct transform consumers;
- state that the preset remains the legacy backend and cannot be mixed with
  Rust output in one build;
- retain the preset in the Core fixed group and normal release verification.

Deprecation MUST NOT reduce correctness testing. The preset's TypeScript,
namespace, CTS, source-map, metadata, and strict-guarantee lanes remain
blocking until its source is removed.

### Phase C — Compatibility window after the default switch

When Rust becomes the default Core compiler, the preset remains installable
and functional as an explicit whole-build legacy migration path. It MUST remain
in the repository and receive blocking fixes for at least one complete,
subsequent stable Core minor release after the Rust-default release. Release
candidates do not count as that subsequent minor.

Removal cannot occur in the same minor release that changes the default. For
the current pre-1.0 line, `1.0.0` is the earliest removal release. If the Rust
default changes after Fict 1.0, removal is earliest in the next semver major,
consistent with the public deprecation policy.

Before ending the window, M7 evidence MUST include at least two consecutive
candidate builds with no unexplained Core semantic difference, a successful
rollback drill, and a release containing the Rust default. The window does not
permit per-file fallback; selecting the preset means selecting legacy for the
entire build and invalidating Rust caches and metadata artifacts.

### Phase D — Final release and removal

The last preset release MUST be published before its source is removed. Its
README, npm deprecation message, changelog, and migration guide MUST identify:

- the final supported preset version;
- the compatible final legacy compiler version;
- the first Core release without the preset;
- supported Vite, Webpack, and direct native replacements.

The subsequent breaking Core release removes the preset from `SCOPE.md`,
`maturity.json`, the Changesets fixed group, workspace release plans, API
boundary checks, and production dependency graphs. The legacy TypeScript
compiler, legacy-only harness, and Babel production dependencies are removed
in the same M9 compatibility unit. Published historical versions are not
unpublished.

If sustained user demand later justifies Babel integration, it may be designed
as an independently versioned Satellite package. It cannot re-enter Core by
default and cannot promise arbitrary Babel sibling-plugin ordering without a
new architecture decision and executable evidence.

## Supported migration paths

| Existing use                        | Replacement                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Babel via Vite                      | `@fictjs/vite-plugin` using one build-level native backend                         |
| Babel via Webpack                   | `@fictjs/webpack-plugin` native loader                                             |
| Direct `transformSync` with preset  | `@fictjs/compiler` `transformSync`                                                 |
| Direct asynchronous Babel transform | `@fictjs/compiler` `transform`                                                     |
| Diagnostics/tooling through Babel   | `analyzeSync` or `analyze` structured results                                      |
| Custom sibling plugins after Fict   | Run native Fict compilation as an explicit stage, then Babel on emitted JavaScript |

The final row is a two-stage user pipeline with explicit source-map
composition. It is not equivalent to sibling plugins observing Fict's original
TypeScript/JSX AST, and documentation MUST say so.

## Options considered

### Keep the preset as a permanent Rust bridge

Rejected. Generate-native-output, reparse-to-Babel bridges require two parser
and codegen lifecycles, make source maps and comments fragile, and cannot
preserve sibling visitor ordering or the relationship between `file.code` and
the live AST.

### Remove the preset as soon as Rust becomes default

Rejected. Default switching is itself the period when users most need a tested
whole-build rollback and a release in which to migrate custom Babel pipelines.

### Maintain the legacy compiler indefinitely

Rejected. Every language rule, diagnostic, metadata behavior, and security fix
would need two implementations. The migration would never achieve its
complexity or dependency goal.

### Move the preset to Satellite immediately

Rejected during the compatibility window. It is currently a Core contract and
must remain in lockstep verification until the announced breaking removal.
After removal, a new Satellite is possible only if real demand justifies its
maintenance cost.

## Consequences

Positive:

- users get a working native replacement before deprecation starts;
- the default switch retains a tested whole-build rollback for a bounded
  period;
- no incomplete bridge expands the Rust compiler's compatibility promise;
- M9 has an objective release boundary for removing Babel and shrinking Core.

Costs and constraints:

- Fict carries both implementations through one stable minor after the default
  switch;
- preset regressions remain release-blocking throughout that window;
- the breaking removal requires coordinated scope, Changesets, docs, API, and
  package-release changes;
- custom Babel users must adopt an explicit two-stage pipeline or pin the final
  historical preset.

## Risks

- The compatibility window could drift and become permanent.
- A warning could start before all replacement integrations are usable.
- Users could accidentally run legacy and Rust on different files.
- Removing the package from Core without removing all dependency edges could
  preserve Babel in production installs.

Milestone and release checks MUST record the phase, default backend, final
preset version when known, and remaining dependency edges. M9 fails if the
preset remains in the fixed group, a production package imports it, or a build
can silently mix backends.

## Human review requirements

Maintainers MUST explicitly approve entry into Phase B, the Rust-default
release, and Phase D removal. Review must confirm replacement availability,
published migration guidance, semantic and rollback evidence, the completed
subsequent-minor window, final-version publication, and coordinated Core scope
changes.

## Verification

During Phases A–C:

```bash
pnpm -C packages/compiler test -- babel-typescript-integration.test.ts
pnpm -C packages/babel-preset build
pnpm test:babel-preset:deprecation
pnpm test:compiler:differential
pnpm test:compiler:rollout-state
pnpm test:bundlers:strict-guarantee
pnpm test:api-boundaries
pnpm test:release-publish-plan
```

At Phase D, repository and packed-artifact checks MUST prove that no Core
runtime dependency, export, loader, fixed-group entry, or release plan refers
to `@fictjs/babel-preset` or the legacy compiler. Historical package
installability is verified against the registry separately from the current
workspace.

## Related decisions

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md)
- [Fict Rust Compiler Architecture](../architecture/rust-compiler.md)
- [SCOPE — What Is Core, What Is Satellite, What Is Preview](../../SCOPE.md)
- [API Freeze and Deprecation Policy](../api-freeze-v1.md#7-deprecation-policy)
