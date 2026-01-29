/**
 * Fict DevTools Content Script
 *
 * This script runs in the page context and bridges communication
 * between the Fict runtime hook and the DevTools panel.
 */

console.debug('[Fict DevTools] Content script loaded')

// ============================================================================
// Types
// ============================================================================

interface FictGlobal {
  __FICT_DEVTOOLS_HOOK__?: unknown
  __FICT_VERSION__?: string
  __FICT__?: {
    version?: string
  }
}

// ============================================================================
// State
// ============================================================================

let port: chrome.runtime.Port | null = null
let isConnected = false
let detectionAttempts = 0
const MAX_DETECTION_ATTEMPTS = 50
const DETECTION_INTERVAL = 100

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if Fict is present on the page
 */
function detectFict(): { detected: boolean; version?: string } {
  const global = globalThis as typeof globalThis & FictGlobal

  if (global.__FICT_DEVTOOLS_HOOK__) {
    const version = global.__FICT_VERSION__ || global.__FICT__?.version
    return { detected: true, version }
  }

  return { detected: false }
}

/**
 * Poll for Fict detection (waits for async app initialization)
 */
function pollForFict(): void {
  const check = () => {
    detectionAttempts++
    const result = detectFict()

    if (result.detected) {
      console.debug('[Fict DevTools] Fict detected', result.version ? `v${result.version}` : '')
      notifyFictDetected(result.version)
      return
    }

    if (detectionAttempts < MAX_DETECTION_ATTEMPTS) {
      setTimeout(check, DETECTION_INTERVAL)
    } else {
      console.debug('[Fict DevTools] Fict not detected after polling')
    }
  }

  check()
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

    // Check for Fict immediately
    const result = detectFict()
    if (result.detected) {
      notifyFictDetected(result.version)
    }
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
// Script Injection
// ============================================================================

/**
 * Inject the debugger hook script into the page
 */
function injectDebuggerHook(): void {
  // Check if already injected
  const global = globalThis as typeof globalThis & { __FICT_DEVTOOLS_INJECTED__?: boolean }
  if (global.__FICT_DEVTOOLS_INJECTED__) return

  const script = document.createElement('script')
  script.textContent = `
    (function() {
      // Mark as injected
      window.__FICT_DEVTOOLS_INJECTED__ = true;

      // Wait for Fict hook to be available
      function checkHook() {
        if (window.__FICT_DEVTOOLS_HOOK__) {
          console.debug('[Fict DevTools] Hook found, DevTools ready');
          // Notify content script
          window.postMessage({
            source: 'fict-devtools-hook',
            type: 'hook-ready'
          }, '*');
        }
      }

      // Check immediately and poll
      checkHook();
      const interval = setInterval(() => {
        checkHook();
        if (window.__FICT_DEVTOOLS_HOOK__) {
          clearInterval(interval);
        }
      }, 100);

      // Stop polling after 10 seconds
      setTimeout(() => clearInterval(interval), 10000);
    })();
  `

  // Inject at document_start
  const target = document.head || document.documentElement
  target.insertBefore(script, target.firstChild)
  script.remove()
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  // Connect to background
  connectToBackground()

  // Listen for messages from page
  window.addEventListener('message', handlePageMessage)

  // Inject debugger hook
  injectDebuggerHook()

  // Start polling for Fict
  pollForFict()
}

// Initialize based on document state
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

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
