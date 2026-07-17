# Migration Guide

This guide helps teams move code from React, Vue, Svelte, or Solid to Fict.
It is not a compatibility promise: Fict keeps JSX/TSX ergonomics, but it
compiles to a fine-grained graph with fail-closed reactivity guarantees.

## Migration Strategy

1. Start with leaf components and isolated routes.
2. Keep behavior tests around the component before changing reactivity.
3. Run the first compile with `strictGuarantee: false` only in a
   non-production migration branch to collect diagnostics.
4. Fix diagnostics with the patterns below.
5. Enable default `strictGuarantee: true` before merging.
6. Add `FICT_STRICT_GUARANTEE=1` to CI build steps so later config drift fails.

Use `strictGuarantee: false` as an inventory tool, not as a long-term app
profile. Production builds force strict guarantee back on.

## Compiler Backend Migration

Fict 0.31 has one compiler: the OXC-native Rust implementation. Vite uses it
without a backend option:

```ts
import fict from '@fictjs/vite-plugin'

export default {
  plugins: [fict()],
}
```

The completed compatibility line is:

| Release  | Compiler role                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `0.29.0` | First published Rust-default release; whole-build legacy rollback remains available.                 |
| `0.30.0` | Subsequent stable compatibility minor; Rust remains the default and legacy remains release-blocking. |
| `0.30.1` | Final release of the Babel preset, `@fictjs/compiler/legacy`, and in-tree rollback implementation.   |
| `0.31.0` | Pre-1.0 Rust-only breaking release; rollback means pinning the whole application to `0.30.1`.        |

Before changing versions, make the migration explicit:

1. Upgrade the complete Fict dependency set to `0.30.1` and establish a green
   baseline.
2. Remove `@fictjs/babel-preset`, `@fictjs/compiler/legacy`, Babel Fict config,
   and any direct `createFictPlugin` import.
3. Remove Vite `backend` / `shadow` options and `FICT_COMPILER_BACKEND` from
   source, CI, containers, and deployment configuration.
4. Replace custom Webpack Babel compilation with
   `@fictjs/webpack-plugin/loader` plus `FictWebpackPlugin`.
5. Delete source-adjacent compiler metadata and `.fict-cache/metadata`; Fict 0.31
   uses graph-host snapshots and versioned package metadata instead.
6. Upgrade the Core packages together, reinstall from a clean lockfile, and run
   the native smoke below before the application test suite.

After installing the release, run this package-root smoke from the application
directory. It proves that the selected platform binding is Rust and executes a
real native transform instead of merely finding package files:

```bash
node --input-type=module <<'EOF'
import assert from 'node:assert/strict'
import {
  COMPILER_PROTOCOL_VERSION,
  nativeCompilerInfo,
  transformSync,
} from '@fictjs/compiler'

const info = nativeCompilerInfo()
assert.equal(info.backend, 'rust')
const result = transformSync({
  protocolVersion: COMPILER_PROTOCOL_VERSION,
  filename: '/migration-smoke.ts',
  code: 'export const answer: number = 42',
  options: {},
})
assert.equal(result.diagnostics.length, 0)
assert.match(result.code, /answer\s*=\s*42/)
console.log(info)
EOF
```

There is no `legacy`, `rust`, or `shadow` selector in 0.31 and no per-file
fallback. A native binding load failure or compiler diagnostic fails the build.
Operational rollback is therefore a dependency rollback: restore the complete
`0.30.1` lockfile, generated output, metadata, and caches as one release unit.
Do not mix a 0.30.1 compiler or preset with a 0.31 runtime or integration.

Webpack users should migrate from `@fictjs/babel-preset` to the native
`@fictjs/webpack-plugin` loader. Direct compiler integrations import the
serializable `transformSync`, `transform`, `scan`, or `analyze` API from
`@fictjs/compiler`; the lower-level loader remains available from
`@fictjs/compiler/native`. Both facades lazily select and reuse the validated
platform binding. Custom Babel pipelines that still
need sibling plugins should run native Fict compilation as a separate first
stage and compose source maps explicitly.

`@fictjs/babel-preset@0.30.1` remains available only as the final whole-build
rollback release. It is not part of the 0.31 workspace, publish plan, or support
surface. Custom Babel plugins may still run as a separate downstream transform,
but they must not attempt to compile Fict reactivity.

### Legacy compiler API replacements

The 0.31 package root is a request/response API, not a compatibility alias for
the Babel plugin. Replace direct 0.30-and-earlier compiler imports explicitly:

| Removed or relocated API                                                                            | 0.31 replacement                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default export or `createFictPlugin`                                                                | Use `@fictjs/vite-plugin`, `@fictjs/webpack-plugin`, or call `transformSync` / `transform` from `@fictjs/compiler` in a custom host.                                                                                                        |
| `FictCompilerOptions`                                                                               | Use serializable `NativeCompilerOptions` in `CompileRequest.options`. Keep callbacks, filesystem access, and graph state in the Vite, Webpack, or custom host layer.                                                                        |
| `CompilerWarning` and `DiagnosticCode`                                                              | Read `CompileResult.diagnostics` as `FictDiagnostic[]`. Match the documented string `code`; configure severity with `warningLevels` or `warningsAsErrors`.                                                                                  |
| `getCompilerCacheFingerprint()`                                                                     | Use `nativeCompilerInfo().compilerBuildId` before a request, or the `compilerBuildId` returned by transform and scan results.                                                                                                               |
| Root `parseModuleReactiveMetadata` and `resolvePackageModuleMetadata` exports                       | Import them from `@fictjs/compiler/graph-host`. They validate and resolve only the versioned native metadata schema.                                                                                                                        |
| `resolveModuleMetadata`, `setModuleMetadata`, `clearModuleMetadata`, and `invalidateModuleMetadata` | There is no process-global compiler metadata cache. Official integrations own graph resolution and invalidation. A direct host resolves scanned edges into `ResolvedMetadataInput[]` and passes that snapshot as `CompileRequest.metadata`. |
| `emitModuleMetadata`, `moduleMetadataCacheDir`, and `moduleMetadataExtension`                       | Use Vite library mode to emit publishable metadata, then declare it through `package.json#fict.metadata` or `package.json#fict.exports`. Source-adjacent and `.fict-cache` sidecars are retired.                                            |
| `analyzeFictFile` and `inferTraceMarkersForComponent`                                               | Use `analyzeSync` or `analyze` with an `AnalyzeRequest`; component traces, regions, and structured diagnostics are returned in `AnalyzeResult`.                                                                                             |
| `minimizeSourceByLines`                                                                             | There is no native compiler equivalent. Run an external reducer that repeatedly calls `transformSync` / `transform` or `analyzeSync` / `analyze` with the failure predicate you need to preserve.                                           |

The metadata replacement intentionally has no mutating singleton. A custom
host should use `scanSync` or `scan` to discover static edges, resolve those
edges using its own module graph, and fingerprint each `ResolvedMetadataInput`
so its cache invalidation follows the same inputs passed to compilation. Vite
virtual-module integrations may instead provide the Vite plugin's
integration-level `resolveModuleMetadata` hook; that hook is not an export from
the compiler package root.

Preview `resumable: true` is available with the Rust compiler through compiler-owned
structured handler artifacts. It remains explicit and Preview; native support
does not graduate it or make it a Core default.

See the [Rust compiler architecture](architecture/rust-compiler.md) and
[rollback runbook](operations/runbooks/compiler-backend-rollback.md) for the
request boundary and 0.31 recovery procedure.

## Concept Map

| Source concept           | Fict equivalent                                    |
| ------------------------ | -------------------------------------------------- |
| React `useState`         | `let value = $state(initial)`                      |
| React `useMemo`          | Plain derived `const value = expression`           |
| React `useEffect`        | `$effect`, `onMount`, `onCleanup`, or `onDestroy`  |
| React context            | `createContext` / `useContext`                     |
| Vue `ref`                | `$state` for local values                          |
| Vue `reactive`           | `$store` for deep shared objects                   |
| Vue `computed`           | Plain derived `const value = expression`           |
| Vue `watchEffect`        | `$effect`                                          |
| Svelte `$state`          | Fict `$state`                                      |
| Svelte `$derived`        | Plain derived `const value = expression`           |
| Svelte `{#if}`           | Native `if` / ternary in TSX                       |
| Solid `createSignal`     | `$state` in components, `createSignal` in advanced |
| Solid `createMemo`       | Plain derived `const value = expression`           |
| Solid `<Show>` / `<For>` | Native `if` / `map` with stable keys               |

## React

React components re-run; Fict components run once and update bindings,
memos, effects, or tracked branches. Move render-time derivations out of
manual hooks and let the compiler infer them.

```tsx
// React
function Counter() {
  const [count, setCount] = useState(0)
  const doubled = useMemo(() => count * 2, [count])
  return <button onClick={() => setCount(count + 1)}>{doubled}</button>
}

// Fict
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return <button onClick={() => count++}>{doubled}</button>
}
```

### Effects

Use `$effect` for reactive effects. Use `onMount` for one-time setup and
`onCleanup` inside `$effect` when the cleanup must re-run with the effect.

```tsx
// React
useEffect(() => {
  const stop = subscribe(id, value => setValue(value))
  return stop
}, [id])

// Fict
$effect(() => {
  const stop = subscribe(id, value => {
    latest = value
  })
  onCleanup(stop)
})
```

### Props And Rest Spreads

Simple prop destructuring is supported. Rest props and native element spreads
can lose per-prop guarantees, so prefer explicit props or `mergeProps`.

```tsx
// Risky during migration: rest spread can hide dynamic native props.
function Button({ variant, ...rest }) {
  return <button {...rest} class={`btn ${variant}`} />
}

// Prefer explicit props, or mergeProps when forwarding is intentional.
function Button(props) {
  const merged = mergeProps({ type: 'button' }, props)
  return <button type={merged.type} class={`btn ${merged.variant}`} />
}
```

## Vue

Use `$state` for component-local values and `$store` for deep shared objects.
Fict does not use `.value`.

```tsx
// Vue
const count = ref(0)
const doubled = computed(() => count.value * 2)
count.value++

// Fict
let count = $state(0)
const doubled = count * 2
count++
```

For `reactive` objects, use `$store` and mutate properties directly.

```tsx
const user = $store({ profile: { name: 'Ada' } })
user.profile.name = 'Grace'
```

## Svelte

Fict's `$state` is also a compiler macro, but derived values do not require
`$derived`.

```tsx
// Svelte
let count = $state(0)
let doubled = $derived(count * 2)

// Fict
let count = $state(0)
const doubled = count * 2
```

Svelte blocks become normal TSX control flow. Keep list keys stable.

```tsx
return (
  <ul>
    {todos.map(todo => (
      <li key={todo.id}>{todo.title}</li>
    ))}
  </ul>
)
```

## Solid

Most Solid reactive primitives map directly, but Fict removes getter calls in
component code.

```tsx
// Solid
const [count, setCount] = createSignal(0)
const doubled = createMemo(() => count() * 2)
return <button onClick={() => setCount(count() + 1)}>{doubled()}</button>

// Fict
let count = $state(0)
const doubled = count * 2
return <button onClick={() => count++}>{doubled}</button>
```

Use `createSignal` from `fict/advanced` only for library-level or module-level
escape hatches. In application components, prefer `$state` and `$store`.

## Patterns That Need Rewrites

| Pattern                              | Rewrite                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| Mutating nested `$state` objects     | Reassign immutably, or use `$store` for direct deep writes  |
| Dynamic object keys from user input  | Narrow keys, use `$store`, or isolate in an explicit helper |
| Passing state into black-box helpers | Use `untrack` for snapshots or a Fict-aware callback API    |
| Native element rest spreads          | Prefer explicit props or `mergeProps`                       |
| Component definitions inside render  | Move components to module scope or a stable factory         |
| List rendering without keys          | Add stable keys from data, not array indexes                |

## Migration Exit Criteria

- No production build opts out of `strictGuarantee`.
- CI sets `FICT_STRICT_GUARANTEE=1` for build/typecheck gates.
- All `fict-ignore` suppressions are removed from strict guarantee paths.
- Store usage is either `$state` with immutable updates or `$store` with direct
  deep mutation; do not mix both models for the same object.
- Branch fallback behavior is covered by tests where DOM identity matters.
