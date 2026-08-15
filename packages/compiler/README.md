# @fictjs/compiler

OXC/Rust compiler facade for Fict. Since Fict 0.31 there is no TypeScript/Babel compiler,
`./legacy` export, or per-file fallback path.

Most applications should use `@fictjs/vite-plugin` or
`@fictjs/webpack-plugin`. Install this package directly only when building a
compiler host:

```bash
npm install @fictjs/compiler
```

## Request API

The package root exposes serializable synchronous and asynchronous APIs:

```ts
import {
  COMPILER_CAPABILITY_MANIFEST,
  COMPILER_CAPABILITY_MANIFEST_DIGEST,
  COMPILER_PROTOCOL_VERSION,
  nativeCompilerInfo,
  scanSync,
  transformSync,
} from '@fictjs/compiler'

const info = nativeCompilerInfo()
if (info.backend !== 'rust') throw new Error('Unexpected compiler binding')
if (
  info.compilerCapabilityManifestDigest !== COMPILER_CAPABILITY_MANIFEST_DIGEST ||
  info.compilerCapabilityPackageVersion !== COMPILER_CAPABILITY_MANIFEST.packageVersion
) {
  throw new Error('Compiler facade and native capabilities do not match')
}

const scan = scanSync({
  protocolVersion: COMPILER_PROTOCOL_VERSION,
  code: source,
  filename: 'src/App.tsx',
})

const result = transformSync({
  protocolVersion: COMPILER_PROTOCOL_VERSION,
  code: source,
  filename: 'src/App.tsx',
  options: {
    strictGuarantee: true,
    sourcemap: true,
  },
  metadata: [],
})
```

The root also exports `transform`, `scan`, `analyzeSync`, and `analyze`. The
facade loads and validates the platform optional package on the first request,
then reuses that binding for the process. A missing or incompatible native
package is a hard error.

Code importing the former Babel plugin, global metadata cache, fingerprint, or
tooling helpers should follow the
[legacy API replacement table](../../docs/migration-guide.md#legacy-compiler-api-replacements);
those APIs were removed or relocated rather than silently aliased.

`FICT_COMPILER_NATIVE_PATH` and the lower-level
`@fictjs/compiler/native` loader are for local compiler development and release
verification. Normal consumers must let the facade select one of the eight
published platform packages.

## Host boundary

Callbacks, filesystem resolution, and bundler graph objects do not cross the
native boundary. Hosts scan imports, resolve their own graph, and pass a
`ResolvedMetadataInput[]` snapshot on each transform or analyze request.
Diagnostics, source maps, compiler artifacts, stats, and module metadata are
returned as structured data.

Every compile, scan, and analyze request accepts an optional `limits` object.
The native boundary checks source bytes before parsing, the complete request,
input metadata and source maps, HIR nodes before compiler passes, retained
diagnostics, aggregate generated maps, and the complete serialized result.
Semantic AST-node, scope, and symbol ceilings stop a request after the first
frontend analysis and before the second parse and HIR construction.
Defaults and non-disableable hard caps are declared on `RequestLimits` in the
package types; an exceeded limit returns a fail-closed `FICT-REQUEST` result.

Deadlines, cancellation, concurrency limits, queue backpressure, and
per-request process or worker isolation are deliberately host responsibilities.
An online compiler that accepts untrusted source must enforce those controls
outside the native library; `RequestLimits` does not make an in-process service
safe against OOM, abort, or stack exhaustion.

Compiler timing and counter stats always cross N-API as non-negative JavaScript
`number` safe integers. Values above `Number.MAX_SAFE_INTEGER` saturate at that
maximum instead of becoming `bigint` or losing precision.

`RawSourceMap` accepts only a standard non-indexed Source Map v3. An indexed map
with `sections` is rejected instead of being partially interpreted; a bundler
host must flatten it to one ordinary `sources`/`mappings` map before assigning
it to `inputSourceMap`. For multi-source composition, set `inputSourceMap.file`
to the unique intermediate source that the compiler output should trace.

The native options include:

- `strictGuarantee` (default in official integrations): fail closed when
  reactivity cannot be guaranteed;
- `strictReactivity`, `warningsAsErrors`, and `warningLevels`: diagnostic
  policy;
- `dev`: attach authored source labels to signal, memo, and effect DevTools
  registrations;
- `lazyConditional`: lower supported reactive control-flow returns through
  runtime branch bindings; `false` preserves authored control flow but removes
  that re-execution capability, so reactive branch returns report `FICT-R006`
  and fail closed unless a non-production build explicitly opts out of
  `strictGuarantee`;
- `getterCache`: cache repeated signal/accessor reads inside safe synchronous
  callbacks; `false` emits every read directly;
- `fineGrainedDom` and `optimize`: lowering controls;
- `optimizeLevel`: keep authored expressions in the conservative `'safe'`
  profile (default), or opt into `'full'` constant propagation and legacy
  algebraic identities;
- `reactiveScopes`: names whose first callback is a compiler-recognized
  reactive scope;
- `typescript`: serializable OXC TypeScript lowering controls;
- `preview`: default-off resumability controls that are not part of the Core
  1.0 promise.

`inlineDerivedMemos` defaults to `true`. Set it to `false` to preserve eligible
user-named single-use derived memos. Compiler-generated `__*` temporaries may
still be inlined, and user-named values in hooks remain memoized in both modes.

`COMPILER_CAPABILITY_MANIFEST` is deliberately scoped to
`certified-behavior-variant-options`. It records only the five option families
whose non-default behavior is covered by the reviewed compatibility audits:
`dev`, `lazyConditional`, `getterCache`, `optimizeLevel`, and
`inlineDerivedMemos`. It is not an exhaustive schema for
`NativeCompilerOptions`; options such as `sourcemap`, diagnostic policy,
`reactiveScopes`, `typescript`, and `preview` remain supported through the
request API even though they are absent from this certification manifest.

Production integrations force fail-closed guarantees. Use relaxed options only
in non-production migration experiments.

## Package metadata

Bundlers that own package resolution import the Node-only graph services from
`@fictjs/compiler/graph-host`:

```ts
import {
  parseModuleReactiveMetadata,
  resolvePackageModuleMetadata,
} from '@fictjs/compiler/graph-host'
```

The graph host accepts only the versioned Rust metadata schema and package
declarations under `package.json#fict.metadata` or `package.json#fict.exports`.
Unversioned payloads, unknown schema fields, paths outside the package, and the
retired root `fictMetadata` declaration fail closed. It does not read or write
source-adjacent Babel sidecars or `.fict-cache/metadata`.

Direct hosts own scan, resolution, fingerprints, and invalidation, then pass a
`ResolvedMetadataInput[]` snapshot in `CompileRequest.metadata`. The compiler
does not expose the former process-global `setModuleMetadata`,
`clearModuleMetadata`, or `invalidateModuleMetadata` state.

See [Third-party Fict libraries](../../docs/third-party-libraries.md) for the
publishing contract.

## Operational recovery

`0.30.1` is the final release containing `@fictjs/compiler/legacy` and
`@fictjs/babel-preset`. In 0.31, recovery means restoring the complete 0.30.1
application dependency set, generated output, metadata, and caches. Mixing
legacy output with the 0.31 compiler/runtime graph is unsupported.

Platform support is defined by
[ADR-0002](../../docs/adr/0002-native-compiler-support-matrix.md). The final
migration sequence is documented in the
[migration guide](../../docs/migration-guide.md).
