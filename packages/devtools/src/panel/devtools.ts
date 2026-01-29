/**
 * DevTools Entry Point
 *
 * This script runs when Chrome DevTools is opened.
 * It creates the Fict DevTools panel.
 */

// Create the DevTools panel
chrome.devtools.panels.create(
  'Fict', // Panel title
  'icons/icon16.png', // Panel icon
  'panel.html', // Panel HTML page
  panel => {
    // Panel created
    console.log('[Fict DevTools] Panel created')

    // Optional: Handle panel show/hide events
    panel.onShown.addListener(window => {
      // Panel is shown
      window.postMessage({ type: 'panel:shown' }, '*')
    })

    panel.onHidden.addListener(() => {
      // Panel is hidden
    })
  },
)
