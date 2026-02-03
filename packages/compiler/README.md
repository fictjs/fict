# @fictjs/compiler

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Babel plugin for Fict Compiler

## Usage

```bash
npm install -D @fictjs/compiler
# or
yarn add -D @fictjs/compiler
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

## Options

```ts
createFictPlugin({
  dev: true,
  onWarn(warning) {
    console.warn(warning)
  },
  // Keep single-use derived values as memos (strict memo mode)
  // inlineDerivedMemos: false,
  // Allow $state/$effect inside reactive-scope callbacks (e.g., renderHook(() => ...))
  reactiveScopes: ['renderHook'],
})
```

- `dev` (default: `NODE_ENV !== 'production' && NODE_ENV !== 'test'`): enables compiler warnings/diagnostics. Set to `false` to silence warnings.
- `onWarn`: custom warning handler (only called when `dev` is enabled).
- `inlineDerivedMemos` (default: `true`): allow the compiler to inline single-use derived values. Set to `false` for a “strict memo” mode where user-named derived values keep explicit memo accessors (unless `"use no memo"` disables memoization).
- `reactiveScopes`: function names whose **first callback argument** is treated as a component-like reactive scope.
  - Only **direct calls** are recognized (e.g., `renderHook(() => ...)` or `utils.renderHook(() => ...)`).
  - **Aliases/indirect calls** are not recognized (e.g., `const rh = renderHook; rh(() => ...)`).
