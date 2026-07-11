import { describe, it, expect, vi } from 'vitest'
import { untrack, type FictNode } from '@fictjs/runtime'
import { render, screen, act } from '@fictjs/testing-library'
import { $state } from 'fict'

import {
  Router,
  MemoryRouter,
  Routes,
  Route,
  createBrowserHistory,
  createMemoryHistory,
  useNavigate,
  useLocation,
  useBeforeLeave,
  usePendingLocation,
  useHref,
  NavLink,
  Link,
  Form,
  Navigate,
  Redirect,
  type History,
  type RouteDefinition,
} from '../src'
import { RouterProvider } from '../src/router-provider'
import { readAccessor } from '../src/context'

function LocationText() {
  const location = useLocation()
  return <span data-testid="path">{location().pathname}</span>
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate()
  const target = untrack(() => to)
  return (
    <button data-testid={`go-${target}`} onClick={() => navigate(target)}>
      go
    </button>
  )
}

function NumericNavigateButton({ delta }: { delta: number }) {
  const navigate = useNavigate()
  return (
    <button data-testid={`go-${delta}`} onClick={() => navigate(delta)}>
      go
    </button>
  )
}

function ReplaceNavigateButton({ to }: { to: string }) {
  const navigate = useNavigate()
  return (
    <button data-testid={`replace-${to}`} onClick={() => navigate(to, { replace: true })}>
      replace
    </button>
  )
}

function PendingText() {
  const pending = usePendingLocation()
  return <span data-testid="pending">{pending()?.pathname ?? 'none'}</span>
}

function HrefText({ to }: { to: string }) {
  const href = useHref(to)
  return <span data-testid="href" data-href={readAccessor(href)} />
}

function Guarded({
  onCall,
}: {
  onCall: (retry: (force?: boolean) => void, prevent: () => void) => void | Promise<void>
}) {
  const handleCall = untrack(() => onCall)
  useBeforeLeave(event => {
    return handleCall(event.retry, event.preventDefault)
  })
  return <div data-testid="guarded" />
}

const firstReactiveLinkClick = vi.fn()
const secondReactiveLinkClick = vi.fn()
let reactiveLinkControls: {
  updateNavigation: () => void
  setDisabled: (value: boolean) => void
  setPrefetch: (value: 'none' | 'intent' | 'render') => void
  setTo: (value: string) => void
} = {
  updateNavigation: () => {},
  setDisabled: () => {},
  setPrefetch: () => {},
  setTo: () => {},
}

function ReactiveLinkFixture() {
  let to = $state('/first')
  let state = $state<unknown>({ version: 1 })
  let replace = $state(false)
  let disabled = $state(false)
  let prefetch = $state<'none' | 'intent' | 'render'>('none')
  let useSecondHandler = $state(false)

  reactiveLinkControls = {
    updateNavigation: () => {
      to = '/second'
      state = { version: 2 }
      replace = true
      useSecondHandler = true
    },
    setDisabled: value => {
      disabled = value
    },
    setPrefetch: value => {
      prefetch = value
    },
    setTo: value => {
      to = value
    },
  }

  return (
    <Link
      to={to}
      state={state}
      replace={replace}
      disabled={disabled}
      prefetch={prefetch}
      onClick={useSecondHandler ? secondReactiveLinkClick : firstReactiveLinkClick}
      data-testid="reactive-link"
    >
      link
    </Link>
  )
}

const firstNavChild = () => <span data-testid="nav-child">first</span>
const secondNavChild = () => <span data-testid="nav-child">second</span>
let reactiveNavLinkControls: {
  updatePresentation: () => void
  setDisabled: (value: boolean) => void
  setPendingClass: (value: string) => void
  setTo: (value: string) => void
} = {
  updatePresentation: () => {},
  setDisabled: () => {},
  setPendingClass: () => {},
  setTo: () => {},
}

function ReactiveNavLinkFixture() {
  let to = $state('/current')
  let className = $state('base-one')
  let activeClassName = $state('active-one')
  let pendingClassName = $state('pending-one')
  let disabled = $state(false)
  let useSecondChild = $state(false)

  reactiveNavLinkControls = {
    updatePresentation: () => {
      className = 'base-two'
      activeClassName = 'active-two'
      useSecondChild = true
    },
    setDisabled: value => {
      disabled = value
    },
    setPendingClass: value => {
      pendingClassName = value
    },
    setTo: value => {
      to = value
    },
  }

  return (
    <NavLink
      to={to}
      className={className}
      activeClassName={activeClassName}
      pendingClassName={pendingClassName}
      disabled={disabled}
      data-testid="reactive-nav-link"
      children={useSecondChild ? secondNavChild : firstNavChild}
    />
  )
}

const firstReactiveFormSubmit = vi.fn()
const secondReactiveFormSubmit = vi.fn()
let updateReactiveForm: () => void = () => {}

function ReactiveFormFixture() {
  let action = $state('/first-action')
  let method = $state<'get' | 'post'>('post')
  let replace = $state(false)
  let useSecondHandler = $state(false)

  updateReactiveForm = () => {
    action = '/second-action'
    method = 'get'
    replace = true
    useSecondHandler = true
  }

  return (
    <Form
      action={action}
      method={method}
      replace={replace}
      onSubmit={useSecondHandler ? secondReactiveFormSubmit : firstReactiveFormSubmit}
      data-testid="reactive-form"
    >
      <input name="query" value="fict" />
    </Form>
  )
}

let updateReactiveFormScroll: (
  action: string,
  preventScrollReset: boolean | undefined,
) => void = () => {}

function ReactiveFormScrollFixture() {
  let action = $state('/no-scroll')
  let preventScrollReset = $state<boolean | undefined>(true)

  updateReactiveFormScroll = (nextAction, nextPreventScrollReset) => {
    action = nextAction
    preventScrollReset = nextPreventScrollReset
  }

  return (
    <Form
      action={action}
      method="get"
      preventScrollReset={preventScrollReset}
      data-testid="reactive-scroll-form"
    />
  )
}

let relativeFormScenario: {
  method: 'get' | 'post'
  initialRelative: 'route' | 'path' | undefined
} = {
  method: 'get',
  initialRelative: 'path',
}
let updateRelativeFormAction: (
  action: string,
  relative: 'route' | 'path' | undefined,
) => void = () => {}

function RelativeFormParent(props: { children?: FictNode }) {
  let action = $state('draft')
  let relative = $state<'route' | 'path' | undefined>(relativeFormScenario.initialRelative)

  updateRelativeFormAction = (nextAction, nextRelative) => {
    action = nextAction
    relative = nextRelative
  }

  return (
    <div>
      <Form
        action={action}
        method={relativeFormScenario.method}
        relative={relative}
        data-testid="relative-form"
      >
        <input name="query" value="fict" />
      </Form>
      {props.children}
    </div>
  )
}

function RelativeLinkParent(props: { children?: FictNode }) {
  return (
    <div>
      <LocationText />
      <Link to="save" relative="route" data-testid="route-relative-link">
        route link
      </Link>
      <Link to="save" relative="path" data-testid="path-relative-link">
        path link
      </Link>
      <NavLink
        to="edit/details"
        relative="route"
        end
        activeClassName="active"
        data-testid="route-relative-nav-link"
      >
        route nav link
      </NavLink>
      <NavLink
        to="edit/details"
        relative="path"
        end
        activeClassName="active"
        data-testid="path-relative-nav-link"
      >
        path nav link
      </NavLink>
      {props.children}
    </div>
  )
}

let updateReactiveNavigate: () => void = () => {}
function ReactiveNavigateFixture() {
  let to = $state('/navigate-one')
  let state = $state<unknown>({ version: 1 })
  let replace = $state(true)

  updateReactiveNavigate = () => {
    to = '/navigate-two'
    state = { version: 2 }
    replace = false
  }

  return <Navigate to={to} state={state} replace={replace} />
}

let updateReactiveRedirect: () => void = () => {}
function ReactiveRedirectFixture() {
  let to = $state('/redirect-one')
  let state = $state<unknown>({ version: 1 })
  let push = $state(false)

  updateReactiveRedirect = () => {
    to = '/redirect-two'
    state = { version: 2 }
    push = true
  }

  return <Redirect to={to} state={state} push={push} />
}

function createLegacyMemoryHistory(): History {
  const history = createMemoryHistory({
    initialEntries: ['/legacy/from', '/legacy/to'],
    initialIndex: 1,
  })

  return {
    get action() {
      return history.action
    },
    get location() {
      return history.location
    },
    push: (to, state) => history.push(to, state),
    replace: (to, state) => history.replace(to, state),
    go: delta => history.go(delta),
    back: () => history.back(),
    forward: () => history.forward(),
    listen: listener => history.listen(listener),
    createHref: to => history.createHref(to),
    block: blocker =>
      history.block(({ action, location, retry }) => blocker({ action, location, retry })),
    destroy: () => history.destroy?.(),
  }
}

describe('Router integration (MemoryRouter)', () => {
  it('keeps search-only hrefs outside a similarly prefixed base unchanged', () => {
    const history = createMemoryHistory({ initialEntries: ['/apple'] })

    render(() => (
      <RouterProvider history={history} routes={[]} base="/app">
        <HrefText to="?query=value" />
      </RouterProvider>
    ))

    expect(screen.getByTestId('href').getAttribute('data-href')).toBe('/apple?query=value')
    history.destroy?.()
  })

  it('normalizes empty initial entries to the root route', () => {
    render(() => (
      <MemoryRouter initialEntries={[]}>
        <Route path="/" element={<LocationText />} />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('path').textContent).toBe('/')
  })

  it('renders loading content before a route preload settles', async () => {
    render(() => (
      <MemoryRouter initialEntries={['/preloaded']}>
        <Route
          path="/preloaded"
          preload={() => Promise.resolve('ready')}
          loadingElement={<span data-testid="preload-loading">loading</span>}
          element={<span data-testid="preload-content">content</span>}
        />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('preload-loading').textContent).toBe('loading')

    await vi.waitFor(() => {
      expect(screen.getByTestId('preload-content').textContent).toBe('content')
    })
    expect(screen.queryByTestId('preload-loading')).toBeNull()
  })

  it('renders the route error element when preload rejects with undefined', async () => {
    render(() => (
      <MemoryRouter initialEntries={['/failed']}>
        <Route
          path="/failed"
          preload={() => Promise.reject(undefined)}
          loadingElement={<span data-testid="undefined-error-loading">loading</span>}
          errorElement={<span data-testid="undefined-error">failed</span>}
          element={<span data-testid="undefined-error-content">content</span>}
        />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('undefined-error-loading').textContent).toBe('loading')

    await vi.waitFor(() => {
      expect(screen.getByTestId('undefined-error').textContent).toBe('failed')
    })
    expect(screen.queryByTestId('undefined-error-content')).toBeNull()
  })

  it('navigates between routes and updates location signal', async () => {
    render(() => (
      <MemoryRouter initialEntries={['/']}>
        <Route
          path="/"
          element={
            <div>
              <LocationText />
              <NavigateButton to="/about" />
            </div>
          }
        />
        <Route path="/about" element={<LocationText />} />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('path').textContent).toBe('/')

    await act(async () => {
      screen.getByTestId('go-/about').click()
    })

    expect(screen.getByTestId('path').textContent).toBe('/about')
  })

  it('runs beforeLeave handlers and blocks navigation when prevented', async () => {
    const onCall = vi.fn()

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
    })

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
  })

  it('clears pending location when beforeLeave blocks navigation', async () => {
    const onCall = vi.fn((_retry, prevent) => {
      prevent()
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <NavLink to="/to" pendingClassName="pending">
                {({ isPending }) => (
                  <span data-testid="nav" className={isPending ? 'pending' : 'idle'}>
                    To
                  </span>
                )}
              </NavLink>
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
    })

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
    expect(screen.getByTestId('nav').className).toBe('idle')
  })

  it('clears pending location when async beforeLeave blocks navigation', async () => {
    const onCall = vi.fn(async (_retry, prevent) => {
      await Promise.resolve()
      prevent()
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('clears pending location when beforeLeave throws', async () => {
    const error = new Error('guard failed')
    const onCall = vi.fn(() => {
      throw error
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
    })

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('clears pending location when beforeLeave rejects', async () => {
    const error = new Error('guard rejected')
    const onCall = vi.fn(async () => {
      await Promise.resolve()
      throw error
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('clears pending location when one of multiple beforeLeave handlers throws', async () => {
    const first = vi.fn(retry => {
      retry()
    })
    const second = vi.fn(() => {
      throw new Error('second guard failed')
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <Guarded onCall={first} />
              <Guarded onCall={second} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
    })

    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('allows retry after a failed beforeLeave handler', async () => {
    let calls = 0
    const onCall = vi.fn(retry => {
      calls += 1
      if (calls === 1) {
        throw new Error('guard failed')
      }
      retry(true)
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <PendingText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
    })

    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')

    await act(async () => {
      screen.getByTestId('go-/to').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onCall).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('path').textContent).toBe('/to')
  })

  it('allows retry after async beforeLeave handler', async () => {
    const onCall = vi.fn(retry => {
      retry(true)
    })

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/to').click()
    })

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('path').textContent).toBe('/to')
  })

  it('runs a beforeLeave handler only once for replace navigation', async () => {
    const onCall = vi.fn(retry => retry(true))

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <ReplaceNavigateButton to="/to" />
            </div>
          }
        />
        <Route path="/to" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('replace-/to').click()
    })

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('path').textContent).toBe('/to')
  })

  it('guards numeric memory navigation and allows an explicit retry', async () => {
    let calls = 0
    const onCall = vi.fn(retry => {
      calls += 1
      if (calls === 2) retry(true)
    })

    render(() => (
      <MemoryRouter initialEntries={['/one', '/two']} initialIndex={1}>
        <Route path="/one" element={<LocationText />} />
        <Route
          path="/two"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <NumericNavigateButton delta={-1} />
            </div>
          }
        />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go--1').click()
    })
    expect(screen.getByTestId('path').textContent).toBe('/two')

    await act(async () => {
      screen.getByTestId('go--1').click()
    })
    expect(onCall).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('path').textContent).toBe('/one')
  })

  it('supports custom histories implemented against the original blocker contract', async () => {
    const history = createLegacyMemoryHistory()
    const onCall = vi.fn(retry => retry(true))

    render(() => (
      <Router history={history}>
        <Route path="/legacy/from" element={<LocationText />} />
        <Route
          path="/legacy/to"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <NumericNavigateButton delta={-1} />
            </div>
          }
        />
      </Router>
    ))

    await act(async () => {
      screen.getByTestId('go--1').click()
    })

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('path').textContent).toBe('/legacy/from')
    history.destroy?.()
  })

  it('does not let a superseded async guard release an older navigation', async () => {
    const approvals: Array<() => void> = []
    const onCall = vi.fn(
      retry =>
        new Promise<void>(resolve => {
          approvals.push(() => {
            retry(true)
            resolve()
          })
        }),
    )

    render(() => (
      <MemoryRouter initialEntries={['/start']}>
        <Route
          path="/start"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
              <NavigateButton to="/first" />
              <NavigateButton to="/second" />
            </div>
          }
        />
        <Route path="/first" element={<LocationText />} />
        <Route path="/second" element={<LocationText />} />
      </MemoryRouter>
    ))

    await act(async () => {
      screen.getByTestId('go-/first').click()
      await Promise.resolve()
      screen.getByTestId('go-/second').click()
      await Promise.resolve()
    })
    expect(approvals).toHaveLength(2)

    await act(async () => {
      approvals[1]!()
      await Promise.resolve()
    })
    expect(screen.getByTestId('path').textContent).toBe('/second')

    await act(async () => {
      approvals[0]!()
      await Promise.resolve()
    })
    expect(screen.getByTestId('path').textContent).toBe('/second')
    expect(onCall).toHaveBeenCalledTimes(2)
  })

  it('guards native browser POP and proceeds after async confirmation', async () => {
    window.history.replaceState({ usr: null, key: 'pop-from', idx: 0 }, '', '/pop/from')
    const history = createBrowserHistory()
    history.push('/pop/to')

    let approve: (() => void) | undefined
    const onCall = vi.fn(
      retry =>
        new Promise<void>(resolve => {
          approve = () => {
            retry(true)
            resolve()
          }
        }),
    )

    render(() => (
      <Router history={history}>
        <Route path="/pop/from" element={<LocationText />} />
        <Route
          path="/pop/to"
          element={
            <div>
              <LocationText />
              <Guarded onCall={onCall} />
            </div>
          }
        />
      </Router>
    ))

    window.history.back()
    await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(window.location.pathname).toBe('/pop/to'))
    expect(screen.getByTestId('path').textContent).toBe('/pop/to')

    await act(async () => {
      approve?.()
    })
    await vi.waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/pop/from'))
    expect(onCall).toHaveBeenCalledTimes(1)

    history.destroy?.()
    window.history.replaceState({ usr: null, key: 'root', idx: 0 }, '', '/')
  })

  it('NavLink active state reflects current route and pending state', async () => {
    render(() => (
      <MemoryRouter initialEntries={['/users']}>
        <Route
          path="/users"
          element={
            <div>
              <LocationText />
              <NavLink to="/users" activeClassName="active" pendingClassName="pending">
                {({ isActive, isPending }) => (
                  <span
                    data-testid="nav"
                    className={isPending ? 'pending' : isActive ? 'active' : 'inactive'}
                  >
                    Users
                  </span>
                )}
              </NavLink>
              <NavigateButton to="/users/list" />
            </div>
          }
        />
        <Route path="/users/list" element={<LocationText />} />
      </MemoryRouter>
    ))

    const nav = screen.getByTestId('nav')
    expect(nav.className).toBe('active')

    await act(async () => {
      screen.getByTestId('go-/users/list').click()
    })

    expect(screen.getByTestId('path').textContent).toBe('/users/list')
  })

  it('honors NavLink case-sensitive matching', () => {
    render(() => (
      <MemoryRouter initialEntries={['/About']}>
        <Route
          path="/About"
          element={
            <div>
              <NavLink to="/about" activeClassName="active" data-testid="insensitive">
                insensitive
              </NavLink>
              <NavLink to="/about" caseSensitive activeClassName="active" data-testid="sensitive">
                sensitive
              </NavLink>
            </div>
          }
        />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('insensitive').className).toBe('active')
    expect(screen.getByTestId('sensitive').className).toBe('')
  })

  it('Link resolves relative paths from current route', async () => {
    render(() => (
      <MemoryRouter initialEntries={['/users/123']}>
        <Route
          path="/users/:id"
          element={
            <div>
              <LocationText />
              <Link to="settings" data-testid="link">
                settings
              </Link>
            </div>
          }
        />
        <Route path="/users/:id/settings" element={<LocationText />} />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('path').textContent).toBe('/users/123')

    await act(async () => {
      screen.getByTestId('link').click()
    })

    expect(screen.getByTestId('path').textContent).toBe('/users/123/settings')
  })

  it('keeps relative Link and NavLink href, active state, and navigation aligned', async () => {
    const history = createMemoryHistory({ initialEntries: ['/app/projects/42/edit/details'] })
    const routes: RouteDefinition[] = [
      {
        path: '/projects/:id',
        component: RelativeLinkParent,
        children: [
          { path: 'edit/details', element: <span data-testid="nested-link-child" /> },
          { path: 'save', element: <span data-testid="route-save" /> },
        ],
      },
    ]

    try {
      render(() => (
        <RouterProvider history={history} routes={routes} base="/app">
          <Routes routes={routes} />
        </RouterProvider>
      ))

      const routeLink = screen.getByTestId('route-relative-link') as HTMLAnchorElement
      const pathLink = screen.getByTestId('path-relative-link') as HTMLAnchorElement
      const routeNavLink = screen.getByTestId('route-relative-nav-link') as HTMLAnchorElement
      const pathNavLink = screen.getByTestId('path-relative-nav-link') as HTMLAnchorElement

      expect(routeLink.getAttribute('href')).toBe('/app/projects/42/save')
      expect(pathLink.getAttribute('href')).toBe('/app/projects/42/edit/details/save')
      expect(routeNavLink.getAttribute('href')).toBe('/app/projects/42/edit/details')
      expect(pathNavLink.getAttribute('href')).toBe('/app/projects/42/edit/details/edit/details')
      expect(routeNavLink.className).toBe('active')
      expect(pathNavLink.className).toBe('')

      await act(async () => {
        routeLink.click()
      })

      expect(history.location.pathname).toBe('/app/projects/42/save')
      expect(screen.getByTestId('path').textContent).toBe('/app/projects/42/save')
    } finally {
      history.destroy?.()
    }
  })

  it('leaves absolute external links to the browser', () => {
    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
              <Link to="https://example.com/docs" data-testid="external">
                docs
              </Link>
            </div>
          }
        />
      </MemoryRouter>
    ))

    const anchor = screen.getByTestId('external') as HTMLAnchorElement
    let routerPreventedDefault = true
    anchor.addEventListener('click', event => {
      routerPreventedDefault = event.defaultPrevented
      event.preventDefault()
    })

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    expect(anchor.getAttribute('href')).toBe('https://example.com/docs')
    expect(routerPreventedDefault).toBe(false)
    expect(screen.getByTestId('path').textContent).toBe('/from')
  })

  it('contains rejected non-GET Form submissions after reporting them', async () => {
    const rejection = new Error('submission failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(rejection)

    try {
      render(() => (
        <MemoryRouter initialEntries={['/form']}>
          <Route
            path="/form"
            element={
              <Form action="/submit" method="post" data-testid="form">
                <input name="value" value="test" />
              </Form>
            }
          />
        </MemoryRouter>
      ))

      const form = screen.getByTestId('form') as HTMLFormElement
      const errors: unknown[] = []
      form.addEventListener('formerror', event => {
        errors.push((event as CustomEvent<{ error: unknown }>).detail.error)
      })

      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(errors).toEqual([rejection])
      expect(consoleError).toHaveBeenCalledWith('[fict-router] Form submission failed:', rejection)
    } finally {
      consoleError.mockRestore()
      fetchMock.mockRestore()
    }
  })

  it('keeps Link navigation, disabled state, handlers, and intent preloads reactive', async () => {
    firstReactiveLinkClick.mockClear()
    secondReactiveLinkClick.mockClear()
    const history = createMemoryHistory({ initialEntries: ['/start', '/current'] })
    const preloads: Array<{ href: string; to: string }> = []
    const onPreload = (event: Event) => {
      preloads.push((event as CustomEvent<{ href: string; to: string }>).detail)
    }
    window.addEventListener('fict-router:preload', onPreload)

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ReactiveLinkFixture />
        </RouterProvider>
      ))

      expect(screen.getByTestId('reactive-link').tagName).toBe('A')
      expect(screen.getByTestId('reactive-link').getAttribute('href')).toBe('/first')

      await act(async () => {
        reactiveLinkControls.updateNavigation()
      })

      expect(screen.getByTestId('reactive-link').getAttribute('href')).toBe('/second')

      await act(async () => {
        reactiveLinkControls.setDisabled(true)
      })
      expect(screen.getByTestId('reactive-link').tagName).toBe('SPAN')

      await act(async () => {
        reactiveLinkControls.setDisabled(false)
        reactiveLinkControls.setPrefetch('intent')
      })

      let link = screen.getByTestId('reactive-link') as HTMLAnchorElement
      link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      expect(preloads).toEqual([{ href: '/second', to: '/second' }])

      await act(async () => {
        reactiveLinkControls.setTo('/third')
      })
      link = screen.getByTestId('reactive-link') as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe('/third')
      link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      expect(preloads).toEqual([
        { href: '/second', to: '/second' },
        { href: '/third', to: '/third' },
      ])

      await act(async () => {
        reactiveLinkControls.setTo('/rendered')
        reactiveLinkControls.setPrefetch('render')
      })
      await vi.waitFor(() =>
        expect(preloads).toEqual([
          { href: '/second', to: '/second' },
          { href: '/third', to: '/third' },
          { href: '/rendered', to: '/rendered' },
        ]),
      )

      link = screen.getByTestId('reactive-link') as HTMLAnchorElement
      link.click()
      await vi.waitFor(() => expect(history.location.pathname).toBe('/rendered'))
      expect(history.action).toBe('REPLACE')
      expect(history.location.state).toEqual({ version: 2 })
      expect(firstReactiveLinkClick).not.toHaveBeenCalled()
      expect(secondReactiveLinkClick).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('fict-router:preload', onPreload)
      history.destroy?.()
    }
  })

  it('keeps NavLink target, presentation, pending class, children, and disabled state reactive', async () => {
    const history = createMemoryHistory({ initialEntries: ['/current'] })
    let cancelNavigation: (() => void) | undefined
    const guard = vi.fn(
      (_retry, prevent) =>
        new Promise<void>(resolve => {
          cancelNavigation = () => {
            prevent()
            resolve()
          }
        }),
    )

    render(() => (
      <RouterProvider history={history} routes={[]}>
        <ReactiveNavLinkFixture />
        <Guarded onCall={guard} />
      </RouterProvider>
    ))

    let navLink = screen.getByTestId('reactive-nav-link') as HTMLAnchorElement
    expect(navLink.className).toBe('base-one active-one')
    expect(screen.getByTestId('nav-child').textContent).toBe('first')

    await act(async () => {
      reactiveNavLinkControls.updatePresentation()
    })
    await vi.waitFor(() => expect(navLink.className).toBe('base-two active-two'))
    await vi.waitFor(() => expect(screen.getByTestId('nav-child').textContent).toBe('second'))

    await act(async () => {
      reactiveNavLinkControls.setTo('/pending')
    })
    expect(navLink.getAttribute('href')).toBe('/pending')
    await vi.waitFor(() => expect(navLink.className).toBe('base-two'))

    navLink.click()
    await vi.waitFor(() => expect(navLink.className).toBe('base-two pending-one'))
    expect(guard).toHaveBeenCalledTimes(1)

    await act(async () => {
      reactiveNavLinkControls.setPendingClass('pending-two')
    })
    expect(navLink.className).toBe('base-two pending-two')

    await act(async () => {
      cancelNavigation?.()
    })
    await vi.waitFor(() => expect(navLink.className).toBe('base-two'))

    await act(async () => {
      reactiveNavLinkControls.setDisabled(true)
    })
    navLink = screen.getByTestId('reactive-nav-link') as HTMLAnchorElement
    expect(navLink.tagName).toBe('SPAN')
    expect(navLink.className).toBe('base-two')
    history.destroy?.()
  })

  it('reads current Form action, method, replace option, and submit handler', async () => {
    firstReactiveFormSubmit.mockClear()
    secondReactiveFormSubmit.mockClear()
    const history = createMemoryHistory({ initialEntries: ['/start', '/form'] })

    render(() => (
      <RouterProvider history={history} routes={[]}>
        <ReactiveFormFixture />
      </RouterProvider>
    ))

    const form = screen.getByTestId('reactive-form') as HTMLFormElement
    expect(form.getAttribute('action')).toBe('/first-action')
    expect(form.getAttribute('method')).toBe('post')

    await act(async () => {
      updateReactiveForm()
    })
    expect(form.getAttribute('action')).toBe('/second-action')
    expect(form.getAttribute('method')).toBe('get')

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(history.location.pathname).toBe('/second-action'))
    expect(history.location.search).toBe('?query=fict')
    expect(history.action).toBe('REPLACE')
    expect(firstReactiveFormSubmit).not.toHaveBeenCalled()
    expect(secondReactiveFormSubmit).toHaveBeenCalledTimes(1)
    history.destroy?.()
  })

  it('uses the current preventScrollReset value for GET navigation', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const requestAnimationFrameMock = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    const scrollToMock = vi.mocked(window.scrollTo)

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ReactiveFormScrollFixture />
        </RouterProvider>
      ))

      const form = screen.getByTestId('reactive-scroll-form') as HTMLFormElement
      scrollToMock.mockClear()
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(history.location.pathname).toBe('/no-scroll'))
      expect(scrollToMock).not.toHaveBeenCalled()

      await act(async () => {
        updateReactiveFormScroll('/scroll-false', false)
      })
      scrollToMock.mockClear()
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(history.location.pathname).toBe('/scroll-false'))
      expect(scrollToMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        updateReactiveFormScroll('/scroll-default', undefined)
      })
      scrollToMock.mockClear()
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(history.location.pathname).toBe('/scroll-default'))
      expect(scrollToMock).toHaveBeenCalledTimes(1)
    } finally {
      requestAnimationFrameMock.mockRestore()
      history.destroy?.()
    }
  })

  it('prevents scroll reset for non-GET response redirects', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const requestAnimationFrameMock = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    const scrollToMock = vi.mocked(window.scrollTo)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { Location: '/submitted' },
      }),
    )

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form
            action="/submit"
            method="post"
            preventScrollReset
            data-testid="no-scroll-post-form"
          />
        </RouterProvider>
      ))

      scrollToMock.mockClear()
      const form = screen.getByTestId('no-scroll-post-form') as HTMLFormElement
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

      await vi.waitFor(() => expect(history.location.pathname).toBe('/submitted'))
      expect(scrollToMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      requestAnimationFrameMock.mockRestore()
      history.destroy?.()
    }
  })

  it.each([
    { method: 'get' as const, relative: 'route' as const, label: 'route-relative GET' },
    { method: 'get' as const, relative: 'path' as const, label: 'path-relative GET' },
    { method: 'post' as const, relative: undefined, label: 'default route-relative POST' },
    { method: 'post' as const, relative: 'path' as const, label: 'path-relative POST' },
  ])('resolves nested Form actions for $label', async ({ method, relative }) => {
    const initialPath = '/app/projects/42/edit/details'
    const routeBase = '/projects/42'
    const pathBase = '/projects/42/edit/details'
    const initialRelative = relative === 'path' ? 'route' : 'path'
    const initialResolvedBase = initialRelative === 'path' ? pathBase : routeBase
    const resolvedBase = relative === 'path' ? pathBase : routeBase
    const history = createMemoryHistory({ initialEntries: [initialPath] })
    const routes: RouteDefinition[] = [
      {
        path: '/projects/:id',
        component: RelativeFormParent,
        children: [{ path: 'edit/details', element: <span data-testid="nested-child" /> }],
      },
    ]
    const fetchMock =
      method === 'post'
        ? vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : undefined

    relativeFormScenario = { method, initialRelative }

    try {
      render(() => (
        <RouterProvider history={history} routes={routes} base="/app">
          <Routes routes={routes} />
        </RouterProvider>
      ))

      const form = screen.getByTestId('relative-form') as HTMLFormElement
      expect(form.getAttribute('action')).toBe(`/app${initialResolvedBase}/draft`)

      await act(async () => {
        updateRelativeFormAction('save#done', relative)
      })
      await vi.waitFor(() =>
        expect(form.getAttribute('action')).toBe(`/app${resolvedBase}/save#done`),
      )

      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

      if (method === 'get') {
        await vi.waitFor(() => expect(history.location.pathname).toBe(`/app${resolvedBase}/save`))
        expect(history.location.search).toBe('?query=fict')
        expect(history.location.hash).toBe('#done')
      } else {
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(fetchMock?.mock.calls[0]?.[0]).toBe(`/app${resolvedBase}/save#done`)
        expect(fetchMock?.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
        expect(history.location.pathname).toBe(initialPath)
      }
    } finally {
      fetchMock?.mockRestore()
      history.destroy?.()
    }
  })

  it.each([
    { action: 'save', expectedPath: '/form/save', label: 'relative action' },
    { action: undefined, expectedPath: '/form', label: 'omitted action' },
  ])('falls back to the current pathname for a Form $label without RouteContext', async case_ => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action={case_.action} data-testid="provider-form">
            <input name="query" value="fict" />
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('provider-form') as HTMLFormElement
      expect(form.getAttribute('action')).toBe(case_.expectedPath)

      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(history.location.pathname).toBe(case_.expectedPath))
      expect(history.location.search).toBe('?query=fict')
    } finally {
      history.destroy?.()
    }
  })

  it('reruns Navigate only for current reactive navigation props', async () => {
    const history = createMemoryHistory({ initialEntries: ['/start'] })
    render(() => (
      <RouterProvider history={history} routes={[]}>
        <ReactiveNavigateFixture />
      </RouterProvider>
    ))

    await vi.waitFor(() => expect(history.location.pathname).toBe('/navigate-one'))
    expect(history.action).toBe('REPLACE')
    expect(history.location.state).toEqual({ version: 1 })

    await act(async () => {
      updateReactiveNavigate()
    })
    await vi.waitFor(() => expect(history.location.pathname).toBe('/navigate-two'))
    expect(history.action).toBe('PUSH')
    expect(history.location.state).toEqual({ version: 2 })
    history.destroy?.()
  })

  it('reruns Redirect only for current reactive redirect props', async () => {
    const history = createMemoryHistory({ initialEntries: ['/start'] })
    render(() => (
      <RouterProvider history={history} routes={[]}>
        <ReactiveRedirectFixture />
      </RouterProvider>
    ))

    await vi.waitFor(() => expect(history.location.pathname).toBe('/redirect-one'))
    expect(history.action).toBe('REPLACE')
    expect(history.location.state).toEqual({ version: 1 })

    await act(async () => {
      updateReactiveRedirect()
    })
    await vi.waitFor(() => expect(history.location.pathname).toBe('/redirect-two'))
    expect(history.action).toBe('PUSH')
    expect(history.location.state).toEqual({ version: 2 })
    history.destroy?.()
  })
})
