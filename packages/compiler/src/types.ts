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

export type ReactiveExportKind = 'signal' | 'memo' | 'store'

export interface HookReturnInfoSerializable {
  objectProps?: Record<string, 'signal' | 'memo'>
  arrayProps?: Record<string, 'signal' | 'memo'>
  directAccessor?: 'signal' | 'memo'
}

export interface ModuleReactiveMetadata {
  exports: Record<string, ReactiveExportKind>
  hooks?: Record<string, HookReturnInfoSerializable>
}

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
  onWarn?: (warning: CompilerWarning) => void
  /** Internal: filename of the module being compiled. */
  filename?: string
  /** Enable lazy evaluation of conditional derived values (Rule J optimization) */
  lazyConditional?: boolean
  /** Enable getter caching within the same sync block (Rule L optimization) */
  getterCache?: boolean
  /** Emit fine-grained DOM creation/binding code for supported JSX templates */
  fineGrainedDom?: boolean
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
  warningLevels?: Record<string, 'off' | 'warn' | 'error'>
  /**
   * Optional shared module metadata map for cross-module reactive imports.
   * If omitted, the compiler uses a process-wide cache.
   */
  moduleMetadata?: Map<string, ModuleReactiveMetadata>
  /**
   * Emit module metadata sidecar files to enable cross-process metadata resolution.
   * - true: always emit
   * - false: never emit
   * - 'auto' or undefined: emit only when no external metadata store/resolver is provided
   */
  emitModuleMetadata?: boolean | 'auto'
  /**
   * File extension suffix for module metadata sidecars.
   * Defaults to '.fict.meta.json'.
   */
  moduleMetadataExtension?: string
  /**
   * Optional hook to resolve module metadata for a given import source.
   * Tooling can override the default resolution strategy.
   */
  resolveModuleMetadata?: (
    source: string,
    importer?: string,
  ) => ModuleReactiveMetadata | null | undefined
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
