---
type: test-plan
title: Review Regression Suite
description: Focused verification plan for high- and medium-risk repository review findings.
owner: NEEDS_OWNER
status: proposed
tags: [regression, release-gate, review]
---

# Review Regression Suite

## Purpose

Every high- or medium-risk defect confirmed by the repository review MUST retain a focused behavioral test. The aggregate command exists so these tests remain runnable as one gate even if package scripts or the Turbo graph change.

This suite is not a substitute for package test suites or `release:verify`. It is the shortest executable path from the review findings to their regression evidence.

## Coverage contract

| Area             | Behavior that MUST remain covered                                                                                                                                                              | Focused suite                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSR              | Comment data cannot terminate its wrapper; parser contexts stay inert; strict-CSP snapshots avoid executable inline scripts; compatibility globals restore transactionally and reject overlap. | `packages/ssr/test/html-serializer.test.ts`, `packages/ssr/test/globals.test.ts`, `packages/ssr/test/streaming.test.ts`                                                                                                       |
| Vite             | Split resumable handlers retain named default-export dependencies.                                                                                                                             | `packages/vite-plugin/src/__tests__/index.test.ts`                                                                                                                                                                            |
| Runtime          | Selector equality classes and observer ownership remain reactive; undefined store keys retain presence tracking.                                                                               | `packages/runtime/test/signal.test.ts`, `packages/runtime/test/store.test.ts`                                                                                                                                                 |
| Runtime security | Snapshot markers, hostile object keys, prototypes, Proxy invariants, migrations, and async SSR sessions fail closed or remain isolated.                                                        | `packages/runtime/test/serialize.test.ts`, `packages/runtime/test/loader.test.ts`, `packages/runtime/test/resume-lifecycle.test.ts`, `packages/runtime/test/props-proxy.test.ts`, `packages/runtime/test/ssr-session.test.ts` |
| `fict`           | Resource failures clear public data; stores preserve presence and avoid proxying incompatible built-ins.                                                                                       | `packages/fict/test/resource.test.ts`, `packages/fict/test/store.test.ts`                                                                                                                                                     |
| Router           | Static route precedence, resource/Suspense behavior, followed redirects, declarative redirects, and native scroll restoration remain correct.                                                  | Router unit and integration files selected by `scripts/review-regression-suite.mjs`                                                                                                                                           |
| Testing library  | Exceptions from delayed condition checks reject the returned Promise.                                                                                                                          | `packages/testing-library/test/testEffect.test.ts`                                                                                                                                                                            |
| ESLint           | Recommended flat config loads and rules use lexical bindings rather than filename-wide names.                                                                                                  | Selected `packages/eslint-plugin/__tests__` files                                                                                                                                                                             |
| Webpack          | Babel's valid empty-string module output is accepted.                                                                                                                                          | `packages/webpack-plugin/src/__tests__/cold-build.test.ts`                                                                                                                                                                    |
| DevTools         | Page-world hook installation, live trace, documented Vite options, and hostile-value serialization remain safe.                                                                                | Selected `packages/devtools/test` files                                                                                                                                                                                       |
| Playground       | Failed session creation removes its temporary root.                                                                                                                                            | `packages/playground/test/session-creation-cleanup.test.ts`                                                                                                                                                                   |
| VS Code          | Unrelated JSX is ignored and live trace connection state is usable.                                                                                                                            | Selected `packages/vscode-extension/test` files                                                                                                                                                                               |

## Failure policy

- A referenced test file MUST NOT be removed without moving its regression case and updating the suite in the same change.
- A behavior change that intentionally reverses one of these rules requires human review and an update to the corresponding public contract.
- The gate MUST run with `FICT_STRICT_GUARANTEE` unset because several behavior-level fixtures intentionally exercise non-strict compilation.

## Verification

Run the focused gate from the repository root:

```bash
pnpm test:review-regressions
```

The executable source of truth for package selection is `scripts/review-regression-suite.mjs`. Full release evidence remains `pnpm release:verify`.
