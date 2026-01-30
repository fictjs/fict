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
  console.debug('[Fict DevTools Background] handleDevToolsMessage:', message, 'for tab:', tabId)
  const state = tabs.get(tabId)
  if (!state?.userApp) {
    console.debug(`[Fict DevTools] No content script for tab ${tabId}, userApp:`, state?.userApp)
    return
  }

  // Forward message to content script
  console.debug('[Fict DevTools Background] Forwarding to content script')
  state.userApp.postMessage(message)
}

/**
 * Handle messages from content script
 */
function handleContentMessage(message: Record<string, unknown>, tabId: number): void {
  console.debug('[Fict DevTools Background] handleContentMessage:', message, 'for tab:', tabId)
  const state = tabs.get(tabId)

  // Handle Fict detection
  if (message.type === 'fict-detected') {
    console.debug('[Fict DevTools Background] Fict detected, notifying panel')
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
  // Icon paths - using same base icons for now
  // TODO: Add distinct active icons (e.g., icon16-active.png) for clearer visual feedback
  const iconPath = {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  }

  chrome.action.setIcon({ tabId, path: iconPath }).catch(() => {
    // Ignore if icons don't exist
  })

  // Use badge to indicate Fict detection state
  // This provides visual feedback since we don't have separate active icons yet
  chrome.action
    .setBadgeText({
      tabId,
      text: detected ? '✓' : '',
    })
    .catch(() => {})

  chrome.action
    .setBadgeBackgroundColor({
      tabId,
      color: detected ? '#42b883' : '#6b7280', // Green when detected, gray otherwise
    })
    .catch(() => {})

  // Set title to indicate state
  chrome.action
    .setTitle({
      tabId,
      title: detected ? 'Fict DevTools - Connected' : 'Fict DevTools - No Fict detected',
    })
    .catch(() => {})
}

// ============================================================================
// Content Script Injection
// ============================================================================

/**
 * Error types for content script injection
 * Note: Using regular enum instead of const enum for isolatedModules compatibility
 */
enum InjectionError {
  /** Page is a chrome:// or other restricted URL */
  RestrictedPage = 'restricted_page',
  /** Missing scripting permission */
  NoPermission = 'no_permission',
  /** Tab was closed or navigated away */
  TabGone = 'tab_gone',
  /** Unknown error */
  Unknown = 'unknown',
}

/**
 * Categorize an injection error
 */
function categorizeInjectionError(error: unknown): InjectionError {
  if (!(error instanceof Error)) return InjectionError.Unknown

  const message = error.message.toLowerCase()

  // Check for restricted page errors
  if (
    message.includes('cannot access') ||
    message.includes('chrome://') ||
    message.includes('chrome-extension://') ||
    message.includes('edge://') ||
    message.includes('about:') ||
    message.includes('file://')
  ) {
    return InjectionError.RestrictedPage
  }

  // Check for permission errors
  if (message.includes('permission') || message.includes('not allowed')) {
    return InjectionError.NoPermission
  }

  // Check for tab gone errors
  if (
    message.includes('no tab') ||
    message.includes('tab was closed') ||
    message.includes('invalid tab')
  ) {
    return InjectionError.TabGone
  }

  return InjectionError.Unknown
}

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
    const errorType = categorizeInjectionError(error)

    switch (errorType) {
      case InjectionError.RestrictedPage:
        // Silently ignore - this is expected for chrome://, about:, etc.
        console.debug(`[Fict DevTools] Tab ${tabId} is a restricted page, skipping injection`)
        break

      case InjectionError.NoPermission:
        console.warn(
          `[Fict DevTools] Missing permission to inject into tab ${tabId}. ` +
            'Please ensure the extension has the "scripting" permission.',
        )
        break

      case InjectionError.TabGone:
        // Tab was closed or navigated, silently ignore
        console.debug(`[Fict DevTools] Tab ${tabId} is no longer available`)
        break

      default:
        console.debug(`[Fict DevTools] Failed to inject content script into tab ${tabId}:`, error)
    }
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
    console.debug('[Fict DevTools Background] Tab loading, resetting state for tab:', tabId)
    // Reset Fict detection on page reload
    const state = tabs.get(tabId)
    if (state) {
      state.fictDetected = false
      state.fictVersion = undefined
      updateIcon(tabId, false)

      // Notify DevTools panel that page is navigating
      // This allows the panel to clear its state
      if (state.devtools) {
        console.debug('[Fict DevTools Background] Notifying panel of page navigation')
        state.devtools.postMessage({
          source: 'fict-devtools-background',
          type: 'page-navigating',
        })
      }
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
