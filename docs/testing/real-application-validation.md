---
type: test-plan
title: Real Application Validation
description: Continuous production-shaped browser, resource, SSR, concurrency, and soak coverage for Fict release candidates.
owner: NEEDS_OWNER
status: proposed
tags: [e2e, applications, ssr, soak, release]
---

# Real Application Validation

## Purpose

Package-level tests remain necessary, but they do not reproduce the lifetime,
composition, and mixed workload of an application. Fict therefore keeps three
production-shaped applications in the release path:

| Application                | Production workload                                                                             | Required evidence                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Operations suite           | Dashboard churn, form validation, nested routes, async resources, auth, and error recovery      | Browser interactions complete without page or console errors.                                      |
| Release operations console | Server-rendered capacity controls, a form, list filtering, serialized state, and Preview resume | Raw HTML contains SSR state and browser events resume from production assets.                      |
| Streaming command center   | Deferred Suspense panels and concurrent Node requests                                           | The shell streams before deferred content, every response completes, and the final page is usable. |

These are medium, maintained fixtures rather than isolated API demos. They use
the same production builds and servers that a consumer would deploy.

## Commands and cadence

Run the normal gate with:

```bash
pnpm test:real-apps
```

It builds all three applications, runs the streaming first-byte smoke test, and
then drives them through Chromium. The default mixed browser/SSR soak lasts 10
seconds and runs in pull requests, pushes, and `release:verify` through
`pnpm test:e2e`.

The scheduled CI workflow raises the soak duration to three minutes. The same
profile is available locally:

```bash
pnpm test:real-apps:long
```

`FICT_REAL_APP_SOAK_MS` may select another duration between one second and ten
minutes. A longer duration does not relax assertions or convert failures into
warnings.

## Workload contract

The suite MUST keep all of these paths active:

1. Submit a form whose validation changes its approval branch.
2. Navigate a nested route and resolve a parameterized detail screen.
3. Load and refetch a `createResource` value through visible loading and ready states.
4. Trigger and recover an `ErrorBoundary` while preserving surrounding state.
5. Fetch SSR output directly, then exercise the delivered page in a browser.
6. Send concurrent streaming SSR requests and verify complete deferred content.
7. Repeatedly mount and unmount application regions while interleaving SSR traffic for the configured soak duration.

Any feature replacing one of these flows must preserve the corresponding
coverage in the same commit.

## Interpretation and limits

This gate detects integration regressions that narrow unit tests can miss, but it
is not evidence of broad ecosystem adoption. Release owners should still run
pre-release builds in independent applications and review production telemetry,
memory behavior, accessibility, and browser diversity. A green fixture suite
must never be presented as a substitute for real external user load.
