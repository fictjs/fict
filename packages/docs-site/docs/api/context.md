---
type: contract
title: Context API
description: Scoped dependency contract for subtree overrides and SSR-safe application state.
owner: NEEDS_OWNER
status: proposed
tags: [api, advanced, context, ssr]
---

# Context API

Context passes a value through a component subtree without forwarding it through every intermediate prop. Each provider creates an owned child root, so nested providers override their ancestors and separate application/SSR roots remain isolated.

Context is an advanced API:

```tsx
import { createContext, hasContext, useContext } from 'fict/advanced'
```

## `createContext`

```ts
function createContext<T>(defaultValue: T): Context<T>
```

```tsx
const ThemeContext = createContext<'light' | 'dark'>('light')
ThemeContext.displayName = 'Theme'
```

The returned object exposes a stable identity, `defaultValue`, optional `displayName`, and a `Provider` component.

## `Context.Provider`

```tsx
function App() {
  return (
    <ThemeContext.Provider value="dark">
      <Dashboard />
    </ThemeContext.Provider>
  )
}
```

The nearest provider wins. Updating the provider's `value` causes its owned subtree to be recreated with the new context value. For frequently changing data, provide a stable signal or store and update that value in place.

```tsx
import { $store, type PropsWithChildren } from 'fict'
import { createContext, useContext } from 'fict/advanced'

interface Session {
  user: { name: string } | null
}

const SessionContext = createContext<Session | null>(null)

function SessionProvider({ children }: PropsWithChildren) {
  const session = $store<Session>({ user: null })
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

function AccountName() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('AccountName requires SessionProvider')
  return <span>{session.user?.name ?? 'Signed out'}</span>
}
```

Create request-specific stores inside a provider or request factory rather than exporting one process-wide store from a server module.

## `useContext`

```ts
function useContext<T>(context: Context<T>): T
```

`useContext` walks the current root's parent chain and returns the nearest provided value. If no provider exists, it returns `defaultValue`.

## `hasContext`

```ts
function hasContext<T>(context: Context<T>): boolean
```

`hasContext` reports whether a provider exists; it does not report whether a default value is available.

```tsx
function OptionalTheme() {
  if (!hasContext(ThemeContext)) return <p>No theme provider</p>
  return <p class={useContext(ThemeContext)}>Themed</p>
}
```

## Verification

- Public advanced exports: `packages/fict/src/advanced.ts`.
- Provider and lookup implementation: `packages/runtime/src/context.ts`.
- Isolation and nesting coverage: `packages/runtime/test/context.test.ts`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
