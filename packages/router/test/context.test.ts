import { describe, it, expect, vi } from 'vitest'

// Mock @fictjs/runtime
vi.mock('@fictjs/runtime', () => ({
  createContext: <T>(defaultValue: T) => {
    let currentValue = defaultValue
    return {
      Provider: ({ value, children }: { value: T; children: any }) => {
        currentValue = value
        return children
      },
      displayName: '',
      _getValue: () => currentValue,
    }
  },
  useContext: <T>(context: { _getValue: () => T }) => context._getValue(),
}))

import {
  RouterContext,
  RouteContext,
  BeforeLeaveContext,
  RouteErrorContext,
  useRouter,
  useRoute,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
  useMatches,
  useIsRouting,
  usePendingLocation,
  useRouteData,
  useRouteError,
  useResolvedPath,
  useMatch,
  useHref,
  useIsActive,
  useBeforeLeave,
  useBeforeLeaveContext,
  readAccessor,
} from '../src/context'
import type { Location, RouteMatch } from '../src/types'

describe('RouterContext', () => {
  it('should have displayName set', () => {
    expect(RouterContext.displayName).toBe('RouterContext')
  })

  it('should provide default router context value', () => {
    const router = useRouter()

    expect(typeof router.location).toBe('function')
    expect(typeof router.params).toBe('function')
    expect(typeof router.matches).toBe('function')
    expect(typeof router.navigate).toBe('function')
    expect(typeof router.isRouting).toBe('function')
    expect(typeof router.pendingLocation).toBe('function')
    expect(typeof router.resolvePath).toBe('function')
    expect(readAccessor(router.base)).toBe('')
  })

  it('default location should return root path', () => {
    const router = useRouter()
    const location = router.location()

    expect(location.pathname).toBe('/')
    expect(location.search).toBe('')
    expect(location.hash).toBe('')
    expect(location.state).toBe(null)
    expect(location.key).toBe('default')
  })

  it('default params should return empty object', () => {
    const router = useRouter()
    const params = router.params()

    expect(params).toEqual({})
  })

  it('default matches should return empty array', () => {
    const router = useRouter()
    const matches = router.matches()

    expect(matches).toEqual([])
  })

  it('default isRouting should return false', () => {
    const router = useRouter()
    expect(router.isRouting()).toBe(false)
  })

  it('default pendingLocation should return null', () => {
    const router = useRouter()
    expect(router.pendingLocation()).toBe(null)
  })

  it('default resolvePath should pass through string paths', () => {
    const router = useRouter()

    expect(router.resolvePath('/about')).toBe('/about')
    expect(router.resolvePath('/users/123')).toBe('/users/123')
  })

  it('default resolvePath should extract pathname from object', () => {
    const router = useRouter()

    expect(router.resolvePath({ pathname: '/about' })).toBe('/about')
    expect(router.resolvePath({ pathname: '/search', search: '?q=test' })).toBe('/search')
    expect(router.resolvePath({})).toBe('/')
  })
})

describe('RouteContext', () => {
  it('should have displayName set', () => {
    expect(RouteContext.displayName).toBe('RouteContext')
  })

  it('should provide default route context value', () => {
    const route = useRoute()

    expect(typeof route.match).toBe('function')
    expect(typeof route.data).toBe('function')
    expect(typeof route.outlet).toBe('function')
    expect(typeof route.resolvePath).toBe('function')
  })

  it('default match should return undefined', () => {
    const route = useRoute()
    expect(route.match()).toBeUndefined()
  })

  it('default data should return undefined', () => {
    const route = useRoute()
    expect(route.data()).toBeUndefined()
  })

  it('default outlet should return null', () => {
    const route = useRoute()
    expect(route.outlet()).toBeNull()
  })

  it('default resolvePath should pass through string paths', () => {
    const route = useRoute()

    expect(route.resolvePath('/about')).toBe('/about')
    expect(route.resolvePath({ pathname: '/about' })).toBe('/about')
    expect(route.resolvePath({})).toBe('/')
  })
})

describe('BeforeLeaveContext', () => {
  it('should have displayName set', () => {
    expect(BeforeLeaveContext.displayName).toBe('BeforeLeaveContext')
  })

  it('should provide default beforeLeave context value', () => {
    const context = useBeforeLeaveContext()

    expect(typeof context.addHandler).toBe('function')
    expect(typeof context.confirm).toBe('function')
  })

  it('default addHandler should return noop cleanup', () => {
    const context = useBeforeLeaveContext()
    const cleanup = context.addHandler(() => {})

    expect(typeof cleanup).toBe('function')
    // Should not throw
    cleanup()
  })

  it('default confirm should resolve to true', async () => {
    const context = useBeforeLeaveContext()
    const location: Location = {
      pathname: '/test',
      search: '',
      hash: '',
      state: null,
      key: 'test',
    }

    const confirmed = await context.confirm(location, location)
    expect(confirmed).toBe(true)
  })
})

describe('RouteErrorContext', () => {
  it('should have displayName set', () => {
    expect(RouteErrorContext.displayName).toBe('RouteErrorContext')
  })
})

describe('useNavigate', () => {
  it('should return navigate function from router context', () => {
    const navigate = useNavigate()
    expect(typeof navigate).toBe('function')
  })
})

describe('useLocation', () => {
  it('should return location getter from router context', () => {
    const location = useLocation()
    expect(typeof location).toBe('function')
    expect(location().pathname).toBe('/')
  })
})

describe('useParams', () => {
  it('should return params getter from router context', () => {
    const params = useParams()
    expect(typeof params).toBe('function')
    expect(params()).toEqual({})
  })
})

describe('useSearchParams', () => {
  it('should return tuple of getter and setter', () => {
    const [getSearchParams, setSearchParams] = useSearchParams()

    expect(typeof getSearchParams).toBe('function')
    expect(typeof setSearchParams).toBe('function')
  })

  it('getter should return URLSearchParams', () => {
    const [getSearchParams] = useSearchParams()
    const params = getSearchParams()

    expect(params).toBeInstanceOf(URLSearchParams)
  })
})

describe('useMatches', () => {
  it('should return matches getter from router context', () => {
    const matches = useMatches()
    expect(typeof matches).toBe('function')
    expect(matches()).toEqual([])
  })
})

describe('useIsRouting', () => {
  it('should return isRouting getter from router context', () => {
    const isRouting = useIsRouting()
    expect(typeof isRouting).toBe('function')
    expect(isRouting()).toBe(false)
  })
})

describe('usePendingLocation', () => {
  it('should return pendingLocation getter from router context', () => {
    const pendingLocation = usePendingLocation()
    expect(typeof pendingLocation).toBe('function')
    expect(pendingLocation()).toBe(null)
  })
})

describe('useRouteData', () => {
  it('should return data getter from route context', () => {
    const data = useRouteData()
    expect(typeof data).toBe('function')
    expect(data()).toBeUndefined()
  })
})

describe('useRouteError', () => {
  it('should return undefined when no error in context', () => {
    const error = useRouteError()
    expect(error).toBeUndefined()
  })
})

describe('useResolvedPath', () => {
  it('should return path resolver function', () => {
    const resolved = useResolvedPath('/about')
    expect(typeof resolved).toBe('function')
  })

  it('should resolve string path', () => {
    const resolved = useResolvedPath('/about')
    expect(resolved()).toBe('/about')
  })

  it('should accept function returning path', () => {
    let path = '/initial'
    const resolved = useResolvedPath(() => path)

    expect(resolved()).toBe('/initial')

    path = '/updated'
    expect(resolved()).toBe('/updated')
  })
})

describe('useMatch', () => {
  it('should return match checker function', () => {
    const match = useMatch('/about')
    expect(typeof match).toBe('function')
  })

  it('should return null when no match', () => {
    const match = useMatch('/about')
    expect(match()).toBe(null)
  })

  it('should accept function returning path', () => {
    let path = '/initial'
    const match = useMatch(() => path)

    expect(match()).toBe(null)

    path = '/updated'
    expect(match()).toBe(null)
  })
})

describe('useHref', () => {
  it('should return href resolver function', () => {
    const href = useHref('/about')
    expect(typeof href).toBe('function')
  })

  it('should resolve string path', () => {
    const href = useHref('/about')
    expect(href()).toBe('/about')
  })

  it('should resolve path with search and hash', () => {
    const href = useHref('/search?q=test#results')
    expect(href()).toBe('/search?q=test#results')
  })

  it('should resolve object path', () => {
    const href = useHref({ pathname: '/about', search: '?foo=bar', hash: '#section' })
    expect(href()).toBe('/about?foo=bar#section')
  })

  it('should accept function returning path', () => {
    let path = '/initial'
    const href = useHref(() => path)

    expect(href()).toBe('/initial')

    path = '/updated'
    expect(href()).toBe('/updated')
  })

  it('should use current location pathname for empty path', () => {
    const href = useHref('?query=value')
    // Default location has pathname '/'
    expect(href()).toBe('/?query=value')
  })
})

describe('useIsActive', () => {
  it('should return active checker function', () => {
    const isActive = useIsActive('/about')
    expect(typeof isActive).toBe('function')
  })

  it('should return true for current path', () => {
    // Default location is '/'
    const isActive = useIsActive('/')
    expect(isActive()).toBe(true)
  })

  it('should return false for non-matching path', () => {
    const isActive = useIsActive('/about')
    expect(isActive()).toBe(false)
  })

  it('should match prefix by default', () => {
    // Default location is '/' which is prefix of all paths
    const isActive = useIsActive('/')
    expect(isActive()).toBe(true)
  })

  it('should require exact match with end option', () => {
    const isActive = useIsActive('/about', { end: true })
    expect(isActive()).toBe(false)

    const isActiveRoot = useIsActive('/', { end: true })
    expect(isActiveRoot()).toBe(true)
  })

  it('should accept function returning path', () => {
    let path = '/'
    const isActive = useIsActive(() => path)

    expect(isActive()).toBe(true)

    path = '/about'
    expect(isActive()).toBe(false)
  })
})

describe('useBeforeLeave', () => {
  it('should accept handler function', () => {
    // Should not throw
    expect(() => {
      useBeforeLeave(() => {})
    }).not.toThrow()
  })

  it('should accept async handler', () => {
    expect(() => {
      useBeforeLeave(async () => {})
    }).not.toThrow()
  })
})
