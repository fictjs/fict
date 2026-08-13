# @fictjs/router API Reference

Complete API reference for `@fictjs/router`.

## Installation

```bash
npm install @fictjs/router
# or
pnpm add @fictjs/router
```

---

## Router Components

### `Router`

Browser router using the History API. Standard choice for most web applications.

```tsx
import { Router, Route } from '@fictjs/router'

function App() {
  return (
    <Router base="/app">
      <Route path="/" component={Home} />
      <Route path="/users/:id" component={UserProfile} />
    </Router>
  )
}
```

**Props:**

| Prop       | Type       | Default | Description                     |
| ---------- | ---------- | ------- | ------------------------------- |
| `base`     | `string`   | `""`    | Base path prefix for all routes |
| `children` | `FictNode` | -       | Route definitions               |

---

### `HashRouter`

Uses URL hash for routing. Useful for static hosting without server-side routing.

```tsx
import { HashRouter, Route } from '@fictjs/router'
;<HashRouter hashType="slash">
  <Route path="/" component={Home} />
</HashRouter>
```

**Props:**

| Prop       | Type                   | Default   | Description                        |
| ---------- | ---------------------- | --------- | ---------------------------------- |
| `hashType` | `'slash' \| 'noslash'` | `'slash'` | Hash format: `/#/path` or `/#path` |
| `base`     | `string`               | `""`      | Base path prefix                   |
| `children` | `FictNode`             | -         | Route definitions                  |

---

### `MemoryRouter`

Keeps history in memory. Useful for testing and non-browser environments.

```tsx
import { MemoryRouter, Route } from '@fictjs/router'
;<MemoryRouter initialEntries={['/users', '/profile']} initialIndex={0}>
  <Route path="/users" component={Users} />
  <Route path="/profile" component={Profile} />
</MemoryRouter>
```

**Props:**

| Prop             | Type       | Default    | Description                |
| ---------------- | ---------- | ---------- | -------------------------- |
| `initialEntries` | `string[]` | `['/']`    | Initial history stack      |
| `initialIndex`   | `number`   | Last entry | Starting position in stack |
| `base`           | `string`   | `""`       | Base path prefix           |
| `children`       | `FictNode` | -          | Route definitions          |

---

### `StaticRouter`

For server-side rendering. Creates a fixed, non-navigable router.

```tsx
import { StaticRouter, Route } from '@fictjs/router'

function renderToString(url: string) {
  return render(
    <StaticRouter url={url}>
      <Route path="/" component={Home} />
    </StaticRouter>,
  )
}
```

**Props:**

| Prop       | Type       | Default  | Description           |
| ---------- | ---------- | -------- | --------------------- |
| `url`      | `string`   | Required | Request URL to render |
| `base`     | `string`   | `""`     | Base path prefix      |
| `children` | `FictNode` | -        | Route definitions     |

---

### `Routes`

Container for route definitions. Renders the matched route.

```tsx
import { Router, Routes, Route } from '@fictjs/router'
;<Router>
  <Routes>
    <Route path="/" component={Home} />
    <Route path="/about" component={About} />
  </Routes>
</Router>
```

---

### `Route`

Defines a route configuration.

```tsx
<Route
  path="/users/:id"
  component={UserProfile}
  preload={({ params }) => fetchUser(params.id)}
  errorElement={<ErrorPage />}
  loadingElement={<Spinner />}
/>
```

**Props:**

| Prop             | Type              | Description                                  |
| ---------------- | ----------------- | -------------------------------------------- |
| `path`           | `string`          | URL pattern (e.g., `/users/:id`, `/files/*`) |
| `component`      | `Component`       | Component to render                          |
| `element`        | `FictNode`        | Alternative to component                     |
| `preload`        | `PreloadFunction` | Data loading function                        |
| `children`       | `FictNode`        | Nested routes                                |
| `index`          | `boolean`         | Index route flag                             |
| `key`            | `string`          | Route cache key                              |
| `errorElement`   | `FictNode`        | Error boundary fallback                      |
| `loadingElement` | `FictNode`        | Loading state fallback                       |
| `matchFilters`   | `MatchFilters`    | Parameter validation                         |

---

### `Outlet`

Renders child routes in nested layouts.

```tsx
function Layout() {
  return (
    <div>
      <Header />
      <main>
        <Outlet /> {/* Child route renders here */}
      </main>
      <Footer />
    </div>
  )
}

;<Route path="/dashboard" component={Layout}>
  <Route path="overview" component={Overview} />
  <Route path="settings" component={Settings} />
</Route>
```

---

### `Navigate`

Declarative navigation. Navigates immediately when rendered.

```tsx
import { Navigate } from '@fictjs/router'

function ProtectedRoute() {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />
  }
  return <Dashboard />
}
```

**Props:**

| Prop      | Type      | Default  | Description                   |
| --------- | --------- | -------- | ----------------------------- |
| `to`      | `To`      | Required | Target location               |
| `replace` | `boolean` | `false`  | Replace current history entry |
| `state`   | `unknown` | -        | Navigation state              |

---

### `Redirect`

Declarative redirect. Always replaces history by default.

```tsx
import { Redirect } from '@fictjs/router'

// Redirect only when the current path matches
<Redirect from="/old-page" to="/new-page" />

// Or place it inside an already matched route
<Route path="/legacy/:id" element={<Redirect to="/new-page" />} />

// Push instead of replace
<Redirect to="/new-page" push />
```

**Props:**

| Prop    | Type      | Default  | Description                            |
| ------- | --------- | -------- | -------------------------------------- |
| `to`    | `To`      | Required | Target location                        |
| `from`  | `string`  | -        | Source pattern (for route definitions) |
| `push`  | `boolean` | `false`  | Use push instead of replace            |
| `state` | `unknown` | -        | Navigation state                       |

---

## Navigation Components

### `Link`

Declarative navigation link.

```tsx
import { Link } from '@fictjs/router'

<Link to="/users/123">View User</Link>

<Link
  to={{ pathname: '/search', search: '?q=test' }}
  replace
  prefetch="intent"
>
  Search
</Link>
```

**Props:**

| Prop             | Type                             | Default   | Description                    |
| ---------------- | -------------------------------- | --------- | ------------------------------ |
| `to`             | `To`                             | Required  | Target location                |
| `replace`        | `boolean`                        | `false`   | Replace history entry          |
| `state`          | `unknown`                        | -         | Navigation state               |
| `scroll`         | `boolean`                        | `true`    | Scroll to top after navigation |
| `relative`       | `'route' \| 'path'`              | `'route'` | Path resolution mode           |
| `prefetch`       | `'none' \| 'intent' \| 'render'` | `'none'`  | Prefetch strategy              |
| `reloadDocument` | `boolean`                        | `false`   | Full page reload               |
| `disabled`       | `boolean`                        | `false`   | Disable the link               |
| `onClick`        | `(event) => void`                | -         | Click handler                  |

---

### `NavLink`

Link with active state awareness.

```tsx
import { NavLink } from '@fictjs/router'

<NavLink
  to="/dashboard"
  activeClassName="active"
  pendingClassName="loading"
>
  Dashboard
</NavLink>

// Render prop for full control
<NavLink to="/dashboard">
  {({ isActive, isPending }) => (
    <span className={isActive ? 'active' : ''}>
      {isPending ? 'Loading...' : 'Dashboard'}
    </span>
  )}
</NavLink>
```

**Props:**

Inherits all `Link` props plus:

| Prop               | Type                                        | Description                        |
| ------------------ | ------------------------------------------- | ---------------------------------- |
| `activeClassName`  | `string`                                    | Class when route is active         |
| `pendingClassName` | `string`                                    | Class when navigation is pending   |
| `activeStyle`      | `CSSProperties`                             | Style when active                  |
| `pendingStyle`     | `CSSProperties`                             | Style when pending                 |
| `end`              | `boolean`                                   | Exact match only (no child routes) |
| `caseSensitive`    | `boolean`                                   | Case-sensitive matching            |
| `className`        | `string \| (props) => string`               | Dynamic className                  |
| `style`            | `CSSProperties \| (props) => CSSProperties` | Dynamic style                      |
| `children`         | `FictNode \| (props) => FictNode`           | Render function                    |
| `aria-current`     | `string`                                    | ARIA current value when active     |

**NavLinkRenderProps:**

```typescript
interface NavLinkRenderProps {
  isActive: boolean // Route matches current location
  isPending: boolean // Navigation to this route in progress
  isTransitioning: boolean
}
```

---

### `Form`

Form component for action submissions.

```tsx
import { Form } from '@fictjs/router'
;<Form action="/api/users" method="post">
  <input name="email" type="email" />
  <button type="submit">Submit</button>
</Form>
```

**Props:**

| Prop                 | Type                                              | Default   | Description                |
| -------------------- | ------------------------------------------------- | --------- | -------------------------- |
| `action`             | `string \| Action<unknown>`                       | -         | Form action URL or action  |
| `method`             | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` | varies    | HTTP method                |
| `replace`            | `boolean`                                         | `false`   | Replace history on GET     |
| `relative`           | `'route' \| 'path'`                               | `'route'` | Action URL resolution      |
| `navigate`           | `boolean`                                         | `true`    | GET navigation / redirects |
| `preventScrollReset` | `boolean`                                         | `false`   | Keep scroll position       |
| `fetcherKey`         | `string`                                          | -         | Stable submission key      |
| `onSubmit`           | `(event) => void`                                 | -         | Submit handler             |

Registered actions default to `post`; ordinary URL forms default to `get`. Non-GET submissions and
GET forms with `navigate={false}` are observable through `useSubmission(actionOrUrl)`. A
`fetcherKey` replaces an older in-flight submission with the same key, so stale completions cannot
redirect or emit form result events. For GET forms, `fetcherKey` is used only when
`navigate={false}`; otherwise the form performs its normal client-side navigation. External GET
forms remain native by default; with `navigate={false}`, they use `fetch` and are subject to the
browser's normal CORS rules.

---

## Routing Hooks

### `useRouter`

Access the router context.

```tsx
import { useRouter } from '@fictjs/router'

function Component() {
  const router = useRouter()

  return (
    <div>
      <p>Current path: {router.location().pathname}</p>
      <p>Is routing: {router.isRouting() ? 'Yes' : 'No'}</p>
      <button onClick={() => router.navigate('/home')}>Go Home</button>
    </div>
  )
}
```

**Returns: `RouterContextValue`**

| Property          | Type                     | Description                       |
| ----------------- | ------------------------ | --------------------------------- |
| `location`        | `() => Location`         | Current location (reactive)       |
| `params`          | `() => Params`           | Merged route params (reactive)    |
| `matches`         | `() => RouteMatch[]`     | Current route matches (reactive)  |
| `navigate`        | `NavigateFunction`       | Navigation function               |
| `isRouting`       | `() => boolean`          | Navigation in progress (reactive) |
| `pendingLocation` | `() => Location \| null` | Target of pending navigation      |
| `base`            | `string`                 | Router base path                  |
| `resolvePath`     | `(to: To) => string`     | Resolve path relative to current  |

---

### `useRoute`

Access the current route context.

```tsx
import { useRoute } from '@fictjs/router'

function UserProfile() {
  const route = useRoute()
  const match = route.match()
  const data = route.data()

  return (
    <div>
      <h1>User: {match?.params.id}</h1>
      <p>Data: {JSON.stringify(data)}</p>
      {route.outlet()} {/* Render child routes */}
    </div>
  )
}
```

**Returns: `RouteContextValue`**

| Property      | Type                            | Description                    |
| ------------- | ------------------------------- | ------------------------------ |
| `match`       | `() => RouteMatch \| undefined` | Current route match            |
| `data`        | `() => unknown`                 | Preloaded data                 |
| `error`       | `() => unknown`                 | Route error (if any)           |
| `outlet`      | `() => FictNode`                | Child route renderer           |
| `resolvePath` | `(to: To) => string`            | Resolve path relative to route |

---

### `useNavigate`

Get the navigation function.

```tsx
import { useNavigate } from '@fictjs/router'

function Component() {
  const navigate = useNavigate()

  const goToUser = (id: string) => {
    navigate(`/users/${id}`, { replace: true })
  }

  const goBack = () => navigate(-1)

  return <button onClick={() => goToUser('123')}>View User</button>
}
```

**Returns: `NavigateFunction`**

```typescript
navigate(to: To, options?: NavigateOptions): void
navigate(delta: number): void  // History navigation
```

---

### `useLocation`

Get the current location (reactive).

```tsx
import { useLocation } from '@fictjs/router'

function LocationDisplay() {
  const location = useLocation()

  return (
    <code>
      {location().pathname}
      {location().search}
      {location().hash}
    </code>
  )
}
```

---

### `useParams`

Get route parameters (reactive).

```tsx
import { useParams } from '@fictjs/router'

// Route: /users/:userId/posts/:postId
function PostView() {
  const params = useParams()

  return (
    <div>
      User: {params().userId}
      Post: {params().postId}
    </div>
  )
}
```

---

### `useSearchParams`

Get and set URL search parameters.

```tsx
import { useSearchParams } from '@fictjs/router'

function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const query = searchParams().get('q') || ''

  const updateSearch = (q: string) => {
    setSearchParams({ q })
  }

  return <input value={query} onInput={e => updateSearch(e.target.value)} />
}
```

**Returns: `[() => URLSearchParams, (params) => void]`**

---

### `useMatches`

Get all current route matches (reactive).

```tsx
import { useMatches } from '@fictjs/router'

function Breadcrumbs() {
  const matches = useMatches()

  return (
    <nav>
      {matches().map((match, i) => (
        <span key={i}>{match.pathname}</span>
      ))}
    </nav>
  )
}
```

---

### `useIsRouting`

Check if navigation is in progress.

```tsx
import { useIsRouting } from '@fictjs/router'

function LoadingIndicator() {
  const isRouting = useIsRouting()

  return isRouting() ? <Spinner /> : null
}
```

---

### `usePendingLocation`

Get the pending navigation target.

```tsx
import { usePendingLocation } from '@fictjs/router'

function PendingInfo() {
  const pending = usePendingLocation()

  if (!pending()) return null
  return <p>Navigating to: {pending()?.pathname}</p>
}
```

---

### `useRouteData`

Get preloaded data for the current route.

```tsx
import { useRouteData } from '@fictjs/router'

function UserProfile() {
  const data = useRouteData<User>()

  return <h1>{data()?.name}</h1>
}
```

---

### `useRouteError`

Get error from route (for error boundaries).

```tsx
import { useRouteError } from '@fictjs/router'

function ErrorPage() {
  const error = useRouteError()

  return (
    <div>
      <h1>Error</h1>
      <pre>{String(error())}</pre>
    </div>
  )
}
```

---

### `useResolvedPath`

Resolve a path relative to current route.

```tsx
import { useResolvedPath } from '@fictjs/router'

function RelativeLink() {
  const resolved = useResolvedPath('./edit')

  return <a href={resolved()}>Edit</a>
}
```

---

### `useMatch`

Check if a path matches the current location.

```tsx
import { useMatch } from '@fictjs/router'

function NavItem({ to }: { to: string }) {
  const match = useMatch(to)

  return (
    <a href={to} className={match() ? 'active' : ''}>
      {to}
    </a>
  )
}
```

---

### `useHref`

Get the full href for a path.

Relative targets resolve against the current route by default. Pass
`{ relative: 'path' }` to resolve against the current location instead. Outside
of a route context, both modes fall back to the current location.

```tsx
import { useHref } from '@fictjs/router'

function ExternalLink({ to }: { to: string }) {
  const href = useHref(to)

  return <a href={href()}>{to}</a>
}
```

---

### `useIsActive`

Check if a path is active.

```tsx
import { useIsActive } from '@fictjs/router'

function Tab({ to }: { to: string }) {
  const isActive = useIsActive(to, { end: true })

  return <button className={isActive() ? 'active' : ''}>{to}</button>
}
```

---

### `useBeforeLeave`

Register a navigation guard.

```tsx
import { useBeforeLeave } from '@fictjs/router'

function UnsavedChanges() {
  const isDirty = () => formHasChanges()

  useBeforeLeave(e => {
    if (isDirty() && !e.defaultPrevented) {
      e.preventDefault()
      if (confirm('Discard changes?')) {
        e.retry(true) // Force navigation
      }
    }
  })

  return <Form>...</Form>
}
```

**Handler Arguments:**

```typescript
interface BeforeLeaveEventArgs {
  to: Location // Target location
  from: Location // Current location
  defaultPrevented: boolean // Initially false
  preventDefault(): void // Block navigation
  retry(force?: boolean): void // Release the block; force=true bypasses later handlers
}
```

Handlers run in registration order. A no-op handler allows navigation. If a
handler leaves the event prevented, navigation stops. `retry()` releases that
prevention and continues with later handlers, which can still prevent the
navigation; `retry(true)` approves immediately and skips the remaining handlers.

---

## Data Loading

### `query`

Create a cached query function.

```tsx
import { query } from '@fictjs/router'

const getUser = query(
  async (id: string) => {
    const res = await fetch(`/api/users/${id}`)
    return res.json()
  },
  'getUser', // Cache key prefix
)

// Usage
function UserProfile({ id }: { id: string }) {
  const user = getUser(id) // Returns reactive accessor

  if (user.loading()) return <p>Loading...</p>
  if (user.status() === 'error') return <p>Could not load the user.</p>
  return <h1>{user()?.name}</h1>
}
```

**Parameters:**

| Param  | Type                     | Description               |
| ------ | ------------------------ | ------------------------- |
| `fn`   | `QueryFunction<T, Args>` | Async function to execute |
| `name` | `string`                 | Cache key prefix          |

**Returns:** `Query<T, Args>`. Each invocation returns a `QueryAccessor<T>`:

```typescript
interface QueryAccessor<T> {
  (): T | undefined
  loading(): boolean
  error(): unknown
  status(): 'pending' | 'success' | 'error'
  latest(): T | undefined
}
```

Calling the main accessor after a rejected request throws the rejection reason,
so reads rendered beneath an `ErrorBoundary` enter its fallback. Check
`error()` first to render failures inline. `status()` distinguishes a successful
`undefined` result from pending and failed requests; `latest()` retains stale
successful data while an expired query refreshes.

---

### `revalidate`

Invalidate cached queries.

```tsx
import { revalidate } from '@fictjs/router'

// Invalidate all queries for 'getUser'
revalidate('getUser')

// Invalidate multiple
revalidate(['getUser', 'getUsers'])

// Invalidate by pattern
revalidate(/^get/)

// Invalidate all
revalidate()
```

---

### `action`

Create a form action.

```tsx
import { action } from '@fictjs/router'

const createUser = action(
  async (formData, { params, request }) => {
    const res = await fetch('/api/users', {
      method: 'POST',
      body: formData
    })
    return res.json()
  },
  'createUser'
)

// Usage with Form
<Form action={createUser.url}>
  <input name="name" />
  <button>Create</button>
</Form>

// Programmatic submission
createUser.submit(new FormData(form))
```

**Returns: `Action<T>`**

```typescript
interface Action<T> {
  url: string // Action URL
  submit: (formData) => Promise<T>
  name?: string
}
```

---

### `useSubmission`

Track submission state for an action.

```tsx
import { useSubmission, action } from '@fictjs/router'

const createUser = action(...)

function CreateUserForm() {
  const submission = useSubmission(createUser)

  return (
    <Form action={createUser.url}>
      <button disabled={submission()?.state === 'submitting'}>
        {submission()?.state === 'submitting' ? 'Creating...' : 'Create'}
      </button>
    </Form>
  )
}
```

**Returns:** `() => Submission<T> | undefined`

```typescript
interface Submission<T> {
  key: string
  formData: FormData
  state: 'submitting' | 'loading' | 'idle'
  result?: T
  error?: unknown
  clear(): void
  retry(): void
}
```

---

### `useSubmissions`

Track all active submissions.

```tsx
import { useSubmissions } from '@fictjs/router'

function SubmissionMonitor() {
  const submissions = useSubmissions()

  return (
    <ul>
      {submissions().map(s => (
        <li key={s.key}>{s.state}</li>
      ))}
    </ul>
  )
}
```

---

### `createResource`

> **Deprecated:** use the canonical `resource` API from `fict/plus`. It adds
> request cancellation, cache policy, invalidation, mutation, and SSR-aware
> cache ownership. The router helper remains temporarily for compatibility.

Canonical usage:

```tsx
import { resource } from 'fict/plus'
import { reactive } from 'fict/advanced'

const users = resource(async ({ signal }, id: string) => {
  const response = await fetch(`/api/users/${id}`, { signal })
  return response.json()
})

function UserProfile(props: { id: string }) {
  const user = users.read(reactive(() => props.id))
  return <h1>{user.data?.name}</h1>
}
```

Legacy router compatibility usage:

```tsx
import { createResource } from '@fictjs/router'

const userResource = createResource(
  () => userId, // Source signal
  async (id, { signal }) => fetch(`/api/users/${id}`, { signal }).then(r => r.json()),
  { suspense: true },
)

function UserProfile() {
  return <h1>{userResource()?.name}</h1>
}
```

**Returns: `Resource<T>`**

```typescript
interface Resource<T> {
  (): T | undefined // Access data
  loading: () => boolean
  error: () => unknown
  latest: () => T | undefined // Last successful value
  refetch: () => Promise<T | undefined>
}
```

Pass `{ suspense: true }` to throw a request token while loading so the nearest
`Suspense` boundary can render its fallback. Without this option, the main
accessor returns `undefined` while loading. In both modes, `latest()` retains
the last successful value during refreshes. Owned requests are aborted when
their component root is destroyed.

---

### `createPreload`

Create a preload function for routes.

```tsx
import { createPreload } from '@fictjs/router'

const preloadUser = createPreload(async ({ params, intent }) => {
  return await fetchUser(params.id)
})

const routes = [{ path: '/users/:id', component: UserProfile, preload: preloadUser }]
```

---

### `preloadQuery`

Preload a query for faster navigation. The returned promise resolves with the
query result and preserves failures, allowing a route preloader to propagate a
speculative failure so the next Link intent can retry it. Fire-and-forget calls
remain safe from unhandled rejections.

```tsx
import { preloadQuery } from '@fictjs/router'

function UserLink({ id }: { id: string }) {
  return (
    <Link to={`/users/${id}`} onMouseEnter={() => preloadQuery(getUser, id)}>
      View User
    </Link>
  )
}
```

Route integration can return the promise directly:

```tsx
const routes = [
  {
    path: '/users/:id',
    preload: ({ params }) => preloadQuery(getUser, params.id),
  },
]
```

---

## Lazy Loading

### `lazy`

Create a lazy-loaded component.

```tsx
import { lazy } from '@fictjs/router'

const UserProfile = lazy(() => import('./pages/UserProfile'), {
  maxRetries: 2,
  retryDelay: 250,
})

// Use in routes
<Route path="/users/:id" component={UserProfile} />

// Or with Suspense
<Suspense fallback={<Spinner />}>
  <UserProfile />
</Suspense>
```

Router lazy components use the same contract as `lazy` from `fict/plus`:
`preload()` starts loading without rendering, and `reset()` clears a cached
failure so an ErrorBoundary retry can start a new load.

---

### `lazyRoute`

Create a lazy route definition.

```tsx
import { lazyRoute } from '@fictjs/router'

const routes = [
  lazyRoute({
    path: '/users/:id',
    component: () => import('./pages/UserProfile'),
    loadingElement: <Spinner />,
    errorElement: <ErrorPage />,
    lazyOptions: { maxRetries: 2, retryDelay: 250 },
    preload: ({ params }) => fetchUser(params.id),
  }),
]
```

---

### `createLazyRoutes`

Create routes from a glob pattern (file-system routing).

```tsx
import { createLazyRoutes } from '@fictjs/router'

// Vite glob import
const pages = import.meta.glob('./pages/*.tsx')

const routes = createLazyRoutes(pages, {
  pathTransform: path => path.replace('./pages', '').replace('.tsx', '').toLowerCase(),
  loadingElement: <Spinner />,
  errorElement: <ErrorPage />,
  lazyOptions: { maxRetries: 2, retryDelay: 250 },
})
```

---

### `preloadLazy`

Preload a lazy component.

```tsx
import { lazy, preloadLazy } from '@fictjs/router'

const UserProfile = lazy(() => import('./pages/UserProfile'))

// Preload on hover
<button onMouseEnter={() => preloadLazy(UserProfile)}>
  Load Profile
</button>
```

`preloadLazy` also accepts lazy components created by `fict/plus`. Both lazy
entry points expose the same `preload()`, `reset()`, retry, and Suspense
contract; router-created components retain the legacy `__preload` marker for
cross-version compatibility. Older router lazy values that expose only
`__lazy`/`__preload` can still be preloaded, but do not satisfy the public
`LazyComponent` contract.

---

### `isLazyComponent`

Check if a component is lazy-loaded.

```tsx
import { isLazyComponent } from '@fictjs/router'

if (isLazyComponent(Component)) {
  Component.preload()
  Component.reset()
}
```

The guard returns `true` only when both public methods are present. Legacy
`__lazy`/`__preload` markers remain supported by `preloadLazy`, but are not
enough to narrow a value to `LazyComponent`.

---

## Scroll Restoration

### `createScrollRestoration`

Create a scroll restoration manager.

```tsx
import { createScrollRestoration } from '@fictjs/router'

const scrollRestoration = createScrollRestoration({
  enabled: true,
  restoreOnPop: true,
  scrollToTopOnPush: true,
  behavior: 'smooth',
})

// Use in navigation handler
scrollRestoration.handleNavigation(fromLocation, toLocation, 'PUSH')
```

---

### `configureScrollRestoration`

Configure the default scroll restoration.

```tsx
import { configureScrollRestoration } from '@fictjs/router'

configureScrollRestoration({
  enabled: true,
  behavior: 'smooth',
})
```

---

### `getScrollRestoration`

Get the default scroll restoration instance.

```tsx
import { getScrollRestoration } from '@fictjs/router'

const restoration = getScrollRestoration()
restoration.scrollToTop()
```

---

### `scrollToTop`

Scroll to top of page.

```tsx
import { scrollToTop } from '@fictjs/router'

scrollToTop('smooth') // or 'auto'
```

---

### `scrollToHash`

Scroll to element by hash.

```tsx
import { scrollToHash } from '@fictjs/router'

scrollToHash('#section-1', 'smooth')
```

---

### `saveScrollPosition` / `restoreScrollPosition`

Manually save and restore scroll positions.

```tsx
import { saveScrollPosition, restoreScrollPosition } from '@fictjs/router'

// Save current position
saveScrollPosition(location.key)

// Restore later
restoreScrollPosition(location.key)
```

---

## History Factories

### `createBrowserHistory`

Create browser history using History API.

```tsx
import { createBrowserHistory } from '@fictjs/router'

const history = createBrowserHistory()

history.push('/users/123')
history.listen(({ action, location }) => {
  console.log(action, location.pathname)
})
```

---

### `createHashHistory`

Create hash-based history.

```tsx
import { createHashHistory } from '@fictjs/router'

const history = createHashHistory({ hashType: 'slash' })
// URLs like: /#/users/123
```

---

### `createMemoryHistory`

Create in-memory history (testing/SSR).

```tsx
import { createMemoryHistory } from '@fictjs/router'

const history = createMemoryHistory({
  initialEntries: ['/home', '/users'],
  initialIndex: 0,
})
```

---

### `createStaticHistory`

Create static history (SSR).

```tsx
import { createStaticHistory } from '@fictjs/router'

const history = createStaticHistory('/users/123')
// history.location.pathname === '/users/123'
```

---

## Utility Functions

### `normalizePath`

Normalize a path (add leading slash, remove trailing slash).

```tsx
normalizePath('users/') // '/users'
normalizePath('/users/') // '/users'
normalizePath('') // '/'
```

---

### `joinPaths`

Join path segments.

```tsx
joinPaths('/users', '123', 'posts') // '/users/123/posts'
```

---

### `resolvePath`

Resolve relative path against base.

```tsx
resolvePath('/users/123', './posts') // '/users/123/posts'
resolvePath('/users/123', '../admin') // '/users/admin'
resolvePath('/users', '/absolute') // '/absolute'
```

---

### `createLocation`

Create a Location object.

```tsx
createLocation('/users?page=1#top', { data: 'value' })
// {
//   pathname: '/users',
//   search: '?page=1',
//   hash: '#top',
//   state: { data: 'value' },
//   key: 'unique-key'
// }
```

---

### `parseURL`

Parse URL into components.

```tsx
parseURL('/users?page=1#top')
// { pathname: '/users', search: '?page=1', hash: '#top' }
```

---

### `createURL`

Create URL string from Location.

```tsx
createURL({ pathname: '/users', search: '?page=1', hash: '#top' })
// '/users?page=1#top'
```

---

### `parseSearchParams` / `stringifySearchParams`

Parse and stringify search parameters.

```tsx
parseSearchParams('?q=test&page=1') // URLSearchParams

stringifySearchParams({ q: 'test', page: '1' }) // '?q=test&page=1'
```

---

### `matchRoutes`

Match pathname against compiled route branches.

```tsx
import { matchRoutes, createBranches, compileRoute } from '@fictjs/router'

const routes = [{ path: '/users/:id', component: UserProfile }]
const compiled = routes.map(r => compileRoute(r))
const branches = createBranches(compiled)

const matches = matchRoutes(branches, '/users/123')
// [{ route: ..., pathname: '/users/123', params: { id: '123' }, pattern: '/users/:id' }]
```

---

### `locationsAreEqual`

Check if two locations are equal.

```tsx
locationsAreEqual(locationA, locationB) // boolean
```

---

### `stripBasePath` / `prependBasePath`

Manipulate base paths.

```tsx
stripBasePath('/app/users', '/app') // '/users'
prependBasePath('/users', '/app') // '/app/users'
```

---

### `isServer` / `isBrowser`

Environment detection.

```tsx
if (isBrowser()) {
  // Browser-only code
}

if (isServer()) {
  // Server-only code
}
```

---

## Types

### Location Types

```typescript
interface Location {
  pathname: string
  search: string
  hash: string
  state: unknown
  key: string
}

type To = string | Partial<Location>
type NavigationIntent = 'initial' | 'navigate' | 'native' | 'preload'
```

### Parameter Types

```typescript
type Params<Key extends string = string> = Readonly<Record<Key, string | undefined>>
type SearchParams = URLSearchParams
type MatchFilter<T = string> = RegExp | readonly T[] | ((value: string) => boolean)
type MatchFilters<P extends string = string> = Partial<Record<P, MatchFilter>>
```

### Route Types

```typescript
interface RouteDefinition<P extends string = string> {
  path?: string
  component?: Component<RouteComponentProps<P>>
  element?: FictNode
  preload?: PreloadFunction<unknown, P>
  children?: RouteDefinition[]
  matchFilters?: MatchFilters<P>
  index?: boolean
  key?: string
  errorElement?: FictNode
  loadingElement?: FictNode
}

interface RouteMatch<P extends string = string> {
  route: RouteDefinition<P>
  pathname: string
  params: Params<P>
  pattern: string
}

interface RouteComponentProps<P extends string = string> {
  params: Params<P>
  location: Location
  data?: unknown
  children?: FictNode
}
```

### Navigation Types

```typescript
interface NavigateOptions {
  replace?: boolean
  state?: unknown
  scroll?: boolean
  relative?: 'route' | 'path'
}

interface NavigateFunction {
  (to: To, options?: NavigateOptions): void
  (delta: number): void
}
```

### History Types

```typescript
type HistoryAction = 'POP' | 'PUSH' | 'REPLACE'

interface History {
  readonly action: HistoryAction
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

type HistoryListener = (update: { action: HistoryAction; location: Location }) => void
type Blocker = (tx: {
  action: HistoryAction
  location: Location
  retry: () => void // Run blockers again
  proceed?: () => void // Continue once without re-running blockers
}) => void
```

### Router Options

```typescript
interface RouterOptions {
  base?: string
  url?: string
  history?: History
  hydrationData?: {
    loaderData?: Record<string, unknown>
    actionData?: Record<string, unknown>
  }
}

interface MemoryRouterOptions extends RouterOptions {
  initialEntries?: string[]
  initialIndex?: number
}

interface HashRouterOptions extends RouterOptions {
  hashType?: 'slash' | 'noslash'
}
```
