/**
 * Component Highlighter
 *
 * Provides visual highlighting of components in the DOM
 * for inspection and debugging purposes.
 */

export interface HighlightOptions {
  /** Border color */
  borderColor?: string
  /** Background color (with alpha) */
  backgroundColor?: string
  /** Label text */
  label?: string
  /** Show dimensions */
  showDimensions?: boolean
  /** Animation duration in ms */
  duration?: number
}

const DEFAULT_OPTIONS: Required<HighlightOptions> = {
  borderColor: '#42b883',
  backgroundColor: 'rgba(66, 184, 131, 0.1)',
  label: '',
  showDimensions: true,
  duration: 1500,
}

let overlayElement: HTMLDivElement | null = null
let labelElement: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let isInspecting = false
let inspectCallback: ((element: HTMLElement) => void) | null = null

/**
 * Create the overlay element
 */
function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.id = 'fict-devtools-overlay'
  overlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    border: 2px solid ${DEFAULT_OPTIONS.borderColor};
    background: ${DEFAULT_OPTIONS.backgroundColor};
    transition: all 0.1s ease-out;
    display: none;
  `
  return overlay
}

/**
 * Create the label element
 */
function createLabel(): HTMLDivElement {
  const label = document.createElement('div')
  label.id = 'fict-devtools-label'
  label.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    background: ${DEFAULT_OPTIONS.borderColor};
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 2px;
    white-space: nowrap;
    display: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  `
  return label
}

/**
 * Initialize the highlighter
 */
export function initHighlighter(): void {
  if (typeof document === 'undefined') return
  if (overlayElement) return

  overlayElement = createOverlay()
  labelElement = createLabel()

  document.body.appendChild(overlayElement)
  document.body.appendChild(labelElement)
}

/**
 * Destroy the highlighter
 */
export function destroyHighlighter(): void {
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }

  if (overlayElement) {
    overlayElement.remove()
    overlayElement = null
  }

  if (labelElement) {
    labelElement.remove()
    labelElement = null
  }

  stopInspecting()
}

/**
 * Highlight an element
 */
export function highlight(element: HTMLElement, options: HighlightOptions = {}): void {
  if (!overlayElement || !labelElement) {
    initHighlighter()
  }
  if (!overlayElement || !labelElement) return

  const opts = { ...DEFAULT_OPTIONS, ...options }
  const rect = element.getBoundingClientRect()

  // Update overlay position and style
  overlayElement.style.left = `${rect.left}px`
  overlayElement.style.top = `${rect.top}px`
  overlayElement.style.width = `${rect.width}px`
  overlayElement.style.height = `${rect.height}px`
  overlayElement.style.borderColor = opts.borderColor
  overlayElement.style.backgroundColor = opts.backgroundColor
  overlayElement.style.display = 'block'

  // Update label
  let labelText = opts.label
  if (opts.showDimensions) {
    labelText += ` ${Math.round(rect.width)} × ${Math.round(rect.height)}`
  }
  labelElement.textContent = labelText.trim()
  labelElement.style.background = opts.borderColor

  // Position label above or below the element
  const labelHeight = 20
  const padding = 4
  let labelTop = rect.top - labelHeight - padding

  if (labelTop < 0) {
    labelTop = rect.bottom + padding
  }

  labelElement.style.left = `${rect.left}px`
  labelElement.style.top = `${labelTop}px`
  labelElement.style.display = labelText.trim() ? 'block' : 'none'

  // Clear previous timeout
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }

  // Auto-hide after duration
  if (opts.duration > 0) {
    hideTimeout = setTimeout(() => {
      unhighlight()
    }, opts.duration)
  }
}

/**
 * Hide the highlight
 */
export function unhighlight(): void {
  if (overlayElement) {
    overlayElement.style.display = 'none'
  }
  if (labelElement) {
    labelElement.style.display = 'none'
  }
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }
}

/**
 * Highlight element and scroll it into view
 */
export function highlightAndScroll(element: HTMLElement, options: HighlightOptions = {}): void {
  element.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center',
  })

  // Wait for scroll to complete before highlighting
  setTimeout(() => {
    highlight(element, options)
  }, 300)
}

/**
 * Start inspect mode - allows user to click on elements
 */
export function startInspecting(callback: (element: HTMLElement) => void): void {
  if (isInspecting) return

  isInspecting = true
  inspectCallback = callback

  initHighlighter()

  // Add event listeners
  document.addEventListener('mousemove', handleInspectMouseMove, true)
  document.addEventListener('click', handleInspectClick, true)
  document.addEventListener('keydown', handleInspectKeyDown, true)

  // Change cursor
  document.body.style.cursor = 'crosshair'
}

/**
 * Stop inspect mode
 */
export function stopInspecting(): void {
  if (!isInspecting) return

  isInspecting = false
  inspectCallback = null

  // Remove event listeners
  document.removeEventListener('mousemove', handleInspectMouseMove, true)
  document.removeEventListener('click', handleInspectClick, true)
  document.removeEventListener('keydown', handleInspectKeyDown, true)

  // Reset cursor
  document.body.style.cursor = ''

  unhighlight()
}

/**
 * Handle mouse move during inspection
 */
function handleInspectMouseMove(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()

  const target = event.target as HTMLElement
  if (!target || target === overlayElement || target === labelElement) return

  // Find the closest component element
  const componentElement = findComponentElement(target)
  if (componentElement) {
    const componentName = getComponentName(componentElement)
    highlight(componentElement, {
      label: componentName || 'Component',
      duration: 0, // Don't auto-hide during inspection
    })
  } else {
    highlight(target, {
      label: target.tagName.toLowerCase(),
      duration: 0,
    })
  }
}

/**
 * Handle click during inspection
 */
function handleInspectClick(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()

  const target = event.target as HTMLElement
  if (!target || target === overlayElement || target === labelElement) return

  const componentElement = findComponentElement(target)
  const selectedElement = componentElement || target

  if (inspectCallback) {
    inspectCallback(selectedElement)
  }

  stopInspecting()
}

/**
 * Handle key down during inspection
 */
function handleInspectKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    stopInspecting()
  }
}

/**
 * Find the closest element that represents a Fict component
 */
function findComponentElement(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element

  while (current) {
    // Check for component marker
    if (current.hasAttribute('data-fict-component')) {
      return current
    }
    // Check for component ID
    if (
      (current as HTMLElement & { __fict_component_id__?: number }).__fict_component_id__ !==
      undefined
    ) {
      return current
    }
    current = current.parentElement
  }

  return null
}

/**
 * Get the component name from an element
 */
function getComponentName(element: HTMLElement): string | null {
  // Check data attribute
  const dataName = element.getAttribute('data-fict-component')
  if (dataName) return dataName

  // Check __fict_component_name__ property
  const propName = (element as HTMLElement & { __fict_component_name__?: string })
    .__fict_component_name__
  if (propName) return propName

  return null
}

/**
 * Flash an element to indicate an update
 */
export function flashUpdate(element: HTMLElement, color = '#42b883'): void {
  const originalTransition = element.style.transition
  const originalOutline = element.style.outline

  element.style.transition = 'outline 0.2s ease-out'
  element.style.outline = `2px solid ${color}`

  setTimeout(() => {
    element.style.outline = 'none'
    setTimeout(() => {
      element.style.transition = originalTransition
      element.style.outline = originalOutline
    }, 200)
  }, 200)
}

/**
 * Highlight multiple elements
 */
export function highlightMultiple(elements: HTMLElement[], options: HighlightOptions = {}): void {
  if (elements.length === 0) return

  if (elements.length === 1) {
    highlight(elements[0]!, options)
    return
  }

  // Calculate bounding box of all elements
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const element of elements) {
    const rect = element.getBoundingClientRect()
    minX = Math.min(minX, rect.left)
    minY = Math.min(minY, rect.top)
    maxX = Math.max(maxX, rect.right)
    maxY = Math.max(maxY, rect.bottom)
  }

  // Create temporary element for highlighting
  const tempElement = document.createElement('div')
  tempElement.style.position = 'fixed'
  tempElement.style.left = `${minX}px`
  tempElement.style.top = `${minY}px`
  tempElement.style.width = `${maxX - minX}px`
  tempElement.style.height = `${maxY - minY}px`
  tempElement.style.pointerEvents = 'none'

  document.body.appendChild(tempElement)

  highlight(tempElement, {
    ...options,
    showDimensions: false,
  })

  // Clean up temp element after highlight duration
  const duration = options.duration ?? DEFAULT_OPTIONS.duration
  setTimeout(() => {
    tempElement.remove()
  }, duration)
}

export default {
  initHighlighter,
  destroyHighlighter,
  highlight,
  unhighlight,
  highlightAndScroll,
  startInspecting,
  stopInspecting,
  flashUpdate,
  highlightMultiple,
}
