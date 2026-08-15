import type { CompilerInternalError, NativeCompilerOptions } from '../types'

export type TraceMarkerKind = 'once' | 'reactive' | 'effect'

export interface TraceMarker {
  kind: TraceMarkerKind
  label: string
  deps?: string[] | undefined
  regionId?: number | undefined
  runCount?: number | undefined
  lastDurationMs?: number | undefined
}

export interface LineTrace {
  line: number
  markers: TraceMarker[]
}

export interface RegionInfoSerializable {
  id: number
  startLine?: number | undefined
  startColumn?: number | undefined
  endLine?: number | undefined
  endColumn?: number | undefined
  dependencies: string[]
  declarations: string[]
  hasControlFlow: boolean
  hasReactiveWrites: boolean
  children?: RegionInfoSerializable[] | undefined
}

export interface AnalyzeDiagnostic {
  code: string
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  line: number
  column: number
  endLine?: number | undefined
  endColumn?: number | undefined
}

export interface ComponentAnalysis {
  name: string
  startLine: number
  endLine: number
  trace: LineTrace[]
  regions?: RegionInfoSerializable[] | undefined
}

export interface AnalyzeOptions {
  includeRegions?: boolean | undefined
  includeDiagnostics?: boolean | undefined
  verbosity?: 'minimal' | 'verbose' | undefined
  compilerOptions?: Partial<NativeCompilerOptions> | undefined
}

export interface AnalyzeResult {
  fileName: string
  components: ComponentAnalysis[]
  diagnostics: AnalyzeDiagnostic[]
  internalError?: CompilerInternalError
}
