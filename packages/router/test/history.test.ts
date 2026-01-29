import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMemoryHistory, createStaticHistory } from '../src/history'

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
