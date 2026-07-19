// ============================================================================
// Types and Constants
// ============================================================================

import type { MODULE_REACTIVE_METADATA_VERSION } from './metadata-protocol.generated'

export {
  MAX_METADATA_NAMESPACE_DEPTH,
  MODULE_REACTIVE_METADATA_VERSION,
} from './metadata-protocol.generated'

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
  /** Include source labels for reactive runtime DevTools registrations. */
  dev?: boolean
  sourcemap?: boolean
  explain?: boolean
  /**
   * Lower supported reactive control-flow returns through lazy runtime branches. Disabling this
   * capability makes reactive branch returns a strict FICT-R006 fallback.
   */
  lazyConditional?: boolean
  /** Cache repeated signal/accessor reads within safe synchronous callback blocks. */
  getterCache?: boolean
  fineGrainedDom?: boolean
  optimize?: boolean
  /** Select conservative output or opt-in legacy-compatible algebraic folding. */
  optimizeLevel?: NativeOptimizeLevel
  /** Inline eligible single-use derived memos with user-authored names. */
  inlineDerivedMemos?: boolean
  strictReactivity?: boolean
  strictGuarantee?: boolean
  warningsAsErrors?: boolean | string[]
  warningLevels?: Record<string, NativeWarningLevel>
  /**
   * Direct identifier or static-member names whose first callback argument is
   * a reactive scope (for example, `renderHook(...)` or `utils.renderHook(...)`).
   * Computed and aliased calls are intentionally not matched.
   */
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
  /** Physical/source-map identity; put bundler query and fragment identity in `moduleId`. */
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
  /** Physical identity; put bundler query and fragment identity in `moduleId`. */
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
  /** Physical identity; put editor or bundler graph identity in `moduleId`. */
  filename: string
  moduleId?: string | null
  language?: SourceLanguage | null
  moduleKind?: ModuleKind | null
  /** Bundler-authoritative snapshot used to classify imported reactive values and hooks. */
  metadata?: ResolvedMetadataInput[]
  /** Diagnostics produced by the official host before native analysis. */
  integrationDiagnostics?: FictDiagnostic[]
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
