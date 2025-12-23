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
  list: boolean
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
  createKeyedListContainer: boolean
  createKeyedBlock: boolean
  moveMarkerBlock: boolean
  destroyMarkerBlock: boolean
  getFirstNodeAfter: boolean
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

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
  onWarn?: (warning: CompilerWarning) => void
  /** Enable lazy evaluation of conditional derived values (Rule J optimization) */
  lazyConditional?: boolean
  /** Enable getter caching within the same sync block (Rule L optimization) */
  getterCache?: boolean
  /** Emit fine-grained DOM creation/binding code for supported JSX templates */
  fineGrainedDom?: boolean
  /**
   * @deprecated HIR is now the default. Set to false to use legacy path (not recommended).
   * Default: true
   */
  experimentalHIR?: boolean
  /**
   * @deprecated HIR codegen is now the default. Set to false to use legacy path (not recommended).
   * Requires experimentalHIR to be true. Default: true
   */
  hirCodegen?: boolean
  /**
   * Enable the HIR-only entrypoint that skips legacy visitors and emits code
   * directly from the HIR → SSA → Region pipeline. Default: true.
   */
  hirEntrypoint?: boolean
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
    list: false,
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
    createKeyedListContainer: false,
    createKeyedBlock: false,
    moveMarkerBlock: false,
    destroyMarkerBlock: false,
    getFirstNodeAfter: false,
    template: false,
    propGetter: false,
    propsRest: false,
  }
}
