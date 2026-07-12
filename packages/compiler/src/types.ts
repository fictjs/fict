import type * as BabelCore from '@babel/core'

// ============================================================================
// Types and Constants
// ============================================================================

export interface TransformContext {
  stateVars: Set<string>
  memoVars: Set<string>
  guardedDerived: Set<string>
  aliasVars: Set<string>
  getterOnlyVars: Set<string>
  shadowedVars: Set<string>
  shadowStack: Set<string>[]
  trackedScopeStack: Set<string>[]
  propsStack: Set<string>[]
  helpersUsed: HelperUsage
  options: FictCompilerOptions
  dependencyGraph: Map<string, Set<string>>
  derivedDecls: Map<string, BabelCore.types.Node>
  hasStateImport: boolean
  hasEffectImport: boolean
  exportedNames: Set<string>
  fineGrainedTemplateId: number
  file: BabelCore.BabelFile
  noMemo: boolean
  noMemoFunctions: WeakSet<BabelCore.types.Function>
  slotCounters: WeakMap<BabelCore.types.Node, number>
  functionsWithJsx: WeakSet<BabelCore.types.Function>
  /**
   * Variables that will become getters after region transform.
   * Used by JSX shorthand property transformation to know which
   * variables need to be called as getters (e.g. { color } -> { color: color() })
   * before the region transform actually converts them to getters.
   */
  pendingRegionOutputs: WeakMap<BabelCore.types.Function, Set<string>>
  pendingRegionStack: Set<string>[]
}

export interface HelperUsage {
  signal: boolean
  memo: boolean
  effect: boolean
  createElement: boolean
  conditional: boolean
  keyedList: boolean
  insert: boolean
  onDestroy: boolean
  bindText: boolean
  bindAttribute: boolean
  bindProperty: boolean
  bindClass: boolean
  bindStyle: boolean
  bindEvent?: boolean
  bindRef?: boolean
  toNodeArray?: boolean
  useContext: boolean
  useSignal: boolean
  useMemo: boolean
  useEffect: boolean
  render: boolean
  fragment: boolean
  template: boolean
  propGetter: boolean
  propsRest: boolean
}

export interface CompilerWarning {
  code: string
  message: string
  fileName: string
  line: number
  column: number
}

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

export interface CompilerExplainEvent {
  kind: CompilerExplainEventKind
  message: string
  name?: string
  code?: string
  line?: number
  column?: number
}

export interface CompilerExplainArtifact {
  version: 1
  fileName: string
  helpers: string[]
  diagnostics: CompilerWarning[]
  events: CompilerExplainEvent[]
}

export type ReactiveExportKind = 'signal' | 'memo' | 'store'

export const MODULE_REACTIVE_METADATA_VERSION = 1

export type ModuleReactiveMetadataVersion = typeof MODULE_REACTIVE_METADATA_VERSION

export interface HookReturnInfoSerializable {
  objectProps?: Record<string, ReactiveExportKind> | undefined
  arrayProps?: Record<string, ReactiveExportKind> | undefined
  directAccessor?: ReactiveExportKind | undefined
}

export interface ModuleReactiveMetadata {
  version?: ModuleReactiveMetadataVersion
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
  resumable?: boolean
  autoExtractHandlers?: boolean
  autoExtractThreshold?: number
}

/** Serializable options accepted by the native core; callbacks and host I/O are excluded. */
export interface NativeCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
  explain?: boolean
  lazyConditional?: boolean
  getterCache?: boolean
  fineGrainedDom?: boolean
  optimize?: boolean
  optimizeLevel?: NativeOptimizeLevel
  inlineDerivedMemos?: boolean
  strictReactivity?: boolean
  strictGuarantee?: boolean
  warningsAsErrors?: boolean | string[]
  warningLevels?: Record<string, NativeWarningLevel>
  reactiveScopes?: string[]
  preview?: CompilerPreviewOptions | null
}

export interface RawSourceMap {
  version: 3
  file?: string
  sourceRoot?: string
  sources: string[]
  sourcesContent?: Array<string | null>
  names?: string[]
  mappings: string
  x_google_ignoreList?: number[]
}

export interface CompileRequest {
  protocolVersion?: CompilerProtocolVersion
  code: string
  filename: string
  moduleId?: string | null
  language?: SourceLanguage | null
  moduleKind?: ModuleKind | null
  inputSourceMap?: RawSourceMap | null
  options?: NativeCompilerOptions
  metadata?: ResolvedMetadataInput[]
  integrationDiagnostics?: FictDiagnostic[]
}

export type CompilerArtifactKind = 'handlerModule' | 'auxiliaryModule'

export interface CompilerArtifact {
  id: string
  kind: CompilerArtifactKind
  code: string
  map: RawSourceMap | null
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

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
  onWarn?: (warning: CompilerWarning) => void
  /** Diagnostics prepared by an official integration before compiler traversal. @internal */
  integrationDiagnostics?: CompilerWarning[]
  /** Validate an integration-owned metadata graph without mutating persisted sidecars. @internal */
  validateIntegrationMetadata?: boolean
  /**
   * Emit a structured explanation artifact for compiler decisions.
   * When true, the artifact is attached to Babel result metadata as `fictExplain`.
   * When a callback is provided, it is also called with the artifact.
   */
  explain?: boolean | ((artifact: CompilerExplainArtifact) => void)
  /** Internal: filename of the module being compiled. */
  filename?: string
  /**
   * Stable public identity embedded in resumable component and event QRLs.
   * Official build integrations provide this separately from `filename`, which
   * remains the physical path used for diagnostics, resolution, and caches.
   * @internal
   */
  publicModuleId?: string
  /** Enable lazy evaluation of conditional derived values (Rule J optimization). Default: true. */
  lazyConditional?: boolean
  /** Enable getter caching within the same sync block (Rule L optimization). Default: true. */
  getterCache?: boolean
  /** Emit fine-grained DOM creation/binding code for supported JSX templates */
  fineGrainedDom?: boolean
  /**
   * Enable Preview resumable output (QRL handlers + resume metadata).
   * Defaults to false and is not part of the Core 1.0 compatibility promise.
   *
   * @experimental Resumability and its generated ABI may change in any release.
   */
  resumable?: boolean
  /**
   * Automatically extract event handlers for lazy loading even without `$` suffix.
   * When enabled, the compiler analyzes handlers and extracts complex ones automatically.
   * Handlers with explicit `$` suffix are always extracted regardless of this setting.
   * @default true when resumable is enabled
   * @experimental Part of the Preview resumability pipeline.
   */
  autoExtractHandlers?: boolean
  /**
   * Minimum AST node count for a handler to be auto-extracted.
   * Handlers with fewer nodes are considered too simple and will be inlined.
   * Only applies when autoExtractHandlers is enabled.
   * @default 3
   * @experimental Part of the Preview resumability pipeline.
   */
  autoExtractThreshold?: number
  /** Enable HIR optimization passes (DCE/const-fold/CSE) */
  optimize?: boolean
  /**
   * Optimization safety level.
   * - 'safe': avoid non-constant algebraic rewrites to preserve JS semantics.
   * - 'full': allow algebraic simplifications beyond constant folding.
   */
  optimizeLevel?: 'safe' | 'full'
  /** Allow inlining single-use derived values even when user-named */
  inlineDerivedMemos?: boolean
  /**
   * Treat warnings as errors. Use true for all warnings, or provide a list of codes.
   */
  warningsAsErrors?: boolean | string[]
  /**
   * Per-warning override. "off" suppresses, "error" throws, "warn" emits.
   */
  warningLevels?: Record<string, 'off' | 'warn' | 'error'> | undefined
  /**
   * Strict control-flow reactivity mode.
   * When enabled, control-flow fallback diagnostics (`FICT-R003`, `FICT-R006`)
   * are treated as errors unless explicitly overridden via `warningLevels`.
   */
  strictReactivity?: boolean
  /**
   * Fail-closed reactivity guarantee mode.
   * When enabled, diagnostics that indicate non-guaranteed reactive behavior are
   * treated as hard errors and cannot be suppressed/downgraded.
   * Default: true. Production compilation (`NODE_ENV=production`) forces this
   * mode on even if an integration passes `false`; use non-production builds for
   * migration experiments that intentionally exercise fallback behavior.
   */
  strictGuarantee?: boolean
  /**
   * Optional shared module metadata map for cross-module reactive imports.
   * If omitted, the compiler uses a process-wide cache.
   */
  moduleMetadata?: Map<string, ModuleReactiveMetadata>
  /**
   * Emit module metadata files to enable cross-process metadata resolution.
   * - true: always emit adjacent sidecar files next to source modules
   * - false: never emit metadata files
   * - 'auto' or undefined:
   *   - emit to cache directory only when no external metadata store/resolver is provided
   *   - avoid source tree pollution while keeping cross-process resolution available
   */
  emitModuleMetadata?: boolean | 'auto'
  /**
   * Cache directory for metadata files when `emitModuleMetadata` is `'auto'`.
   * Defaults to `<cwd>/.fict-cache/metadata`.
   */
  moduleMetadataCacheDir?: string
  /**
   * File extension suffix for module metadata sidecars.
   * Defaults to '.fict.meta.json'.
   */
  moduleMetadataExtension?: string
  /**
   * Optional hook to resolve module metadata for a given import source.
   * Tooling can override the default resolution strategy.
   * Return `undefined` to continue with the compiler's default resolution.
   * Return `null` for an authoritative miss that must not fall back to another resolver.
   */
  resolveModuleMetadata?: (
    source: string,
    importer?: string,
  ) => ModuleReactiveMetadata | null | undefined
  /** Notify integrations about package manifests/sidecars consulted during metadata resolution. */
  onModuleMetadataDependency?: (filename: string) => void
  /**
   * Optional TypeScript integration data provided by tooling (e.g., Vite plugin).
   * The compiler currently ignores this, but it enables future type-aware passes.
   */
  typescript?: {
    program?: unknown
    checker?: unknown
    projectVersion?: number
    configPath?: string
  }
  /**
   * Function names that create reactive scopes. Callbacks passed to these functions
   * are treated as component-like contexts where $state and $effect can be used.
   *
   * This is useful for testing libraries (e.g., renderHook) and other scenarios
   * where reactive code runs in non-component contexts.
   *
   * Limitations (by design):
   * - Only direct calls are recognized (e.g., renderHook(() => ...), utils.renderHook(() => ...)).
   * - Only the first argument is treated as the reactive callback.
   * - Aliased/indirect calls are not recognized (e.g., const rh = renderHook; rh(() => ...)).
   *
   * @example
   * ```typescript
   * // In vite.config.ts or babel config:
   * reactiveScopes: ['renderHook', 'createReactiveScope']
   *
   * // Then in tests:
   * renderHook(() => {
   *   let count = $state(0)  // Now allowed!
   *   return count
   * })
   * ```
   */
  reactiveScopes?: string[]
}

export interface VisitorOptions {
  disableRegionTransform: boolean
  disableMemoize: boolean
  disableFineGrainedDom: boolean
}

export function createHelperUsage(): HelperUsage {
  return {
    signal: false,
    memo: false,
    effect: false,
    useContext: false,
    useSignal: false,
    useMemo: false,
    useEffect: false,
    render: false,
    fragment: false,
    createElement: false,
    conditional: false,
    keyedList: false,
    insert: false,
    onDestroy: false,
    bindText: false,
    bindAttribute: false,
    bindProperty: false,
    bindClass: false,
    bindStyle: false,
    bindEvent: false,
    toNodeArray: false,
    template: false,
    propGetter: false,
    propsRest: false,
  }
}
