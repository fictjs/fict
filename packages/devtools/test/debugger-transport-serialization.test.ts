import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeDependencyGraphPayload } from '../src/panel/panel-utils'

class MockBroadcastChannel {
  private static channels = new Map<string, Set<MockBroadcastChannel>>()
  private readonly name: string
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(name: string) {
    this.name = name
    const group = MockBroadcastChannel.channels.get(name)
    if (group) {
      group.add(this)
    } else {
      MockBroadcastChannel.channels.set(name, new Set([this]))
    }
  }

  postMessage(message: unknown): void {
    // Mimic browser postMessage/BroadcastChannel structured-clone behavior.
    const cloned = structuredClone(message)
    const group = MockBroadcastChannel.channels.get(this.name)
    if (!group) return
    for (const channel of group) {
      if (channel === this) continue
      channel.onmessage?.({ data: cloned } as MessageEvent)
    }
  }

  close(): void {
    const group = MockBroadcastChannel.channels.get(this.name)
    if (!group) return
    group.delete(this)
    if (group.size === 0) {
      MockBroadcastChannel.channels.delete(this.name)
    }
  }

  static reset(): void {
    MockBroadcastChannel.channels.clear()
  }
}

const waitForTick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('debugger transport serialization', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined
  let originalPostMessage: typeof window.postMessage

  beforeEach(() => {
    originalBroadcastChannel = globalThis.BroadcastChannel
    originalPostMessage = window.postMessage.bind(window)

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
    window.postMessage = vi.fn((message: unknown) => {
      structuredClone(message)
    }) as typeof window.postMessage
  })

  afterEach(async () => {
    try {
      const debuggerModule = await import('../src/core/debugger')
      debuggerModule.detachDebugger()
    } catch {
      // Ignore module teardown errors in tests
    }

    window.postMessage = originalPostMessage
    if (originalBroadcastChannel) {
      vi.stubGlobal('BroadcastChannel', originalBroadcastChannel)
    } else {
      delete (globalThis as typeof globalThis & { BroadcastChannel?: unknown }).BroadcastChannel
    }
    MockBroadcastChannel.reset()

    delete (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown })
      .__FICT_DEVTOOLS_HOOK__
    delete (globalThis as typeof globalThis & { __FICT_DEVTOOLS_STATE__?: unknown })
      .__FICT_DEVTOOLS_STATE__

    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('falls back to transport-safe payloads for initial state messages', async () => {
    const { attachDebugger, hook } = await import('../src/core/debugger')
    const { FICT_DEVTOOLS_PROTOCOL_VERSION } = await import('../src/core/types')

    attachDebugger()
    expect(
      (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: typeof hook })
        .__FICT_DEVTOOLS_HOOK__?.devtools,
    ).toMatchObject({
      protocolVersion: FICT_DEVTOOLS_PROTOCOL_VERSION,
      minRuntimeProtocol: 1,
      maxRuntimeProtocol: 1,
    })

    hook.registerSignal(1, () => 1, { name: 'callable' })
    hook.registerComponent(1, 'App')
    hook.componentMount(1, [document.createElement('button')])

    const panelChannel = new MockBroadcastChannel('fict-devtools')
    const messages: Array<{ source?: string; type?: string; payload?: unknown }> = []
    panelChannel.onmessage = event => {
      messages.push(event.data as { source?: string; type?: string; payload?: unknown })
    }

    panelChannel.postMessage({
      source: 'fict-devtools-panel',
      type: 'connect',
      timestamp: Date.now(),
    })
    await waitForTick()

    const initMessage = messages.find(message => message.type === 'state:init')
    expect(initMessage).toBeTruthy()
    const payload = initMessage?.payload as {
      signals: Array<{ value: unknown }>
      components: Array<{ elements?: unknown[] }>
    }
    expect(payload.signals).toHaveLength(1)
    expect(payload.signals[0]?.value).toBe('[Function anonymous]')
    expect(payload.components).toHaveLength(1)
    expect(payload.components[0]?.elements?.[0]).toMatchObject({
      __fictType: 'Element',
      tagName: 'BUTTON',
    })

    panelChannel.postMessage({
      source: 'fict-devtools-panel',
      type: 'request:dependencyGraph',
      payload: { nodeId: 1 },
      timestamp: Date.now(),
    })
    await waitForTick()

    const graphMessage = messages.find(message => message.type === 'response:dependencyGraph')
    expect(graphMessage).toBeTruthy()
    const graphPayload = graphMessage?.payload as { nodes: unknown }
    expect(Array.isArray(graphPayload.nodes)).toBe(true)
    const normalized = normalizeDependencyGraphPayload(graphPayload)
    expect(normalized?.rootId).toBe(1)
    expect(normalized?.nodes.size).toBe(1)
    expect(normalized?.nodes.get(1)?.type).toBe('signal')

    expect(window.postMessage).toHaveBeenCalled()
  })

  it('ignores compiler-internal computed registrations', async () => {
    const { attachDebugger, hook } = await import('../src/core/debugger')

    attachDebugger()
    hook.registerComputed(1, undefined, { internal: true })
    hook.registerComputed(2, undefined, { name: 'doubled' })

    const state = (
      globalThis as typeof globalThis & {
        __FICT_DEVTOOLS_STATE__?: {
          computeds: Map<number, unknown>
          timeline: Array<{ type?: string; nodeId?: number }>
        }
      }
    ).__FICT_DEVTOOLS_STATE__

    expect(state).toBeTruthy()
    expect(Array.from(state!.computeds.keys())).toEqual([2])
    expect(
      state!.timeline.some(event => event.type === 'computed:create' && event.nodeId === 1),
    ).toBe(false)
  })

  it('keeps transport updates alive when application values reject inspection', async () => {
    const { attachDebugger, hook } = await import('../src/core/debugger')
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('inspection denied')
        },
      },
    )

    attachDebugger()
    expect(() => hook.registerSignal(101, new Date(Number.NaN), { name: 'date' })).not.toThrow()
    expect(() => hook.registerSignal(102, hostile, { name: 'hostile' })).not.toThrow()

    const panelChannel = new MockBroadcastChannel('fict-devtools')
    const messages: Array<{ type?: string; payload?: unknown }> = []
    panelChannel.onmessage = event => {
      messages.push(event.data as { type?: string; payload?: unknown })
    }
    panelChannel.postMessage({
      source: 'fict-devtools-panel',
      type: 'connect',
      timestamp: Date.now(),
    })
    await waitForTick()

    const payload = messages.find(message => message.type === 'state:init')?.payload as {
      signals: Array<{ id: number; value: unknown }>
    }
    expect(payload.signals.find(signal => signal.id === 101)?.value).toBe('Invalid Date')
    expect(payload.signals.find(signal => signal.id === 102)?.value).toBe('[Uninspectable]')
  })
})
