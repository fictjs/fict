import { promises as fs } from 'node:fs'
import path from 'node:path'

import WebSocket from 'ws'

import { normalizeLiveTracePayload } from './live-trace'
import type { LiveTraceStore } from './live-trace'

interface LiveTraceClientOptions {
  onFileUpdate: (file: string) => void
  onLog?: (message: string) => void
}

const LIVE_TRACE_ENDPOINT = '__fict-trace__'

export function normalizeLiveTraceServerUrl(serverUrl: string): string | null {
  const trimmed = serverUrl.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null

    const pathname = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = pathname.endsWith(`/${LIVE_TRACE_ENDPOINT}`)
      ? pathname
      : `${pathname}/${LIVE_TRACE_ENDPOINT}`.replace(/^\/+/, '/')
    parsed.hash = ''

    return parsed.toString()
  } catch {
    return null
  }
}

export async function readLiveTraceToken(
  tokenPath: string,
  workspaceRoot?: string,
): Promise<string | null> {
  const configuredPath = tokenPath.trim()
  if (!configuredPath) return null
  if (!path.isAbsolute(configuredPath) && !workspaceRoot) return null

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(workspaceRoot!, configuredPath)
  try {
    const token = (await fs.readFile(resolvedPath, 'utf8')).trim()
    return token && token.length <= 4096 ? token : null
  } catch {
    return null
  }
}

export class LiveTraceClient {
  private socket: WebSocket | null = null
  private socketTarget: string | null = null
  private socketToken: string | null = null
  private subscribedFile: string | null = null
  private lastConnectionWarning: string | null = null

  constructor(
    private readonly store: LiveTraceStore,
    private readonly options: LiveTraceClientOptions,
  ) {}

  connect(serverUrl: string, token: string | null): boolean {
    const target = normalizeLiveTraceServerUrl(serverUrl)
    if (!target) {
      this.disconnect()
      this.logConnectionWarning('Live trace server URL is invalid.')
      return false
    }

    const normalizedToken = token?.trim() || null
    if (!normalizedToken) {
      this.disconnect()
      this.logConnectionWarning(
        'Live trace token is unavailable. Start Vite with @fictjs/devtools/vite and verify fict.dev.tokenPath.',
      )
      return false
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN) &&
      this.socketTarget === target &&
      this.socketToken === normalizedToken
    ) {
      return true
    }

    this.disconnect()

    const socket = new WebSocket(target, {
      headers: { Authorization: `Bearer ${normalizedToken}` },
    })
    this.socket = socket
    this.socketTarget = target
    this.socketToken = normalizedToken

    socket.on('open', () => {
      this.lastConnectionWarning = null
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
      const subscribedPayload =
        this.subscribedFile && this.subscribedFile !== payload.file
          ? { ...payload, file: this.subscribedFile }
          : payload
      this.store.apply(subscribedPayload)
      this.options.onFileUpdate(subscribedPayload.file)
    })

    socket.on('close', () => {
      this.options.onLog?.('Live trace disconnected')
      if (this.socket === socket) {
        this.socket = null
        this.socketTarget = null
        this.socketToken = null
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
    const socket = this.socket
    this.socket = null
    this.socketTarget = null
    this.socketToken = null
    socket.removeAllListeners()
    socket.on('error', () => {})
    socket.close()
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

  private logConnectionWarning(message: string): void {
    if (this.lastConnectionWarning === message) return
    this.lastConnectionWarning = message
    this.options.onLog?.(message)
  }
}
