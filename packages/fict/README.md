# fict

![Node CI](https://github.com/fictjs/fict/workflows/ci/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

> Reactive UI with zero boilerplate.

Fict is a UI library where you write plain JavaScript and the compiler figures out the reactivity.

> Write JavaScript; let the compiler handle signals, derived values, and DOM updates. It’s a new way to think about UI—not a drop-in replacement for React/Vue/Svelte. The promise is less code and lower cognitive load.

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2 // auto-derived, no useMemo needed

  return <button onClick={() => count++}>{doubled}</button>
}
```

**No `useMemo`. No dependency arrays. No `.value`. Just JavaScript.**

## Usage

```bash
npm install fict
# or
yarn add fict
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.
