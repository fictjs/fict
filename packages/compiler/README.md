# @fictjs/compiler

OXC/Rust compiler facade for Fict. Fict 0.31 has no TypeScript/Babel compiler,
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
  COMPILER_PROTOCOL_VERSION,
  nativeCompilerInfo,
  scanSync,
  transformSync,
} from '@fictjs/compiler'

const info = nativeCompilerInfo()
if (info.backend !== 'rust') throw new Error('Unexpected compiler binding')

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
`ResolvedMetadataInput[]` snapshot on each transform request. Diagnostics,
source maps, compiler artifacts, stats, and module metadata are returned as
structured data.

The native options include:

- `strictGuarantee` (default in official integrations): fail closed when
  reactivity cannot be guaranteed;
- `strictReactivity`, `warningsAsErrors`, and `warningLevels`: diagnostic
  policy;
- `dev`: attach authored source labels to signal, memo, and effect DevTools
  registrations;
- `lazyConditional`: lower supported reactive control-flow returns through
  runtime branch bindings; `false` preserves the authored control flow;
- `getterCache`: cache repeated signal/accessor reads inside safe synchronous
  callbacks; `false` emits every read directly;
- `fineGrainedDom` and `optimize`: lowering controls;
- `reactiveScopes`: names whose first callback is a compiler-recognized
  reactive scope;
- `typescript`: serializable OXC TypeScript lowering controls;
- `preview`: default-off resumability controls that are not part of the Core
  1.0 promise.

Two wire-compatibility fields currently accept only their defaults:
`optimizeLevel: 'safe'` and `inlineDerivedMemos: true`. A non-default value fails
with `FICT-OPTION-UNIMPLEMENTED`; it is never silently ignored.

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
