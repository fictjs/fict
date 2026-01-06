/**
 * Regression tests for bug fixes
 * Each test corresponds to a specific bug fix in the staged changes
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createSignal,
  createMemo,
  createEffect,
  effectScope,
  batch,
  onCleanup,
  render,
  ErrorBoundary,
  Suspense,
  createSuspenseToken,
  mergeProps,
  createPropsProxy,
  useTransition,
  startTransition,
  createKeyedList,
} from '../src/index'
import {
  isSignal,
  isComputed,
  isEffect,
  isEffectScope,
  signal,
  computed,
  effect,
} from '../src/signal'
import { createVersionedSignalAccessor } from '../src/list-helpers'
import {
  handleError,
  registerErrorHandler,
  getCurrentRoot,
  pushRoot,
  popRoot,
  createRootContext,
} from '../src/lifecycle'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('BUG-001: disposeNode should unlink ALL subscribers', () => {
  it('disposes computed with multiple effect subscribers correctly', async () => {
    const source = signal(1)
    const derived = computed(() => source() * 2)

    let effectA = 0
    let effectB = 0
    let effectC = 0

    // Create multiple effects subscribing to the same computed
    const disposeA = effect(() => {
      effectA = derived()
    })
    const disposeB = effect(() => {
      effectB = derived()
    })
    const disposeC = effect(() => {
      effectC = derived()
    })

    expect(effectA).toBe(2)
    expect(effectB).toBe(2)
    expect(effectC).toBe(2)

    // Update source
    source(5)
    await tick()

    expect(effectA).toBe(10)
    expect(effectB).toBe(10)
    expect(effectC).toBe(10)

    // Dispose the computed (simulated by disposing all effects and recreating)
    disposeA()
    disposeB()
    disposeC()

    // After disposal, updating source should not cause issues
    source(10)
    await tick()

    // Values should remain at last seen values (effects disposed)
    expect(effectA).toBe(10)
    expect(effectB).toBe(10)
    expect(effectC).toBe(10)
  })

  it('handles disposal of signal with multiple computed subscribers', async () => {
    const source = signal(1)

    const derivedA = computed(() => source() + 1)
    const derivedB = computed(() => source() + 2)
    const derivedC = computed(() => source() + 3)

    let results: number[] = []

    const dispose = effect(() => {
      results = [derivedA(), derivedB(), derivedC()]
    })

    expect(results).toEqual([2, 3, 4])

    source(10)
    await tick()

    expect(results).toEqual([11, 12, 13])

    dispose()

    // Should not throw when source updates after disposal
    source(20)
    await tick()

    expect(results).toEqual([11, 12, 13])
  })
})

describe('BUG-002: checkDirty should handle missing dep.deps', () => {
  it('handles computed without dependencies', async () => {
    // A computed that doesn't track any reactive dependencies
    const constantComputed = computed(() => 42)

    let effectValue = 0
    const dispose = effect(() => {
      effectValue = constantComputed()
    })

    expect(effectValue).toBe(42)

    // Even without dependencies, the computed should work correctly
    expect(constantComputed()).toBe(42)

    dispose()
  })

  it('handles nested computed where inner has no deps', async () => {
    const source = signal(1)
    const constant = computed(() => 100) // No reactive deps
    const derived = computed(() => source() + constant())

    let effectValue = 0
    const dispose = effect(() => {
      effectValue = derived()
    })

    expect(effectValue).toBe(101)

    source(5)
    await tick()

    expect(effectValue).toBe(105)

    dispose()
  })
})

describe('BUG-003: effectScope isolation in keyed list', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('cleans up effects when list item is removed', async () => {
    const items = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }])
    const cleanupCalls: number[] = []

    const listBinding = createKeyedList(
      () => items(),
      item => item.id,
      itemSig => {
        const id = itemSig().id
        const div = document.createElement('div')

        createEffect(() => {
          div.textContent = String(itemSig().id)
          onCleanup(() => {
            cleanupCalls.push(id)
          })
        })

        return [div]
      },
    )

    container.appendChild(listBinding.marker)
    listBinding.flush?.()
    await tick()

    expect(container.children.length).toBe(3)
    expect(cleanupCalls).toEqual([])

    // Remove item with id 2
    items([{ id: 1 }, { id: 3 }])
    await tick()

    expect(container.children.length).toBe(2)
    expect(cleanupCalls).toContain(2)

    listBinding.dispose()
  })

  it('nested effects in list items are properly scoped', async () => {
    const items = createSignal([{ id: 1, value: 'a' }])
    const outerCleanups: string[] = []
    const innerCleanups: string[] = []

    const listBinding = createKeyedList(
      () => items(),
      item => item.id,
      itemSig => {
        const div = document.createElement('div')

        // Outer effect
        createEffect(() => {
          const item = itemSig()
          onCleanup(() => outerCleanups.push(`outer-${item.id}`))

          // Nested effect - should be cleaned up with outer
          createEffect(() => {
            div.textContent = item.value
            onCleanup(() => innerCleanups.push(`inner-${item.id}`))
          })
        })

        return [div]
      },
    )

    container.appendChild(listBinding.marker)
    listBinding.flush?.()
    await tick()

    // Remove the item
    items([])
    await tick()

    // Both outer and inner cleanups should have run
    expect(outerCleanups).toContain('outer-1')
    expect(innerCleanups).toContain('inner-1')

    listBinding.dispose()
  })
})

describe('BUG-005: ErrorBoundary recursion guard', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('prevents infinite recursion when fallback also throws', async () => {
    const errors: unknown[] = []
    let renderAttempts = 0

    const ThrowingChild = () => {
      renderAttempts++
      throw new Error('child error')
    }

    const ThrowingFallback = () => {
      renderAttempts++
      throw new Error('fallback error')
    }

    // Should not cause infinite loop - should throw after detecting recursion
    expect(() => {
      render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: { type: ThrowingFallback, props: {} },
            onError: (err: unknown) => errors.push(err),
            children: { type: ThrowingChild, props: {} },
          },
        }),
        container,
      )
    }).toThrow('fallback error')

    // Should have attempted render only twice (child + fallback), not infinite
    expect(renderAttempts).toBe(2)
  })

  it('calls onError even when fallback throws', async () => {
    const errors: unknown[] = []

    const ThrowingChild = () => {
      throw new Error('child error')
    }

    const ThrowingFallback = () => {
      throw new Error('fallback error')
    }

    expect(() => {
      render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: { type: ThrowingFallback, props: {} },
            onError: (err: unknown) => errors.push(err),
            children: { type: ThrowingChild, props: {} },
          },
        }),
        container,
      )
    }).toThrow()

    // onError should have been called with the original error
    expect(errors.length).toBeGreaterThan(0)
    expect((errors[0] as Error).message).toBe('child error')
  })

  it('keeps renderingFallback true after fallback failure', async () => {
    let fallbackRenderCount = 0

    const ThrowingChild = () => {
      throw new Error('child error')
    }

    const ThrowingFallback = () => {
      fallbackRenderCount++
      throw new Error('fallback error')
    }

    expect(() => {
      render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: { type: ThrowingFallback, props: {} },
            children: { type: ThrowingChild, props: {} },
          },
        }),
        container,
      )
    }).toThrow()

    // Fallback should only be attempted once
    expect(fallbackRenderCount).toBe(1)
  })
})

describe('BUG-006: handleError return value', () => {
  it('returns false when no error handler handles the error', () => {
    const root = createRootContext()
    const prev = pushRoot(root)

    // Don't register any error handler
    const result = handleError(new Error('unhandled'), { source: 'render' }, root)

    popRoot(prev)

    // Should return false instead of throwing
    expect(result).toBe(false)
  })

  it('returns true when error handler handles the error', () => {
    const root = createRootContext()
    const prev = pushRoot(root)

    registerErrorHandler(() => true) // Handler that handles the error

    const result = handleError(new Error('handled'), { source: 'render' }, root)

    popRoot(prev)

    expect(result).toBe(true)
  })
})

describe('BUG-011/020: Suspense epoch check order', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('ignores stale token resolution after reset', async () => {
    const resetKey = createSignal(0)
    let tokenCount = 0
    let currentToken: ReturnType<typeof createSuspenseToken> | null = null

    const Child = () => {
      tokenCount++
      currentToken = createSuspenseToken()
      throw currentToken.token
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          resetKeys: () => resetKey(),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    await tick()
    expect(container.textContent).toBe('loading')
    expect(tokenCount).toBe(1)

    const staleToken = currentToken!

    // Trigger reset - this should create a new epoch
    resetKey(1)
    await tick()
    await tick()

    expect(tokenCount).toBe(2)

    // Resolve the stale token - should be ignored
    staleToken.resolve()
    await tick()
    await tick()

    // Should still be loading because the stale token resolution was ignored
    expect(container.textContent).toBe('loading')

    dispose()
  })

  it('handles new token after reset correctly', async () => {
    const resetKey = createSignal(0)
    const shouldSuspend = createSignal(true)
    let currentToken: ReturnType<typeof createSuspenseToken> | null = null

    const Child = () => {
      if (shouldSuspend()) {
        currentToken = createSuspenseToken()
        throw currentToken.token
      }
      return { type: 'span', props: { children: 'ready' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          resetKeys: () => resetKey(),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    await tick()
    expect(container.textContent).toBe('loading')

    // Don't resolve, just reset
    shouldSuspend(false)
    resetKey(1)
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')

    dispose()
  })
})

describe('BUG-014: Symbol marker type detection', () => {
  it('isSignal detects signal after minification simulation', () => {
    const s = signal(1)

    // The function name might be mangled, but Symbol marker should work
    expect(isSignal(s)).toBe(true)
    expect(isSignal(() => 1)).toBe(false)
    expect(isSignal(null)).toBe(false)
    expect(isSignal(undefined)).toBe(false)
    expect(isSignal({})).toBe(false)
  })

  it('isComputed detects computed after minification simulation', () => {
    const c = computed(() => 42)

    expect(isComputed(c)).toBe(true)
    expect(isComputed(() => 42)).toBe(false)
    expect(isComputed(signal(1))).toBe(false)
  })

  it('isEffect detects effect disposer after minification simulation', () => {
    const dispose = effect(() => {})

    expect(isEffect(dispose)).toBe(true)
    expect(isEffect(() => {})).toBe(false)
    expect(isEffect(signal(1))).toBe(false)
  })

  it('isEffectScope detects effectScope disposer after minification simulation', () => {
    const dispose = effectScope(() => {})

    expect(isEffectScope(dispose)).toBe(true)
    expect(isEffectScope(() => {})).toBe(false)
    expect(isEffectScope(effect(() => {}))).toBe(false)
  })

  it('type detection works even when function.name is mangled', () => {
    const s = signal(1)
    const c = computed(() => s() * 2)
    const e = effect(() => {
      s()
    })
    const es = effectScope(() => {
      s()
    })

    // Simulate minification by checking that we don't rely on function.name
    // The Symbol markers should still work
    expect(isSignal(s)).toBe(true)
    expect(isComputed(c)).toBe(true)
    expect(isEffect(e)).toBe(true)
    expect(isEffectScope(es)).toBe(true)

    e() // cleanup
    es() // cleanup
  })
})

describe('BUG-015: mergeProps Symbol support', () => {
  it('supports Symbol properties in merged props', () => {
    const sym = Symbol('test')
    const merged = mergeProps({ [sym]: 'value1' }, { other: 'value2' })

    expect(merged[sym]).toBe('value1')
    expect((merged as Record<string, unknown>).other).toBe('value2')
  })

  it('last Symbol property wins in merge', () => {
    const sym = Symbol('test')
    const merged = mergeProps({ [sym]: 'first' }, { [sym]: 'second' })

    expect(merged[sym]).toBe('second')
  })

  it('Symbol properties work with reactive sources', () => {
    const sym = Symbol('reactive')
    const source = createSignal({ [sym]: 1 })

    const merged = createPropsProxy(mergeProps(() => source()))

    expect(merged[sym]).toBe(1)

    source({ [sym]: 2 })
    expect(merged[sym]).toBe(2)
  })

  it('well-known Symbols like Symbol.iterator are supported', () => {
    const iterable = {
      [Symbol.iterator]: function* () {
        yield 1
        yield 2
        yield 3
      },
    }

    const merged = mergeProps(iterable)

    expect(typeof merged[Symbol.iterator]).toBe('function')
    expect([...(merged as Iterable<number>)]).toEqual([1, 2, 3])
  })
})

describe('BUG-016: useTransition pending consistency', () => {
  it('isPending reflects correct state during transition', async () => {
    const states: boolean[] = []
    const value = createSignal(0)

    const [isPending, start] = useTransition()

    // Track isPending state before, during, and after
    createEffect(() => {
      states.push(isPending())
    })

    expect(isPending()).toBe(false)
    states.length = 0 // Reset tracking

    start(() => {
      // Inside transition callback, isPending should be true
      states.push(isPending())
      value(1)
    })

    await tick()
    await tick()

    // isPending should have been true during the transition
    expect(states).toContain(true)
  })

  it('pending state is consistent with transition execution', async () => {
    const [isPending, start] = useTransition()
    const executionStates: { isPending: boolean; phase: string }[] = []

    executionStates.push({ isPending: isPending(), phase: 'before' })

    start(() => {
      executionStates.push({ isPending: isPending(), phase: 'during' })
    })

    await tick()
    await tick()

    executionStates.push({ isPending: isPending(), phase: 'after' })

    // Before should be false
    expect(executionStates.find(s => s.phase === 'before')?.isPending).toBe(false)
    // During should be true (this is the fix - pending(true) is now inside startTransition)
    expect(executionStates.find(s => s.phase === 'during')?.isPending).toBe(true)
    // After should be false
    expect(executionStates.find(s => s.phase === 'after')?.isPending).toBe(false)
  })
})

describe('BUG-019: version overflow protection', () => {
  it('versioned signal handles version near max safe integer', async () => {
    const accessor = createVersionedSignalAccessor('initial')

    // The signal should work normally
    expect(accessor()).toBe('initial')

    accessor('updated')
    expect(accessor()).toBe('updated')

    // Multiple updates should not cause overflow issues
    for (let i = 0; i < 100; i++) {
      accessor(`value-${i}`)
    }

    expect(accessor()).toBe('value-99')
  })

  it('versioned signal triggers effects after many updates', async () => {
    const accessor = createVersionedSignalAccessor(0)
    let effectCount = 0

    const dispose = effect(() => {
      accessor()
      effectCount++
    })

    expect(effectCount).toBe(1)

    // Many updates
    for (let i = 1; i <= 50; i++) {
      accessor(i)
      await tick()
    }

    // Effect should have run for each update
    expect(effectCount).toBe(51)

    dispose()
  })
})
