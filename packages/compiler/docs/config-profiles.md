# Native Compiler Config Profiles

Applications configure these options through `@fictjs/vite-plugin` or the
native Webpack loader. Direct hosts place the equivalent values in
`CompileRequest.options`.

## App default

```ts
fict({
  strictGuarantee: true,
  lazyConditional: true,
  optimizeLevel: 'safe',
})
```

This is the supported production baseline. Official integrations force
`strictGuarantee` when `NODE_ENV=production`.

## CI hard gate

```ts
fict({
  strictGuarantee: true,
  strictReactivity: true,
  warningsAsErrors: true,
})
```

Also set the integration-level override:

```bash
FICT_STRICT_GUARANTEE=1
```

## Non-production migration inventory

```ts
fict({
  strictGuarantee: false,
  dev: true,
  onWarn(warning) {
    console.warn(warning)
  },
})
```

Use this only to inventory diagnostics in a migration branch. Production builds
restore fail-closed behavior.

## Direct host

```ts
transformSync({
  code,
  filename,
  options: {
    strictGuarantee: true,
    sourcemap: true,
    typescript: { allowNamespaces: true },
  },
  metadata: resolvedMetadataSnapshot,
})
```

The host owns graph resolution and passes a serializable metadata snapshot.
There is no 0.31 option for Babel sidecar emission or a legacy backend.
