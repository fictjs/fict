import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageSource } from '../src/core/types'

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

describe('panel component trace navigation', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined
  let outgoingMessages: Array<{ source?: string; type?: string; payload?: unknown }>

  beforeEach(async () => {
    originalBroadcastChannel = globalThis.BroadcastChannel
    outgoingMessages = []

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as number)
    document.body.innerHTML = '<div id="app"></div>'

    const observer = new MockBroadcastChannel('fict-devtools')
    observer.onmessage = event => {
      outgoingMessages.push(event.data as { source?: string; type?: string; payload?: unknown })
    }
    ;(
      globalThis as typeof globalThis & { __panelObserverChannel?: MockBroadcastChannel }
    ).__panelObserverChannel = observer

    await import('../src/panel/index')
    await waitForTick()
  })

  afterEach(() => {
    const observer = (
      globalThis as typeof globalThis & { __panelObserverChannel?: MockBroadcastChannel }
    ).__panelObserverChannel
    observer?.close()

    delete (globalThis as typeof globalThis & { __panelObserverChannel?: MockBroadcastChannel })
      .__panelObserverChannel
    delete (window as Window & { __devtoolsChannel?: BroadcastChannel }).__devtoolsChannel
    document.body.innerHTML = ''

    if (originalBroadcastChannel) {
      vi.stubGlobal('BroadcastChannel', originalBroadcastChannel)
    } else {
      delete (globalThis as typeof globalThis & { BroadcastChannel?: unknown }).BroadcastChannel
    }

    MockBroadcastChannel.reset()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('requests component trace when jumping to component owner from another tab', async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: MessageSource.Hook,
          type: 'state:init',
          payload: {
            signals: [
              {
                id: 10,
                name: 'count',
                value: 0,
                previousValue: undefined,
                updateCount: 0,
                observers: [],
                ownerId: 1,
              },
            ],
            computeds: [],
            effects: [],
            components: [
              {
                id: 1,
                name: 'Counter',
                parentId: null,
                isMounted: true,
                renderCount: 1,
                signals: [10],
                computeds: [],
                effects: [],
                props: {},
              },
            ],
            roots: [],
            timeline: [],
            settings: {},
          },
        },
        source: window,
      }),
    )

    await waitForTick()

    const ownerLink = document.querySelector(
      '.owner-link[data-owner-id="1"]',
    ) as HTMLButtonElement | null
    expect(ownerLink).toBeTruthy()

    ownerLink?.click()
    await waitForTick()

    expect(
      outgoingMessages.some(message => {
        if (message.source !== MessageSource.Panel) return false
        if (message.type !== 'request:componentTrace') return false
        const payload = message.payload as { componentId?: number } | undefined
        return payload?.componentId === 1
      }),
    ).toBe(true)

    expect(document.querySelector('.component-trace-section')).toBeTruthy()
  })
})
