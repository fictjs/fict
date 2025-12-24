/**
 * Fict DevTools Background Script
 *
 * Handles extension installation and messaging between components.
 */

console.debug('[Fict DevTools] Background script loaded')

// Track tabs with Fict detected
const fictTabs = new Set<number>()

// Handle extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Fict DevTools] Extension installed')
})

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  const tabId = sender.tab?.id

  if (message.type === 'fict-detected' && tabId) {
    fictTabs.add(tabId)
    console.debug(`[Fict DevTools] Fict detected on tab ${tabId}`)

    // Update extension icon to indicate Fict is present
    chrome.action
      .setIcon({
        tabId,
        path: {
          16: 'icons/icon-16-active.png',
          32: 'icons/icon-32-active.png',
          48: 'icons/icon-48-active.png',
        },
      })
      .catch(() => {
        // Ignore if icons don't exist yet
      })
  }

  // Forward messages between content script and DevTools panel
  if (message.source === 'fict-devtools-hook' || message.source === 'fict-devtools-panel') {
    // Broadcast to all connected contexts
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore errors (panel might not be open)
    })
  }
})

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener(tabId => {
  fictTabs.delete(tabId)
})
