/**
 * Tests for the renderHook function
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, cleanup } from '../src/index'
import { createElement, createMemo, createEffect, onMount, onCleanup } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('renderHook', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('basic usage', () => {
    it('returns the result of the hook', () => {
      const { result } = renderHook(() => {
        return { value: 42 }
      })

      expect(result.current.value).toBe(42)
    })

    it('returns functions from hooks', () => {
      const { result } = renderHook(() => {
        const getValue = () => 'hello'
        return { getValue }
      })

      expect(result.current.getValue()).toBe('hello')
    })

    it('allows accessing reactive values', () => {
      const { result } = renderHook(() => {
        const count = createSignal(0)
        return {
          count,
          increment: () => count(count() + 1),
        }
      })

      expect(result.current.count()).toBe(0)
      result.current.increment()
      expect(result.current.count()).toBe(1)
    })
  })

  describe('with initial props', () => {
    it('passes initial props to the hook', () => {
      const { result } = renderHook((initial: number) => ({ value: initial }), {
        initialProps: [10],
      })

      expect(result.current.value).toBe(10)
    })

    it('accepts props as array shorthand', () => {
      const { result } = renderHook((name: string, age: number) => ({ name, age }), ['John', 30])

      expect(result.current.name).toBe('John')
      expect(result.current.age).toBe(30)
    })
  })

  describe('rerender', () => {
    it('rerenders with new props', () => {
      const { result, rerender } = renderHook((value: number) => ({ doubled: value * 2 }), {
        initialProps: [5],
      })

      expect(result.current.doubled).toBe(10)

      rerender([10])

      expect(result.current.doubled).toBe(20)
    })

    it('updates result on rerender', () => {
      let renderCount = 0

      const { result, rerender } = renderHook(() => {
        renderCount++
        return { count: renderCount }
      })

      expect(result.current.count).toBe(1)

      rerender()

      expect(result.current.count).toBe(2)
    })
  })

  describe('cleanup', () => {
    it('cleans up the hook', () => {
      let cleanedUp = false

      const { cleanup: cleanupHook } = renderHook(() => {
        onMount(() => {
          return () => {
            cleanedUp = true
          }
        })
        return {}
      })

      expect(cleanedUp).toBe(false)
      cleanupHook()
      expect(cleanedUp).toBe(true)
    })

    it('provides unmount as alias for cleanup', () => {
      let unmounted = false

      const { unmount } = renderHook(() => {
        onMount(() => {
          return () => {
            unmounted = true
          }
        })
        return {}
      })

      expect(unmounted).toBe(false)
      unmount()
      expect(unmounted).toBe(true)
    })

    it('cleanup() disposes hooks created by renderHook', () => {
      let cleanedUp = false

      renderHook(() => {
        createEffect(() => {
          onCleanup(() => {
            cleanedUp = true
          })
        })
        return {}
      })

      cleanup()
      expect(cleanedUp).toBe(true)
    })
  })

  describe('with wrapper', () => {
    it('wraps the hook with a wrapper component', () => {
      let wrapperRendered = false

      const Wrapper = (props: { children: any }) => {
        wrapperRendered = true
        return props.children
      }

      const { result } = renderHook(
        () => {
          return { value: 'test' }
        },
        { wrapper: Wrapper },
      )

      expect(wrapperRendered).toBe(true)
      expect(result.current.value).toBe('test')
    })
  })

  describe('reactive hooks', () => {
    it('handles createMemo', () => {
      const { result } = renderHook(() => {
        const count = createSignal(5)
        const doubled = createMemo(() => count() * 2)
        return { count, doubled }
      })

      expect(result.current.doubled()).toBe(10)
      result.current.count(10)
      expect(result.current.doubled()).toBe(20)
    })

    it('handles createEffect', async () => {
      const log: number[] = []

      const { result, cleanup: cleanupHook } = renderHook(() => {
        const count = createSignal(0)
        createEffect(() => {
          log.push(count())
        })
        return { count }
      })

      expect(log).toEqual([0])

      result.current.count(1)
      await tick()
      expect(log).toEqual([0, 1])

      result.current.count(2)
      await tick()
      expect(log).toEqual([0, 1, 2])

      cleanupHook()
    })
  })

  describe('complex hooks', () => {
    it('tests a counter hook', () => {
      function useCounter(initial: number) {
        const count = createSignal(initial)
        const increment = () => count(count() + 1)
        const decrement = () => count(count() - 1)
        const reset = () => count(initial)
        return { count, increment, decrement, reset }
      }

      const { result } = renderHook((initial: number) => useCounter(initial), [10])

      expect(result.current.count()).toBe(10)

      result.current.increment()
      expect(result.current.count()).toBe(11)

      result.current.decrement()
      expect(result.current.count()).toBe(10)

      result.current.increment()
      result.current.increment()
      result.current.reset()
      expect(result.current.count()).toBe(10)
    })

    it('tests a toggle hook', () => {
      function useToggle(initial: boolean = false) {
        const state = createSignal(initial)
        const toggle = () => state(!state())
        const setTrue = () => state(true)
        const setFalse = () => state(false)
        return { state, toggle, setTrue, setFalse }
      }

      const { result } = renderHook(() => useToggle())

      expect(result.current.state()).toBe(false)

      result.current.toggle()
      expect(result.current.state()).toBe(true)

      result.current.toggle()
      expect(result.current.state()).toBe(false)

      result.current.setTrue()
      expect(result.current.state()).toBe(true)

      result.current.setFalse()
      expect(result.current.state()).toBe(false)
    })

    it('tests a list hook', () => {
      function useList<T>(initial: T[] = []) {
        const items = createSignal(initial)
        const add = (item: T) => items([...items(), item])
        const remove = (index: number) => items(items().filter((_, i) => i !== index))
        const clear = () => items([])
        return { items, add, remove, clear }
      }

      const { result } = renderHook(() => useList<string>())

      expect(result.current.items()).toEqual([])

      result.current.add('a')
      result.current.add('b')
      result.current.add('c')
      expect(result.current.items()).toEqual(['a', 'b', 'c'])

      result.current.remove(1)
      expect(result.current.items()).toEqual(['a', 'c'])

      result.current.clear()
      expect(result.current.items()).toEqual([])
    })
  })
})
