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
  helpersUsed: HelperUsage
  options: FictCompilerOptions
  dependencyGraph: Map<string, Set<string>>
  derivedDecls: Map<string, BabelCore.types.Node>
  hasStateImport: boolean
  hasEffectImport: boolean
  exportedNames: Set<string>
  fineGrainedTemplateId: number
  file: BabelCore.BabelFile
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
  bindEvent: boolean
  toNodeArray: boolean
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
  }
}
