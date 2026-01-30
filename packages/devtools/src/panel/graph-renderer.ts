/**
 * Fict DevTools Dependency Graph Renderer
 *
 * A Canvas-based graph visualization for reactive dependency chains.
 * Renders Signal → Computed → Effect relationships.
 */

import type { DependencyGraph, NodeType } from '../core/types'

interface GraphNode {
  id: number
  x: number
  y: number
  type: NodeType
  name: string
  value?: unknown
  isDirty?: boolean
}

interface GraphEdge {
  from: number
  to: number
}

export interface GraphRendererOptions {
  container: HTMLElement
  onNodeSelect?: (nodeId: number) => void
  onNodeHover?: (nodeId: number | null) => void
}

// Node type colors
const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  signal: { bg: '#10b981', border: '#059669', text: '#fff' },
  computed: { bg: '#3b82f6', border: '#2563eb', text: '#fff' },
  effect: { bg: '#f59e0b', border: '#d97706', text: '#fff' },
  'effect-scope': { bg: '#8b5cf6', border: '#7c3aed', text: '#fff' },
  root: { bg: '#6b7280', border: '#4b5563', text: '#fff' },
  component: { bg: '#ec4899', border: '#db2777', text: '#fff' },
}

export class GraphRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private nodes: GraphNode[] = []
  private edges: GraphEdge[] = []
  private selectedNode: number | null = null
  private hoveredNode: number | null = null
  private offset = { x: 0, y: 0 }
  private scale = 1
  private isDragging = false
  private dragStart = { x: 0, y: 0 }
  private options: GraphRendererOptions
  private animationFrame: number | null = null
  private lastGraph: DependencyGraph | null = null
  private resizeObserver: ResizeObserver | null = null
  private highlightedNodes = new Set<number>()

  constructor(options: GraphRendererOptions) {
    this.options = options

    // Create Canvas
    this.canvas = document.createElement('canvas')
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.cursor = 'grab'
    options.container.appendChild(this.canvas)

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to get canvas context')
    this.ctx = ctx

    this.setupEventListeners()
    this.resize()

    // Watch for resize
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(options.container)
    }
  }

  private setupEventListeners(): void {
    // Drag to pan
    this.canvas.addEventListener('mousedown', e => {
      this.isDragging = true
      this.dragStart = { x: e.clientX - this.offset.x, y: e.clientY - this.offset.y }
      this.canvas.style.cursor = 'grabbing'
    })

    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      if (this.isDragging) {
        this.offset.x = e.clientX - this.dragStart.x
        this.offset.y = e.clientY - this.dragStart.y
        this.scheduleRender()
      } else {
        // Check hover
        const node = this.getNodeAtPosition(x, y)
        if (node?.id !== this.hoveredNode) {
          this.hoveredNode = node?.id ?? null
          this.options.onNodeHover?.(this.hoveredNode)
          this.canvas.style.cursor = node ? 'pointer' : 'grab'
          this.scheduleRender()
        }
      }
    })

    this.canvas.addEventListener('mouseup', () => {
      this.isDragging = false
      this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab'
    })

    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false
      this.canvas.style.cursor = 'grab'
      if (this.hoveredNode !== null) {
        this.hoveredNode = null
        this.options.onNodeHover?.(null)
        this.scheduleRender()
      }
    })

    this.canvas.addEventListener('click', e => {
      const rect = this.canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const node = this.getNodeAtPosition(x, y)

      if (node) {
        this.selectedNode = node.id
        this.options.onNodeSelect?.(node.id)
        this.scheduleRender()
      }
    })

    // Zoom with wheel
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newScale = Math.max(0.2, Math.min(3, this.scale * delta))

      // Zoom towards mouse position
      const rect = this.canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      this.offset.x = mouseX - ((mouseX - this.offset.x) / this.scale) * newScale
      this.offset.y = mouseY - ((mouseY - this.offset.y) / this.scale) * newScale
      this.scale = newScale

      this.scheduleRender()
    })
  }

  private resize(): void {
    // Check if canvas is still in the DOM
    if (!this.canvas.parentElement) return

    const rect = this.canvas.parentElement.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    this.canvas.width = rect.width * dpr
    this.canvas.height = rect.height * dpr
    this.canvas.style.width = rect.width + 'px'
    this.canvas.style.height = rect.height + 'px'

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.scheduleRender()
  }

  setGraph(graph: DependencyGraph | null): void {
    this.lastGraph = graph

    if (!graph) {
      this.nodes = []
      this.edges = []
      this.scheduleRender()
      return
    }

    // Convert graph data to render nodes
    this.edges = graph.edges.map(([from, to]) => ({ from, to }))

    // Layout nodes using hierarchical algorithm
    this.nodes = this.layoutNodes(graph)

    // Select root node
    this.selectedNode = graph.rootId

    // Center the graph
    this.centerGraph()
    this.scheduleRender()
  }

  private layoutNodes(graph: DependencyGraph): GraphNode[] {
    const nodes: GraphNode[] = []
    const levels = new Map<number, number>()
    const visited = new Set<number>()

    // BFS to determine levels (depth from root)
    const queue: { id: number; level: number }[] = [{ id: graph.rootId, level: 0 }]

    while (queue.length > 0) {
      const { id, level } = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)

      // Keep the minimum level (closest to root)
      if (!levels.has(id) || level < levels.get(id)!) {
        levels.set(id, level)
      }

      const node = graph.nodes.get(id)
      if (node) {
        // Traverse sources (dependencies) - they go to lower levels
        for (const sourceId of node.sources) {
          if (!visited.has(sourceId)) {
            queue.push({ id: sourceId, level: level - 1 })
          }
        }
        // Traverse observers - they go to higher levels
        for (const obsId of node.observers) {
          if (!visited.has(obsId)) {
            queue.push({ id: obsId, level: level + 1 })
          }
        }
      }
    }

    // Group by level
    const levelGroups = new Map<number, number[]>()
    for (const [id, level] of levels) {
      if (!levelGroups.has(level)) levelGroups.set(level, [])
      levelGroups.get(level)!.push(id)
    }

    // Calculate positions
    const levelSpacing = 100
    const nodeSpacing = 100
    const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b)

    // Normalize levels to start from 0
    const minLevel = sortedLevels[0] || 0

    for (const level of sortedLevels) {
      const ids = levelGroups.get(level)!
      const normalizedLevel = level - minLevel
      const y = normalizedLevel * levelSpacing
      const totalWidth = (ids.length - 1) * nodeSpacing
      const startX = -totalWidth / 2

      ids.forEach((id, i) => {
        const graphNode = graph.nodes.get(id)!
        nodes.push({
          id,
          x: startX + i * nodeSpacing,
          y,
          type: graphNode.type,
          name: graphNode.name,
          value: graphNode.value,
          isDirty: graphNode.isDirty,
        })
      })
    }

    return nodes
  }

  private centerGraph(): void {
    if (this.nodes.length === 0) return

    const bounds = this.getGraphBounds()
    const canvasWidth = this.canvas.width / (window.devicePixelRatio || 1)
    const canvasHeight = this.canvas.height / (window.devicePixelRatio || 1)

    const graphWidth = bounds.maxX - bounds.minX
    const graphHeight = bounds.maxY - bounds.minY

    // Auto-fit scale
    const padding = 80
    const scaleX = (canvasWidth - padding * 2) / Math.max(graphWidth, 1)
    const scaleY = (canvasHeight - padding * 2) / Math.max(graphHeight, 1)
    this.scale = Math.min(1.5, Math.max(0.3, Math.min(scaleX, scaleY)))

    // Center offset
    this.offset.x = canvasWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * this.scale
    this.offset.y = canvasHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * this.scale
  }

  private getGraphBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    if (this.nodes.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    }

    let minX = Infinity,
      maxX = -Infinity
    let minY = Infinity,
      maxY = -Infinity

    for (const node of this.nodes) {
      minX = Math.min(minX, node.x - 30)
      maxX = Math.max(maxX, node.x + 30)
      minY = Math.min(minY, node.y - 30)
      maxY = Math.max(maxY, node.y + 50)
    }

    return { minX, maxX, minY, maxY }
  }

  private getNodeAtPosition(x: number, y: number): GraphNode | null {
    const worldX = (x - this.offset.x) / this.scale
    const worldY = (y - this.offset.y) / this.scale
    const nodeRadius = 25

    // Check in reverse order (top-most first)
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]
      const dx = worldX - node.x
      const dy = worldY - node.y
      if (dx * dx + dy * dy <= nodeRadius * nodeRadius) {
        return node
      }
    }
    return null
  }

  private scheduleRender(): void {
    if (this.animationFrame) return
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null
      this.render()
    })
  }

  private render(): void {
    const ctx = this.ctx
    const width = this.canvas.width / (window.devicePixelRatio || 1)
    const height = this.canvas.height / (window.devicePixelRatio || 1)

    // Clear canvas
    ctx.clearRect(0, 0, width, height)

    // Draw background pattern
    this.drawBackground(width, height)

    if (this.nodes.length === 0) {
      // Draw empty state
      ctx.fillStyle = '#9ca3af'
      ctx.font = '14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Select a node to view its dependency graph', width / 2, height / 2)
      return
    }

    // Apply transform
    ctx.save()
    ctx.translate(this.offset.x, this.offset.y)
    ctx.scale(this.scale, this.scale)

    // Draw edges first (behind nodes)
    for (const edge of this.edges) {
      const from = this.nodes.find(n => n.id === edge.from)
      const to = this.nodes.find(n => n.id === edge.to)
      if (from && to) {
        this.drawEdge(from, to)
      }
    }

    // Draw nodes
    for (const node of this.nodes) {
      this.drawNode(node)
    }

    ctx.restore()

    // Draw legend (fixed position)
    this.drawLegend(width, height)
  }

  private drawBackground(width: number, height: number): void {
    const ctx = this.ctx

    // Grid pattern
    ctx.strokeStyle = '#e5e7eb20'
    ctx.lineWidth = 1

    const gridSize = 20 * this.scale
    const offsetX = this.offset.x % gridSize
    const offsetY = this.offset.y % gridSize

    ctx.beginPath()
    for (let x = offsetX; x < width; x += gridSize) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
    }
    for (let y = offsetY; y < height; y += gridSize) {
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
    }
    ctx.stroke()
  }

  private drawEdge(from: GraphNode, to: GraphNode): void {
    const ctx = this.ctx

    // Calculate control points for curved edge
    const midY = (from.y + to.y) / 2
    const dx = to.x - from.x

    ctx.strokeStyle = '#9ca3af'
    ctx.lineWidth = 2

    ctx.beginPath()
    ctx.moveTo(from.x, from.y + 25) // Start from bottom of node

    // Use bezier curve for smoother appearance
    if (Math.abs(dx) < 10) {
      // Straight line for vertically aligned nodes
      ctx.lineTo(to.x, to.y - 25)
    } else {
      ctx.bezierCurveTo(from.x, midY, to.x, midY, to.x, to.y - 25)
    }

    ctx.stroke()

    // Draw arrow
    const angle = Math.atan2(to.y - 25 - midY, to.x - to.x) || Math.PI / 2
    const arrowSize = 8
    const arrowX = to.x
    const arrowY = to.y - 25

    ctx.fillStyle = '#9ca3af'
    ctx.beginPath()
    ctx.moveTo(arrowX, arrowY)
    ctx.lineTo(
      arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
      arrowY - arrowSize * Math.sin(angle - Math.PI / 6),
    )
    ctx.lineTo(
      arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
      arrowY - arrowSize * Math.sin(angle + Math.PI / 6),
    )
    ctx.closePath()
    ctx.fill()
  }

  private drawNode(node: GraphNode): void {
    const ctx = this.ctx
    const radius = 25
    const colors = NODE_COLORS[node.type] || NODE_COLORS.signal

    const isSelected = node.id === this.selectedNode
    const isHovered = node.id === this.hoveredNode
    const isHighlighted = this.highlightedNodes.has(node.id)

    // Shadow for selected/hovered/highlighted
    if (isSelected || isHovered || isHighlighted) {
      ctx.shadowColor = isHighlighted ? '#fbbf24' : colors.bg
      ctx.shadowBlur = isSelected ? 20 : isHighlighted ? 15 : 10
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }

    // Node circle
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = colors.bg
    ctx.fill()

    // Border
    ctx.strokeStyle = isHighlighted ? '#fbbf24' : isSelected ? '#fff' : colors.border
    ctx.lineWidth = isSelected || isHighlighted ? 3 : 2
    ctx.stroke()

    // Reset shadow
    ctx.shadowBlur = 0

    // Type label
    ctx.fillStyle = colors.text
    ctx.font = 'bold 14px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const typeLabel = node.type === 'effect-scope' ? 'ES' : node.type[0].toUpperCase()
    ctx.fillText(typeLabel, node.x, node.y)

    // Name below node
    ctx.fillStyle = isSelected ? '#1f2937' : '#6b7280'
    ctx.font = '11px system-ui, sans-serif'
    const displayName = node.name.length > 18 ? node.name.slice(0, 15) + '...' : node.name
    ctx.fillText(displayName, node.x, node.y + radius + 14)

    // Dirty indicator
    if (node.isDirty) {
      ctx.fillStyle = '#ef4444'
      ctx.beginPath()
      ctx.arc(node.x + radius - 6, node.y - radius + 6, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 8px system-ui'
      ctx.fillText('!', node.x + radius - 6, node.y - radius + 7)
    }
  }

  private drawLegend(width: number, height: number): void {
    const ctx = this.ctx
    const legends = [
      { type: 'signal', label: 'Signal' },
      { type: 'computed', label: 'Computed' },
      { type: 'effect', label: 'Effect' },
    ]

    const padding = 12
    const itemHeight = 20
    const dotRadius = 6

    ctx.font = '11px system-ui, sans-serif'

    let x = padding
    const y = height - padding - itemHeight / 2

    // Background
    const totalWidth = legends.reduce((sum, l) => sum + ctx.measureText(l.label).width + 30, 0)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.beginPath()
    ctx.roundRect(padding - 8, y - itemHeight / 2 - 4, totalWidth + 16, itemHeight + 8, 4)
    ctx.fill()

    for (const legend of legends) {
      const colors = NODE_COLORS[legend.type]

      // Dot
      ctx.beginPath()
      ctx.arc(x + dotRadius, y, dotRadius, 0, Math.PI * 2)
      ctx.fillStyle = colors.bg
      ctx.fill()

      // Label
      ctx.fillStyle = '#6b7280'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(legend.label, x + dotRadius * 2 + 6, y)

      x += ctx.measureText(legend.label).width + 30
    }
  }

  getSelectedNode(): GraphNode | null {
    return this.nodes.find(n => n.id === this.selectedNode) || null
  }

  getGraph(): DependencyGraph | null {
    return this.lastGraph
  }

  setHighlightedNodes(nodeIds: Set<number>): void {
    this.highlightedNodes = nodeIds
    this.scheduleRender()
  }

  getNodes(): GraphNode[] {
    return this.nodes
  }

  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    this.canvas.remove()
  }
}
