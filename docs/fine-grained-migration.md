# Fine-grained DOM migration guide

This document explains how to adopt Fict's fine-grained DOM runtime/compile path in existing apps without regressing user-visible behaviour.

## Audience & scope

- Teams already using the `fict-compiler-ts` TypeScript transformer and the `fict/runtime` entrypoint.
- JSX coverage: intrinsic elements, `<Fragment>`, conditional expressions (`?:`, `&&`), and array `.map` for keyed lists.
- The guide reflects the GA default (fine-grained pipeline enabled since 2025-12-05) and the remaining opt-out levers if you need to fall back.

## Pre-flight checklist

1. Sync to the latest `main` (or a release that includes `enableFineGrainedRuntime`).
2. Ensure your CI can run the full unit/e2e suite twice (legacy + fine-grained modes) until rollout finishes.
3. Confirm there are no out-of-tree TypeScript transformers that re-write JSX before Fict runs—those can block the new lowering.

## Step 1 – Confirm (or disable) fine-grained compiler output

As of the 2025-12-05 build, the TypeScript transformer emits fine-grained DOM code by default—no config changes are required for greenfield apps. Only set `fineGrainedDom` when you need to temporarily opt out (for bisects or staged rollouts).

### ts-patch / `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    // ... existing options ...
    "plugins": [
      {
        "transform": "fict-compiler-ts",
        "fineGrainedDom": false, // opt out when debugging
      },
    ],
  },
}
```

### Programmatic usage

```ts
import { createFictTransformer } from 'fict-compiler-ts'
import ts from 'typescript'

const transformer = (program: ts.Program) =>
  createFictTransformer(program, {
    fineGrainedDom: false, // omit or set to true to stay on the default path
    getterCache: true,
  })

export default transformer
```

When the flag is `true` (the default), supported JSX templates lower to:

- `const el0 = document.createElement('div')` style node declarations.
- `bindText`, `bindAttribute`, `bindClass`, `bindStyle` calls wired directly to the DOM reference.
- Specialized keyed list renderers that reuse blocks instead of calling `renderItem` from scratch.

## Step 2 – Runtime opt-out lever

The runtime ships with fine-grained rendering enabled. Call `disableFineGrainedRuntime()` only when you need to fall back to the legacy rerender path (e.g., during a staged rollout or a regression bisect). Re-enable via `enableFineGrainedRuntime()` after the experiment finishes.

```ts
import { disableFineGrainedRuntime, enableFineGrainedRuntime, render } from 'fict/runtime'

if (import.meta.env.VITE_USE_LEGACY_RUNTIME === '1') {
  disableFineGrainedRuntime()
}

render(() => <App />, document.getElementById('root')!)

if (import.meta.hot) {
  import.meta.hot.dispose(() => enableFineGrainedRuntime())
}
```

- `render()` marks the container with `data-fict-fine-grained="1"` when the flag is on (the default). Check this attribute in screenshots/logs to verify which path rendered a page.
- Keep the kill-switch handy: call `disableFineGrainedRuntime()` before rendering to revert to the legacy mode, then re-enable once you're done investigating.

## Step 3 – Validate critical flows

| Area                          | What to verify                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyed lists                   | Items preserve DOM nodes, local state, and event handlers across insert/remove/reorder. Test primitives (`string[]`, `number[]`) and objects. |
| Fragments & conditionals      | Branch toggles should only touch the affected nodes. Focus/selection state stays intact.                                                      |
| Nested lists                  | Inner keyed lists update independently even when the outer list reshuffles.                                                                   |
| Text/attr bindings            | `bindText` and `bindAttribute` respond to rapid state changes without remounting parents.                                                     |
| Hydration/SSR (if applicable) | Ensure the generated markup still matches the client output before enabling the flag in production.                                           |

Automate these checks in CI by running the suite twice (once with the flag on, once off) or by dedicating a stage job.

## Step 4 – Rollout strategy

1. **Staging soak:** Run with the default (fine-grained) compiler/runtime settings, but keep the opt-out env vars wired so you can flip back instantly if telemetry spikes.
2. **Canary cohorts:** If you still need gradual rollout, gate the new path behind a remote toggle that calls `disableFineGrainedRuntime()` plus `fineGrainedDom: false` for the affected slice.
3. **Gradual expansion:** Remove the opt-out once KPIs stay flat for at least one release train; the default already points at the new path, so this mostly means deleting overrides.
4. **Cleanup:** After the legacy path is unused, delete rerender-specific helpers (`ManagedBranch`, `rerenderBlock`, etc.) and reduce build permutations.

Rollback remains straightforward: deploy with `disableFineGrainedRuntime()` (runtime) and/or set `fineGrainedDom` back to `false` (compiler).

## Known trade-offs & documentation requirements

- **Primitive proxy prototype exposure:** The runtime intentionally exposes native prototype methods on primitive proxies so code like `value.toFixed(2)` keeps working. Do not rely on `typeof` to detect proxies inside keyed lists.
- **Keyed items always rerender:** Even if a keyed item's value/index is unchanged, the runtime bumps a version counter to refresh bindings. This guarantees effects stay aligned with the latest closure state; it is a deliberate behaviour, not an optimization bug.
- **Primitive proxies are list-only:** Passing the proxy object outside of the keyed-list binding (e.g., directly into `createElement`) produces a static text node. Treat the proxy as an implementation detail of list renderers.

Call these trade-offs out in user-facing docs before GA.

## Adoption TODO

- [ ] Land a CI job that runs `pnpm test` with fine-grained compiler + runtime flags enabled.
- [ ] Document the feature flag usage in your project's dev handbook/onboarding.
- [ ] Verify analytics/error monitoring dashboards include the `data-fict-fine-grained` attribute for correlation.
- [ ] Schedule follow-up work to remove legacy rerender helpers now that the new path is the default.
