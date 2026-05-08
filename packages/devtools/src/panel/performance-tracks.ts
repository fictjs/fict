import { TimelineEventType, type TimelineEvent, type NodeType } from '../core/types'

const MIN_RANGE_DURATION_MS = 0.05
const MIN_POINT_DURATION_MS = 0.02
const TRACE_PROCESS_ID = 1
const TRACE_THREAD_COMMITS = 10
const TRACE_THREAD_BATCHES = 11
const TRACE_THREAD_EFFECTS = 12
const TRACE_THREAD_RENDERS = 13
const TRACE_THREAD_UPDATES = 14
const TRACE_THREAD_WARNINGS = 15
const TRACE_THREAD_TIMELINE = 16
const TRACE_FLOW_MULTIPLIER = 1_000_000
const TRACE_FLOW_FLUSH_OFFSET = 1_000_000_000

interface RangeStart {
  id: number
  timestamp: number
  nodeId?: number
  nodeType?: NodeType
  nodeName?: string
}

export interface PerformanceTrackSegment {
  eventId: number
  startTime: number
  endTime: number
  duration: number
  label: string
  type: TimelineEventType
  nodeId?: number
  nodeType?: NodeType
  nodeName?: string
}

export interface PerformanceTrackLane {
  id: string
  label: string
  color: string
  kind: 'range' | 'point'
  segments: PerformanceTrackSegment[]
}

export interface PerformanceTrackSummary {
  totalEvents: number
  flushCount: number
  batchCount: number
  effectRuns: number
  componentRenders: number
  signalUpdates: number
  computedUpdates: number
  warningCount: number
  totalFlushDuration: number
  maxFlushDuration: number
  totalEffectDuration: number
  maxEffectDuration: number
}

export interface PerformanceTrackModel {
  startTime: number
  endTime: number
  duration: number
  lanes: PerformanceTrackLane[]
  summary: PerformanceTrackSummary
}

interface TraceEvent {
  name: string
  cat: string
  ph: 'M' | 'X' | 'i' | 's' | 'f'
  ts: number
  pid: number
  tid: number
  dur?: number
  s?: 't'
  id?: number
  args?: Record<string, unknown>
}

export interface ChromeTraceFile {
  traceEvents: TraceEvent[]
  displayTimeUnit: 'ms'
  metadata: {
    source: string
    generatedAt: string
    eventCount: number
    laneCount?: number
    timelineEventCount?: number
    flowEventCount?: number
    timeRangeMs?: {
      start: number
      end: number
      duration: number
    }
  }
}

const round = (value: number): number => Math.round(value * 1000) / 1000

function parseDuration(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(fallback, value)
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return '0ms'
  if (value >= 1000) return `${round(value / 1000)}s`
  return `${round(value)}ms`
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function createSegment(
  eventId: number,
  startTime: number,
  endTime: number,
  type: TimelineEventType,
  label: string,
  node?: Pick<TimelineEvent, 'nodeId' | 'nodeType' | 'nodeName'>,
): PerformanceTrackSegment {
  const safeEnd = Math.max(endTime, startTime + MIN_POINT_DURATION_MS)
  return {
    eventId,
    startTime,
    endTime: safeEnd,
    duration: safeEnd - startTime,
    type,
    label,
    nodeId: node?.nodeId,
    nodeType: node?.nodeType,
    nodeName: node?.nodeName,
  }
}

function createEmptySummary(totalEvents: number): PerformanceTrackSummary {
  return {
    totalEvents,
    flushCount: 0,
    batchCount: 0,
    effectRuns: 0,
    componentRenders: 0,
    signalUpdates: 0,
    computedUpdates: 0,
    warningCount: 0,
    totalFlushDuration: 0,
    maxFlushDuration: 0,
    totalEffectDuration: 0,
    maxEffectDuration: 0,
  }
}

function appendUnclosedRanges(
  stack: RangeStart[],
  lane: PerformanceTrackSegment[],
  endTime: number,
  type: TimelineEventType,
  labelPrefix: string,
): void {
  while (stack.length > 0) {
    const start = stack.pop()!
    lane.push(
      createSegment(
        start.id,
        start.timestamp,
        Math.max(endTime, start.timestamp + MIN_RANGE_DURATION_MS),
        type,
        `${labelPrefix} (open)`,
        start,
      ),
    )
  }
}

export function buildPerformanceTrackModel(timeline: TimelineEvent[]): PerformanceTrackModel {
  const events = timeline
    .filter(
      event => event && typeof event.timestamp === 'number' && Number.isFinite(event.timestamp),
    )
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)

  if (events.length === 0) {
    return {
      startTime: 0,
      endTime: 0,
      duration: 0,
      lanes: [
        { id: 'commits', label: 'Commits', color: '#8b5cf6', kind: 'range', segments: [] },
        { id: 'batches', label: 'Batches', color: '#6b7280', kind: 'range', segments: [] },
        { id: 'effects', label: 'Effects', color: '#f59e0b', kind: 'range', segments: [] },
        { id: 'renders', label: 'Renders', color: '#3b82f6', kind: 'point', segments: [] },
        { id: 'updates', label: 'Updates', color: '#10b981', kind: 'point', segments: [] },
        { id: 'warnings', label: 'Warnings', color: '#ef4444', kind: 'point', segments: [] },
      ],
      summary: createEmptySummary(0),
    }
  }

  const summary = createEmptySummary(events.length)
  const commitSegments: PerformanceTrackSegment[] = []
  const batchSegments: PerformanceTrackSegment[] = []
  const effectSegments: PerformanceTrackSegment[] = []
  const renderSegments: PerformanceTrackSegment[] = []
  const updateSegments: PerformanceTrackSegment[] = []
  const warningSegments: PerformanceTrackSegment[] = []

  const flushStack: RangeStart[] = []
  const batchStack: RangeStart[] = []

  let minTime = events[0]!.timestamp
  let maxTime = events[events.length - 1]!.timestamp

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    minTime = Math.min(minTime, event.timestamp)
    maxTime = Math.max(maxTime, event.timestamp)

    switch (event.type) {
      case TimelineEventType.FlushStart:
        flushStack.push({
          id: event.id,
          timestamp: event.timestamp,
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          nodeName: event.nodeName,
        })
        break

      case TimelineEventType.FlushEnd: {
        const start = flushStack.pop()
        const startTime = start?.timestamp ?? event.timestamp
        const endTime = Math.max(event.timestamp, startTime + MIN_RANGE_DURATION_MS)
        const segment = createSegment(
          event.id,
          startTime,
          endTime,
          event.type,
          `Flush #${event.id}`,
          event,
        )
        commitSegments.push(segment)
        summary.flushCount++
        summary.totalFlushDuration += segment.duration
        summary.maxFlushDuration = Math.max(summary.maxFlushDuration, segment.duration)
        break
      }

      case TimelineEventType.BatchStart:
        batchStack.push({
          id: event.id,
          timestamp: event.timestamp,
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          nodeName: event.nodeName,
        })
        break

      case TimelineEventType.BatchEnd: {
        const start = batchStack.pop()
        const startTime = start?.timestamp ?? event.timestamp
        const endTime = Math.max(event.timestamp, startTime + MIN_RANGE_DURATION_MS)
        const segment = createSegment(
          event.id,
          startTime,
          endTime,
          event.type,
          `Batch #${event.id}`,
          event,
        )
        batchSegments.push(segment)
        summary.batchCount++
        break
      }

      case TimelineEventType.EffectRun: {
        const duration = parseDuration(event.duration, MIN_POINT_DURATION_MS)
        const startTime = event.timestamp - duration
        const endTime = event.timestamp
        const segment = createSegment(
          event.id,
          startTime,
          endTime,
          event.type,
          event.nodeName || `Effect #${event.nodeId ?? event.id}`,
          event,
        )
        effectSegments.push(segment)
        summary.effectRuns++
        summary.totalEffectDuration += segment.duration
        summary.maxEffectDuration = Math.max(summary.maxEffectDuration, segment.duration)
        minTime = Math.min(minTime, segment.startTime)
        break
      }

      case TimelineEventType.ComponentRender:
        renderSegments.push(
          createSegment(
            event.id,
            event.timestamp,
            event.timestamp + MIN_POINT_DURATION_MS,
            event.type,
            event.nodeName || `Component #${event.nodeId ?? event.id}`,
            event,
          ),
        )
        summary.componentRenders++
        break

      case TimelineEventType.SignalUpdate:
        updateSegments.push(
          createSegment(
            event.id,
            event.timestamp,
            event.timestamp + MIN_POINT_DURATION_MS,
            event.type,
            event.nodeName || `Signal #${event.nodeId ?? event.id}`,
            event,
          ),
        )
        summary.signalUpdates++
        break

      case TimelineEventType.ComputedUpdate:
        updateSegments.push(
          createSegment(
            event.id,
            event.timestamp,
            event.timestamp + MIN_POINT_DURATION_MS,
            event.type,
            event.nodeName || `Computed #${event.nodeId ?? event.id}`,
            event,
          ),
        )
        summary.computedUpdates++
        break

      case TimelineEventType.Warning:
      case TimelineEventType.Error:
        warningSegments.push(
          createSegment(
            event.id,
            event.timestamp,
            event.timestamp + MIN_POINT_DURATION_MS,
            event.type,
            event.nodeName || event.type,
            event,
          ),
        )
        summary.warningCount++
        break

      default:
        break
    }
  }

  appendUnclosedRanges(
    flushStack,
    commitSegments,
    maxTime + MIN_RANGE_DURATION_MS,
    TimelineEventType.FlushEnd,
    'Flush',
  )
  appendUnclosedRanges(
    batchStack,
    batchSegments,
    maxTime + MIN_RANGE_DURATION_MS,
    TimelineEventType.BatchEnd,
    'Batch',
  )

  for (const lane of [
    commitSegments,
    batchSegments,
    effectSegments,
    renderSegments,
    updateSegments,
  ]) {
    for (const segment of lane) {
      minTime = Math.min(minTime, segment.startTime)
      maxTime = Math.max(maxTime, segment.endTime)
    }
  }

  const totalDuration = Math.max(MIN_RANGE_DURATION_MS, maxTime - minTime)

  return {
    startTime: minTime,
    endTime: maxTime,
    duration: totalDuration,
    lanes: [
      {
        id: 'commits',
        label: 'Commits',
        color: '#8b5cf6',
        kind: 'range',
        segments: commitSegments,
      },
      { id: 'batches', label: 'Batches', color: '#6b7280', kind: 'range', segments: batchSegments },
      {
        id: 'effects',
        label: 'Effects',
        color: '#f59e0b',
        kind: 'range',
        segments: effectSegments,
      },
      {
        id: 'renders',
        label: 'Renders',
        color: '#3b82f6',
        kind: 'point',
        segments: renderSegments,
      },
      {
        id: 'updates',
        label: 'Updates',
        color: '#10b981',
        kind: 'point',
        segments: updateSegments,
      },
      {
        id: 'warnings',
        label: 'Warnings',
        color: '#ef4444',
        kind: 'point',
        segments: warningSegments,
      },
    ],
    summary,
  }
}

function renderRulerMarks(model: PerformanceTrackModel): string {
  const marks = 6
  const list: string[] = []
  for (let i = 0; i < marks; i++) {
    const ratio = i / (marks - 1)
    const position = ratio * 100
    const value = model.startTime + model.duration * ratio
    const offset = value - model.startTime
    list.push(
      `<span class="perf-ruler-mark" style="left:${position.toFixed(4)}%"><span class="perf-ruler-label">${formatDuration(offset)}</span></span>`,
    )
  }
  return list.join('')
}

function segmentTooltip(segment: PerformanceTrackSegment): string {
  const nodeLabel = segment.nodeName || (segment.nodeId ? `#${segment.nodeId}` : '')
  const durationLabel = formatDuration(segment.duration)
  const pieces = [segment.label, nodeLabel, durationLabel].filter(Boolean)
  return pieces.join(' • ')
}

function renderLane(
  model: PerformanceTrackModel,
  lane: PerformanceTrackLane,
  selectedEventId: number | null,
): string {
  if (lane.segments.length === 0) {
    return `
      <div class="perf-lane">
        <div class="perf-lane-label">${escapeHtml(lane.label)}</div>
        <div class="perf-lane-track empty"></div>
      </div>
    `
  }

  const segments = lane.segments
    .map(segment => {
      const startRatio = ((segment.startTime - model.startTime) / model.duration) * 100
      const widthRatio = (segment.duration / model.duration) * 100
      const width = Math.max(0.2, widthRatio)
      return `
        <button
          type="button"
          class="perf-segment ${selectedEventId === segment.eventId ? 'selected' : ''}"
          data-event-id="${segment.eventId}"
          data-node-id="${segment.nodeId ?? ''}"
          data-node-type="${segment.nodeType ?? ''}"
          title="${escapeHtml(segmentTooltip(segment))}"
          style="left:${startRatio.toFixed(4)}%; width:${width.toFixed(4)}%; background:${lane.color};"
        ></button>
      `
    })
    .join('')

  return `
    <div class="perf-lane">
      <div class="perf-lane-label">${escapeHtml(lane.label)}</div>
      <div class="perf-lane-track">${segments}</div>
    </div>
  `
}

export function renderPerformanceTracks(
  model: PerformanceTrackModel,
  selectedEventId: number | null,
): string {
  const summary = model.summary
  return `
    <div class="performance-summary">
      <div class="perf-summary-chip"><span>Total events</span><strong>${summary.totalEvents}</strong></div>
      <div class="perf-summary-chip"><span>Flushes</span><strong>${summary.flushCount}</strong></div>
      <div class="perf-summary-chip"><span>Total flush time</span><strong>${formatDuration(summary.totalFlushDuration)}</strong></div>
      <div class="perf-summary-chip"><span>Effects</span><strong>${summary.effectRuns}</strong></div>
      <div class="perf-summary-chip"><span>Total effect time</span><strong>${formatDuration(summary.totalEffectDuration)}</strong></div>
      <div class="perf-summary-chip"><span>Renders</span><strong>${summary.componentRenders}</strong></div>
    </div>
    <div class="performance-track-panel">
      <div class="perf-ruler">${renderRulerMarks(model)}</div>
      ${model.lanes.map(lane => renderLane(model, lane, selectedEventId)).join('')}
    </div>
  `
}

function laneThreadId(laneId: string): number {
  switch (laneId) {
    case 'commits':
      return TRACE_THREAD_COMMITS
    case 'batches':
      return TRACE_THREAD_BATCHES
    case 'effects':
      return TRACE_THREAD_EFFECTS
    case 'renders':
      return TRACE_THREAD_RENDERS
    case 'updates':
      return TRACE_THREAD_UPDATES
    case 'warnings':
      return TRACE_THREAD_WARNINGS
    default:
      return 19
  }
}

function eventThreadId(type: TimelineEventType): number {
  switch (type) {
    case TimelineEventType.SignalCreate:
    case TimelineEventType.SignalUpdate:
    case TimelineEventType.ComputedCreate:
    case TimelineEventType.ComputedUpdate:
      return TRACE_THREAD_UPDATES
    case TimelineEventType.EffectCreate:
    case TimelineEventType.EffectRun:
    case TimelineEventType.EffectCleanup:
    case TimelineEventType.EffectDispose:
      return TRACE_THREAD_EFFECTS
    case TimelineEventType.ComponentMount:
    case TimelineEventType.ComponentUnmount:
    case TimelineEventType.ComponentRender:
      return TRACE_THREAD_RENDERS
    case TimelineEventType.BatchStart:
    case TimelineEventType.BatchEnd:
      return TRACE_THREAD_BATCHES
    case TimelineEventType.FlushStart:
    case TimelineEventType.FlushEnd:
      return TRACE_THREAD_COMMITS
    case TimelineEventType.Warning:
    case TimelineEventType.Error:
      return TRACE_THREAD_WARNINGS
    default:
      return TRACE_THREAD_TIMELINE
  }
}

function toTraceTimestampMs(value: number): number {
  return Math.max(0, value)
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

interface TimelineGroupContext {
  batchGroupId?: number
  flushGroupId?: number
}

function resolveTimelineGroupContext(
  event: TimelineEvent,
  batchStartIds: Set<number>,
  flushStartIds: Set<number>,
): TimelineGroupContext {
  const data = event.data
  let batchGroupId = asFiniteNumber(data?.batchGroupId)
  let flushGroupId = asFiniteNumber(data?.flushGroupId)
  const fallbackGroupId = asFiniteNumber(event.groupId)

  if (batchGroupId === undefined && event.type === TimelineEventType.BatchStart) {
    batchGroupId = event.id
  }
  if (flushGroupId === undefined && event.type === TimelineEventType.FlushStart) {
    flushGroupId = event.id
  }
  if (
    batchGroupId === undefined &&
    fallbackGroupId !== undefined &&
    batchStartIds.has(fallbackGroupId)
  ) {
    batchGroupId = fallbackGroupId
  }
  if (
    flushGroupId === undefined &&
    fallbackGroupId !== undefined &&
    flushStartIds.has(fallbackGroupId)
  ) {
    flushGroupId = fallbackGroupId
  }

  return { batchGroupId, flushGroupId }
}

function buildTimelineTraceArgs(
  event: TimelineEvent,
  groups: TimelineGroupContext,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    eventId: event.id,
    eventType: event.type,
  }
  if (event.nodeId !== undefined) args.nodeId = event.nodeId
  if (event.nodeType !== undefined) args.nodeType = event.nodeType
  if (event.nodeName !== undefined) args.nodeName = event.nodeName
  if (event.groupId !== undefined) args.groupId = event.groupId
  if (event.duration !== undefined) args.duration = event.duration
  if (groups.batchGroupId !== undefined) args.batchGroupId = groups.batchGroupId
  if (groups.flushGroupId !== undefined) args.flushGroupId = groups.flushGroupId
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      args[key] = value
    }
  }
  return args
}

function pushFlowTraceEvents(
  traceEvents: TraceEvent[],
  kind: 'batch' | 'flush',
  source: TimelineEvent,
  target: TimelineEvent,
  targetThreadId: number,
): void {
  const startTs = Math.round(toTraceTimestampMs(source.timestamp) * 1000)
  const endTs = Math.round(toTraceTimestampMs(target.timestamp) * 1000)
  if (endTs < startTs) return

  const flowId =
    kind === 'batch'
      ? source.id * TRACE_FLOW_MULTIPLIER + target.id
      : TRACE_FLOW_FLUSH_OFFSET + source.id * TRACE_FLOW_MULTIPLIER + target.id
  const category = kind === 'batch' ? 'fict.flow.batch' : 'fict.flow.flush'
  const name = kind === 'batch' ? 'batch-flow' : 'flush-flow'

  traceEvents.push(
    {
      name,
      cat: category,
      ph: 's',
      id: flowId,
      ts: startTs,
      pid: TRACE_PROCESS_ID,
      tid: eventThreadId(source.type),
      args: {
        groupId: source.id,
        eventId: source.id,
        eventType: source.type,
      },
    },
    {
      name,
      cat: category,
      ph: 'f',
      id: flowId,
      ts: endTs,
      pid: TRACE_PROCESS_ID,
      tid: targetThreadId,
      args: {
        groupId: source.id,
        eventId: target.id,
        eventType: target.type,
      },
    },
  )
}

export function buildChromeTraceFromTimeline(timeline: TimelineEvent[]): ChromeTraceFile {
  const model = buildPerformanceTrackModel(timeline)
  const events = timeline
    .filter(
      event => event && typeof event.timestamp === 'number' && Number.isFinite(event.timestamp),
    )
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
  const batchStartById = new Map<number, TimelineEvent>()
  const flushStartById = new Map<number, TimelineEvent>()
  for (const event of events) {
    if (event.type === TimelineEventType.BatchStart) batchStartById.set(event.id, event)
    if (event.type === TimelineEventType.FlushStart) flushStartById.set(event.id, event)
  }

  const traceEvents: TraceEvent[] = []

  traceEvents.push(
    {
      name: 'process_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: 0,
      ts: 0,
      args: { name: 'Fict DevTools' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_COMMITS,
      ts: 0,
      args: { name: 'Commits' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_BATCHES,
      ts: 0,
      args: { name: 'Batches' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_EFFECTS,
      ts: 0,
      args: { name: 'Effects' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_RENDERS,
      ts: 0,
      args: { name: 'Renders' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_UPDATES,
      ts: 0,
      args: { name: 'Updates' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_WARNINGS,
      ts: 0,
      args: { name: 'Warnings' },
    },
    {
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      pid: TRACE_PROCESS_ID,
      tid: TRACE_THREAD_TIMELINE,
      ts: 0,
      args: { name: 'Timeline Events' },
    },
  )

  for (const lane of model.lanes) {
    const tid = laneThreadId(lane.id)
    for (const segment of lane.segments) {
      const ts = Math.round(toTraceTimestampMs(segment.startTime) * 1000)
      const dur = Math.max(1, Math.round(segment.duration * 1000))
      if (lane.kind === 'range') {
        traceEvents.push({
          name: segment.label,
          cat: `fict.${lane.id}`,
          ph: 'X',
          ts,
          dur,
          pid: TRACE_PROCESS_ID,
          tid,
          args: {
            eventId: segment.eventId,
            nodeId: segment.nodeId,
            nodeType: segment.nodeType,
            nodeName: segment.nodeName,
            eventType: segment.type,
          },
        })
      } else {
        traceEvents.push({
          name: segment.label,
          cat: `fict.${lane.id}`,
          ph: 'i',
          s: 't',
          ts,
          pid: TRACE_PROCESS_ID,
          tid,
          args: {
            eventId: segment.eventId,
            nodeId: segment.nodeId,
            nodeType: segment.nodeType,
            nodeName: segment.nodeName,
            eventType: segment.type,
          },
        })
      }
    }
  }

  const batchStartIds = new Set(batchStartById.keys())
  const flushStartIds = new Set(flushStartById.keys())
  for (const event of events) {
    const groups = resolveTimelineGroupContext(event, batchStartIds, flushStartIds)
    const tid = eventThreadId(event.type)
    const ts = Math.round(toTraceTimestampMs(event.timestamp) * 1000)

    traceEvents.push({
      name: event.type,
      cat: 'fict.timeline',
      ph: 'i',
      s: 't',
      ts,
      pid: TRACE_PROCESS_ID,
      tid,
      args: buildTimelineTraceArgs(event, groups),
    })

    if (groups.batchGroupId !== undefined) {
      const start = batchStartById.get(groups.batchGroupId)
      if (start && start.id !== event.id) {
        pushFlowTraceEvents(traceEvents, 'batch', start, event, tid)
      }
    }
    if (groups.flushGroupId !== undefined) {
      const start = flushStartById.get(groups.flushGroupId)
      if (start && start.id !== event.id) {
        pushFlowTraceEvents(traceEvents, 'flush', start, event, tid)
      }
    }
  }

  return {
    traceEvents,
    displayTimeUnit: 'ms',
    metadata: {
      source: 'fict-devtools-performance-tracks',
      generatedAt: new Date().toISOString(),
      eventCount: traceEvents.length,
      laneCount: model.lanes.length,
      timelineEventCount: events.length,
      flowEventCount: traceEvents.filter(event => event.cat.startsWith('fict.flow.')).length,
      timeRangeMs: {
        start: model.startTime,
        end: model.endTime,
        duration: model.duration,
      },
    },
  }
}

export function exportPerformanceTrace(
  timeline: TimelineEvent[],
  filename = 'fict-performance-trace.json',
): ChromeTraceFile {
  const trace = buildChromeTraceFromTimeline(timeline)

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return trace
  }

  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)

  return trace
}
