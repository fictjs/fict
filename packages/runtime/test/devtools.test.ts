import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSuspenseToken,
  render,
} from '../src/index'
import {
  FICT_DEVTOOLS_MIN_PROTOCOL_VERSION,
  FICT_DEVTOOLS_PROTOCOL_VERSION,
  createSignal,
  getDevtoolsHook,
  isDevtoolsHookCompatible,
} from '../src/advanced'
import { registerSuspenseHandler } from '../src/lifecycle'

const tick = () => Promise.resolve()

describe('devtools hook integration', () => {
  let original: unknown
  let events: string[]
  let componentEvents: Array<{
    type: 'component:register' | 'component:render' | 'component:mount'
    id: number
    name?: string
    elements?: HTMLElement[]
  }>
  let lifecycleEvents: string[]
  let dependencyEvents: string[]
  let effectRunDurations: number[]
  let rootEvents: Array<{
    type: 'root:register' | 'root:dispose' | 'root:suspend'
    id: number
    suspended?: boolean
  }>
  let container: HTMLElement

  beforeEach(() => {
    original = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    events = []
    componentEvents = []
    lifecycleEvents = []
    dependencyEvents = []
    effectRunDurations = []
    rootEvents = []
    container = document.createElement('div')
    document.body.appendChild(container)
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = {
      registerSignal: (id: number, value: unknown) => {
        events.push(`signal:${id}:register:${String(value)}`)
      },
      updateSignal: (id: number, value: unknown) => {
        events.push(`signal:${id}:update:${String(value)}`)
      },
      registerComputed: (id: number, value: unknown) => {
        events.push(`computed:${id}:register:${String(value)}`)
      },
      updateComputed: (id: number, value: unknown) => {
        events.push(`computed:${id}:update:${String(value)}`)
      },
      registerEffect: (id: number) => {
        events.push(`effect:${id}:register`)
      },
      effectRun: (id: number, duration?: number) => {
        events.push(`effect:${id}:run`)
        if (typeof duration === 'number') {
          effectRunDurations.push(duration)
        }
      },
      disposeComputed: (id: number) => {
        lifecycleEvents.push(`computed:${id}:dispose`)
      },
      effectCleanup: (id: number) => {
        lifecycleEvents.push(`effect:${id}:cleanup`)
      },
      disposeEffect: (id: number) => {
        lifecycleEvents.push(`effect:${id}:dispose`)
      },
      trackDependency: (subscriberId: number, dependencyId: number) => {
        dependencyEvents.push(`track:${subscriberId}:${dependencyId}`)
      },
      untrackDependency: (subscriberId: number, dependencyId: number) => {
        dependencyEvents.push(`untrack:${subscriberId}:${dependencyId}`)
      },
      batchStart: () => {
        lifecycleEvents.push('batch:start')
      },
      batchEnd: () => {
        lifecycleEvents.push('batch:end')
      },
      flushStart: () => {
        lifecycleEvents.push('flush:start')
      },
      flushEnd: () => {
        lifecycleEvents.push('flush:end')
      },
      registerRoot: (id: number) => {
        rootEvents.push({ type: 'root:register', id })
      },
      disposeRoot: (id: number) => {
        rootEvents.push({ type: 'root:dispose', id })
      },
      rootSuspend: (id: number, suspended: boolean) => {
        rootEvents.push({ type: 'root:suspend', id, suspended })
      },
      registerComponent: (id: number, name: string) => {
        componentEvents.push({ type: 'component:register', id, name })
      },
      componentRender: (id: number) => {
        componentEvents.push({ type: 'component:render', id })
      },
      componentMount: (id: number, elements?: HTMLElement[]) => {
        componentEvents.push({ type: 'component:mount', id, elements })
      },
    }
  })

  afterEach(() => {
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = original
    container.remove()
  })

  it('emits devtools events for signal and effect', () => {
    const count = createSignal(0)
    createEffect(() => {
      count()
    })

    const signalRegisterEvent = events.find(
      event => event.startsWith('signal:') && event.includes(':register:0'),
    )
    expect(signalRegisterEvent).toBeDefined()
    const signalId = Number(signalRegisterEvent!.split(':')[1])
    expect(Number.isFinite(signalId)).toBe(true)

    expect(events.some(e => e.startsWith('effect:') && e.endsWith(':register'))).toBe(true)
    expect(events.filter(e => e.endsWith(':run')).length).toBeGreaterThan(0)

    count(1)
    expect(events.some(e => e === `signal:${signalId}:update:1`)).toBe(true)
  })

  it('preserves the public raw hook identity and supports partial legacy hooks', () => {
    const calls: string[] = []
    const hook = {
      registerSignal: (id: number) => calls.push(`signal:${id}`),
      registerEffect: (id: number) => calls.push(`effect:${id}`),
    }
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = hook

    expect(getDevtoolsHook()).toBe(hook)
    const value = createSignal(0)
    expect(() => createEffect(() => value())).not.toThrow()
    expect(calls.some(call => call.startsWith('signal:'))).toBe(true)
    expect(calls.some(call => call.startsWith('effect:'))).toBe(true)
  })

  it('keeps safe hook methods bound to the raw hook and observes replacements', () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const receivers: unknown[] = []
    const versions: string[] = []
    const value = createSignal(0)
    hook.updateSignal = function (this: unknown) {
      receivers.push(this)
      versions.push('first')
    }

    value(1)
    hook.updateSignal = function (this: unknown) {
      receivers.push(this)
      versions.push('second')
    }
    value(2)

    expect(receivers).toEqual([hook, hook])
    expect(versions).toEqual(['first', 'second'])
  })

  it('isolates throwing required-method and compatibility getters', async () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const error = new Error('observer getter failed')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = createSignal(0)
    const seen: number[] = []
    createEffect(() => seen.push(value()))
    Object.defineProperty(hook, 'updateSignal', {
      configurable: true,
      get: () => {
        throw error
      },
    })

    try {
      expect(() => value(1)).not.toThrow()
      await tick()
      expect(seen).toEqual([0, 1])

      Object.defineProperty(hook, 'devtools', {
        configurable: true,
        get: () => {
          throw error
        },
      })
      expect(() => createSignal(2)).not.toThrow()
      expect(
        errorSpy.mock.calls.some(([message]) =>
          String(message).includes('Hook method "compatibility" failed'),
        ),
      ).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('isolates scheduler and signal hook failures from reactive state', async () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const error = new Error('observer failed')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hook.batchStart = () => {
      throw error
    }
    hook.batchEnd = () => {
      throw error
    }
    hook.flushStart = () => {
      throw error
    }
    hook.flushEnd = () => {
      throw error
    }
    hook.updateSignal = () => {
      throw error
    }

    try {
      const value = createSignal(0)
      const seen: number[] = []
      createEffect(() => seen.push(value()))

      expect(() => batch(() => value(1))).not.toThrow()
      expect(seen).toEqual([0, 1])

      value(2)
      await tick()
      expect(seen).toEqual([0, 1, 2])

      for (const method of ['batchStart', 'batchEnd', 'flushStart', 'flushEnd', 'updateSignal']) {
        expect(
          errorSpy.mock.calls.some(([message]) =>
            String(message).includes(`Hook method "${method}" failed`),
          ),
        ).toBe(true)
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('isolates component hook throws and async rejections', async () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const error = new Error('component observer failed')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hook.registerComponent = () => {
      throw error
    }
    hook.componentRender = () => {
      throw error
    }
    hook.componentMount = async () => {
      throw error
    }
    hook.componentUnmount = () => {
      throw error
    }
    hook.registerRoot = () => {
      throw error
    }
    hook.disposeRoot = () => {
      throw error
    }

    function Demo() {
      const div = document.createElement('div')
      div.textContent = 'safe'
      return div
    }

    try {
      let dispose = () => {}
      expect(() => {
        dispose = render(() => ({ type: Demo, props: {}, key: undefined }) as any, container)
      }).not.toThrow()
      expect(container.textContent).toBe('safe')

      await tick()
      expect(() => dispose()).not.toThrow()

      for (const method of [
        'registerRoot',
        'disposeRoot',
        'registerComponent',
        'componentRender',
        'componentMount',
        'componentUnmount',
      ]) {
        expect(
          errorSpy.mock.calls.some(([message]) =>
            String(message).includes(`Hook method "${method}" failed`),
          ),
        ).toBe(true)
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('isolates effect lifecycle and dependency-untrack hook failures', async () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const error = new Error('reactive observer failed')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hook.effectRun = () => {
      throw error
    }
    hook.effectCleanup = () => {
      throw error
    }
    hook.untrackDependency = () => {
      throw error
    }

    try {
      const useFirst = createSignal(true)
      const first = createSignal(0)
      const second = createSignal(0)
      let runs = 0
      let cleanups = 0
      const stop = createEffect(() => {
        runs++
        if (useFirst()) first()
        else second()
        return () => {
          cleanups++
        }
      })

      useFirst(false)
      await tick()
      expect(runs).toBe(2)
      expect(cleanups).toBe(1)

      first(1)
      await tick()
      expect(runs).toBe(2)

      second(1)
      await tick()
      expect(runs).toBe(3)

      expect(() => stop()).not.toThrow()
      expect(cleanups).toBe(3)
      for (const method of ['effectRun', 'effectCleanup', 'untrackDependency']) {
        expect(
          errorSpy.mock.calls.some(([message]) =>
            String(message).includes(`Hook method "${method}" failed`),
          ),
        ).toBe(true)
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not turn handled suspension into an error when rootSuspend fails', () => {
    const hook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hook.rootSuspend = () => {
      throw new Error('suspense observer failed')
    }
    const source = createSignal(false)
    const { token, resolve } = createSuspenseToken()
    let handled = 0

    try {
      const root = createRoot(() => {
        registerSuspenseHandler(() => {
          handled++
          return true
        })
        createEffect(() => {
          if (source()) throw token
        })
      })

      expect(() => batch(() => source(true))).not.toThrow()
      expect(handled).toBe(1)
      expect(
        errorSpy.mock.calls.some(([message]) =>
          String(message).includes('Hook method "rootSuspend" failed'),
        ),
      ).toBe(true)

      resolve()
      root.dispose()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('ignores hooks outside the runtime devtools protocol range', () => {
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__.devtools = {
      protocolVersion: 1,
      minRuntimeProtocol: 99,
      maxRuntimeProtocol: 99,
    }

    const count = createSignal(0)
    count(1)

    expect(events).toEqual([])
  })

  it('checks hook compatibility against the current runtime protocol', () => {
    const hook = {
      ...(globalThis as any).__FICT_DEVTOOLS_HOOK__,
      devtools: {
        protocolVersion: 1,
        minRuntimeProtocol: FICT_DEVTOOLS_MIN_PROTOCOL_VERSION,
        maxRuntimeProtocol: FICT_DEVTOOLS_MIN_PROTOCOL_VERSION,
      },
    }

    expect(isDevtoolsHookCompatible(hook)).toBe(
      FICT_DEVTOOLS_MIN_PROTOCOL_VERSION === FICT_DEVTOOLS_PROTOCOL_VERSION,
    )
  })

  it('does not emit devtools computed registration for internal memos', () => {
    createMemo(() => 1)
    createMemo(() => 2, { internal: true })

    const computedRegisters = events.filter(
      event => event.startsWith('computed:') && event.includes(':register:'),
    )
    expect(computedRegisters).toHaveLength(1)
  })

  it('tracks component render/mount and annotates root elements for inspection', () => {
    function Demo() {
      const div = document.createElement('div')
      div.textContent = 'demo'
      return div
    }

    const teardown = render(
      () =>
        ({
          type: Demo,
          props: {},
          key: undefined,
        }) as any,
      container,
    )

    const registerEvent = componentEvents.find(event => event.type === 'component:register')
    expect(registerEvent).toBeDefined()
    const componentId = registerEvent!.id

    expect(
      componentEvents.some(event => event.type === 'component:render' && event.id === componentId),
    ).toBe(true)
    expect(
      componentEvents.some(event => event.type === 'component:mount' && event.id === componentId),
    ).toBe(true)

    const rootElement = container.querySelector('div') as
      | (HTMLElement & {
          __fict_component_id__?: number
          __fict_component_name__?: string
        })
      | null
    expect(rootElement).toBeTruthy()
    expect(rootElement?.getAttribute('data-fict-component')).toBe('Demo')
    expect(rootElement?.getAttribute('data-fict-component-id')).toBe(String(componentId))
    expect(rootElement?.__fict_component_id__).toBe(componentId)
    expect(rootElement?.__fict_component_name__).toBe('Demo')

    const mountEvent = componentEvents.find(
      event => event.type === 'component:mount' && event.id === componentId,
    )
    expect(mountEvent?.elements?.[0]).toBe(rootElement)

    teardown()
  })

  it('emits batch/flush and disposal lifecycle events for reactive nodes', () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const dispose = createEffect(() => {
      doubled()
      return () => {}
    })

    batch(() => {
      count(1)
    })

    expect(lifecycleEvents).toContain('batch:start')
    expect(lifecycleEvents).toContain('batch:end')
    expect(lifecycleEvents).toContain('flush:start')
    expect(lifecycleEvents).toContain('flush:end')
    expect(lifecycleEvents.some(event => event.includes(':cleanup'))).toBe(true)

    dispose()

    expect(
      lifecycleEvents.some(event => event.includes('effect:') && event.endsWith(':dispose')),
    ).toBe(true)
  })

  it('emits computed disposal when its owning root is disposed', () => {
    const { dispose } = createRoot(() => {
      const value = createSignal(1)
      const memo = createMemo(() => value() * 2)
      expect(memo()).toBe(2)
    })
    const registration = events.find(
      event => event.startsWith('computed:') && event.includes(':register:'),
    )
    const signalRegistration = events.find(
      event => event.startsWith('signal:') && event.includes(':register:1'),
    )
    const computedId = Number(registration?.split(':')[1])
    const signalId = Number(signalRegistration?.split(':')[1])

    expect(Number.isFinite(computedId)).toBe(true)
    expect(Number.isFinite(signalId)).toBe(true)
    expect(dependencyEvents).toContain(`track:${computedId}:${signalId}`)
    dispose()

    expect(lifecycleEvents).toContain(`computed:${computedId}:dispose`)
    expect(dependencyEvents).toContain(`untrack:${computedId}:${signalId}`)
  })

  it('untracks computed dependencies collected after reentrant owner disposal', () => {
    const innerSource = createSignal(10)
    const trigger = createSignal(0)
    const inner = createMemo(() => innerSource())
    let outer!: () => number
    let disposeOwner = () => {}

    const owner = createRoot(() => {
      outer = createMemo(() => {
        const value = trigger()
        if (value === 1) {
          disposeOwner()
          return inner()
        }
        return value
      })
      expect(outer()).toBe(0)
    })
    disposeOwner = owner.dispose

    const innerRegistration = events.find(
      event => event.startsWith('computed:') && event.includes(':register:'),
    )
    const sourceRegistration = events.find(
      event => event.startsWith('signal:') && event.includes(':register:10'),
    )
    const innerId = Number(innerRegistration?.split(':')[1])
    const sourceId = Number(sourceRegistration?.split(':')[1])
    dependencyEvents.length = 0

    trigger(1)
    expect(outer()).toBe(10)

    expect(dependencyEvents).toContain(`track:${innerId}:${sourceId}`)
    expect(dependencyEvents).toContain(`untrack:${innerId}:${sourceId}`)
  })

  it('reports non-negative effect run duration in devtools hook', () => {
    const count = createSignal(0)
    createEffect(() => {
      // Keep a tiny synchronous workload so duration is measurable.
      let total = 0
      for (let i = 0; i < 2000; i++) total += i
      if (total < 0) count()
      count()
    })

    count(1)
    expect(effectRunDurations.length).toBeGreaterThan(0)
    expect(effectRunDurations.every(duration => duration >= 0)).toBe(true)
  })

  it('tracks root register/dispose lifecycle', () => {
    const { dispose } = createRoot(() => {
      const value = createSignal(1)
      createEffect(() => value())
      return value
    })

    const registerEvent = rootEvents.find(event => event.type === 'root:register')
    expect(registerEvent).toBeDefined()

    dispose()

    expect(
      rootEvents.some(event => event.type === 'root:dispose' && event.id === registerEvent?.id),
    ).toBe(true)
  })
})
