# Context API

Context provides a way to pass data through the component tree without having to pass props down manually at every level.

## Overview

Context is designed for:

- **SSR isolation**: Different requests get different context values
- **Multi-instance support**: Multiple app roots can have different values
- **Subtree scoping**: Override values in specific parts of the tree

## API Reference

### `createContext<T>(defaultValue: T): Context<T>`

Creates a new context with the given default value.

```tsx
import { createContext } from 'fict'

const ThemeContext = createContext<'light' | 'dark'>('light')
```

**Parameters:**

- `defaultValue`: The value to use when no Provider is found in the tree

**Returns:** A context object with a `Provider` component

### `useContext<T>(context: Context<T>): T`

Reads the current value of a context.

```tsx
import { useContext } from 'fict'

function ThemedButton() {
  const theme = useContext(ThemeContext)
  return <button class={theme === 'dark' ? 'btn-dark' : 'btn-light'}>Click</button>
}
```

**Parameters:**

- `context`: The context object created by `createContext`

**Returns:** The current context value (from nearest Provider or default value)

### `hasContext<T>(context: Context<T>): boolean`

Checks if a context value is currently provided in the tree.

```tsx
import { hasContext } from 'fict'

function OptionalTheme() {
  if (hasContext(ThemeContext)) {
    const theme = useContext(ThemeContext)
    return <div class={theme}>Themed content</div>
  }
  return <div>Default content</div>
}
```

### `Context.Provider`

The Provider component supplies a context value to its children.

```tsx
<ThemeContext.Provider value="dark">
  <App />
</ThemeContext.Provider>
```

**Props:**

- `value: T` - The value to provide to the subtree
- `children` - Child components that can consume this context

## Usage Examples

### Basic Usage

```tsx
import { createContext, useContext, render } from 'fict'

// 1. Create a context with a default value
const ThemeContext = createContext<'light' | 'dark'>('light')

// 2. Create a component that consumes the context
function ThemedCard() {
  const theme = useContext(ThemeContext)
  return (
    <div class={`card ${theme}`}>
      <h2>Themed Card</h2>
      <p>Current theme: {theme}</p>
    </div>
  )
}

// 3. Wrap your app with the Provider
function App() {
  return (
    <ThemeContext.Provider value="dark">
      <ThemedCard />
    </ThemeContext.Provider>
  )
}

render(() => <App />, document.getElementById('app')!)
```

### Nested Providers

You can nest Providers to override values for specific subtrees:

```tsx
const ThemeContext = createContext('light')

function App() {
  return (
    <ThemeContext.Provider value="light">
      <Header /> {/* Uses 'light' */}
      <ThemeContext.Provider value="dark">
        <Sidebar /> {/* Uses 'dark' */}
      </ThemeContext.Provider>
      <Footer /> {/* Uses 'light' */}
    </ThemeContext.Provider>
  )
}
```

### Multiple Contexts

You can use multiple contexts in the same component tree:

```tsx
const ThemeContext = createContext('light')
const LanguageContext = createContext('en')
const UserContext = createContext({ name: 'Guest' })

function App() {
  return (
    <ThemeContext.Provider value="dark">
      <LanguageContext.Provider value="zh">
        <UserContext.Provider value={{ name: 'Alice' }}>
          <Dashboard />
        </UserContext.Provider>
      </LanguageContext.Provider>
    </ThemeContext.Provider>
  )
}

function Dashboard() {
  const theme = useContext(ThemeContext)
  const lang = useContext(LanguageContext)
  const user = useContext(UserContext)

  return (
    <div class={theme}>
      <p>Hello, {user.name}!</p>
      <p>Language: {lang}</p>
    </div>
  )
}
```

### Reactive Context Values

In Fict's fine-grained model, component functions execute only once, so Provider's value is captured at mount time. For reactive context values, pass a signal or store as the value:

```tsx
import { createContext, useContext, createSignal } from 'fict/advanced'

// Create context that holds a signal
const CounterContext = createContext({
  count: () => 0,
  increment: () => {},
})

function CounterProvider(props) {
  const count = createSignal(0)

  const value = {
    count, // Pass the signal directly
    increment: () => count(count() + 1),
  }

  return <CounterContext.Provider value={value}>{props.children}</CounterContext.Provider>
}

function Counter() {
  const { count, increment } = useContext(CounterContext)

  return (
    <div>
      {/* count is a signal, so we call it to get the value */}
      <p>Count: {count()}</p>
      <button onClick={increment}>+1</button>
    </div>
  )
}

function App() {
  return (
    <CounterProvider>
      <Counter />
    </CounterProvider>
  )
}
```

## Best Practices

### 1. Keep Context Values Simple

Context works best with simple, infrequently changing values:

```tsx
// Good - simple value
const ThemeContext = createContext('light')

// Good - object with signals for reactivity
const AuthContext = createContext({
  user: createSignal(null),
  login: () => {},
  logout: () => {},
})
```

### 2. Create Custom Hooks

Wrap `useContext` in a custom hook for better ergonomics:

```tsx
const ThemeContext = createContext<'light' | 'dark'>('light')

export function useTheme() {
  return useContext(ThemeContext)
}

// Usage
function Button() {
  const theme = useTheme()
  return <button class={theme}>Click</button>
}
```

### 3. Use `hasContext` for Optional Providers

When a Provider might not exist, use `hasContext` to check:

```tsx
function ThemeAwareComponent() {
  if (hasContext(ThemeContext)) {
    const theme = useContext(ThemeContext)
    return <div class={theme}>Themed</div>
  }
  return <div>Default styling</div>
}
```

## How It Works

Context in Fict leverages the existing `RootContext` hierarchy:

1. **Provider** creates a child `RootContext` for its subtree
2. **Context value** is stored on that root
3. **useContext** walks up the parent chain to find the nearest value
4. This aligns perfectly with Fict's `insert`, `Suspense`, and other boundaries

This design means:

- Zero extra root creation overhead for lookups
- Automatic alignment with component boundaries
- Proper cleanup when components unmount

## TypeScript

Context is fully typed:

```tsx
interface User {
  id: string
  name: string
  email: string
}

const UserContext = createContext<User | null>(null)

function Profile() {
  const user = useContext(UserContext) // Type: User | null

  if (!user) {
    return <p>Not logged in</p>
  }

  return <p>Welcome, {user.name}</p> // user is narrowed to User
}
```
