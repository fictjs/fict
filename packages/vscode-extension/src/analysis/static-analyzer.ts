import type {
  ComponentAnalysis,
  FictDocumentAnalysis,
  LineTrace,
  LiveTraceLineUpdate,
  TraceMarker,
  TraceMarkerKind,
} from './types'

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/
const TRACE_REGEX_ESCAPES = /[.*+?^${}()|[\]\\]/g
const FUNCTION_DECLARATION = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/
const FUNCTION_EXPRESSION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/
const FICT_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:fict(?:\/[^'"]+)?|@fictjs\/runtime(?:\/[^'"]+)?)['"]/m
const FICT_JSX_IMPORT_SOURCE_RE = /@jsxImportSource\s+(?:fict|@fictjs\/runtime)(?:\/[^\s*]+)?\b/m
const MACRO_RE = /\$(?:state|effect)\s*\(/

interface StaticComponentCandidate {
  name: string
  startLine: number
  endLine: number
}

interface ReactiveDecl {
  name: string
  expression: string
}

interface StateDecl {
  name: string
  line: number
}

export function isSupportedLanguageId(languageId: string): boolean {
  return (
    languageId === 'typescriptreact' ||
    languageId === 'javascriptreact' ||
    languageId === 'typescript' ||
    languageId === 'javascript'
  )
}

export function isLikelyFictSource(source: string): boolean {
  return (
    FICT_IMPORT_RE.test(source) || FICT_JSX_IMPORT_SOURCE_RE.test(source) || MACRO_RE.test(source)
  )
}

function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name)
}

function lineContainsIdentifier(lineText: string, identifier: string): boolean {
  const pattern = new RegExp(`\\b${identifier.replace(TRACE_REGEX_ESCAPES, '\\$&')}\\b`)
  return pattern.test(lineText)
}

function lineContainsAnyIdentifier(lineText: string, identifiers: Iterable<string>): boolean {
  for (const identifier of identifiers) {
    if (lineContainsIdentifier(lineText, identifier)) return true
  }
  return false
}

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0
  let started = false

  for (let line = startLine; line <= lines.length; line++) {
    const text = lines[line - 1] ?? ''
    for (const char of text) {
      if (char === '{') {
        depth += 1
        started = true
      } else if (char === '}') {
        depth -= 1
        if (started && depth <= 0) {
          return line
        }
      }
    }
  }

  return startLine
}

function findComponentCandidates(lines: string[]): StaticComponentCandidate[] {
  const components: StaticComponentCandidate[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const fnMatch = line.match(FUNCTION_DECLARATION)
    if (fnMatch && fnMatch[1] && /^[A-Z]/.test(fnMatch[1])) {
      const startLine = index + 1
      const endLine = findBlockEnd(lines, startLine)
      components.push({
        name: fnMatch[1],
        startLine,
        endLine,
      })
      continue
    }

    const constMatch = line.match(FUNCTION_EXPRESSION)
    if (constMatch && constMatch[1] && /^[A-Z]/.test(constMatch[1])) {
      const startLine = index + 1
      const endLine = line.includes('{') ? findBlockEnd(lines, startLine) : startLine
      components.push({
        name: constMatch[1],
        startLine,
        endLine,
      })
    }
  }

  return components
}

function collectStateDecls(lines: string[], startLine: number, endLine: number): StateDecl[] {
  const states: StateDecl[] = []
  const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$state\s*\(/g

  for (let line = startLine; line <= endLine; line++) {
    const text = lines[line - 1] ?? ''
    declarationPattern.lastIndex = 0
    let match = declarationPattern.exec(text)
    while (match) {
      const name = match[1]
      if (name && isIdentifierName(name)) {
        states.push({ name, line })
      }
      match = declarationPattern.exec(text)
    }
  }

  return states
}

function collectDerivedDecls(lines: string[], startLine: number, endLine: number): ReactiveDecl[] {
  const declarations: ReactiveDecl[] = []
  const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)(?:;)?$/

  for (let line = startLine; line <= endLine; line++) {
    const text = (lines[line - 1] ?? '').trim()
    if (!text) continue
    const withoutComment = text.replace(/\/\/.*$/, '').trim()
    if (!withoutComment) continue
    const match = withoutComment.match(declarationPattern)
    if (!match || !match[1] || !match[2]) continue
    declarations.push({
      name: match[1],
      expression: match[2],
    })
  }

  return declarations
}

function inferReactiveNames(lines: string[], startLine: number, endLine: number): Set<string> {
  const stateDecls = collectStateDecls(lines, startLine, endLine)
  const reactiveNames = new Set<string>(stateDecls.map(state => state.name))
  const derivedDecls = collectDerivedDecls(lines, startLine, endLine)

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of derivedDecls) {
      if (reactiveNames.has(declaration.name)) continue
      if (!lineContainsAnyIdentifier(declaration.expression, reactiveNames)) continue
      reactiveNames.add(declaration.name)
      changed = true
    }
  }

  return reactiveNames
}

function pushMarker(
  markersByLine: Map<number, TraceMarker[]>,
  line: number,
  marker: TraceMarker,
): void {
  const markers = markersByLine.get(line)
  if (!markers) {
    markersByLine.set(line, [marker])
    return
  }

  const exists = markers.some(item => item.kind === marker.kind && item.label === marker.label)
  if (!exists) {
    markers.push(marker)
  }
}

function buildTraceForComponent(
  lines: string[],
  component: StaticComponentCandidate,
  verbosity: 'minimal' | 'verbose',
): LineTrace[] {
  const markersByLine = new Map<number, TraceMarker[]>()
  const reactiveNames = inferReactiveNames(lines, component.startLine, component.endLine)
  const stateDecls = collectStateDecls(lines, component.startLine, component.endLine)

  pushMarker(markersByLine, component.startLine, {
    kind: 'once',
    label: 'Component setup runs on mount',
  })

  for (const stateDecl of stateDecls) {
    pushMarker(markersByLine, stateDecl.line, {
      kind: 'once',
      label: 'Signal initialization runs once',
    })
  }

  for (let line = component.startLine; line <= component.endLine; line++) {
    const text = lines[line - 1] ?? ''
    if (!text) continue
    const hasReactive = lineContainsAnyIdentifier(text, reactiveNames)

    if (/\b\$effect\s*\(/.test(text)) {
      pushMarker(markersByLine, line, {
        kind: 'effect',
        label: 'Effect callback executes reactively',
      })
    }

    if (hasReactive && /\{[^}]*\b[A-Za-z_$][\w$]*\b[^}]*\}/.test(text)) {
      pushMarker(markersByLine, line, {
        kind: 'reactive',
        label: 'JSX expression updates with reactive values',
      })
    }

    if (hasReactive && /\bconsole\.(?:log|debug|info|warn|error)\s*\(/.test(text)) {
      pushMarker(markersByLine, line, {
        kind: 'reactive',
        label: 'Statement reruns when reactive values change',
      })
    }

    if (!hasReactive && /\bconsole\.(?:log|debug|info|warn|error)\s*\(/.test(text)) {
      pushMarker(markersByLine, line, {
        kind: 'once',
        label: 'Statement runs only during setup',
      })
    }

    if (verbosity === 'verbose' && !hasReactive && /\{[^}]*\}/.test(text)) {
      pushMarker(markersByLine, line, {
        kind: 'once',
        label: 'JSX expression runs during setup only',
      })
    }
  }

  return [...markersByLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, markers]) => ({ line, markers }))
}

function buildComponentsFromStatic(
  lines: string[],
  candidates: StaticComponentCandidate[],
  verbosity: 'minimal' | 'verbose',
): ComponentAnalysis[] {
  return candidates.map(candidate => ({
    name: candidate.name,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    trace: buildTraceForComponent(lines, candidate, verbosity),
  }))
}

function pickMarkerKindFromLine(line: LiveTraceLineUpdate): TraceMarkerKind {
  return line.kind ?? 'reactive'
}

export function mergeLiveTraceUpdates(
  components: ComponentAnalysis[],
  updates: Map<number, LiveTraceLineUpdate>,
): ComponentAnalysis[] {
  if (updates.size === 0) return components

  return components.map(component => {
    const traceByLine = new Map<number, TraceMarker[]>(
      component.trace.map(entry => [entry.line, [...entry.markers]]),
    )

    for (const update of updates.values()) {
      if (update.line < component.startLine || update.line > component.endLine) continue
      const marker: TraceMarker = {
        kind: pickMarkerKindFromLine(update),
        label: 'Live trace update from dev server',
        runCount: update.runCount,
        lastDurationMs: update.lastDurationMs,
      }
      const markers = traceByLine.get(update.line)
      if (!markers) {
        traceByLine.set(update.line, [marker])
        continue
      }
      const existing = markers.find(
        item => item.label === marker.label && item.kind === marker.kind,
      )
      if (existing) {
        existing.runCount = marker.runCount
        existing.lastDurationMs = marker.lastDurationMs
      } else {
        markers.push(marker)
      }
    }

    return {
      ...component,
      trace: [...traceByLine.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, markers]) => ({ line, markers })),
    }
  })
}

export function analyzeStaticFictSource(
  source: string,
  fileName: string,
  verbosity: 'minimal' | 'verbose',
): FictDocumentAnalysis {
  const lines = source.split(/\r?\n/)
  const isFictFile = isLikelyFictSource(source)
  const candidates = isFictFile ? findComponentCandidates(lines) : []
  const components = buildComponentsFromStatic(lines, candidates, verbosity)

  return {
    fileName,
    components,
    diagnostics: [],
    isFictFile,
    generatedAt: Date.now(),
    mode: 'static',
  }
}
