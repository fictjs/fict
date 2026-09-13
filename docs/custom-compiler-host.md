# Custom compiler hosts

Use `@fictjs/compiler` for the public request API. Both the root API and
`createNativeCompilerFacade()` from `@fictjs/compiler/native` pin one validated
native binding and apply the process environment policy on **each** transform and
analyze call. `NODE_ENV=production` or `FICT_STRICT_GUARANTEE=1` forces strict
guarantees, including when the request explicitly sets `strictGuarantee: false`.
Changing `dev` only changes generated development instrumentation.

`loadNativeCompilerBinding()` returns the raw native protocol. It does not read
JavaScript's `process.env`, resolve imports, or infer the build tool's mode. A host
using this lower-level API must apply `applyCompileRequestEnvironmentPolicy()` and
`applyAnalyzeRequestEnvironmentPolicy()` before dispatch, including worker-pool
calls. A build mode such as Vite's `mode` is host data; pass an explicit environment
to the policy helpers if it differs from `process.env`.

## Executable minimal host

The following example scans a module, asks the host resolver for each value import,
validates the returned metadata, and supplies one serializable snapshot to compile
or analyze. The resolver runs afresh for every request. The example has no cache,
watcher, publisher, or cyclic graph solver. Its final-emission check rejects an
incomplete graph instead of publishing provisional output.

`resolveMetadata(source, identity)` returns `{ resolvedId, status, metadata }`:

| Status            | Host obligation                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `resolved`        | Supply current compiler-generated metadata for the exact resolved module.                                                  |
| `opaque`          | Explicitly classify a dependency as ordinary JavaScript, with no inferred Fict reactive exports. This is a trust boundary. |
| `missing`         | Preserve a failed resolution or missing/invalid declared metadata; do not relabel it `opaque`.                             |
| `incompleteCycle` | Supply provisional facts during a graph fixed point. Final output must wait for convergence.                               |

`resolvedId` must include the host's query/variant identity. `filename` remains the
physical/source-map identity; `moduleId` carries virtual or query-bearing identity.
Type-only imports do not need runtime metadata. A mixed type/value dependency still
does. Built-in Fict runtime entries may be classified `opaque`: the native compiler
already knows their imported API identities.

<!-- executable-host-example:start -->

```js
import { createHash } from 'node:crypto'
import {
  applyCompileRequestEnvironmentPolicy,
  analyzeSync,
  scanSync,
  transformSync,
} from '@fictjs/compiler'
import { parseModuleReactiveMetadata } from '@fictjs/compiler/graph-host'

function definedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function checkResult(result) {
  if (result.internalError || result.diagnostics.some(d => d.severity === 'error')) {
    throw new Error(JSON.stringify(result.internalError ?? result.diagnostics))
  }
  return result
}

export async function prepareRequest(input, resolveMetadata, environment) {
  const request = definedFields(applyCompileRequestEnvironmentPolicy(input, environment))
  const { protocolVersion, code, filename, moduleId, language, moduleKind, limits } = request
  const scan = checkResult(
    scanSync(
      definedFields({ protocolVersion, code, filename, moduleId, language, moduleKind, limits }),
    ),
  )
  const sources = [
    ...new Set(scan.moduleRequests.filter(edge => !edge.typeOnly).map(edge => edge.source)),
  ]
  const metadata = []
  for (const source of sources) {
    const resolution = await resolveMetadata(source, { filename, moduleId: moduleId ?? filename })
    const { resolvedId, status } = resolution
    const known = status === 'resolved' || status === 'incompleteCycle'
    if (!known && status !== 'opaque' && status !== 'missing') {
      throw new Error(`Invalid metadata status for ${source}`)
    }
    if (
      status === 'missing' ? resolvedId !== null : typeof resolvedId !== 'string' || !resolvedId
    ) {
      throw new Error(`Invalid module identity for ${source}`)
    }
    const facts = known ? parseModuleReactiveMetadata(JSON.stringify(resolution.metadata)) : null
    if (known ? !facts : resolution.metadata !== null) {
      throw new Error(`Invalid metadata for ${source}`)
    }
    const fingerprint = `sha256:${createHash('sha256')
      .update(JSON.stringify([source, resolvedId, status, facts]))
      .digest('hex')}`
    metadata.push({ request: source, resolvedId, status, metadata: facts, fingerprint })
  }
  return { ...request, metadata }
}

export async function compileModule(input, resolveMetadata, environment) {
  const request = await prepareRequest(input, resolveMetadata, environment)
  const result = checkResult(transformSync(request))
  if (
    request.metadata.some(
      entry => entry.status === 'missing' || entry.status === 'incompleteCycle',
    ) ||
    result.metadataIncomplete ||
    result.unresolvedMetadataRequests.length
  ) {
    throw new Error('Resolve the complete metadata graph before final emission')
  }
  return result
}

export async function analyzeModule(input, resolveMetadata, environment) {
  const request = await prepareRequest(input, resolveMetadata, environment)
  const {
    protocolVersion,
    code,
    filename,
    moduleId,
    language,
    moduleKind,
    metadata,
    integrationDiagnostics,
    limits,
    options: compilerOptions,
  } = request
  return analyzeSync(
    definedFields({
      protocolVersion,
      code,
      filename,
      moduleId,
      language,
      moduleKind,
      metadata,
      integrationDiagnostics,
      limits,
      options: { compilerOptions },
    }),
  )
}
```

<!-- executable-host-example:end -->

Analysis returns diagnostics to the editor, including errors; `compileModule`
throws on errors before output can be published. Do not determine success from
`result.code` alone: an empty valid module may have empty output, while an
`incompleteCycle` result can contain executable but provisional code.
Omit absent optional request fields; JavaScript `undefined` is not a JSON value.
In particular, `limits: undefined` reaches native decoding as `null`, which is not
a valid `RequestLimits` object. The example omits absent top-level fields explicitly.

## Resolving packages and local modules

Compile local dependencies first and pass their `result.moduleMetadata` to the
consumer. Publish that generated schema through `package.json#fict.metadata` or
`fict.exports`. A hook returning `{ count }` can describe `count` as a signal;
the consumer then emits an accessor read. No module-global metadata cache exists
in the compiler.

Use `resolvePackageModuleMetadataState()` from `@fictjs/compiler/graph-host` for
package declarations. Its states map to the request protocol as follows:

| Package state         | Snapshot status                                                        |
| --------------------- | ---------------------------------------------------------------------- |
| `resolved`            | `resolved`, with the validated metadata and exact resolved module ID   |
| `missing` / `invalid` | `missing`, with `metadata: null` and `resolvedId: null`                |
| `plain`               | `opaque` only when the host accepts the package as ordinary JavaScript |

A package without a `fict` declaration is `plain`. This cannot prove that its
implementation does not contain compiled Fict hooks. The host or publisher must
identify Fict libraries and require their metadata; `strictGuarantee` cannot recover
information deliberately discarded by an `opaque` snapshot. This is also why
handwriting `{ version: 1, exports: {} }` for an unknown Fict library is incorrect.
Schema validation checks structure, not the truth of a publisher's declarations.

For PnP, aliases, and virtual importers, supply the graph service's `resolvePackage`
callback. Return an exact package manifest boundary, or a discriminated final
state. `null` is an authoritative miss; `undefined` requests the physical
`node_modules` fallback. Authoritative resolved metadata is schema-validated too.
Use `onDependency` to watch every consulted manifest and metadata path, including
missing paths so later creation can repair the build.

The example's fingerprints change with resolution identity, status, or metadata.
A production cache also needs source and input-map content, effective options,
compiler build **and selected native artifact** identity, and relevant resolver or
plugin configuration. Invalidate dependents after graph changes and rerun the SCC
solver for cycles. Do not cache unresolved output as a successful build. See
[compiler-aware caching](./reactivity-implementation-plan.md#s6-compiler-aware-build-caching).

Run `pnpm test:compiler:custom-host` for the real-addon environment, recipe,
metadata-change, and live consumer checks. `pnpm test:compiler:native-packages`
also executes the environment and recipe contracts after an isolated tarball
installation through both ESM and CommonJS package exports.
