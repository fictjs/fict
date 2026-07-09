import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChromeExtensionTransport } from '../src/core/rpc'

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
})
