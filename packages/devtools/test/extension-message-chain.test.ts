import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener<TArgs extends unknown[]> = (...args: TArgs) => void

interface MockChromeEvent<TArgs extends unknown[]> {
  addListener(listener: Listener<TArgs>): void
  removeListener(listener: Listener<TArgs>): void
  emit(...args: TArgs): void
}

interface MockPort {
  name: string
  sender?: chrome.runtime.MessageSender
  onMessage: MockChromeEvent<[unknown]>
  onDisconnect: MockChromeEvent<[]>
  postMessage(message: unknown): void
  disconnect(): void
}

function createChromeEvent<TArgs extends unknown[]>(): MockChromeEvent<TArgs> {
  const listeners = new Set<Listener<TArgs>>()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args)
      }
    },
  }
}

function createPortPair(
  name: string,
  sender?: chrome.runtime.MessageSender,
): { client: MockPort; background: MockPort } {
  const clientOnMessage = createChromeEvent<[unknown]>()
  const backgroundOnMessage = createChromeEvent<[unknown]>()
  const clientOnDisconnect = createChromeEvent<[]>()
  const backgroundOnDisconnect = createChromeEvent<[]>()

  let closed = false

  const client: MockPort = {
    name,
    onMessage: clientOnMessage,
    onDisconnect: clientOnDisconnect,
    postMessage(message) {
      if (closed) return
      backgroundOnMessage.emit(message)
    },
    disconnect() {
      if (closed) return
      closed = true
      clientOnDisconnect.emit()
      backgroundOnDisconnect.emit()
    },
  }

  const background: MockPort = {
    name,
    sender,
    onMessage: backgroundOnMessage,
    onDisconnect: backgroundOnDisconnect,
    postMessage(message) {
      if (closed) return
      clientOnMessage.emit(message)
    },
    disconnect() {
      if (closed) return
      closed = true
      backgroundOnDisconnect.emit()
      clientOnDisconnect.emit()
    },
  }

  return { client, background }
}

function createChromeMock(tabId: number) {
  const onConnect = createChromeEvent<[chrome.runtime.Port]>()
  const onMessage =
    createChromeEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>()
  const onInstalled = createChromeEvent<[chrome.runtime.InstalledDetails]>()
  const onTabRemoved = createChromeEvent<[number]>()
  const onTabUpdated = createChromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()

  const executeScript = vi.fn(async () => [{ result: false }] as chrome.scripting.InjectionResult[])

  const runtime = {
    onConnect: {
      addListener: onConnect.addListener,
      removeListener: onConnect.removeListener,
    },
    onMessage: {
      addListener: onMessage.addListener,
      removeListener: onMessage.removeListener,
    },
    onInstalled: {
      addListener: onInstalled.addListener,
      removeListener: onInstalled.removeListener,
    },
    connect: vi.fn((connectInfo?: chrome.runtime.ConnectInfo) => {
      const name = connectInfo?.name ?? ''
      const sender =
        name === 'fict-devtools-content'
          ? ({ tab: { id: tabId } } as chrome.runtime.MessageSender)
          : undefined
      const pair = createPortPair(name, sender)
      onConnect.emit(pair.background as unknown as chrome.runtime.Port)
      return pair.client as unknown as chrome.runtime.Port
    }),
    sendMessage: vi.fn(async (message: unknown) => {
      let response: unknown
      onMessage.emit(
        message,
        { tab: { id: tabId } } as chrome.runtime.MessageSender,
        (value?: unknown) => {
          response = value
        },
      )
      return response
    }),
    getManifest: () => ({ version: '0.0.0-test' }),
  }

  const chromeMock = {
    runtime,
    tabs: {
      onRemoved: {
        addListener: onTabRemoved.addListener,
        removeListener: onTabRemoved.removeListener,
      },
      onUpdated: {
        addListener: onTabUpdated.addListener,
        removeListener: onTabUpdated.removeListener,
      },
    },
    action: {
      setIcon: vi.fn(async () => {}),
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
    scripting: {
      executeScript,
    },
  }

  return chromeMock
}

const waitForTick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('extension message chain', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome
    delete (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown })
      .__FICT_DEVTOOLS_HOOK__
    delete (globalThis as typeof globalThis & { __FICT_VERSION__?: unknown }).__FICT_VERSION__
  })

  it('routes messages across panel, background, content, and page', async () => {
    const tabId = 42
    const chromeMock = createChromeMock(tabId)
    vi.stubGlobal('chrome', chromeMock as unknown as typeof chrome)
    ;(
      globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown }
    ).__FICT_DEVTOOLS_HOOK__ = {}
    ;(globalThis as typeof globalThis & { __FICT_VERSION__?: string }).__FICT_VERSION__ = '1.0.0'

    await import('../src/background/index')

    const panelPort = chromeMock.runtime.connect({
      name: String(tabId),
    })
    const panelMessages: unknown[] = []
    ;(panelPort as unknown as MockPort).onMessage.addListener(message => {
      panelMessages.push(message)
    })

    const pageMessages: unknown[] = []
    window.addEventListener('message', event => {
      pageMessages.push(event.data)
    })

    await import('../src/content/index')
    await waitForTick()

    expect(
      panelMessages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: string }).type === 'fict-detected',
      ),
    ).toBe(true)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'fict-devtools-hook', type: 'signal:update', payload: { id: 1 } },
        source: window,
      }),
    )
    await waitForTick()

    expect(
      panelMessages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { source?: string; type?: string }).source === 'fict-devtools-hook' &&
          (message as { source?: string; type?: string }).type === 'signal:update',
      ),
    ).toBe(true)
    ;(panelPort as unknown as MockPort).postMessage({
      source: 'fict-devtools-panel',
      type: 'request:signals',
    })
    await waitForTick()

    expect(
      pageMessages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { source?: string; type?: string }).source === 'fict-devtools-panel' &&
          (message as { source?: string; type?: string }).type === 'request:signals',
      ),
    ).toBe(true)
  })
})
