import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lazy as frameworkLazy } from 'fict/plus'
import {
  lazy,
  preloadLazy,
  retryPreloadLazy,
  isLazyComponent,
  lazyRoute,
  createLazyRoutes,
} from '../src/lazy'

// Mock component for testing
const MockComponent = () => null as any

describe('lazy', () => {
  it('should create a lazy component marked with __lazy', () => {
    const LazyComponent = lazy(() => Promise.resolve({ default: MockComponent }))

    expect((LazyComponent as any).__lazy).toBe(true)
  })

  it('exposes the shared preload/reset contract and legacy router markers', () => {
    const LazyComponent = lazy(() => Promise.resolve({ default: MockComponent }))

    expect(typeof LazyComponent.preload).toBe('function')
    expect(typeof LazyComponent.reset).toBe('function')
    expect(typeof (LazyComponent as any).__preload).toBe('function')
  })

  it('should cache the loaded component on preload', async () => {
    let loadCount = 0
    const loader = () => {
      loadCount++
      return Promise.resolve({ default: MockComponent })
    }

    const LazyComponent = lazy(loader)

    // First preload
    await LazyComponent.preload()
    expect(loadCount).toBe(1)

    // Second preload should use cache
    await LazyComponent.preload()
    expect(loadCount).toBe(1)
  })

  it('should handle direct component exports (without default)', async () => {
    const loader = () => Promise.resolve(MockComponent as any)

    const LazyComponent = lazy(loader)
    await LazyComponent.preload()

    expect(LazyComponent()).toEqual({ type: MockComponent, props: undefined })
  })

  it('normalizes synchronous loader failures and can retry after reset', async () => {
    const error = new Error('first load failed')
    const loader = vi
      .fn<() => Promise<{ default: typeof MockComponent }>>()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockResolvedValueOnce({ default: MockComponent })
    const LazyComponent = lazy(loader)

    let preload: Promise<void> | undefined
    expect(() => {
      preload = LazyComponent.preload()
    }).not.toThrow()
    await expect(preload).rejects.toBe(error)
    expect(() => LazyComponent()).toThrow(error)

    LazyComponent.reset()
    await expect(LazyComponent.preload()).resolves.toBeUndefined()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('supports the framework retry options', async () => {
    const loader = vi
      .fn<() => Promise<{ default: typeof MockComponent }>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ default: MockComponent })
    const LazyComponent = lazy(loader, { maxRetries: 1, retryDelay: 0 })

    await expect(LazyComponent.preload()).resolves.toBeUndefined()
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('preloadLazy', () => {
  it('should call __preload on lazy components', async () => {
    const preloadFn = vi.fn().mockResolvedValue(MockComponent)
    const lazyComp: any = () => null
    lazyComp.__lazy = true
    lazyComp.__preload = preloadFn

    expect(isLazyComponent(lazyComp)).toBe(false)
    await preloadLazy(lazyComp)

    expect(preloadFn).toHaveBeenCalledTimes(1)
  })

  it('preloads and recognizes lazy components created by fict/plus', async () => {
    const loader = vi.fn(() => Promise.resolve({ default: MockComponent }))
    const LazyComponent = frameworkLazy(loader)

    expect(isLazyComponent(LazyComponent)).toBe(true)
    await preloadLazy(LazyComponent)

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('recognizes the public preload/reset protocol without private markers', async () => {
    const preload = vi.fn().mockResolvedValue(undefined)
    const compatibleComponent: any = () => null
    compatibleComponent.preload = preload
    compatibleComponent.reset = () => {}

    expect(isLazyComponent(compatibleComponent)).toBe(true)
    await preloadLazy(compatibleComponent)
    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('retries a failed compatible lazy component without private markers', async () => {
    const failure = new Error('temporary compatible lazy failure')
    const loader = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    let cachedPreload: Promise<void> | undefined
    const compatibleComponent: any = () => null
    compatibleComponent.preload = vi.fn(() => (cachedPreload ??= loader()))
    compatibleComponent.reset = vi.fn(() => {
      cachedPreload = undefined
    })

    await expect(retryPreloadLazy(compatibleComponent)).rejects.toBe(failure)
    await expect(retryPreloadLazy(compatibleComponent)).resolves.toBeUndefined()

    expect(loader).toHaveBeenCalledTimes(2)
    expect(compatibleComponent.reset).toHaveBeenCalledTimes(1)
  })

  it('should return resolved promise for non-lazy components', async () => {
    const normalComponent = () => null

    const result = await preloadLazy(normalComponent as any)

    expect(result).toBeUndefined()
  })

  it('should return resolved promise for components without __preload', async () => {
    const lazyComp: any = () => null
    lazyComp.__lazy = true
    // No __preload

    const result = await preloadLazy(lazyComp)

    expect(result).toBeUndefined()
  })
})

describe('isLazyComponent', () => {
  it('should return true for lazy components', () => {
    const LazyComponent = lazy(() => Promise.resolve({ default: MockComponent }))

    expect(isLazyComponent(LazyComponent)).toBe(true)
  })

  it('should return false for normal components', () => {
    expect(isLazyComponent(MockComponent)).toBe(false)
  })

  it('should return false for non-function values', () => {
    expect(isLazyComponent(null)).toBe(false)
    expect(isLazyComponent(undefined)).toBe(false)
    expect(isLazyComponent('string')).toBe(false)
    expect(isLazyComponent(123)).toBe(false)
    expect(isLazyComponent({})).toBe(false)
  })
})

describe('lazyRoute', () => {
  it('should create a route definition with a lazy component', () => {
    const route = lazyRoute({
      path: '/users/:id',
      component: () => Promise.resolve({ default: MockComponent }),
    })

    expect(route.path).toBe('/users/:id')
    expect(route.component).toBeDefined()
    expect(isLazyComponent(route.component)).toBe(true)
  })

  it('should include optional properties when provided', () => {
    const loadingElement = 'Loading...' as any
    const errorElement = 'Error!' as any
    const preloadFn = vi.fn()
    const children = [{ path: '/child' }]

    const route = lazyRoute({
      path: '/test',
      component: () => Promise.resolve({ default: MockComponent }),
      loadingElement,
      errorElement,
      lazyOptions: { maxRetries: 2, retryDelay: 0 },
      preload: preloadFn,
      children,
      index: true,
      key: 'test-key',
    })

    expect(route.path).toBe('/test')
    expect(route.loadingElement).toBe(loadingElement)
    expect(route.errorElement).toBe(errorElement)
    expect(route.preload).toBe(preloadFn)
    expect(route.children).toBe(children)
    expect(route.index).toBe(true)
    expect(route.key).toBe('test-key')
  })

  it('should not include undefined optional properties', () => {
    const route = lazyRoute({
      component: () => Promise.resolve({ default: MockComponent }),
    })

    expect(route.component).toBeDefined()
    expect('path' in route).toBe(false)
    expect('loadingElement' in route).toBe(false)
    expect('errorElement' in route).toBe(false)
    expect('preload' in route).toBe(false)
    expect('children' in route).toBe(false)
    expect('index' in route).toBe(false)
    expect('key' in route).toBe(false)
  })

  it('passes retry options to the generated lazy route component', async () => {
    const loader = vi
      .fn<() => Promise<{ default: typeof MockComponent }>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ default: MockComponent })
    const route = lazyRoute({
      component: loader,
      lazyOptions: { maxRetries: 1, retryDelay: 0 },
    })

    await preloadLazy(route.component!)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('createLazyRoutes', () => {
  it('should create routes from module map', () => {
    const modules = {
      './pages/Home.tsx': () => Promise.resolve({ default: MockComponent }),
      './pages/About.tsx': () => Promise.resolve({ default: MockComponent }),
    }

    const routes = createLazyRoutes(modules)

    expect(routes).toHaveLength(2)
    expect(routes[0]!.path).toBe('/home')
    expect(routes[1]!.path).toBe('/about')
    routes.forEach(route => {
      expect(isLazyComponent(route.component)).toBe(true)
    })
  })

  it('should use custom pathTransform when provided', () => {
    const modules = {
      './pages/UserProfile.tsx': () => Promise.resolve({ default: MockComponent }),
    }

    const routes = createLazyRoutes(modules, {
      pathTransform: filePath => filePath.replace('./pages/', '/').replace('.tsx', ''),
    })

    expect(routes[0]!.path).toBe('/UserProfile')
  })

  it('should include loadingElement and errorElement when provided', () => {
    const modules = {
      './pages/Test.tsx': () => Promise.resolve({ default: MockComponent }),
    }
    const loadingElement = 'Loading...' as any
    const errorElement = 'Error!' as any

    const routes = createLazyRoutes(modules, { loadingElement, errorElement })

    expect(routes[0]!.loadingElement).toBe(loadingElement)
    expect(routes[0]!.errorElement).toBe(errorElement)
  })

  it('should handle different file extensions', () => {
    const modules = {
      './pages/One.ts': () => Promise.resolve({ default: MockComponent }),
      './pages/Two.jsx': () => Promise.resolve({ default: MockComponent }),
      './pages/Three.js': () => Promise.resolve({ default: MockComponent }),
    }

    const routes = createLazyRoutes(modules)

    expect(routes[0]!.path).toBe('/one')
    expect(routes[1]!.path).toBe('/two')
    expect(routes[2]!.path).toBe('/three')
  })
})
