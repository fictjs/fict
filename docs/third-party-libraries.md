# Third-Party Fict Libraries

Fict can preserve reactivity across package boundaries when a library publishes reactive metadata for its public API. This is required for precompiled packages because consumer builds normally do not re-run the Fict compiler over `node_modules`.

## Why metadata is needed

Inside one source module, the compiler can inspect a hook such as `useCounter()` and infer that its return value contains signals or memos. After a library is bundled to ESM or CJS, the consumer compiler only sees an import:

```tsx
import { useCounter } from 'fict-counter'

function App() {
  const count = useCounter()
  const doubled = count * 2
  return <span>{doubled}</span>
}
```

Without metadata, `count` is just the result of a normal function call, so the consumer compiler cannot safely treat `doubled` as a reactive derived value. With metadata, the compiler knows `useCounter()` returns a signal accessor and can emit the same automatic memo/binding behavior it would for a local hook.

## Package metadata ABI

Publish a JSON metadata file containing the same shape used by the compiler:

```json
{
  "version": 1,
  "exports": {},
  "hooks": {
    "useCounter": {
      "directAccessor": "signal"
    },
    "usePair": {
      "arrayProps": { "0": "signal", "1": "memo" }
    },
    "useStoreView": {
      "objectProps": { "count": "signal", "doubled": "memo" }
    }
  }
}
```

`version: 1` is required. Fict 0.31 rejects unversioned payloads, unsupported
future versions, unknown schema fields, and malformed hook shapes instead of
guessing compatibility.

Then point to it from `package.json`:

```json
{
  "name": "fict-counter",
  "type": "module",
  "exports": "./dist/index.js",
  "fict": {
    "metadata": "./dist/index.fict.meta.json"
  }
}
```

For packages with subpath exports or separate ESM/CJS entrypoints, use `fict.exports`:

```json
{
  "name": "fict-counter",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./hooks": {
      "import": "./dist/hooks.js",
      "require": "./dist/hooks.cjs"
    }
  },
  "fict": {
    "exports": {
      ".": "./dist/index.fict.meta.json",
      "./hooks": "./dist/hooks.fict.meta.json"
    }
  }
}
```

The retired root `fictMetadata` shorthand is not read by Fict 0.31. Publish the
versioned asset under `fict.metadata` or `fict.exports` before upgrading
consumers.

## Authoring hooks

Hook names must start with `use` followed by an uppercase letter. The compiler can infer simple direct/object/array returns from source, but exported library APIs should annotate complex or intentionally stable shapes:

```ts
import { $state, $memo } from 'fict'

/**
 * @fictReturn { count: 'signal', doubled: 'memo' }
 */
export function useCounter() {
  let count = $state(0)
  const doubled = $memo(() => count * 2)
  return { count, doubled }
}
```

The annotation is especially useful when build steps minify, wrap, or re-export hooks.

## Vite library publishing

`@fictjs/vite-plugin` can generate and package metadata automatically for Vite library builds:

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        hooks: 'src/hooks.ts',
      },
      formats: ['es', 'cjs'],
    },
  },
  plugins: [fict({ library: true })],
})
```

When `library: true` is enabled, the plugin compiles TypeScript and JSX source, collects compiler metadata for entry chunks, emits `*.fict.meta.json` files into `dist`, and updates the package `package.json` with `fict.metadata` or `fict.exports`.

The package should already declare its public JavaScript entries through `exports`, `module`, or `main`; the plugin uses those fields to choose the public metadata subpaths. Set `library.packageJson: false` if a separate release script should handle package.json updates.

## ESM and CJS behavior

The metadata ABI is independent of the JavaScript module format. A precompiled ESM package and a precompiled CJS package can point to the same metadata file as long as they expose the same public hook names and return shapes.

Runtime behavior of the hook is provided by the compiled library code. Consumer-side automatic derived values and JSX bindings are provided by the metadata consumed during the app compile.

## Consumer behavior

`@fictjs/vite-plugin` excludes `node_modules` from transformation by default, but it resolves `fict.metadata` / `fict.exports` for bare package imports. Applications usually do not need to include the package in the transform list.

If a package uses a non-standard metadata location or virtual module system,
the integration must still provide authoritative versioned metadata. Vite
integrations can provide the Vite plugin's integration-level
`resolveModuleMetadata(source, importer)` hook. A direct compiler host instead
resolves `scan` results into `ResolvedMetadataInput[]` and passes that snapshot
as `CompileRequest.metadata`; the 0.31 compiler package root has no global
metadata resolver or cache.
