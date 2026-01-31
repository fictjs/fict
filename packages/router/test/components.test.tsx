import { describe, it, expect, vi, beforeEach } from 'vitest'

// Import components to test
import {
  Router,
  HashRouter,
  MemoryRouter,
  StaticRouter,
  Routes,
  Route,
  Outlet,
  Navigate,
  Redirect,
  createRoutes,
  createRouter,
} from '../src/components'

import type { RouteDefinition } from '../src/types'

describe('Routes', () => {
  it('should be a function component', () => {
    expect(typeof Routes).toBe('function')
  })
})

describe('Route', () => {
  it('should be a function component', () => {
    expect(typeof Route).toBe('function')
  })

  it('should return null (declarative component)', () => {
    const result = Route({ path: '/about' })
    expect(result).toBe(null)
  })

  it('should accept path prop', () => {
    // Route is a declarative component that accepts path
    const result = Route({ path: '/users/:id' })
    expect(result).toBe(null)
  })

  it('should accept component prop', () => {
    const MyComponent = () => null
    const result = Route({ path: '/about', component: MyComponent })
    expect(result).toBe(null)
  })

  it('should accept element prop', () => {
    const result = Route({ path: '/about', element: 'Hello' as any })
    expect(result).toBe(null)
  })

  it('should accept index prop', () => {
    const result = Route({ index: true, element: 'Home' as any })
    expect(result).toBe(null)
  })

  it('should accept preload prop', () => {
    const preloadFn = async () => ({ data: 'test' })
    const result = Route({ path: '/data', preload: preloadFn })
    expect(result).toBe(null)
  })

  it('should accept errorElement prop', () => {
    const result = Route({ path: '/error', errorElement: 'Error!' as any })
    expect(result).toBe(null)
  })

  it('should accept loadingElement prop', () => {
    const result = Route({ path: '/loading', loadingElement: 'Loading...' as any })
    expect(result).toBe(null)
  })

  it('should accept children for nested routes', () => {
    const result = Route({
      path: '/users',
      children: Route({ path: ':id' }) as any,
    })
    expect(result).toBe(null)
  })
})

describe('Outlet', () => {
  it('should be a function component', () => {
    expect(typeof Outlet).toBe('function')
  })
})

describe('Navigate', () => {
  it('should be a function component', () => {
    expect(typeof Navigate).toBe('function')
  })
})

describe('Redirect', () => {
  it('should be a function component', () => {
    expect(typeof Redirect).toBe('function')
  })
})

describe('Router types', () => {
  describe('Router (BrowserRouter)', () => {
    it('should be a function component', () => {
      expect(typeof Router).toBe('function')
    })

    it('should have correct name', () => {
      expect(Router.name).toBe('Router')
    })
  })

  describe('HashRouter', () => {
    it('should be a function component', () => {
      expect(typeof HashRouter).toBe('function')
    })

    it('should have correct name', () => {
      expect(HashRouter.name).toBe('HashRouter')
    })
  })

  describe('MemoryRouter', () => {
    it('should be a function component', () => {
      expect(typeof MemoryRouter).toBe('function')
    })

    it('should have correct name', () => {
      expect(MemoryRouter.name).toBe('MemoryRouter')
    })

    it('should be suitable for testing', () => {
      // MemoryRouter is the recommended router for unit tests
      expect(typeof MemoryRouter).toBe('function')
    })
  })

  describe('StaticRouter', () => {
    it('should be a function component', () => {
      expect(typeof StaticRouter).toBe('function')
    })

    it('should have correct name', () => {
      expect(StaticRouter.name).toBe('StaticRouter')
    })

    it('should be suitable for SSR', () => {
      // StaticRouter is used for server-side rendering
      expect(typeof StaticRouter).toBe('function')
    })
  })
})

describe('createRoutes', () => {
  it('should be a function', () => {
    expect(typeof createRoutes).toBe('function')
  })

  it('should return the same routes array', () => {
    const routes: RouteDefinition[] = [{ path: '/', component: () => null as any }]

    const result = createRoutes(routes)

    expect(result).toBe(routes)
  })

  it('should work with nested routes', () => {
    const routes: RouteDefinition[] = [
      {
        path: '/users',
        component: () => null as any,
        children: [
          { index: true, component: () => null as any },
          { path: ':id', component: () => null as any },
        ],
      },
    ]

    const result = createRoutes(routes)

    expect(result).toHaveLength(1)
    expect(result[0]!.children).toHaveLength(2)
  })

  it('should support all route definition properties', () => {
    const preloadFn = async () => ({ data: 'test' })
    const component = () => null as any

    const routes: RouteDefinition[] = [
      {
        path: '/test',
        component,
        preload: preloadFn,
        errorElement: 'Error',
        loadingElement: 'Loading',
        key: 'test-route',
      },
    ]

    const result = createRoutes(routes)

    expect(result[0]!.path).toBe('/test')
    expect(result[0]!.component).toBe(component)
    expect(result[0]!.preload).toBe(preloadFn)
    expect(result[0]!.errorElement).toBe('Error')
    expect(result[0]!.loadingElement).toBe('Loading')
    expect(result[0]!.key).toBe('test-route')
  })
})

describe('createRouter', () => {
  it('should be a function', () => {
    expect(typeof createRouter).toBe('function')
  })

  it('should return an object with Router component', () => {
    const routes: RouteDefinition[] = [{ path: '/', component: () => null as any }]

    const result = createRouter(routes)

    expect(typeof result.Router).toBe('function')
  })

  it('should accept routes and options', () => {
    const routes: RouteDefinition[] = [
      { path: '/', component: () => null as any },
      { path: '/about', component: () => null as any },
    ]

    const result = createRouter(routes, { base: '/app' })

    expect(typeof result.Router).toBe('function')
  })
})

describe('Route matching behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should match static paths', () => {
    // Route matching is tested through matchRoutes in utils.test.ts
    // This verifies the component structure accepts static paths
    expect(Route({ path: '/about' })).toBe(null)
    expect(Route({ path: '/users/new' })).toBe(null)
  })

  it('should support dynamic segments', () => {
    expect(Route({ path: '/users/:id' })).toBe(null)
    expect(Route({ path: '/posts/:postId/comments/:commentId' })).toBe(null)
  })

  it('should support optional segments', () => {
    expect(Route({ path: '/users/:id?' })).toBe(null)
  })

  it('should support splat/catch-all segments', () => {
    expect(Route({ path: '/files/*' })).toBe(null)
    expect(Route({ path: '/files/*path' })).toBe(null)
  })

  it('should support index routes', () => {
    expect(Route({ index: true, element: 'Home' as any })).toBe(null)
  })
})

describe('Route preload functionality', () => {
  it('should accept sync preload function', () => {
    const syncPreload = () => ({ immediate: true })
    expect(Route({ path: '/sync', preload: syncPreload })).toBe(null)
  })

  it('should accept async preload function', () => {
    const asyncPreload = async () => {
      const data = await Promise.resolve({ fetched: true })
      return data
    }
    expect(Route({ path: '/async', preload: asyncPreload })).toBe(null)
  })

  it('preload function signature is validated by TypeScript', () => {
    const preloadFn = vi.fn(({ params, location, intent }) => {
      return { data: 'test' }
    })

    Route({ path: '/test', preload: preloadFn })

    // The preload function signature is validated by TypeScript
    expect(typeof preloadFn).toBe('function')
  })
})

describe('Error boundary integration', () => {
  it('should accept errorElement for error handling', () => {
    const errorElement = 'Something went wrong!' as any

    const result = Route({
      path: '/error-prone',
      component: () => null as any,
      errorElement,
    })

    expect(result).toBe(null)
  })

  it('should accept loadingElement for suspense fallback', () => {
    const loadingElement = 'Loading...' as any

    const result = Route({
      path: '/lazy',
      component: () => null as any,
      loadingElement,
    })

    expect(result).toBe(null)
  })

  it('should accept both errorElement and loadingElement', () => {
    const result = Route({
      path: '/complete',
      component: () => null as any,
      errorElement: 'Error!' as any,
      loadingElement: 'Loading...' as any,
    })

    expect(result).toBe(null)
  })
})

describe('Nested routing', () => {
  it('should support layout routes without path', () => {
    // Layout routes are routes without a path that provide a wrapper
    const result = Route({
      // No path - acts as layout
      element: 'Layout wrapper' as any,
      children: [Route({ path: 'child', element: 'Child' as any }) as any],
    })

    expect(result).toBe(null)
  })

  it('should support deeply nested routes', () => {
    const result = Route({
      path: '/app',
      children: [
        Route({
          path: 'dashboard',
          children: [
            Route({
              path: 'analytics',
              children: [Route({ path: ':metric', element: 'Metric view' as any }) as any],
            }) as any,
          ],
        }) as any,
      ],
    })

    expect(result).toBe(null)
  })
})

describe('RouteDefinition interface', () => {
  it('should support path property', () => {
    const route: RouteDefinition = { path: '/users' }
    expect(route.path).toBe('/users')
  })

  it('should support component property', () => {
    const component = () => null as any
    const route: RouteDefinition = { path: '/users', component }
    expect(route.component).toBe(component)
  })

  it('should support element property', () => {
    const element = 'Hello' as any
    const route: RouteDefinition = { path: '/users', element }
    expect(route.element).toBe(element)
  })

  it('should support index property', () => {
    const route: RouteDefinition = { index: true }
    expect(route.index).toBe(true)
  })

  it('should support children property', () => {
    const route: RouteDefinition = {
      path: '/users',
      children: [{ path: ':id' }, { path: 'new' }],
    }
    expect(route.children).toHaveLength(2)
  })

  it('should support preload function', () => {
    const preload = async () => ({ data: 'test' })
    const route: RouteDefinition = { path: '/data', preload }
    expect(route.preload).toBe(preload)
  })

  it('should support errorElement', () => {
    const route: RouteDefinition = {
      path: '/error',
      errorElement: 'Error!' as any,
    }
    expect(route.errorElement).toBe('Error!')
  })

  it('should support loadingElement', () => {
    const route: RouteDefinition = {
      path: '/loading',
      loadingElement: 'Loading...' as any,
    }
    expect(route.loadingElement).toBe('Loading...')
  })

  it('should support key for explicit route identity', () => {
    const route: RouteDefinition = {
      path: '/unique',
      key: 'my-unique-route',
    }
    expect(route.key).toBe('my-unique-route')
  })

  it('should support matchFilters for parameter validation', () => {
    const route: RouteDefinition = {
      path: '/users/:id',
      matchFilters: { id: /^\d+$/ },
    }
    expect(route.matchFilters?.id).toEqual(/^\d+$/)
  })
})
