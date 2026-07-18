# Fict Config Profiles (Dev / CI / Prod)

This document defines practical defaults for compiler/runtime configuration.

- Compiler defaults prioritize DX and correctness.
- Runtime defaults prioritize DX in development and performance in production.

## Compiler Defaults

Current `@fictjs/compiler` defaults:

- `fineGrainedDom: true`
- `lazyConditional: true`
- `getterCache: true`
- `optimize: true`
- `optimizeLevel: 'safe'`
- `inlineDerivedMemos: true`
- `strictGuarantee: true`
- `NODE_ENV=production` force-enables `strictGuarantee` even when options request opt-out
- `strictReactivity: false`
- `dev: false`

Set `dev: true` to attach authored source labels to signal, memo, and effect
DevTools registrations. Set `lazyConditional: false` to preserve authored
control-flow returns instead of installing runtime branch bindings. `getterCache`
caches repeated signal/accessor reads only inside safe synchronous callbacks;
set it to `false` to emit every read directly. `optimizeLevel` and
`inlineDerivedMemos` are compatibility fields that currently accept only their
defaults above. Non-default values fail with `FICT-OPTION-UNIMPLEMENTED`.

Official bundler integrations keep module metadata in their graph and consume
versioned metadata published by third-party packages. The 0.31 compiler does not
write source-adjacent or `.fict-cache/metadata` sidecars.

## Recommended Profiles

### Dev (local development)

```ts
{
  sourcemap: true,
  dev: true,
  strictGuarantee: true,
  strictReactivity: false,
}
```

### CI (merge gate / release gate)

```ts
{
  sourcemap: true,
  strictGuarantee: true,
  strictReactivity: true,
}
```

And force strict mode globally in CI:

```bash
FICT_STRICT_GUARANTEE=1
```

### Prod (application build)

```ts
{
  dev: false,
  sourcemap: false, // or hidden/external, per deployment policy
  strictGuarantee: true,
  strictReactivity: false,
}
```

## Runtime Defaults

Cycle protection defaults:

- Development: enabled (`NODE_ENV !== 'production'`)
- Production: disabled (`NODE_ENV === 'production'`)

Optional runtime tuning:

```ts
import { setCycleProtectionOptions } from 'fict/advanced'

// Dev/soak test strict mode
setCycleProtectionOptions({
  enabled: true,
  devMode: true,
})

// Production performance-first (default behavior)
setCycleProtectionOptions({
  enabled: false,
})
```

For option details, see `docs/cycle-protection.md`.
