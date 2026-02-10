import { describe, expect, it } from 'vitest'

import { NodeType, TimelineEventType, type TimelineEvent } from '../src/core/types'
import { createDefaultLayers, renderEventDetails } from '../src/panel/timeline-renderer'

describe('timeline renderer detail links', () => {
  it('renders clickable node links when node id and type are present', () => {
    const event: TimelineEvent = {
      id: 1,
      type: TimelineEventType.ComponentRender,
      timestamp: 1735689600000,
      nodeId: 42,
      nodeType: NodeType.Component,
      nodeName: 'Counter',
    }

    const html = renderEventDetails(event, createDefaultLayers())

    expect(html).toContain('timeline-node-link')
    expect(html).toContain('data-node-id="42"')
    expect(html).toContain('data-node-type="component"')
  })

  it('keeps node details non-clickable when node type is missing', () => {
    const event: TimelineEvent = {
      id: 2,
      type: TimelineEventType.Warning,
      timestamp: 1735689600000,
      nodeId: 7,
      nodeName: 'unknown node',
    }

    const html = renderEventDetails(event, createDefaultLayers())

    expect(html).not.toContain('timeline-node-link')
    expect(html).toContain('unknown node')
    expect(html).toContain('#7')
  })
})
