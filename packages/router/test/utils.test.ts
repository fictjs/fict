import { describe, it, expect } from 'vitest'
import {
  normalizePath,
  joinPaths,
  resolvePath,
  parseURL,
  createURL,
  createLocation,
  parsePathPattern,
  createMatcher,
  scoreRoute,
  compileRoute,
  createBranches,
  matchRoutes,
  locationsAreEqual,
  hashQueryArgs,
  stripBasePath,
  prependBasePath,
} from '../src/utils'

describe('normalizePath', () => {
  it('should handle empty path', () => {
    expect(normalizePath('')).toBe('/')
  })

  it('should handle root path', () => {
    expect(normalizePath('/')).toBe('/')
  })

  it('should ensure leading slash', () => {
    expect(normalizePath('users')).toBe('/users')
    expect(normalizePath('users/123')).toBe('/users/123')
  })

  it('should remove trailing slash', () => {
    expect(normalizePath('/users/')).toBe('/users')
    expect(normalizePath('/users/123/')).toBe('/users/123')
  })

  it('should not remove trailing slash from root', () => {
    expect(normalizePath('/')).toBe('/')
  })
})

describe('joinPaths', () => {
  it('should join paths', () => {
    expect(joinPaths('/users', '123')).toBe('/users/123')
    expect(joinPaths('/users', '/123')).toBe('/users/123')
  })

  it('should handle empty segments', () => {
    expect(joinPaths('/users', '', '123')).toBe('/users/123')
    expect(joinPaths('', '/users')).toBe('/users')
  })

  it('should handle undefined segments', () => {
    expect(joinPaths('/users', undefined, '123')).toBe('/users/123')
  })
})

describe('base path utilities', () => {
  it('strips only an exact base or a complete path-segment prefix', () => {
    expect(stripBasePath('/app', '/app')).toBe('/')
    expect(stripBasePath('/app/', '/app/')).toBe('/')
    expect(stripBasePath('/app/child', 'app/')).toBe('/child')

    expect(stripBasePath('/apple', '/app')).toBe('/apple')
    expect(stripBasePath('/app2/child', '/app/')).toBe('/app2/child')
  })

  it('keeps base matching case-sensitive and does not decode separators', () => {
    expect(stripBasePath('/App/child', '/app')).toBe('/App/child')
    expect(stripBasePath('/app%2Fchild', '/app')).toBe('/app%2Fchild')
    expect(stripBasePath('/app/%2Fchild', '/app')).toBe('/%2Fchild')
  })

  it('prepends normalized root and trailing-slash bases', () => {
    expect(prependBasePath('/child', '')).toBe('/child')
    expect(prependBasePath('/child', '/')).toBe('/child')
    expect(prependBasePath('/', '/app/')).toBe('/app')
    expect(prependBasePath('/child', 'app/')).toBe('/app/child')
  })
})

describe('resolvePath', () => {
  it('should resolve absolute paths', () => {
    expect(resolvePath('/users/123', '/about')).toBe('/about')
  })

  it('should resolve relative paths', () => {
    expect(resolvePath('/users/123', 'edit')).toBe('/users/123/edit')
    expect(resolvePath('/users/123', './edit')).toBe('/users/123/edit')
  })

  it('should resolve parent paths', () => {
    expect(resolvePath('/users/123', '..')).toBe('/users')
    expect(resolvePath('/users/123', '../456')).toBe('/users/456')
    expect(resolvePath('/users/123/edit', '../..')).toBe('/users')
  })
})

describe('parseURL', () => {
  it('should parse simple pathname', () => {
    const result = parseURL('/users/123')
    expect(result.pathname).toBe('/users/123')
    expect(result.search).toBe('')
    expect(result.hash).toBe('')
  })

  it('should parse pathname with search', () => {
    const result = parseURL('/users?page=1')
    expect(result.pathname).toBe('/users')
    expect(result.search).toBe('?page=1')
    expect(result.hash).toBe('')
  })

  it('should parse pathname with hash', () => {
    const result = parseURL('/users#section')
    expect(result.pathname).toBe('/users')
    expect(result.search).toBe('')
    expect(result.hash).toBe('#section')
  })

  it('should parse pathname with search and hash', () => {
    const result = parseURL('/users?page=1#section')
    expect(result.pathname).toBe('/users')
    expect(result.search).toBe('?page=1')
    expect(result.hash).toBe('#section')
  })
})

describe('createURL', () => {
  it('should create URL from location', () => {
    expect(createURL({ pathname: '/users', search: '', hash: '' })).toBe('/users')
    expect(createURL({ pathname: '/users', search: '?page=1', hash: '' })).toBe('/users?page=1')
    expect(createURL({ pathname: '/users', search: '', hash: '#section' })).toBe('/users#section')
    expect(createURL({ pathname: '/users', search: '?page=1', hash: '#section' })).toBe(
      '/users?page=1#section',
    )
  })
})

describe('createLocation', () => {
  it('should create location from string', () => {
    const location = createLocation('/users/123')
    expect(location.pathname).toBe('/users/123')
    expect(location.search).toBe('')
    expect(location.hash).toBe('')
    expect(location.state).toBe(null)
    expect(location.key).toBeDefined()
  })

  it('should create location from object', () => {
    const location = createLocation({ pathname: '/users', search: '?page=1' })
    expect(location.pathname).toBe('/users')
    expect(location.search).toBe('?page=1')
    expect(location.hash).toBe('')
  })

  it('should include state', () => {
    const state = { from: '/home' }
    const location = createLocation('/users', state)
    expect(location.state).toBe(state)
  })
})

describe('hashQueryArgs', () => {
  it('keeps structural value semantics for supported built-in containers', () => {
    const first = [
      new Date('2026-07-11T00:00:00.000Z'),
      /fict/gi,
      new Map<string, number>([
        ['b', 2],
        ['a', 1],
      ]),
      new Set(['b', 'a']),
    ]
    const second = [
      new Date('2026-07-11T00:00:00.000Z'),
      /fict/gi,
      new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]),
      new Set(['a', 'b']),
    ]

    expect(hashQueryArgs(first)).toBe(hashQueryArgs(second))
  })

  it('keeps circular plain objects structural and deterministic', () => {
    interface CircularValue {
      id: string
      nested: { enabled: boolean }
      self?: CircularValue
    }

    const first: CircularValue = { id: 'same', nested: { enabled: true } }
    first.self = first
    const second: CircularValue = { nested: { enabled: true }, id: 'same' }
    second.self = second

    expect(hashQueryArgs([first])).toBe(hashQueryArgs([second]))
  })

  it('preserves opaque object identity when nested in plain structures', () => {
    class OpaqueKey {
      constructor(readonly label: string) {}
    }

    const first = new OpaqueKey('same')
    const second = new OpaqueKey('same')

    expect(hashQueryArgs([{ nested: [first] }])).toBe(hashQueryArgs([{ nested: [first] }]))
    expect(hashQueryArgs([{ nested: [first] }])).not.toBe(hashQueryArgs([{ nested: [second] }]))
  })
})

describe('createMatcher', () => {
  it('should match static paths', () => {
    const matcher = createMatcher('/users')
    expect(matcher('/users')).toBeTruthy()
    expect(matcher('/about')).toBe(null)
  })

  it('should match dynamic segments', () => {
    const matcher = createMatcher('/users/:id')
    const match = matcher('/users/123')
    expect(match).toBeTruthy()
    expect(match?.params.id).toBe('123')
  })

  it('should not throw for malformed encoded parameters', () => {
    const dynamicMatcher = createMatcher('/users/:id')
    const optionalMatcher = createMatcher('/users/:id?')

    expect(dynamicMatcher('/users/%')?.params.id).toBe('%')
    expect(optionalMatcher('/users/%E0%A4%A')?.params.id).toBe('%E0%A4%A')
  })

  it('should match optional segments', () => {
    const matcher = createMatcher('/users/:id?')
    expect(matcher('/users')).toBeTruthy()
    expect(matcher('/users/123')?.params.id).toBe('123')
  })

  it('should match splat segments', () => {
    const matcher = createMatcher('/files/*path')
    const match = matcher('/files/docs/readme.md')
    expect(match).toBeTruthy()
    expect(match?.params.path).toBe('docs/readme.md')
  })

  it('should decode URI components', () => {
    const matcher = createMatcher('/users/:name')
    const match = matcher('/users/John%20Doe')
    expect(match?.params.name).toBe('John Doe')
  })

  it('should validate with match filters', () => {
    const matcher = createMatcher('/users/:id', { id: /^\d+$/ })
    expect(matcher('/users/123')).toBeTruthy()
    expect(matcher('/users/abc')).toBe(null)
  })

  it('should make stateful regular-expression filters deterministic', () => {
    const filter = /^\d+$/g
    const matcher = createMatcher('/users/:id', { id: filter })

    expect(matcher('/users/42')?.params.id).toBe('42')
    expect(matcher('/users/42')?.params.id).toBe('42')
    expect(filter.lastIndex).toBe(0)
  })

  it('should validate with array filter', () => {
    const matcher = createMatcher('/status/:code', { code: ['active', 'inactive'] })
    expect(matcher('/status/active')).toBeTruthy()
    expect(matcher('/status/pending')).toBe(null)
  })

  it('should validate with function filter', () => {
    const matcher = createMatcher('/items/:id', { id: v => v.length > 2 })
    expect(matcher('/items/abc')).toBeTruthy()
    expect(matcher('/items/ab')).toBe(null)
  })
})

describe('scoreRoute', () => {
  it('should score static segments higher', () => {
    expect(scoreRoute('/users')).toBe(3)
    expect(scoreRoute('/users/:id')).toBe(5) // 3 + 2
    expect(scoreRoute('/users/:id?')).toBe(4) // 3 + 1
    expect(scoreRoute('/files/*')).toBe(3.5) // 3 for "files" + 0.5 for splat
    expect(scoreRoute('/*')).toBe(0.5) // Just the splat
  })

  it('should give index routes a bonus', () => {
    expect(scoreRoute('/', true)).toBe(0.5)
    expect(scoreRoute('/users', true)).toBe(3.5)
  })
})

describe('matchRoutes', () => {
  it('should match simple routes', () => {
    const routes = [
      compileRoute({ path: '/', component: () => null }),
      compileRoute({ path: '/users', component: () => null }),
      compileRoute({ path: '/about', component: () => null }),
    ]
    const branches = createBranches(routes)

    const matches = matchRoutes(branches, '/users')
    expect(matches).toBeTruthy()
    expect(matches?.length).toBe(1)
    expect(matches?.[0]?.pattern).toBe('/users')
  })

  it('should prefer more specific routes', () => {
    const routes = [
      compileRoute({ path: '/users/:id', component: () => null }),
      compileRoute({ path: '/users/new', component: () => null }),
    ]
    const branches = createBranches(routes)

    // /users/new should match the more specific route
    const matches = matchRoutes(branches, '/users/new')
    expect(matches?.[0]?.pattern).toBe('/users/new')

    // /users/123 should match the dynamic route
    const matches2 = matchRoutes(branches, '/users/123')
    expect(matches2?.[0]?.pattern).toBe('/users/:id')
    expect(matches2?.[0]?.params.id).toBe('123')
  })

  it('prefers a static route over a nested dynamic branch with the same pathname depth', () => {
    const routes = [
      compileRoute({
        path: '/users',
        component: () => null,
        children: [{ path: ':id', component: () => null }],
      }),
      compileRoute({ path: '/users/new', component: () => null }),
    ]
    const branches = createBranches(routes)

    expect(branches.map(branch => branch.score)).toEqual([6, 5])
    const matches = matchRoutes(branches, '/users/new')

    expect(matches).toHaveLength(1)
    expect(matches?.[0]?.pattern).toBe('/users/new')
    expect(matches?.[0]?.params).toEqual({})
  })

  it('should match nested branches against the complete pathname', () => {
    const routes = [
      compileRoute({
        path: '/users',
        component: () => null,
        children: [
          {
            path: ':userId',
            component: () => null,
            children: [{ path: 'posts/:postId', component: () => null }],
          },
        ],
      }),
    ]
    const branches = createBranches(routes)

    const matches = matchRoutes(branches, '/users/42/posts/7')

    expect(matches?.map(match => match.pattern)).toEqual([
      '/users',
      '/users/:userId',
      '/users/:userId/posts/:postId',
    ])
    expect(matches?.[0]?.params).toEqual({})
    expect(matches?.[1]?.params).toEqual({ userId: '42' })
    expect(matches?.[2]?.params).toEqual({ userId: '42', postId: '7' })
  })

  it('should match nested index routes at the parent pathname', () => {
    const routes = [
      compileRoute({
        path: '/users',
        component: () => null,
        children: [{ index: true, component: () => null }],
      }),
    ]
    const branches = createBranches(routes)

    const matches = matchRoutes(branches, '/users')

    expect(matches).toHaveLength(2)
    expect(matches?.map(match => match.pathname)).toEqual(['/users', '/users'])
  })

  it('should preserve optional parent parameter consumption from the leaf match', () => {
    const routes = [
      compileRoute({
        path: '/users/:userId?',
        component: () => null,
        children: [{ path: 'settings', component: () => null }],
      }),
    ]
    const branches = createBranches(routes)

    const withoutOptional = matchRoutes(branches, '/users/settings')
    const withOptional = matchRoutes(branches, '/users/42/settings')

    expect(withoutOptional?.[0]?.pathname).toBe('/users')
    expect(withoutOptional?.[0]?.params).toEqual({})
    expect(withOptional?.[0]?.pathname).toBe('/users/42')
    expect(withOptional?.[0]?.params).toEqual({ userId: '42' })
  })

  it('should return null for no match', () => {
    const routes = [compileRoute({ path: '/users', component: () => null })]
    const branches = createBranches(routes)

    expect(matchRoutes(branches, '/about')).toBe(null)
  })
})

describe('locationsAreEqual', () => {
  it('should compare locations', () => {
    const loc1 = createLocation('/users?page=1#section')
    const loc2 = createLocation('/users?page=1#section')
    const loc3 = createLocation('/users?page=2#section')

    expect(locationsAreEqual(loc1, loc2)).toBe(true)
    expect(locationsAreEqual(loc1, loc3)).toBe(false)
  })
})
