import type { FictDocumentAnalysis, TraceMarker } from '../analysis/types'

function formatMarker(marker: TraceMarker): string {
  const extras: string[] = []
  if (marker.deps && marker.deps.length > 0) {
    extras.push(`deps: ${marker.deps.join(', ')}`)
  }
  if (marker.runCount !== undefined) {
    extras.push(`runs: ${marker.runCount}`)
  }
  if (marker.lastDurationMs !== undefined) {
    extras.push(`last: ${marker.lastDurationMs.toFixed(2)}ms`)
  }

  if (extras.length === 0) {
    return `- ${marker.label}`
  }

  return `- ${marker.label} (${extras.join(' | ')})`
}

export function buildReactivityExplanation(
  analysis: FictDocumentAnalysis,
  cursorLine: number,
): string {
  const component =
    analysis.components.find(item => cursorLine >= item.startLine && cursorLine <= item.endLine) ??
    analysis.components[0]

  if (!component) {
    return 'No Fict component is available in this file yet.'
  }

  const trace = component.trace.find(item => item.line === cursorLine)
  if (!trace) {
    return `Component ${component.name} has no trace marker at line ${cursorLine}.`
  }

  const details = trace.markers.map(marker => formatMarker(marker)).join('\n')
  return `Component ${component.name} (line ${trace.line})\n${details}`
}
