import { createEffect } from 'fict-runtime'
import { describe, it, expect, vi } from 'vitest'

import { $store } from '../store'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('$store', () => {
  it('should be reactive for direct properties', async () => {
    const state = $store({ count: 0 })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.count)
    })

    expect(fn).toHaveBeenCalledWith(0)
    expect(fn).toHaveBeenCalledTimes(1)

    state.count++
    await tick()
    expect(fn).toHaveBeenCalledWith(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should be reactive for nested objects', async () => {
    const state = $store({ user: { name: 'Alice' } })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.user.name)
    })

    expect(fn).toHaveBeenCalledWith('Alice')

    state.user.name = 'Bob'
    await tick()
    expect(fn).toHaveBeenCalledWith('Bob')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should handle array mutations', async () => {
    const state = $store({ list: [1, 2, 3] })
    const fn = vi.fn()

    createEffect(() => {
      fn(state.list[0])
    })

    expect(fn).toHaveBeenCalledWith(1)

    state.list[0] = 10
    await tick()
    expect(fn).toHaveBeenCalledWith(10)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should handle adding new properties', async () => {
    const state = $store<any>({})
    const fn = vi.fn()

    // Reading a non-existent property should still track it if we access it
    createEffect(() => {
      fn(state.foo)
    })

    expect(fn).toHaveBeenCalledWith(undefined)

    state.foo = 'bar'
    await tick()
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

    it('should return new method after reassignment when called from effect', async () => {
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
      await tick()
      expect(results).toEqual(['a', 'a!'])

      // Change a tracked property to trigger effect again
      state.value = 'b'

      // Effect re-runs again
      await tick()
      expect(results).toEqual(['a', 'a!', 'b!'])
    })
  })

  describe('Edge cases verification', () => {
    it('should react to property deletion', async () => {
      const state = $store<{ prop?: string }>({ prop: 'exists' })
      const fn = vi.fn()

      createEffect(() => {
        fn('prop' in state)
      })

      expect(fn).toHaveBeenCalledWith(true)

      delete state.prop
      await tick()
      expect(fn).toHaveBeenCalledWith(false)
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should react to Object.keys iteration', async () => {
      const state = $store<Record<string, number>>({ a: 1, b: 2 })
      const fn = vi.fn()

      createEffect(() => {
        fn(Object.keys(state).join(','))
      })

      expect(fn).toHaveBeenCalledWith('a,b')

      state.c = 3
      await tick()
      expect(fn).toHaveBeenCalledWith('a,b,c')

      delete state.a
      await tick()
      expect(fn).toHaveBeenCalledWith('b,c')

      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('should react to for...in loop', async () => {
      const state = $store<Record<string, number>>({ x: 10 })
      const fn = vi.fn()

      createEffect(() => {
        const keys = []
        for (const key in state) {
          keys.push(key)
        }
        fn(keys.join(','))
      })

      expect(fn).toHaveBeenCalledWith('x')

      state.y = 20
      await tick()
      expect(fn).toHaveBeenCalledWith('x,y')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should handle deep nesting with arrays', async () => {
      const state = $store({
        users: [
          { id: 1, name: 'Alice', posts: [{ title: 'A' }] },
          { id: 2, name: 'Bob', posts: [] },
        ],
      })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.users[0]!.posts[0]!.title)
      })

      expect(fn).toHaveBeenCalledWith('A')

      state.users[0]!.posts[0]!.title = 'B'
      await tick()
      expect(fn).toHaveBeenCalledWith('B')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should react to "in" operator for property additions', async () => {
      const state = $store<{ prop?: string }>({})
      const fn = vi.fn()

      createEffect(() => {
        fn('prop' in state)
      })

      expect(fn).toHaveBeenCalledWith(false)

      state.prop = 'value'
      await tick()
      expect(fn).toHaveBeenCalledWith(true)
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should react to "in" operator after property modification', async () => {
      const state = $store<{ existing?: string; other?: string }>({ existing: 'initial' })
      const fn = vi.fn()

      createEffect(() => {
        const hasExisting = 'existing' in state
        const hasOther = 'other' in state
        fn({ hasExisting, hasOther })
      })

      expect(fn).toHaveBeenCalledWith({ hasExisting: true, hasOther: false })

      state.other = 'new'
      await tick()
      expect(fn).toHaveBeenCalledWith({ hasExisting: true, hasOther: true })

      delete state.existing
      await tick()
      expect(fn).toHaveBeenCalledWith({ hasExisting: false, hasOther: true })

      expect(fn).toHaveBeenCalledTimes(3)
    })
  })

  describe('Array methods reactivity', () => {
    it('should react to array.push()', async () => {
      const state = $store({ items: [1, 2] })
      const results: number[] = []

      createEffect(() => {
        results.push(state.items.length)
      })

      expect(results).toEqual([2])

      state.items.push(3)
      await tick()
      await tick()
      // Verify the final state is correct
      expect(state.items.length).toBe(3)
      expect(state.items).toEqual([1, 2, 3])
      // The effect should have been triggered and updated with the new length
      expect(results[results.length - 1]).toBe(3)
    })

    it('should react to array.pop()', async () => {
      const state = $store({ items: [1, 2, 3] })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.items.length)
      })

      expect(fn).toHaveBeenCalledWith(3)

      state.items.pop()
      await tick()
      expect(fn).toHaveBeenLastCalledWith(2)
      expect(state.items.length).toBe(2)
    })

    it('should react to array.splice()', async () => {
      const state = $store({ items: [1, 2, 3, 4] })
      const lengthFn = vi.fn()
      const contentFn = vi.fn()

      createEffect(() => {
        lengthFn(state.items.length)
      })

      createEffect(() => {
        contentFn(state.items.join(','))
      })

      expect(lengthFn).toHaveBeenCalledWith(4)
      expect(contentFn).toHaveBeenCalledWith('1,2,3,4')

      // Remove 1 element at index 1
      state.items.splice(1, 1)
      await tick()
      expect(lengthFn).toHaveBeenLastCalledWith(3)
      expect(contentFn).toHaveBeenLastCalledWith('1,3,4')

      // Add elements
      state.items.splice(1, 0, 10, 20)
      await tick()
      expect(lengthFn).toHaveBeenLastCalledWith(5)
      expect(contentFn).toHaveBeenLastCalledWith('1,10,20,3,4')
    })

    it('should react to array.unshift()', async () => {
      const state = $store({ items: [2, 3] })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.items.join(','))
      })

      expect(fn).toHaveBeenCalledWith('2,3')

      state.items.unshift(1)
      await tick()
      // unshift moves all elements, so may trigger multiple times
      expect(fn).toHaveBeenLastCalledWith('1,2,3')
      expect(state.items.join(',')).toBe('1,2,3')
    })

    it('should react to array.shift()', async () => {
      const state = $store({ items: [1, 2, 3] })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.items.join(','))
      })

      expect(fn).toHaveBeenCalledWith('1,2,3')

      state.items.shift()
      await tick()
      // shift moves all elements, so may trigger multiple times
      expect(fn).toHaveBeenLastCalledWith('2,3')
      expect(state.items.join(',')).toBe('2,3')
    })

    it('should react to array.reverse()', async () => {
      const state = $store({ items: [1, 2, 3] })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.items.join(','))
      })

      expect(fn).toHaveBeenCalledWith('1,2,3')

      state.items.reverse()
      await tick()
      // reverse swaps elements in place, may trigger multiple times
      expect(fn).toHaveBeenLastCalledWith('3,2,1')
      expect(state.items.join(',')).toBe('3,2,1')
    })

    it('should react to array.sort()', async () => {
      const state = $store({ items: [3, 1, 2] })
      const fn = vi.fn()

      createEffect(() => {
        fn(state.items.join(','))
      })

      expect(fn).toHaveBeenCalledWith('3,1,2')

      state.items.sort()
      await tick()
      // sort swaps elements in place, may trigger multiple times
      expect(fn).toHaveBeenLastCalledWith('1,2,3')
      expect(state.items.join(',')).toBe('1,2,3')
    })

    it('should track array iteration with Object.keys', async () => {
      const state = $store({ items: ['a', 'b'] })
      const fn = vi.fn()

      createEffect(() => {
        fn(Object.keys(state.items).join(','))
      })

      expect(fn).toHaveBeenCalledWith('0,1')

      state.items.push('c')
      await tick()
      expect(fn).toHaveBeenLastCalledWith('0,1,2')

      state.items.splice(1, 1)
      await tick()
      expect(fn).toHaveBeenLastCalledWith('0,1')
      expect(Object.keys(state.items).join(',')).toBe('0,1')
    })
  })
})
