# Metadata Packaging Architecture

This note defines where Fict reactive metadata should be generated, packaged, and published for third-party hook libraries.

## Decision

Fict metadata should be split across two responsibilities:

1. **The compiler generates metadata.**
2. **Build/publish integrations package and declare metadata.**

The compiler should not become the only place that understands npm package entrypoints, bundler output layouts, or `package.json` publishing rules.

## Why not put everything in the compiler?

The compiler understands source semantics:

- which exports are reactive accessors;
- which `useXxx` hooks return signals or memos;
- whether a return shape is direct, object-based, or array-based;
- how to serialize that information as `ModuleReactiveMetadata`.

But the compiler does not naturally know package publishing concerns:

- whether the public entry is `.`, `./hooks`, `./server`, or another subpath;
- where the final ESM and CJS files are emitted;
- whether the bundler preserves modules or merges source files;
- how `package.json#exports` maps source modules to public entrypoints;
- whether the package publishes `dist` only or includes source files;
- whether `npm pack` includes generated metadata files.

Those are bundler and package-manager responsibilities. Encoding all of them in the compiler would make the compiler less portable and harder to use outside a specific build tool.

## Layered model

### 1. Compiler layer

The compiler owns the metadata format and source analysis.

Responsibilities:

- infer module metadata while compiling source;
- emit per-module metadata when requested;
- expose APIs such as `emitModuleMetadata`, `moduleMetadata`, and `resolveModuleMetadata`;
- keep metadata generation independent of Vite, Rollup, Webpack, tsup, or esbuild;
- fail closed for malformed metadata read from disk or packages.

The compiler should answer: **"What reactive API does this module expose?"**

It should not answer: **"How should this npm package publish every entrypoint?"**

### 2. Library build helper layer

Fict should eventually provide an official library build integration, for example `@fictjs/library`, `@fictjs/build`, or a mode inside `@fictjs/vite-plugin`.

Responsibilities:

- compile the library source with Fict;
- collect generated metadata files or in-memory metadata;
- map metadata to public package entrypoints;
- write `dist/*.fict.meta.json` files;
- update or validate `package.json#fict.metadata` and `package.json#fict.exports`;
- ensure metadata files are included in the published package;
- report clear errors when a public hook export lacks metadata.

This layer should answer: **"How do I publish this library so consumers can recover Fict reactivity?"**

### 3. Bundler adapter layer

Specific bundlers can provide convenience integrations on top of the shared library helper.

Examples:

```ts
// vite.config.ts
import fict from '@fictjs/vite-plugin'

export default {
  plugins: [
    fict({
      library: true,
      metadata: true,
    }),
  ],
}
```

Equivalent adapters can exist for Rollup, Webpack, tsup, esbuild, or unbuild. They should all emit the same package metadata ABI.

## Package ABI

Published packages should declare metadata in `package.json`.

Single-entry package:

```json
{
  "name": "fict-counter-lib",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "fict": {
    "metadata": "./dist/index.fict.meta.json"
  }
}
```

Multi-entry package:

```json
{
  "name": "fict-counter-lib",
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

The metadata file itself uses the compiler-owned `ModuleReactiveMetadata` shape:

```json
{
  "exports": {},
  "hooks": {
    "useCounter": {
      "directAccessor": "signal"
    },
    "useCounterObject": {
      "objectProps": {
        "count": "signal",
        "doubled": "memo"
      }
    }
  }
}
```

## Desired author experience

Library authors should not hand-write metadata JSON for normal cases. The intended future workflow is:

1. author hooks in Fict source;
2. optionally annotate complex APIs with `@fictReturn`;
3. run an official Fict library build command or plugin mode;
4. publish the generated package.

For example:

```bash
fict build-lib
```

or:

```ts
fict({ library: true, metadata: true })
```

The integration should generate the metadata file and package declarations automatically.

## Current status

The compiler can generate and consume module metadata, and consumers can resolve package-level metadata declared through `package.json#fict`.

What is still future work:

- first-class library build command;
- automatic `package.json#fict` writing or validation;
- bundler-specific adapters for Rollup/Webpack/tsup/esbuild beyond the current Vite integration;
- pack-time checks that metadata files are included in the published artifact.

## Summary

Metadata generation belongs in the compiler. Metadata packaging belongs in official library build tooling and bundler adapters.

This keeps the compiler small and portable while still allowing third-party Fict hook libraries to offer near-zero-manual-work publishing in the future.
