import { createEffect } from '@fictjs/runtime'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { $store } from '../src/store'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

// Module-scope $store - this is ALLOWED (unlike $state which must be inside component)
const moduleStore = $store({ count: 0, user: { name: 'Alice' } })

describe('$store', () => {
  describe('module-scope store (allowed)', () => {
    beforeEach(() => {
      // Reset between tests
      moduleStore.count = 0
      moduleStore.user.name = 'Alice'
    })

    it('should work at module scope unlike $state', async () => {
      const fn = vi.fn()

      createEffect(() => {
        fn(moduleStore.count)
      })

      expect(fn).toHaveBeenCalledWith(0)

      moduleStore.count++
      await tick()
      expect(fn).toHaveBeenCalledWith(1)
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should allow nested property access at module scope', async () => {
      const fn = vi.fn()

      createEffect(() => {
        fn(moduleStore.user.name)
      })

      expect(fn).toHaveBeenCalledWith('Alice')

      moduleStore.user.name = 'Bob'
      await tick()
      expect(fn).toHaveBeenCalledWith('Bob')
    })
  })
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

  it('should react to array length truncation', async () => {
    const state = $store({ items: [1, 2, 3] })
    const seen: Array<number | undefined> = []

    createEffect(() => {
      seen.push(state.items[2])
    })

    expect(seen[seen.length - 1]).toBe(3)

    state.items.length = 1
    await tick()

    expect(state.items.length).toBe(1)
    expect(seen[seen.length - 1]).toBe(undefined)
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

    it('should not return stale bound methods after external deletion', () => {
      const raw: any = {
        value: 'original',
        getValue() {
          return this.value
        },
      }
      const state = $store(raw)

      // Cache the bound method
      expect(state.getValue()).toBe('original')

      // Mutate the raw object directly (bypassing proxy)
      delete raw.getValue
      expect(state.getValue).toBeUndefined()

      // Restore with a new function
      raw.getValue = function () {
        return this.value + '!'
      }
      expect(state.getValue()).toBe('original!')
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

  describe('circular references', () => {
    it('should handle self-referencing objects without infinite recursion', () => {
      interface SelfRef {
        name: string
        self?: SelfRef
      }

      const obj: SelfRef = { name: 'root' }
      obj.self = obj // Create circular reference

      const state = $store(obj)

      // Should not throw or cause infinite loop
      expect(state.name).toBe('root')
      expect(state.self).toBe(state) // Should return the same proxy
      expect(state.self?.name).toBe('root')
      expect(state.self?.self?.name).toBe('root')
    })

    it('should handle mutually referencing objects', () => {
      interface NodeA {
        name: string
        b?: NodeB
      }
      interface NodeB {
        value: number
        a?: NodeA
      }

      const a: NodeA = { name: 'A' }
      const b: NodeB = { value: 42 }
      a.b = b
      b.a = a

      const storeA = $store(a)

      // Should not throw or cause infinite loop
      expect(storeA.name).toBe('A')
      expect(storeA.b?.value).toBe(42)
      expect(storeA.b?.a?.name).toBe('A')
      expect(storeA.b?.a?.b?.value).toBe(42)
    })

    it('should track changes in circular structures', async () => {
      interface SelfRef {
        name: string
        self?: SelfRef
      }

      const obj: SelfRef = { name: 'root' }
      obj.self = obj

      const state = $store(obj)
      const fn = vi.fn()

      createEffect(() => {
        fn(state.name)
      })

      expect(fn).toHaveBeenCalledWith('root')

      state.name = 'updated'
      await tick()
      expect(fn).toHaveBeenCalledWith('updated')

      // Access through circular reference should also see update
      expect(state.self?.name).toBe('updated')
    })

    it('should handle nested arrays with circular references', () => {
      interface TreeNode {
        id: number
        children: TreeNode[]
        parent?: TreeNode
      }

      const root: TreeNode = { id: 1, children: [] }
      const child1: TreeNode = { id: 2, children: [], parent: root }
      const child2: TreeNode = { id: 3, children: [], parent: root }
      root.children.push(child1, child2)

      const state = $store(root)

      expect(state.id).toBe(1)
      expect(state.children.length).toBe(2)
      expect(state.children[0].id).toBe(2)
      expect(state.children[0].parent?.id).toBe(1)
      expect(state.children[1].parent?.children[0].id).toBe(2)
    })

    it('should handle deeply nested circular structures', () => {
      interface DeepNode {
        level: number
        nested?: {
          inner?: {
            ref?: DeepNode
          }
        }
      }

      const obj: DeepNode = {
        level: 0,
        nested: {
          inner: {},
        },
      }
      obj.nested!.inner!.ref = obj

      const state = $store(obj)

      expect(state.level).toBe(0)
      expect(state.nested?.inner?.ref?.level).toBe(0)
      expect(state.nested?.inner?.ref?.nested?.inner?.ref?.level).toBe(0)
    })

    it('should maintain proxy identity for circular references', () => {
      interface SelfRef {
        self?: SelfRef
      }

      const obj: SelfRef = {}
      obj.self = obj

      const state = $store(obj)

      // The proxy should be the same object when accessed through circular reference
      const directProxy = state
      const circularProxy = state.self

      // Both should be the same proxy (or at least equivalent proxies for the same target)
      expect(circularProxy).toBe(directProxy)
    })

    it('should handle mutual references (A -> B -> A)', () => {
      interface NodeA {
        name: string
        b?: NodeB
      }
      interface NodeB {
        value: number
        a?: NodeA
      }

      const a: NodeA = { name: 'nodeA' }
      const b: NodeB = { value: 42 }
      a.b = b
      b.a = a // Creates mutual reference

      const storeA = $store(a)

      // Access through mutual reference chain
      expect(storeA.name).toBe('nodeA')
      expect(storeA.b?.value).toBe(42)
      expect(storeA.b?.a?.name).toBe('nodeA')
      expect(storeA.b?.a?.b?.value).toBe(42)
    })

    it('should handle reactivity through circular reference paths', async () => {
      interface Node {
        value: number
        next?: Node
      }

      const obj: Node = { value: 1 }
      obj.next = { value: 2 }
      obj.next.next = obj // Circular back to root

      const state = $store(obj)
      const fn = vi.fn()

      createEffect(() => {
        // Access value through circular path
        fn(state.next?.next?.value)
      })

      await tick()
      expect(fn).toHaveBeenCalledWith(1)

      // Modify root value
      state.value = 100
      await tick()
      expect(fn).toHaveBeenCalledWith(100)
    })

    it('should handle breaking circular references', () => {
      interface SelfRef {
        name: string
        self?: SelfRef | null
      }

      const obj: SelfRef = { name: 'root' }
      obj.self = obj

      const state = $store(obj)

      // Initially circular
      expect(state.self?.name).toBe('root')

      // Break the circular reference
      state.self = null

      expect(state.self).toBe(null)
      expect(state.name).toBe('root')
    })

    it('should handle creating circular references dynamically', () => {
      interface DynamicNode {
        id: number
        ref?: DynamicNode
      }

      const state = $store<DynamicNode>({ id: 1 })

      // Initially no circular reference
      expect(state.ref).toBe(undefined)

      // Dynamically create circular reference
      state.ref = state as DynamicNode

      // Access through circular reference
      expect(state.ref.id).toBe(1)
      expect(state.ref.ref?.id).toBe(1)
    })
  })

  // Double-wrap prevention and read-time write removal
  describe('proxy guard and read-time write prevention', () => {
    it('should prevent double-wrapping of proxies', () => {
      const raw = { value: 1 }
      const store1 = $store(raw)
      const store2 = $store(store1) // Try to wrap the proxy again

      // Should return the same proxy, not create a new one
      expect(store2).toBe(store1)
    })

    it('should return same proxy for same raw object', () => {
      const raw = { value: 1 }
      const store1 = $store(raw)
      const store2 = $store(raw)

      expect(store1).toBe(store2)
    })

    it('should identify store proxy via internal symbol', () => {
      const store = $store({ value: 1 })

      // Accessing IS_STORE_PROXY symbol should return true
      // This is tested indirectly via the double-wrap prevention
      const store2 = $store(store)
      expect(store2).toBe(store)
    })

    it('should warn in dev mode when underlying object is mutated directly', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const raw = { value: 1 }
      const store = $store(raw)

      // First read - creates signal with initial value
      expect(store.value).toBe(1)

      // Direct mutation of raw object (bypassing proxy)
      raw.value = 2

      // Second read - should detect the discrepancy and warn
      expect(store.value).toBe(2) // Still returns current value

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fict] $store detected direct mutation'),
      )

      warnSpy.mockRestore()
    })

    it('should not warn when mutations go through proxy', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const store = $store({ value: 1 })

      expect(store.value).toBe(1)

      // Mutation through proxy (correct way)
      store.value = 2
      await tick()

      expect(store.value).toBe(2)

      // No warning should be issued for proper proxy mutation
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    it('should not warn for built-in properties like constructor', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const store = $store([1, 2, 3])

      // Accessing array methods (which internally access constructor, etc.)
      store.push(4)
      store.splice(0, 1)

      // Should not warn about constructor access
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('constructor'))

      warnSpy.mockRestore()
    })

    it('should handle nested proxies correctly without double-wrapping', () => {
      const store = $store({
        nested: { value: 1 },
      })

      // Get nested proxy
      const nested1 = store.nested
      const nested2 = store.nested

      // Should return the same proxy reference
      expect(nested1).toBe(nested2)

      // And double-wrapping the nested proxy should return itself
      const rewrapped = $store(nested1)
      expect(rewrapped).toBe(nested1)
    })
  })
})
