# SCOPE — What Is Core, What Is Satellite, What Is Preview

> This file is the **scope contract** for the Fict monorepo. It exists to make
> one decision _structural_ instead of relying on day-to-day discipline:
> **which surfaces are part of the product Fict promises to keep, and which are
> not.**
>
> Adding surface is cheap (especially with AI assistance). Keeping surface is
> not: every published package is a version, a changelog, a CI lane, and a bug
> inbox. The default in this repo is **contract minimalism** — expansion must be
> justified; contraction is free.

> **Status: active (Steps 1–6 landed).** This file separates the standing
> scope rule from the historical migration checklist below. The tiers and
> enforcement rules in this document now describe the live tree; the remaining
> work is graduation of individual Preview surfaces, not the migration itself.

## The rule

A surface belongs in **Core** if and only if:

1. **It serves the single thesis** — _compiler-first fine-grained reactivity
   with fail-closed guarantees, authored as plain TSX_; and
2. **Removing it breaks the thesis** (not merely "it's useful"); and
3. **It has converged** enough to be held to the guarantee bar
   (`strictGuarantee`, [reactivity-guarantee-matrix](./docs/reactivity-guarantee-matrix.md),
   [api-freeze-v1](./docs/api-freeze-v1.md)).

Fail any of the three → it is **not Core**. It is demoted, not deleted.

## Tiers

| Tier          | Held to guarantee bar? | Versioning              | Published?                                   | Meaning                                                                                              |
| ------------- | ---------------------- | ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Core**      | ✅ yes                 | Lockstep (`fixed`)      | ✅ public                                    | The thesis. `npm i fict @fictjs/vite-plugin` is exactly this set.                                    |
| **Satellite** | ❌ no (own contract)   | Independent (`0.x` ok)  | ✅ public                                    | Real product, but allowed to lag/iterate without dragging Core.                                      |
| **Preview**   | ❌ no — _no semver_    | Rides host package      | ⚠️ behind `experimental` export              | Aspirational surface. May change or be removed at any time.                                          |
| **Internal**  | ❌ no                  | Not released (`ignore`) | 🚫 `private`, or store-distributed (not npm) | Dev scaffolding **and** store/marketplace-distributed tooling. Not a changeset-released npm library. |

## The map

| Package                    | Tier          | Notes                                                                                                                                  |
| -------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `fict`                     | **Core**      | Public API surface. Only `.`, `/jsx-runtime`, `/jsx-dev-runtime`, `/plus`, `/advanced` are guaranteed.                                 |
| `@fictjs/runtime`          | **Core**      | Reactive graph + fine-grained DOM.                                                                                                     |
| `@fictjs/compiler`         | **Core**      | HIR/SSA/region lowering. The thesis lives here.                                                                                        |
| `@fictjs/babel-preset`     | **Core**      | Compiler plumbing; versions with the compiler.                                                                                         |
| `@fictjs/vite-plugin`      | **Core**      | The delivery mechanism. Without it nobody can use Fict.                                                                                |
| `@fictjs/eslint-plugin`    | **Core**      | Mirrors compiler diagnostics — part of the fail-closed DX, not an add-on.                                                              |
| `@fictjs/ssr`              | **Satellite** | `renderToString`/`renderToStream`/`renderToPipeableStream` are the supported surface. Streaming/resume/PPR is **Preview** (see below). |
| `@fictjs/router`           | **Satellite** | A router may lag Core. Best candidate to invite a second maintainer (reduces truck factor).                                            |
| `@fictjs/testing-library`  | **Satellite** | Adoption-enabling; frozen API, downstream of runtime stability.                                                                        |
| `@fictjs/webpack-plugin`   | **Satellite** | Official Webpack 5 compiler adapter; independently versioned so it does not expand the Core lockstep train.                            |
| `@fictjs/devtools`         | **Internal**  | Browser extension / Vite auto-inject — a **private distribution artifact**, not an npm library. Feature-frozen.                        |
| `@fictjs/vscode-extension` | **Internal**  | Private editor extension distributed through the VS Code Marketplace, not npm. Feature-frozen.                                         |
| `@fictjs/playground`       | **Internal**  | Private dev/demo tool.                                                                                                                 |
| `fict-docs-site`           | **Internal**  | Already private.                                                                                                                       |

### Preview surface (lives inside Core/Satellite packages, but NOT guaranteed)

These are explicitly **not** under semver and **not** under the guarantee bar.
See [docs/PREVIEW.md](./docs/PREVIEW.md) for the policy and the required
degradation contract.

- `@fictjs/ssr/experimental`: `renderToPartial` (partial prerendering) — now
  off the `@fictjs/ssr` main export. The resumability / QRL handler extraction
  path and the SSR snapshot schema remain Preview too.
- `fict/experimental`: not created yet — there is no framework-level Preview API
  to put there. Add the subpath when one exists (deferred part of step 3).

## Enforcement (how the rule is encoded, not just written)

1. **Version lockstep = Core membership.** The `fixed` array in
   [.changeset/config.json](./.changeset/config.json) **is** the Core list.
   Satellites are absent from both `fixed` and `ignore` (independent). Internal
   packages are in `ignore` and/or `"private": true`.
2. **Guarantee bar applies to Core only.** `strictGuarantee`, the guarantee
   matrix, and API-freeze cover Core packages. Satellites/Preview document their
   own, weaker, contract.
3. **Preview is reachable only through an `experimental` entrypoint** + an
   `@experimental` JSDoc tag, never from a package's main export.

## The two-thesis trap

The MCP server and agent skill library are tooling for **AI agents to consume
Fict**. For a project with ~zero production users, carrying them inside the
core monorepo as versioned product packages is a second, implicit thesis
("AI-native distribution is the GTM").

**A solo project cannot carry two core theses.** Pick one:

- If _compiler-first reactivity_ is primary (the assumption here) → MCP/skill
  tooling lives outside this monorepo. It must not compete with Core for
  attention or version surface.
- If _AI-native distribution_ is primary → that is a different project; do not
  let it share one maintainer's attention with the compiler.

> **Decision (2026-05):** primary thesis is compiler-first reactivity. The MCP
> server and skill library have moved to standalone repos (`mcp/` and `skill/`,
> remotes `fictjs/mcp` and `fictjs/skill`) and are no longer packages in this
> monorepo.

## Tripwire (prevents regression to breadth)

> **Before publishing any new package or version-locked surface, answer in the
> PR description:** _"Does this enter Core? If not, why must it be published at
> all (vs. `private`, vs. an independent `0.x` satellite)?"_
>
> Default answer is **do not publish / private / independent `0.x`**. Expansion
> requires an explicit, written justification. Contraction does not.

## Migration status

Tracks the move from "13 lockstep `0.21.0` packages" to "Core lockstep + a ring
of independent satellites + ignored internal tooling."

> **`[x]` means committed.** Steps 1–2 landed atomically (SCOPE.md +
> docs/PREVIEW.md + `.changeset/config.json` in one commit), so the docs never
> describe a config that isn't in the tree.

- [x] **Step 1 — Define tiers** (this file + [docs/PREVIEW.md](./docs/PREVIEW.md)).
- [x] **Step 2 — Encode Core via changesets.** `fixed` reduced to the 6 Core
      packages; `ssr`/`router`/`testing-library` moved to independent versioning;
      then-internal `mcp`/`skill` were temporarily added to `ignore` before their
      standalone repo split. (See `.changeset/config.json`.)
- [x] **Step 3 — Move Preview off main exports.** Added the
      `@fictjs/ssr/experimental` entrypoint and moved `renderToPartial` there,
      off the `@fictjs/ssr` main export (engine extracted to the internal
      `render-core` module; `.` re-exports only the supported surface). Verified:
      ssr build + SSR test suite + edge smoke + typecheck green. `fict/experimental`
      is intentionally not created — no framework-level Preview API exists to put
      there yet; add the subpath when one does.
- [x] **Step 4 — Move agent tooling out of the monorepo.** `@fictjs/mcp` and
      `@fictjs/skill` were first privatized, then migrated into standalone repos
      (`mcp/` and `skill/`). They no longer participate in this monorepo's
      workspace, Changesets config, or Turbo graph.
- [x] **Step 5 — Preview degradation contracts.** The current failure behavior
      is audited and test-backed in
      [preview-degradation-audit.md](./docs/preview-degradation-audit.md),
      including explicit legacy snapshot migration, one-shot
      application-owned CSR handoff after loader cleanup, sibling-scope
      isolation for resume failures, and streaming sink-error cleanup. The
      contract does not claim automatic CSR or ErrorBoundary routing for QRL
      failures.
- [x] **Step 6 — Re-tier docs.** SSR docs (deployment, resume-stability,
      performance, SEO) now carry a maturity banner: `@fictjs/ssr` is a Satellite
      and resume/PPR are Preview. Tier-0 docs (semantics, diagnostics, guarantee
      matrix, compiler spec) remain Core (unchanged).

> **Remaining:** the Preview degradation-contract migration work is complete.
> Graduation still requires the other [docs/PREVIEW.md](./docs/PREVIEW.md) gates
> (frozen API shape, release-gate matrix rows, and frozen snapshot-schema
> commitment). When those land, collapse this block to the map + rule as the
> standing contract.
