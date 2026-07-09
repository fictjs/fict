import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChromeExtensionTransport, PostMessageTransport } from '../src/core/rpc'

type Listener<TArgs extends unknown[]> = (...args: TArgs) => void

function createChromeEvent<TArgs extends unknown[]>() {
  const listeners = new Set<Listener<TArgs>>()
  return {
    addListener(listener: Listener<TArgs>) {
      listeners.add(listener)
    },
    emit(...args: TArgs) {
      for (const listener of listeners) listener(...args)
    },
  }
}

function createPort(): chrome.runtime.Port {
  const onMessage = createChromeEvent<[unknown]>()
  const onDisconnect = createChromeEvent<[]>()
  let disconnected = false

  return {
    name: '42',
    onMessage,
    onDisconnect,
    postMessage: vi.fn(),
    disconnect() {
      if (disconnected) return
      disconnected = true
      onDisconnect.emit()
    },
  } as unknown as chrome.runtime.Port
}

describe('ChromeExtensionTransport lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('does not reconnect after being destroyed', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(() => createPort())
    vi.stubGlobal('chrome', {
      runtime: { connect },
    } as unknown as typeof chrome)

    const transport = new ChromeExtensionTransport(42)
    expect(connect).toHaveBeenCalledTimes(1)

    transport.destroy()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(transport.isConnected()).toBe(false)
  })

  it('only accepts postMessage traffic from its configured peer window', () => {
    const peerFrame = document.createElement('iframe')
    const impostorFrame = document.createElement('iframe')
    document.body.append(peerFrame, impostorFrame)
    const peerWindow = peerFrame.contentWindow!
    const impostorWindow = impostorFrame.contentWindow!
    const transport = new PostMessageTransport(peerWindow, 'https://trusted.example')
    const messages: unknown[] = []
    transport.subscribe(message => messages.push(message))

    window.dispatchEvent(
      new MessageEvent('message', {
        source: impostorWindow,
        origin: 'https://trusted.example',
        data: { source: 'fict-devtools-hook', type: 'spoofed', timestamp: Date.now() },
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        source: peerWindow,
        origin: 'https://trusted.example',
        data: { source: 'fict-devtools-hook', type: 'trusted', timestamp: Date.now() },
      }),
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'trusted' })
    transport.destroy()
  })
})
