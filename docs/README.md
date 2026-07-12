# Fict Documentation

This folder holds documentation for the Fict project. The canonical scope
boundary lives in [SCOPE.md](../SCOPE.md); Preview policy lives in
[PREVIEW.md](./PREVIEW.md).

## Start Here

- `fict.md` — **Start here!** Core design philosophy, technical overview, and how the compiler works
- `../SCOPE.md` — Core / Satellite / Preview / Internal tiers for the monorepo
- `PREVIEW.md` — Preview surface policy, entrypoint rules, and degradation contract
- `api-reference.md` — Developer-facing API reference

## Core Contracts

- `compiler-spec.md` — Compiler rules, lowering details, and formal semantics (v1.0)
- `reactivity-semantics.md` — Semantic rules for Fict reactivity (memoization, closures, call-site expansion)
- `reactivity-guarantee-matrix.md` — Guarantee matrix for compiler/runtime behavior
- `error-semantics.md` — Runtime contract for errors thrown in effects, cleanups, and memos
- `diagnostic-codes.md` — Complete reference for compiler warnings and errors with fixes
- `api-freeze-v1.md` — v1 API freeze map for stable public and compiler-dependent surfaces
- `config-profiles.md` — Recommended dev/CI/prod compiler + runtime profiles
- `release-policy.md` — SemVer, Changesets, changelog, and release note standards

## Architecture And Internals

- `architecture.md` — Runtime and compiler architecture notes
- `architecture/security-boundaries.md` — Security threat model, findings,
  non-goals, and executable evidence for HTML, snapshots, CSP, Proxy behavior,
  and SSR isolation
- `compiler-maintenance.md` — Compiler complexity budgets and profiling workflow
- `compiler-pass-invariants.md` — Internal compiler pass ownership and invariant checklist
- `metadata-packaging-architecture.md` — Architecture decision for compiler-generated metadata and build-time packaging
- `typecheck-hardening.md` — Typecheck hardening notes and policy
- `cycle-protection.md` — Runtime cycle protection semantics
- `scheduler.md` — Multi-priority scheduler and transition APIs
- `error-boundary.md` — Error boundary runtime semantics
- `store-api.md` — Public `$store` ownership and internal `createStore` boundary

## Guides

- `fiction-ui.md` — Product/design philosophy around the fiction layer
- `framework-comparison.md` — Comparison with React, Solid, Vue, Svelte
- `migration-guide.md` — Practical migration paths from React, Vue, Svelte, and Solid
- `strict-guarantee-cookbook.md` — Common strictGuarantee failures and rewrites
- `third-party-libraries.md` — Package metadata ABI for third-party Fict hook libraries
- `strict-guarantee-test-policy.md` — Policy for test suites that intentionally opt out of strict guarantee diagnostics

## SSR And Preview

- `ssr-deployment.md` — Deployment guides for Node, Vercel, Cloudflare Workers, and edge runtimes
- `ssr-performance.md` — SSR performance tuning and snapshot-size optimization
- `ssr-seo.md` — SEO best practices for SSR/streaming apps
- `ssr-resume-stability-contract.md` — Supported SSR streaming behavior plus Preview contracts for resume and PPR
- `ssr-runtime-matrix.md` — Release-gate matrix for SSR runtime, CSP, hydration, resumability, and streaming checks
- `preview-degradation-audit.md` — Current coverage audit for Preview degradation behavior

## Tooling

- `eslint-rules.md` — ESLint plugin rules
- `tooling-runtime-matrix.md` — Release-gate matrix for Vite, bundler examples, HMR, sourcemaps, CSP, and Trusted Types

## Testing

- `testing/review-regressions.md` — Focused regression gate for confirmed high- and medium-risk review findings
- `testing/release-verification.md` — Clean-checkout and publishable-tarball release verification contract
- `testing/real-application-validation.md` — Production-shaped application, SSR, concurrency, and scheduled soak gate

## Roadmap And Essays

- `post-v1-roadmap.md` — Post-v1 roadmap and deferred work
- `blog/fict.md` — Long-form Fict overview
- `blog/react-compiler-and-beyond.md` — React Compiler comparison essay
