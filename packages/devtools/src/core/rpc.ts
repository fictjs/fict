/**
 * Fict DevTools RPC Layer
 *
 * A unified RPC abstraction for DevTools communication.
 * Supports multiple transports: Chrome Extension, BroadcastChannel, PostMessage.
 */

import { MessageSource } from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * RPC message structure
 */
export interface RPCMessage<T = unknown> {
  source: MessageSource
  type: string
  payload?: T
  tabId?: number
  timestamp: number
  /** Unique message ID for request/response correlation */
  id?: string
  /** For response messages, the ID of the request */
  replyTo?: string
  /** Whether this is a response message */
  isResponse?: boolean
  /** Error if the request failed */
  error?: string
}

/**
 * RPC transport interface
 */
export interface RPCTransport {
  /** Transport name for debugging */
  name: string
  /** Send a message */
  send(message: RPCMessage): void
  /** Subscribe to incoming messages */
  subscribe(handler: (message: RPCMessage) => void): () => void
  /** Check if transport is available/connected */
  isConnected(): boolean
  /** Cleanup resources */
  destroy(): void
}

/**
 * RPC client options
 */
export interface RPCClientOptions {
  /** Message source identifier */
  source: MessageSource
  /** Request timeout in milliseconds */
  timeout?: number
  /** Custom transport (auto-detected if not provided) */
  transport?: RPCTransport
  /** Tab ID (for Chrome extension mode) */
  tabId?: number
}

/**
 * RPC request handler type
 */
export type RPCHandler<T = unknown, R = unknown> = (payload: T) => R | Promise<R>

// ============================================================================
// Transports
// ============================================================================

/**
 * Chrome Extension Port Transport
 */
export class ChromeExtensionTransport implements RPCTransport {
  name = 'chrome-extension'
  private port: chrome.runtime.Port | null = null
  private handlers = new Set<(message: RPCMessage) => void>()
  private headers = new Map<string, string>()
  private tabId: number
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 5

  constructor(tabId: number) {
    this.tabId = tabId
    this.connect()
  }

  private connect(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return

    try {
      this.port = chrome.runtime.connect({ name: String(this.tabId) })

      // Reset retry count if connection persists for 5s
      const resetTimer = setTimeout(() => {
        this.reconnectAttempts = 0
      }, 5000)

      this.port.onMessage.addListener((message: RPCMessage) => {
        for (const handler of this.handlers) {
          handler(message)
        }
      })

      this.port.onDisconnect.addListener(() => {
        this.port = null
        clearTimeout(resetTimer)

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000)
          setTimeout(() => this.connect(), delay)
        } else {
          console.warn('[RPC] Chrome extension transport reconnection failed after max attempts')
        }
      })
    } catch (e) {
      console.error('[RPC] Chrome extension transport connection failed:', e)
    }
  }

  send(message: RPCMessage): void {
    if (this.port) {
      this.port.postMessage(message)
    }
  }

  subscribe(handler: (message: RPCMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return this.port !== null
  }

  destroy(): void {
    if (this.port) {
      this.port.disconnect()
      this.port = null
    }
    this.handlers.clear()
  }
}

/**
 * BroadcastChannel Transport (for cross-tab communication)
 */
export class BroadcastChannelTransport implements RPCTransport {
  name = 'broadcast-channel'
  private channel: BroadcastChannel | null = null
  private handlers = new Set<(message: RPCMessage) => void>()
  private channelName: string

  constructor(channelName = 'fict-devtools') {
    this.channelName = channelName
    this.connect()
  }

  private connect(): void {
    if (typeof BroadcastChannel === 'undefined') return

    try {
      this.channel = new BroadcastChannel(this.channelName)

      this.channel.onmessage = (event: MessageEvent<RPCMessage>) => {
        if (event.data?.source) {
          for (const handler of this.handlers) {
            handler(event.data)
          }
        }
      }
    } catch (e) {
      console.error('[RPC] BroadcastChannel transport connection failed:', e)
    }
  }

  send(message: RPCMessage): void {
    if (this.channel) {
      this.channel.postMessage(message)
    }
  }

  subscribe(handler: (message: RPCMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return this.channel !== null
  }

  destroy(): void {
    if (this.channel) {
      this.channel.close()
      this.channel = null
    }
    this.handlers.clear()
  }
}

/**
 * PostMessage Transport (for iframe/popup communication)
 */
export class PostMessageTransport implements RPCTransport {
  name = 'post-message'
  private targetWindow: Window
  private targetOrigin: string
  private handlers = new Set<(message: RPCMessage) => void>()
  private boundHandler: (event: MessageEvent) => void

  constructor(targetWindow?: Window, targetOrigin = '*') {
    this.targetWindow = targetWindow || window.parent
    this.targetOrigin = targetOrigin

    this.boundHandler = (event: MessageEvent) => {
      // Validate message
      if (!event.data?.source) return
      if (targetOrigin !== '*' && event.origin !== targetOrigin) return

      for (const handler of this.handlers) {
        handler(event.data)
      }
    }

    window.addEventListener('message', this.boundHandler)
  }

  send(message: RPCMessage): void {
    this.targetWindow.postMessage(message, this.targetOrigin)
  }

  subscribe(handler: (message: RPCMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return this.targetWindow !== null
  }

  destroy(): void {
    window.removeEventListener('message', this.boundHandler)
    this.handlers.clear()
  }
}

/**
 * Multi-Transport (tries multiple transports)
 */
export class MultiTransport implements RPCTransport {
  name = 'multi'
  private transports: RPCTransport[] = []
  private handlers = new Set<(message: RPCMessage) => void>()
  private unsubscribers: (() => void)[] = []

  constructor(transports: RPCTransport[]) {
    this.transports = transports

    // Subscribe to all transports
    for (const transport of transports) {
      const unsubscribe = transport.subscribe(message => {
        for (const handler of this.handlers) {
          handler(message)
        }
      })
      this.unsubscribers.push(unsubscribe)
    }
  }

  send(message: RPCMessage): void {
    // Send to all connected transports
    for (const transport of this.transports) {
      if (transport.isConnected()) {
        transport.send(message)
      }
    }
  }

  subscribe(handler: (message: RPCMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return this.transports.some(t => t.isConnected())
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe()
    }
    for (const transport of this.transports) {
      transport.destroy()
    }
    this.handlers.clear()
  }
}

// ============================================================================
// RPC Client
// ============================================================================

/**
 * RPC Client
 *
 * Provides a unified API for sending messages and making requests.
 */
export class RPCClient {
  private source: MessageSource
  private transport: RPCTransport
  private timeout: number
  private tabId?: number
  private handlers = new Map<string, RPCHandler>()
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private messageId = 0
  private unsubscribe: (() => void) | null = null

  constructor(options: RPCClientOptions) {
    this.source = options.source
    this.timeout = options.timeout ?? 5000
    this.tabId = options.tabId
    this.transport = options.transport ?? this.autoDetectTransport()

    // Start listening for messages
    this.unsubscribe = this.transport.subscribe(message => this.handleMessage(message))
  }

  /**
   * Auto-detect the best available transport
   */
  private autoDetectTransport(): RPCTransport {
    // Chrome Extension mode
    if (typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow?.tabId !== undefined) {
      return new ChromeExtensionTransport(chrome.devtools.inspectedWindow.tabId)
    }

    // Try BroadcastChannel first (better cross-tab support)
    if (typeof BroadcastChannel !== 'undefined') {
      return new BroadcastChannelTransport()
    }

    // Fallback to postMessage
    return new PostMessageTransport()
  }

  /**
   * Generate a unique message ID
   */
  private generateId(): string {
    return `${this.source}-${Date.now()}-${++this.messageId}`
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: RPCMessage): void {
    // Handle responses to our requests
    if (message.isResponse && message.replyTo) {
      const pending = this.pendingRequests.get(message.replyTo)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.replyTo)

        if (message.error) {
          pending.reject(new Error(message.error))
        } else {
          pending.resolve(message.payload)
        }
      }
      return
    }

    // Handle requests that expect a response
    if (message.id && !message.isResponse) {
      const handler = this.handlers.get(message.type)
      if (handler) {
        Promise.resolve(handler(message.payload))
          .then(result => {
            this.sendResponse(message.id!, result)
          })
          .catch(error => {
            this.sendResponse(message.id!, undefined, error.message)
          })
      }
    }
  }

  /**
   * Send a response message
   */
  private sendResponse(replyTo: string, payload?: unknown, error?: string): void {
    const message: RPCMessage = {
      source: this.source,
      type: 'response',
      payload,
      replyTo,
      isResponse: true,
      error,
      timestamp: Date.now(),
    }
    if (this.tabId !== undefined) {
      message.tabId = this.tabId
    }
    this.transport.send(message)
  }

  /**
   * Send a fire-and-forget message
   */
  send(type: string, payload?: unknown): void {
    const message: RPCMessage = {
      source: this.source,
      type,
      payload,
      timestamp: Date.now(),
    }
    if (this.tabId !== undefined) {
      message.tabId = this.tabId
    }
    this.transport.send(message)
  }

  /**
   * Send a request and wait for a response
   */
  request<T = unknown>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.generateId()

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`RPC request timeout: ${type}`))
      }, this.timeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      const message: RPCMessage = {
        source: this.source,
        type,
        payload,
        id,
        timestamp: Date.now(),
      }
      if (this.tabId !== undefined) {
        message.tabId = this.tabId
      }
      this.transport.send(message)
    })
  }

  /**
   * Register a handler for incoming requests
   */
  handle<T = unknown, R = unknown>(type: string, handler: RPCHandler<T, R>): () => void {
    this.handlers.set(type, handler as RPCHandler)
    return () => this.handlers.delete(type)
  }

  /**
   * Subscribe to messages of a specific type
   */
  on(type: string, handler: (payload: unknown) => void): () => void {
    const wrappedHandler = (message: RPCMessage) => {
      if (message.type === type && !message.isResponse) {
        handler(message.payload)
      }
    }
    return this.transport.subscribe(wrappedHandler)
  }

  /**
   * Subscribe to all messages
   */
  onAny(handler: (type: string, payload: unknown) => void): () => void {
    return this.transport.subscribe(message => {
      if (!message.isResponse) {
        handler(message.type, message.payload)
      }
    })
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.transport.isConnected()
  }

  /**
   * Get transport name (for debugging)
   */
  getTransportName(): string {
    return this.transport.name
  }

  /**
   * Destroy the client and cleanup resources
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }

    // Cancel all pending requests
    for (const [, { timer, reject }] of this.pendingRequests) {
      clearTimeout(timer)
      reject(new Error('RPC client destroyed'))
    }
    this.pendingRequests.clear()
    this.handlers.clear()
    this.transport.destroy()
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an RPC client for the DevTools panel
 */
export function createPanelRPC(): RPCClient {
  return new RPCClient({
    source: MessageSource.Panel,
    timeout: 5000,
  })
}

/**
 * Create an RPC client for the content script
 */
export function createContentRPC(): RPCClient {
  return new RPCClient({
    source: MessageSource.Content,
    timeout: 5000,
  })
}

/**
 * Create an RPC client for the hook (page context)
 */
export function createHookRPC(): RPCClient {
  return new RPCClient({
    source: MessageSource.Hook,
    timeout: 5000,
  })
}

/**
 * Create an RPC client for the background script
 */
export function createBackgroundRPC(): RPCClient {
  return new RPCClient({
    source: MessageSource.Background,
    timeout: 5000,
  })
}

// ============================================================================
// Type-safe RPC Helpers
// ============================================================================

/**
 * Define a typed RPC endpoint
 */
export function defineEndpoint<TRequest, TResponse>(
  type: string,
): {
  type: string
  request: (client: RPCClient, payload: TRequest) => Promise<TResponse>
  handle: (
    client: RPCClient,
    handler: (payload: TRequest) => TResponse | Promise<TResponse>,
  ) => () => void
} {
  return {
    type,
    request: (client: RPCClient, payload: TRequest) => client.request<TResponse>(type, payload),
    handle: (client: RPCClient, handler) => client.handle<TRequest, TResponse>(type, handler),
  }
}

// ============================================================================
// Pre-defined Endpoints
// ============================================================================

export const RPCEndpoints = {
  // State queries
  getSignals: defineEndpoint<void, unknown[]>('request:signals'),
  getEffects: defineEndpoint<void, unknown[]>('request:effects'),
  getComponents: defineEndpoint<void, unknown[]>('request:components'),
  getTimeline: defineEndpoint<{ limit?: number }, unknown[]>('request:timeline'),
  getDependencyGraph: defineEndpoint<{ nodeId: number }, unknown>('request:dependencyGraph'),

  // State mutations
  setSignalValue: defineEndpoint<{ id: number; value: unknown }, boolean>('set:signalValue'),
  exposeToConsole: defineEndpoint<{ type: string; id: number }, void>('expose:console'),

  // Settings
  getSettings: defineEndpoint<void, unknown>('request:settings'),
  setSettings: defineEndpoint<Record<string, unknown>, void>('set:settings'),

  // Lifecycle
  connect: defineEndpoint<void, { version?: string }>('connect'),
  disconnect: defineEndpoint<void, void>('disconnect'),
}
