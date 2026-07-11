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
  createHashHistory,
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
  clearAllScrollPositions,
  type History,
  type NavigateOptions,
  type RouteDefinition,
  type To,
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

function ObjectNavigateButton(props: { testId: string; to: To; options?: NavigateOptions }) {
  const navigate = useNavigate()
  const testId = untrack(() => props.testId)
  const to = untrack(() => props.to)
  const options = untrack(() => props.options)
  return (
    <button data-testid={testId} onClick={() => navigate(to, options)}>
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
  onCall: (
    retry: (force?: boolean) => void,
    prevent: () => void,
    defaultPrevented: boolean,
  ) => void | Promise<void>
}) {
  const handleCall = untrack(() => onCall)
  useBeforeLeave(event => {
    return handleCall(event.retry, event.preventDefault, event.defaultPrevented)
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

let setReactiveDownload: (value: boolean | string | undefined) => void = () => {}

function ReactiveDownloadLinkFixture() {
  let download = $state<boolean | string | undefined>('report.pdf')

  setReactiveDownload = value => {
    download = value
  }

  return (
    <Link to="/download-target" download={download} data-testid="reactive-download-link">
      download
    </Link>
  )
}

let setReactiveLinkTarget: (value: string) => void = () => {}

function ReactiveTargetLinkFixture() {
  let target = $state('_BLANK')

  setReactiveLinkTarget = value => {
    target = value
  }

  return (
    <>
      <Link to="/reactive-link-target" target={target} data-testid="reactive-target-link">
        link target
      </Link>
      <NavLink to="/reactive-nav-target" target={target} data-testid="reactive-target-nav-link">
        nav target
      </NavLink>
    </>
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
      <button type="submit" data-testid="reactive-form-submitter">
        Submit
      </button>
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

const reactiveExternalFormSubmit = vi.fn()
let updateReactiveExternalForm: (action: string) => void = () => {}

function ReactiveExternalGetFormFixture() {
  let action = $state('/internal-submit')
  let method = $state<'get' | 'post'>('post')

  updateReactiveExternalForm = nextAction => {
    action = nextAction
    method = 'get'
  }

  return (
    <Form
      action={action}
      method={method}
      onSubmit={reactiveExternalFormSubmit}
      data-testid="reactive-external-form"
    >
      <input name="query" value="fict" />
    </Form>
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
      <Link to="save" data-testid="default-relative-link">
        default link
      </Link>
      <Link to="save" relative="route" data-testid="route-relative-link">
        route link
      </Link>
      <Link to="save" relative="path" data-testid="path-relative-link">
        path link
      </Link>
      <NavLink
        to="edit/details"
        end
        activeClassName="active"
        data-testid="default-relative-nav-link"
      >
        default nav link
      </NavLink>
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

function RouteRelativeActiveParent(props: { children?: FictNode }) {
  return (
    <div>
      <NavLink
        to="edit/details?tab=string#section"
        relative="route"
        end
        activeClassName="active"
        data-testid="route-active-string"
      >
        string
      </NavLink>
      <NavLink
        to={{ pathname: 'edit/details', search: '?tab=object', hash: '#section' }}
        relative="route"
        end
        activeClassName="active"
        data-testid="route-active-object"
      >
        object
      </NavLink>
      <NavLink
        to="?tab=search-only"
        relative="route"
        end
        activeClassName="active"
        data-testid="route-active-search-only"
      >
        search
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

  it('starts beforeLeave unprevented and lets a no-op handler navigate', async () => {
    const observedDefaultPrevented: boolean[] = []
    const onCall = vi.fn((_retry, _prevent, defaultPrevented) => {
      observedDefaultPrevented.push(defaultPrevented)
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

    expect(onCall).toHaveBeenCalled()
    expect(observedDefaultPrevented).toEqual([false])
    expect(screen.getByTestId('path').textContent).toBe('/to')
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

  it('lets a later preventDefault override an earlier non-force retry', async () => {
    const first = vi.fn(retry => retry(false))
    const second = vi.fn((_retry, prevent, defaultPrevented) => {
      expect(defaultPrevented).toBe(false)
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

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('path').textContent).toBe('/from')
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('allows a non-force retry to release the same handler prevention', async () => {
    const onCall = vi.fn((retry, prevent) => {
      prevent()
      retry(false)
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

  it('lets a force retry bypass remaining beforeLeave handlers', async () => {
    const first = vi.fn(retry => retry(true))
    const second = vi.fn((_retry, prevent) => prevent())

    render(() => (
      <MemoryRouter initialEntries={['/from']}>
        <Route
          path="/from"
          element={
            <div>
              <LocationText />
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
    })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/to')
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
    const onCall = vi.fn((retry, prevent) => {
      calls += 1
      if (calls === 1) prevent()
      else retry(true)
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

  it('uses only the pathname for string and object NavLink active state', () => {
    render(() => (
      <MemoryRouter initialEntries={['/app/users?tab=current#current']} base="/app">
        <Route
          path="/users"
          element={
            <div>
              <NavLink
                to="/users?tab=string#section"
                end
                activeClassName="active"
                data-testid="active-string-url"
              >
                string
              </NavLink>
              <NavLink
                to={{ pathname: '/users', search: '?tab=object', hash: '#section' }}
                end
                activeClassName="active"
                data-testid="active-object-url"
              >
                object
              </NavLink>
              <NavLink
                to="?tab=search-only"
                end
                activeClassName="active"
                data-testid="active-search-only"
              >
                search
              </NavLink>
              <NavLink to="#hash-only" end activeClassName="active" data-testid="active-hash-only">
                hash
              </NavLink>
              <NavLink
                to={{ search: '?tab=object-only' }}
                end
                activeClassName="active"
                data-testid="active-object-search-only"
              >
                object search
              </NavLink>
              <NavLink
                to={{ hash: '#object-only' }}
                end
                activeClassName="active"
                data-testid="active-object-hash-only"
              >
                object hash
              </NavLink>
              <NavLink
                to="/other?tab=string#section"
                end
                activeClassName="active"
                data-testid="inactive-other-url"
              >
                other
              </NavLink>
            </div>
          }
        />
      </MemoryRouter>
    ))

    for (const testId of [
      'active-string-url',
      'active-object-url',
      'active-search-only',
      'active-hash-only',
      'active-object-search-only',
      'active-object-hash-only',
    ]) {
      expect(screen.getByTestId(testId).className).toBe('active')
    }
    expect(screen.getByTestId('inactive-other-url').className).toBe('')
    expect(screen.getByTestId('active-string-url').getAttribute('href')).toBe(
      '/app/users?tab=string#section',
    )
    expect(screen.getByTestId('active-search-only').getAttribute('href')).toBe(
      '/app/users?tab=search-only',
    )
    expect(screen.getByTestId('active-hash-only').getAttribute('href')).toBe('/app/users#hash-only')
  })

  it('keeps route-relative NavLink active resolution aligned with hrefs', () => {
    const initialPath = '/app/projects/42/edit/details?current=1#current'
    const history = createMemoryHistory({ initialEntries: [initialPath] })
    const routes: RouteDefinition[] = [
      {
        path: '/projects/:id',
        component: RouteRelativeActiveParent,
        children: [{ path: 'edit/details', element: <span /> }],
      },
    ]

    try {
      render(() => (
        <RouterProvider history={history} routes={routes} base="/app">
          <Routes routes={routes} />
        </RouterProvider>
      ))

      for (const testId of [
        'route-active-string',
        'route-active-object',
        'route-active-search-only',
      ]) {
        expect(screen.getByTestId(testId).className).toBe('active')
      }
      expect(screen.getByTestId('route-active-string').getAttribute('href')).toBe(
        '/app/projects/42/edit/details?tab=string#section',
      )
      expect(screen.getByTestId('route-active-object').getAttribute('href')).toBe(
        '/app/projects/42/edit/details?tab=object#section',
      )
      expect(screen.getByTestId('route-active-search-only').getAttribute('href')).toBe(
        '/app/projects/42/edit/details?tab=search-only',
      )
    } finally {
      history.destroy?.()
    }
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

  it('resolves object pathnames like strings and preserves location fields', async () => {
    const history = createMemoryHistory({ initialEntries: ['/users/42?old=1#old'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ObjectNavigateButton
            testId="object-relative"
            to={{
              pathname: 'settings',
              search: '?tab=profile',
              hash: '#panel',
              state: { source: 'relative-object' },
              key: 'relative-object-key',
            }}
          />
          <ObjectNavigateButton
            testId="object-absolute"
            to={{
              pathname: '/absolute',
              search: '?mode=full',
              hash: '#top',
              state: { source: 'absolute-object' },
              key: 'absolute-object-key',
            }}
          />
          <ObjectNavigateButton
            testId="object-empty"
            to={{
              pathname: '',
              search: '?only=search',
              hash: '#kept-path',
              state: { source: 'empty-object' },
              key: 'empty-object-key',
            }}
          />
        </RouterProvider>
      ))

      await act(async () => {
        screen.getByTestId('object-relative').click()
      })
      expect(history.location).toMatchObject({
        pathname: '/users/42/settings',
        search: '?tab=profile',
        hash: '#panel',
        state: { source: 'relative-object' },
        key: 'relative-object-key',
      })

      await act(async () => {
        screen.getByTestId('object-absolute').click()
      })
      expect(history.location).toMatchObject({
        pathname: '/absolute',
        search: '?mode=full',
        hash: '#top',
        state: { source: 'absolute-object' },
        key: 'absolute-object-key',
      })

      await act(async () => {
        screen.getByTestId('object-empty').click()
      })
      expect(history.location).toMatchObject({
        pathname: '/absolute',
        search: '?only=search',
        hash: '#kept-path',
        state: { source: 'empty-object' },
        key: 'empty-object-key',
      })
    } finally {
      history.destroy?.()
    }
  })

  it('resolves object pathnames with path and route modes under a base', async () => {
    const initialPath = '/app/projects/42/edit/details'
    const history = createMemoryHistory({ initialEntries: [initialPath] })
    const routes: RouteDefinition[] = [
      {
        path: '/projects/:id',
        children: [{ path: 'edit/details', element: <span /> }],
      },
    ]

    try {
      render(() => (
        <RouterProvider history={history} routes={routes} base="/app">
          <ObjectNavigateButton testId="object-path-relative" to={{ pathname: 'settings' }} />
          <ObjectNavigateButton
            testId="object-route-relative"
            to={{ pathname: 'settings' }}
            options={{ relative: 'route' }}
          />
          <ObjectNavigateButton
            testId="object-base-absolute"
            to={{ pathname: '/app/dashboard' }}
            options={{ relative: 'route' }}
          />
        </RouterProvider>
      ))

      await act(async () => {
        screen.getByTestId('object-path-relative').click()
      })
      expect(history.location.pathname).toBe('/app/projects/42/edit/details/settings')

      await act(async () => {
        history.back()
      })
      expect(history.location.pathname).toBe(initialPath)

      await act(async () => {
        screen.getByTestId('object-route-relative').click()
      })
      expect(history.location.pathname).toBe('/app/projects/42/edit/details/settings')

      await act(async () => {
        screen.getByTestId('object-base-absolute').click()
      })
      expect(history.location.pathname).toBe('/app/dashboard')
    } finally {
      history.destroy?.()
    }
  })

  it('resolves relative object pathnames with browser history', async () => {
    window.history.replaceState({ usr: null, key: 'browser-start', idx: 0 }, '', '/browser/start')
    const history = createBrowserHistory()

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ObjectNavigateButton
            testId="browser-object-relative"
            to={{
              pathname: 'next',
              search: '?source=browser',
              hash: '#object',
              state: { kind: 'browser' },
              key: 'browser-object-key',
            }}
          />
        </RouterProvider>
      ))

      await act(async () => {
        screen.getByTestId('browser-object-relative').click()
      })
      expect(history.location).toMatchObject({
        pathname: '/browser/start/next',
        search: '?source=browser',
        hash: '#object',
        state: { kind: 'browser' },
        key: 'browser-object-key',
      })
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        '/browser/start/next?source=browser#object',
      )
    } finally {
      history.destroy?.()
      window.history.replaceState({ usr: null, key: 'root', idx: 0 }, '', '/')
    }
  })

  it('resolves relative object pathnames with hash history', async () => {
    window.history.replaceState({ usr: null, key: 'hash-start', idx: 0 }, '', '/#/hash/start')
    const history = createHashHistory()

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ObjectNavigateButton
            testId="hash-object-relative"
            to={{
              pathname: 'next',
              search: '?source=hash',
              hash: '#object',
              state: { kind: 'hash' },
              key: 'hash-object-key',
            }}
          />
        </RouterProvider>
      ))

      await act(async () => {
        screen.getByTestId('hash-object-relative').click()
      })
      expect(history.location).toMatchObject({
        pathname: '/hash/start/next',
        search: '?source=hash',
        hash: '#object',
        state: { kind: 'hash' },
        key: 'hash-object-key',
      })
      expect(window.location.hash).toBe('#/hash/start/next?source=hash#object')
    } finally {
      history.destroy?.()
      window.history.replaceState({ usr: null, key: 'root', idx: 0 }, '', '/')
    }
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

      const defaultLink = screen.getByTestId('default-relative-link') as HTMLAnchorElement
      const routeLink = screen.getByTestId('route-relative-link') as HTMLAnchorElement
      const pathLink = screen.getByTestId('path-relative-link') as HTMLAnchorElement
      const defaultNavLink = screen.getByTestId('default-relative-nav-link') as HTMLAnchorElement
      const routeNavLink = screen.getByTestId('route-relative-nav-link') as HTMLAnchorElement
      const pathNavLink = screen.getByTestId('path-relative-nav-link') as HTMLAnchorElement

      expect(defaultLink.getAttribute('href')).toBe('/app/projects/42/save')
      expect(routeLink.getAttribute('href')).toBe('/app/projects/42/save')
      expect(pathLink.getAttribute('href')).toBe('/app/projects/42/edit/details/save')
      expect(defaultNavLink.getAttribute('href')).toBe('/app/projects/42/edit/details')
      expect(routeNavLink.getAttribute('href')).toBe('/app/projects/42/edit/details')
      expect(pathNavLink.getAttribute('href')).toBe('/app/projects/42/edit/details/edit/details')
      expect(defaultNavLink.className).toBe('active')
      expect(routeNavLink.className).toBe('active')
      expect(pathNavLink.className).toBe('')

      await act(async () => {
        defaultLink.click()
      })

      expect(history.location.pathname).toBe('/app/projects/42/save')
      expect(screen.getByTestId('path').textContent).toBe('/app/projects/42/save')
    } finally {
      history.destroy?.()
    }
  })

  it('falls back to path-relative links without RouteContext', async () => {
    const history = createMemoryHistory({ initialEntries: ['/app/current/deep'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]} base="/app">
          <Link to="next" data-testid="provider-default-link">
            next
          </Link>
          <Link to="next" relative="path" data-testid="provider-path-link">
            path next
          </Link>
          <NavLink to="." end activeClassName="active" data-testid="provider-default-nav-link">
            current
          </NavLink>
        </RouterProvider>
      ))

      const defaultLink = screen.getByTestId('provider-default-link') as HTMLAnchorElement
      const pathLink = screen.getByTestId('provider-path-link') as HTMLAnchorElement
      const navLink = screen.getByTestId('provider-default-nav-link') as HTMLAnchorElement
      expect(defaultLink.getAttribute('href')).toBe('/app/current/deep/next')
      expect(pathLink.getAttribute('href')).toBe('/app/current/deep/next')
      expect(navLink.getAttribute('href')).toBe('/app/current/deep')
      expect(navLink.className).toBe('active')

      await act(async () => {
        defaultLink.click()
      })
      expect(history.location.pathname).toBe('/app/current/deep/next')
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

  it('intercepts mixed-case _self targets for Link and NavLink', async () => {
    const history = createMemoryHistory({ initialEntries: ['/from'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Link to="/link-self" target="_SELF" data-testid="link-self-target">
            link
          </Link>
          <NavLink to="/nav-self" target="_SeLf" data-testid="nav-self-target">
            nav
          </NavLink>
        </RouterProvider>
      ))

      const linkEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      expect(screen.getByTestId('link-self-target').dispatchEvent(linkEvent)).toBe(false)
      expect(linkEvent.defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(history.location.pathname).toBe('/link-self'))

      await act(async () => {
        history.replace('/from')
      })
      const navEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      expect(screen.getByTestId('nav-self-target').dispatchEvent(navEvent)).toBe(false)
      expect(navEvent.defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(history.location.pathname).toBe('/nav-self'))
    } finally {
      history.destroy?.()
    }
  })

  it('leaves other reserved and named targets to native navigation', () => {
    const history = createMemoryHistory({ initialEntries: ['/from'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Link to="/blank" target="_BLANK" data-testid="blank-target">
            blank
          </Link>
          <NavLink to="/parent" target="_PaReNt" data-testid="parent-target">
            parent
          </NavLink>
          <Link to="/top" target="_ToP" data-testid="top-target">
            top
          </Link>
          <NavLink to="/named" target="reportFrame" data-testid="named-target">
            named
          </NavLink>
        </RouterProvider>
      ))

      const routerPreventedDefaults: boolean[] = []
      const observeClick = (event: MouseEvent) => {
        routerPreventedDefaults.push(event.defaultPrevented)
        event.preventDefault()
      }
      window.addEventListener('click', observeClick)

      try {
        for (const testId of ['blank-target', 'parent-target', 'top-target', 'named-target']) {
          screen
            .getByTestId(testId)
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        }
      } finally {
        window.removeEventListener('click', observeClick)
      }

      expect(routerPreventedDefaults).toEqual([false, false, false, false])
      expect(history.location.pathname).toBe('/from')
    } finally {
      history.destroy?.()
    }
  })

  it('uses the current reactive target when deciding Link interception', async () => {
    const history = createMemoryHistory({ initialEntries: ['/from'] })
    const routerPreventedDefaults: boolean[] = []
    const observeClick = (event: MouseEvent) => {
      routerPreventedDefaults.push(event.defaultPrevented)
      if (!event.defaultPrevented) event.preventDefault()
    }

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ReactiveTargetLinkFixture />
        </RouterProvider>
      ))
      window.addEventListener('click', observeClick)

      const link = screen.getByTestId('reactive-target-link') as HTMLAnchorElement
      const navLink = screen.getByTestId('reactive-target-nav-link') as HTMLAnchorElement
      expect(link.getAttribute('target')).toBe('_BLANK')
      expect(navLink.getAttribute('target')).toBe('_BLANK')
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      navLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      expect(history.location.pathname).toBe('/from')

      await act(async () => {
        setReactiveLinkTarget('_SELF')
      })
      expect(link.getAttribute('target')).toBe('_SELF')
      expect(navLink.getAttribute('target')).toBe('_SELF')
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      await vi.waitFor(() => expect(history.location.pathname).toBe('/reactive-link-target'))
      await act(async () => {
        history.replace('/from')
      })
      navLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      await vi.waitFor(() => expect(history.location.pathname).toBe('/reactive-nav-target'))
      expect(routerPreventedDefaults).toEqual([false, false, true, true])
    } finally {
      window.removeEventListener('click', observeClick)
      history.destroy?.()
    }
  })

  it('leaves Link and NavLink downloads to the browser after onClick', () => {
    const linkClick = vi.fn()
    const navLinkClick = vi.fn((event: MouseEvent) => event.preventDefault())
    const history = createMemoryHistory({ initialEntries: ['/from'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Link to="/link-download" download="" onClick={linkClick} data-testid="download-link">
            link download
          </Link>
          <NavLink
            to="/nav-download"
            download="archive.zip"
            onClick={navLinkClick}
            data-testid="download-nav-link"
          >
            nav download
          </NavLink>
        </RouterProvider>
      ))

      const link = screen.getByTestId('download-link') as HTMLAnchorElement
      const navLink = screen.getByTestId('download-nav-link') as HTMLAnchorElement
      const observedDefaults: boolean[] = []
      const observeClick = (event: MouseEvent) => {
        if (event.target !== link && event.target !== navLink) return
        observedDefaults.push(event.defaultPrevented)
        event.preventDefault()
      }
      window.addEventListener('click', observeClick)

      try {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        navLink.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
        )
      } finally {
        window.removeEventListener('click', observeClick)
      }

      expect(link.hasAttribute('download')).toBe(true)
      expect(link.getAttribute('download')).toBe('')
      expect(navLink.getAttribute('download')).toBe('archive.zip')
      expect(linkClick).toHaveBeenCalledTimes(1)
      expect(navLinkClick).toHaveBeenCalledTimes(1)
      expect(observedDefaults).toEqual([false, true])
      expect(history.location.pathname).toBe('/from')
    } finally {
      history.destroy?.()
    }
  })

  it('uses the current reactive download attribute when handling clicks', async () => {
    const history = createMemoryHistory({ initialEntries: ['/from'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ReactiveDownloadLinkFixture />
        </RouterProvider>
      ))

      const link = screen.getByTestId('reactive-download-link') as HTMLAnchorElement
      const observedDefaults: boolean[] = []
      const observeClick = (event: MouseEvent) => {
        if (event.target !== link) return
        observedDefaults.push(event.defaultPrevented)
        if (!event.defaultPrevented) event.preventDefault()
      }
      window.addEventListener('click', observeClick)

      try {
        expect(link.getAttribute('download')).toBe('report.pdf')
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        expect(history.location.pathname).toBe('/from')

        await act(async () => {
          setReactiveDownload(undefined)
        })
        expect(link.hasAttribute('download')).toBe(false)
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        await vi.waitFor(() => expect(history.location.pathname).toBe('/download-target'))

        await act(async () => {
          history.replace('/from')
          setReactiveDownload('')
        })
        expect(link.hasAttribute('download')).toBe(true)
        expect(link.getAttribute('download')).toBe('')
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        expect(history.location.pathname).toBe('/from')
        expect(observedDefaults).toEqual([false, true, false])
      } finally {
        window.removeEventListener('click', observeClick)
      }
    } finally {
      history.destroy?.()
    }
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

    const submitter = screen.getByTestId('reactive-form-submitter') as HTMLButtonElement
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }))
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

  it('omits the query marker for an empty GET form while preserving the hash', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/search#results" method="get" data-testid="empty-get-form" />
        </RouterProvider>
      ))

      const form = screen.getByTestId('empty-get-form') as HTMLFormElement
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

      await vi.waitFor(() => expect(history.location.pathname).toBe('/search'))
      expect(history.location.search).toBe('')
      expect(history.location.hash).toBe('#results')
    } finally {
      history.destroy?.()
    }
  })

  it('serializes GET File entries as repeated filename strings', async () => {
    const NativeFormData = FormData
    class FormDataWithFiles extends NativeFormData {
      constructor(form?: HTMLFormElement, submitter?: HTMLElement | null) {
        super(form, submitter)
        if (form?.getAttribute('data-testid') === 'file-get-form') {
          this.append('upload', new File(['report'], 'report one.txt'))
          this.append('upload', new File([], ''))
        }
      }
    }
    vi.stubGlobal('FormData', FormDataWithFiles)
    const history = createMemoryHistory({ initialEntries: ['/form'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/search#results" method="get" data-testid="file-get-form">
            <input name="query" value="fict router" />
            <button type="submit" name="intent" value="preview" data-testid="file-get-submitter">
              Search
            </button>
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('file-get-form') as HTMLFormElement
      const submitter = screen.getByTestId('file-get-submitter') as HTMLButtonElement
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }))

      await vi.waitFor(() => expect(history.location.pathname).toBe('/search'))
      expect(history.location.search).toBe(
        '?query=fict+router&intent=preview&upload=report+one.txt&upload=',
      )
      expect(history.location.hash).toBe('#results')
    } finally {
      vi.stubGlobal('FormData', NativeFormData)
      history.destroy?.()
    }
  })

  it('restores the outgoing position after a scroll-disabled navigation and POP', async () => {
    const history = createMemoryHistory({ initialEntries: ['/from'] })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    clearAllScrollPositions()

    let currentScrollX = 12
    let currentScrollY = 345
    const scrollXMock = vi.spyOn(window, 'scrollX', 'get').mockImplementation(() => currentScrollX)
    const scrollYMock = vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => currentScrollY)
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
          <ObjectNavigateButton
            testId="no-scroll-navigation"
            to="/to"
            options={{ scroll: false }}
          />
        </RouterProvider>
      ))

      scrollToMock.mockClear()
      await act(async () => {
        screen.getByTestId('no-scroll-navigation').click()
      })
      expect(history.location.pathname).toBe('/to')
      expect(scrollToMock).not.toHaveBeenCalled()

      currentScrollX = 67
      currentScrollY = 890
      await act(async () => {
        history.back()
      })

      expect(history.location.pathname).toBe('/from')
      expect(scrollToMock).toHaveBeenCalledTimes(1)
      expect(scrollToMock).toHaveBeenLastCalledWith({
        left: 12,
        top: 345,
        behavior: 'auto',
      })
    } finally {
      clearAllScrollPositions()
      requestAnimationFrameMock.mockRestore()
      scrollYMock.mockRestore()
      scrollXMock.mockRestore()
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

  it('leaves current external GET actions to native form submission', async () => {
    reactiveExternalFormSubmit.mockClear()
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <ReactiveExternalGetFormFixture />
        </RouterProvider>
      ))

      const form = screen.getByTestId('reactive-external-form') as HTMLFormElement

      await act(async () => {
        updateReactiveExternalForm('https://example.com/search?source=fict#results')
      })
      await vi.waitFor(() => {
        expect(form.getAttribute('action')).toBe('https://example.com/search?source=fict#results')
        expect(form.getAttribute('method')).toBe('get')
      })

      const absoluteSubmit = new SubmitEvent('submit', { bubbles: true, cancelable: true })
      expect(form.dispatchEvent(absoluteSubmit)).toBe(true)
      expect(absoluteSubmit.defaultPrevented).toBe(false)
      expect(history.location.pathname).toBe('/form')

      await act(async () => {
        updateReactiveExternalForm('//example.org/search')
      })
      await vi.waitFor(() => expect(form.getAttribute('action')).toBe('//example.org/search'))

      const protocolRelativeSubmit = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
      })
      expect(form.dispatchEvent(protocolRelativeSubmit)).toBe(true)
      expect(protocolRelativeSubmit.defaultPrevented).toBe(false)
      expect(history.location.pathname).toBe('/form')
      expect(reactiveExternalFormSubmit).toHaveBeenCalledTimes(2)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('allows onSubmit to cancel an external GET submission', () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault())

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form
            action="https://example.com/search"
            method="get"
            onSubmit={onSubmit}
            data-testid="prevented-external-form"
          />
        </RouterProvider>
      ))

      const form = screen.getByTestId('prevented-external-form') as HTMLFormElement
      const event = new SubmitEvent('submit', { bubbles: true, cancelable: true })
      expect(form.dispatchEvent(event)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(history.location.pathname).toBe('/form')
    } finally {
      history.destroy?.()
    }
  })

  it('leaves targeted GET submissions to the browser', () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/search" method="get" target="_blank" data-testid="targeted-form" />
        </RouterProvider>
      ))

      const form = screen.getByTestId('targeted-form') as HTMLFormElement
      const event = new SubmitEvent('submit', { bubbles: true, cancelable: true })
      expect(form.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
      expect(history.location.pathname).toBe('/form')
    } finally {
      history.destroy?.()
    }
  })

  it('uses the associated submitter action, method, name, and value', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/fallback" method="get" data-testid="submitter-form">
            <input name="query" value="fict" />
            <button
              type="submit"
              name="intent"
              value="preview"
              formAction="/preview"
              formMethod="get"
              data-testid="preview-submitter"
            >
              Preview
            </button>
            <button
              type="submit"
              name="intent"
              value="save"
              formAction="/save"
              formMethod="post"
              data-testid="save-submitter"
            >
              Save
            </button>
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('submitter-form') as HTMLFormElement
      const preview = screen.getByTestId('preview-submitter') as HTMLButtonElement
      const save = screen.getByTestId('save-submitter') as HTMLButtonElement

      const previewEvent = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: preview,
      })
      expect(form.dispatchEvent(previewEvent)).toBe(false)
      await vi.waitFor(() => expect(history.location.pathname).toBe('/preview'))
      expect(history.location.search).toBe('?query=fict&intent=preview')
      expect(fetchMock).not.toHaveBeenCalled()

      const saveEvent = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: save,
      })
      expect(form.dispatchEvent(saveEvent)).toBe(false)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/save')
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
      expect(body.get('query')).toBe('fict')
      expect(body.get('intent')).toBe('save')
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('keeps submitter overrides when onSubmit removes the submitter', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    const onSubmit = vi.fn((event: SubmitEvent) => {
      event.submitter?.remove()
    })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form
            action="/fallback"
            method="get"
            onSubmit={onSubmit}
            data-testid="removed-submitter-form"
          >
            <input name="query" value="fict" />
            <button
              type="submit"
              name="intent"
              value="save"
              formAction="/save"
              formMethod="post"
              data-testid="removed-submitter"
            >
              Save
            </button>
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('removed-submitter-form') as HTMLFormElement
      const submitter = screen.getByTestId('removed-submitter') as HTMLButtonElement
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(false)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(submitter.form).toBeNull()

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/save')
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
      expect(body.get('query')).toBe('fict')
      expect(body.has('intent')).toBe(false)
      expect(history.location.pathname).toBe('/form')
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('excludes a submitter changed to a non-submit button from FormData', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    const onSubmit = vi.fn((event: SubmitEvent) => {
      const submitter = event.submitter as HTMLButtonElement
      submitter.type = 'button'
    })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form
            action="/fallback"
            method="get"
            onSubmit={onSubmit}
            data-testid="retagged-submitter-form"
          >
            <input name="query" value="fict" />
            <button
              type="submit"
              name="intent"
              value="save"
              formAction="/save"
              formMethod="post"
              data-testid="retagged-submitter"
            >
              Save
            </button>
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('retagged-submitter-form') as HTMLFormElement
      const submitter = screen.getByTestId('retagged-submitter') as HTMLButtonElement
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(false)
      expect(submitter.type).toBe('button')

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/save')
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
      expect(body.get('query')).toBe('fict')
      expect(body.has('intent')).toBe(false)
      expect(history.location.pathname).toBe('/form')
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('keeps a removed submitter formTarget native', () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    const onSubmit = vi.fn((event: SubmitEvent) => {
      event.submitter?.remove()
    })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form
            action="/fallback"
            method="post"
            onSubmit={onSubmit}
            data-testid="removed-target-form"
          >
            <button
              type="submit"
              formAction="/search"
              formMethod="get"
              formTarget="_blank"
              data-testid="removed-target-submitter"
            />
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('removed-target-form') as HTMLFormElement
      const submitter = screen.getByTestId('removed-target-submitter') as HTMLButtonElement
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(submitter.form).toBeNull()
      expect(history.location.pathname).toBe('/form')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('leaves a submitter formTarget outside _self to the browser', () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/fallback" method="post" data-testid="submitter-target-form">
            <input
              type="submit"
              formAction="/search"
              formMethod="get"
              formTarget="_blank"
              data-testid="blank-submitter"
            />
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('submitter-target-form') as HTMLFormElement
      const submitter = screen.getByTestId('blank-submitter') as HTMLInputElement
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
      expect(history.location.pathname).toBe('/form')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it('leaves an external GET submitter action to the browser', () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <Form action="/fallback" method="post" data-testid="external-submitter-form">
            <button
              type="submit"
              formAction="https://example.com/search"
              formMethod="get"
              data-testid="external-submitter"
            />
          </Form>
        </RouterProvider>
      ))

      const form = screen.getByTestId('external-submitter-form') as HTMLFormElement
      const submitter = screen.getByTestId('external-submitter') as HTMLButtonElement
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
      expect(history.location.pathname).toBe('/form')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      history.destroy?.()
    }
  })

  it.each(['dialog', '', 'trace', ' get '])(
    'leaves unsupported submitter formMethod %j native',
    method => {
      const history = createMemoryHistory({ initialEntries: ['/form'] })

      try {
        render(() => (
          <RouterProvider history={history} routes={[]}>
            <Form action="/fallback" method="get" data-testid="unsupported-method-form">
              <button
                type="submit"
                formAction="/override"
                formMethod={method}
                data-testid="unsupported-method-submitter"
              />
            </Form>
          </RouterProvider>
        ))

        const form = screen.getByTestId('unsupported-method-form') as HTMLFormElement
        const submitter = screen.getByTestId('unsupported-method-submitter') as HTMLButtonElement
        expect(submitter.getAttribute('formmethod')).toBe(method)
        const event = new SubmitEvent('submit', {
          bubbles: true,
          cancelable: true,
          submitter,
        })
        expect(form.dispatchEvent(event)).toBe(true)
        expect(event.defaultPrevented).toBe(false)
        expect(history.location.pathname).toBe('/form')
      } finally {
        history.destroy?.()
      }
    },
  )

  it('ignores a submitter associated with another form', async () => {
    const history = createMemoryHistory({ initialEntries: ['/form'] })

    try {
      render(() => (
        <RouterProvider history={history} routes={[]}>
          <div>
            <Form action="/fallback" method="get" data-testid="associated-form" />
            <form>
              <button
                type="submit"
                formAction="https://example.com/search"
                formMethod="get"
                data-testid="foreign-submitter"
              />
            </form>
          </div>
        </RouterProvider>
      ))

      const form = screen.getByTestId('associated-form') as HTMLFormElement
      const submitter = screen.getByTestId('foreign-submitter') as HTMLButtonElement
      expect(submitter.form).not.toBe(form)
      const event = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      expect(form.dispatchEvent(event)).toBe(false)
      await vi.waitFor(() => expect(history.location.pathname).toBe('/fallback'))
    } finally {
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
