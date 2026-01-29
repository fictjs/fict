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
