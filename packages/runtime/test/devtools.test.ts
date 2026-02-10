import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { batch, createEffect, createMemo, createRoot, render } from '../src/index'
import { createSignal } from '../src/advanced'

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
