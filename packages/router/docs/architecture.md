# @fictjs/router Architecture

This document provides an in-depth look at the internal architecture of `@fictjs/router`.

## 1. Overview

`@fictjs/router` is a reactive router designed for Fict applications with fine-grained reactivity integration. It provides:

- **Multiple history modes** - Browser, Hash, Memory, and Static routers
- **Nested routes** - Hierarchical route structures with layouts
- **Data loading** - Query caching, actions, and preloading
- **Lazy loading** - Code splitting with Suspense integration
- **Scroll restoration** - Automatic scroll position management
- **Route guards** - Navigation control via `beforeLeave` handlers

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Application Layer                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  Router/Routes  │  │   Link/NavLink  │  │   Route Components  │  │
│  │  - Configuration│  │   - Navigation  │  │   - User Components │  │
│  │  - Rendering    │  │   - Active State│  │   - Outlets         │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Core Layer                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  RouterProvider │  │   Context API   │  │   Route Matching    │  │
│  │  - State Mgmt   │  │   - useRouter   │  │   - Path Parsing    │  │
│  │  - Navigation   │  │   - useRoute    │  │   - Score Ranking   │  │
│  │  - Transitions  │  │   - useParams   │  │   - Branch Matching │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Infrastructure Layer                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │     History     │  │   Data Loading  │  │  Scroll Restoration │  │
│  │  - Browser      │  │   - query()     │  │  - Save/Restore     │  │
│  │  - Hash         │  │   - action()    │  │  - Hash Scrolling   │  │
│  │  - Memory       │  │   - preload()   │  │  - Top Scrolling    │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. History Abstraction

The router supports four history modes through a unified `History` interface:

### 3.1 History Interface

```typescript
interface History {
  readonly action: HistoryAction // 'POP' | 'PUSH' | 'REPLACE'
  readonly location: Location
  push(to: To, state?: unknown): void
  replace(to: To, state?: unknown): void
  go(delta: number): void
  back(): void
  forward(): void
  listen(listener: HistoryListener): () => void
  createHref(to: To): string
  block(blocker: Blocker): () => void
}

type Blocker = (transition: {
  action: HistoryAction
  location: Location
  retry: () => void
  proceed?: () => void
}) => void
```

### 3.2 History Implementations

| Mode        | Factory                  | Use Case                            |
| ----------- | ------------------------ | ----------------------------------- |
| **Browser** | `createBrowserHistory()` | Standard web apps using History API |
| **Hash**    | `createHashHistory()`    | Static hosting, no server routing   |
| **Memory**  | `createMemoryHistory()`  | Testing, SSR, React Native          |
| **Static**  | `createStaticHistory()`  | Server-side rendering               |

### 3.3 Location Object

```typescript
interface Location {
  pathname: string // "/users/123"
  search: string // "?page=1"
  hash: string // "#section"
  state: unknown // Navigation state
  key: string // Unique location key
}
```

## 4. Route Matching

### 4.1 Pattern Syntax

| Pattern         | Description        | Example Match                        |
| --------------- | ------------------ | ------------------------------------ |
| `/users`        | Static segment     | `/users`                             |
| `/users/:id`    | Dynamic parameter  | `/users/123` → `{ id: "123" }`       |
| `/files/:path*` | Splat (catch-all)  | `/files/a/b/c` → `{ path: "a/b/c" }` |
| `/posts/:id?`   | Optional parameter | `/posts` or `/posts/1`               |

### 4.2 Route Scoring Algorithm

Routes are scored for specificity ranking (higher = more specific):

```
Static segment:    3 points
Dynamic segment:   2 points
Optional segment:  1 point
Splat segment:     0.5 points
Index route bonus: 0.5 points
```

**Example:**

- `/users/:id/posts` → Score: 3 + 2 + 3 = 8
- `/users/:id` → Score: 3 + 2 = 5
- `/users/*` → Score: 3 + 0.5 = 3.5

### 4.3 Matching Flow

```
URL: "/users/123/posts"
         │
         ▼
    ┌─────────────┐
    │ Parse URL   │
    └─────────────┘
         │
         ▼
    ┌─────────────────┐
    │ Strip Base Path │
    └─────────────────┘
         │
         ▼
    ┌─────────────────────┐
    │ Match Against       │
    │ Compiled Branches   │
    │ (sorted by score)   │
    └─────────────────────┘
         │
         ▼
    ┌─────────────────────┐
    │ Return RouteMatch[] │
    │ (nested matches)    │
    └─────────────────────┘
```

## 5. Reactive State Management

### 5.1 Router Context

The `RouterProvider` creates reactive state using Fict's signal system:

```typescript
interface RouterContextValue {
  location: () => Location // Reactive location
  params: () => Params // Reactive merged params
  matches: () => RouteMatch[] // Reactive matches array
  navigate: NavigateFunction // Navigation function
  isRouting: () => boolean // Routing transition state
  pendingLocation: () => Location | null
  base: string // Base path
  resolvePath: (to: To) => string
}
```

### 5.2 Navigation Flow

```
navigate("/users/123", { replace: false })
         │
         ▼
    ┌────────────────────────┐
    │ 1. Check beforeLeave   │
    │    handlers            │
    └────────────────────────┘
         │ (if allowed)
         ▼
    ┌────────────────────────┐
    │ 2. Set isRouting=true  │
    │    Set pendingLocation │
    └────────────────────────┘
         │
         ▼
    ┌────────────────────────┐
    │ 3. Start Transition    │
    │    (via startTransition)│
    └────────────────────────┘
         │
         ▼
    ┌────────────────────────┐
    │ 4. Match new routes    │
    │    Run preload funcs   │
    └────────────────────────┘
         │
         ▼
    ┌────────────────────────┐
    │ 5. Update history      │
    │    Update location     │
    │    Update matches      │
    └────────────────────────┘
         │
         ▼
    ┌────────────────────────┐
    │ 6. Set isRouting=false │
    │    Clear pending       │
    └────────────────────────┘
```

## 6. Data Loading

### 6.1 Query System

The `query()` function creates cached, reactive queries:

```typescript
const getUser = query(
  async (id: string) => fetch(`/api/users/${id}`).then(r => r.json()),
  'getUser',
)

// Usage: returns reactive accessor
const user = getUser('123') // () => User | undefined
```

**Cache behavior:**

- Queries are cached by key (`name + serialized args`)
- Stale entries expire after 30 seconds
- Maximum 100 entries (LRU eviction)
- `revalidate()` clears matching cache entries

### 6.2 Action System

Actions handle form submissions with optimistic UI support:

```typescript
const createUser = action(async (formData, { params }) => {
  return await fetch('/api/users', { method: 'POST', body: formData })
}, 'createUser')

// Track submissions
const submission = useSubmission(createUser)
// submission()?.state: 'submitting' | 'loading' | 'idle'
```

### 6.3 Route Preloading

Routes can define `preload` functions that run before rendering:

```typescript
const routes = [
  {
    path: '/users/:id',
    component: UserProfile,
    preload: async ({ params, intent }) => {
      // intent: 'initial' | 'navigate' | 'native' | 'preload'
      return await getUser(params.id)
    },
  },
]
```

## 7. Lazy Loading

### 7.1 Component Lazy Loading

```typescript
const LazyProfile = lazy(() => import('./UserProfile'))

// Renders with Suspense integration
<Route path="/users/:id" component={LazyProfile} />
```

### 7.2 Lazy Route Definition

```typescript
const routes = [
  lazyRoute({
    path: '/users/:id',
    component: () => import('./UserProfile'),
    loadingElement: <Spinner />,
    errorElement: <ErrorPage />
  })
]
```

### 7.3 File-System Routing

```typescript
// With Vite's import.meta.glob
const pages = import.meta.glob('./pages/*.tsx')

const routes = createLazyRoutes(pages, {
  pathTransform: path => path.replace('./pages', '').replace('.tsx', ''),
})
```

## 8. Scroll Restoration

### 8.1 Behavior

| Navigation Type    | Scroll Behavior                |
| ------------------ | ------------------------------ |
| PUSH               | Scroll to top (or hash target) |
| REPLACE            | Scroll to top (or hash target) |
| POP (back/forward) | Restore saved position         |

### 8.2 Configuration

```typescript
configureScrollRestoration({
  enabled: true,
  restoreOnPop: true,
  scrollToTopOnPush: true,
  behavior: 'smooth', // or 'auto'
})
```

### 8.3 Position Storage

- Positions stored by location `key`
- Maximum 100 positions (prevents memory leaks)
- Uses `requestAnimationFrame` for DOM synchronization

## 9. Route Guards

### 9.1 BeforeLeave Handler

```typescript
function UnsavedChangesGuard() {
  const hasChanges = () => formIsDirty()

  useBeforeLeave((e) => {
    if (hasChanges() && !e.defaultPrevented) {
      e.preventDefault()
      if (confirm('Discard changes?')) {
        e.retry(true)  // Force navigation
      }
    }
  })

  return <Form>...</Form>
}
```

### 9.2 Handler Flow

```
Navigation triggered
        │
        ▼
   ┌──────────────────┐
   │ Collect handlers │
   │ (from context)   │
   └──────────────────┘
        │
        ▼
   ┌──────────────────┐
   │ Call each handler│
   │ with event args  │
   └──────────────────┘
        │
        ▼
   ┌──────────────────┐     NO
   │ preventDefault   │──────────► Continue navigation
   │ called?          │
   └──────────────────┘
        │ YES
        ▼
   Block navigation
   (until retry called)
```

## 10. SSR Integration

### 10.1 StaticRouter

For server-side rendering, use `StaticRouter` with the request URL:

```typescript
function renderToString(url: string) {
  return render(
    <StaticRouter url={url}>
      <Routes children={routes} />
    </StaticRouter>
  )
}
```

### 10.2 Static History

`createStaticHistory(url)` creates a read-only history:

- All navigation methods are no-ops
- Location is fixed to provided URL
- Used internally by `StaticRouter`

## 11. Link Components

### 11.1 Link Prefetching

```typescript
<Link
  to="/users/123"
  prefetch="intent"  // 'none' | 'intent' | 'render'
>
  View User
</Link>
```

| Mode     | Behavior                   |
| -------- | -------------------------- |
| `none`   | No prefetching             |
| `intent` | Prefetch on hover/focus    |
| `render` | Prefetch when link renders |

### 11.2 NavLink Active State

```typescript
<NavLink
  to="/dashboard"
  activeClassName="active"
  end  // Exact match only
>
  {({ isActive, isPending }) => (
    <span className={isActive ? 'active' : ''}>Dashboard</span>
  )}
</NavLink>
```

## 12. Module Structure

```
src/
├── index.ts           # Public exports
├── types.ts           # Type definitions
├── components.tsx     # Router, Routes, Route, Outlet
├── router-provider.ts # Core router state management
├── router-internals.ts# Base path utilities
├── context.ts         # React-style hooks (useRouter, etc.)
├── history.ts         # History implementations
├── link.tsx           # Link, NavLink, Form components
├── data.ts            # query(), action(), preload utilities
├── lazy.tsx           # Lazy loading utilities
├── scroll.ts          # Scroll restoration
├── utils.ts           # Path matching and utilities
└── accessor-utils.ts  # Internal accessor helpers
```
