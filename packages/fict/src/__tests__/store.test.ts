import { createEffect } from 'fict-runtime'
import { describe, it, expect, vi } from 'vitest'

import { $store } from '../store'

describe('$store', () => {
  it('should be reactive for direct properties', () => {
    const state = $store({ count: 0 })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.count)
    })

    expect(fn).toHaveBeenCalledWith(0)
    expect(fn).toHaveBeenCalledTimes(1)

    state.count++
    expect(fn).toHaveBeenCalledWith(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should be reactive for nested objects', () => {
    const state = $store({ user: { name: 'Alice' } })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.user.name)
    })

    expect(fn).toHaveBeenCalledWith('Alice')

    state.user.name = 'Bob'
    expect(fn).toHaveBeenCalledWith('Bob')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should handle array mutations', () => {
    const state = $store({ list: [1, 2, 3] })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.list[0])
    })

    expect(fn).toHaveBeenCalledWith(1)

    state.list[0] = 10
    expect(fn).toHaveBeenCalledWith(10)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should handle adding new properties', () => {
    const state = $store<any>({})
    const fn = vi.fn()

    // Reading a non-existent property should still track it if we access it
    createEffect(() => {
      fn(state.foo)
    })

    expect(fn).toHaveBeenCalledWith(undefined)

    state.foo = 'bar'
    expect(fn).toHaveBeenCalledWith('bar')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  describe('Method binding and cache invalidation', () => {
    it('should invalidate bound method cache when method is reassigned', () => {
      const state = $store({
        value: 'original',
        getValue() {
          return this.value
        },
      })

      // First call caches the bound method
      const result1 = state.getValue()
      expect(result1).toBe('original')

      // Reassign the method
      state.getValue = function () {
        return 'updated'
      }

      // Should return the new method's result, not cached old one
      const result2 = state.getValue()
      expect(result2).toBe('updated')
    })

    it('should handle method reassignment with state references', () => {
      const state = $store({
        counter: 0,
        increment() {
          this.counter++
          return this.counter
        },
      })

      expect(state.increment()).toBe(1)
      expect(state.counter).toBe(1)

      // Reassign to increment by 10
      state.increment = function () {
        this.counter += 10
        return this.counter
      }

      expect(state.increment()).toBe(11)
      expect(state.counter).toBe(11)
    })

    it('should invalidate cache on method delete and recreate', () => {
      const state = $store<any>({
        fn() {
          return 'first'
        },
      })

      // Cache the method
      expect(state.fn()).toBe('first')

      // Delete and recreate
      delete state.fn
      state.fn = () => 'second'

      expect(state.fn()).toBe('second')
    })

    it('should maintain correct this binding after reassignment', () => {
      const state = $store({
        name: 'Alice',
        greet() {
          return `Hello, ${this.name}`
        },
      })

      expect(state.greet()).toBe('Hello, Alice')

      state.greet = function () {
        return `Hi, ${this.name}!`
      }

      expect(state.greet()).toBe('Hi, Alice!')

      // Verify this binding still works
      state.name = 'Bob'
      expect(state.greet()).toBe('Hi, Bob!')
    })

    it('should return new method after reassignment when called from effect', () => {
      const state = $store<any>({
        value: 'a',
        fn() {
          return this.value
        },
      })
      const results: string[] = []

      createEffect(() => {
        // Accessing state.fn tracks the 'fn' property
        // When fn is reassigned, the effect will re-run
        results.push(state.fn())
      })

      expect(results).toEqual(['a'])

      // Reassign the method - this will trigger effect re-run
      // because accessing state.fn tracks the fn property's signal
      state.fn = function () {
        return this.value + '!'
      }

      // Effect re-runs immediately with new method
      expect(results).toEqual(['a', 'a!'])

      // Change a tracked property to trigger effect again
      state.value = 'b'

      // Effect re-runs again
      expect(results).toEqual(['a', 'a!', 'b!'])
    })
  })
})
