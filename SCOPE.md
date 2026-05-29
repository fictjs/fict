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

> **Status: active (Steps 1–2 landed).** This file separates **TARGET state**
> (the tiers and rule below) from **CURRENT fact** (see _Migration status_).
> Steps 1–2 (this contract + the changeset Core lockstep) landed together in one
> atomic commit; Steps 3–6 are still pending and are flagged as such. Treat
> anything not yet checked off as target, not live.

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

| Package                    | Tier          | Notes                                                                                                                                                                  |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fict`                     | **Core**      | Public API surface. Only `.`, `/jsx-runtime`, `/jsx-dev-runtime`, `/plus`, `/advanced` are guaranteed.                                                                 |
| `@fictjs/runtime`          | **Core**      | Reactive graph + fine-grained DOM.                                                                                                                                     |
| `@fictjs/compiler`         | **Core**      | HIR/SSA/region lowering. The thesis lives here.                                                                                                                        |
| `@fictjs/babel-preset`     | **Core**      | Compiler plumbing; versions with the compiler.                                                                                                                         |
| `@fictjs/vite-plugin`      | **Core**      | The delivery mechanism. Without it nobody can use Fict.                                                                                                                |
| `@fictjs/eslint-plugin`    | **Core**      | Mirrors compiler diagnostics — part of the fail-closed DX, not an add-on.                                                                                              |
| `@fictjs/ssr`              | **Satellite** | `renderToString`/`renderToStream`/`renderToPipeableStream` are the supported surface. Streaming/resume/PPR is **Preview** (see below).                                 |
| `@fictjs/router`           | **Satellite** | A router may lag Core. Best candidate to invite a second maintainer (reduces truck factor).                                                                            |
| `@fictjs/testing-library`  | **Satellite** | Adoption-enabling; frozen API, downstream of runtime stability.                                                                                                        |
| `@fictjs/devtools`         | **Internal**  | Browser extension / Vite auto-inject — a **distribution artifact**, not an npm library. Already in changesets `ignore`. Feature-frozen.                                |
| `@fictjs/vscode-extension` | **Internal**  | Editor extension via the VS Code Marketplace, not npm. **Currently independent** in changesets — should move to `ignore` to match this tier (pending). Feature-frozen. |
| `@fictjs/mcp`              | **Internal**  | Agent/docs tooling. Should be `private` or spun out (see "The two-thesis trap").                                                                                       |
| `@fictjs/skill`            | **Internal**  | Agent skill. Same as `mcp`.                                                                                                                                            |
| `@fictjs/playground`       | **Internal**  | Dev/demo tool.                                                                                                                                                         |
| `fict-docs-site`           | **Internal**  | Already private.                                                                                                                                                       |

### Preview surface (lives inside Core/Satellite packages, but NOT guaranteed)

These are explicitly **not** under semver and **not** under the guarantee bar.
See [docs/PREVIEW.md](./docs/PREVIEW.md) for the policy and the required
degradation contract.

- `@fictjs/ssr`: `renderToPartial` (partial prerendering), the resumability /
  QRL handler extraction path, and the SSR snapshot schema.
- Anything exported from `fict/experimental` (export subpath to be added; see
  migration step 3).

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

`@fictjs/mcp` and `@fictjs/skill` are tooling for **AI agents to consume Fict**.
For a project with ~zero production users, shipping them as versioned product
packages is a second, implicit thesis ("AI-native distribution is the GTM").

**A solo project cannot carry two core theses.** Pick one:

- If _compiler-first reactivity_ is primary (the assumption here) → `mcp`/`skill`
  are **Internal**: `"private": true` or spin out to a separate `fict-ai-tools`
  repo. They must not compete with Core for attention or version surface.
- If _AI-native distribution_ is primary → that is a different project; do not
  let it share one maintainer's attention with the compiler.

> **Decision (2026-05):** primary thesis is compiler-first reactivity →
> `@fictjs/mcp` and `@fictjs/skill` are set `"private": true` (Step 4). They stay
> in-repo as internal dev tooling; spinning them out to a `fict-ai-tools` repo
> later remains open and does not change this contract.

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
      `mcp`/`skill` added to `ignore`. (See `.changeset/config.json`.)
- [ ] **Step 3 — Add `fict/experimental` entrypoint.** New `packages/fict/src/experimental.ts` + `./experimental` export map entry + tsup entry. Move Preview re-exports
      there. Sweep `@experimental` JSDoc onto Preview APIs.
- [x] **Step 4 — Privatize internal tooling.** Set `"private": true` on
      `@fictjs/mcp` and `@fictjs/skill` (and dropped their `publishConfig`), per
      "The two-thesis trap". Spin-out to `fict-ai-tools` remains open.
- [ ] **Step 5 — Preview degradation contracts.** Implement the resume-failure
      fallbacks defined in [docs/PREVIEW.md](./docs/PREVIEW.md) before any
      Preview API is considered for graduation.
- [x] **Step 6 — Re-tier docs.** SSR docs (deployment, resume-stability,
      performance, SEO) now carry a maturity banner: `@fictjs/ssr` is a Satellite
      and resume/PPR are Preview. Tier-0 docs (semantics, diagnostics, guarantee
      matrix, compiler spec) remain Core (unchanged).

> **Remaining:** Steps 3 (`experimental` entrypoint) and 5 (Preview degradation
> contracts) are deferred — each is a build/test-touching change that warrants
> its own verified PR (Step 3 moves `renderToPartial` off the `@fictjs/ssr` main
> export, a breaking API change; Step 5 implements the failure modes in
> [docs/PREVIEW.md](./docs/PREVIEW.md)). When both land, collapse this block to
> the map + rule as the standing contract.
