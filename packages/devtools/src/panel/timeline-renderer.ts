/**
 * Fict DevTools Timeline Renderer
 *
 * A multi-layer timeline visualization for reactive events.
 * Supports filtering by event type and layer toggling.
 */

import {
  type TimelineEvent,
  type TimelineLayer,
  TimelineEventType,
  BuiltinTimelineLayer,
  DEFAULT_TIMELINE_LAYERS,
} from '../core/types'

export interface TimelineRendererOptions {
  container: HTMLElement
  events: TimelineEvent[]
  layers?: TimelineLayer[]
  onEventSelect?: (event: TimelineEvent) => void
  onLayerToggle?: (layerId: string, enabled: boolean) => void
}

/**
 * Get the layer ID for an event type
 */
export function getEventLayerId(type: TimelineEventType): string {
  if (type.startsWith('signal:')) return BuiltinTimelineLayer.Signals
  if (type.startsWith('computed:')) return BuiltinTimelineLayer.Computeds
  if (type.startsWith('effect:')) return BuiltinTimelineLayer.Effects
  if (type.startsWith('component:')) return BuiltinTimelineLayer.Components
  if (type.startsWith('batch:') || type.startsWith('flush:')) return BuiltinTimelineLayer.Batches
  if (type === TimelineEventType.Error || type === TimelineEventType.Warning)
    return BuiltinTimelineLayer.Errors
  return 'other'
}

/**
 * Get icon for timeline event
 */
export function getEventIcon(type: TimelineEventType): string {
  switch (type) {
    case TimelineEventType.SignalCreate:
      return '📊'
    case TimelineEventType.SignalUpdate:
      return '✏️'
    case TimelineEventType.ComputedCreate:
      return '🔄'
    case TimelineEventType.ComputedUpdate:
      return '🔃'
    case TimelineEventType.EffectCreate:
      return '⚡'
    case TimelineEventType.EffectRun:
      return '▶️'
    case TimelineEventType.EffectCleanup:
      return '🧹'
    case TimelineEventType.EffectDispose:
      return '🗑️'
    case TimelineEventType.ComponentMount:
      return '🟢'
    case TimelineEventType.ComponentUnmount:
      return '⚪'
    case TimelineEventType.ComponentRender:
      return '🎨'
    case TimelineEventType.BatchStart:
      return '📦'
    case TimelineEventType.BatchEnd:
      return '📦'
    case TimelineEventType.FlushStart:
      return '💨'
    case TimelineEventType.FlushEnd:
      return '💨'
    case TimelineEventType.Error:
      return '❌'
    case TimelineEventType.Warning:
      return '⚠️'
    default:
      return '•'
  }
}

/**
 * Format event type for display
 */
export function formatEventType(type: TimelineEventType): string {
  return type
    .replace(':', ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return (
    date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) +
    '.' +
    String(date.getMilliseconds()).padStart(3, '0')
  )
}

/**
 * Escape HTML special characters
 */
function escapeHtml(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value ?? '')
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render timeline with layers
 */
export function renderTimeline(
  events: TimelineEvent[],
  layers: TimelineLayer[],
  selectedEventId: number | null,
): string {
  // Get enabled layer IDs
  const enabledLayers = new Set(layers.filter(l => l.enabled).map(l => l.id))

  // Filter events by enabled layers
  const filteredEvents = events.filter(e => {
    const layerId = getEventLayerId(e.type)
    return enabledLayers.has(layerId)
  })

  // Group events by time (every 100ms)
  const groups = groupEventsByTime(filteredEvents, 100)
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => b - a)

  return `
    <div class="timeline-panel">
      <div class="timeline-layers">
        <div class="layers-header">
          <span>Layers</span>
          <button class="btn-small" id="toggle-all-layers" title="Toggle all">All</button>
        </div>
        <div class="layers-list">
          ${layers
            .map(
              layer => `
            <label class="layer-item" style="--layer-color: ${layer.color}">
              <input
                type="checkbox"
                class="layer-toggle"
                data-layer-id="${layer.id}"
                ${layer.enabled ? 'checked' : ''}
              />
              <span class="layer-color"></span>
              <span class="layer-label">${escapeHtml(layer.label)}</span>
              <span class="layer-count">${getLayerEventCount(events, layer.id)}</span>
            </label>
          `,
            )
            .join('')}
        </div>
      </div>

      <div class="timeline-track">
        <div class="timeline-events">
          ${
            sortedGroups.length === 0
              ? '<div class="empty-message">No events to display</div>'
              : sortedGroups
                  .slice(0, 50) // Limit to 50 groups for performance
                  .map(
                    ([timestamp, groupEvents]) => `
                <div class="event-group">
                  <div class="event-time">${formatTimestamp(timestamp)}</div>
                  <div class="event-items">
                    ${groupEvents
                      .map(event => renderEventItem(event, layers, selectedEventId === event.id))
                      .join('')}
                  </div>
                </div>
              `,
                  )
                  .join('')
          }
        </div>
      </div>

      <div class="event-details" id="timeline-event-details">
        ${selectedEventId ? '' : '<p class="hint">Select an event to view details</p>'}
      </div>
    </div>
  `
}

function renderEventItem(
  event: TimelineEvent,
  layers: TimelineLayer[],
  isSelected: boolean,
): string {
  const layerId = getEventLayerId(event.type)
  const layer = layers.find(l => l.id === layerId)
  const color = layer?.color || '#9ca3af'

  return `
    <div
      class="event-item ${isSelected ? 'selected' : ''}"
      data-event-id="${event.id}"
      style="--event-color: ${color}"
    >
      <span class="event-icon">${getEventIcon(event.type)}</span>
      <span class="event-type">${formatEventType(event.type)}</span>
      ${event.nodeName ? `<span class="event-name">${escapeHtml(event.nodeName)}</span>` : ''}
      ${event.duration !== undefined ? `<span class="event-duration">${event.duration.toFixed(1)}ms</span>` : ''}
    </div>
  `
}

export function renderEventDetails(event: TimelineEvent | null, layers: TimelineLayer[]): string {
  if (!event) {
    return '<p class="hint">Select an event to view details</p>'
  }

  const layerId = getEventLayerId(event.type)
  const layer = layers.find(l => l.id === layerId)

  return `
    <div class="details-header" style="border-left: 3px solid ${layer?.color || '#9ca3af'}">
      <span class="event-icon">${getEventIcon(event.type)}</span>
      <span class="event-type">${formatEventType(event.type)}</span>
    </div>
    <div class="details-content">
      <div class="detail-row">
        <span class="label">Time</span>
        <span class="value">${formatTimestamp(event.timestamp)}</span>
      </div>
      <div class="detail-row">
        <span class="label">Layer</span>
        <span class="value">${layer?.label || 'Unknown'}</span>
      </div>
      ${
        event.nodeId !== undefined
          ? `
        <div class="detail-row">
          <span class="label">Node ID</span>
          <span class="value">#${event.nodeId}</span>
        </div>
      `
          : ''
      }
      ${
        event.nodeName
          ? `
        <div class="detail-row">
          <span class="label">Node</span>
          <span class="value">${escapeHtml(event.nodeName)}</span>
        </div>
      `
          : ''
      }
      ${
        event.duration !== undefined
          ? `
        <div class="detail-row">
          <span class="label">Duration</span>
          <span class="value">${event.duration.toFixed(2)}ms</span>
        </div>
      `
          : ''
      }
      ${
        event.groupId !== undefined
          ? `
        <div class="detail-row">
          <span class="label">Group</span>
          <span class="value">#${event.groupId}</span>
        </div>
      `
          : ''
      }
      ${
        event.data
          ? `
        <div class="detail-section">
          <span class="label">Data</span>
          <pre class="data-preview">${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
        </div>
      `
          : ''
      }
    </div>
  `
}

function groupEventsByTime(
  events: TimelineEvent[],
  interval: number,
): Map<number, TimelineEvent[]> {
  const groups = new Map<number, TimelineEvent[]>()

  for (const event of events) {
    const groupKey = Math.floor(event.timestamp / interval) * interval
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey)!.push(event)
  }

  return groups
}

function getLayerEventCount(events: TimelineEvent[], layerId: string): number {
  return events.filter(e => getEventLayerId(e.type) === layerId).length
}

/**
 * Create a copy of layers with updated enabled state
 */
export function toggleLayer(
  layers: TimelineLayer[],
  layerId: string,
  enabled: boolean,
): TimelineLayer[] {
  return layers.map(l => (l.id === layerId ? { ...l, enabled } : l))
}

/**
 * Toggle all layers on or off
 */
export function toggleAllLayers(layers: TimelineLayer[], enabled: boolean): TimelineLayer[] {
  return layers.map(l => ({ ...l, enabled }))
}

/**
 * Create default timeline layers
 */
export function createDefaultLayers(): TimelineLayer[] {
  return DEFAULT_TIMELINE_LAYERS.map(l => ({ ...l }))
}
