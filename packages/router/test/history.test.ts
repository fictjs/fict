import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createStaticHistory,
} from '../src/history'

describe('browser-backed history lifecycle', () => {
  it('removes browser listeners and blockers when destroyed', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const history = createBrowserHistory()
    history.listen(vi.fn())
    history.block(vi.fn())

    history.destroy?.()
    history.destroy?.()

    expect(removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    removeEventListener.mockRestore()
  })

  it('removes hash listeners and blockers when destroyed', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const history = createHashHistory()
    history.listen(vi.fn())
    history.block(vi.fn())

    history.destroy?.()
    history.destroy?.()

    expect(removeEventListener).toHaveBeenCalledWith('hashchange', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    removeEventListener.mockRestore()
  })

  it('restores a blocked POP before proceeding exactly once', async () => {
    window.history.replaceState({ usr: null, key: 'history-from', idx: 0 }, '', '/history/from')
    const history = createBrowserHistory()
    history.push('/history/to')
    const blocker = vi.fn(({ proceed }) => proceed?.())
    history.block(blocker)

    window.history.back()

    await vi.waitFor(() => expect(history.location.pathname).toBe('/history/from'))
    expect(blocker).toHaveBeenCalledTimes(1)

    window.history.forward()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/history/to'))
    expect(blocker).toHaveBeenCalledTimes(2)

    history.destroy?.()
    window.history.replaceState({ usr: null, key: 'root', idx: 0 }, '', '/')
  })
})

describe('createBrowserHistory unindexed POP handling', () => {
  beforeEach(() => {
    window.history.replaceState({ usr: null, key: 'browser-root', idx: 0 }, '', '/')
  })

  function waitForBrowserHashChange(navigate: () => void): Promise<void> {
    return new Promise(resolve => {
      window.addEventListener('hashchange', () => resolve(), { once: true })
      navigate()
    })
  }

  it('restores an appended fragment POP from a nonzero index', async () => {
    window.history.replaceState(
      { usr: null, key: 'browser-from', idx: 12 },
      '',
      '/browser/direct#browser-from',
    )
    const history = createBrowserHistory()
    history.push('/browser/direct#browser-tail')

    const listener = vi.fn()
    history.listen(listener)
    const blocker = vi.fn(({ proceed }) => {
      setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    window.location.hash = '#browser-appended'

    await vi.waitFor(() => expect(history.location.hash).toBe('#browser-appended'))
    expect(window.location.hash).toBe('#browser-appended')
    expect(window.history.state.idx).toBe(14)
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(historyLength + 1)

    history.destroy?.()
  })

  it('stamps an explicitly traversed legacy entry before retrying', async () => {
    window.history.replaceState(null, '', '/browser/legacy#browser-a')
    await waitForBrowserHashChange(() => {
      window.location.hash = '#browser-b'
    })

    const history = createBrowserHistory()
    expect(history.location.hash).toBe('#browser-b')
    expect(window.history.state.idx).toBe(0)

    const listener = vi.fn()
    history.listen(listener)
    let attempts = 0
    const blocker = vi.fn(({ retry, proceed }) => {
      attempts++
      if (attempts === 1) setTimeout(retry, 0)
      if (attempts === 2) setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    history.back()

    await vi.waitFor(() => expect(history.location.hash).toBe('#browser-a'))
    expect(window.history.state.idx).toBe(-1)
    expect(blocker).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(historyLength)

    history.destroy?.()
  })

  it('fails open when a middle-stack fragment write has no trustworthy direction', async () => {
    window.history.replaceState(null, '', '/browser/middle#browser-a')
    await waitForBrowserHashChange(() => {
      window.location.hash = '#browser-b'
    })
    await waitForBrowserHashChange(() => {
      window.location.hash = '#browser-c'
    })
    await waitForBrowserHashChange(() => window.history.back())

    const history = createBrowserHistory()
    expect(history.location.hash).toBe('#browser-b')

    const listener = vi.fn()
    history.listen(listener)
    const blocker = vi.fn(({ proceed }) => {
      setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    window.location.hash = '#browser-d'

    await vi.waitFor(() => expect(history.location.hash).toBe('#browser-d'))
    expect(window.location.hash).toBe('#browser-d')
    expect(window.history.state.idx).toBe(0)
    expect(blocker).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(historyLength)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot safely block an unindexed browser navigation'),
    )

    history.back()
    await vi.waitFor(() => expect(history.location.hash).toBe('#browser-b'))
    expect(window.location.hash).toBe('#browser-b')
    expect(window.history.state.idx).toBe(-1)
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(window.history.length).toBe(historyLength)

    warn.mockRestore()
    history.destroy?.()
  })
})

describe('createHashHistory POP blocking', () => {
  beforeEach(() => {
    window.history.replaceState({ usr: null, key: 'hash-root', idx: 0 }, '', '/#/')
  })

  function waitForHashChange(navigate: () => void): Promise<void> {
    return new Promise(resolve => {
      window.addEventListener('hashchange', () => resolve(), { once: true })
      navigate()
    })
  }

  it('continues an asynchronously approved POP exactly once without adding entries', async () => {
    window.history.replaceState({ usr: null, key: 'hash-from', idx: 12 }, '', '/#/hash/from')
    const history = createHashHistory()
    history.push('/hash/to')

    expect(window.history.state.idx).toBe(13)

    const listener = vi.fn()
    history.listen(listener)
    const blocker = vi.fn(({ proceed }) => {
      setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    history.back()

    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/from'))
    expect(window.location.hash).toBe('#/hash/from')
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      action: 'POP',
      location: expect.objectContaining({ pathname: '/hash/from' }),
    })
    expect(window.history.length).toBe(historyLength)

    history.destroy?.()
  })

  it('reruns blockers on retry and remains usable after a rejected POP', async () => {
    window.history.replaceState({ usr: null, key: 'hash-a', idx: 20 }, '', '/#/hash/a')
    const history = createHashHistory()
    history.push('/hash/b')

    const listener = vi.fn()
    history.listen(listener)
    let attempts = 0
    const blocker = vi.fn(({ retry, proceed }) => {
      attempts++
      if (attempts === 1) setTimeout(retry, 0)
      if (attempts === 3 || attempts === 4) setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    history.back()

    await vi.waitFor(() => expect(blocker).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(window.location.hash).toBe('#/hash/b'))
    expect(history.location.pathname).toBe('/hash/b')
    expect(listener).not.toHaveBeenCalled()

    history.back()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/a'))
    expect(blocker).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenCalledTimes(1)

    history.forward()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/b'))
    expect(blocker).toHaveBeenCalledTimes(4)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(window.history.length).toBe(historyLength)

    history.destroy?.()
  })

  it('restores and approves a directly assigned hash without creating a recovery entry', async () => {
    window.history.replaceState(
      { usr: null, key: 'hash-direct-from', idx: 30 },
      '',
      '/#/hash/direct-from',
    )
    const history = createHashHistory()
    const listener = vi.fn()
    history.listen(listener)
    const blocker = vi.fn(({ proceed }) => {
      setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    window.location.hash = '#/hash/direct-to'

    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/direct-to'))
    expect(window.location.hash).toBe('#/hash/direct-to')
    expect(window.history.state.idx).toBe(31)
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(historyLength + 1)

    history.destroy?.()
  })

  it('stamps pre-existing unindexed entries in both POP directions', async () => {
    window.history.replaceState(null, '', '/#/hash/legacy-a')
    await waitForHashChange(() => {
      window.location.hash = '#/hash/legacy-b'
    })
    await waitForHashChange(() => {
      window.location.hash = '#/hash/legacy-c'
    })
    await waitForHashChange(() => window.history.back())

    const history = createHashHistory()
    expect(history.location.pathname).toBe('/hash/legacy-b')
    expect(window.history.state.idx).toBe(0)

    const listener = vi.fn()
    history.listen(listener)
    let attempts = 0
    const blocker = vi.fn(({ retry, proceed }) => {
      attempts++
      if (attempts === 1) setTimeout(retry, 0)
      if (attempts > 1) setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length

    // The forward entry predates this history instance. The explicit delta
    // identifies it as index + 1, and retry must run the blocker again.
    history.forward()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/legacy-c'))
    expect(window.history.state.idx).toBe(1)
    expect(blocker).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(1)

    history.back()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/legacy-b'))
    expect(blocker).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenCalledTimes(2)

    // The explicit back delta makes the older unindexed entry recoverable.
    history.back()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/legacy-a'))
    expect(window.history.state.idx).toBe(-1)
    expect(blocker).toHaveBeenCalledTimes(4)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(window.history.length).toBe(historyLength)

    history.destroy?.()
  })

  it('fails open when a middle-stack hash write has no trustworthy direction', async () => {
    window.history.replaceState(null, '', '/#/hash/middle-a')
    await waitForHashChange(() => {
      window.location.hash = '#/hash/middle-b'
    })
    await waitForHashChange(() => {
      window.location.hash = '#/hash/middle-c'
    })
    await waitForHashChange(() => window.history.back())

    const history = createHashHistory()
    expect(history.location.pathname).toBe('/hash/middle-b')

    const listener = vi.fn()
    history.listen(listener)
    const blocker = vi.fn(({ proceed }) => {
      setTimeout(() => proceed?.(), 0)
    })
    history.block(blocker)
    const historyLength = window.history.length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // This truncates C and appends D, leaving history.length unchanged. Since
    // legacy events cannot distinguish it from an unindexed traversal, the
    // history must not guess a restoration delta and get stuck at the new URL.
    window.location.hash = '#/hash/middle-d'
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/middle-d'))
    expect(window.location.hash).toBe('#/hash/middle-d')
    expect(window.history.state.idx).toBe(0)
    expect(blocker).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(historyLength)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot safely block an unindexed hash navigation'),
    )

    // The new anchor makes a later explicit traversal blockable again.
    history.back()
    await vi.waitFor(() => expect(history.location.pathname).toBe('/hash/middle-b'))
    expect(window.location.hash).toBe('#/hash/middle-b')
    expect(window.history.state.idx).toBe(-1)
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(window.history.length).toBe(historyLength)

    warn.mockRestore()
    history.destroy?.()
  })
})

describe('createMemoryHistory', () => {
  it('should initialize with default entry', () => {
    const history = createMemoryHistory()
    expect(history.location.pathname).toBe('/')
    expect(history.action).toBe('POP')
  })

  it('should initialize with custom entries', () => {
    const history = createMemoryHistory({
      initialEntries: ['/users', '/about'],
      initialIndex: 0,
    })
    expect(history.location.pathname).toBe('/users')
  })

  it('should normalize empty initial entries to the default entry', () => {
    const history = createMemoryHistory({ initialEntries: [] })

    expect(history.location.pathname).toBe('/')
    expect(history.location.search).toBe('')
    expect(history.location.hash).toBe('')
    expect(history.action).toBe('POP')
  })

  it('should support replace and push after empty initial entries', () => {
    const history = createMemoryHistory({ initialEntries: [] })

    history.replace('/login')
    expect(history.location.pathname).toBe('/login')
    expect(history.action).toBe('REPLACE')

    history.push('/dashboard')
    expect(history.location.pathname).toBe('/dashboard')
    expect(history.action).toBe('PUSH')

    history.back()
    expect(history.location.pathname).toBe('/login')
  })

  it('should push new entries', () => {
    const history = createMemoryHistory()
    history.push('/users')
    expect(history.location.pathname).toBe('/users')
    expect(history.action).toBe('PUSH')
  })

  it('should replace current entry', () => {
    const history = createMemoryHistory()
    history.push('/users')
    history.replace('/about')
    expect(history.location.pathname).toBe('/about')
    expect(history.action).toBe('REPLACE')
  })

  it('should navigate back and forward', () => {
    const history = createMemoryHistory()
    history.push('/users')
    history.push('/about')

    history.back()
    expect(history.location.pathname).toBe('/users')

    history.forward()
    expect(history.location.pathname).toBe('/about')
  })

  it('should go by delta', () => {
    const history = createMemoryHistory({
      initialEntries: ['/', '/users', '/about'],
      initialIndex: 2,
    })

    history.go(-2)
    expect(history.location.pathname).toBe('/')

    history.go(1)
    expect(history.location.pathname).toBe('/users')
  })

  it('should notify listeners on navigation', () => {
    const history = createMemoryHistory()
    const listener = vi.fn()

    const unlisten = history.listen(listener)
    history.push('/users')

    expect(listener).toHaveBeenCalledWith({
      action: 'PUSH',
      location: expect.objectContaining({ pathname: '/users' }),
    })

    unlisten()
    history.push('/about')

    // Listener should not be called after unlisten
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('should create href from location', () => {
    const history = createMemoryHistory()
    expect(history.createHref('/users')).toBe('/users')
    expect(history.createHref({ pathname: '/users', search: '?page=1' })).toBe('/users?page=1')
  })

  it('should support state in navigation', () => {
    const history = createMemoryHistory()
    history.push('/users', { from: '/home' })
    expect(history.location.state).toEqual({ from: '/home' })
  })

  it('should handle blockers', () => {
    const history = createMemoryHistory()
    const blocker = vi.fn(({ retry }) => {
      // Don't retry - block the navigation
    })

    const unblock = history.block(blocker)
    history.push('/users')

    // Navigation should be blocked
    expect(history.location.pathname).toBe('/')
    expect(blocker).toHaveBeenCalled()

    unblock()
    history.push('/users')

    // Navigation should succeed after unblocking
    expect(history.location.pathname).toBe('/users')
  })

  it('should clamp index to valid range', () => {
    const history = createMemoryHistory({
      initialEntries: ['/users'],
      initialIndex: 10, // Out of range
    })
    expect(history.location.pathname).toBe('/users')
  })

  it('should clamp negative index to valid range', () => {
    const history = createMemoryHistory({
      initialEntries: ['/users'],
      initialIndex: -10,
    })
    expect(history.location.pathname).toBe('/users')
  })

  it('should truncate forward entries on push', () => {
    const history = createMemoryHistory({
      initialEntries: ['/', '/users', '/about'],
      initialIndex: 1,
    })

    history.push('/settings')

    // Forward entries (/about) should be removed
    history.forward()
    expect(history.location.pathname).toBe('/settings') // Still at settings, no forward entry
  })
})

describe('createStaticHistory', () => {
  it('should initialize with given URL', () => {
    const history = createStaticHistory('/users/123')
    expect(history.location.pathname).toBe('/users/123')
    expect(history.action).toBe('POP')
  })

  it('should parse URL with search and hash', () => {
    const history = createStaticHistory('/users?page=1#section')
    expect(history.location.pathname).toBe('/users')
    expect(history.location.search).toBe('?page=1')
    expect(history.location.hash).toBe('#section')
  })

  it('should not allow navigation', () => {
    const history = createStaticHistory('/users')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    history.push('/about')
    expect(history.location.pathname).toBe('/users')
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('should create href', () => {
    const history = createStaticHistory('/users')
    expect(history.createHref('/about')).toBe('/about')
  })
})
