import type { FictCompilerOptions } from '../types'

export type TraceMarkerKind = 'once' | 'reactive' | 'effect'

export interface TraceMarker {
  kind: TraceMarkerKind
  label: string
  deps?: string[]
  regionId?: number
  runCount?: number
  lastDurationMs?: number
}

export interface LineTrace {
  line: number
  markers: TraceMarker[]
}

export interface RegionInfoSerializable {
  id: number
  startLine?: number
  startColumn?: number
  endLine?: number
  endColumn?: number
  dependencies: string[]
  declarations: string[]
  hasControlFlow: boolean
  hasReactiveWrites: boolean
  children?: RegionInfoSerializable[]
}

export interface AnalyzeDiagnostic {
  code: string
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface ComponentAnalysis {
  name: string
  startLine: number
  endLine: number
  trace: LineTrace[]
  regions?: RegionInfoSerializable[]
}

export interface AnalyzeOptions {
  includeRegions?: boolean
  includeDiagnostics?: boolean
  verbosity?: 'minimal' | 'verbose'
  compilerOptions?: Partial<FictCompilerOptions>
}

export interface AnalyzeResult {
  fileName: string
  components: ComponentAnalysis[]
  diagnostics: AnalyzeDiagnostic[]
}
