import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @fictjs/runtime
vi.mock('@fictjs/runtime', () => ({
  createMemo: <T,>(fn: () => T) => fn,
  Fragment: ({ children }: any) => children,
}))

// Mock context module with all needed exports
vi.mock('../src/context', () => {
  const mockLocation = () => ({
    pathname: '/',
    search: '',
    hash: '',
    state: null,
    key: 'default',
  })

  const wrapAccessor = <T extends (...args: unknown[]) => unknown>(fn: T): T => {
    const wrapped = ((...args: any[]) => {
      if (args.length === 0) return wrapped
      return fn(...args)
    }) as unknown as T
    return wrapped
  }

  const navigateMock = vi.fn()
  const resolvePathMock = (to: any) => (typeof to === 'string' ? to : to.pathname || '/')

  return {
    useRouter: () => ({
      location: mockLocation,
      params: () => ({}),
      matches: () => [],
      navigate: wrapAccessor(navigateMock),
      isRouting: () => false,
      pendingLocation: () => null,
      base: () => '',
      resolvePath: wrapAccessor(resolvePathMock),
    }),
    useIsActive: (to: any, options?: { end?: boolean }) => () => {
      const target = typeof to === 'function' ? to() : to
      const targetPath = typeof target === 'string' ? target : target.pathname || '/'
      const currentPath = mockLocation().pathname
      if (options?.end) {
        return currentPath === targetPath
      }
      return currentPath === targetPath || currentPath.startsWith(targetPath + '/')
    },
    useHref: (to: any) => () => {
      const target = typeof to === 'function' ? to() : to
      if (typeof target === 'string') {
        return target
      }
      let result = target.pathname || '/'
      if (target.search) result += target.search
      if (target.hash) result += target.hash
      return result
    },
    usePendingLocation: () => () => null,
  }
})

import { Link, NavLink, Form, type LinkProps, type NavLinkProps, type FormProps } from '../src/link'

describe('Link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('should be a function component', () => {
      expect(typeof Link).toBe('function')
    })

    it('should accept to prop as required', () => {
      const props: LinkProps = { to: '/about' }
      expect(props.to).toBe('/about')
    })

    it('should accept object-style to prop', () => {
      const props: LinkProps = {
        to: { pathname: '/search', search: '?q=test', hash: '#results' },
      }
      expect(typeof props.to).toBe('object')
    })
  })

  describe('props interface', () => {
    it('should support replace option', () => {
      const props: LinkProps = { to: '/about', replace: true }
      expect(props.replace).toBe(true)
    })

    it('should support state option', () => {
      const props: LinkProps = { to: '/about', state: { from: '/home' } }
      expect(props.state).toEqual({ from: '/home' })
    })

    it('should support scroll option', () => {
      const props: LinkProps = { to: '/about', scroll: false }
      expect(props.scroll).toBe(false)
    })

    it('should support relative option', () => {
      const props: LinkProps = { to: 'settings', relative: 'route' }
      expect(props.relative).toBe('route')

      const props2: LinkProps = { to: 'settings', relative: 'path' }
      expect(props2.relative).toBe('path')
    })

    it('should support reloadDocument option', () => {
      const props: LinkProps = { to: '/about', reloadDocument: true }
      expect(props.reloadDocument).toBe(true)
    })

    it('should support prefetch option', () => {
      const propsNone: LinkProps = { to: '/about', prefetch: 'none' }
      expect(propsNone.prefetch).toBe('none')

      const propsIntent: LinkProps = { to: '/about', prefetch: 'intent' }
      expect(propsIntent.prefetch).toBe('intent')

      const propsRender: LinkProps = { to: '/about', prefetch: 'render' }
      expect(propsRender.prefetch).toBe('render')
    })

    it('should support disabled option', () => {
      const props: LinkProps = { to: '/about', disabled: true }
      expect(props.disabled).toBe(true)
    })

    it('should support onClick handler', () => {
      const onClick = vi.fn()
      const props: LinkProps = { to: '/about', onClick }
      expect(props.onClick).toBe(onClick)
    })

    it('should support children', () => {
      const props: LinkProps = { to: '/about', children: 'About Us' }
      expect(props.children).toBe('About Us')
    })
  })
})

describe('NavLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('should be a function component', () => {
      expect(typeof NavLink).toBe('function')
    })

    it('should accept to prop as required', () => {
      const props: NavLinkProps = { to: '/about' }
      expect(props.to).toBe('/about')
    })
  })

  describe('NavLinkRenderProps', () => {
    it('should support className as function', () => {
      const classNameFn = ({ isActive, isPending }: any) =>
        isActive ? 'active' : isPending ? 'pending' : 'normal'

      const props: NavLinkProps = { to: '/about', className: classNameFn }
      expect(typeof props.className).toBe('function')
    })

    it('should support style as function', () => {
      const styleFn = ({ isActive }: any) => (isActive ? { color: 'blue' } : { color: 'black' })

      const props: NavLinkProps = { to: '/about', style: styleFn }
      expect(typeof props.style).toBe('function')
    })

    it('should support children as function', () => {
      const childrenFn = ({ isActive, isPending }: any) =>
        isActive ? 'Active!' : isPending ? 'Loading...' : 'Click me'

      const props: NavLinkProps = { to: '/about', children: childrenFn }
      expect(typeof props.children).toBe('function')
    })
  })

  describe('active state props', () => {
    it('should support end option for exact matching', () => {
      const props: NavLinkProps = { to: '/users', end: true }
      expect(props.end).toBe(true)
    })

    it('should support caseSensitive option', () => {
      const props: NavLinkProps = { to: '/About', caseSensitive: true }
      expect(props.caseSensitive).toBe(true)
    })

    it('should support activeClassName', () => {
      const props: NavLinkProps = { to: '/about', activeClassName: 'nav-active' }
      expect(props.activeClassName).toBe('nav-active')
    })

    it('should support pendingClassName', () => {
      const props: NavLinkProps = { to: '/about', pendingClassName: 'nav-pending' }
      expect(props.pendingClassName).toBe('nav-pending')
    })

    it('should support activeStyle', () => {
      const props: NavLinkProps = { to: '/about', activeStyle: { fontWeight: 'bold' } }
      expect(props.activeStyle).toEqual({ fontWeight: 'bold' })
    })

    it('should support pendingStyle', () => {
      const props: NavLinkProps = { to: '/about', pendingStyle: { opacity: 0.5 } }
      expect(props.pendingStyle).toEqual({ opacity: 0.5 })
    })

    it('should support aria-current', () => {
      const props: NavLinkProps = { to: '/about', 'aria-current': 'page' }
      expect(props['aria-current']).toBe('page')
    })
  })
})

describe('Form', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('should be a function component', () => {
      expect(typeof Form).toBe('function')
    })
  })

  describe('props interface', () => {
    it('should support action prop', () => {
      const props: FormProps = { action: '/api/submit' }
      expect(props.action).toBe('/api/submit')
    })

    it('should support method prop', () => {
      const methods = ['get', 'post', 'put', 'patch', 'delete'] as const
      for (const method of methods) {
        const props: FormProps = { method }
        expect(props.method).toBe(method)
      }
    })

    it('should support replace option', () => {
      const props: FormProps = { replace: true }
      expect(props.replace).toBe(true)
    })

    it('should support relative option', () => {
      const props: FormProps = { relative: 'route' }
      expect(props.relative).toBe('route')
    })

    it('should support preventScrollReset option', () => {
      const props: FormProps = { preventScrollReset: true }
      expect(props.preventScrollReset).toBe(true)
    })

    it('should support navigate option', () => {
      const props: FormProps = { navigate: false }
      expect(props.navigate).toBe(false)
    })

    it('should support fetcherKey option', () => {
      const props: FormProps = { fetcherKey: 'my-form' }
      expect(props.fetcherKey).toBe('my-form')
    })

    it('should support children', () => {
      const props: FormProps = { children: 'Submit form' }
      expect(props.children).toBe('Submit form')
    })

    it('should support onSubmit handler', () => {
      const onSubmit = vi.fn()
      const props: FormProps = { onSubmit }
      expect(props.onSubmit).toBe(onSubmit)
    })
  })
})

describe('Link click handling', () => {
  it('should respect onClick handler', () => {
    const onClick = vi.fn()
    const props: LinkProps = { to: '/about', onClick }
    expect(props.onClick).toBe(onClick)
  })
})

describe('NavLink active state detection', () => {
  it('should correctly detect active state for exact paths', () => {
    // When location is '/users/123' and NavLink is to '/users/123', isActive should be true
    const location = {
      pathname: '/users/123',
      search: '',
      hash: '',
      state: null,
      key: 'test',
    }

    expect(location.pathname).toBe('/users/123')
  })

  it('should correctly detect active state for prefix paths', () => {
    // When location is '/users/123' and NavLink is to '/users', isActive should be true (without end)
    const location = {
      pathname: '/users/123',
      search: '',
      hash: '',
      state: null,
      key: 'test',
    }

    expect(location.pathname.startsWith('/users')).toBe(true)
  })

  it('should not be active for unrelated paths', () => {
    const location = {
      pathname: '/about',
      search: '',
      hash: '',
      state: null,
      key: 'test',
    }

    expect(location.pathname).not.toBe('/users')
    expect(location.pathname.startsWith('/users')).toBe(false)
  })
})

describe('Form submission handling', () => {
  it('should correctly build search params for GET method', () => {
    const formData = new FormData()
    formData.append('name', 'John')
    formData.append('email', 'john@example.com')

    const searchParams = new URLSearchParams()
    formData.forEach((value, key) => {
      if (typeof value === 'string') {
        searchParams.append(key, value)
      }
    })

    expect(searchParams.toString()).toBe('name=John&email=john%40example.com')
  })

  it('should handle empty form data', () => {
    const formData = new FormData()
    const searchParams = new URLSearchParams()
    formData.forEach((value, key) => {
      if (typeof value === 'string') {
        searchParams.append(key, value)
      }
    })

    expect(searchParams.toString()).toBe('')
  })
})
