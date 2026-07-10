import { describe, it, expect, vi } from 'vitest'
import { untrack } from '@fictjs/runtime'
import { render, screen, act } from '@fictjs/testing-library'

import {
  Router,
  MemoryRouter,
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
  type History,
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
})
