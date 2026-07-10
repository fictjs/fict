import { describe, it, expect } from 'vitest'

import {
  createEffect,
  createMemo,
  onCleanup,
  onDestroy,
  onMount,
  render,
  batch,
  untrack,
  createElement,
  Fragment,
  createRoot,
} from '../src/index'
import { setCycleProtectionOptions, createSignal } from '../src/advanced'
import { bindText, bindAttribute, bindProperty, insert } from '../src/internal'
import { registerErrorHandler } from '../src/lifecycle'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('fict runtime', () => {
  it('runs effects when signals change', async () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const seen: number[] = []

    createEffect(() => {
      seen.push(doubled())
    })

    expect(seen).toEqual([0])

    count(1)
    await tick()
    expect(seen).toEqual([0, 2])

    count(5)
    await tick()
    expect(seen).toEqual([0, 2, 10])
  })

  it('runs onCleanup before re-run', async () => {
    const count = createSignal(0)
    const cleanups: number[] = []

    createEffect(() => {
      const current = count()
      onCleanup(() => cleanups.push(current))
    })

    count(1)
    await tick()
    count(2)
    await tick()

    expect(cleanups).toEqual([0, 1])
  })

  it('batches updates to avoid extra effect runs', () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => seen.push(count()))

    batch(() => {
      count(1)
      count(2)
    })

    expect(seen).toEqual([0, 2])
  })

  it('untrack prevents dependency collection', async () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => {
      seen.push(count())
      untrack(() => count())
    })

    count(1)
    await tick()
    expect(seen).toEqual([0, 1])
  })

  it('mounts and cleans up via render lifecycle', () => {
    const container = document.createElement('div')
    let mounted = 0
    let destroyed = 0

    const teardown = render(() => {
      onMount(() => {
        mounted++
        return () => destroyed++
      })
      onDestroy(() => {
        destroyed++
      })
      const node = document.createElement('div')
      node.textContent = 'hello'
      return node
    }, container)

    expect(mounted).toBe(1)
    expect(container.textContent).toBe('hello')

    teardown()

    expect(destroyed).toBe(2)
    expect(container.textContent).toBe('')
  })

  it('supports createRoot utility', () => {
    let cleaned = 0
    const root = createRoot(() => {
      onDestroy(() => {
        cleaned++
      })
      return 42
    })

    expect(root.value).toBe(42)
    root.dispose()
    expect(cleaned).toBe(1)
  })

  it('finishes root teardown when an effect cleanup throws', async () => {
    const trigger = createSignal(0)
    const calls: string[] = []
    let effectRuns = 0

    const root = createRoot(() => {
      onDestroy(() => {
        calls.push('destroy')
      })
      createEffect(() => {
        trigger()
        effectRuns++
        return () => {
          calls.push('effect-cleanup')
          throw new Error('cleanup boom')
        }
      })
      onCleanup(() => {
        calls.push('root-cleanup')
      })
    })

    expect(() => root.dispose()).toThrow('cleanup boom')
    expect(calls).toEqual(['root-cleanup', 'effect-cleanup', 'destroy'])

    trigger(1)
    await tick()
    expect(effectRuns).toBe(1)
  })

  it('rethrows undefined cleanup failures after completing root teardown', () => {
    const calls: string[] = []
    const root = createRoot(() => {
      onDestroy(() => {
        calls.push('destroy')
      })
      onCleanup(() => {
        calls.push('cleanup-after')
      })
      onCleanup(() => {
        calls.push('cleanup-throw')
        throw undefined
      })
      onCleanup(() => {
        calls.push('cleanup-before')
      })
    })

    let didThrow = false
    let thrown: unknown = Symbol('not thrown')
    try {
      root.dispose()
    } catch (error) {
      didThrow = true
      thrown = error
    }

    expect(didThrow).toBe(true)
    expect(thrown).toBeUndefined()
    expect(calls).toEqual(['cleanup-before', 'cleanup-throw', 'cleanup-after', 'destroy'])
  })

  it('rethrows undefined onDestroy failures after running remaining callbacks', () => {
    const calls: string[] = []
    const root = createRoot(() => {
      onDestroy(() => {
        calls.push('destroy-after')
      })
      onDestroy(() => {
        calls.push('destroy-throw')
        throw undefined
      })
      onDestroy(() => {
        calls.push('destroy-before')
      })
    })

    let didThrow = false
    try {
      root.dispose()
    } catch (error) {
      didThrow = true
      expect(error).toBeUndefined()
    }

    expect(didThrow).toBe(true)
    expect(calls).toEqual(['destroy-before', 'destroy-throw', 'destroy-after'])
  })

  it('cleans up createRoot effects when setup throws', async () => {
    const trigger = createSignal(0)
    let runs = 0
    let rootCleanups = 0
    let destroyed = 0

    expect(() => {
      createRoot(() => {
        createEffect(() => {
          trigger()
          runs++
        })
        onCleanup(() => {
          rootCleanups++
        })
        onDestroy(() => {
          destroyed++
        })
        throw new Error('root boom')
      })
    }).toThrow('root boom')

    expect(runs).toBe(1)
    expect(rootCleanups).toBe(1)
    expect(destroyed).toBe(1)

    trigger(1)
    await tick()

    expect(runs).toBe(1)
  })

  it('cleans up createRoot effects when mount flushing throws', async () => {
    const trigger = createSignal(0)
    let runs = 0
    let mountCleanups = 0
    let destroyed = 0

    expect(() => {
      createRoot(() => {
        createEffect(() => {
          trigger()
          runs++
        })
        onDestroy(() => {
          destroyed++
        })
        onMount(() => {
          return () => {
            mountCleanups++
          }
        })
        onMount(() => {
          throw new Error('mount boom')
        })
      })
    }).toThrow('mount boom')

    expect(runs).toBe(1)
    expect(mountCleanups).toBe(1)
    expect(destroyed).toBe(1)

    trigger(1)
    await tick()

    expect(runs).toBe(1)
  })

  it('does not leak failed inherited createRoot handlers', async () => {
    const trigger = createSignal(0)
    const calls: string[] = []

    const root = createRoot(() => {
      registerErrorHandler(() => {
        calls.push('parent')
        return true
      })

      expect(() => {
        createRoot(
          () => {
            registerErrorHandler(() => {
              calls.push('child')
              return true
            })
            createEffect(() => {
              if (trigger()) {
                throw new Error('child later')
              }
            })
            throw new Error('child setup')
          },
          { inherit: true },
        )
      }).toThrow('child setup')

      createEffect(() => {
        if (trigger()) {
          throw new Error('parent later')
        }
      })
    })

    trigger(1)
    await tick()

    expect(calls).toEqual(['parent'])
    root.dispose()
  })

  it('isolates createRoot by default', () => {
    const calls: string[] = []
    let caught: unknown

    createRoot(() => {
      registerErrorHandler(() => {
        calls.push('parent')
        return true
      })
      try {
        createRoot(() => {
          createEffect(() => {
            throw new Error('boom')
          })
        })
      } catch (err) {
        caught = err
      }
    })

    expect(calls).toEqual([])
    expect(caught).toBeInstanceOf(Error)
  })

  it('inherits error handlers when createRoot inherit is true', () => {
    const calls: string[] = []

    createRoot(() => {
      registerErrorHandler(() => {
        calls.push('parent')
        return true
      })
      createRoot(
        () => {
          createEffect(() => {
            throw new Error('boom')
          })
        },
        { inherit: true },
      )
    })

    expect(calls).toEqual(['parent'])
  })

  it('creates fragments and keeps falsy numeric children', () => {
    const frag = createElement({
      type: Fragment,
      props: { children: [0, 'a'] },
      key: undefined,
    })

    expect(frag.childNodes).toHaveLength(2)
    expect((frag.childNodes[0] as Text).textContent).toBe('0')
  })

  it('updates DOM via effects', async () => {
    const container = document.createElement('div')
    const div = document.createElement('div')
    const count = createSignal(0)

    createEffect(() => {
      div.textContent = String(count())
    })

    container.appendChild(div)
    expect(div.textContent).toBe('0')

    count(2)
    await tick()
    expect(div.textContent).toBe('2')
  })

  it('bindText updates a text node reactively', async () => {
    const text = document.createTextNode('')
    const count = createSignal(1)
    bindText(text, () => count())
    expect(text.textContent).toBe('1')
    count(5)
    await tick()
    expect(text.textContent).toBe('5')
  })

  it('bindAttribute and bindProperty update DOM reactively', async () => {
    const el = document.createElement('input')
    const value = createSignal('a')
    const checked = createSignal(false)

    bindAttribute(el, 'data-value', () => value())
    bindProperty(el, 'checked', () => checked())

    expect(el.getAttribute('data-value')).toBe('a')
    expect(el.checked).toBe(false)

    value('b')
    checked(true)
    await tick()

    expect(el.getAttribute('data-value')).toBe('b')
    expect(el.checked).toBe(true)
  })

  it('bindProperty clears nullish values with sensible defaults', async () => {
    const el = document.createElement('input')
    const value = createSignal<string | undefined>('a')
    const checked = createSignal<boolean | undefined>(true)

    bindProperty(el, 'value', () => value())
    bindProperty(el, 'checked', () => checked())

    expect(el.value).toBe('a')
    expect(el.checked).toBe(true)

    value(undefined)
    checked(undefined)
    await tick()

    expect(el.value).toBe('')
    expect(el.checked).toBe(false)
  })

  it('insert swaps child nodes reactively', async () => {
    const parent = document.createElement('div')
    const toggle = createSignal(true)
    insert(parent, () => (toggle() ? 'yes' : document.createElement('span')))

    expect(parent.textContent).toBe('yes')
    toggle(false)
    await tick()
    expect(parent.firstChild instanceof HTMLElement).toBe(true)
  })

  it('runs lifecycles in nested components within render', () => {
    const container = document.createElement('div')
    const calls: string[] = []

    const Child = () => {
      onMount(() => calls.push('child-mount'))
      onDestroy(() => calls.push('child-destroy'))
      return document.createElement('span')
    }

    const dispose = render(() => {
      onMount(() => calls.push('root-mount'))
      onDestroy(() => calls.push('root-destroy'))
      return { type: Child, props: null, key: undefined }
    }, container)

    expect(calls).toEqual(['root-mount', 'child-mount'])
    dispose()
    expect(calls).toEqual(['root-mount', 'child-mount', 'child-destroy', 'root-destroy'])
  })

  it('exposes cycle protection configuration', () => {
    expect(typeof setCycleProtectionOptions).toBe('function')
  })

  it('exposes jsx-dev-runtime entrypoint', async () => {
    const mod = await import('../src/jsx-dev-runtime')
    expect(mod.jsxDEV).toBeTypeOf('function')
    expect(mod.Fragment).toBeDefined()
  })
})
