# Native Compiler Config Profiles

Applications configure these options through `@fictjs/vite-plugin` or the
native Webpack loader. Direct hosts place the equivalent values in
`CompileRequest.options`.

## App default

```ts
fict({
  strictGuarantee: true,
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
  onWarn(warning) {
    console.warn(warning)
  },
})
```

Use this only to inventory diagnostics in a migration branch. Production builds
restore fail-closed behavior.

Set `dev: true` to attach authored source labels to signal, memo, and effect
DevTools registrations. Set `lazyConditional: false` to preserve authored
control-flow returns instead of installing runtime branch bindings. `getterCache`
caches repeated signal/accessor reads only inside safe synchronous callbacks;
set it to `false` to emit every read directly. `optimizeLevel: 'full'` opts into
constant propagation and legacy algebraic identities; the default `'safe'`
profile leaves authored algebra alone. `inlineDerivedMemos` remains in the
request schema for compatibility and accepts only `true`; `false` fails with
`FICT-OPTION-UNIMPLEMENTED`.

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
