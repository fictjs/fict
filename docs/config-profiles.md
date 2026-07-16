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
- `dev: NODE_ENV !== 'production' && NODE_ENV !== 'test'`

Official bundler integrations keep module metadata in their graph and consume
versioned metadata published by third-party packages. The 0.31 compiler does not
write source-adjacent or `.fict-cache/metadata` sidecars.

## Recommended Profiles

### Dev (local development)

```ts
{
  dev: true,
  sourcemap: true,
  strictGuarantee: true,
  strictReactivity: false,
}
```

### CI (merge gate / release gate)

```ts
{
  dev: true,
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
