# Compiler Config Profiles

Use these presets as stable starting points for different environments.

## 1) App Default (Recommended)

Use fail-closed guarantees in normal application builds.

```ts
createFictPlugin({
  strictGuarantee: true,
  lazyConditional: true,
  emitModuleMetadata: 'auto',
})
```

Notes:

- `strictGuarantee` is already `true` by default.
- `emitModuleMetadata: 'auto'` writes only to cache (`.fict-cache/metadata`) when needed.

## 2) CI Hard Gate

Use strict compile failures for guarantee boundaries.

```ts
createFictPlugin({
  strictGuarantee: true,
  dev: false,
})
```

And enforce in CI environment:

```bash
FICT_STRICT_GUARANTEE=1
```

Notes:

- `strictGuarantee` disallows `fict-ignore` suppression and downgrade overrides for guarantee codes.
- Keep this on for production branches if you want fail-closed reactivity contracts.

## 3) Migration / Benchmark Compatibility

Use this when you must keep compiling legacy or intentionally fallback-heavy code.

```ts
createFictPlugin({
  strictGuarantee: false,
  dev: false,
})
```

Use cases:

- benchmark fixtures
- migration periods before codebase cleanup
- exploratory prototyping

## 4) One-shot Build / Fixture Mode (No Metadata Files)

Disable module metadata sidecar/cache output when cross-module reuse is unnecessary.

```ts
createFictPlugin({
  emitModuleMetadata: false,
})
```

Use cases:

- isolated fixture builds
- performance benchmark pipelines
- ephemeral CI jobs with no cross-module incremental analysis
