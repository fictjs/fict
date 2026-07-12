/**
 * Fict DevTools Content Script
 *
 * This script runs in Chrome's isolated world and bridges communication
 * between the main-world Fict runtime hook and the DevTools panel.
 */

console.debug('[Fict DevTools] Content script loaded')

// ============================================================================
// State
// ============================================================================

let port: chrome.runtime.Port | null = null
let isConnected = false
let fictDetected = false
let fictVersion: string | undefined
;(
  globalThis as typeof globalThis & { __FICT_DEVTOOLS_CONTENT_INJECTED__?: boolean }
).__FICT_DEVTOOLS_CONTENT_INJECTED__ = true

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if Fict is present on the page
 */
function detectFict(): { detected: boolean; version?: string | undefined } {
  return fictDetected ? { detected: true, version: fictVersion } : { detected: false }
}

/**
 * Ask the main-world bridge to replay its current status. This closes the race
 * where page-hook.js posts its initial message before this listener is ready.
 */
function requestPageStatus(): void {
  window.postMessage(
    { source: 'fict-devtools-content', type: 'request:hook-status', timestamp: Date.now() },
    '*',
  )
}

/**
 * Notify background script that Fict was detected
 */
function notifyFictDetected(version?: string): void {
  // Via port
  if (port && isConnected) {
    port.postMessage({
      type: 'fict-detected',
      version,
    })
    return
  }

  // Via chrome.runtime.sendMessage as fallback
  try {
    chrome.runtime.sendMessage({
      type: 'fict-detected',
      version,
    })
  } catch {
    // Extension might not be ready
  }
}

// ============================================================================
// Communication
// ============================================================================

/**
 * Connect to background script via port
 */
function connectToBackground(): void {
  try {
    port = chrome.runtime.connect({ name: 'fict-devtools-content' })
    isConnected = true

    port.onMessage.addListener(handleBackgroundMessage)

    port.onDisconnect.addListener(() => {
      console.debug('[Fict DevTools] Disconnected from background')
      isConnected = false
      port = null

      // Try to reconnect after a delay
      setTimeout(() => {
        if (!isConnected) {
          connectToBackground()
        }
      }, 1000)
    })

    console.debug('[Fict DevTools] Connected to background')

    // Replay detection after an extension-service-worker reconnect.
    const result = detectFict()
    if (result.detected) {
      notifyFictDetected(result.version)
    }
    requestPageStatus()
  } catch (error) {
    console.debug('[Fict DevTools] Failed to connect to background:', error)
  }
}

/**
 * Handle messages from background script
 */
function handleBackgroundMessage(message: Record<string, unknown>): void {
  // Forward to page
  if (message.source === 'fict-devtools-panel' || message.source === 'fict-devtools-background') {
    window.postMessage(message, '*')
  }
}

/**
 * Handle messages from page (hook)
 */
function handlePageMessage(event: MessageEvent): void {
  // Only accept messages from same window
  if (event.source !== window) return

  const message = event.data
  if (!message || typeof message !== 'object') return

  // Only forward messages from devtools hook
  if (message.source !== 'fict-devtools-hook') return

  if (message.type === 'fict-detected') {
    const payloadVersion =
      message.payload && typeof message.payload === 'object'
        ? (message.payload as { version?: unknown }).version
        : undefined
    const version =
      typeof message.version === 'string'
        ? message.version
        : typeof payloadVersion === 'string'
          ? payloadVersion
          : undefined
    fictDetected = true
    fictVersion = version
    console.debug('[Fict DevTools] Fict detected', version ? `v${version}` : '')
    notifyFictDetected(version)
    return
  }

  // Forward to background via port
  if (port && isConnected) {
    port.postMessage(message)
    return
  }

  // Fallback to chrome.runtime.sendMessage
  try {
    chrome.runtime.sendMessage(message)
  } catch {
    // Extension might not be ready
  }
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  // Register the bridge listener before asking either side for status.
  window.addEventListener('message', handlePageMessage)
  connectToBackground()
  requestPageStatus()
}

// document_start must install the bridge before application scripts execute.
init()

// Also listen for runtime connect events (for when DevTools opens)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ pong: true, fictDetected: detectFict().detected })
    return true
  }

  // Forward panel messages to page
  if (message.source === 'fict-devtools-panel') {
    window.postMessage(message, '*')
  }

  return false
})

// Export for module
export {}
