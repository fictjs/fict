import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

async function waitForMessage(
  messages: Array<{ type?: string; payload?: unknown }>,
  type: string,
): Promise<{ type?: string; payload?: unknown } | undefined> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = messages.find(message => message.type === type)
    if (found) return found
    await waitForTick()
  }
  return messages.find(message => message.type === type)
}

describe('debugger component trace', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined
  let originalFetch: typeof fetch | undefined
  let originalPostMessage: typeof window.postMessage

  beforeEach(() => {
    originalBroadcastChannel = globalThis.BroadcastChannel
    originalFetch = globalThis.fetch
    originalPostMessage = window.postMessage.bind(window)

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
    window.postMessage = vi.fn((message: unknown) => {
      structuredClone(message)
    }) as typeof window.postMessage

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/@fs/Users/test/src/Counter.tsx')) {
          return new Response(
            [
              'function Counter() {',
              "  console.log('A')",
              '  let count = $state(0)',
              '  const doubled = count * 2',
              "  console.log('B', doubled)",
              "  return <button>{(console.log('C'), doubled)}{(console.log('D'), 'static')}</button>",
              '}',
            ].join('\n'),
            { status: 200 },
          )
        }
        return new Response('', { status: 404 })
      }),
    )
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
    if (originalFetch) {
      vi.stubGlobal('fetch', originalFetch)
    } else {
      delete (globalThis as typeof globalThis & { fetch?: unknown }).fetch
    }

    MockBroadcastChannel.reset()
    delete (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown })
      .__FICT_DEVTOOLS_HOOK__
    delete (globalThis as typeof globalThis & { __FICT_DEVTOOLS_STATE__?: unknown })
      .__FICT_DEVTOOLS_STATE__
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns component trace with once/reactive markers', async () => {
    const { attachDebugger, hook } = await import('../src/core/debugger')

    attachDebugger()
    hook.registerComponent(1, 'Counter')
    hook.registerSignal(10, 0, {
      name: 'count',
      source: '/Users/test/src/Counter.tsx:3:7',
      ownerId: 1,
    })
    hook.registerComputed(11, 0, {
      name: 'doubled',
      source: '/Users/test/src/Counter.tsx:4:9',
      ownerId: 1,
    })

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

    panelChannel.postMessage({
      source: 'fict-devtools-panel',
      type: 'request:componentTrace',
      payload: { componentId: 1 },
      timestamp: Date.now(),
    })

    const traceMessage = await waitForMessage(messages, 'response:componentTrace')
    expect(traceMessage).toBeTruthy()
    const tracePayload = traceMessage?.payload as {
      componentId: number
      trace: {
        file: string
        lines: Array<{ markers: Array<{ kind: string }> }>
      }
    }
    expect(tracePayload.componentId).toBe(1)
    expect(tracePayload.trace.file).toBe('/Users/test/src/Counter.tsx')
    expect(tracePayload.trace.lines.length).toBeGreaterThan(0)
    expect(
      tracePayload.trace.lines.some(line => line.markers.some(marker => marker.kind === 'once')),
    ).toBe(true)
    expect(
      tracePayload.trace.lines.some(line =>
        line.markers.some(marker => marker.kind === 'reactive'),
      ),
    ).toBe(true)
  })
})
