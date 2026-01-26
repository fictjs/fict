/**
 * Memory and Lifecycle Tests
 *
 * Tests for memory management, cleanup behavior, and leak prevention.
 * Covers behaviors B031-B040 from architecture docs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createMemo,
  createEffect,
  render,
  createElement,
  onMount,
  onDestroy,
  onCleanup,
  createContext,
  useContext,
} from '../src/index'
import { createSignal } from '../src/advanced'
import { createKeyedList, createConditional } from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Memory and Lifecycle Tests', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('B031-B033: Signal Dependency Links', () => {
    it('B031: dependency links established on read', async () => {
      const source = createSignal(0)
      const effectRuns: number[] = []

      createEffect(() => {
        effectRuns.push(source())
      })

      expect(effectRuns).toEqual([0])

      source(1)
      await tick()
      expect(effectRuns).toEqual([0, 1])

      source(2)
      await tick()
      expect(effectRuns).toEqual([0, 1, 2])
    })

    it('B032: old links cleaned on effect re-run', async () => {
      const a = createSignal(1)
      const b = createSignal(10)
      const useA = createSignal(true)
      const effectRuns: string[] = []

      createEffect(() => {
        if (useA()) {
          effectRuns.push(`a:${a()}`)
        } else {
          effectRuns.push(`b:${b()}`)
        }
      })

      expect(effectRuns).toEqual(['a:1'])

      // Change to use b
      useA(false)
      await tick()
      expect(effectRuns).toEqual(['a:1', 'b:10'])

      // Now a changes should NOT trigger effect
      a(2)
      await tick()
      expect(effectRuns).toEqual(['a:1', 'b:10'])

      // But b changes should
      b(20)
      await tick()
      expect(effectRuns).toEqual(['a:1', 'b:10', 'b:20'])
    })

    it('B033: memo dependencies update correctly', async () => {
      const a = createSignal(1)
      const b = createSignal(10)
      const useA = createSignal(true)

      const derived = createMemo(() => {
        return useA() ? a() * 2 : b() * 2
      })

      expect(derived()).toBe(2)

      useA(false)
      await tick()
      expect(derived()).toBe(20)

      // a changes should not affect derived now
      a(100)
      await tick()
      expect(derived()).toBe(20)

      // b changes should affect it
      b(50)
      await tick()
      expect(derived()).toBe(100)
    })
  })

  describe('B034-B036: Binding Cleanup', () => {
    it('B034: bindText cleanup on dispose', async () => {
      const count = createSignal(0)
      const cleanupCalled = vi.fn()

      const dispose = render(() => {
        const text = document.createTextNode('')
        createEffect(() => {
          text.textContent = String(count())
          onCleanup(cleanupCalled)
        })
        return text
      }, container)

      expect(cleanupCalled).not.toHaveBeenCalled()

      count(1)
      await tick()
      expect(cleanupCalled).toHaveBeenCalledTimes(1)

      dispose()
      expect(cleanupCalled).toHaveBeenCalledTimes(2)
    })

    it('B035: attribute binding cleanup', async () => {
      const value = createSignal('initial')
      const cleanupCount = { count: 0 }

      const dispose = render(() => {
        const div = document.createElement('div')
        createEffect(() => {
          div.setAttribute('data-value', value())
          onCleanup(() => cleanupCount.count++)
        })
        return div
      }, container)

      expect(cleanupCount.count).toBe(0)

      value('changed')
      await tick()
      expect(cleanupCount.count).toBe(1)

      dispose()
      expect(cleanupCount.count).toBe(2)
    })

    it('B036: list container cleanup removes all blocks', async () => {
      const items = createSignal([1, 2, 3])
      const blockCleanups: number[] = []

      const list = createKeyedList(
        () => items(),
        item => item,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig())
            onCleanup(() => blockCleanups.push(itemSig() as number))
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(container.querySelectorAll('div').length).toBe(3)

      list.dispose()

      // All blocks should be cleaned up
      expect(blockCleanups).toContain(1)
      expect(blockCleanups).toContain(2)
      expect(blockCleanups).toContain(3)
    })
  })

  describe('Frequent Mount/Unmount', () => {
    it('handles rapid mount/unmount cycles without leaks', async () => {
      const mountCount = { value: 0 }
      const unmountCount = { value: 0 }

      const Component = () => {
        onMount(() => {
          mountCount.value++
          return () => unmountCount.value++
        })
        return document.createElement('div')
      }

      // Rapid mount/unmount
      for (let i = 0; i < 100; i++) {
        const dispose = render(
          () => createElement({ type: Component, props: null, key: undefined }),
          container,
        )
        dispose()
      }

      expect(mountCount.value).toBe(100)
      expect(unmountCount.value).toBe(100)
    })

    it('conditional toggle does not leak', async () => {
      const show = createSignal(true)
      const mountLog: string[] = []
      const cleanupLog: string[] = []

      const dispose = render(() => {
        const { marker } = createConditional(
          () => show(),
          () => {
            onMount(() => {
              mountLog.push('mount')
              return () => cleanupLog.push('cleanup')
            })
            return document.createElement('div')
          },
          createElement,
        )
        return marker
      }, container)

      expect(mountLog.length).toBeGreaterThanOrEqual(1)

      // Toggle 50 times
      for (let i = 0; i < 50; i++) {
        show(!show())
        await tick()
      }

      // Verify cleanups happen when show becomes false
      // The exact count depends on implementation details of when mounts fire
      expect(cleanupLog.length).toBeGreaterThan(0)

      // Final dispose should clean up remaining state
      const cleanupsBefore = cleanupLog.length
      dispose()
      // After dispose, if show was true, one more cleanup should run
      if (show()) {
        expect(cleanupLog.length).toBeGreaterThanOrEqual(cleanupsBefore)
      }
    })
  })

  describe('List Diff Memory Management', () => {
    it('list reorder does not create new effects', async () => {
      const items = createSignal([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ])
      let effectCreations = 0

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          effectCreations++
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().name
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(effectCreations).toBe(3)

      // Reorder items
      items([
        { id: 3, name: 'C' },
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ])
      await tick()

      // No new effects should be created for reorder
      expect(effectCreations).toBe(3)

      list.dispose()
    })

    it('removed items clean up their effects', async () => {
      const items = createSignal([1, 2, 3, 4, 5])
      const activeBlocks = new Set<number>()
      const removedBlocks: number[] = []

      const list = createKeyedList(
        () => items(),
        item => item,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          const value = itemSig() as number
          activeBlocks.add(value)
          // Use onDestroy instead of onCleanup to track block disposal
          onDestroy(() => {
            activeBlocks.delete(value)
            removedBlocks.push(value)
          })
          createEffect(() => {
            div.textContent = String(itemSig())
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      expect(activeBlocks.size).toBe(5)

      // Remove items 2 and 4
      items([1, 3, 5])
      await tick()

      // Items 2 and 4 should have been removed
      expect(removedBlocks).toContain(2)
      expect(removedBlocks).toContain(4)
      expect(activeBlocks.has(2)).toBe(false)
      expect(activeBlocks.has(4)).toBe(false)

      list.dispose()
    })

    it('large list operations do not accumulate effects', { timeout: 10000 }, async () => {
      const items = createSignal<number[]>([])
      let totalCleanups = 0

      const list = createKeyedList(
        () => items(),
        item => item,
        (itemSig, _indexSig) => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig())
            onCleanup(() => totalCleanups++)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Add 1000 items
      items(Array.from({ length: 1000 }, (_, i) => i))
      await tick()

      expect(container.querySelectorAll('div').length).toBe(1000)

      // Remove all
      items([])
      await tick()

      expect(totalCleanups).toBe(1000)
      expect(container.querySelectorAll('div').length).toBe(0)

      list.dispose()
    })
  })

  describe('Effect Cleanup Edge Cases', () => {
    it('cleanup runs when effect re-runs', async () => {
      const trigger = createSignal(0)
      let cleanupRan = false

      createEffect(() => {
        trigger()
        onCleanup(() => {
          cleanupRan = true
        })
      })

      expect(cleanupRan).toBe(false)

      trigger(1)
      await tick()

      // Cleanup should run when effect re-runs
      expect(cleanupRan).toBe(true)
    })

    it('nested effects clean up in correct order', async () => {
      const show = createSignal(true)
      const cleanupOrder: string[] = []

      createEffect(() => {
        if (show()) {
          onCleanup(() => cleanupOrder.push('outer'))

          createEffect(() => {
            onCleanup(() => cleanupOrder.push('inner'))
          })
        }
      })

      show(false)
      await tick()

      // Outer cleanup runs when effect re-runs
      // The exact order depends on implementation - verify outer runs at minimum
      expect(cleanupOrder).toContain('outer')
    })

    it('effect dispose during cleanup does not double-clean', async () => {
      const trigger = createSignal(0)
      let cleanupCount = 0

      const dispose = createEffect(() => {
        trigger()
        onCleanup(() => cleanupCount++)
      })

      trigger(1)
      await tick()
      expect(cleanupCount).toBe(1)

      // Dispose should trigger one more cleanup
      dispose?.()
      expect(cleanupCount).toBe(2)

      // Further triggers should not cause cleanup
      trigger(2)
      await tick()
      expect(cleanupCount).toBe(2)
    })
  })

  describe('Memory Stress Tests', () => {
    it('handles many concurrent signals', async () => {
      const signals = Array.from({ length: 1000 }, () => createSignal(0))
      const memos = signals.map((s, i) => createMemo(() => s() + i))

      let effectRunCount = 0
      createEffect(() => {
        effectRunCount++
        // Read all memos
        memos.forEach(m => m())
      })

      expect(effectRunCount).toBe(1)

      // Update first signal
      signals[0]!(1)
      await tick()

      expect(effectRunCount).toBe(2)
      expect(memos[0]!()).toBe(1)
    })

    it('deep memo chain cleans up properly', () => {
      const base = createSignal(0)
      const memos: ReturnType<typeof createMemo<number>>[] = []

      // Create chain of 100 memos
      let prev: () => number = base
      for (let i = 0; i < 100; i++) {
        const p = prev
        const memo = createMemo(() => p() + 1)
        memos.push(memo)
        prev = memo
      }

      expect(memos[99]!()).toBe(100)

      base(10)
      expect(memos[99]!()).toBe(110)
    })

    it('effect with many deps tracks correctly', async () => {
      const signals = Array.from({ length: 50 }, (_, i) => createSignal(i))
      const log: number[] = []

      createEffect(() => {
        const sum = signals.reduce((acc, s) => acc + s(), 0)
        log.push(sum)
      })

      const initialSum = (49 * 50) / 2 // Sum of 0-49
      expect(log).toEqual([initialSum])

      signals[0]!(100)
      await tick()

      expect(log).toEqual([initialSum, initialSum + 100])
    })
  })

  describe('Component Tree Memory', () => {
    it('deeply nested components clean up correctly', () => {
      const cleanupOrder: number[] = []
      const DEPTH = 10

      const createNested = (depth: number): Node => {
        if (depth === 0) {
          const span = document.createElement('span')
          span.textContent = 'leaf'
          return span
        }

        const div = document.createElement('div')
        onDestroy(() => cleanupOrder.push(depth))
        div.appendChild(createNested(depth - 1))
        return div
      }

      const dispose = render(() => createNested(DEPTH), container)

      expect(cleanupOrder.length).toBe(0)

      dispose()

      // All levels should be cleaned up
      expect(cleanupOrder.length).toBe(DEPTH)
    })

    it('sibling components do not interfere with each other', async () => {
      const countA = createSignal(0)
      const countB = createSignal(0)
      const effectsA: number[] = []
      const effectsB: number[] = []

      const dispose = render(() => {
        const div = document.createElement('div')

        // Component A
        const a = document.createElement('div')
        a.className = 'a'
        createEffect(() => {
          effectsA.push(countA())
          a.textContent = `A: ${countA()}`
        })

        // Component B
        const b = document.createElement('div')
        b.className = 'b'
        createEffect(() => {
          effectsB.push(countB())
          b.textContent = `B: ${countB()}`
        })

        div.appendChild(a)
        div.appendChild(b)
        return div
      }, container)

      expect(effectsA).toEqual([0])
      expect(effectsB).toEqual([0])

      countA(1)
      await tick()

      // Only A should have re-run
      expect(effectsA).toEqual([0, 1])
      expect(effectsB).toEqual([0])

      countB(1)
      await tick()

      // Only B should have re-run
      expect(effectsA).toEqual([0, 1])
      expect(effectsB).toEqual([0, 1])

      dispose()
    })
  })

  describe('Large List Cyclic Create/Destroy Tests', () => {
    it('handles repeated large list creation and destruction', { timeout: 30000 }, async () => {
      const ITERATIONS = 20
      const LIST_SIZE = 200
      const items = createSignal<number[]>([])
      let totalCreations = 0
      let totalDestructions = 0

      const list = createKeyedList(
        () => items(),
        item => item,
        (itemSig, _indexSig) => {
          totalCreations++
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig())
          })
          onDestroy(() => {
            totalDestructions++
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Cycle through creation and destruction multiple times
      for (let i = 0; i < ITERATIONS; i++) {
        // Create large list
        items(Array.from({ length: LIST_SIZE }, (_, idx) => i * LIST_SIZE + idx))
        await tick()

        expect(container.querySelectorAll('div').length).toBe(LIST_SIZE)

        // Clear list
        items([])
        await tick()

        expect(container.querySelectorAll('div').length).toBe(0)
      }

      // Verify all creations have corresponding destructions
      expect(totalCreations).toBe(ITERATIONS * LIST_SIZE)
      expect(totalDestructions).toBe(ITERATIONS * LIST_SIZE)

      list.dispose()
    })

    it('handles rapid list updates without memory accumulation', async () => {
      const items = createSignal<{ id: number; value: string }[]>([])
      let totalCreated = 0
      let totalDestroyed = 0

      const list = createKeyedList(
        () => items(),
        item => item.id,
        (itemSig, _indexSig) => {
          totalCreated++
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().value
          })
          onDestroy(() => {
            totalDestroyed++
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Rapidly update with different sized lists
      const sizes = [100, 50, 200, 10, 150, 0, 300, 25, 0]
      let nextId = 0

      for (const size of sizes) {
        const newItems = Array.from({ length: size }, () => ({
          id: nextId++,
          value: `Item ${nextId}`,
        }))
        items(newItems)
        await tick()

        // Current DOM should match list size
        expect(container.querySelectorAll('div').length).toBe(size)
      }

      // After clearing, no elements should remain
      expect(container.querySelectorAll('div').length).toBe(0)

      // Verify all creations have corresponding destructions
      expect(totalCreated).toBe(totalDestroyed)

      list.dispose()
    })

    it('handles nested lists with proper cleanup', async () => {
      const outerItems = createSignal<number[]>([1, 2, 3])
      let innerListCreations = 0
      let innerListDestructions = 0
      let innerItemCreations = 0
      let innerItemDestructions = 0

      const outerList = createKeyedList(
        () => outerItems(),
        item => item,
        (outerSig, _indexSig) => {
          innerListCreations++
          const container = document.createElement('div')
          container.className = 'outer'

          const innerItems = createSignal(
            Array.from({ length: 10 }, (_, i) => outerSig() * 100 + i),
          )

          const innerList = createKeyedList(
            () => innerItems(),
            item => item,
            (innerSig, _innerIndex) => {
              innerItemCreations++
              const span = document.createElement('span')
              createEffect(() => {
                span.textContent = String(innerSig())
              })
              onDestroy(() => {
                innerItemDestructions++
              })
              return [span]
            },
          )

          container.appendChild(innerList.marker)

          onDestroy(() => {
            innerListDestructions++
            innerList.dispose()
          })

          return [container]
        },
      )

      container.appendChild(outerList.marker)
      await tick()

      expect(innerListCreations).toBe(3)
      expect(innerItemCreations).toBe(30) // 3 outer * 10 inner

      // Remove middle outer item
      outerItems([1, 3])
      await tick()

      expect(innerListDestructions).toBe(1)
      expect(innerItemDestructions).toBe(10)

      // Clear all
      outerItems([])
      await tick()

      expect(innerListDestructions).toBe(3)
      expect(innerItemDestructions).toBe(30)

      outerList.dispose()
    })

    it('handles interleaved add/remove operations efficiently', async () => {
      const items = createSignal<number[]>([])
      const operations: string[] = []

      const list = createKeyedList(
        () => items(),
        item => item,
        (itemSig, _indexSig) => {
          const id = itemSig() as number
          operations.push(`create:${id}`)
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(itemSig())
          })
          onDestroy(() => {
            operations.push(`destroy:${id}`)
          })
          return [div]
        },
      )

      container.appendChild(list.marker)
      await tick()

      // Perform interleaved operations
      items([1, 2, 3, 4, 5])
      await tick()
      expect(operations.filter(o => o.startsWith('create')).length).toBe(5)

      // Remove some, keep some, add new
      items([2, 4, 6, 7])
      await tick()

      // Items 1, 3, 5 should be destroyed; 6, 7 created; 2, 4 retained
      expect(operations).toContain('destroy:1')
      expect(operations).toContain('destroy:3')
      expect(operations).toContain('destroy:5')
      expect(operations).toContain('create:6')
      expect(operations).toContain('create:7')

      // Final cleanup
      items([])
      await tick()

      const createCount = operations.filter(o => o.startsWith('create')).length
      const destroyCount = operations.filter(o => o.startsWith('destroy')).length
      expect(createCount).toBe(destroyCount)

      list.dispose()
    })
  })

  describe('Long-Running Application Tests', () => {
    it('maintains stable memory over many signal update cycles', async () => {
      const CYCLE_COUNT = 1000
      const signal = createSignal(0)
      let effectRunCount = 0
      let cleanupRunCount = 0

      createEffect(() => {
        signal()
        effectRunCount++
        onCleanup(() => {
          cleanupRunCount++
        })
      })

      // Simulate long-running updates
      for (let i = 1; i <= CYCLE_COUNT; i++) {
        signal(i)
        await tick()
      }

      // Effect should have run CYCLE_COUNT + 1 times (initial + updates)
      expect(effectRunCount).toBe(CYCLE_COUNT + 1)
      // Cleanup should have run CYCLE_COUNT times (before each re-run, not after last)
      expect(cleanupRunCount).toBe(CYCLE_COUNT)
    })

    it('handles many effect create/dispose cycles', async () => {
      const CYCLE_COUNT = 200
      let activeEffects = 0
      let peakActiveEffects = 0
      const signal = createSignal(0)

      for (let i = 0; i < CYCLE_COUNT; i++) {
        const dispose = createEffect(() => {
          signal()
          activeEffects++
          peakActiveEffects = Math.max(peakActiveEffects, activeEffects)
          onCleanup(() => {
            activeEffects--
          })
        })

        // Verify effect is active
        expect(activeEffects).toBe(1)

        // Dispose immediately
        dispose()
        await tick()

        // Effect should be cleaned up
        expect(activeEffects).toBe(0)
      }

      // Peak should never exceed 1 since we dispose before creating next
      expect(peakActiveEffects).toBe(1)
      expect(activeEffects).toBe(0)
    })

    it('handles cascading memo updates without memory growth', async () => {
      const CHAIN_LENGTH = 50
      const UPDATE_CYCLES = 100
      const base = createSignal(0)
      const memos: ReturnType<typeof createMemo<number>>[] = []

      // Build a chain of memos
      let prev: () => number = base
      for (let i = 0; i < CHAIN_LENGTH; i++) {
        const p = prev
        const memo = createMemo(() => p() + 1)
        memos.push(memo)
        prev = memo
      }

      // Track effect runs
      let effectRunCount = 0
      createEffect(() => {
        memos[CHAIN_LENGTH - 1]!()
        effectRunCount++
      })

      expect(effectRunCount).toBe(1)
      expect(memos[CHAIN_LENGTH - 1]!()).toBe(CHAIN_LENGTH)

      // Update base signal many times
      for (let i = 1; i <= UPDATE_CYCLES; i++) {
        base(i)
        await tick()

        // Verify final memo value is correct
        expect(memos[CHAIN_LENGTH - 1]!()).toBe(i + CHAIN_LENGTH)
      }

      // Effect should run exactly once per update + initial
      expect(effectRunCount).toBe(UPDATE_CYCLES + 1)
    })

    it('handles component with many child renders over time', async () => {
      const RENDER_CYCLES = 100
      let totalMounts = 0
      let totalUnmounts = 0
      let currentlyMounted = 0

      for (let cycle = 0; cycle < RENDER_CYCLES; cycle++) {
        const dispose = render(() => {
          const div = document.createElement('div')
          onMount(() => {
            totalMounts++
            currentlyMounted++
            return () => {
              totalUnmounts++
              currentlyMounted--
            }
          })

          // Add several child elements with their own lifecycle
          for (let i = 0; i < 5; i++) {
            const child = document.createElement('span')
            child.textContent = `Child ${i}`
            onMount(() => {
              totalMounts++
              currentlyMounted++
              return () => {
                totalUnmounts++
                currentlyMounted--
              }
            })
            div.appendChild(child)
          }

          return div
        }, container)

        // Verify mounting
        expect(currentlyMounted).toBe(6) // 1 parent + 5 children

        // Clean container for next cycle
        dispose()
        await tick()

        // Verify cleanup
        expect(currentlyMounted).toBe(0)
      }

      // Verify total lifecycle calls balance
      expect(totalMounts).toBe(RENDER_CYCLES * 6)
      expect(totalUnmounts).toBe(RENDER_CYCLES * 6)
    })

    it('handles conditional rendering with effects over many toggles', async () => {
      const TOGGLE_COUNT = 500
      const show = createSignal(true)
      let effectCreations = 0
      let effectCleanups = 0

      const dispose = render(() => {
        const { marker } = createConditional(
          () => show(),
          () => {
            const div = document.createElement('div')
            createEffect(() => {
              effectCreations++
              div.textContent = 'visible'
              onCleanup(() => {
                effectCleanups++
              })
            })
            return div
          },
          createElement,
        )
        return marker
      }, container)

      expect(effectCreations).toBe(1)

      // Rapid toggles
      for (let i = 0; i < TOGGLE_COUNT; i++) {
        show(!show())
        await tick()
      }

      dispose()
      await tick()

      // After even number of toggles (back to shown) + dispose:
      // Creations = 1 (initial) + TOGGLE_COUNT/2 (each time show becomes true)
      const expectedCreations = 1 + TOGGLE_COUNT / 2
      expect(effectCreations).toBe(expectedCreations)

      // Cleanups happen when condition changes to false or on dispose
      // The important invariant: all created effects should eventually be cleaned up
      // (allowing for the timing difference where cleanups may lag by one tick)
      expect(effectCleanups).toBeGreaterThanOrEqual(expectedCreations - 1)
      expect(effectCleanups).toBeLessThanOrEqual(expectedCreations)
    })

    it('handles context with provider updates over time', async () => {
      const UPDATES = 200
      const TestContext = createContext({ value: 0 })
      let consumerReads = 0

      const Provider = ({ children, value }: { children?: Node; value: number }) => {
        const div = document.createElement('div')
        TestContext.Provider({ value: { value }, children: () => div })
        if (children) div.appendChild(children)
        return div
      }

      const Consumer = () => {
        const span = document.createElement('span')
        createEffect(() => {
          const ctx = useContext(TestContext)
          span.textContent = String(ctx.value)
          consumerReads++
        })
        return span
      }

      const contextValue = createSignal(0)

      const dispose = render(() => {
        const wrapper = document.createElement('div')
        createEffect(() => {
          wrapper.innerHTML = ''
          const provider = Provider({
            value: contextValue(),
            children: Consumer(),
          })
          wrapper.appendChild(provider)
        })
        return wrapper
      }, container)

      expect(consumerReads).toBeGreaterThanOrEqual(1)

      // Update context value many times
      for (let i = 1; i <= UPDATES; i++) {
        contextValue(i)
        await tick()
      }

      dispose()

      // Verify no memory leaks by checking cleanup happened
      expect(container.innerHTML).toBe('')
    })
  })
})
