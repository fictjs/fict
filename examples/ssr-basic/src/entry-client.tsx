import { installResumableLoader } from 'fict/experimental/loader'

// Import App to ensure its handlers are included in the client build
// The handlers will be code-split into separate chunks for lazy loading
import './App'

// Load the manifest for production builds to resolve virtual module URLs
async function loadManifest() {
  try {
    const response = await fetch('/fict.manifest.json')
    if (response.ok) {
      const manifest = await response.json()
      ;(globalThis as Record<string, unknown>).__FICT_MANIFEST__ = manifest
    }
  } catch {
    // In development or if manifest doesn't exist, skip
  }
}

// Initialize resumable loader
async function init() {
  // Load manifest first (for production)
  await loadManifest()

  // Install the resumable loader to handle lazy-loaded event handlers
  // This intercepts events on elements with on:click, on:input, etc. attributes
  // and lazily loads + executes the handler code
  installResumableLoader({
    document,
    prefetch: {
      // Prefetch handlers when elements become visible
      visibility: true,
      visibilityMargin: '200px',
      // Also prefetch on hover for faster response
      hover: true,
      hoverDelay: 50,
    },
  })

  console.log('[Fict SSR] Client hydration installed - handlers will be lazy loaded on interaction')
}

init()
