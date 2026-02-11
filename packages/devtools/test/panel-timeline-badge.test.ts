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

describe('panel timeline badge', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined

  beforeEach(async () => {
    originalBroadcastChannel = globalThis.BroadcastChannel

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as number)
    document.body.innerHTML = '<div id="app"></div>'

    await import('../src/panel/index')
    await waitForTick()
  })

  afterEach(() => {
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

  it('keeps timeline nav badge in sync when timeline updates outside timeline tab', async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: MessageSource.Hook,
          type: 'state:init',
          payload: {
            signals: [],
            computeds: [],
            effects: [],
            components: [],
            roots: [],
            timeline: [],
            settings: {},
          },
        },
        source: window,
      }),
    )
    await waitForTick()

    const badge = () =>
      document.querySelector('.tab[data-tab="timeline"] .badge') as HTMLElement | null
    expect(badge()?.textContent).toBe('0')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: MessageSource.Hook,
          type: 'timeline:event',
          payload: {
            id: 1,
            timestamp: Date.now(),
            type: 'signal:update',
          },
        },
        source: window,
      }),
    )
    await waitForTick()
    expect(badge()?.textContent).toBe('1')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: MessageSource.Hook,
          type: 'response:timeline',
          payload: [
            { id: 1, timestamp: Date.now(), type: 'signal:update' },
            { id: 2, timestamp: Date.now(), type: 'signal:update' },
            { id: 3, timestamp: Date.now(), type: 'effect:run' },
          ],
        },
        source: window,
      }),
    )
    await waitForTick()
    expect(badge()?.textContent).toBe('3')
  })
})
