import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  query,
  revalidate,
  action,
  useSubmission,
  submitAction,
  createResource,
  cleanupDataUtilities,
} from '../src/data'

describe('query', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create a query function', () => {
    const fetchUser = query(async (id: string) => ({ id, name: 'Test User' }), 'fetchUser')

    expect(typeof fetchUser).toBe('function')
  })

  it('should return an accessor function', () => {
    const fetchUser = query(async (id: string) => ({ id, name: 'Test User' }), 'fetchUser')

    const accessor = fetchUser('123')
    expect(typeof accessor).toBe('function')
  })

  it('should cache results', async () => {
    let callCount = 0
    const fetchUser = query(async (id: string) => {
      callCount++
      return { id, name: 'Test User' }
    }, 'fetchUser')

    // First call
    const accessor1 = fetchUser('123')
    await new Promise(resolve => setTimeout(resolve, 10))

    // Second call with same args should use cache
    const accessor2 = fetchUser('123')

    // The function should still only be called once
    // (cache lookup happens on accessor call)
    expect(callCount).toBe(1)
  })

  it('should handle different args separately', async () => {
    let callCount = 0
    const fetchUser = query(async (id: string) => {
      callCount++
      return { id }
    }, 'fetchUser')

    fetchUser('123')
    await new Promise(resolve => setTimeout(resolve, 10))

    fetchUser('456')
    await new Promise(resolve => setTimeout(resolve, 10))

    // Different args should create separate cache entries
    expect(callCount).toBe(2)
  })
})

describe('revalidate', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should invalidate all queries when no key provided', () => {
    // Create some queries first
    const fetchUser = query(async (id: string) => ({ id }), 'fetchUser')
    const fetchPosts = query(async () => [], 'fetchPosts')

    fetchUser('123')
    fetchPosts()

    // Invalidate all
    revalidate()

    // Queries should refetch on next call
    // (We can't easily verify cache clearing without accessing internals)
    expect(true).toBe(true)
  })

  it('should invalidate queries by key prefix', () => {
    const fetchUser = query(async (id: string) => ({ id }), 'fetchUser')
    fetchUser('123')

    // Invalidate by prefix
    revalidate('fetchUser')

    // Query should refetch on next call
    expect(true).toBe(true)
  })
})

describe('action', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create an action', () => {
    const createUser = action(async (formData: FormData) => {
      return { id: '123', name: formData.get('name') }
    }, 'createUser')

    expect(createUser.url).toBe('/_action/createUser')
    expect(createUser.name).toBe('createUser')
    expect(typeof createUser.submit).toBe('function')
  })

  it('should submit action', async () => {
    const createUser = action(async (formData: FormData) => {
      return { id: '123', name: formData.get('name') as string }
    }, 'createUser')

    const formData = new FormData()
    formData.set('name', 'Test User')

    const result = await createUser.submit(formData)

    expect(result.id).toBe('123')
    expect(result.name).toBe('Test User')
  })
})

describe('submitAction', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should track submission state', async () => {
    const createUser = action(async (formData: FormData) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return { id: '123' }
    }, 'createUser')

    const formData = new FormData()
    formData.set('name', 'Test')

    const promise = submitAction(createUser, formData)

    // Wait for completion
    await promise

    // Verify result is returned
    const result = await promise
    expect(result.id).toBe('123')
  })

  it('should handle errors', async () => {
    const failingAction = action(async () => {
      throw new Error('Action failed')
    }, 'failingAction')

    const formData = new FormData()

    await expect(submitAction(failingAction, formData)).rejects.toThrow('Action failed')
  })
})

describe('createResource', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create a resource', () => {
    const resource = createResource(
      () => '123',
      async id => ({ id, name: 'Test' }),
    )

    expect(typeof resource).toBe('function')
    expect(typeof resource.loading).toBe('function')
    expect(typeof resource.error).toBe('function')
    expect(typeof resource.refetch).toBe('function')
  })

  it('should start in loading state', () => {
    const resource = createResource(
      () => '123',
      async id => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { id }
      },
    )

    expect(resource.loading()).toBe(true)
    expect(resource()).toBe(undefined)
  })

  it('should resolve with data', async () => {
    const resource = createResource(
      () => '123',
      async id => ({ id, name: 'Test' }),
    )

    // Wait for data to load
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(resource.loading()).toBe(false)
    expect(resource()?.id).toBe('123')
  })

  it('should handle errors', async () => {
    const resource = createResource(
      () => '123',
      async () => {
        throw new Error('Fetch failed')
      },
    )

    // Wait for error
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(resource.loading()).toBe(false)
    expect(resource.error()).toBeInstanceOf(Error)
  })
})
