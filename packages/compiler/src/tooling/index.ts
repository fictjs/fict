export type {
  AnalyzeDiagnostic,
  AnalyzeOptions,
  AnalyzeResult,
  ComponentAnalysis,
  LineTrace,
  RegionInfoSerializable,
  TraceMarker,
  TraceMarkerKind,
} from './types'
export { analyzeFictFile } from './analyze'
export { inferTraceMarkersForComponent } from './trace-infer'
export { minimizeSourceByLines } from './minimize'
export type {
  SourceMinimizerOptions,
  SourceMinimizerBackend,
  SourceMinimizerPredicate,
  SourceMinimizerPredicateContext,
  SourceMinimizerResult,
} from './minimize'
