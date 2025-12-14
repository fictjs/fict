# Quick Start

Get started with Fict in 5 minutes.

## Installation

```bash
pnpm add fict fict-runtime fict-vite-plugin
# or
npm install fict fict-runtime fict-vite-plugin
# or
yarn add fict fict-runtime fict-vite-plugin
```

## Setup

### 1. Configure Vite

Create or update your `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import fict from 'fict-vite-plugin'

export default defineConfig({
  plugins: [fict()],
})
```

### 2. Configure TypeScript

Update your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "fict",
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

## Your First Component

Create a simple counter component:

```tsx
// src/Counter.tsx
import { $state, $effect } from 'fict'

export function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    document.title = `Count: ${count}`
  })

  return (
    <div>
      <h1>Counter</h1>
      <p>Count: {count}</p>
      <p>Doubled: {doubled}</p>
      <button onClick={() => count++}>Increment</button>
      <button onClick={() => count--}>Decrement</button>
    </div>
  )
}
```

## Rendering

Render your component to the DOM:

```tsx
// src/main.tsx
import { render } from 'fict'
import { Counter } from './Counter'

render(() => <Counter />, document.getElementById('app')!)
```

## HTML Entry Point

Create `index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fict App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

## Run Development Server

```bash
pnpm dev
```

Open your browser at `http://localhost:5173` and you should see your counter!

## What's Next?

- Learn about [State Management](./state.md)
- Understand [Effects](./effects.md)
- Explore [Control Flow](./control-flow.md)
- Read the [API Reference](../api/index.md)
