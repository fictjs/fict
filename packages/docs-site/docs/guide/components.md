---
type: feature-spec
title: Components
description: Define Fict components, reactive props, events, lists, refs, and root rendering.
owner: NEEDS_OWNER
status: proposed
tags: [guide, components, tsx]
---

# Components

A Fict component is a function that returns a Fict node. Use PascalCase names and define components at module scope so their identity and ownership remain stable.

```tsx
interface GreetingProps {
  name: string
  excited?: boolean
}

function Greeting({ name, excited = false }: GreetingProps) {
  const punctuation = excited ? '!' : '.'
  return (
    <p>
      Hello, {name}
      {punctuation}
    </p>
  )
}
```

## Props stay reactive

Destructuring props does not create a snapshot. The compiler lowers each reactive field to a getter and keeps derived expressions current.

```tsx
function Price({ amount, currency }) {
  const formatted = `${currency} ${amount.toFixed(2)}`
  return <output>{formatted}</output>
}
```

Default expressions are lazy and stay reactive too. If an optional prop is `undefined`, the default is recomputed from the current values of any props it reads:

```tsx
function Total({ price, quantity = price > 100 ? 2 : 1 }) {
  return <output>{price * quantity}</output>
}
```

Avoid copying props into `$state` unless the component intentionally owns an editable local value.

## Children and fragments

Components can accept `children`, and fragments group siblings without adding an element:

```tsx
import type { FictNode, PropsWithChildren } from 'fict'

function Card({ children }: PropsWithChildren): FictNode {
  return <section class="card">{children}</section>
}

function Actions() {
  return (
    <>
      <button>Save</button>
      <button>Cancel</button>
    </>
  )
}
```

## Events

Use DOM-style event props such as `onClick` and `onInput`. Handlers created in a component stay stable while compiler-transformed state reads remain current.

```tsx
function NameField() {
  let name = $state('')

  return <input value={name} onInput={event => (name = event.currentTarget.value)} />
}
```

Fict uses the HTML `class` attribute rather than React's `className` convention.

## Lists and keys

Use native `map` and give stable keys to elements or components whose identity must survive insertion, removal, or reordering.

```tsx
<ul>
  {todos.map(todo => (
    <li key={todo.id}>{todo.title}</li>
  ))}
</ul>
```

Do not use an array index as a key when item order can change.

## Refs and lifecycle

`createRef` exposes the mounted element through `.current`. Read it in `onMount`, after the DOM commit:

```tsx
import { createRef, onMount } from 'fict'

function SearchBox() {
  const input = createRef<HTMLInputElement>()

  onMount(() => input.current?.focus())
  return <input ref={input} type="search" />
}
```

## Rendering and unmounting

```tsx
import { render } from 'fict'

const unmount = render(() => <App />, document.getElementById('app')!)
// Later: unmount()
```

Unmounting disposes the component root, subscriptions, effects, and lifecycle cleanup.

## Verification

- JSX and DOM contract: `packages/runtime/src/jsx.ts`, `packages/runtime/src/dom.ts`, and `packages/runtime/src/types.ts`.
- Prop lowering: `packages/runtime/src/props.ts` and `docs/reactivity-semantics.md`.
- Compiler coverage: `packages/compiler/test/template-integration.test.ts`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
