import WebSocket from 'ws'

import { normalizeLiveTracePayload } from './live-trace'
import type { LiveTraceStore } from './live-trace'

interface LiveTraceClientOptions {
  onFileUpdate: (file: string) => void
  onLog?: (message: string) => void
}

function normalizeServerUrl(serverUrl: string): string | null {
  const trimmed = serverUrl.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
    }

    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/__fict-trace__'
    }

    return parsed.toString()
  } catch {
    return null
  }
}

export class LiveTraceClient {
  private socket: WebSocket | null = null
  private subscribedFile: string | null = null

  constructor(
    private readonly store: LiveTraceStore,
    private readonly options: LiveTraceClientOptions,
  ) {}

  connect(serverUrl: string): boolean {
    const target = normalizeServerUrl(serverUrl)
    if (!target) return false

    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.socket.url === target) {
      return true
    }

    this.disconnect()

    const socket = new WebSocket(target)
    this.socket = socket

    socket.on('open', () => {
      this.options.onLog?.(`Live trace connected: ${target}`)
      if (this.subscribedFile) {
        this.send({ type: 'trace/subscribe', file: this.subscribedFile })
      }
    })

    socket.on('message', (rawMessage: WebSocket.RawData) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawMessage.toString())
      } catch {
        return
      }

      const payload = normalizeLiveTracePayload(parsed)
      if (!payload) return
      this.store.apply(payload)
      this.options.onFileUpdate(payload.file)
    })

    socket.on('close', () => {
      this.options.onLog?.('Live trace disconnected')
      if (this.socket === socket) {
        this.socket = null
      }
    })

    socket.on('error', (error: Error) => {
      this.options.onLog?.(`Live trace error: ${error.message}`)
    })

    return true
  }

  subscribe(file: string): void {
    if (!file) return

    if (this.subscribedFile && this.subscribedFile !== file) {
      this.send({ type: 'trace/unsubscribe', file: this.subscribedFile })
    }

    this.subscribedFile = file
    this.send({ type: 'trace/subscribe', file })
  }

  unsubscribe(file: string): void {
    if (!file) return
    this.send({ type: 'trace/unsubscribe', file })
    if (this.subscribedFile === file) {
      this.subscribedFile = null
    }
  }

  disconnect(): void {
    if (!this.socket) return
    this.socket.removeAllListeners()
    this.socket.close()
    this.socket = null
  }

  dispose(): void {
    if (this.subscribedFile) {
      this.send({ type: 'trace/unsubscribe', file: this.subscribedFile })
      this.subscribedFile = null
    }
    this.disconnect()
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(payload))
  }
}
