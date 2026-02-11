/**
 * Fict DevTools Debugger
 *
 * Core debugging module that hooks into Fict's reactive system
 * and provides inspection capabilities.
 */

import { formatValueShort } from './serializer'
import { highlightAndScroll, startInspecting, stopInspecting } from './highlighter'
import {
  type ComponentState,
  type ComputedState,
  type DependencyGraph,
  type DependencyGraphNode,
  type DevToolsSettings,
  type EffectState,
  type FictDevtoolsHookEnhanced,
  MessageSource,
  NodeType,
  type RootState,
  type SignalState,
  type SourceLocation,
  type TimelineEvent,
  TimelineEventType,
} from './types'

// ============================================================================
// State Storage
// ============================================================================

const signals = new Map<number, SignalState>()
const computeds = new Map<number, ComputedState>()
const effects = new Map<number, EffectState>()
const components = new Map<number, ComponentState>()
const roots = new Map<number, RootState>()
const timeline: TimelineEvent[] = []

// Dependency tracking
const dependencies = new Map<number, Set<number>>() // subscriber -> dependencies
const observers = new Map<number, Set<number>>() // dependency -> observers

// ID generation
let nextTimelineId = 1
let batchGroupId: number | null = null
let flushGroupId: number | null = null

// Settings
const settings: DevToolsSettings = {
  maxTimelineEvents: 1000,
  recordTimeline: true,
  highPerfMode: false,
  highlightUpdates: true,
  theme: 'system',
  collapsedSections: [],
}

// Connection state
let isConnected = false
const panelPort: MessagePort | null = null
let broadcastChannel: BroadcastChannel | null = null
const MAX_TRANSPORT_SANITIZE_DEPTH = 6
const PERF_MARK_PREFIX = 'fict.devtools'
const MAX_PERF_ENTRY_BUFFER = 4000
const perfRangeStacks = {
  batch: [] as number[],
  flush: [] as number[],
}
const perfMarkNames: string[] = []
const perfMeasureNames: string[] = []

// ============================================================================
// Console Exposure
// ============================================================================

const CONSOLE_HISTORY_SIZE = 10

// Store history of selected nodes for console access
const consoleHistory = {
  signals: [] as unknown[],
  effects: [] as unknown[],
  components: [] as unknown[],
}

type TraceMarkerKind = 'once' | 'reactive' | 'effect'

interface ComponentTraceMarker {
  kind: TraceMarkerKind
  label: string
}

interface ComponentTraceLine {
  line: number
  text: string
  markers: ComponentTraceMarker[]
}

interface ComponentTracePayload {
  componentId: number
  componentName: string
  file: string
  startLine: number
  endLine: number
  lines: ComponentTraceLine[]
  warnings?: string[]
}

const sourceFileCache = new Map<string, Promise<string | null>>()
const traceRegexEscapes = /[.*+?^${}()|[\]\\]/g

function parseSourceLocation(input?: string | SourceLocation): SourceLocation | undefined {
  if (!input) return undefined
  if (typeof input !== 'string') {
    const line = Number.isFinite(input.line) ? Math.max(1, Math.floor(input.line)) : 1
    const column = Number.isFinite(input.column) ? Math.max(1, Math.floor(input.column)) : 1
    const parsed: SourceLocation = {
      file: input.file,
      line,
      column,
    }
    if (input.endLine !== undefined && Number.isFinite(input.endLine)) {
      parsed.endLine = Math.max(parsed.line, Math.floor(input.endLine))
    }
    if (input.endColumn !== undefined && Number.isFinite(input.endColumn)) {
      parsed.endColumn = Math.max(1, Math.floor(input.endColumn))
    }
    return parsed
  }

  const trimmed = input.trim()
  if (!trimmed) return undefined

  const isDigits = (value: string): boolean => /^\d+$/.test(value)
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon > 0 && lastColon < trimmed.length - 1) {
    const maybeColumn = trimmed.slice(lastColon + 1)
    if (isDigits(maybeColumn)) {
      const beforeLast = trimmed.slice(0, lastColon)
      const secondColon = beforeLast.lastIndexOf(':')
      if (secondColon > 0 && secondColon < beforeLast.length - 1) {
        const maybeLine = beforeLast.slice(secondColon + 1)
        if (isDigits(maybeLine)) {
          const file = beforeLast.slice(0, secondColon)
          return {
            file: file || trimmed,
            line: Math.max(1, Number.parseInt(maybeLine, 10)),
            column: Math.max(1, Number.parseInt(maybeColumn, 10)),
          }
        }
      }
      return {
        file: beforeLast || trimmed,
        line: Math.max(1, Number.parseInt(maybeColumn, 10)),
        column: 1,
      }
    }
  }

  return { file: trimmed, line: 1, column: 1 }
}

function chooseDominantFile(locations: SourceLocation[]): string | null {
  const counts = new Map<string, number>()
  for (const location of locations) {
    counts.set(location.file, (counts.get(location.file) ?? 0) + 1)
  }

  let bestFile: string | null = null
  let bestCount = -1
  for (const [file, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count
      bestFile = file
    }
  }

  return bestFile
}

function collectComponentNodeLocations(component: ComponentState): SourceLocation[] {
  const locations: SourceLocation[] = []
  const pushSource = (source?: SourceLocation): void => {
    const parsed = parseSourceLocation(source)
    if (parsed?.file) locations.push(parsed)
  }

  for (const signalId of component.signals) {
    pushSource(signals.get(signalId)?.source)
  }
  for (const computedId of component.computeds) {
    pushSource(computeds.get(computedId)?.source)
  }
  for (const effectId of component.effects) {
    pushSource(effects.get(effectId)?.source)
  }

  return locations
}

function updateOwnerComponentSource(ownerId: number | undefined, source?: SourceLocation): void {
  if (ownerId === undefined || !source) return
  if (!source.file || source.line <= 0) return

  const component = components.get(ownerId)
  if (!component) return

  const existing = parseSourceLocation(component.source)
  if (!existing) {
    component.source = { ...source }
    return
  }

  if (existing.file !== source.file) return
  if (
    source.line < existing.line ||
    (source.line === existing.line && source.column < existing.column)
  ) {
    component.source = { ...source, endLine: existing.endLine, endColumn: existing.endColumn }
  }
}

function toFetchCandidates(file: string): string[] {
  const normalized = file.trim().replace(/\\/g, '/')
  if (!normalized) return []

  const candidates = new Set<string>()
  if (/^https?:\/\//.test(normalized)) {
    candidates.add(normalized)
    return Array.from(candidates)
  }

  if (normalized.startsWith('/')) {
    candidates.add(`/@fs${normalized}`)
    candidates.add(normalized)
    return Array.from(candidates)
  }

  candidates.add(`/@fs/${normalized}`)
  candidates.add(normalized.startsWith('./') ? normalized.slice(1) : `/${normalized}`)
  return Array.from(candidates)
}

function decodeBase64Payload(value: string): string | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')

  try {
    if (typeof atob === 'function') {
      const binary = atob(normalized)
      if (typeof TextDecoder === 'function') {
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index)
        }
        return new TextDecoder('utf-8').decode(bytes)
      }
      return binary
    }
  } catch {
    // Fall through to Buffer decoding.
  }

  try {
    const bufferCtor = (
      globalThis as typeof globalThis & {
        Buffer?: {
          from: (input: string, encoding: string) => { toString: (enc: string) => string }
        }
      }
    ).Buffer
    if (bufferCtor?.from) {
      return bufferCtor.from(normalized, 'base64').toString('utf-8')
    }
  } catch {
    // Ignore decode failures.
  }

  return null
}

function extractOriginalSourceFromInlineMap(transformedSource: string): string | null {
  const marker = 'sourceMappingURL=data:application/json;base64,'
  const markerIndex = transformedSource.lastIndexOf(marker)
  if (markerIndex < 0) return null

  const rawPayload = transformedSource.slice(markerIndex + marker.length).trim()
  if (!rawPayload) return null

  const base64Payload = rawPayload.split(/\s+/)[0]
  if (!base64Payload) return null

  const decoded = decodeBase64Payload(base64Payload)
  if (!decoded) return null

  try {
    const sourceMap = JSON.parse(decoded) as { sourcesContent?: (string | null)[] }
    const original = sourceMap.sourcesContent?.find(
      content => typeof content === 'string' && content.length > 0,
    )
    return typeof original === 'string' ? original : null
  } catch {
    return null
  }
}

async function fetchSourceFile(file: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null
  const cacheKey = file.trim()
  if (!cacheKey) return null

  let promise = sourceFileCache.get(cacheKey)
  if (!promise) {
    promise = (async () => {
      for (const url of toFetchCandidates(cacheKey)) {
        try {
          const response = await fetch(url, { credentials: 'same-origin' })
          if (!response.ok) continue
          const text = await response.text()
          if (!text || text.startsWith('<!DOCTYPE html>') || text.startsWith('<html')) continue
          const originalSource = extractOriginalSourceFromInlineMap(text)
          return originalSource ?? text
        } catch {
          // Try next candidate URL
        }
      }
      return null
    })()
    sourceFileCache.set(cacheKey, promise)
  }

  return promise
}

function getLineOffsets(source: string): number[] {
  const offsets = [0]
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) {
      offsets.push(index + 1)
    }
  }
  return offsets
}

function getLineFromOffset(offsets: number[], offset: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = offsets[mid] ?? Number.POSITIVE_INFINITY
    if (value <= offset) low = mid + 1
    else high = mid - 1
  }
  return Math.max(1, high + 1)
}

function findMatchingFunctionStartLine(
  sourceLines: string[],
  componentName: string,
  anchorLine: number,
): number {
  if (!componentName || componentName === 'Anonymous') {
    return Math.max(1, Math.min(sourceLines.length, anchorLine))
  }

  const escapedName = componentName.replace(traceRegexEscapes, '\\$&')
  const patterns = [
    new RegExp(`\\bexport\\s+default\\s+function\\s+${escapedName}\\b`),
    new RegExp(`\\bexport\\s+function\\s+${escapedName}\\b`),
    new RegExp(`\\bfunction\\s+${escapedName}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`),
    new RegExp(
      `\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`,
    ),
    new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*function\\b`),
  ]

  const candidateLines: number[] = []
  sourceLines.forEach((lineText, index) => {
    if (patterns.some(pattern => pattern.test(lineText))) {
      candidateLines.push(index + 1)
    }
  })

  if (candidateLines.length === 0) {
    return Math.max(1, Math.min(sourceLines.length, anchorLine))
  }

  candidateLines.sort((a, b) => Math.abs(a - anchorLine) - Math.abs(b - anchorLine))
  return candidateLines[0] ?? anchorLine
}

function findFunctionEndLine(source: string, startLine: number, lineOffsets: number[]): number {
  const lineStart = lineOffsets[Math.max(0, startLine - 1)] ?? 0
  let index = lineStart
  let line = startLine
  let depth = 0
  let started = false
  let paramDepth = 0
  let signatureClosed = false

  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  while (index < source.length) {
    const char = source[index]
    const nextChar = source[index + 1]

    if (char === '\n') {
      line++
      inLineComment = false
      escaped = false
      index++
      continue
    }

    if (inLineComment) {
      index++
      continue
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      index++
      continue
    }

    if (inSingle) {
      if (char === "'" && !escaped) inSingle = false
      escaped = char === '\\' && !escaped
      index++
      continue
    }

    if (inDouble) {
      if (char === '"' && !escaped) inDouble = false
      escaped = char === '\\' && !escaped
      index++
      continue
    }

    if (inTemplate) {
      if (char === '`' && !escaped) {
        inTemplate = false
        escaped = false
        index++
        continue
      }
      escaped = char === '\\' && !escaped
      index++
      continue
    }

    if (char === '/' && nextChar === '/') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && nextChar === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    if (char === "'") {
      inSingle = true
      escaped = false
      index++
      continue
    }
    if (char === '"') {
      inDouble = true
      escaped = false
      index++
      continue
    }
    if (char === '`') {
      inTemplate = true
      escaped = false
      index++
      continue
    }

    if (char === '{') {
      if (!started) {
        if (signatureClosed || paramDepth === 0) {
          started = true
          depth = 1
        }
        index++
        continue
      }
      depth++
      index++
      continue
    }

    if (char === '}') {
      if (started) {
        depth--
        if (depth <= 0) {
          return getLineFromOffset(lineOffsets, index)
        }
      }
      index++
      continue
    }

    if (char === '(') {
      paramDepth++
      index++
      continue
    }

    if (char === ')') {
      if (paramDepth > 0) {
        paramDepth--
        if (paramDepth === 0) {
          signatureClosed = true
        }
      }
      index++
      continue
    }

    if (char === '=' && nextChar === '>') {
      signatureClosed = true
      index += 2
      continue
    }

    index++
  }

  return Math.max(startLine, line)
}

function pushTraceMarker(
  markersByLine: Map<number, ComponentTraceMarker[]>,
  line: number,
  marker: ComponentTraceMarker,
): void {
  const lineMarkers = markersByLine.get(line)
  if (!lineMarkers) {
    markersByLine.set(line, [marker])
    return
  }

  if (
    lineMarkers.some(existing => existing.kind === marker.kind && existing.label === marker.label)
  ) {
    return
  }
  lineMarkers.push(marker)
}

function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name)
}

function lineContainsIdentifier(lineText: string, identifier: string): boolean {
  const pattern = new RegExp(`\\b${identifier.replace(traceRegexEscapes, '\\$&')}\\b`)
  return pattern.test(lineText)
}

function lineContainsAnyIdentifier(lineText: string, identifiers: Iterable<string>): boolean {
  for (const identifier of identifiers) {
    if (lineContainsIdentifier(lineText, identifier)) return true
  }
  return false
}

function inferReactiveLocalNames(
  startLine: number,
  endLine: number,
  sourceLines: string[],
  baseReactiveNames: Iterable<string>,
): Set<string> {
  const reactiveNames = new Set<string>(baseReactiveNames)
  const declarationLines: Array<{ name: string; expression: string }> = []
  const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)(?:;)?$/

  for (let line = startLine; line <= endLine; line++) {
    const lineText = (sourceLines[line - 1] ?? '').trim()
    if (!lineText) continue
    const withoutComment = lineText.replace(/\/\/.*$/, '').trim()
    if (!withoutComment) continue
    const declarationMatch = withoutComment.match(declarationPattern)
    if (!declarationMatch) continue
    const name = declarationMatch[1]
    const expression = declarationMatch[2]
    if (!name || !expression) continue
    declarationLines.push({ name, expression })
  }

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarationLines) {
      if (reactiveNames.has(declaration.name)) continue
      if (!lineContainsAnyIdentifier(declaration.expression, reactiveNames)) continue
      reactiveNames.add(declaration.name)
      changed = true
    }
  }

  return reactiveNames
}

function inferComponentTraceMarkers(
  component: ComponentState,
  file: string,
  startLine: number,
  endLine: number,
  sourceLines: string[],
): Map<number, ComponentTraceMarker[]> {
  const markersByLine = new Map<number, ComponentTraceMarker[]>()
  pushTraceMarker(markersByLine, startLine, {
    kind: 'once',
    label: 'Component setup runs on mount',
  })

  const signalNames = component.signals
    .map(id => signals.get(id)?.name)
    .filter((name): name is string => typeof name === 'string' && isIdentifierName(name))
  const computedNames = component.computeds
    .map(id => computeds.get(id)?.name)
    .filter((name): name is string => typeof name === 'string' && isIdentifierName(name))
  const reactiveNames = inferReactiveLocalNames(startLine, endLine, sourceLines, [
    ...signalNames,
    ...computedNames,
  ])

  for (const signalId of component.signals) {
    const source = parseSourceLocation(signals.get(signalId)?.source)
    if (!source || source.file !== file) continue
    if (source.line < startLine || source.line > endLine) continue
    pushTraceMarker(markersByLine, source.line, {
      kind: 'once',
      label: 'Signal initialization runs once',
    })
  }

  for (const computedId of component.computeds) {
    const source = parseSourceLocation(computeds.get(computedId)?.source)
    if (!source || source.file !== file) continue
    if (source.line < startLine || source.line > endLine) continue
    pushTraceMarker(markersByLine, source.line, {
      kind: 'reactive',
      label: 'Computed updates on dependency changes',
    })
  }

  for (const effectId of component.effects) {
    const source = parseSourceLocation(effects.get(effectId)?.source)
    if (source && source.file === file && source.line >= startLine && source.line <= endLine) {
      pushTraceMarker(markersByLine, source.line, {
        kind: 'effect',
        label: 'Effect reruns when dependencies change',
      })
    }
  }

  for (let line = startLine; line <= endLine; line++) {
    const lineText = sourceLines[line - 1] ?? ''
    if (!lineText) continue

    const hasReactiveName = lineContainsAnyIdentifier(lineText, reactiveNames)

    if (hasReactiveName && /\{[^}]*\b[A-Za-z_$][\w$]*\b[^}]*\}/.test(lineText)) {
      pushTraceMarker(markersByLine, line, {
        kind: 'reactive',
        label: 'JSX expression updates with reactive values',
      })
    }

    if (hasReactiveName && /\bconsole\.(?:log|debug|info|warn|error)\s*\(/.test(lineText)) {
      pushTraceMarker(markersByLine, line, {
        kind: 'reactive',
        label: 'Statement reruns when reactive values change',
      })
    }

    if (/\b(?:\$effect|effect)\s*\(/.test(lineText)) {
      pushTraceMarker(markersByLine, line, {
        kind: 'effect',
        label: 'Effect callback executes reactively',
      })
    }

    if (
      /\bconsole\.(?:log|debug|info|warn|error)\s*\(/.test(lineText) &&
      !hasReactiveName &&
      line !== startLine
    ) {
      pushTraceMarker(markersByLine, line, {
        kind: 'once',
        label: 'Statement runs only during setup',
      })
    }
  }

  return markersByLine
}

async function buildComponentTrace(componentId: number): Promise<ComponentTracePayload | null> {
  const component = components.get(componentId)
  if (!component) return null

  const nodeLocations = collectComponentNodeLocations(component)
  const componentSource = parseSourceLocation(component.source)
  const candidates = [...nodeLocations]
  if (componentSource) candidates.push(componentSource)
  if (candidates.length === 0) return null

  const dominantFile = chooseDominantFile(candidates)
  if (!dominantFile) return null
  const dominantLocations = candidates
    .filter(location => location.file === dominantFile)
    .sort((a, b) => a.line - b.line || a.column - b.column)
  if (dominantLocations.length === 0) return null

  const anchor = dominantLocations[0]?.line ?? 1
  const sourceText = await fetchSourceFile(dominantFile)
  if (!sourceText) {
    return {
      componentId,
      componentName: component.name,
      file: dominantFile,
      startLine: Math.max(1, anchor),
      endLine: Math.max(1, anchor),
      lines: [],
      warnings: ['Unable to load source file from current dev server context.'],
    }
  }

  const sourceLines = sourceText.split(/\r?\n/)
  const lineOffsets = getLineOffsets(sourceText)
  const startLine = findMatchingFunctionStartLine(sourceLines, component.name, anchor)
  const inferredEndLine = findFunctionEndLine(sourceText, startLine, lineOffsets)
  const boundedEndLine = Math.min(sourceLines.length, Math.max(startLine, inferredEndLine))
  const endLine = Math.min(boundedEndLine, startLine + 220)
  const markersByLine = inferComponentTraceMarkers(
    component,
    dominantFile,
    startLine,
    endLine,
    sourceLines,
  )

  const lines: ComponentTraceLine[] = []
  for (let line = startLine; line <= endLine; line++) {
    lines.push({
      line,
      text: sourceLines[line - 1] ?? '',
      markers: markersByLine.get(line) ?? [],
    })
  }

  const result: ComponentTracePayload = {
    componentId,
    componentName: component.name,
    file: dominantFile,
    startLine,
    endLine,
    lines,
  }

  if (endLine === startLine + 220) {
    result.warnings = ['Trace is truncated to keep the panel responsive.']
  }
  return result
}

/**
 * Expose a node to the browser console for interactive debugging.
 * Creates $signal0-$signal9, $effect0-$effect9, $component0-$component9 variables.
 */
export function exposeToConsole(
  type: 'signal' | 'computed' | 'effect' | 'component',
  id: number,
): void {
  if (typeof window === 'undefined') return

  const global = window as unknown as {
    __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
    [key: string]: unknown
  }

  let node: unknown
  let history: unknown[]
  let prefix: string

  switch (type) {
    case 'signal':
    case 'computed': {
      const signal = type === 'signal' ? signals.get(id) : computeds.get(id)
      if (!signal) return

      // Create an interactive object
      const setter = global.__FICT_DEVTOOLS_SIGNALS__?.get(id)
      const isComputed = type === 'computed'

      node = {
        id: signal.id,
        name: signal.name,
        type: isComputed ? 'computed' : 'signal',
        get value() {
          return signal.value
        },
        set value(v: unknown) {
          if (!isComputed && setter) setter(v)
          else console.warn('[Fict DevTools] Cannot set value on computed')
        },
        previousValue: signal.previousValue,
        updateCount: signal.updateCount,
        observers: signal.observers,
        // Convenience methods
        set: isComputed
          ? undefined
          : (v: unknown) => {
              setter?.(v)
            },
        log: () =>
          console.log(`${isComputed ? 'Computed' : 'Signal'} "${signal.name}":`, signal.value),
        inspect: () => {
          console.group(`${isComputed ? 'Computed' : 'Signal'} "${signal.name}" (#${signal.id})`)
          console.log('Value:', signal.value)
          console.log('Previous:', signal.previousValue)
          console.log('Updates:', signal.updateCount)
          console.log('Observers:', signal.observers)
          if ('dependencies' in signal) {
            console.log('Dependencies:', (signal as ComputedState).dependencies)
          }
          console.groupEnd()
        },
      }
      history = consoleHistory.signals
      prefix = '$signal'
      break
    }

    case 'effect': {
      const effect = effects.get(id)
      if (!effect) return

      node = {
        id: effect.id,
        name: effect.name,
        runCount: effect.runCount,
        lastRunAt: effect.lastRunAt,
        lastRunDuration: effect.lastRunDuration,
        dependencies: effect.dependencies,
        isActive: effect.isActive,
        hasCleanup: effect.hasCleanup,
        // Convenience methods
        getDeps: () =>
          effect.dependencies.map(depId => {
            const sig = signals.get(depId)
            const comp = computeds.get(depId)
            return sig || comp || { id: depId, name: 'unknown' }
          }),
        inspect: () => {
          console.group(`Effect "${effect.name}" (#${effect.id})`)
          console.log('Active:', effect.isActive)
          console.log('Run count:', effect.runCount)
          console.log(
            'Last run:',
            effect.lastRunAt ? new Date(effect.lastRunAt).toISOString() : 'never',
          )
          console.log(
            'Duration:',
            effect.lastRunDuration ? `${effect.lastRunDuration}ms` : 'unknown',
          )
          console.log('Dependencies:', effect.dependencies)
          console.log('Has cleanup:', effect.hasCleanup)
          console.groupEnd()
        },
      }
      history = consoleHistory.effects
      prefix = '$effect'
      break
    }

    case 'component': {
      const component = components.get(id)
      if (!component) return

      node = {
        id: component.id,
        name: component.name,
        isMounted: component.isMounted,
        renderCount: component.renderCount,
        props: component.props,
        signals: component.signals,
        effects: component.effects,
        children: component.children,
        parentId: component.parentId,
        get elements() {
          return component.elements
        },
        // Convenience methods
        highlight: () => {
          if (component.elements?.[0]) {
            component.elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
            // Temporary highlight
            const el = component.elements[0]
            const originalOutline = el.style.outline
            const originalTransition = el.style.transition
            el.style.transition = 'outline 0.3s'
            el.style.outline = '3px solid #42b883'
            setTimeout(() => {
              el.style.outline = originalOutline
              el.style.transition = originalTransition
            }, 2000)
          } else {
            console.warn('[Fict DevTools] Component has no mounted elements')
          }
        },
        getSignals: () => component.signals.map(sid => signals.get(sid)).filter(Boolean),
        getEffects: () => component.effects.map(eid => effects.get(eid)).filter(Boolean),
        getChildren: () => component.children.map(cid => components.get(cid)).filter(Boolean),
        getParent: () => (component.parentId ? components.get(component.parentId) : null),
        inspect: () => {
          console.group(`Component "${component.name}" (#${component.id})`)
          console.log('Mounted:', component.isMounted)
          console.log('Render count:', component.renderCount)
          console.log('Props:', component.props)
          console.log('Signals:', component.signals.length)
          console.log('Effects:', component.effects.length)
          console.log('Children:', component.children.length)
          console.log('Elements:', component.elements)
          console.groupEnd()
        },
      }
      history = consoleHistory.components
      prefix = '$component'
      break
    }
  }

  // Update history (keep most recent at $xxx0)
  history.unshift(node)
  if (history.length > CONSOLE_HISTORY_SIZE) {
    history.pop()
  }

  // Expose to window
  history.forEach((item, index) => {
    global[`${prefix}${index}`] = item
  })

  // Print hint
  console.log(
    `%c[Fict DevTools]%c ${prefix}0 =`,
    'color: #42b883; font-weight: bold',
    'color: inherit',
    node,
  )
  console.log(
    `%c  Tip:%c Try ${prefix}0.inspect() or ${prefix}0.log()`,
    'color: #6b7280; font-style: italic',
    'color: #6b7280',
  )
}

// ============================================================================
// Timeline Recording
// ============================================================================

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getPerformanceApi(): Performance | undefined {
  if (typeof performance === 'undefined') return undefined
  if (typeof performance.mark !== 'function' || typeof performance.measure !== 'function') {
    return undefined
  }
  return performance
}

function trimPerformanceEntries(perf: Performance): void {
  while (perfMarkNames.length + perfMeasureNames.length > MAX_PERF_ENTRY_BUFFER) {
    if (perfMarkNames.length >= perfMeasureNames.length && perfMarkNames.length > 0) {
      const removed = perfMarkNames.shift()
      if (removed && typeof perf.clearMarks === 'function') {
        try {
          perf.clearMarks(removed)
        } catch {
          // Ignore cleanup failures
        }
      }
      continue
    }

    const removed = perfMeasureNames.shift()
    if (removed && typeof perf.clearMeasures === 'function') {
      try {
        perf.clearMeasures(removed)
      } catch {
        // Ignore cleanup failures
      }
    }
  }
}

function markPerformance(name: string, options?: PerformanceMarkOptions): boolean {
  const perf = getPerformanceApi()
  if (!perf) return false

  try {
    if (options !== undefined) {
      perf.mark(name, options)
    } else {
      perf.mark(name)
    }
    perfMarkNames.push(name)
    trimPerformanceEntries(perf)
    return true
  } catch {
    if (options !== undefined) {
      try {
        perf.mark(name)
        perfMarkNames.push(name)
        trimPerformanceEntries(perf)
        return true
      } catch {
        // Ignore mark failures
      }
    }
    return false
  }
}

function measurePerformance(
  name: string,
  startOrOptions?: string | PerformanceMeasureOptions,
  endMark?: string,
): boolean {
  const perf = getPerformanceApi()
  if (!perf) return false

  try {
    if (typeof startOrOptions === 'undefined') {
      perf.measure(name)
    } else if (typeof startOrOptions === 'string') {
      if (endMark !== undefined) {
        perf.measure(name, startOrOptions, endMark)
      } else {
        perf.measure(name, startOrOptions)
      }
    } else {
      perf.measure(name, startOrOptions)
    }
    perfMeasureNames.push(name)
    trimPerformanceEntries(perf)
    return true
  } catch {
    return false
  }
}

function clearPerformanceTimelineInstrumentation(): void {
  perfRangeStacks.batch.length = 0
  perfRangeStacks.flush.length = 0

  const perf = getPerformanceApi()
  if (!perf) {
    perfMarkNames.length = 0
    perfMeasureNames.length = 0
    return
  }

  for (const name of perfMarkNames) {
    if (typeof perf.clearMarks !== 'function') break
    try {
      perf.clearMarks(name)
    } catch {
      // Ignore cleanup failures
    }
  }
  for (const name of perfMeasureNames) {
    if (typeof perf.clearMeasures !== 'function') break
    try {
      perf.clearMeasures(name)
    } catch {
      // Ignore cleanup failures
    }
  }

  perfMarkNames.length = 0
  perfMeasureNames.length = 0
}

function buildTimelineEventData(
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const nextData = data ? { ...data } : {}
  const batchId = batchGroupId ?? undefined
  const flushId = flushGroupId ?? undefined
  if (batchId !== undefined) nextData.batchGroupId = batchId
  if (flushId !== undefined) nextData.flushGroupId = flushId
  return Object.keys(nextData).length > 0 ? nextData : undefined
}

function emitPerformanceTimelineEntries(event: TimelineEvent): void {
  if (!getPerformanceApi()) return

  const details: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
  }
  if (event.nodeId !== undefined) details.nodeId = event.nodeId
  if (event.nodeType !== undefined) details.nodeType = event.nodeType
  if (event.nodeName !== undefined) details.nodeName = event.nodeName
  if (event.groupId !== undefined) details.groupId = event.groupId
  if (event.duration !== undefined) details.duration = event.duration
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      details[key] = value
    }
  }

  markPerformance(`${PERF_MARK_PREFIX}.event.${event.type}.${event.id}`, { detail: details })

  switch (event.type) {
    case TimelineEventType.BatchStart: {
      perfRangeStacks.batch.push(event.id)
      markPerformance(`${PERF_MARK_PREFIX}.batch.${event.id}.start`)
      break
    }

    case TimelineEventType.BatchEnd: {
      const batchId =
        perfRangeStacks.batch.pop() ??
        asFiniteNumber(event.data?.batchGroupId) ??
        asFiniteNumber(event.groupId)
      if (batchId !== undefined) {
        const startMark = `${PERF_MARK_PREFIX}.batch.${batchId}.start`
        const endMark = `${PERF_MARK_PREFIX}.batch.${batchId}.end.${event.id}`
        markPerformance(endMark)
        measurePerformance(`${PERF_MARK_PREFIX}.batch.${batchId}`, startMark, endMark)
      }
      break
    }

    case TimelineEventType.FlushStart: {
      perfRangeStacks.flush.push(event.id)
      markPerformance(`${PERF_MARK_PREFIX}.flush.${event.id}.start`)
      break
    }

    case TimelineEventType.FlushEnd: {
      const flushId =
        perfRangeStacks.flush.pop() ??
        asFiniteNumber(event.data?.flushGroupId) ??
        asFiniteNumber(event.groupId)
      if (flushId !== undefined) {
        const startMark = `${PERF_MARK_PREFIX}.flush.${flushId}.start`
        const endMark = `${PERF_MARK_PREFIX}.flush.${flushId}.end.${event.id}`
        markPerformance(endMark)
        measurePerformance(`${PERF_MARK_PREFIX}.flush.${flushId}`, startMark, endMark)
      }
      break
    }

    case TimelineEventType.EffectRun: {
      const rawDuration = asFiniteNumber(event.duration)
      if (rawDuration === undefined) break
      const duration = Math.max(0, rawDuration)
      const startTime = Math.max(0, event.timestamp - duration)
      const measureName = `${PERF_MARK_PREFIX}.effect.${event.id}`
      const measured = measurePerformance(measureName, {
        start: startTime,
        end: event.timestamp,
        detail: details,
      })
      if (!measured) {
        const startMark = `${PERF_MARK_PREFIX}.effect.${event.id}.start`
        const endMark = `${PERF_MARK_PREFIX}.effect.${event.id}.end`
        markPerformance(startMark, { startTime })
        markPerformance(endMark)
        measurePerformance(measureName, startMark, endMark)
      }
      break
    }

    default:
      break
  }
}

function recordEvent(
  type: TimelineEventType,
  nodeId?: number,
  nodeType?: NodeType,
  nodeName?: string,
  data?: Record<string, unknown>,
  duration?: number,
): void {
  if (!settings.recordTimeline || settings.highPerfMode) return

  const eventData = buildTimelineEventData(data)
  const event: TimelineEvent = {
    id: nextTimelineId++,
    type,
    timestamp: performance.now(),
    nodeId,
    nodeType,
    nodeName,
    data: eventData,
    duration,
    groupId: batchGroupId ?? flushGroupId ?? undefined,
  }

  timeline.push(event)

  // Trim timeline if needed
  if (timeline.length > settings.maxTimelineEvents) {
    timeline.splice(0, timeline.length - settings.maxTimelineEvents)
  }

  emitPerformanceTimelineEntries(event)

  // Send to panel
  sendToPanel('timeline:event', event)
}

// ============================================================================
// Communication
// ============================================================================

function sendToPanel(type: string, payload: unknown): void {
  if (!isConnected) return

  const message = { source: MessageSource.Hook, type, payload, timestamp: Date.now() }
  let transportSafeMessage: typeof message | null = null

  const getTransportSafeMessage = (): typeof message => {
    if (transportSafeMessage) return transportSafeMessage
    transportSafeMessage = {
      ...message,
      payload: sanitizeForTransport(message.payload, 0, new WeakMap<object, unknown>()),
    }
    return transportSafeMessage
  }

  const postWithFallback = (post: (msg: typeof message) => void): void => {
    try {
      post(message)
      return
    } catch {
      // Fall back to a transport-safe payload when structured clone fails
    }

    try {
      post(getTransportSafeMessage())
    } catch {
      // Ignore postMessage errors
    }
  }

  if (panelPort) {
    postWithFallback(msg => panelPort.postMessage(msg))
  } else if (typeof window !== 'undefined') {
    // Send via window.postMessage for same-window communication
    postWithFallback(msg => window.postMessage(msg, '*'))
  }

  // Also send via BroadcastChannel for cross-tab communication (standalone mode)
  if (broadcastChannel) {
    postWithFallback(msg => broadcastChannel!.postMessage(msg))
  }
}

function sanitizeForTransport(
  value: unknown,
  depth: number,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value

  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
    return value
  }
  if (kind === 'symbol') return String(value)
  if (kind === 'function') {
    const fn = value as (...args: unknown[]) => unknown
    return `[Function ${fn.name || 'anonymous'}]`
  }

  if (depth >= MAX_TRANSPORT_SANITIZE_DEPTH) {
    return formatValueShort(value)
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof Element !== 'undefined' && value instanceof Element) {
    return {
      __fictType: 'Element',
      tagName: value.tagName,
      id: value.id || undefined,
      className: value.className || undefined,
    }
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return {
      __fictType: 'Node',
      nodeName: value.nodeName,
    }
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForTransport(item, depth + 1, seen))
  }

  if (value instanceof Map) {
    const output = new Map<unknown, unknown>()
    seen.set(value, output)
    for (const [key, item] of value.entries()) {
      output.set(
        sanitizeForTransport(key, depth + 1, seen),
        sanitizeForTransport(item, depth + 1, seen),
      )
    }
    return output
  }

  if (value instanceof Set) {
    const output = new Set<unknown>()
    seen.set(value, output)
    for (const item of value.values()) {
      output.add(sanitizeForTransport(item, depth + 1, seen))
    }
    return output
  }

  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return {
        __fictType: 'DataView',
        byteLength: value.byteLength,
      }
    }
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return {
      __fictType: value.constructor.name,
      values: Array.from(bytes),
    }
  }

  if (value instanceof ArrayBuffer) {
    return {
      __fictType: 'ArrayBuffer',
      byteLength: value.byteLength,
    }
  }

  if (kind === 'object') {
    const objectValue = value as Record<string, unknown>
    const existing = seen.get(objectValue)
    if (existing !== undefined) {
      return existing
    }

    const output: Record<string, unknown> = {}
    seen.set(objectValue, output)
    for (const [key, nestedValue] of Object.entries(objectValue)) {
      output[key] = sanitizeForTransport(nestedValue, depth + 1, seen)
    }
    return output
  }

  return formatValueShort(value)
}

function handlePanelMessage(event: MessageEvent): void {
  if (event.data?.source !== MessageSource.Panel) return

  const { type, payload } = event.data

  switch (type) {
    case 'connect':
      isConnected = true
      sendInitialState()
      break

    case 'disconnect':
      isConnected = false
      break

    case 'request:signals':
      sendToPanel('response:signals', Array.from(signals.values()))
      break

    case 'request:computeds':
      sendToPanel('response:computeds', Array.from(computeds.values()))
      break

    case 'request:effects':
      sendToPanel('response:effects', Array.from(effects.values()))
      break

    case 'request:components':
      sendToPanel('response:components', Array.from(components.values()))
      break

    case 'request:roots':
      sendToPanel('response:roots', Array.from(roots.values()))
      break

    case 'request:timeline':
      sendToPanel('response:timeline', timeline.slice(-(payload?.limit || 100)))
      break

    case 'request:settings':
      sendToPanel('response:settings', settings)
      break

    case 'request:dependencyGraph':
      sendToPanel(
        'response:dependencyGraph',
        serializeDependencyGraphForTransport(buildDependencyGraph(payload?.nodeId)),
      )
      break

    case 'request:componentTrace': {
      const componentId =
        payload && typeof payload === 'object'
          ? (payload as { componentId?: number }).componentId
          : undefined
      if (typeof componentId !== 'number' || !Number.isFinite(componentId)) {
        sendToPanel('response:componentTrace', {
          componentId: componentId ?? null,
          trace: null,
          error: 'Invalid component id',
        })
        break
      }

      void buildComponentTrace(componentId)
        .then(trace => {
          sendToPanel('response:componentTrace', { componentId, trace })
        })
        .catch(error => {
          sendToPanel('response:componentTrace', {
            componentId,
            trace: null,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      break
    }

    case 'set:signalValue':
      if (payload?.id !== undefined) {
        hook.setSignalValue(payload.id as number, payload.value)
      }
      break

    case 'set:settings':
      if (payload && typeof payload === 'object') {
        const prevRecordTimeline = settings.recordTimeline
        const prevHighPerfMode = settings.highPerfMode
        Object.assign(settings, payload)
        if (
          (prevRecordTimeline !== settings.recordTimeline ||
            prevHighPerfMode !== settings.highPerfMode) &&
          (!settings.recordTimeline || settings.highPerfMode)
        ) {
          clearPerformanceTimelineInstrumentation()
        }
      }
      break

    case 'clear:timeline':
      timeline.length = 0
      nextTimelineId = 1
      clearPerformanceTimelineInstrumentation()
      break

    case 'inspect:start':
      startInspecting(
        element => {
          const componentId = findComponentIdForElement(element)
          if (componentId === null) {
            sendToPanel('inspect:selected', { componentId: null })
            return
          }

          const component = components.get(componentId)
          const inspectTarget = component?.elements?.[0]
          if (inspectTarget) {
            highlightAndScroll(inspectTarget, {
              label: component?.name || 'Component',
              duration: 1200,
            })
          }
          sendToPanel('inspect:selected', { componentId })
        },
        () => {
          sendToPanel('inspect:stopped', {})
        },
      )
      break

    case 'inspect:stop':
      stopInspecting()
      break

    case 'inspect:highlight': {
      const componentId =
        payload && typeof payload === 'object' ? (payload as { id?: number }).id : undefined
      if (typeof componentId === 'number') {
        const component = components.get(componentId)
        const element = component?.elements?.[0]
        if (element) {
          highlightAndScroll(element, {
            label: component?.name || `Component #${componentId}`,
            duration: 1200,
          })
        }
      }
      break
    }

    case 'expose:console':
      if (payload?.type && payload?.id !== undefined) {
        exposeToConsole(
          payload.type as 'signal' | 'computed' | 'effect' | 'component',
          payload.id as number,
        )
      }
      break
  }
}

function findComponentIdForElement(element: HTMLElement): number | null {
  let current: HTMLElement | null = element
  while (current) {
    const propertyId = (current as HTMLElement & { __fict_component_id__?: unknown })
      .__fict_component_id__
    if (typeof propertyId === 'number' && Number.isFinite(propertyId)) {
      return propertyId
    }

    const attrId = current.getAttribute('data-fict-component-id')
    if (attrId !== null) {
      const parsed = Number.parseInt(attrId, 10)
      if (Number.isFinite(parsed)) return parsed
    }
    current = current.parentElement
  }
  return null
}

function sendInitialState(): void {
  sendToPanel('state:init', {
    signals: Array.from(signals.values()),
    computeds: Array.from(computeds.values()),
    effects: Array.from(effects.values()),
    components: Array.from(components.values()),
    roots: Array.from(roots.values()),
    timeline: timeline.slice(-100),
    settings,
  })
}

// ============================================================================
// Dependency Graph Builder
// ============================================================================

function buildDependencyGraph(nodeId: number): DependencyGraph | null {
  if (!signals.has(nodeId) && !computeds.has(nodeId) && !effects.has(nodeId)) {
    return null
  }

  const nodes = new Map<number, DependencyGraphNode>()
  const edges: [number, number][] = []
  const visited = new Set<number>()

  // Get node info
  function getNodeInfo(
    id: number,
  ): { type: NodeType; name: string; value?: unknown; isDirty?: boolean } | null {
    if (signals.has(id)) {
      const s = signals.get(id)!
      return { type: NodeType.Signal, name: s.name || `Signal #${id}`, value: s.value }
    }
    if (computeds.has(id)) {
      const c = computeds.get(id)!
      return {
        type: NodeType.Computed,
        name: c.name || `Computed #${id}`,
        value: c.value,
        isDirty: c.isDirty,
      }
    }
    if (effects.has(id)) {
      const e = effects.get(id)!
      return { type: NodeType.Effect, name: e.name || `Effect #${id}` }
    }
    return null
  }

  // BFS to collect nodes and edges
  function traverse(startId: number, direction: 'sources' | 'observers', depth = 0): void {
    if (visited.has(startId) || depth > 10) return
    visited.add(startId)

    const info = getNodeInfo(startId)
    if (!info) return

    const nodeDeps = dependencies.get(startId)
    const nodeObs = observers.get(startId)

    const graphNode: DependencyGraphNode = {
      id: startId,
      type: info.type,
      name: info.name,
      depth,
      sources: nodeDeps ? Array.from(nodeDeps) : [],
      observers: nodeObs ? Array.from(nodeObs) : [],
      value: info.value,
      isDirty: info.isDirty,
    }

    nodes.set(startId, graphNode)

    if (direction === 'sources' && nodeDeps) {
      for (const depId of nodeDeps) {
        edges.push([depId, startId])
        traverse(depId, 'sources', depth + 1)
      }
    } else if (direction === 'observers' && nodeObs) {
      for (const obsId of nodeObs) {
        edges.push([startId, obsId])
        traverse(obsId, 'observers', depth + 1)
      }
    }
  }

  // Traverse both directions from the root node
  traverse(nodeId, 'sources', 0)
  visited.delete(nodeId) // Reset to traverse observers
  traverse(nodeId, 'observers', 0)

  return { rootId: nodeId, nodes, edges }
}

function serializeDependencyGraphForTransport(graph: DependencyGraph | null): unknown {
  if (!graph) return null
  return {
    ...graph,
    // Chrome extension runtime messaging is JSON-based and drops Map payloads.
    nodes: Array.from(graph.nodes.entries()),
  }
}

// ============================================================================
// Hook Implementation
// ============================================================================

const hook: FictDevtoolsHookEnhanced = {
  // Signal lifecycle
  registerSignal(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ): void {
    const parsedSource = parseSourceLocation(options?.source)
    const state: SignalState = {
      id,
      type: NodeType.Signal,
      name: options?.name,
      value,
      updateCount: 0,
      createdAt: Date.now(),
      observers: [],
      source: parsedSource,
      ownerId: options?.ownerId,
    }
    signals.set(id, state)
    observers.set(id, new Set())

    // Link signal to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.signals.includes(id)) {
        ownerComponent.signals.push(id)
      }
      updateOwnerComponentSource(options.ownerId, parsedSource)
    }

    recordEvent(
      TimelineEventType.SignalCreate,
      id,
      NodeType.Signal,
      options?.name || `Signal #${id}`,
      {
        value: formatValueShort(value),
      },
    )

    sendToPanel('signal:register', state)
  },

  updateSignal(id: number, value: unknown, previousValue?: unknown): void {
    const state = signals.get(id)
    if (!state) return

    state.previousValue = previousValue ?? state.value
    state.value = value
    state.updateCount++
    state.lastUpdatedAt = Date.now()

    recordEvent(
      TimelineEventType.SignalUpdate,
      id,
      NodeType.Signal,
      state.name || `Signal #${id}`,
      {
        previousValue: formatValueShort(state.previousValue),
        newValue: formatValueShort(value),
      },
    )

    sendToPanel('signal:update', {
      id,
      value,
      previousValue: state.previousValue,
      updateCount: state.updateCount,
    })
  },

  disposeSignal(id: number): void {
    signals.delete(id)
    dependencies.delete(id)
    observers.delete(id)
    sendToPanel('signal:dispose', { id })
  },

  // Computed lifecycle
  registerComputed(
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number; internal?: boolean },
  ): void {
    if (options?.internal === true) return
    const parsedSource = parseSourceLocation(options?.source)
    const state: ComputedState = {
      id,
      type: NodeType.Computed,
      name: options?.name,
      value,
      updateCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      observers: [],
      isDirty: true,
      source: parsedSource,
      ownerId: options?.ownerId,
    }
    computeds.set(id, state)
    dependencies.set(id, new Set())
    observers.set(id, new Set())

    // Link computed to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.computeds.includes(id)) {
        ownerComponent.computeds.push(id)
      }
      updateOwnerComponentSource(options.ownerId, parsedSource)
    }

    recordEvent(
      TimelineEventType.ComputedCreate,
      id,
      NodeType.Computed,
      options?.name || `Computed #${id}`,
    )

    sendToPanel('computed:register', state)
  },

  updateComputed(id: number, value: unknown, previousValue?: unknown): void {
    const state = computeds.get(id)
    if (!state) return

    state.previousValue = previousValue ?? state.value
    state.value = value
    state.updateCount++
    state.lastUpdatedAt = Date.now()
    state.isDirty = false

    recordEvent(
      TimelineEventType.ComputedUpdate,
      id,
      NodeType.Computed,
      state.name || `Computed #${id}`,
      {
        previousValue: formatValueShort(state.previousValue),
        newValue: formatValueShort(value),
      },
    )

    sendToPanel('computed:update', {
      id,
      value,
      previousValue: state.previousValue,
      updateCount: state.updateCount,
    })
  },

  disposeComputed(id: number): void {
    computeds.delete(id)
    dependencies.delete(id)
    observers.delete(id)
    sendToPanel('computed:dispose', { id })
  },

  // Effect lifecycle
  registerEffect(id: number, options?: { ownerId?: number; source?: string }): void {
    const parsedSource = parseSourceLocation(options?.source)
    const state: EffectState = {
      id,
      type: NodeType.Effect,
      runCount: 0,
      createdAt: Date.now(),
      dependencies: [],
      isActive: true,
      hasCleanup: false,
      source: parsedSource,
      ownerId: options?.ownerId,
    }
    effects.set(id, state)
    dependencies.set(id, new Set())

    // Link effect to owner component
    if (options?.ownerId !== undefined) {
      const ownerComponent = components.get(options.ownerId)
      if (ownerComponent && !ownerComponent.effects.includes(id)) {
        ownerComponent.effects.push(id)
      }
      updateOwnerComponentSource(options.ownerId, parsedSource)
    }

    recordEvent(TimelineEventType.EffectCreate, id, NodeType.Effect, `Effect #${id}`)

    sendToPanel('effect:register', state)
  },

  effectRun(id: number, duration?: number): void {
    const state = effects.get(id)
    if (!state) return

    state.runCount++
    state.lastRunAt = Date.now()
    state.lastRunDuration = duration

    // Update dependencies
    const deps = dependencies.get(id)
    state.dependencies = deps ? Array.from(deps) : []

    recordEvent(
      TimelineEventType.EffectRun,
      id,
      NodeType.Effect,
      state.name || `Effect #${id}`,
      { runCount: state.runCount },
      duration,
    )

    sendToPanel('effect:run', {
      id,
      runCount: state.runCount,
      duration,
      dependencies: state.dependencies,
    })
  },

  effectCleanup(id: number): void {
    const state = effects.get(id)
    if (!state) return

    recordEvent(TimelineEventType.EffectCleanup, id, NodeType.Effect, state.name || `Effect #${id}`)

    sendToPanel('effect:cleanup', { id })
  },

  disposeEffect(id: number): void {
    const state = effects.get(id)
    if (state) {
      state.isActive = false
      recordEvent(
        TimelineEventType.EffectDispose,
        id,
        NodeType.Effect,
        state.name || `Effect #${id}`,
      )
    }

    effects.delete(id)
    dependencies.delete(id)
    sendToPanel('effect:dispose', { id })
  },

  // Component lifecycle
  registerComponent(id: number, name: string, parentId?: number, source?: SourceLocation): void {
    const parsedSource = parseSourceLocation(source)
    const state: ComponentState = {
      id,
      type: NodeType.Component,
      name,
      parentId,
      children: [],
      signals: [],
      computeds: [],
      effects: [],
      source: parsedSource,
      isMounted: false,
      renderCount: 0,
      createdAt: Date.now(),
    }
    components.set(id, state)

    // Update parent's children
    if (parentId !== undefined) {
      const parent = components.get(parentId)
      if (parent) {
        parent.children.push(id)
      }
    }

    sendToPanel('component:register', state)
  },

  componentMount(id: number, elements?: HTMLElement[]): void {
    const state = components.get(id)
    if (!state) return

    state.isMounted = true
    state.elements = elements

    recordEvent(TimelineEventType.ComponentMount, id, NodeType.Component, state.name)

    sendToPanel('component:mount', { id, elements: elements?.length })
  },

  componentUnmount(id: number): void {
    const state = components.get(id)
    if (!state) return

    state.isMounted = false
    state.elements = undefined

    recordEvent(TimelineEventType.ComponentUnmount, id, NodeType.Component, state.name)

    sendToPanel('component:unmount', { id })
  },

  componentRender(id: number): void {
    const state = components.get(id)
    if (!state) return

    state.renderCount++

    recordEvent(TimelineEventType.ComponentRender, id, NodeType.Component, state.name, {
      renderCount: state.renderCount,
    })

    sendToPanel('component:render', { id, renderCount: state.renderCount })
  },

  // Root lifecycle
  registerRoot(id: number, name?: string): void {
    const state: RootState = {
      id,
      type: NodeType.Root,
      name,
      children: [],
      isSuspended: false,
      hasErrorBoundary: false,
      createdAt: Date.now(),
    }
    roots.set(id, state)

    sendToPanel('root:register', state)
  },

  disposeRoot(id: number): void {
    roots.delete(id)
    sendToPanel('root:dispose', { id })
  },

  rootSuspend(id: number, suspended: boolean): void {
    const state = roots.get(id)
    if (!state) return

    state.isSuspended = suspended
    sendToPanel('root:suspend', { id, suspended })
  },

  // Dependency tracking
  trackDependency(subscriberId: number, dependencyId: number): void {
    // Add to subscriber's dependencies
    let subDeps = dependencies.get(subscriberId)
    if (!subDeps) {
      subDeps = new Set()
      dependencies.set(subscriberId, subDeps)
    }
    const isNewDep = !subDeps.has(dependencyId)
    subDeps.add(dependencyId)

    // Add to dependency's observers
    let depObs = observers.get(dependencyId)
    if (!depObs) {
      depObs = new Set()
      observers.set(dependencyId, depObs)
    }
    depObs.add(subscriberId)

    // Update state objects and notify panel
    const signal = signals.get(dependencyId)
    if (signal && !signal.observers.includes(subscriberId)) {
      signal.observers.push(subscriberId)
      // Notify panel of observer change
      if (isNewDep) {
        sendToPanel('signal:observers', { id: dependencyId, observers: signal.observers })
      }
    }

    const computed = computeds.get(dependencyId)
    if (computed && !computed.observers.includes(subscriberId)) {
      computed.observers.push(subscriberId)
      if (isNewDep) {
        sendToPanel('computed:observers', { id: dependencyId, observers: computed.observers })
      }
    }

    const subComputed = computeds.get(subscriberId)
    if (subComputed && !subComputed.dependencies.includes(dependencyId)) {
      subComputed.dependencies.push(dependencyId)
      if (isNewDep) {
        sendToPanel('computed:dependencies', {
          id: subscriberId,
          dependencies: subComputed.dependencies,
        })
      }
    }

    const effect = effects.get(subscriberId)
    if (effect && !effect.dependencies.includes(dependencyId)) {
      effect.dependencies.push(dependencyId)
      if (isNewDep) {
        sendToPanel('effect:dependencies', { id: subscriberId, dependencies: effect.dependencies })
      }
    }
  },

  untrackDependency(subscriberId: number, dependencyId: number): void {
    const subDeps = dependencies.get(subscriberId)
    if (subDeps) {
      subDeps.delete(dependencyId)
    }

    const depObs = observers.get(dependencyId)
    if (depObs) {
      depObs.delete(subscriberId)
    }

    // Update state objects
    const signal = signals.get(dependencyId)
    if (signal) {
      const idx = signal.observers.indexOf(subscriberId)
      if (idx !== -1) signal.observers.splice(idx, 1)
    }

    const computed = computeds.get(dependencyId)
    if (computed) {
      const idx = computed.observers.indexOf(subscriberId)
      if (idx !== -1) computed.observers.splice(idx, 1)
    }
  },

  // Batch/flush events
  batchStart(): void {
    batchGroupId = nextTimelineId
    recordEvent(TimelineEventType.BatchStart)
  },

  batchEnd(): void {
    recordEvent(TimelineEventType.BatchEnd)
    batchGroupId = null
  },

  flushStart(): void {
    flushGroupId = nextTimelineId
    recordEvent(TimelineEventType.FlushStart)
  },

  flushEnd(): void {
    recordEvent(TimelineEventType.FlushEnd)
    flushGroupId = null
  },

  // Error/warning
  cycleDetected(payload: { reason: string; detail?: Record<string, unknown> }): void {
    recordEvent(TimelineEventType.Warning, undefined, undefined, 'Cycle detected', payload)
    sendToPanel('warning:cycle', payload)
    console.warn('[Fict DevTools] Cycle detected:', payload)
  },

  error(error: unknown, componentId?: number): void {
    const message = error instanceof Error ? error.message : String(error)
    recordEvent(TimelineEventType.Error, componentId, NodeType.Component, message, {
      stack: error instanceof Error ? error.stack : undefined,
    })
    sendToPanel('error', { message, componentId })
  },

  warning(message: string, componentId?: number): void {
    recordEvent(TimelineEventType.Warning, componentId, NodeType.Component, message)
    sendToPanel('warning', { message, componentId })
  },

  // Inspection API
  getSignals(): SignalState[] {
    return Array.from(signals.values())
  },

  getComputeds(): ComputedState[] {
    return Array.from(computeds.values())
  },

  getEffects(): EffectState[] {
    return Array.from(effects.values())
  },

  getComponents(): ComponentState[] {
    return Array.from(components.values())
  },

  getRoots(): RootState[] {
    return Array.from(roots.values())
  },

  getTimeline(limit = 100): TimelineEvent[] {
    return timeline.slice(-limit)
  },

  getDependencyGraph(nodeId: number): DependencyGraph | null {
    return buildDependencyGraph(nodeId)
  },

  // State mutation
  setSignalValue(id: number, value: unknown): boolean {
    // Get the signal setter from the runtime
    // This requires access to the actual signal node
    const global = globalThis as typeof globalThis & {
      __FICT_DEVTOOLS_SIGNALS__?: Map<number, (value: unknown) => void>
    }

    const setter = global.__FICT_DEVTOOLS_SIGNALS__?.get(id)
    if (setter) {
      try {
        setter(value)
        return true
      } catch (e) {
        console.error('[Fict DevTools] Failed to set signal value:', e)
        return false
      }
    }
    return false
  },
}

// ============================================================================
// Initialization
// ============================================================================

export function attachDebugger(): void {
  if (typeof globalThis === 'undefined') return

  const global = globalThis as typeof globalThis & {
    __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHookEnhanced
    __FICT_DEVTOOLS_STATE__?: {
      signals: Map<number, SignalState>
      computeds: Map<number, ComputedState>
      effects: Map<number, EffectState>
      components: Map<number, ComponentState>
      roots: Map<number, RootState>
      timeline: TimelineEvent[]
      settings: DevToolsSettings
    }
  }

  // Don't override if already attached
  if (global.__FICT_DEVTOOLS_HOOK__) return

  global.__FICT_DEVTOOLS_HOOK__ = hook
  global.__FICT_DEVTOOLS_STATE__ = {
    signals,
    computeds,
    effects,
    components,
    roots,
    timeline,
    settings,
  }

  // Listen for messages from panel
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handlePanelMessage)

    // Initialize BroadcastChannel for cross-tab communication (standalone mode)
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel('fict-devtools')
      broadcastChannel.onmessage = event => {
        handlePanelMessage({ data: event.data } as MessageEvent)
      }

      // Broadcast that hook is ready (for panels that connected before app loaded)
      broadcastChannel.postMessage({
        source: MessageSource.Hook,
        type: 'hook-ready',
        timestamp: Date.now(),
      })
    }
  }

  console.debug('[Fict DevTools] Debugger attached')
}

export function detachDebugger(): void {
  stopInspecting()

  if (typeof window !== 'undefined') {
    window.removeEventListener('message', handlePanelMessage)
  }

  // Close and cleanup BroadcastChannel
  if (broadcastChannel) {
    try {
      broadcastChannel.close()
    } catch {
      // Ignore errors during cleanup
    }
    broadcastChannel = null
  }

  // Reset connection state
  isConnected = false
  sourceFileCache.clear()
  clearPerformanceTimelineInstrumentation()

  const global = globalThis as typeof globalThis & {
    __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHookEnhanced
    __FICT_DEVTOOLS_STATE__?: unknown
  }

  delete global.__FICT_DEVTOOLS_HOOK__
  delete global.__FICT_DEVTOOLS_STATE__
}

export { hook }
export default hook
