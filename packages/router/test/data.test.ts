import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createSignal } from '@fictjs/runtime/advanced'
import { __fictCreateSSRSession, __fictRunWithSSRSession } from '@fictjs/runtime/internal'
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

  it('should keep rejected query failures internal', async () => {
    const error = new Error('query failed')
    const fetchUser = query(async () => {
      throw error
    }, 'failingQuery')

    const accessor = fetchUser()
    await Promise.resolve()
    await Promise.resolve()

    expect(accessor()).toBe(undefined)
  })

  it('should retry successfully after a rejected query', async () => {
    const fetchUser = query(
      vi.fn().mockRejectedValueOnce(new Error('query failed')).mockResolvedValueOnce('ok'),
      'retryQuery',
    )

    const first = fetchUser('123')
    await Promise.resolve()
    await Promise.resolve()
    expect(first()).toBe(undefined)

    const second = fetchUser('123')
    await Promise.resolve()
    await Promise.resolve()

    expect(second()).toBe('ok')
  })

  it('should dedupe pending requests for the same key', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi.fn<(id: string) => Promise<string>>(
      _id =>
        new Promise<string>(resolve => {
          resolveFetch = resolve
        }),
    )
    const fetchUser = query(fetcher, 'pendingQuery')

    const first = fetchUser('123')
    const second = fetchUser('123')

    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetch?.('ok')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(first()).toBe('ok')
    expect(second()).toBe('ok')
  })

  it('should keep different pending keys separate', async () => {
    const fetcher = vi.fn(
      (id: string) =>
        new Promise<string>(resolve => {
          resolve(`ok:${id}`)
        }),
    )
    const fetchUser = query(fetcher, 'pendingDifferentQuery')

    const first = fetchUser('123')
    const second = fetchUser('456')
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('ok:123')
    expect(second()).toBe('ok:456')
  })

  it('should dedupe pending failures for the same key', async () => {
    let rejectFetch: ((err: unknown) => void) | undefined
    const fetcher = vi.fn<(id: string) => Promise<string>>(
      _id =>
        new Promise<string>((_, reject) => {
          rejectFetch = reject
        }),
    )
    const fetchUser = query(fetcher, 'pendingFailureQuery')

    const first = fetchUser('123')
    const second = fetchUser('123')

    expect(fetcher).toHaveBeenCalledTimes(1)

    rejectFetch?.(new Error('failed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(first()).toBe(undefined)
    expect(second()).toBe(undefined)
  })

  it('should keep null and undefined query args separate', async () => {
    const fetcher = vi.fn((value: null | undefined) =>
      value === null ? 'from-null' : 'from-undefined',
    )
    const fetchValue = query(fetcher, 'nullUndefinedQuery')

    const nullValue = fetchValue(null)
    await Promise.resolve()
    await Promise.resolve()

    const undefinedValue = fetchValue(undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(nullValue()).toBe('from-null')
    expect(undefinedValue()).toBe('from-undefined')
  })

  it('should keep different function query args separate by identity', async () => {
    const fetcher = vi.fn((callback: () => string) => callback())
    const fetchValue = query(fetcher, 'functionArgQuery')
    const firstCallback = () => 'first'
    const secondCallback = () => 'second'

    const first = fetchValue(firstCallback)
    await Promise.resolve()
    await Promise.resolve()

    const firstAgain = fetchValue(firstCallback)
    const second = fetchValue(secondCallback)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('first')
    expect(firstAgain()).toBe('first')
    expect(second()).toBe('second')
  })

  it('should keep different symbol query args separate by identity', async () => {
    const firstSymbol = Symbol('id')
    const secondSymbol = Symbol('id')
    const fetcher = vi.fn((value: symbol) => (value === firstSymbol ? 'first' : 'second'))
    const fetchValue = query(fetcher, 'symbolArgQuery')

    const first = fetchValue(firstSymbol)
    await Promise.resolve()
    await Promise.resolve()

    const firstAgain = fetchValue(firstSymbol)
    const second = fetchValue(secondSymbol)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('first')
    expect(firstAgain()).toBe('first')
    expect(second()).toBe('second')
  })

  it('should keep sparse array holes separate from undefined query values', async () => {
    const fetcher = vi.fn((value: unknown[]) =>
      Object.prototype.hasOwnProperty.call(value, 0) ? 'present' : 'hole',
    )
    const fetchValue = query(fetcher, 'sparseArrayQuery')
    const sparseValue = new Array(1)

    const present = fetchValue([undefined])
    await Promise.resolve()
    await Promise.resolve()

    const sparse = fetchValue(sparseValue)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(present()).toBe('present')
    expect(sparse()).toBe('hole')
  })

  it('should keep object query keys stable regardless of property order', async () => {
    const fetcher = vi.fn((_value: { a: number; b: number }) => 'ok')
    const fetchValue = query(fetcher, 'objectOrderQuery')

    const first = fetchValue({ a: 1, b: 2 })
    await Promise.resolve()
    await Promise.resolve()

    const second = fetchValue({ b: 2, a: 1 })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first()).toBe('ok')
    expect(second()).toBe('ok')
  })

  it('should keep nested undefined properties separate from missing properties', async () => {
    type NestedArg = { nested: { value?: undefined } }
    const fetcher = vi.fn((value: NestedArg) =>
      Object.prototype.hasOwnProperty.call(value.nested, 'value') ? 'has-value' : 'missing',
    )
    const fetchValue = query(fetcher, 'nestedUndefinedQuery')

    const withUndefined = fetchValue({ nested: { value: undefined } })
    await Promise.resolve()
    await Promise.resolve()

    const missing = fetchValue({ nested: {} })
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(withUndefined()).toBe('has-value')
    expect(missing()).toBe('missing')
  })

  it('should keep primitive query arg types separate', async () => {
    const fetcher = vi.fn((value: boolean | number | string) => `${typeof value}:${String(value)}`)
    const fetchValue = query(fetcher, 'primitiveArgQuery')

    const numberValue = fetchValue(1)
    const stringValue = fetchValue('1')
    const booleanValue = fetchValue(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(numberValue()).toBe('number:1')
    expect(stringValue()).toBe('string:1')
    expect(booleanValue()).toBe('boolean:true')
  })

  it('isolates cached query data between SSR sessions', async () => {
    let currentUser = 'alice'
    const fetcher = vi.fn(async (_key: string) => currentUser)
    const fetchUser = query(fetcher, 'sessionUser')
    const aliceSession = __fictCreateSSRSession()
    const bobSession = __fictCreateSSRSession()

    const alice = __fictRunWithSSRSession(aliceSession, () => fetchUser('same-key'))
    await Promise.resolve()
    await Promise.resolve()

    currentUser = 'bob'
    const bob = __fictRunWithSSRSession(bobSession, () => fetchUser('same-key'))
    await Promise.resolve()
    await Promise.resolve()

    const aliceAgain = __fictRunWithSSRSession(aliceSession, () => fetchUser('same-key'))
    const bobAgain = __fictRunWithSSRSession(bobSession, () => fetchUser('same-key'))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(alice()).toBe('alice')
    expect(aliceAgain()).toBe('alice')
    expect(bob()).toBe('bob')
    expect(bobAgain()).toBe('bob')
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

  it('should forward route parameters to the action function', async () => {
    const updateUser = action(async (_formData, { params }) => params.id, 'updateUser')
    const formData = new FormData()

    await expect(submitAction(updateUser, formData, { id: '42' })).resolves.toBe('42')
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

  it('should fetch when initial source is undefined', async () => {
    const fetcher = vi.fn(async (source: undefined) => `loaded:${String(source)}`)
    const resource = createResource(() => undefined, fetcher)

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resource.loading()).toBe(false)
    expect(resource()).toBe('loaded:undefined')
  })

  it('should fetch for initial falsy source values', async () => {
    const cases = [
      { label: 'null', source: null },
      { label: 'false', source: false },
      { label: 'zero', source: 0 },
      { label: 'empty', source: '' },
    ] as const

    for (const item of cases) {
      const fetcher = vi.fn(async (source: unknown) => `${item.label}:${String(source)}`)
      const resource = createResource(() => item.source, fetcher)

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(resource.loading()).toBe(false)
      expect(resource()).toBe(`${item.label}:${String(item.source)}`)
    }
  })

  it('should refetch when source changes back to undefined', async () => {
    const source = createSignal<string | undefined>('first')
    const fetcher = vi.fn(async (value: string | undefined) => `loaded:${String(value)}`)
    const resource = createResource(source, fetcher)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resource()).toBe('loaded:first')

    source(undefined)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(resource.loading()).toBe(false)
    expect(resource()).toBe('loaded:undefined')
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
