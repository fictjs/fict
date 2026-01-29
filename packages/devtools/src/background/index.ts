/**
 * Fict DevTools Background Script
 *
 * Service worker that manages communication between:
 * - Content scripts (page context)
 * - DevTools panel
 * - Extension popup (if any)
 */

console.debug('[Fict DevTools] Background script loaded')

// ============================================================================
// Types
// ============================================================================

interface PortInfo {
  tabId: number
  name: 'devtools' | 'userApp'
  port: chrome.runtime.Port
}

interface TabState {
  devtools?: chrome.runtime.Port
  userApp?: chrome.runtime.Port
  fictDetected: boolean
  fictVersion?: string
}

// ============================================================================
// State
// ============================================================================

const tabs = new Map<number, TabState>()
const ports = new Map<chrome.runtime.Port, PortInfo>()

// ============================================================================
// Port Management
// ============================================================================

/**
 * Handle new port connections
 */
chrome.runtime.onConnect.addListener(port => {
  const portName = port.name

  // DevTools panel connecting (port name is tab ID)
  if (/^\d+$/.test(portName)) {
    const tabId = parseInt(portName, 10)
    handleDevToolsConnection(port, tabId)
    return
  }

  // Content script connecting
  if (portName === 'fict-devtools-content') {
    const tabId = port.sender?.tab?.id
    if (tabId !== undefined) {
      handleContentConnection(port, tabId)
    }
    return
  }

  console.debug('[Fict DevTools] Unknown port connection:', portName)
})

/**
 * Handle DevTools panel connection
 */
function handleDevToolsConnection(port: chrome.runtime.Port, tabId: number): void {
  console.debug(`[Fict DevTools] DevTools panel connected for tab ${tabId}`)

  // Store port info
  ports.set(port, { tabId, name: 'devtools', port })

  // Get or create tab state
  let tabState = tabs.get(tabId)
  if (!tabState) {
    tabState = { fictDetected: false }
    tabs.set(tabId, tabState)
  }
  tabState.devtools = port

  // Handle messages from DevTools panel
  port.onMessage.addListener(message => {
    handleDevToolsMessage(message, tabId)
  })

  // Handle disconnect
  port.onDisconnect.addListener(() => {
    console.debug(`[Fict DevTools] DevTools panel disconnected for tab ${tabId}`)
    ports.delete(port)

    const state = tabs.get(tabId)
    if (state) {
      state.devtools = undefined
    }
  })

  // Inject content script if not already present
  injectContentScript(tabId)

  // If Fict was already detected, notify the panel
  if (tabState.fictDetected) {
    port.postMessage({
      source: 'fict-devtools-background',
      type: 'fict-detected',
      payload: { version: tabState.fictVersion },
    })
  }
}

/**
 * Handle content script connection
 */
function handleContentConnection(port: chrome.runtime.Port, tabId: number): void {
  console.debug(`[Fict DevTools] Content script connected for tab ${tabId}`)

  // Store port info
  ports.set(port, { tabId, name: 'userApp', port })

  // Get or create tab state
  let tabState = tabs.get(tabId)
  if (!tabState) {
    tabState = { fictDetected: false }
    tabs.set(tabId, tabState)
  }
  tabState.userApp = port

  // Handle messages from content script
  port.onMessage.addListener(message => {
    handleContentMessage(message, tabId)
  })

  // Handle disconnect
  port.onDisconnect.addListener(() => {
    console.debug(`[Fict DevTools] Content script disconnected for tab ${tabId}`)
    ports.delete(port)

    const state = tabs.get(tabId)
    if (state) {
      state.userApp = undefined
      state.fictDetected = false
      updateIcon(tabId, false)
    }
  })
}

// ============================================================================
// Message Handling
// ============================================================================

/**
 * Handle messages from DevTools panel
 */
function handleDevToolsMessage(message: unknown, tabId: number): void {
  const state = tabs.get(tabId)
  if (!state?.userApp) {
    console.debug(`[Fict DevTools] No content script for tab ${tabId}`)
    return
  }

  // Forward message to content script
  state.userApp.postMessage(message)
}

/**
 * Handle messages from content script
 */
function handleContentMessage(message: Record<string, unknown>, tabId: number): void {
  const state = tabs.get(tabId)

  // Handle Fict detection
  if (message.type === 'fict-detected') {
    state!.fictDetected = true
    state!.fictVersion = message.version as string | undefined
    updateIcon(tabId, true)

    // Notify DevTools panel if connected
    if (state?.devtools) {
      state.devtools.postMessage({
        source: 'fict-devtools-background',
        type: 'fict-detected',
        payload: { version: state.fictVersion },
      })
    }
    return
  }

  // Forward other messages to DevTools panel
  if (state?.devtools) {
    state.devtools.postMessage(message)
  }
}

/**
 * Handle messages via chrome.runtime.sendMessage (legacy support)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id

  if (message.type === 'fict-detected' && tabId !== undefined) {
    let state = tabs.get(tabId)
    if (!state) {
      state = { fictDetected: false }
      tabs.set(tabId, state)
    }

    state.fictDetected = true
    state.fictVersion = message.version
    updateIcon(tabId, true)

    sendResponse({ success: true })
  }

  // Forward messages between components
  if (message.source === 'fict-devtools-hook' || message.source === 'fict-devtools-panel') {
    const targetTabId = message.tabId ?? tabId

    if (targetTabId !== undefined) {
      const state = tabs.get(targetTabId)

      if (message.source === 'fict-devtools-hook' && state?.devtools) {
        state.devtools.postMessage(message)
      } else if (message.source === 'fict-devtools-panel' && state?.userApp) {
        state.userApp.postMessage(message)
      }
    }
  }

  return true // Keep channel open for async response
})

// ============================================================================
// Icon Management
// ============================================================================

/**
 * Update extension icon based on Fict detection
 */
function updateIcon(tabId: number, detected: boolean): void {
  const iconPath = detected
    ? {
        16: 'icons/icon-16-active.png',
        32: 'icons/icon-32-active.png',
        48: 'icons/icon-48-active.png',
        128: 'icons/icon-128-active.png',
      }
    : {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      }

  chrome.action.setIcon({ tabId, path: iconPath }).catch(() => {
    // Ignore if icons don't exist
  })

  // Update badge
  chrome.action
    .setBadgeText({
      tabId,
      text: detected ? '' : '',
    })
    .catch(() => {})

  chrome.action
    .setBadgeBackgroundColor({
      tabId,
      color: '#42b883',
    })
    .catch(() => {})
}

// ============================================================================
// Content Script Injection
// ============================================================================

/**
 * Inject content script into a tab
 */
async function injectContentScript(tabId: number): Promise<void> {
  try {
    // Check if script is already injected
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        (window as Window & { __FICT_DEVTOOLS_INJECTED__?: boolean }).__FICT_DEVTOOLS_INJECTED__,
    })

    if (results[0]?.result) {
      console.debug(`[Fict DevTools] Content script already injected in tab ${tabId}`)
      return
    }

    // Inject the content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })

    // Mark as injected
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        ;(window as Window & { __FICT_DEVTOOLS_INJECTED__?: boolean }).__FICT_DEVTOOLS_INJECTED__ =
          true
      },
    })

    console.debug(`[Fict DevTools] Content script injected in tab ${tabId}`)
  } catch (error) {
    console.debug(`[Fict DevTools] Failed to inject content script:`, error)
  }
}

// ============================================================================
// Tab Management
// ============================================================================

/**
 * Clean up when a tab is closed
 */
chrome.tabs.onRemoved.addListener(tabId => {
  const state = tabs.get(tabId)
  if (state) {
    if (state.devtools) {
      ports.delete(state.devtools)
    }
    if (state.userApp) {
      ports.delete(state.userApp)
    }
    tabs.delete(tabId)
  }
})

/**
 * Handle tab navigation (page reload)
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // Reset Fict detection on page reload
    const state = tabs.get(tabId)
    if (state) {
      state.fictDetected = false
      state.fictVersion = undefined
      updateIcon(tabId, false)
    }
  }
})

// ============================================================================
// Installation
// ============================================================================

chrome.runtime.onInstalled.addListener(details => {
  console.log('[Fict DevTools] Extension installed:', details.reason)

  if (details.reason === 'install') {
    // First install
    console.log('[Fict DevTools] Welcome to Fict DevTools!')
  } else if (details.reason === 'update') {
    // Extension updated
    console.log('[Fict DevTools] Updated to version', chrome.runtime.getManifest().version)
  }
})
