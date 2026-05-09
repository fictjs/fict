import type {
  AnalyzeDiagnostic,
  AnalyzeResult,
  ComponentAnalysis,
  LineTrace,
  RegionInfoSerializable,
  TraceMarker,
  TraceMarkerKind,
} from '@fictjs/compiler'

export type {
  AnalyzeDiagnostic,
  AnalyzeResult,
  ComponentAnalysis,
  LineTrace,
  RegionInfoSerializable,
  TraceMarker,
  TraceMarkerKind,
}

export type TraceMode = 'static' | 'compiler' | 'live'

export interface LiveTraceLineUpdate {
  line: number
  kind?: TraceMarkerKind | undefined
  runCount?: number | undefined
  lastDurationMs?: number | undefined
}

export interface FictDocumentAnalysis extends AnalyzeResult {
  mode: TraceMode
  isFictFile: boolean
  generatedAt: number
}

export interface AnalyzerSettings {
  mode: TraceMode
  verbosity: 'minimal' | 'verbose'
  includeRegions: boolean
  includeDiagnostics: boolean
}
