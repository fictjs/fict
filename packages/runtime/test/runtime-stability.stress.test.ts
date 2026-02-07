import { describe, it, expect, afterEach } from 'vitest'

import {
  createMemo,
  createEffect,
  createRoot,
  createElement,
  onMount,
  onCleanup,
  render,
  startTransition,
} from '../src/index'
import { createSignal } from '../src/advanced'
import { createConditional, createKeyedList } from '../src/internal'

interface StressConfig {
  soakIterations: number
  churnCycles: number
  churnListSize: number
  leakRounds: number
  leakEffectsPerRound: number
  maxHeapGrowthBytes: number
  backpressureUpdates: number
  backpressureTimeoutMs: number
  maxDrainLatencyMs: number
}

function readIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}

const STRESS_ENABLED = process.env.FICT_RUNTIME_STRESS === '1'

const cfg: StressConfig = {
  soakIterations: readIntEnv('FICT_RUNTIME_SOAK_ITERS', 1200),
  churnCycles: readIntEnv('FICT_RUNTIME_CHURN_CYCLES', 120),
  churnListSize: readIntEnv('FICT_RUNTIME_CHURN_LIST_SIZE', 24),
  leakRounds: readIntEnv('FICT_RUNTIME_LEAK_ROUNDS', 60),
  leakEffectsPerRound: readIntEnv('FICT_RUNTIME_LEAK_EFFECTS_PER_ROUND', 80),
  maxHeapGrowthBytes: readIntEnv('FICT_RUNTIME_MAX_HEAP_GROWTH_BYTES', 24 * 1024 * 1024, 0),
  backpressureUpdates: readIntEnv('FICT_RUNTIME_BACKPRESSURE_UPDATES', 4000),
  backpressureTimeoutMs: readIntEnv('FICT_RUNTIME_BACKPRESSURE_TIMEOUT_MS', 3000),
  maxDrainLatencyMs: readIntEnv('FICT_RUNTIME_MAX_DRAIN_LATENCY_MS', 800),
}

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; elapsedMs: number }> {
  const start = performance.now()
  while (true) {
    if (predicate()) {
      return { ok: true, elapsedMs: performance.now() - start }
    }
    const elapsed = performance.now() - start
    if (elapsed > timeoutMs) {
      return { ok: false, elapsedMs: elapsed }
    }
    await tick()
  }
}

function makeInitialItems(size: number): Array<{ id: number; value: number }> {
  const items: Array<{ id: number; value: number }> = []
  for (let i = 0; i < size; i++) {
    items.push({ id: i + 1, value: i + 1 })
  }
  return items
}

const describeStress = STRESS_ENABLED ? describe : describe.skip

describeStress('Runtime Stability Stress', () => {
  let activeContainer: HTMLElement | null = null

  afterEach(() => {
    if (activeContainer) {
      activeContainer.remove()
      activeContainer = null
    }
  })

  it('soak: keeps reactive state transitions and cleanup accounting stable', async () => {
    const root = createRoot(() => {
      const counter = createSignal(0)
      const doubled = createMemo(() => counter() * 2)
      let effectRuns = 0
      let cleanupRuns = 0
      let mismatches = 0

      createEffect(() => {
        const value = counter()
        const derived = doubled()
        effectRuns += 1
        if (derived !== value * 2) {
          mismatches += 1
        }
        onCleanup(() => {
          cleanupRuns += 1
        })
      })

      return {
        setCounter: counter,
        snapshot: () => ({ effectRuns, cleanupRuns, mismatches }),
      }
    })

    for (let i = 1; i <= cfg.soakIterations; i++) {
      root.value.setCounter(i)
      await tick()
    }
    await tick()

    const beforeDispose = root.value.snapshot()
    root.dispose()
    const afterDispose = root.value.snapshot()

    expect(beforeDispose.mismatches).toBe(0)
    expect(beforeDispose.effectRuns).toBe(cfg.soakIterations + 1)
    expect(afterDispose.cleanupRuns).toBe(afterDispose.effectRuns)
  })

  it('churn: repeated conditional mount/unmount with keyed list leaves no active rows', async () => {
    const container = document.createElement('div')
    activeContainer = container
    document.body.appendChild(container)

    const show = createSignal(true)
    const items = createSignal(makeInitialItems(cfg.churnListSize))
    let nextId = cfg.churnListSize
    let rowMounts = 0
    let rowUnmounts = 0

    function Row(props: { itemSig: () => { id: number; value: number } }): HTMLElement {
      const li = document.createElement('li')
      onMount(() => {
        rowMounts += 1
        return () => {
          rowUnmounts += 1
        }
      })
      createEffect(() => {
        const item = props.itemSig()
        li.textContent = `${item.id}:${item.value}`
      })
      return li
    }

    const conditionalBinding = createConditional(
      () => show(),
      () => {
        const listBinding = createKeyedList(
          () => items(),
          item => item.id,
          itemSig => [createElement({ type: Row, props: { itemSig }, key: undefined }) as Node],
        )
        onCleanup(() => listBinding.dispose())

        const ul = document.createElement('ul')
        ul.appendChild(listBinding.marker)
        return ul
      },
      createElement,
    )

    container.appendChild(conditionalBinding.marker)
    await tick()

    for (let cycle = 0; cycle < cfg.churnCycles; cycle++) {
      const current = items()
      const rotated = current.length > 1 ? [...current.slice(1), { ...current[0]! }] : [...current]
      const next = rotated.map((item, idx) =>
        idx % 3 === cycle % 3 ? { ...item, value: item.value + 1 } : item,
      )

      if (cycle % 4 === 0) {
        nextId += 1
        next.push({ id: nextId, value: nextId })
      }
      if (cycle % 5 === 0 && next.length > Math.max(4, Math.floor(cfg.churnListSize / 2))) {
        next.shift()
      }

      items(next)
      show(false)
      await tick()
      show(true)
      await tick()
    }

    expect(container.querySelectorAll('li').length).toBe(items().length)

    conditionalBinding.dispose()
    await tick()

    expect(rowMounts).toBeGreaterThan(0)
    expect(rowUnmounts).toBe(rowMounts)
  })

  it('leak: disposed effect roots do not continue receiving updates', async () => {
    let staleRuns = 0
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
    const canMeasureHeap =
      typeof process !== 'undefined' &&
      typeof process.memoryUsage === 'function' &&
      typeof gc === 'function'
    const heapSamples: number[] = []

    if (canMeasureHeap) {
      gc!()
      heapSamples.push(process.memoryUsage().heapUsed)
    }

    for (let round = 0; round < cfg.leakRounds; round++) {
      const source = createSignal(0)
      let runs = 0

      const root = createRoot(() => {
        for (let i = 0; i < cfg.leakEffectsPerRound; i++) {
          createEffect(() => {
            source()
            runs += 1
          })
        }
      })

      source(round + 1)
      await tick()
      const runsBeforeDispose = runs

      root.dispose()
      source(round + 100_000)
      await tick()

      if (runs !== runsBeforeDispose) {
        staleRuns += 1
      }

      if (canMeasureHeap) {
        gc!()
        heapSamples.push(process.memoryUsage().heapUsed)
      }
    }

    expect(staleRuns).toBe(0)

    if (heapSamples.length >= 2) {
      const first = heapSamples[0]!
      const last = heapSamples[heapSamples.length - 1]!
      const growth = last - first
      expect(growth).toBeLessThanOrEqual(cfg.maxHeapGrowthBytes)
    }
  })

  it('backpressure: mixed high/low priority burst drains within latency budget without dropping final state', async () => {
    const high = createSignal(0)
    const low = createSignal(0)
    let observedHigh = 0
    let observedLow = 0
    let effectRuns = 0

    createEffect(() => {
      observedHigh = high()
      observedLow = low()
      effectRuns += 1
    })

    const burstStart = performance.now()
    for (let i = 1; i <= cfg.backpressureUpdates; i++) {
      startTransition(() => {
        low(i)
      })
      high(i)
    }

    const settle = await waitForCondition(
      () => observedHigh === cfg.backpressureUpdates && observedLow === cfg.backpressureUpdates,
      cfg.backpressureTimeoutMs,
    )
    const totalElapsed = performance.now() - burstStart

    expect(settle.ok).toBe(true)
    expect(observedHigh).toBe(cfg.backpressureUpdates)
    expect(observedLow).toBe(cfg.backpressureUpdates)
    expect(effectRuns).toBeGreaterThan(1)
    expect(settle.elapsedMs).toBeLessThanOrEqual(cfg.maxDrainLatencyMs)
    expect(totalElapsed).toBeLessThanOrEqual(cfg.backpressureTimeoutMs)
  })
})
