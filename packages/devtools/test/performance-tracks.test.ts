import { describe, expect, it } from 'vitest'

import { NodeType, type TimelineEvent, TimelineEventType } from '../src/core/types'
import {
  buildChromeTraceFromTimeline,
  buildPerformanceTrackModel,
} from '../src/panel/performance-tracks'

describe('performance tracks', () => {
  it('builds grouped lanes and summary metrics from timeline events', () => {
    const timeline: TimelineEvent[] = [
      { id: 1, type: TimelineEventType.BatchStart, timestamp: 1 },
      {
        id: 2,
        type: TimelineEventType.SignalUpdate,
        timestamp: 1.25,
        nodeId: 10,
        nodeType: NodeType.Signal,
      },
      { id: 3, type: TimelineEventType.FlushStart, timestamp: 1.5 },
      {
        id: 4,
        type: TimelineEventType.EffectRun,
        timestamp: 2.0,
        duration: 0.4,
        nodeId: 20,
        nodeType: NodeType.Effect,
        nodeName: 'syncCounter',
      },
      {
        id: 5,
        type: TimelineEventType.ComponentRender,
        timestamp: 2.2,
        nodeId: 30,
        nodeType: NodeType.Component,
        nodeName: 'Counter',
      },
      { id: 6, type: TimelineEventType.FlushEnd, timestamp: 3.0 },
      { id: 7, type: TimelineEventType.BatchEnd, timestamp: 3.2 },
    ]

    const model = buildPerformanceTrackModel(timeline)

    expect(model.summary.totalEvents).toBe(7)
    expect(model.summary.batchCount).toBe(1)
    expect(model.summary.flushCount).toBe(1)
    expect(model.summary.effectRuns).toBe(1)
    expect(model.summary.componentRenders).toBe(1)
    expect(model.summary.signalUpdates).toBe(1)
    expect(model.summary.totalFlushDuration).toBeGreaterThan(1.4)
    expect(model.summary.totalEffectDuration).toBeGreaterThan(0.39)

    const commits = model.lanes.find(lane => lane.id === 'commits')
    const effects = model.lanes.find(lane => lane.id === 'effects')
    expect(commits?.segments.length).toBe(1)
    expect(effects?.segments.length).toBe(1)
    expect(effects?.segments[0]?.startTime).toBeCloseTo(1.6, 2)
  })

  it('closes unpaired batch/flush starts as open ranges', () => {
    const timeline: TimelineEvent[] = [
      { id: 1, type: TimelineEventType.BatchStart, timestamp: 5 },
      { id: 2, type: TimelineEventType.FlushStart, timestamp: 6 },
    ]

    const model = buildPerformanceTrackModel(timeline)

    const commits = model.lanes.find(lane => lane.id === 'commits')
    const batches = model.lanes.find(lane => lane.id === 'batches')
    expect(commits?.segments.length).toBe(1)
    expect(batches?.segments.length).toBe(1)
    expect(commits?.segments[0]?.label).toContain('(open)')
    expect(batches?.segments[0]?.label).toContain('(open)')
  })

  it('exports chrome trace events with metadata and lane events', () => {
    const timeline: TimelineEvent[] = [
      { id: 1, type: TimelineEventType.FlushStart, timestamp: 1.0 },
      { id: 2, type: TimelineEventType.FlushEnd, timestamp: 1.5 },
      {
        id: 3,
        type: TimelineEventType.EffectRun,
        timestamp: 2.0,
        duration: 0.2,
        nodeId: 3,
        nodeType: NodeType.Effect,
      },
    ]

    const trace = buildChromeTraceFromTimeline(timeline)

    expect(trace.displayTimeUnit).toBe('ms')
    expect(trace.metadata.source).toBe('fict-devtools-performance-tracks')
    expect(trace.traceEvents.some(event => event.name === 'process_name' && event.ph === 'M')).toBe(
      true,
    )
    expect(trace.traceEvents.some(event => event.cat === 'fict.commits')).toBe(true)
    expect(trace.traceEvents.some(event => event.cat === 'fict.effects')).toBe(true)
  })
})
