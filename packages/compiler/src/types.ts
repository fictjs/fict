// ============================================================================
// Types and Constants
// ============================================================================

export type FictDiagnosticSeverity = 'error' | 'warning' | 'info'

export type FictDiagnosticGuaranteeClass =
  | 'notApplicable'
  | 'advisory'
  | 'fallback'
  | 'unsupported'
  | 'internal'

/** Half-open UTF-8 byte range in the compilation source. */
export interface FictSourceSpan {
  start: number
  end: number
}

export interface FictDiagnosticLabel {
  span: FictSourceSpan
  message: string
}

/** Structured native diagnostic before host-specific code-frame rendering. */
export interface FictDiagnostic {
  code: string
  severity: FictDiagnosticSeverity
  message: string
  primarySpan: FictSourceSpan | null
  secondaryLabels: FictDiagnosticLabel[]
  help: string | null
  notes: string[]
  guaranteeClass: FictDiagnosticGuaranteeClass
}

export type CompilerExplainEventKind =
  | 'source-signal'
  | 'source-effect'
  | 'source-memo'
  | 'source-jsx'
  | 'source-control-flow'
  | 'runtime-helper'
  | 'diagnostic'

export type ReactiveExportKind = 'signal' | 'memo' | 'store'

export const MODULE_REACTIVE_METADATA_VERSION = 1

export type ModuleReactiveMetadataVersion = typeof MODULE_REACTIVE_METADATA_VERSION

export interface HookReturnInfoSerializable {
  objectProps?: Record<string, ReactiveExportKind> | undefined
  arrayProps?: Record<string, ReactiveExportKind> | undefined
  directAccessor?: ReactiveExportKind | undefined
}

export interface ModuleReactiveMetadata {
  version: ModuleReactiveMetadataVersion
  exports: Record<string, ReactiveExportKind>
  hooks?: Record<string, HookReturnInfoSerializable>
  namespaces?: Record<string, ModuleReactiveMetadata>
}

export type MetadataResolutionStatus = 'resolved' | 'opaque' | 'missing' | 'incompleteCycle'

/** Bundler-authoritative metadata snapshot; callbacks never cross the native boundary. */
export interface ResolvedMetadataInput {
  request: string
  resolvedId: string | null
  status: MetadataResolutionStatus
  metadata: ModuleReactiveMetadata | null
  fingerprint: string
}

export const COMPILER_PROTOCOL_VERSION = 1

export type CompilerProtocolVersion = typeof COMPILER_PROTOCOL_VERSION

export type SourceLanguage = 'js' | 'jsx' | 'ts' | 'tsx'

export type ModuleKind = 'module' | 'script' | 'commonjs' | 'unambiguous'

export type NativeOptimizeLevel = 'safe' | 'full'

export type NativeWarningLevel = 'off' | 'warn' | 'error'

export interface CompilerPreviewOptions {
  /**
   * @experimental Enables the unfrozen resumable-handler/QRL protocol. Omit this option or use
   * eager event handlers for the stable compilation path.
   */
  resumable?: boolean
  /**
   * @experimental Selects handlers for the unfrozen resumable protocol automatically. Keep this
   * disabled and use eager event handlers for stable behavior.
   */
  autoExtractHandlers?: boolean
  /**
   * @experimental Tunes a heuristic of the unfrozen resumable protocol. Keep automatic extraction
   * disabled for the stable compilation path.
   */
  autoExtractThreshold?: number
}

export interface NativeTypeScriptOptions {
  allowNamespaces?: boolean
  onlyRemoveTypeImports?: boolean
  optimizeConstEnums?: boolean
  optimizeEnums?: boolean
  rewriteImportExtensions?: boolean
  removeClassFieldsWithoutInitializer?: boolean
}

/** Serializable options accepted by the native core; callbacks and host I/O are excluded. */
export interface NativeCompilerOptions {
  /** Reserved compatibility field. Only `false` is currently implemented. */
  dev?: boolean
  sourcemap?: boolean
  explain?: boolean
  /** Reserved compatibility field. Only `true` is currently implemented. */
  lazyConditional?: boolean
  /** Reserved compatibility field. Only `true` is currently implemented. */
  getterCache?: boolean
  fineGrainedDom?: boolean
  optimize?: boolean
  /** Reserved compatibility field. Only `'safe'` is currently implemented. */
  optimizeLevel?: NativeOptimizeLevel
  /** Reserved compatibility field. Only `true` is currently implemented. */
  inlineDerivedMemos?: boolean
  strictReactivity?: boolean
  strictGuarantee?: boolean
  warningsAsErrors?: boolean | string[]
  warningLevels?: Record<string, NativeWarningLevel>
  reactiveScopes?: string[]
  typescript?: NativeTypeScriptOptions
  preview?: CompilerPreviewOptions | null
}

export interface RawSourceMap {
  version: 3
  file?: string
  sourceRoot?: string
  sources: string[]
  sourcesContent?: (string | null)[]
  names?: string[]
  mappings: string
  x_google_ignoreList?: number[]
}

export interface CompileRequest {
  protocolVersion?: CompilerProtocolVersion
  code: string
  filename: string
  moduleId?: string | null
  /** Stable graph-host identity embedded in Preview QRLs instead of a physical path. */
  publicModuleId?: string | null
  language?: SourceLanguage | null
  moduleKind?: ModuleKind | null
  inputSourceMap?: RawSourceMap | null
  options?: NativeCompilerOptions
  metadata?: ResolvedMetadataInput[]
  integrationDiagnostics?: FictDiagnostic[]
}

export type ScanModuleRequestKind = 'import' | 'reExport' | 'importEquals'

/** Parse-only request used by bundler module-graph hosts. */
export interface ScanRequest {
  protocolVersion?: CompilerProtocolVersion
  code: string
  filename: string
  moduleId?: string | null
  language?: SourceLanguage | null
  moduleKind?: ModuleKind | null
}

/** One static import, re-export, or TypeScript import-equals edge. */
export interface ScanModuleRequest {
  source: string
  kind: ScanModuleRequestKind
  typeOnly: boolean
  /** Half-open UTF-8 byte span of the module string literal. */
  span: FictSourceSpan
}

/** Arena-independent result returned by native scan entrypoints. */
export interface ScanResult {
  protocolVersion: CompilerProtocolVersion
  moduleRequests: ScanModuleRequest[]
  hasModuleSyntax: boolean
  diagnostics: FictDiagnostic[]
  compilerBuildId: string
}

export type NativeAnalyzeVerbosity = 'minimal' | 'verbose'

/** Serializable controls accepted by native editor/tooling analysis. */
export interface NativeAnalyzeOptions {
  includeRegions?: boolean
  includeDiagnostics?: boolean
  verbosity?: NativeAnalyzeVerbosity
  compilerOptions?: NativeCompilerOptions
}

/** Source-file request accepted by native sync and worker-pool analysis. */
export interface AnalyzeRequest {
  protocolVersion?: CompilerProtocolVersion
  code: string
  filename: string
  moduleId?: string | null
  language?: SourceLanguage | null
  moduleKind?: ModuleKind | null
  options?: NativeAnalyzeOptions
}

export type CompilerArtifactKind = 'handlerModule' | 'auxiliaryModule'

export interface HandlerArtifactMetadata {
  /** Request-local source export retained for QRL and diagnostic identity. */
  sourceExportName: string
  /** Export loaded from the standalone handler module, normally `default`. */
  artifactExportName: string
  /** Compiler-owned placeholder embedded in main output for graph-host replacement. */
  moduleSpecifier: string
  /** Authored handler expression used by artifact source-map probes. */
  sourceSpan: FictSourceSpan
}

export interface CompilerArtifact {
  id: string
  kind: CompilerArtifactKind
  code: string
  map: RawSourceMap | null
  handler: HandlerArtifactMetadata | null
}

export interface NativeCompilerExplainEvent {
  kind: CompilerExplainEventKind
  message: string
  name: string | null
  code: string | null
  span: FictSourceSpan | null
}

export interface NativeCompilerExplainArtifact {
  version: number
  fileName: string
  helpers: string[]
  diagnostics: FictDiagnostic[]
  events: NativeCompilerExplainEvent[]
}

export interface CompilerStats {
  stageDurationsNs: Record<string, number>
  counters: Record<string, number>
}

export interface CompileResult {
  protocolVersion: CompilerProtocolVersion
  code: string
  map: RawSourceMap | null
  diagnostics: FictDiagnostic[]
  moduleMetadata: ModuleReactiveMetadata
  metadataDependencies: string[]
  unresolvedMetadataRequests: string[]
  metadataIncomplete: boolean
  explain: NativeCompilerExplainArtifact | null
  artifacts: CompilerArtifact[]
  stats: CompilerStats | null
  compilerBuildId: string
}
