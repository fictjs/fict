import type { AssignInstruction, HIRFunction, Instruction } from '../ir/hir'
import { deSSAVarName } from '../ir/regions'
import { walkExpression } from '../ir/walk-expression'

import type { LineTrace, RegionInfoSerializable, TraceMarker } from './types'

interface InferTraceInput {
  fn: HIRFunction
  sourceLines: string[]
  startLine: number
  endLine: number
  verbosity: 'minimal' | 'verbose'
  regions?: RegionInfoSerializable[] | undefined
}

const TRACE_REGEX_ESCAPES = /[.*+?^${}()|[\]\\]/g
const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/
const IDENTIFIER_BOUNDARY_CHARS = 'A-Za-z0-9_$'

function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name)
}

function lineContainsIdentifier(lineText: string, identifier: string): boolean {
  const escaped = identifier.replace(TRACE_REGEX_ESCAPES, '\\$&')
  const pattern = new RegExp(
    `(^|[^${IDENTIFIER_BOUNDARY_CHARS}])${escaped}(?![${IDENTIFIER_BOUNDARY_CHARS}])`,
  )
  return pattern.test(lineText)
}

function lineContainsAnyIdentifier(lineText: string, identifiers: Iterable<string>): boolean {
  for (const id of identifiers) {
    if (lineContainsIdentifier(lineText, id)) return true
  }
  return false
}

function pushTraceMarker(
  markersByLine: Map<number, TraceMarker[]>,
  line: number,
  marker: TraceMarker,
): void {
  const markers = markersByLine.get(line)
  if (!markers) {
    markersByLine.set(line, [marker])
    return
  }
  const duplicate = markers.some(
    existing => existing.kind === marker.kind && existing.label === marker.label,
  )
  if (!duplicate) markers.push(marker)
}

function inferReactiveLocalNames(
  startLine: number,
  endLine: number,
  sourceLines: string[],
  baseReactiveNames: Iterable<string>,
): Set<string> {
  const reactiveNames = new Set<string>(baseReactiveNames)
  const declarationLines: { name: string; expression: string }[] = []
  const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)(?:;)?$/

  for (let line = startLine; line <= endLine; line++) {
    const text = (sourceLines[line - 1] ?? '').trim()
    if (!text) continue
    const withoutComment = text.replace(/\/\/.*$/, '').trim()
    if (!withoutComment) continue
    const match = withoutComment.match(declarationPattern)
    if (!match) continue
    const name = match[1]
    const expression = match[2]
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

function isStateCallInstruction(instr: Instruction): instr is AssignInstruction {
  if (instr.kind !== 'Assign') return false
  const value = instr.value
  return (
    value.kind === 'CallExpression' &&
    value.callee.kind === 'Identifier' &&
    value.callee.name === '$state'
  )
}

function collectStateDeclNames(fn: HIRFunction): { name: string; line: number }[] {
  const result: { name: string; line: number }[] = []
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (!isStateCallInstruction(instr)) continue
      const loc = instr.loc ?? instr.value.loc
      if (!loc) continue
      const name = deSSAVarName(instr.target.name)
      if (!isIdentifierName(name)) continue
      result.push({ name, line: loc.start.line })
    }
  }
  return result
}

function expressionContainsEffectCall(instr: Instruction): number | null {
  const value = instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value : null
  if (!value || !instr.loc) return null

  let found = false
  walkExpression(value, expr => {
    if (
      expr.kind === 'CallExpression' &&
      expr.callee.kind === 'Identifier' &&
      deSSAVarName(expr.callee.name) === '$effect'
    ) {
      found = true
    }
  })
  return found ? instr.loc.start.line : null
}

function flattenRegions(regions: RegionInfoSerializable[] | undefined): RegionInfoSerializable[] {
  if (!regions || regions.length === 0) return []
  const result: RegionInfoSerializable[] = []
  const visit = (region: RegionInfoSerializable): void => {
    result.push(region)
    region.children?.forEach(child => visit(child))
  }
  regions.forEach(region => visit(region))
  return result
}

function findContainingRegion(
  line: number,
  flatRegions: RegionInfoSerializable[],
): RegionInfoSerializable | undefined {
  let best: RegionInfoSerializable | undefined
  for (const region of flatRegions) {
    if (
      region.startLine === undefined ||
      region.endLine === undefined ||
      line < region.startLine ||
      line > region.endLine
    ) {
      continue
    }
    const bestSpan =
      best && best.startLine !== undefined && best.endLine !== undefined
        ? best.endLine - best.startLine
        : Number.POSITIVE_INFINITY
    const span = region.endLine - region.startLine
    if (span <= bestSpan) best = region
  }
  return best
}

export function inferTraceMarkersForComponent(input: InferTraceInput): LineTrace[] {
  const { fn, sourceLines, startLine, endLine, verbosity, regions } = input
  const markersByLine = new Map<number, TraceMarker[]>()

  pushTraceMarker(markersByLine, startLine, {
    kind: 'once',
    label: 'Component setup runs on mount',
  })

  const stateDecls = collectStateDeclNames(fn)
  const reactiveNames = inferReactiveLocalNames(
    startLine,
    endLine,
    sourceLines,
    stateDecls.map(item => item.name),
  )

  for (const stateDecl of stateDecls) {
    pushTraceMarker(markersByLine, stateDecl.line, {
      kind: 'once',
      label: 'Signal initialization runs once',
    })
  }

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      const line = expressionContainsEffectCall(instr)
      if (!line || line < startLine || line > endLine) continue
      pushTraceMarker(markersByLine, line, {
        kind: 'effect',
        label: 'Effect reruns when dependencies change',
      })
    }
  }

  const flatRegions = flattenRegions(regions)

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

    if (verbosity === 'verbose' && !hasReactiveName && /\{[^}]*\}/.test(lineText)) {
      pushTraceMarker(markersByLine, line, {
        kind: 'once',
        label: 'JSX expression runs during setup only',
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

    const containingRegion = findContainingRegion(line, flatRegions)
    if (!containingRegion) continue
    const markers = markersByLine.get(line)
    if (!markers) continue
    for (const marker of markers) {
      marker.regionId = containingRegion.id
      marker.deps = containingRegion.dependencies
    }
  }

  return [...markersByLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, markers]) => ({ line, markers }))
}
