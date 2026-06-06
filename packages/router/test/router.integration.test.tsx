import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@fictjs/testing-library'

import {
  MemoryRouter,
  Route,
  useNavigate,
  useLocation,
  useBeforeLeave,
  usePendingLocation,
  NavLink,
  Link,
} from '../src'

function LocationText() {
  const location = useLocation()
  return <span data-testid="path">{location().pathname}</span>
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate()
  return (
    <button data-testid={`go-${to}`} onClick={() => navigate(to)}>
      go
    </button>
  )
}

function PendingText() {
  const pending = usePendingLocation()
  return <span data-testid="pending">{pending()?.pathname ?? 'none'}</span>
}

function Guarded({
  onCall,
}: {
  onCall: (retry: (force?: boolean) => void, prevent: () => void) => void
}) {
  useBeforeLeave(event => {
    onCall(event.retry, event.preventDefault)
  })
  return <div data-testid="guarded" />
}

describe('Router integration (MemoryRouter)', () => {
  it('normalizes empty initial entries to the root route', () => {
    render(() => (
      <MemoryRouter initialEntries={[]}>
        <Route path="/" element={<LocationText />} />
      </MemoryRouter>
    ))

    expect(screen.getByTestId('path').textContent).toBe('/')
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

    expect(onCall).toHaveBeenCalled()
    expect(screen.getByTestId('path').textContent).toBe('/to')
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
})
