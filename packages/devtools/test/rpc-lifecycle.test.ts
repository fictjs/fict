import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ChromeExtensionTransport,
  PostMessageTransport,
  RPCClient,
  type RPCMessage,
  type RPCTransport,
} from '../src/core/rpc'
import { MessageSource } from '../src/core/types'

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

class TestTransport implements RPCTransport {
  readonly name = 'test'
  readonly sent: RPCMessage[] = []
  sendAttemptsAfterDestroy = 0
  destroyed = false
  private handlers = new Set<(message: RPCMessage) => void>()

  send(message: RPCMessage): void {
    if (this.destroyed) {
      this.sendAttemptsAfterDestroy++
      return
    }
    this.sent.push(message)
  }

  subscribe(handler: (message: RPCMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return !this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.handlers.clear()
  }

  emit(message: RPCMessage): void {
    for (const handler of this.handlers) handler(message)
  }
}

function createRPCRequest(type: string, id: string, payload?: unknown): RPCMessage {
  return {
    source: MessageSource.Panel,
    type,
    id,
    payload,
    timestamp: Date.now(),
  }
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

describe('RPCClient lifecycle', () => {
  it('turns a synchronous handler throw into an error response', async () => {
    const transport = new TestTransport()
    const client = new RPCClient({ source: MessageSource.Hook, transport })
    client.handle('explode', () => {
      throw new Error('synchronous failure')
    })

    expect(() => transport.emit(createRPCRequest('explode', 'request-1'))).not.toThrow()

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(1)
    })
    expect(transport.sent[0]).toMatchObject({
      type: 'response',
      replyTo: 'request-1',
      isResponse: true,
      error: 'synchronous failure',
    })
    client.destroy()
  })

  it.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('responds when a handler rejects with %s', async (_label, reason, expectedError) => {
    const transport = new TestTransport()
    const client = new RPCClient({ source: MessageSource.Hook, transport })
    client.handle('reject', () => Promise.reject(reason))

    transport.emit(createRPCRequest('reject', 'request-2'))

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(1)
    })
    expect(transport.sent[0]).toMatchObject({
      type: 'response',
      replyTo: 'request-2',
      isResponse: true,
      error: expectedError,
    })
    client.destroy()
  })

  it('preserves successful response payloads', async () => {
    const transport = new TestTransport()
    const client = new RPCClient({ source: MessageSource.Hook, transport })
    client.handle('echo', payload => ({ payload }))

    transport.emit(createRPCRequest('echo', 'request-3', { value: 42 }))

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(1)
    })
    expect(transport.sent[0]).toMatchObject({
      type: 'response',
      replyTo: 'request-3',
      isResponse: true,
      payload: { payload: { value: 42 } },
    })
    expect(transport.sent[0]?.error).toBeUndefined()
    client.destroy()
  })

  it('does not send an in-flight response after being destroyed', async () => {
    const transport = new TestTransport()
    const client = new RPCClient({ source: MessageSource.Hook, transport })
    let resolveHandler!: (value: string) => void
    const handler = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveHandler = resolve
        }),
    )
    client.handle('slow', handler)

    transport.emit(createRPCRequest('slow', 'request-4'))
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce()
    })

    client.destroy()
    resolveHandler('too late')
    await new Promise(resolve => setTimeout(resolve, 0))

    client.send('after-destroy')
    await expect(client.request('after-destroy')).rejects.toThrow('RPC client destroyed')
    const afterDestroy = vi.fn()
    client.on('after-destroy', afterDestroy)
    client.onAny(afterDestroy)
    transport.emit(createRPCRequest('after-destroy', 'request-5'))
    expect(transport.sent).toHaveLength(0)
    expect(transport.sendAttemptsAfterDestroy).toBe(0)
    expect(afterDestroy).not.toHaveBeenCalled()
  })
})
