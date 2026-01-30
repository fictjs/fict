/**
 * Fict DevTools Virtual List
 *
 * A lightweight virtual scrolling implementation for large lists.
 * Only renders visible items plus a small overscan buffer.
 */

export interface VirtualListOptions<T> {
  /** Container element */
  container: HTMLElement
  /** Items to render */
  items: T[]
  /** Height of each item in pixels */
  itemHeight: number
  /** Function to render an item to HTML string */
  renderItem: (item: T, index: number) => string
  /** Number of extra items to render above/below viewport */
  overscan?: number
  /** Callback when an item is clicked */
  onItemClick?: (item: T, index: number, event: MouseEvent) => void
  /** CSS class for the scroll container */
  containerClass?: string
}

export class VirtualList<T> {
  private container: HTMLElement
  private items: T[]
  private itemHeight: number
  private renderItem: (item: T, index: number) => string
  private overscan: number
  private onItemClick?: (item: T, index: number, event: MouseEvent) => void

  private scrollContainer: HTMLElement
  private contentWrapper: HTMLElement
  private visibleStart = 0
  private visibleEnd = 0
  private scrollTop = 0
  private viewportHeight = 0
  private isDestroyed = false
  private rafId: number | null = null

  constructor(options: VirtualListOptions<T>) {
    this.container = options.container
    this.items = options.items
    this.itemHeight = options.itemHeight
    this.renderItem = options.renderItem
    this.overscan = options.overscan ?? 5
    this.onItemClick = options.onItemClick

    // Create scroll container
    this.scrollContainer = document.createElement('div')
    this.scrollContainer.className = options.containerClass || 'virtual-scroll-container'
    this.scrollContainer.style.cssText = `
      overflow-y: auto;
      height: 100%;
      position: relative;
    `

    // Create content wrapper (holds the full height for scrolling)
    this.contentWrapper = document.createElement('div')
    this.contentWrapper.className = 'virtual-scroll-content'
    this.contentWrapper.style.cssText = `
      position: relative;
      width: 100%;
    `

    this.scrollContainer.appendChild(this.contentWrapper)
    this.container.appendChild(this.scrollContainer)

    // Event listeners
    this.scrollContainer.addEventListener('scroll', this.handleScroll)
    this.contentWrapper.addEventListener('click', this.handleClick)

    // Initial render
    this.updateViewport()
    this.render()

    // Watch for resize
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (!this.isDestroyed) {
          this.updateViewport()
          this.render()
        }
      })
      observer.observe(this.scrollContainer)
    }
  }

  private handleScroll = (): void => {
    if (this.rafId !== null) return

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (this.isDestroyed) return

      this.scrollTop = this.scrollContainer.scrollTop
      this.render()
    })
  }

  private handleClick = (e: MouseEvent): void => {
    if (!this.onItemClick) return

    const target = (e.target as HTMLElement).closest('.virtual-list-item') as HTMLElement
    if (!target) return

    const index = parseInt(target.dataset.index || '-1', 10)
    if (index >= 0 && index < this.items.length) {
      this.onItemClick(this.items[index], index, e)
    }
  }

  private updateViewport(): void {
    this.viewportHeight = this.scrollContainer.clientHeight
  }

  setItems(items: T[]): void {
    this.items = items
    this.render()
  }

  updateItem(index: number, item: T): void {
    if (index >= 0 && index < this.items.length) {
      this.items[index] = item
      // Only re-render if this item is visible
      if (index >= this.visibleStart && index < this.visibleEnd) {
        this.render()
      }
    }
  }

  scrollToIndex(index: number, align: 'start' | 'center' | 'end' = 'start'): void {
    const targetTop = index * this.itemHeight
    let scrollTop: number

    switch (align) {
      case 'center':
        scrollTop = targetTop - this.viewportHeight / 2 + this.itemHeight / 2
        break
      case 'end':
        scrollTop = targetTop - this.viewportHeight + this.itemHeight
        break
      default:
        scrollTop = targetTop
    }

    this.scrollContainer.scrollTop = Math.max(0, scrollTop)
  }

  private render(): void {
    if (this.isDestroyed) return

    const totalHeight = this.items.length * this.itemHeight

    // Calculate visible range
    const startIndex = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - this.overscan)
    const endIndex = Math.min(
      this.items.length,
      Math.ceil((this.scrollTop + this.viewportHeight) / this.itemHeight) + this.overscan,
    )

    // Check if we need to update
    if (startIndex === this.visibleStart && endIndex === this.visibleEnd) {
      return
    }

    this.visibleStart = startIndex
    this.visibleEnd = endIndex

    // Update content height
    this.contentWrapper.style.height = `${totalHeight}px`

    // Render visible items
    const visibleItems = this.items.slice(startIndex, endIndex)
    const html = visibleItems
      .map((item, i) => {
        const actualIndex = startIndex + i
        const top = actualIndex * this.itemHeight
        return `
        <div
          class="virtual-list-item"
          style="position: absolute; top: ${top}px; left: 0; right: 0; height: ${this.itemHeight}px;"
          data-index="${actualIndex}"
        >
          ${this.renderItem(item, actualIndex)}
        </div>
      `
      })
      .join('')

    this.contentWrapper.innerHTML = html
  }

  getVisibleRange(): { start: number; end: number } {
    return { start: this.visibleStart, end: this.visibleEnd }
  }

  getScrollTop(): number {
    return this.scrollTop
  }

  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.isDestroyed = true

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
    }

    this.scrollContainer.removeEventListener('scroll', this.handleScroll)
    this.contentWrapper.removeEventListener('click', this.handleClick)
    this.scrollContainer.remove()
  }
}

/**
 * Helper to determine if virtual scrolling should be used
 */
export function shouldUseVirtualList(itemCount: number, threshold = 50): boolean {
  return itemCount > threshold
}
