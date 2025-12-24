/**
 * Fict DevTools Content Script
 *
 * This script runs in the page context and bridges communication
 * between the Fict runtime hook and the DevTools panel.
 */

// Make this file a module
export {}

console.debug('[Fict DevTools] Content script loaded')

/**
 * Check if Fict is present on the page
 */
function detectFict(): boolean {
  return !!(globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown })
    .__FICT_DEVTOOLS_HOOK__
}

/**
 * Initialize connection with the DevTools panel
 */
function init(): void {
  // Listen for messages from the page (hook)
  window.addEventListener('message', event => {
    if (event.source !== window) return
    if (event.data?.source !== 'fict-devtools-hook') return

    // Forward to DevTools panel via chrome.runtime
    try {
      chrome.runtime.sendMessage(event.data)
    } catch {
      // Panel might not be open
    }
  })

  // Listen for messages from the DevTools panel
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message?.source !== 'fict-devtools-panel') return

    // Forward to page
    window.postMessage(message, '*')
  })

  // Check if Fict is on the page
  if (detectFict()) {
    console.debug('[Fict DevTools] Fict detected on page')

    // Notify background script
    try {
      chrome.runtime.sendMessage({
        type: 'fict-detected',
        tabId: chrome.devtools?.inspectedWindow?.tabId,
      })
    } catch {
      // Ignore errors
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
