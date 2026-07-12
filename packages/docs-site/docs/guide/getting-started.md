---
type: feature-spec
title: Getting started
description: Install Fict with Vite and build a compiler-backed counter.
owner: NEEDS_OWNER
status: proposed
tags: [guide, vite, setup]
---

# Getting Started

This guide adds Fict to a minimal Vite TypeScript project. Fict macros require a compiler integration, so installing `fict` without the Vite plugin is not sufficient.

## Install

```bash
npm install fict
npm install --save-dev vite typescript @fictjs/vite-plugin
```

The same packages can be installed with pnpm, Yarn, or Bun.

## Configure Vite

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict()],
})
```

Production builds enable Fict's strict reactivity guarantees. The default development configuration is strict as well, so unsupported reactive boundaries fail with an actionable diagnostic instead of producing stale UI.

## Configure TypeScript

Set Fict as the JSX runtime in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "fict",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["vite/client"]
  }
}
```

## Add the application

Create an HTML entry:

```html
<div id="app"></div>
<script type="module" src="/src/main.tsx"></script>
```

Then create `src/main.tsx`:

```tsx
import { $state, render } from 'fict'

function Counter() {
  let count = $state(0)
  const doubled = count * 2

  return (
    <main>
      <h1>Fict counter</h1>
      <button onClick={() => count--}>−</button>
      <output>{count}</output>
      <button onClick={() => count++}>+</button>
      <p>Doubled: {doubled}</p>
    </main>
  )
}

const app = document.getElementById('app')
if (!app) throw new Error('Missing #app container')

const unmount = render(() => <Counter />, app)

if (import.meta.hot) {
  import.meta.hot.dispose(unmount)
}
```

`render` replaces the container contents and returns an unmount function. Unmounting disposes component effects and lifecycle callbacks before clearing the container.

## Run and build

```bash
npx vite
npx vite build
```

Clicking the buttons updates only the bindings that read `count` or `doubled`; the component function is not re-run as a whole.

## Common setup failures

- **“macro reached runtime” diagnostic:** the file did not pass through `@fictjs/vite-plugin`; confirm the plugin is in `vite.config.ts` and the file is not excluded.
- **Missing JSX types:** confirm `jsxImportSource` is `fict` and the file extension is `.tsx` or `.jsx`.
- **Module-level `$state` diagnostic:** move `$state` into a component or a top-level `useX` helper, or use `$store`/`createSignal` for shared module state.

Next, read [component state](/guide/state) and [automatic derived values](/guide/derived).

## Verification

- Source of truth: `packages/vite-plugin/src/index.ts`, `packages/fict/src/index.ts`, and `packages/runtime/src/dom.ts`.
- Reference application: `examples/counter-basic`.
- Repository check: `pnpm --filter @fictjs/vite-plugin test && pnpm --filter fict-docs-site build`.
