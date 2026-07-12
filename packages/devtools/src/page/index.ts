/**
 * Main-world entry for the browser extension.
 *
 * Chrome content scripts normally run in an isolated JavaScript world. This
 * entry is bundled as a self-contained classic script and declared with
 * `world: "MAIN"` so the Fict runtime can discover the debugger hook.
 */

import { attachDebugger, detachDebugger, hasDetectedFictRuntime } from '../core/debugger'
import { MessageSource } from '../core/types'

interface PageBridge {
  dispose(): void
}

type PageGlobal = typeof globalThis & {
  __FICT_DEVTOOLS_HOOK__?: unknown
  __FICT_DEVTOOLS_PAGE_BRIDGE__?: PageBridge
  __FICT_VERSION__?: unknown
  __FICT__?: { version?: unknown }
}

function readVersion(global: PageGlobal): string | undefined {
  try {
    const version = global.__FICT_VERSION__ ?? global.__FICT__?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

function postPageMessage(type: string, extra: Record<string, unknown> = {}): void {
  try {
    window.postMessage({ source: MessageSource.Hook, type, timestamp: Date.now(), ...extra }, '*')
  } catch {
    // The bridge is diagnostic-only and must never affect application code.
  }
}

export function installPageHookBridge(): boolean {
  if (typeof window === 'undefined') return false
  const global = globalThis as PageGlobal
  if (global.__FICT_DEVTOOLS_PAGE_BRIDGE__) return false

  let hadHook = false
  try {
    hadHook = !!global.__FICT_DEVTOOLS_HOOK__
  } catch {
    // A hostile pre-existing global must not prevent the extension bridge.
  }

  attachDebugger()

  const announceReady = () => postPageMessage('hook-ready')
  const announceDetected = () => postPageMessage('fict-detected', { version: readVersion(global) })
  const handleContentMessage = (event: MessageEvent) => {
    if (event.source !== window) return
    const message = event.data
    if (
      !message ||
      typeof message !== 'object' ||
      message.source !== MessageSource.Content ||
      message.type !== 'request:hook-status'
    ) {
      return
    }
    announceReady()
    if (hadHook || hasDetectedFictRuntime()) announceDetected()
  }

  window.addEventListener('message', handleContentMessage)
  global.__FICT_DEVTOOLS_PAGE_BRIDGE__ = {
    dispose() {
      window.removeEventListener('message', handleContentMessage)
      delete global.__FICT_DEVTOOLS_PAGE_BRIDGE__
      if (!hadHook) detachDebugger()
    },
  }

  announceReady()
  if (hadHook) announceDetected()
  return true
}

export function detachPageHookBridge(): void {
  ;(globalThis as PageGlobal).__FICT_DEVTOOLS_PAGE_BRIDGE__?.dispose()
}

installPageHookBridge()
