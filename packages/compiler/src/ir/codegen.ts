import type * as BabelCore from '@babel/core'

import { DelegatedEvents, RUNTIME_ALIASES } from '../constants'
import { debugLog } from '../debug'
import { applyRegionMetadata, shouldMemoizeRegion, type RegionMetadata } from '../fine-grained-dom'
import { setModuleMetadata } from '../module-metadata'
import type { FictCompilerOptions, ModuleReactiveMetadata } from '../types'
import { DiagnosticCode, reportDiagnostic } from '../validation'

import { convertStatementsToHIRFunction } from './build-hir'
import {
  collectMutatedIdentifiers,
  collectCalledIdentifiers,
  functionContainsJSX,
  functionHasAsyncAwait,
  functionHasYield,
  structuredNodeHasComplexControlFlow,
} from './codegen-analysis'
import {
  getCachedGetterExpression,
  getOrCreateHoistedTemplate,
  withGetterCache,
} from './codegen-cache'
import { emitConditionalChild } from './codegen-conditional-child'
import { detectDerivedCycles } from './codegen-cycles'
import {
  extractDelegatedEventData,
  extractDelegatedEventDataFromHIR,
} from './codegen-delegated-data'
import { emitReactiveControlFlowReexecutionWarning } from './codegen-diagnostics'
import { isDOMProperty, isStaticDelegatedDataAst } from './codegen-dom-utils'
import { collectExpressionDependencies } from './codegen-expression-deps'
import {
  emitHIRChildBinding,
  resolveHIRBindingPath,
  type HIRChildBindingOps,
} from './codegen-hir-bindings'
import { markCompilerReactiveGetter } from './codegen-reactive-getter'
import {
  analyzeHookReturnInfo as analyzeHookReturnInfoWithOps,
  deserializeHookReturnInfo,
  getHookReturnInfo as getHookReturnInfoWithOps,
  serializeHookReturnInfo,
  type HookAccessorKind,
  type HookReturnInfo,
  type HookReturnInfoAnalysisOps,
} from './codegen-hook-returns'
import { attachHelperImports, collectDeclaredNames } from './codegen-imports'
import { buildListCallExpression, emitListChild, type ListChildOps } from './codegen-list-child'
import {
  isListKeyConstExpression,
  isStaticDelegatedDataExpression,
  matchesListKeyPattern,
} from './codegen-list-keys'
import {
  applyImportedReactiveMetadata,
  buildModuleReactiveMetadata,
} from './codegen-module-metadata'
import {
  normalizeDependencyKey,
  replaceIdentifiersWithOverrides,
  type RegionOverrideMap,
} from './codegen-overrides'
import { computeReactiveAccessors } from './codegen-reactive-accessors'
import {
  getReactiveCallKind,
  getReactiveCallKindFromBabel,
  getStaticPropName,
} from './codegen-reactive-kind'
import {
  getReactiveDependencies,
  isExpressionReactive,
  isLikelyTextExpression,
} from './codegen-reactivity'
import { findContainingRegion, regionInfoToMetadata } from './codegen-region-utils'
import { registerResumableComponent } from './codegen-resumable-component'
import {
  emitResumableEventBinding,
  type ResumableEventBindingOps,
} from './codegen-resumable-events'
import { collectRuntimeImports } from './codegen-runtime-imports'
import {
  extractHIRStaticHtml,
  resolveNamespaceContext,
  type NamespaceContext,
} from './codegen-template-extraction'
import {
  HIRError,
  type BasicBlock,
  type Expression,
  type HIRFunction,
  type HIRProgram,
  type Instruction,
  type JSXChild,
  type JSXElementExpression,
  type Terminator,
} from './hir'
import { isHookLikeFunction, isHookName } from './hook-utils'
import { buildPropsExpression } from './props-plan'
import {
  deSSAVarName,
  expressionUsesTracked,
  lowerStructuredNodeWithoutRegions,
  type Region,
} from './regions'
import { generateRegions, generateRegionCode, regionToMetadata } from './regions'
import type { ReactiveScopeResult } from './scopes'
import { analyzeReactiveScopesWithSSA } from './scopes'
import { structurizeCFG, structurizeCFGWithDiagnostics } from './structurize'

export { getReactiveCallKind } from './codegen-reactive-kind'

const HOOK_SLOT_BASE = 1000

const cloneLoc = (loc?: BabelCore.types.SourceLocation | null) =>
  loc === undefined
    ? undefined
    : loc === null
      ? null
      : {
          start: { ...loc.start },
          end: { ...loc.end },
          filename: loc.filename,
          identifierName: loc.identifierName,
        }

function setNodeLoc<T extends { loc?: BabelCore.types.SourceLocation | null }>(
  node: T,
  loc?: BabelCore.types.SourceLocation | null,
): T {
  if (loc === undefined) return node
  node.loc = cloneLoc(loc) ?? null
  return node
}

function getTerminatorArgumentLoc(
  terminator: Terminator,
): BabelCore.types.SourceLocation | undefined {
  switch (terminator.kind) {
    case 'Return':
      return terminator.argument?.loc ?? undefined
    case 'Throw':
      return terminator.argument.loc ?? undefined
    default:
      return undefined
  }
}

/**
 * Region metadata for fine-grained DOM integration.
 * This is the HIR codegen equivalent of RegionMetadata from fine-grained-dom.ts.
 */
export interface RegionInfo {
  id: number
  dependencies: Set<string>
  declarations: Set<string>
  hasControlFlow: boolean
  hasReactiveWrites?: boolean
}

export interface RegionLoweringOps {
  applyRegionToContext: typeof applyRegionToContext
  applyRegionMetadataToExpression: typeof applyRegionMetadataToExpression
  buildDependencyGetter: typeof buildDependencyGetter
  getReactiveCallKind: typeof getReactiveCallKind
  lowerExpression: typeof lowerExpression
  propagateHookResultAlias: typeof propagateHookResultAlias
  resolveHookMemberValue: typeof resolveHookMemberValue
}

export function propagateHookResultAlias(
  targetBase: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  const mapSource = (source: string) => {
    const hookName = ctx.hookResultVarMap?.get(source)
    if (!hookName) return
    ctx.hookResultVarMap?.set(targetBase, hookName)
    const info = getHookReturnInfo(hookName, ctx)
    if (info?.directAccessor === 'signal') {
      ctx.signalVars?.add(targetBase)
      ctx.trackedVars.add(targetBase)
    } else if (info?.directAccessor === 'memo') {
      ctx.memoVars?.add(targetBase)
    }
  }

  if (value.kind === 'Identifier') {
    mapSource(deSSAVarName(value.name))
    return
  }

  if (
    value.kind === 'CallExpression' &&
    value.callee.kind === 'Identifier' &&
    value.callee.name === '__fictPropsRest'
  ) {
    const firstArg = value.arguments[0]
    if (firstArg && firstArg.kind === 'Identifier') {
      mapSource(deSSAVarName(firstArg.name))
    }
  }

  if (value.kind === 'SequenceExpression' && value.expressions.length > 0) {
    const last = value.expressions[value.expressions.length - 1]
    if (
      last &&
      last.kind === 'CallExpression' &&
      last.callee.kind === 'Identifier' &&
      last.callee.name === '__fictPropsRest'
    ) {
      const firstArg = last.arguments[0]
      if (firstArg && firstArg.kind === 'Identifier') {
        mapSource(deSSAVarName(firstArg.name))
      }
    }
  }
}

/**
 * Apply region metadata to the codegen context.
 * This is the HIR codegen equivalent of applyRegionMetadata from fine-grained-dom.ts.
 * It sets up the context to use region information for DOM binding decisions.
 *
 * @param ctx - The codegen context
 * @param region - The region info to apply
 * @returns The previous region (for restoration)
 */
export function applyRegionToContext(
  ctx: CodegenContext,
  region: RegionInfo | null,
): RegionInfo | undefined {
  const prevRegion = ctx.currentRegion
  ctx.currentRegion = region ?? undefined

  return prevRegion
}

function createRegionLoweringOps(): RegionLoweringOps {
  return {
    applyRegionToContext,
    applyRegionMetadataToExpression,
    buildDependencyGetter,
    getReactiveCallKind,
    lowerExpression,
    propagateHookResultAlias,
    resolveHookMemberValue,
  }
}

function createHIRChildBindingOps(): HIRChildBindingOps {
  const listOps = createListChildOps()
  return {
    emitConditionalChild: (startMarkerId, endMarkerId, expr, statements, ctx) =>
      emitConditionalChild(startMarkerId, endMarkerId, expr, statements, ctx, {
        buildListCallExpression: (candidate, childStatements, childCtx) =>
          buildListCallExpression(candidate, childStatements, childCtx, listOps),
        genTemp,
        lowerDomExpression,
      }),
    emitListChild: (startMarkerId, endMarkerId, expr, statements, ctx) =>
      emitListChild(startMarkerId, endMarkerId, expr, statements, ctx, listOps),
    genTemp,
    lowerDomExpression,
    lowerExpression,
    lowerJSXElement: (expr, ctx) => lowerJSXElement(expr as JSXElementExpression, ctx),
  }
}

function createListChildOps(): ListChildOps {
  return {
    applyRegionMetadataToExpression,
    genTemp,
    lowerDomExpression,
    lowerExpression,
  }
}

function createResumableEventBindingOps(): ResumableEventBindingOps {
  return {
    lowerDomExpression,
  }
}

function reserveHookSlot(ctx: CodegenContext): number {
  if (ctx.dynamicHookSlotDepth && ctx.dynamicHookSlotDepth > 0) {
    return -1
  }
  const slot = ctx.nextHookSlot ?? HOOK_SLOT_BASE
  ctx.nextHookSlot = slot + 1
  return slot
}

function withNoMemoAndDynamicHooks<T>(ctx: CodegenContext, fn: () => T): T {
  const prevNoMemo = ctx.noMemo
  const prevDynamic = ctx.dynamicHookSlotDepth ?? 0
  ctx.noMemo = true
  ctx.dynamicHookSlotDepth = prevDynamic + 1
  try {
    return fn()
  } finally {
    ctx.noMemo = prevNoMemo
    ctx.dynamicHookSlotDepth = prevDynamic
  }
}

/**
 * Codegen context for tracking state during code generation
 */
export interface CodegenContext {
  t: typeof BabelCore.types
  /** Compiler options (for feature toggles like lazyConditional). */
  options?: FictCompilerOptions
  /** Module-level declared names for helper shadowing checks. */
  moduleDeclaredNames?: Set<string>
  /** Module-level runtime helper imports (e.g., from 'fict'). */
  moduleRuntimeNames?: Set<string>
  /** Module-level runtime import map (local name -> imported name). */
  moduleRuntimeImportMap?: Map<string, string>
  /** Module-level runtime namespace/default imports (local name). */
  moduleRuntimeNamespaceImports?: Set<string>
  /** Macro aliases for $state (compiler macro). */
  stateMacroNames?: Set<string>
  /** Local (function-scope) declared names for helper shadowing checks. */
  localDeclaredNames?: Set<string>
  /** Tracks which runtime helpers are used */
  helpersUsed: Set<string>
  /** Counter for generating unique identifiers */
  tempCounter: number
  /** Set of tracked/reactive variable names (de-versioned) */
  trackedVars: Set<string>
  /** Identifiers shadowed in the current lowering scope (params/locals) */
  shadowedNames?: Set<string>
  /** Reactive scope analysis results */
  scopes?: ReactiveScopeResult | undefined
  /** Whether a context object (__fictCtx) is needed */
  needsCtx?: boolean
  /** Whether local for-of helper is needed */
  needsForOfHelper?: boolean
  /** Whether local for-in helper is needed */
  needsForInHelper?: boolean
  /** Control-flow dependencies per instruction (from CFG analysis) */
  controlDepsByInstr?: Map<Instruction, Set<string>>
  /** Current region info for fine-grained DOM optimization */
  currentRegion?: RegionInfo
  /** All regions for the current function */
  regions?: RegionInfo[]
  /** Alias variables that point to tracked signals (for reassignment guards) */
  aliasVars?: Set<string>
  /** Tracked bindings that exist outside the current lowering scope (e.g., captured signals) */
  externalTracked?: Set<string>
  /** Variables initialized with $store (need path-level reactivity, no getter transformation) */
  storeVars?: Set<string>
  /** Namespace import metadata for reactive exports (used for obj.signal access) */
  importedNamespaces?: Map<string, ModuleReactiveMetadata>
  /** Variables initialized with $state (signal accessors) */
  signalVars?: Set<string>
  /** Variables assigned to function expressions (should not be treated as reactive accessors) */
  functionVars?: Set<string>
  /** Variables that are memos (derived values) - these shouldn't be cached by getter cache */
  memoVars?: Set<string>
  /** Memo call names (including aliases) that return accessors */
  memoMacroNames?: Set<string>
  /** Variables that are assigned after declaration (need mutable binding) */
  mutatedVars?: Set<string>
  /** Whether we are emitting statements inside a region memo */
  inRegionMemo?: boolean
  /** Whether we are lowering a list item render callback */
  inListRender?: boolean
  /** Whether we are lowering top-level module statements */
  inModule?: boolean
  /** Next explicit slot index for nested memo hooks */
  nextHookSlot?: number
  /** Disable numbered hook slots within dynamic iteration contexts */
  dynamicHookSlotDepth?: number
  /**
   * Rule L: Getter cache for sync blocks.
   * Maps getter expression keys to their cached variable names.
   * When enabled, repeated reads of the same getter within a sync function
   * will use a cached value instead of calling the getter multiple times.
   */
  getterCache?: Map<string, string>
  /** Pending cache declarations to insert at the start of a function body */
  getterCacheDeclarations?: Map<string, BabelCore.types.Expression>
  /** Whether getter caching is enabled for the current scope */
  getterCacheEnabled?: boolean
  /** Disable memoization for the current function (\"use no memo\" directive) */
  noMemo?: boolean
  /** Current expression recursion depth for stack overflow protection */
  expressionDepth?: number
  /** Maximum allowed expression depth (default: 500) */
  maxExpressionDepth?: number
  /** Track non-reactive nested scopes (event handlers, effects) */
  nonReactiveScopeDepth?: number
  /** Current assignment target name (for devtools metadata) */
  currentAssignmentName?: string
  /** Depth counter for conditional child lowering (disable memo caching) */
  inConditional?: number
  /** Whether we are lowering JSX props (enables prop getter wrapping) */
  inPropsContext?: boolean
  /** Name of the props parameter for component lowering */
  propsParamName?: string
  /** Pending prop accessor declarations synthesized for props reads */
  propAccessorDecls?: Map<string, BabelCore.types.Statement>
  /** Whether tracked expressions should be wrapped in runtime effects */
  wrapTrackedExpressions?: boolean
  /** Whether the current function is treated as a hook (preserve accessor returns) */
  currentFnIsHook?: boolean
  /** Whether the current function is a component (PascalCase) */
  isComponentFn?: boolean
  /** Whether we are lowering a return statement (for hook return preservation) */
  inReturn?: boolean
  /** Cache of hook return accessor metadata keyed by hook name */
  hookReturnInfo?: Map<string, HookReturnInfo>
  /** Map of local variables bound to hook results (per function) */
  hookResultVarMap?: Map<string, string>
  /** Program functions keyed by name for hook metadata lookup */
  programFunctions?: Map<string, HIRFunction>
  /** Cache of hoisted template identifiers keyed by HTML string */
  hoistedTemplates?: Map<string, BabelCore.types.Identifier>
  /** Hoisted template declarations to insert at function/component scope */
  hoistedTemplateStatements?: BabelCore.types.Statement[]
  /** Hoisted resumable handler/export statements */
  hoistedResumableStatements?: BabelCore.types.Statement[]
  /** Resumable handler counter */
  resumableHandlerCounter?: number
  /** Resumable component counter */
  resumableComponentCounter?: number
  /** Resumable component metadata */
  resumableComponents?: Map<string, { resumeExport: string; typeKey: string }>
  /** Whether resumable output is enabled */
  resumableEnabled?: boolean
  /** Whether auto-extraction of handlers is enabled */
  autoExtractEnabled?: boolean
  /** Minimum AST node count for auto-extraction */
  autoExtractThreshold?: number
  /** Set of delegated events used (for hoisting delegateEvents call) */
  delegatedEventsUsed?: Set<string>
  /** Component-scoped function definitions (variable name -> HIR expression) for handler dependency hoisting */
  componentFunctionDefs?: Map<string, Expression>
  /** Hoisted function dependency counter for unique naming */
  hoistedFunctionDepCounter?: number
  /** Map of hoisted function dep names (original name -> hoisted module-level name) */
  hoistedFunctionDepNames?: Map<string, string>
  /** Parameter name for the list key constant (e.g., "__key") when in list render */
  listKeyParamName?: string
  /** The key expression HIR (e.g., row.id) for comparison when replacing with __key */
  listKeyExpr?: Expression
  /** The item parameter name in list render (e.g., "row") for key expression matching */
  listItemParamName?: string
  /** Current namespace context for SVG/MathML element creation */
  namespaceContext?: NamespaceContext
  /** Injected lowering operations used by regions.ts to avoid runtime import cycles */
  regionLoweringOps?: RegionLoweringOps
  /** Dedupe set for control-flow re-execution diagnostics */
  controlFlowReexecWarnings?: Set<string>
}

/**
 * Creates a fresh codegen context
 */
export function createCodegenContext(t: typeof BabelCore.types): CodegenContext {
  return {
    t,
    moduleDeclaredNames: new Set(),
    moduleRuntimeNames: new Set(),
    moduleRuntimeImportMap: new Map(),
    moduleRuntimeNamespaceImports: new Set(),
    stateMacroNames: new Set(),
    localDeclaredNames: new Set(),
    helpersUsed: new Set(),
    tempCounter: 0,
    trackedVars: new Set(),
    shadowedNames: new Set(),
    needsForOfHelper: false,
    needsForInHelper: false,
    controlDepsByInstr: new Map(),
    aliasVars: new Set(),
    externalTracked: new Set(),
    storeVars: new Set(),
    importedNamespaces: new Map(),
    signalVars: new Set(),
    functionVars: new Set(),
    memoVars: new Set(),
    memoMacroNames: new Set(['$memo', 'createMemo']),
    mutatedVars: new Set(),
    inRegionMemo: false,
    inListRender: false,
    inModule: false,
    nextHookSlot: HOOK_SLOT_BASE,
    nonReactiveScopeDepth: 0,
    inConditional: 0,
    wrapTrackedExpressions: true,
    getterCache: new Map(),
    getterCacheDeclarations: new Map(),
    getterCacheEnabled: false,
    inPropsContext: false,
    propsParamName: undefined,
    propAccessorDecls: new Map(),
    hookReturnInfo: new Map(),
    hoistedTemplates: new Map(),
    hoistedTemplateStatements: [],
    hoistedResumableStatements: [],
    resumableHandlerCounter: 0,
    resumableComponentCounter: 0,
    resumableComponents: new Map(),
    resumableEnabled: false,
    autoExtractEnabled: false,
    autoExtractThreshold: 3,
    delegatedEventsUsed: new Set(),
    componentFunctionDefs: new Map(),
    hoistedFunctionDepCounter: 0,
    hoistedFunctionDepNames: new Map(),
    regionLoweringOps: createRegionLoweringOps(),
    controlFlowReexecWarnings: new Set(),
  }
}

const hookReturnInfoAnalysisOps: HookReturnInfoAnalysisOps = {
  createCodegenContext,
  detectDerivedCycles,
  flattenRegions,
}

function analyzeHookReturnInfo(fn: HIRFunction, ctx: CodegenContext): HookReturnInfo | null {
  return analyzeHookReturnInfoWithOps(fn, ctx, hookReturnInfoAnalysisOps)
}

function getHookReturnInfo(name: string, ctx: CodegenContext): HookReturnInfo | null {
  return getHookReturnInfoWithOps(name, ctx, hookReturnInfoAnalysisOps)
}

export function resolveHookMemberValue(
  expr: Expression,
  ctx: CodegenContext,
): { member: BabelCore.types.MemberExpression; kind: HookAccessorKind } | null {
  if (expr.kind !== 'MemberExpression') return null
  if (expr.object.kind !== 'Identifier') return null
  const hookName = ctx.hookResultVarMap?.get(deSSAVarName(expr.object.name))
  if (!hookName) return null
  const info = getHookReturnInfo(hookName, ctx)
  const propName = getStaticPropName(expr.property as Expression, expr.computed)
  let kind: HookAccessorKind | undefined =
    typeof propName === 'string'
      ? info?.objectProps?.get(propName)
      : typeof propName === 'number'
        ? info?.arrayProps?.get(propName)
        : undefined
  if (!info && propName !== null) {
    kind = 'signal'
  }
  if (!kind) return null

  const obj = ctx.t.identifier(deSSAVarName(expr.object.name))
  const prop = expr.computed
    ? lowerExpression(expr.property as Expression, ctx)
    : ctx.t.identifier(String(propName))
  const member = ctx.t.memberExpression(obj, prop, expr.computed, expr.optional)
  return { member, kind }
}

function resolveNamespaceHookCallInfo(
  expr: Expression,
  ctx: CodegenContext,
): { hookName: string; info: HookReturnInfo } | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  const callee = expr.callee
  if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') return null
  if (callee.object.kind !== 'Identifier') return null

  const namespaceName = deSSAVarName(callee.object.name)
  const nsMeta = ctx.importedNamespaces?.get(namespaceName)
  if (!nsMeta?.hooks) return null

  const propName = getStaticPropName(callee.property as Expression, callee.computed)
  if (typeof propName !== 'string') return null

  const serialized = nsMeta.hooks[propName]
  if (!serialized) return null

  const hookName = `${namespaceName}.${propName}`
  const info = deserializeHookReturnInfo(serialized)
  ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
  ctx.hookReturnInfo.set(hookName, info)
  return { hookName, info }
}

function withNonReactiveScope<T>(ctx: CodegenContext, fn: () => T): T {
  const prevDepth = ctx.nonReactiveScopeDepth ?? 0
  ctx.nonReactiveScopeDepth = prevDepth + 1
  try {
    return fn()
  } finally {
    ctx.nonReactiveScopeDepth = prevDepth
  }
}

/**
 * Generate a unique temporary identifier
 */
function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return ctx.t.identifier(`__${prefix}_${ctx.tempCounter++}`)
}

/**
 * Minimal lowering from HIR back to Babel AST.
 * - Emits a single function declaration per HIR function.
 * - Linearizes blocks in order and reconstructs statements best-effort.
 * - Unsupported instructions become empty statements.
 * - Placeholder for region→fine-grained DOM mapping (not implemented yet).
 * Primarily used for tests that snapshot intermediate lowering.
 */
export function lowerHIRToBabel(
  program: HIRProgram,
  t: typeof BabelCore.types,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  const body: BabelCore.types.Statement[] = []
  const emittedFunctionNames = new Set<string>()
  for (const fn of program.functions) {
    const funcStmt = lowerFunction(fn, ctx)
    if (funcStmt) {
      body.push(funcStmt)
      if (fn.name) emittedFunctionNames.add(fn.name)
    }
  }
  const filteredBody = body.filter(stmt => {
    if (t.isVariableDeclaration(stmt)) {
      return !stmt.declarations.some(
        decl => t.isIdentifier(decl.id) && emittedFunctionNames.has(decl.id.name),
      )
    }
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      if (
        t.isVariableDeclaration(stmt.declaration) &&
        stmt.declaration.declarations.some(
          decl => t.isIdentifier(decl.id) && emittedFunctionNames.has(decl.id.name),
        )
      ) {
        return false
      }
    }
    return true
  })

  return t.file(t.program(attachHelperImports(ctx, filteredBody, t)))
}

function buildOutputParams(
  fn: HIRFunction,
  t: typeof BabelCore.types,
): BabelCore.types.FunctionParameter[] {
  if (fn.rawParams && fn.rawParams.length > 0) {
    return fn.rawParams.map(param => t.cloneNode(param, true) as BabelCore.types.FunctionParameter)
  }
  return fn.params.map(p => t.identifier(deSSAVarName(p.name)))
}

function lowerFunction(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const scopedTracked = new Set(ctx.trackedVars)
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  ctx.needsCtx = false
  const params = buildOutputParams(fn, t)
  const statements: BabelCore.types.Statement[] = []

  // For now, just emit instructions in block order, ignoring control flow structure.
  for (const block of fn.blocks) {
    statements.push(
      ...(block.instructions
        .map(instr => lowerInstruction(instr, ctx))
        .filter(Boolean) as BabelCore.types.Statement[]),
    )
    statements.push(...lowerTerminator(block, ctx))
  }

  if (ctx.needsCtx) {
    ctx.helpersUsed.add('useContext')
    statements.unshift(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__fictCtx'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
        ),
      ]),
    )
  }

  const result = setNodeLoc(
    t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements)),
    fn.loc,
  )
  result.async = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  result.generator = !!fn.meta?.isGenerator || functionHasYield(fn)
  ctx.trackedVars = prevTracked
  return result
}

function lowerTrackedExpression(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  const regionOverride =
    ctx.inReturn && ctx.currentFnIsHook
      ? null
      : (ctx.currentRegion ??
        (ctx.trackedVars.size
          ? {
              id: -1,
              dependencies: new Set(ctx.trackedVars),
              declarations: new Set<string>(),
              hasControlFlow: false,
              hasReactiveWrites: false,
            }
          : null))
  const lowered = lowerExpression(expr, ctx, valueUsed)
  if (ctx.t.isAssignmentExpression(lowered)) {
    const right = applyRegionMetadataToExpression(lowered.right, ctx, regionOverride ?? undefined)
    return ctx.t.assignmentExpression(lowered.operator, lowered.left, right)
  }
  if (ctx.t.isUpdateExpression(lowered)) {
    const arg = applyRegionMetadataToExpression(
      lowered.argument as BabelCore.types.Expression,
      ctx,
      regionOverride ?? undefined,
    )
    return ctx.t.updateExpression(
      lowered.operator,
      arg as BabelCore.types.Expression,
      lowered.prefix,
    )
  }
  return applyRegionMetadataToExpression(lowered, ctx, regionOverride ?? undefined)
}

function lowerInstruction(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  const applyLoc = <T extends BabelCore.types.Statement | null>(stmt: T): T => {
    if (!stmt) return stmt
    const baseLoc =
      instr.loc ??
      (instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value.loc : undefined)
    return setNodeLoc(stmt, baseLoc) as T
  }
  if (instr.kind === 'Assign') {
    const baseName = deSSAVarName(instr.target.name)

    const isFunctionDecl =
      instr.value.kind === 'FunctionExpression' &&
      (instr.declarationKind === 'function' ||
        (!instr.declarationKind && instr.value.name === baseName))
    if (isFunctionDecl) {
      const loweredFn = lowerExpression(instr.value, ctx)
      if (t.isFunctionExpression(loweredFn)) {
        return applyLoc(
          t.functionDeclaration(
            t.identifier(baseName),
            loweredFn.params as BabelCore.types.Identifier[],
            loweredFn.body as BabelCore.types.BlockStatement,
            loweredFn.generator ?? false,
            loweredFn.async ?? false,
          ),
        )
      }
    }

    const declKind = instr.declarationKind === 'function' ? undefined : instr.declarationKind
    propagateHookResultAlias(baseName, instr.value, ctx)
    const hookMember = resolveHookMemberValue(instr.value, ctx)
    if (hookMember) {
      if (hookMember.kind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (hookMember.kind === 'memo') {
        ctx.memoVars?.add(baseName)
      }
      if (declKind) {
        return applyLoc(
          t.variableDeclaration(declKind, [
            t.variableDeclarator(t.identifier(baseName), hookMember.member),
          ]),
        )
      }
      return applyLoc(
        t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), hookMember.member),
        ),
      )
    }
    if (
      instr.value.kind === 'CallExpression' &&
      instr.value.callee.kind === 'Identifier' &&
      isHookName(instr.value.callee.name)
    ) {
      ctx.hookResultVarMap?.set(baseName, instr.value.callee.name)
      const retInfo = getHookReturnInfo(instr.value.callee.name, ctx)
      if (retInfo?.directAccessor === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (retInfo?.directAccessor === 'memo') {
        ctx.memoVars?.add(baseName)
      }
    }
    const namespaceHookCall = resolveNamespaceHookCallInfo(instr.value, ctx)
    if (namespaceHookCall) {
      ctx.hookResultVarMap?.set(baseName, namespaceHookCall.hookName)
      if (namespaceHookCall.info.directAccessor === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (namespaceHookCall.info.directAccessor === 'memo') {
        ctx.memoVars?.add(baseName)
      }
    }
    if (declKind) {
      const initKind = getReactiveCallKind(instr.value, ctx)
      if (initKind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
        ctx.currentAssignmentName = baseName
        const loweredValue = (() => {
          try {
            return lowerTrackedExpression(instr.value, ctx)
          } finally {
            ctx.currentAssignmentName = undefined
          }
        })()
        return applyLoc(
          t.variableDeclaration(declKind, [
            t.variableDeclarator(t.identifier(baseName), loweredValue),
          ]),
        )
      }
    }
    if (ctx.signalVars?.has(baseName)) {
      ctx.currentAssignmentName = baseName
      const loweredValue = (() => {
        try {
          return lowerTrackedExpression(instr.value, ctx)
        } finally {
          ctx.currentAssignmentName = undefined
        }
      })()
      return applyLoc(
        t.expressionStatement(t.callExpression(t.identifier(baseName), [loweredValue])),
      )
    }
    ctx.currentAssignmentName = baseName
    const loweredAssign = (() => {
      try {
        return lowerTrackedExpression(instr.value, ctx)
      } finally {
        ctx.currentAssignmentName = undefined
      }
    })()
    return applyLoc(
      t.expressionStatement(t.assignmentExpression('=', t.identifier(baseName), loweredAssign)),
    )
  }
  if (instr.kind === 'Expression') {
    return applyLoc(t.expressionStatement(lowerTrackedExpression(instr.value, ctx, false)))
  }
  if (instr.kind === 'Phi') {
    // Phi nodes are typically eliminated in SSA-out pass; emit comment for debugging
    return null
  }
  return null
}

function lowerTerminator(block: BasicBlock, ctx: CodegenContext): BabelCore.types.Statement[] {
  const { t } = ctx
  const baseLoc = block.terminator.loc ?? getTerminatorArgumentLoc(block.terminator)
  const applyLoc = (stmts: BabelCore.types.Statement[]): BabelCore.types.Statement[] =>
    stmts.map(stmt => setNodeLoc(stmt, baseLoc))
  switch (block.terminator.kind) {
    case 'Return': {
      const preserveAccessors = ctx.currentFnIsHook
      const prevHookFlag = ctx.currentFnIsHook
      if (preserveAccessors) ctx.currentFnIsHook = false
      ctx.inReturn = true
      let retExpr = block.terminator.argument
        ? lowerTrackedExpression(block.terminator.argument, ctx)
        : null
      ctx.inReturn = false
      if (preserveAccessors) {
        ctx.currentFnIsHook = prevHookFlag
      }
      if (preserveAccessors && retExpr) {
        retExpr = unwrapAccessorCalls(retExpr, ctx)
      }
      return applyLoc([t.returnStatement(retExpr)])
    }
    case 'Throw':
      return applyLoc([t.throwStatement(lowerTrackedExpression(block.terminator.argument, ctx))])
    case 'Jump':
      return applyLoc([t.expressionStatement(t.stringLiteral(`jump ${block.terminator.target}`))])
    case 'Branch':
      return applyLoc([
        t.ifStatement(
          lowerTrackedExpression(block.terminator.test, ctx),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.consequent}`)),
          ]),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.alternate}`)),
          ]),
        ),
      ])
    case 'Switch':
      return applyLoc([
        t.switchStatement(
          lowerTrackedExpression(block.terminator.discriminant, ctx),
          block.terminator.cases.map(({ test, target }) =>
            t.switchCase(test ? lowerTrackedExpression(test, ctx) : null, [
              t.expressionStatement(t.stringLiteral(`goto ${target}`)),
            ]),
          ),
        ),
      ])
    case 'ForOf': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return applyLoc([
        t.forOfStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.iterable, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ])
    }
    case 'ForIn': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return applyLoc([
        t.forInStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.object, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ])
    }
    case 'Try': {
      const term = block.terminator
      const tryBlock = t.blockStatement([
        t.expressionStatement(t.stringLiteral(`try ${term.tryBlock}`)),
      ])
      const catchClause =
        term.catchBlock !== undefined
          ? t.catchClause(
              term.catchParam ? t.identifier(term.catchParam) : null,
              t.blockStatement([
                t.expressionStatement(t.stringLiteral(`catch ${term.catchBlock}`)),
              ]),
            )
          : null
      const finallyBlock =
        term.finallyBlock !== undefined
          ? t.blockStatement([
              t.expressionStatement(t.stringLiteral(`finally ${term.finallyBlock}`)),
            ])
          : null
      return applyLoc([t.tryStatement(tryBlock, catchClause, finallyBlock)])
    }
    case 'Unreachable':
      return applyLoc([])
    case 'Break':
      return applyLoc([
        t.breakStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ])
    case 'Continue':
      return applyLoc([
        t.continueStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ])
    default:
      return applyLoc([])
  }
}

function collectLocalDeclaredNames(
  params: { name: string }[],
  blocks: BasicBlock[] | null | undefined,
  t: typeof BabelCore.types,
): Set<string> {
  const declared = new Set<string>()
  const addPatternNames = (pattern: BabelCore.types.LVal | BabelCore.types.PatternLike): void => {
    if (t.isIdentifier(pattern)) {
      declared.add(deSSAVarName(pattern.name))
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      addPatternNames(pattern.left as BabelCore.types.PatternLike)
      return
    }
    if (t.isRestElement(pattern)) {
      addPatternNames(pattern.argument as BabelCore.types.PatternLike)
      return
    }
    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          addPatternNames(prop.argument as BabelCore.types.PatternLike)
        } else if (t.isObjectProperty(prop)) {
          addPatternNames(prop.value as BabelCore.types.PatternLike)
        }
      }
      return
    }
    if (t.isArrayPattern(pattern)) {
      for (const el of pattern.elements) {
        if (!el) continue
        if (t.isPatternLike(el)) addPatternNames(el as BabelCore.types.PatternLike)
      }
    }
  }

  params.forEach(param => declared.add(deSSAVarName(param.name)))

  if (!blocks) return declared

  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const isFunctionDecl =
        instr.value.kind === 'FunctionExpression' &&
        !!instr.value.name &&
        deSSAVarName(instr.value.name) === target
      if (instr.declarationKind || isFunctionDecl) {
        declared.add(target)
      }
    }
    const term = block.terminator
    if (term.kind === 'ForOf' || term.kind === 'ForIn') {
      declared.add(deSSAVarName(term.variable))
      if (term.pattern) {
        addPatternNames(term.pattern as BabelCore.types.PatternLike)
      }
    } else if (term.kind === 'Try' && term.catchParam) {
      declared.add(deSSAVarName(term.catchParam))
    }
  }

  return declared
}

/**
 * Lower an HIR Expression to a Babel AST Expression.
 * All SSA-versioned variable names are automatically de-versioned to their original names.
 */
export function lowerExpression(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  // Check recursion depth to prevent stack overflow
  const depth = (ctx.expressionDepth ?? 0) + 1
  const maxDepth = ctx.maxExpressionDepth ?? 500
  if (depth > maxDepth) {
    throw new HIRError(
      `Expression too deeply nested (depth ${depth} exceeds maximum ${maxDepth}). ` +
        `This may indicate a malformed AST or excessively complex expression.`,
      'DEPTH_EXCEEDED',
    )
  }
  ctx.expressionDepth = depth

  try {
    return setNodeLoc(lowerExpressionImpl(expr, ctx, valueUsed), expr.loc)
  } finally {
    ctx.expressionDepth = depth - 1
  }
}

function lowerExpressionImpl(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  const { t } = ctx
  const mapParams = (params: { name: string }[]) =>
    params.map(p => t.identifier(deSSAVarName(p.name)))
  const lowerArgsAsExpressions = (args: Expression[]): BabelCore.types.Expression[] =>
    args.map(arg =>
      arg.kind === 'SpreadElement'
        ? lowerExpression(arg.argument as Expression, ctx)
        : lowerExpression(arg, ctx),
    )
  const lowerCallArguments = (
    args: Expression[],
    mapArg?: (arg: Expression, idx: number) => BabelCore.types.Expression,
  ): (BabelCore.types.Expression | BabelCore.types.SpreadElement)[] =>
    args.map((arg, idx) => {
      if (arg.kind === 'SpreadElement') {
        return t.spreadElement(lowerExpression(arg.argument as Expression, ctx))
      }
      return mapArg ? mapArg(arg, idx) : lowerExpression(arg, ctx)
    })
  const withFunctionScope = <T>(
    paramNames: Set<string>,
    fn: () => T,
    localDeclared?: Set<string>,
  ): T => {
    const prevTracked = ctx.trackedVars
    const prevAlias = ctx.aliasVars
    const prevExternal = ctx.externalTracked
    const prevShadowed = ctx.shadowedNames
    const prevLocalDeclared = ctx.localDeclaredNames
    const scoped = new Set(ctx.trackedVars)
    paramNames.forEach(n => scoped.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        scoped.delete(deSSAVarName(name))
      }
    }
    ctx.trackedVars = scoped
    ctx.aliasVars = new Set(ctx.aliasVars)
    ctx.externalTracked = new Set(prevTracked)
    const shadowed = new Set(prevShadowed ?? [])
    paramNames.forEach(n => shadowed.add(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        shadowed.add(deSSAVarName(name))
      }
    }
    ctx.shadowedNames = shadowed
    const localNames = new Set(prevLocalDeclared ?? [])
    if (localDeclared) {
      for (const name of localDeclared) {
        localNames.add(deSSAVarName(name))
      }
    }
    ctx.localDeclaredNames = localNames
    const result = fn()
    ctx.trackedVars = prevTracked
    ctx.aliasVars = prevAlias
    ctx.externalTracked = prevExternal
    ctx.shadowedNames = prevShadowed
    ctx.localDeclaredNames = prevLocalDeclared
    return result
  }
  const lowerTrackedWriteCall = (
    callee: BabelCore.types.Expression,
    nextValue: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    if (!valueUsed) {
      return t.callExpression(t.cloneNode(callee, true), [nextValue])
    }

    const nextId = genTemp(ctx, 'next')
    const nextRef = t.identifier(nextId.name)
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(nextId, true)],
        t.sequenceExpression([
          t.callExpression(t.cloneNode(callee, true), [nextRef]),
          t.identifier(nextId.name),
        ]),
      ),
      [nextValue],
    )
  }
  const buildTrackedAssignmentNext = (
    operator: string,
    current: BabelCore.types.Expression,
    right: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    switch (operator) {
      case '=':
        return right
      case '+=':
        return t.binaryExpression('+', current, right)
      case '-=':
        return t.binaryExpression('-', current, right)
      case '*=':
        return t.binaryExpression('*', current, right)
      case '/=':
        return t.binaryExpression('/', current, right)
      case '%=':
        return t.binaryExpression('%', current, right)
      case '**=':
        return t.binaryExpression('**', current, right)
      case '<<=':
        return t.binaryExpression('<<', current, right)
      case '>>=':
        return t.binaryExpression('>>', current, right)
      case '>>>=':
        return t.binaryExpression('>>>', current, right)
      case '|=':
        return t.binaryExpression('|', current, right)
      case '^=':
        return t.binaryExpression('^', current, right)
      case '&=':
        return t.binaryExpression('&', current, right)
      case '&&=':
        return t.logicalExpression('&&', current, right)
      case '||=':
        return t.logicalExpression('||', current, right)
      case '??=':
        return t.logicalExpression('??', current, right)
      default:
        return right
    }
  }
  const buildStaticSignalKeyTest = (
    keyRef: BabelCore.types.Identifier,
    keys: (string | number)[],
  ): BabelCore.types.Expression | null => {
    if (keys.length === 0) return null
    let test: BabelCore.types.Expression | null = null
    for (const key of keys) {
      const literal = typeof key === 'number' ? t.numericLiteral(key) : t.stringLiteral(String(key))
      const eq = t.binaryExpression('===', t.cloneNode(keyRef, true), literal)
      test = test ? t.logicalExpression('||', test, eq) : eq
    }
    return test
  }
  const lowerComputedHookSignalAssignment = (
    objectName: string,
    keyExpr: Expression,
    signalKeys: (string | number)[],
    operator: BabelCore.types.AssignmentExpression['operator'],
    rightExpr: Expression,
  ): BabelCore.types.Expression | null => {
    const keyTestKeys = signalKeys.filter(
      key => (typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string',
    )
    if (keyTestKeys.length === 0) return null

    const keyId = genTemp(ctx, 'key')
    const keyRef = t.identifier(keyId.name)
    const memberForAccessor = t.memberExpression(
      t.identifier(objectName),
      t.identifier(keyId.name),
      true,
    )
    const current = t.callExpression(t.cloneNode(memberForAccessor, true), [])
    const right = lowerExpression(rightExpr, ctx)
    const signalWrite = lowerTrackedWriteCall(
      memberForAccessor,
      buildTrackedAssignmentNext(operator, current, t.cloneNode(right, true)),
    )
    const fallback = t.assignmentExpression(
      operator,
      t.memberExpression(t.identifier(objectName), t.identifier(keyId.name), true),
      right,
    )
    const keyTest = buildStaticSignalKeyTest(keyRef, keyTestKeys)
    if (!keyTest) return null
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(keyId, true)],
        t.conditionalExpression(keyTest, signalWrite, fallback),
      ),
      [lowerExpression(keyExpr, ctx)],
    )
  }
  const lowerComputedHookSignalUpdate = (
    objectName: string,
    keyExpr: Expression,
    signalKeys: (string | number)[],
    operator: '++' | '--',
    prefix: boolean,
  ): BabelCore.types.Expression | null => {
    const keyTestKeys = signalKeys.filter(
      key => (typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string',
    )
    if (keyTestKeys.length === 0) return null

    const keyId = genTemp(ctx, 'key')
    const keyRef = t.identifier(keyId.name)
    const signalUpdate = lowerTrackedUpdateCall(
      t.memberExpression(t.identifier(objectName), t.identifier(keyId.name), true),
      operator,
      prefix,
    )
    const fallback = t.updateExpression(
      operator,
      t.memberExpression(t.identifier(objectName), t.identifier(keyId.name), true),
      prefix,
    )
    const keyTest = buildStaticSignalKeyTest(keyRef, keyTestKeys)
    if (!keyTest) return null
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(keyId, true)],
        t.conditionalExpression(keyTest, signalUpdate, fallback),
      ),
      [lowerExpression(keyExpr, ctx)],
    )
  }
  const lowerTrackedUpdateCall = (
    callee: BabelCore.types.Expression,
    operator: '++' | '--',
    prefix: boolean,
  ): BabelCore.types.Expression => {
    const op = operator === '++' ? '+' : '-'
    const current = t.callExpression(t.cloneNode(callee, true), [])
    const prevId = genTemp(ctx, 'prev')
    const buildDelta = (valueExpr: BabelCore.types.Expression): BabelCore.types.Expression =>
      t.conditionalExpression(
        t.binaryExpression(
          '===',
          t.unaryExpression('typeof', valueExpr),
          t.stringLiteral('bigint'),
        ),
        t.bigIntLiteral('1'),
        t.numericLiteral(1),
      )
    const buildNext = (valueExpr: BabelCore.types.Expression): BabelCore.types.BinaryExpression =>
      t.binaryExpression(op, valueExpr, buildDelta(valueExpr))
    if (!valueUsed) {
      return t.callExpression(
        t.arrowFunctionExpression(
          [t.cloneNode(prevId, true)],
          t.callExpression(t.cloneNode(callee, true), [buildNext(t.identifier(prevId.name))]),
        ),
        [current],
      )
    }

    const prevForSet = t.identifier(prevId.name)
    const prevForResult = t.identifier(prevId.name)
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(prevId, true)],
        t.sequenceExpression([
          t.callExpression(t.cloneNode(callee, true), [buildNext(prevForSet)]),
          prefix ? buildNext(prevForResult) : prevForResult,
        ]),
      ),
      [current],
    )
  }
  const lowerBlocksToStatements = (blocks: BasicBlock[]): BabelCore.types.Statement[] => {
    const stmts: BabelCore.types.Statement[] = []
    for (const block of blocks) {
      stmts.push(
        ...(block.instructions
          .map(instr => lowerInstruction(instr, ctx))
          .filter(Boolean) as BabelCore.types.Statement[]),
      )
      stmts.push(...lowerTerminator(block, ctx))
    }
    return stmts
  }
  const lowerStructuredBlocks = (
    blocks: BasicBlock[],
    params: { name: string }[],
    paramIds: BabelCore.types.FunctionParameter[],
  ): BabelCore.types.Statement[] => {
    try {
      const fn: HIRFunction = {
        params: params.map(p => ({ kind: 'Identifier', name: p.name })),
        blocks,
        meta: { fromExpression: true },
      }
      const { node, diagnostics } = structurizeCFGWithDiagnostics(fn)
      const structured =
        node.kind === 'stateMachine'
          ? node
          : diagnostics.isComplete
            ? node
            : {
                kind: 'stateMachine' as const,
                blocks: fn.blocks.map(block => ({
                  blockId: block.id,
                  instructions: block.instructions,
                  terminator: block.terminator,
                })),
                entryBlock: fn.blocks[0]?.id ?? 0,
              }
      const declared = new Set<string>()
      for (const p of paramIds) {
        const ids = t.getBindingIdentifiers(p)
        for (const name of Object.keys(ids)) {
          declared.add(name)
        }
      }
      return lowerStructuredNodeWithoutRegions(structured, t, ctx, declared)
    } catch {
      return lowerBlocksToStatements(blocks)
    }
  }

  const lowerReactiveScopeExpression = (
    fnExpr: Extract<Expression, { kind: 'ArrowFunction' | 'FunctionExpression' }>,
  ): BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression | null => {
    if (!fnExpr.reactiveScope) return null
    const blocks = Array.isArray(fnExpr.body)
      ? (fnExpr.body as BasicBlock[])
      : ([
          {
            id: 0,
            instructions: [],
            terminator: {
              kind: 'Return',
              argument: fnExpr.body as Expression,
            },
          },
        ] as BasicBlock[])

    const fn: HIRFunction = {
      params: fnExpr.params,
      rawParams: fnExpr.rawParams,
      blocks,
      meta: {
        fromExpression: true,
        isArrow: fnExpr.kind === 'ArrowFunction',
        hasExpressionBody: fnExpr.kind === 'ArrowFunction' && fnExpr.isExpression,
        isAsync: fnExpr.isAsync ?? false,
        isGenerator: fnExpr.kind === 'FunctionExpression' ? !!fnExpr.isGenerator : false,
        noMemo: fnExpr.noMemo ?? false,
        pure: fnExpr.pure ?? false,
      },
      loc: fnExpr.loc ?? null,
    }

    const lowered = lowerFunctionWithRegions(fn, ctx, { forceHookContext: true })
    if (!lowered) return null

    const params = lowered.params
    if (fnExpr.kind === 'ArrowFunction') {
      const arrow = t.arrowFunctionExpression(params, lowered.body)
      arrow.async = lowered.async
      return arrow
    }

    const fnExprAst = t.functionExpression(
      fnExpr.name ? t.identifier(deSSAVarName(fnExpr.name)) : null,
      params,
      lowered.body,
    )
    fnExprAst.async = lowered.async
    fnExprAst.generator = lowered.generator ?? fnExpr.isGenerator ?? false
    return fnExprAst
  }

  switch (expr.kind) {
    case 'Identifier':
      // Apply SSA de-versioning to restore original variable names
      return t.identifier(deSSAVarName(expr.name))

    case 'Literal':
      if (expr.value === null) return t.nullLiteral()
      if (expr.value === undefined) return t.identifier('undefined')
      if (typeof expr.value === 'string') return t.stringLiteral(expr.value)
      if (typeof expr.value === 'number') return t.numericLiteral(expr.value)
      if (typeof expr.value === 'boolean') return t.booleanLiteral(expr.value)
      if (typeof expr.value === 'bigint') return t.bigIntLiteral(expr.value.toString())
      if (expr.value instanceof RegExp) {
        return t.regExpLiteral(expr.value.source, expr.value.flags)
      }
      return t.identifier('undefined')

    case 'ImportExpression':
      return t.importExpression(lowerExpression(expr.source, ctx) as BabelCore.types.Expression)

    case 'MetaProperty':
      return t.metaProperty(t.identifier(expr.meta.name), t.identifier(expr.property.name))

    case 'CallExpression': {
      // Handle Fict macros in HIR path
      const stateCalleeNameRaw = expr.callee.kind === 'Identifier' ? expr.callee.name : null
      const stateCalleeName = stateCalleeNameRaw ? deSSAVarName(stateCalleeNameRaw) : null
      if (stateCalleeName && ctx.stateMacroNames?.has(stateCalleeName)) {
        const args = lowerCallArguments(expr.arguments)
        const includeDevtools = ctx.options?.dev !== false
        const options: BabelCore.types.ObjectProperty[] = []
        // Always include name when available - needed for resumable mode slotMap and devtools
        if (ctx.currentAssignmentName) {
          options.push(
            t.objectProperty(t.identifier('name'), t.stringLiteral(ctx.currentAssignmentName)),
          )
        }
        if (includeDevtools && expr.loc) {
          const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
          options.push(t.objectProperty(t.identifier('devToolsSource'), t.stringLiteral(source)))
        }
        if (options.length > 0) {
          args.push(t.objectExpression(options))
        }

        if (ctx.inModule) {
          ctx.helpersUsed.add('signal')
          return t.callExpression(t.identifier(RUNTIME_ALIASES.signal), args)
        }
        ctx.helpersUsed.add('useSignal')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useSignal), [
          t.identifier('__fictCtx'),
          ...args,
        ])
      }
      if (expr.callee.kind === 'Identifier') {
        const memoCalleeName = deSSAVarName(expr.callee.name)
        if (ctx.memoMacroNames?.has(memoCalleeName)) {
          const args = lowerCallArguments(expr.arguments)
          const includeDevtools = ctx.options?.dev !== false
          if (includeDevtools && expr.arguments.length === 1) {
            const options: BabelCore.types.ObjectProperty[] = []
            if (ctx.currentAssignmentName) {
              options.push(
                t.objectProperty(t.identifier('name'), t.stringLiteral(ctx.currentAssignmentName)),
              )
            }
            if (expr.loc) {
              const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
              options.push(
                t.objectProperty(t.identifier('devToolsSource'), t.stringLiteral(source)),
              )
            }
            if (options.length > 0) {
              args.push(t.objectExpression(options))
            }
          }
          return t.callExpression(
            lowerExpression(expr.callee, ctx) as BabelCore.types.Expression,
            args,
          )
        }
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$effect') {
        const args = lowerCallArguments(expr.arguments, arg =>
          arg.kind === 'ArrowFunction' || arg.kind === 'FunctionExpression'
            ? withNonReactiveScope(ctx, () => lowerExpression(arg, ctx))
            : lowerExpression(arg, ctx),
        )
        const includeDevtools = ctx.options?.dev !== false
        if (includeDevtools && expr.loc) {
          const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
          const sourceProp = t.objectProperty(
            t.identifier('devToolsSource'),
            t.stringLiteral(source),
          )

          if (args.length === 1) {
            args.push(t.objectExpression([sourceProp]))
          } else if (args.length > 1 && t.isObjectExpression(args[1])) {
            const hasSourceProp = args[1].properties.some(
              prop =>
                t.isObjectProperty(prop) &&
                t.isIdentifier(prop.key) &&
                prop.key.name === 'devToolsSource',
            )
            if (!hasSourceProp) {
              args[1].properties.push(sourceProp)
            }
          }
        }
        if (ctx.inModule) {
          ctx.helpersUsed.add('effect')
          return t.callExpression(t.identifier(RUNTIME_ALIASES.effect), args)
        }
        ctx.helpersUsed.add('useEffect')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useEffect), [
          t.identifier('__fictCtx'),
          ...args,
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forOf') {
        ctx.needsForOfHelper = true
        const [iterable, cb] = lowerArgsAsExpressions(expr.arguments)
        return t.callExpression(t.identifier('__fictForOf'), [
          iterable ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forIn') {
        ctx.needsForInHelper = true
        const [obj, cb] = lowerArgsAsExpressions(expr.arguments)
        return t.callExpression(t.identifier('__fictForIn'), [
          obj ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__fictPropsRest') {
        ctx.helpersUsed.add('propsRest')
        const args = lowerCallArguments(expr.arguments)
        return t.callExpression(t.identifier(RUNTIME_ALIASES.propsRest), args)
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === 'mergeProps') {
        ctx.helpersUsed.add('mergeProps')
        const args = lowerCallArguments(expr.arguments)
        return t.callExpression(t.identifier(RUNTIME_ALIASES.mergeProps), args)
      }
      const isIIFE =
        (expr.callee.kind === 'ArrowFunction' || expr.callee.kind === 'FunctionExpression') &&
        expr.arguments.length === 0 &&
        expr.callee.params.length === 0
      const calleeName = expr.callee.kind === 'Identifier' ? deSSAVarName(expr.callee.name) : null
      const calleeIsMemoAccessor = !!calleeName && ctx.memoVars?.has(calleeName)
      const calleeIsSignalLike =
        !!calleeName && (ctx.signalVars?.has(calleeName) || ctx.storeVars?.has(calleeName))
      if (calleeIsMemoAccessor && !calleeIsSignalLike && expr.arguments.length > 0) {
        const loweredArgs = lowerCallArguments(expr.arguments)
        return t.callExpression(t.callExpression(t.identifier(calleeName), []), loweredArgs)
      }
      const lowerCallee = () =>
        isIIFE
          ? withNonReactiveScope(ctx, () => lowerExpression(expr.callee, ctx))
          : lowerExpression(expr.callee, ctx)
      const isIteratingMethod =
        expr.callee.kind === 'MemberExpression' &&
        ((expr.callee.property.kind === 'Identifier' &&
          ['map', 'reduce', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find'].includes(
            expr.callee.property.name,
          )) ||
          (expr.callee.property.kind === 'Literal' &&
            ['map', 'reduce', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find'].includes(
              String(expr.callee.property.value),
            )))
      const loweredArgs = lowerCallArguments(expr.arguments, (a, idx) => {
        if (
          idx === 0 &&
          isIteratingMethod &&
          (a.kind === 'ArrowFunction' || a.kind === 'FunctionExpression')
        ) {
          return withNoMemoAndDynamicHooks(ctx, () => lowerExpression(a, ctx))
        }
        return lowerExpression(a, ctx)
      })
      return t.callExpression(lowerCallee(), loweredArgs)
    }

    case 'MemberExpression':
      // Key constification: replace row().id with __key when it matches the key expression
      if (matchesListKeyPattern(expr, ctx)) {
        return t.identifier(ctx.listKeyParamName!)
      }
      if (expr.object.kind === 'Identifier') {
        const nsMeta = ctx.importedNamespaces?.get(deSSAVarName(expr.object.name))
        if (nsMeta) {
          const propName = getStaticPropName(expr.property as Expression, expr.computed)
          if (typeof propName === 'string') {
            const kind = nsMeta.exports[propName]
            if (kind === 'signal' || kind === 'memo') {
              const member = t.memberExpression(
                t.identifier(deSSAVarName(expr.object.name)),
                expr.computed ? t.stringLiteral(propName) : t.identifier(propName),
                expr.computed,
                expr.optional,
              )
              return t.callExpression(member, [])
            }
          }
        }
      }
      if (
        expr.object.kind === 'Identifier' &&
        ctx.hookResultVarMap?.has(deSSAVarName(expr.object.name))
      ) {
        const hookName = ctx.hookResultVarMap.get(deSSAVarName(expr.object.name))!
        const info = getHookReturnInfo(hookName, ctx)
        const propName = getStaticPropName(expr.property as Expression, expr.computed)
        let accessorKind: HookAccessorKind | undefined
        if (typeof propName === 'string') {
          accessorKind = info?.objectProps?.get(propName)
        } else if (typeof propName === 'number') {
          accessorKind = info?.arrayProps?.get(propName)
        }
        const shouldTreatAccessor = accessorKind || (!info && propName !== null)
        if (shouldTreatAccessor) {
          const member = t.memberExpression(
            t.identifier(deSSAVarName(expr.object.name)),
            expr.computed ? lowerExpression(expr.property, ctx) : t.identifier(String(propName)),
            expr.computed,
            expr.optional,
          )
          return t.callExpression(member, [])
        }
      }
      return t.memberExpression(
        lowerExpression(expr.object, ctx),
        expr.computed
          ? lowerExpression(expr.property, ctx)
          : expr.property.kind === 'Identifier'
            ? t.identifier(expr.property.name) // Property names are NOT SSA-versioned
            : t.stringLiteral(
                String(expr.property.kind === 'Literal' ? (expr.property.value ?? '') : ''),
              ),
        expr.computed,
        expr.optional,
      )

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as BabelCore.types.BinaryExpression['operator'],
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as BabelCore.types.UnaryExpression['operator'],
        lowerExpression(expr.argument, ctx),
        expr.prefix,
      )

    case 'LogicalExpression':
      return t.logicalExpression(
        expr.operator as BabelCore.types.LogicalExpression['operator'],
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'ConditionalExpression':
      return t.conditionalExpression(
        lowerExpression(expr.test, ctx),
        lowerExpression(expr.consequent, ctx),
        lowerExpression(expr.alternate, ctx),
      )

    case 'ArrayExpression':
      return t.arrayExpression(
        expr.elements.map(el =>
          el.kind === 'SpreadElement'
            ? t.spreadElement(lowerExpression(el.argument, ctx))
            : lowerExpression(el, ctx),
        ),
      )

    case 'ObjectExpression':
      return t.objectExpression(
        expr.properties.map(p => {
          if (p.kind === 'SpreadElement') {
            return t.spreadElement(lowerExpression(p.argument, ctx))
          }
          const keyIsIdentifier = !p.computed && p.key.kind === 'Identifier'
          const keyIdent = keyIsIdentifier && p.key.kind === 'Identifier' ? p.key.name : ''
          const keyNode = p.computed
            ? lowerExpression(p.key, ctx)
            : keyIsIdentifier
              ? t.identifier(keyIdent)
              : lowerExpression(p.key, ctx)

          if (p.propertyKind && p.propertyKind !== 'init') {
            const valueExpr = lowerExpression(p.value, ctx)
            if (!t.isFunctionExpression(valueExpr)) {
              throw new HIRError(
                `Object method property did not lower to function expression.`,
                'CODEGEN_ERROR',
              )
            }
            const method = t.objectMethod(
              p.propertyKind === 'method' ? 'method' : p.propertyKind,
              keyNode as BabelCore.types.Expression,
              valueExpr.params as BabelCore.types.FunctionParameter[],
              valueExpr.body,
              !!p.computed,
            )
            method.async = valueExpr.async
            method.generator = valueExpr.generator
            return method
          }
          // For shorthand properties, ensure key matches the de-versioned value name
          const usesTracked =
            !!ctx.inPropsContext &&
            (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
            p.value.kind !== 'ArrowFunction' &&
            p.value.kind !== 'FunctionExpression' &&
            expressionUsesTracked(p.value, ctx)
          const valueExprRaw = usesTracked
            ? (lowerTrackedExpression(p.value as Expression, ctx) as BabelCore.types.Expression)
            : lowerExpression(p.value, ctx)
          const shouldMemoProp =
            usesTracked &&
            !t.isIdentifier(valueExprRaw) &&
            !t.isMemberExpression(valueExprRaw) &&
            !t.isLiteral(valueExprRaw)
          const valueExpr =
            usesTracked && ctx.t.isExpression(valueExprRaw)
              ? (() => {
                  if (shouldMemoProp) {
                    ctx.helpersUsed.add('prop')
                    return t.callExpression(t.identifier(RUNTIME_ALIASES.prop), [
                      t.arrowFunctionExpression([], valueExprRaw),
                    ])
                  }
                  ctx.helpersUsed.add('propGetter')
                  return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                    t.arrowFunctionExpression([], valueExprRaw),
                  ])
                })()
              : valueExprRaw
          // If shorthand and value is identifier, use de-versioned name for key too
          const useShorthand =
            p.shorthand &&
            t.isIdentifier(valueExpr) &&
            keyIsIdentifier &&
            deSSAVarName(keyIdent) === valueExpr.name

          return t.objectProperty(
            useShorthand ? t.identifier(valueExpr.name) : keyNode,
            valueExpr,
            !!p.computed,
            useShorthand,
          )
        }),
      )

    case 'JSXElement':
      return lowerJSXElement(expr, ctx)

    case 'ArrowFunction': {
      const reactiveLowered = lowerReactiveScopeExpression(expr)
      if (reactiveLowered) return reactiveLowered
      const paramIds = expr.rawParams
        ? expr.rawParams.map(param => t.cloneNode(param, true) as BabelCore.types.FunctionParameter)
        : mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      const localDeclared = collectLocalDeclaredNames(
        expr.params,
        Array.isArray(expr.body) ? (expr.body as BasicBlock[]) : null,
        t,
      )
      // Arrow functions are always reactivity boundaries - prevent statements inside
      // from being wrapped in $effect/__fictUseEffect (like FunctionExpression)
      return withNonReactiveScope(ctx, () =>
        withFunctionScope(
          shadowed,
          () => {
            const prevNoMemo = ctx.noMemo
            const prevHookFlag = ctx.currentFnIsHook
            const prevIsComponent = ctx.isComponentFn
            ctx.noMemo = !!(prevNoMemo || expr.noMemo)
            ctx.currentFnIsHook = false
            ctx.isComponentFn = false
            let fn: BabelCore.types.ArrowFunctionExpression

            try {
              if (expr.isExpression && !Array.isArray(expr.body)) {
                // Rule L: Enable getter caching for sync arrow functions with expression body
                const { result: bodyExpr, cacheDeclarations } = withGetterCache(ctx, () =>
                  lowerTrackedExpression(expr.body as Expression, ctx),
                )
                if (cacheDeclarations.length > 0) {
                  // Need to convert to block body to include cache declarations
                  fn = t.arrowFunctionExpression(
                    paramIds,
                    t.blockStatement([...cacheDeclarations, t.returnStatement(bodyExpr)]),
                  )
                } else {
                  fn = t.arrowFunctionExpression(paramIds, bodyExpr)
                }
              } else if (Array.isArray(expr.body)) {
                // Rule L: Enable getter caching for sync arrow functions with block body
                const { result: stmts, cacheDeclarations } = withGetterCache(ctx, () =>
                  lowerStructuredBlocks(expr.body as BasicBlock[], expr.params, paramIds),
                )
                fn = t.arrowFunctionExpression(
                  paramIds,
                  t.blockStatement([...cacheDeclarations, ...stmts]),
                )
              } else {
                fn = t.arrowFunctionExpression(paramIds, t.blockStatement([]))
              }
              fn.async = expr.isAsync ?? false
              return fn
            } finally {
              ctx.noMemo = prevNoMemo
              ctx.currentFnIsHook = prevHookFlag
              ctx.isComponentFn = prevIsComponent
            }
          },
          localDeclared,
        ),
      )
    }

    case 'FunctionExpression': {
      const reactiveLowered = lowerReactiveScopeExpression(expr)
      if (reactiveLowered) return reactiveLowered
      const paramIds = expr.rawParams
        ? expr.rawParams.map(param => t.cloneNode(param, true) as BabelCore.types.FunctionParameter)
        : mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      const localDeclared = collectLocalDeclaredNames(expr.params, expr.body as BasicBlock[], t)
      return withNonReactiveScope(ctx, () =>
        withFunctionScope(
          shadowed,
          () => {
            const prevNoMemo = ctx.noMemo
            const prevHookFlag = ctx.currentFnIsHook
            const prevIsComponent = ctx.isComponentFn
            ctx.noMemo = !!(prevNoMemo || expr.noMemo)
            ctx.currentFnIsHook = expr.name ? isHookName(deSSAVarName(expr.name)) : false
            ctx.isComponentFn = false
            let fn: BabelCore.types.FunctionExpression
            try {
              if (Array.isArray(expr.body)) {
                // Rule L: Enable getter caching for sync function expressions
                const { result: stmts, cacheDeclarations } = withGetterCache(ctx, () =>
                  lowerStructuredBlocks(expr.body as BasicBlock[], expr.params, paramIds),
                )
                fn = t.functionExpression(
                  expr.name ? t.identifier(deSSAVarName(expr.name)) : null,
                  paramIds,
                  t.blockStatement([...cacheDeclarations, ...stmts]),
                )
              } else {
                fn = t.functionExpression(
                  expr.name ? t.identifier(deSSAVarName(expr.name)) : null,
                  paramIds,
                  t.blockStatement([]),
                )
              }
              fn.async = expr.isAsync ?? false
              fn.generator = expr.isGenerator ?? false
              return fn
            } finally {
              ctx.noMemo = prevNoMemo
              ctx.currentFnIsHook = prevHookFlag
              ctx.isComponentFn = prevIsComponent
            }
          },
          localDeclared,
        ),
      )
    }

    case 'AssignmentExpression':
      if (expr.left.kind === 'MemberExpression') {
        if (
          expr.left.object.kind === 'Identifier' &&
          ctx.hookResultVarMap?.has(deSSAVarName(expr.left.object.name))
        ) {
          const hookName = ctx.hookResultVarMap.get(deSSAVarName(expr.left.object.name))!
          const info = getHookReturnInfo(hookName, ctx)
          const propName = getStaticPropName(expr.left.property as Expression, expr.left.computed)
          let kind: HookAccessorKind | undefined =
            typeof propName === 'string'
              ? info?.objectProps?.get(propName)
              : typeof propName === 'number'
                ? info?.arrayProps?.get(propName)
                : undefined
          if (!info && propName !== null) {
            kind = 'signal'
          }
          if (kind === 'signal') {
            const member = t.memberExpression(
              t.identifier(deSSAVarName(expr.left.object.name)),
              expr.left.computed
                ? lowerExpression(expr.left.property as Expression, ctx)
                : expr.left.property.kind === 'Identifier'
                  ? t.identifier(expr.left.property.name)
                  : t.stringLiteral(
                      String(expr.left.property.kind === 'Literal' ? expr.left.property.value : ''),
                    ),
              expr.left.computed,
              expr.left.optional,
            )
            const current = t.callExpression(t.cloneNode(member, true), [])
            const right = lowerExpression(expr.right, ctx)
            const next = buildTrackedAssignmentNext(expr.operator, current, right)
            return lowerTrackedWriteCall(member, next)
          }
          if (expr.left.computed) {
            const signalKeys: (string | number)[] = []
            if (info?.objectProps) {
              for (const [key, accessorKind] of info.objectProps.entries()) {
                if (accessorKind === 'signal') signalKeys.push(key)
              }
            }
            if (info?.arrayProps) {
              for (const [key, accessorKind] of info.arrayProps.entries()) {
                if (accessorKind === 'signal') signalKeys.push(key)
              }
            }
            const lowered = lowerComputedHookSignalAssignment(
              deSSAVarName(expr.left.object.name),
              expr.left.property as Expression,
              signalKeys,
              expr.operator as BabelCore.types.AssignmentExpression['operator'],
              expr.right,
            )
            if (lowered) return lowered
          }
        }
      }
      if (expr.left.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.left.name)
        if (ctx.trackedVars.has(baseName)) {
          const callee = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const right = lowerExpression(expr.right, ctx)
          const next = buildTrackedAssignmentNext(expr.operator, current, right)
          return lowerTrackedWriteCall(callee, next)
        }
      }

      return t.assignmentExpression(
        expr.operator as BabelCore.types.AssignmentExpression['operator'],
        lowerExpression(expr.left, ctx) as BabelCore.types.LVal,
        lowerExpression(expr.right, ctx),
      )

    case 'UpdateExpression':
      if (expr.argument.kind === 'MemberExpression') {
        if (
          expr.argument.object.kind === 'Identifier' &&
          ctx.hookResultVarMap?.has(deSSAVarName(expr.argument.object.name))
        ) {
          const hookName = ctx.hookResultVarMap.get(deSSAVarName(expr.argument.object.name))!
          const info = getHookReturnInfo(hookName, ctx)
          const propName = getStaticPropName(
            expr.argument.property as Expression,
            expr.argument.computed,
          )
          let kind: HookAccessorKind | undefined =
            typeof propName === 'string'
              ? info?.objectProps?.get(propName)
              : typeof propName === 'number'
                ? info?.arrayProps?.get(propName)
                : undefined
          if (!info && propName !== null) {
            kind = 'signal'
          }
          if (kind === 'signal') {
            const member = t.memberExpression(
              t.identifier(deSSAVarName(expr.argument.object.name)),
              expr.argument.computed
                ? lowerExpression(expr.argument.property as Expression, ctx)
                : expr.argument.property.kind === 'Identifier'
                  ? t.identifier(expr.argument.property.name)
                  : t.stringLiteral(
                      String(
                        expr.argument.property.kind === 'Literal'
                          ? expr.argument.property.value
                          : '',
                      ),
                    ),
              expr.argument.computed,
              expr.argument.optional,
            )
            return lowerTrackedUpdateCall(member, expr.operator, expr.prefix)
          }
          if (expr.argument.computed) {
            const signalKeys: (string | number)[] = []
            if (info?.objectProps) {
              for (const [key, accessorKind] of info.objectProps.entries()) {
                if (accessorKind === 'signal') signalKeys.push(key)
              }
            }
            if (info?.arrayProps) {
              for (const [key, accessorKind] of info.arrayProps.entries()) {
                if (accessorKind === 'signal') signalKeys.push(key)
              }
            }
            const lowered = lowerComputedHookSignalUpdate(
              deSSAVarName(expr.argument.object.name),
              expr.argument.property as Expression,
              signalKeys,
              expr.operator,
              expr.prefix,
            )
            if (lowered) return lowered
          }
        }
      }
      if (expr.argument.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.argument.name)
        if (ctx.trackedVars.has(baseName)) {
          return lowerTrackedUpdateCall(t.identifier(baseName), expr.operator, expr.prefix)
        }
      }

      return t.updateExpression(
        expr.operator,
        lowerExpression(expr.argument, ctx) as BabelCore.types.Expression,
        expr.prefix,
      )

    case 'TemplateLiteral':
      return t.templateLiteral(
        expr.quasis.map((q, i) =>
          t.templateElement({ raw: q, cooked: q }, i === expr.quasis.length - 1),
        ),
        expr.expressions.map(e => lowerExpression(e, ctx)),
      )

    case 'SpreadElement':
      // SpreadElement is handled specially in ObjectExpression/ArrayExpression
      // When encountered as a standalone expression, lower its argument
      return lowerExpression(expr.argument, ctx)

    case 'AwaitExpression':
      return t.awaitExpression(lowerExpression(expr.argument, ctx))

    case 'NewExpression':
      return t.newExpression(lowerExpression(expr.callee, ctx), lowerCallArguments(expr.arguments))

    case 'SequenceExpression':
      return t.sequenceExpression(
        expr.expressions.map((e, index) =>
          lowerExpression(e, ctx, index === expr.expressions.length - 1 ? valueUsed : false),
        ),
      )

    case 'YieldExpression':
      return t.yieldExpression(
        expr.argument ? lowerExpression(expr.argument, ctx) : null,
        expr.delegate,
      )

    case 'OptionalCallExpression':
      return t.optionalCallExpression(
        lowerExpression(expr.callee, ctx),
        lowerCallArguments(expr.arguments),
        expr.optional,
      )

    case 'TaggedTemplateExpression':
      return t.taggedTemplateExpression(
        lowerExpression(expr.tag, ctx),
        t.templateLiteral(
          expr.quasi.quasis.map((q, i) =>
            t.templateElement({ raw: q, cooked: q }, i === expr.quasi.quasis.length - 1),
          ),
          expr.quasi.expressions.map(e => lowerExpression(e, ctx)),
        ),
      )

    case 'ClassExpression':
      // For now, just return the class body as-is (stored as Babel AST)
      return t.classExpression(
        expr.name ? t.identifier(expr.name) : null,
        expr.superClass ? lowerExpression(expr.superClass, ctx) : null,
        t.classBody(expr.body ?? []),
      )

    case 'ThisExpression':
      return t.thisExpression()

    case 'SuperExpression':
      return t.super()

    case 'OptionalMemberExpression':
      return t.optionalMemberExpression(
        lowerExpression(expr.object, ctx),
        expr.computed
          ? lowerExpression(expr.property, ctx)
          : expr.property.kind === 'Identifier'
            ? t.identifier(expr.property.name)
            : t.stringLiteral(
                String(expr.property.kind === 'Literal' ? (expr.property.value ?? '') : ''),
              ),
        expr.computed,
        expr.optional,
      )

    default:
      return t.identifier('undefined')
  }
}

/**
 * Lower an expression intended for DOM bindings, applying RegionMetadata overrides.
 */
function lowerDomExpression(
  expr: Expression,
  ctx: CodegenContext,
  region?: RegionInfo | null,
  options?: { skipHookAccessors?: boolean; skipRegionRootOverride?: boolean },
): BabelCore.types.Expression {
  let lowered = lowerExpression(expr, ctx)
  const skipHookAccessors = options?.skipHookAccessors ?? false
  if (
    !skipHookAccessors &&
    ctx.t.isMemberExpression(lowered) &&
    ctx.t.isIdentifier(lowered.object) &&
    ctx.hookResultVarMap?.has(deSSAVarName(lowered.object.name))
  ) {
    lowered = ctx.t.callExpression(lowered, [])
  } else if (!skipHookAccessors && ctx.t.isIdentifier(lowered)) {
    const hookName = ctx.hookResultVarMap?.get(deSSAVarName(lowered.name))
    if (hookName) {
      const info = getHookReturnInfo(hookName, ctx)
      if (info?.directAccessor) {
        lowered = ctx.t.callExpression(ctx.t.identifier(deSSAVarName(lowered.name)), [])
      }
    }
  }
  return applyRegionMetadataToExpression(lowered, ctx, region, {
    skipRootOverride: options?.skipRegionRootOverride,
  })
}

function lowerJSXChildNonFineGrained(
  child: JSXChild,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  if (child.kind === 'text') {
    return t.stringLiteral(child.value)
  }
  if (child.kind === 'element') {
    return lowerJSXElement(child.value, ctx)
  }
  const expr = child.value
  const lowered = lowerDomExpression(expr, ctx)
  if (isExpressionReactive(expr, ctx)) {
    return markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], lowered))
  }
  return lowered
}

function lowerIntrinsicElementAsVNode(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const props: BabelCore.types.ObjectProperty[] = []
  const spreads: BabelCore.types.SpreadElement[] = []
  const toPropKey = (name: string) =>
    /^[a-zA-Z_$][\w$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name)

  for (const attr of jsx.attributes) {
    if (attr.isSpread && attr.spreadExpr) {
      spreads.push(t.spreadElement(lowerDomExpression(attr.spreadExpr, ctx)))
      continue
    }

    const name = attr.name
    if (name === 'key') {
      // Key is ignored in runtime VNode mode.
      continue
    }

    const isEvent = name.startsWith('on') && name.length > 2 && name[2] === name[2]?.toUpperCase()
    const prevWrapTracked = ctx.wrapTrackedExpressions
    if (isEvent) {
      ctx.wrapTrackedExpressions = false
    }
    const rawExpr = attr.value ? lowerDomExpression(attr.value, ctx) : t.booleanLiteral(true)
    ctx.wrapTrackedExpressions = prevWrapTracked
    let valueExpr = rawExpr

    if (attr.value) {
      if (isEvent) {
        if (!(t.isArrowFunctionExpression(rawExpr) || t.isFunctionExpression(rawExpr))) {
          valueExpr = markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], rawExpr))
        }
      } else if (isExpressionReactive(attr.value, ctx)) {
        valueExpr = markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], rawExpr))
      }
    }

    props.push(t.objectProperty(toPropKey(name), valueExpr))
  }

  const children = jsx.children.map(child => lowerJSXChildNonFineGrained(child, ctx))
  if (children.length === 1 && children[0]) {
    props.push(t.objectProperty(t.identifier('children'), children[0]))
  } else if (children.length > 1) {
    props.push(t.objectProperty(t.identifier('children'), t.arrayExpression(children)))
  }

  const propsExpr =
    spreads.length > 0
      ? t.objectExpression([...spreads, ...props])
      : props.length > 0
        ? t.objectExpression(props)
        : t.nullLiteral()

  return t.objectExpression([
    t.objectProperty(t.identifier('type'), t.stringLiteral(String(jsx.tagName))),
    t.objectProperty(t.identifier('props'), propsExpr),
  ])
}

/**
 * Lower a JSX Element expression to fine-grained DOM operations
 */
function lowerJSXElement(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx

  if (jsx.isComponent) {
    // Check if this is a Fragment component
    const isFragment =
      typeof jsx.tagName === 'object' &&
      jsx.tagName.kind === 'Identifier' &&
      jsx.tagName.name === 'Fragment'

    if (isFragment) {
      // Fragment - create VNode directly for runtime to handle
      ctx.helpersUsed.add('createElement')
      ctx.helpersUsed.add('fragment')
      const children = jsx.children.map(c => lowerJSXChild(c, ctx))

      // Create VNode: { type: Fragment, props: { children: [...] } }
      const childrenProp =
        children.length === 1
          ? children[0]
          : children.length > 1
            ? t.arrayExpression(children)
            : t.nullLiteral()

      return t.callExpression(t.identifier('createElement'), [
        t.objectExpression([
          t.objectProperty(t.identifier('type'), t.identifier('Fragment')),
          t.objectProperty(
            t.identifier('props'),
            children.length > 0 && childrenProp
              ? t.objectExpression([t.objectProperty(t.identifier('children'), childrenProp)])
              : t.nullLiteral(),
          ),
        ]),
      ])
    }

    // Component - create VNode {type, props} for runtime createElement
    ctx.helpersUsed.add('createElement')
    const children = jsx.children.map(c => lowerJSXChild(c, ctx))
    const propsExpr = buildPropsExpression(jsx.attributes, children, ctx, {
      lowerDomExpression,
      lowerTrackedExpression,
      expressionUsesTracked,
      deSSAVarName,
    })

    const componentRef =
      typeof jsx.tagName === 'string'
        ? t.identifier(jsx.tagName)
        : lowerExpression(jsx.tagName, ctx)

    // Create VNode: { type: Component, props: {...} }
    // Return VNode object directly - runtime render()/insert() will call createElement on it
    return t.objectExpression([
      t.objectProperty(t.identifier('type'), componentRef),
      t.objectProperty(t.identifier('props'), propsExpr ?? t.nullLiteral()),
    ])
  }

  const useFineGrainedDom = (ctx.options?.fineGrainedDom ?? true) && !ctx.noMemo
  if (!useFineGrainedDom) {
    return lowerIntrinsicElementAsVNode(jsx, ctx)
  }

  // Intrinsic element - use fine-grained DOM
  return lowerIntrinsicElement(jsx, ctx)
}

/**
 * Apply RegionMetadata dependency overrides to a lowered expression.
 * This mirrors fine-grained-dom's applyRegionMetadata, but guards against
 * double-invoking callees by skipping overrides on call targets.
 */
export function applyRegionMetadataToExpression(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  regionOverride?: RegionInfo | null,
  options?: { skipRootOverride?: boolean },
): BabelCore.types.Expression {
  if (ctx.inReturn && ctx.currentFnIsHook) {
    return expr
  }
  const region = regionOverride ?? ctx.currentRegion
  if (!region) return expr
  const skipRootOverride = options?.skipRootOverride ?? false

  const metadata = regionInfoToMetadata(region)
  const state: { identifierOverrides?: RegionOverrideMap } = {}

  applyRegionMetadata(state, {
    region: metadata,
    dependencyGetter: name => buildDependencyGetter(name, ctx),
  })

  const overrides = state.identifierOverrides ?? {}
  state.identifierOverrides = overrides

  const shadowed = ctx.shadowedNames
  const _isReactiveAccessor = (name: string): boolean =>
    ctx.trackedVars.has(name) ||
    !!(ctx.signalVars?.has(name) || ctx.memoVars?.has(name) || ctx.aliasVars?.has(name))
  const isNonReactiveFunction = (name: string): boolean => ctx.functionVars?.has(name) ?? false

  if (shadowed && Object.keys(overrides).length > 0) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (shadowed.has(base)) {
        delete overrides[key]
      }
    }
  }

  if (Object.keys(overrides).length > 0) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (isNonReactiveFunction(base)) {
        delete overrides[key]
      }
    }
  }

  if (ctx.inReturn && ctx.currentFnIsHook) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (ctx.trackedVars.has(base) || ctx.memoVars?.has(base) || ctx.signalVars?.has(base)) {
        delete overrides[key]
      }
    }
  }

  // Ensure tracked variables are also covered even if region metadata missed them
  const trackedNames = new Set(ctx.trackedVars)
  if (ctx.memoVars) {
    ctx.memoVars.forEach(dep => trackedNames.add(dep))
  }
  for (const dep of trackedNames) {
    const key = normalizeDependencyKey(dep)
    const base = key.split('.')[0] ?? key
    if (shadowed && shadowed.has(base)) continue
    if (isNonReactiveFunction(base)) continue
    if (ctx.inReturn && ctx.currentFnIsHook) continue
    if (!overrides[key]) {
      overrides[key] = () => buildDependencyGetter(dep, ctx)
    }
  }

  if (Object.keys(overrides).length === 0) {
    return expr
  }

  if (!skipRootOverride && ctx.t.isIdentifier(expr)) {
    const key = normalizeDependencyKey(expr.name)
    const direct = overrides[key] ?? overrides[expr.name]
    if (direct) {
      return direct()
    }
  }

  const cloned = ctx.t.cloneNode(expr, true) as BabelCore.types.Expression
  replaceIdentifiersWithOverrides(cloned, overrides, ctx.t, undefined, undefined, skipRootOverride)
  return cloned
}

export function buildDependencyGetter(
  name: string,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  // Support simple dotted paths: foo.bar -> foo().bar if foo is tracked
  const parts = name.split('.')
  const base = parts.shift()!
  const baseId = t.identifier(base)
  // Only signal/memo/alias variables are actual getter functions that need () calls
  // trackedVars includes all reactive dependencies but may contain plain values
  const isActualGetter = !!(
    ctx.signalVars?.has(base) ||
    ctx.memoVars?.has(base) ||
    ctx.aliasVars?.has(base)
  )
  // $store variables use proxy-based reactivity, don't convert to getter calls
  const isStore = ctx.storeVars?.has(base) ?? false
  const isNonReactiveFunction = ctx.functionVars?.has(base) ?? false

  let baseExpr: BabelCore.types.Expression
  if (isActualGetter && !isStore && !isNonReactiveFunction) {
    // Rule L: Use getter cache when enabled to avoid redundant getter calls
    const getterCall = t.callExpression(baseId, [])
    baseExpr = getCachedGetterExpression(ctx, base, getterCall)
  } else {
    // For store variables and non-tracked variables, use identifier directly
    // Stores use proxy-based path-level reactivity internally
    baseExpr = baseId
  }

  return parts.reduce<BabelCore.types.Expression>((acc, prop) => {
    const numericValue = Number(prop)
    const useNumeric = Number.isSafeInteger(numericValue) && String(numericValue) === prop
    const key = useNumeric
      ? t.numericLiteral(numericValue)
      : /^[a-zA-Z_$][\w$]*$/.test(prop)
        ? t.identifier(prop)
        : t.stringLiteral(prop)
    return t.memberExpression(acc, key, !t.isIdentifier(key))
  }, baseExpr)
}

function unwrapAccessorCalls(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const isAccessorName = (name: string) =>
    ctx.signalVars?.has(name) || ctx.memoVars?.has(name) || ctx.aliasVars?.has(name)

  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && expr.arguments.length === 0) {
    if (isAccessorName(expr.callee.name)) {
      return t.identifier(expr.callee.name)
    }
  }

  if (t.isObjectExpression(expr)) {
    const props = expr.properties.map(p => {
      if (t.isObjectProperty(p)) {
        const value = unwrapAccessorCalls(p.value as BabelCore.types.Expression, ctx)
        return t.objectProperty(p.key, value, p.computed, p.shorthand)
      }
      return p
    })
    return t.objectExpression(props)
  }

  if (t.isArrayExpression(expr)) {
    const elements = expr.elements.map(el =>
      el && t.isExpression(el) ? unwrapAccessorCalls(el, ctx) : el,
    )
    return t.arrayExpression(elements)
  }

  return expr
}

/**
 * Lower an intrinsic HTML element to fine-grained DOM operations.
 * Uses template extraction and RegionMetadata for optimized updates.
 * Aligned with fine-grained-dom.ts approach.
 */
function lowerIntrinsicElement(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const statements: BabelCore.types.Statement[] = []

  // Extract static HTML with bindings, passing namespace context
  // This allows proper namespace detection for elements inside SVG/MathML
  const { html, bindings, isSVG, isMathML } = extractHIRStaticHtml(
    jsx,
    ctx,
    {
      isLikelyTextExpression: (expr, context) =>
        isLikelyTextExpression(expr, context, { getHookReturnInfo }),
    },
    [],
    ctx.namespaceContext ?? null,
  )

  // Collect all dependencies from bindings to find containing region
  const allDeps = new Set<string>()
  for (const binding of bindings) {
    if (binding.expr) collectExpressionDependencies(binding.expr, allDeps)
  }

  // Find the containing region and apply it to the context
  let containingRegion = findContainingRegion(allDeps, ctx)
  if (!containingRegion && allDeps.size > 0) {
    containingRegion = {
      id: (ctx.regions?.length ?? 0) + 1000,
      dependencies: new Set(Array.from(allDeps).map(d => deSSAVarName(d))),
      declarations: new Set<string>(),
      hasControlFlow: false,
      hasReactiveWrites: false,
    }
  }
  const prevRegion = applyRegionToContext(ctx, containingRegion)
  const regionMeta = containingRegion ? regionInfoToMetadata(containingRegion) : null
  const canUseRenderMemo = !!(ctx.inModule || ctx.isComponentFn || ctx.currentFnIsHook)
  const shouldMemo =
    canUseRenderMemo &&
    !ctx.inListRender &&
    !(ctx.inConditional && ctx.inConditional > 0) &&
    regionMeta
      ? shouldMemoizeRegion(regionMeta)
      : false
  if (shouldMemo) {
    if (ctx.inModule) {
      ctx.helpersUsed.add('memo')
    } else {
      ctx.helpersUsed.add('useMemo')
      ctx.needsCtx = true
    }
  }

  // Create template with full static HTML
  // For list render context, try to hoist template to avoid repeated HTML parsing
  // Pass namespace flags for SVG/MathML support
  const hoistedTmplId = getOrCreateHoistedTemplate(html, ctx, isSVG, isMathML)
  const rootId = genTemp(ctx, 'root')

  if (hoistedTmplId) {
    // Use hoisted template (already declared outside list callback)
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(rootId, t.callExpression(t.identifier(hoistedTmplId.name), [])),
      ]),
    )
  } else {
    // Create template inline (non-list context)
    ctx.helpersUsed.add('template')
    const tmplId = genTemp(ctx, 'tmpl')

    // Build template call arguments with namespace flags
    const templateArgs: BabelCore.types.Expression[] = [t.stringLiteral(html)]
    if (isSVG || isMathML) {
      // template(html, isImportNode, isSVG, isMathML)
      templateArgs.push(t.identifier('undefined')) // isImportNode
      templateArgs.push(isSVG ? t.booleanLiteral(true) : t.identifier('undefined'))
      if (isMathML) {
        templateArgs.push(t.booleanLiteral(true))
      }
    }

    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          tmplId,
          t.callExpression(t.identifier(RUNTIME_ALIASES.template), templateArgs),
        ),
      ]),
    )
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(rootId, t.callExpression(t.identifier(tmplId.name), [])),
      ]),
    )
  }
  // Note: template() already returns content.firstChild, so rootId IS the root element
  // We use rootId directly as elId
  const elId = rootId

  // Build a cache for resolved node paths
  const nodeCache = new Map<string, BabelCore.types.Identifier>()
  nodeCache.set('', elId)

  // Determine and set namespace context for this element's children
  // This allows dynamic child expressions to know they're inside SVG/MathML
  const tagName = typeof jsx.tagName === 'string' ? jsx.tagName : null
  const prevNamespace = ctx.namespaceContext
  if (tagName) {
    const elementNamespace = resolveNamespaceContext(tagName, ctx.namespaceContext ?? null)
    ctx.namespaceContext = elementNamespace
  }

  // Precompute node references before any binding mutates the DOM tree
  const pathStatements: BabelCore.types.Statement[] = []
  for (const binding of bindings) {
    resolveHIRBindingPath(binding.path, nodeCache, pathStatements, ctx, genTemp)
  }
  statements.push(...pathStatements)

  const optimizeLevel = ctx.options?.optimizeLevel ?? 'safe'
  interface FusedPatchEntry {
    patch: BabelCore.types.Statement
    fallback: BabelCore.types.Statement
    patchHelper: 'setText' | 'setAttr' | 'setProp' | 'setClass' | 'setStyle'
    fallbackHelper: 'bindText' | 'bindAttribute' | 'bindProperty' | 'bindClass' | 'bindStyle'
  }

  const fusedPatchGroups = new Map<string, FusedPatchEntry[]>()
  let fusedUniqueId = 0

  const isFusibleBindingExpression = (expr: Expression): boolean => {
    switch (expr.kind) {
      case 'Identifier':
      case 'Literal':
      case 'ThisExpression':
      case 'SuperExpression':
        return true
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return (
          isFusibleBindingExpression(expr.object) &&
          (!expr.computed || isFusibleBindingExpression(expr.property))
        )
      case 'BinaryExpression':
      case 'LogicalExpression':
        return (
          isFusibleBindingExpression(expr.left as Expression) &&
          isFusibleBindingExpression(expr.right as Expression)
        )
      case 'UnaryExpression':
        return expr.operator !== 'delete' && isFusibleBindingExpression(expr.argument as Expression)
      case 'ConditionalExpression':
        return (
          isFusibleBindingExpression(expr.test as Expression) &&
          isFusibleBindingExpression(expr.consequent as Expression) &&
          isFusibleBindingExpression(expr.alternate as Expression)
        )
      case 'ArrayExpression':
        return expr.elements.every(el => isFusibleBindingExpression(el as Expression))
      case 'ObjectExpression':
        return expr.properties.every(prop => {
          if (prop.kind === 'SpreadElement') {
            return isFusibleBindingExpression(prop.argument as Expression)
          }
          if (prop.key.kind === 'Identifier' || prop.key.kind === 'Literal') {
            return isFusibleBindingExpression(prop.value as Expression)
          }
          return isFusibleBindingExpression(prop.value as Expression)
        })
      case 'TemplateLiteral':
        return expr.expressions.every(e => isFusibleBindingExpression(e as Expression))
      default:
        return false
    }
  }

  const getFusedPatchGroupKey = (expr: Expression): string => {
    if (optimizeLevel === 'full') return '__full__'
    const deps = getReactiveDependencies(expr, ctx)
    if (deps.size === 0) {
      fusedUniqueId += 1
      return `__dep_empty_${fusedUniqueId}`
    }
    return Array.from(deps).sort().join('|')
  }

  const queueFusedPatch = (expr: Expression, entry: FusedPatchEntry): boolean => {
    if (!isFusibleBindingExpression(expr)) return false
    const key = getFusedPatchGroupKey(expr)
    const group = fusedPatchGroups.get(key)
    if (group) {
      group.push(entry)
    } else {
      fusedPatchGroups.set(key, [entry])
    }
    return true
  }

  const lowerBindingValueExpression = (expr?: Expression): BabelCore.types.Expression => {
    const valueExpr = expr
      ? lowerDomExpression(expr, ctx, containingRegion)
      : t.booleanLiteral(true)
    const valueIdentifier = t.isIdentifier(valueExpr) ? deSSAVarName(valueExpr.name) : undefined
    return valueIdentifier &&
      (regionMeta?.dependencies.has(valueIdentifier) || ctx.trackedVars.has(valueIdentifier))
      ? buildDependencyGetter(valueIdentifier, ctx)
      : valueExpr
  }

  const flushFusedPatchGroups = (): void => {
    if (fusedPatchGroups.size === 0) return
    for (const groupEntries of fusedPatchGroups.values()) {
      if (optimizeLevel !== 'full' && groupEntries.length === 1) {
        const single = groupEntries[0]!
        ctx.helpersUsed.add(single.fallbackHelper)
        statements.push(single.fallback)
        continue
      }

      ctx.helpersUsed.add('renderEffect')
      const patchStatements: BabelCore.types.Statement[] = []
      for (const entry of groupEntries) {
        ctx.helpersUsed.add(entry.patchHelper)
        patchStatements.push(entry.patch)
      }
      statements.push(
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.renderEffect), [
            t.arrowFunctionExpression([], t.blockStatement(patchStatements)),
          ]),
        ),
      )
    }
    fusedPatchGroups.clear()
  }

  // Apply bindings using path navigation
  for (const binding of bindings) {
    const targetId = resolveHIRBindingPath(binding.path, nodeCache, statements, ctx, genTemp)

    if (binding.type === 'spread' && binding.expr) {
      // Spread ordering must follow source order, so flush pending fused patches first.
      flushFusedPatchGroups()
      ctx.helpersUsed.add('spread')
      const spreadValueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      // Always wrap spread expressions so function-valued expressions are treated
      // as values, not invoked as runtime spread getters.
      const spreadGetter = markCompilerReactiveGetter(
        ctx,
        t.arrowFunctionExpression([], spreadValueExpr),
      )
      const spreadArgs: BabelCore.types.Expression[] = [
        targetId,
        spreadGetter,
        t.booleanLiteral(Boolean(isSVG || isMathML)),
        t.booleanLiteral(jsx.children.length > 0),
      ]
      if (binding.exclude && binding.exclude.length > 0) {
        spreadArgs.push(t.arrayExpression(binding.exclude.map(name => t.stringLiteral(name))))
      }
      statements.push(
        t.expressionStatement(t.callExpression(t.identifier(RUNTIME_ALIASES.spread), spreadArgs)),
      )
    } else if (binding.type === 'event' && binding.expr && binding.name) {
      // Event binding
      const eventName = binding.name
      const hasEventOptions =
        binding.eventOptions &&
        (binding.eventOptions.capture || binding.eventOptions.passive || binding.eventOptions.once)
      const isDelegated = DelegatedEvents.has(eventName) && !hasEventOptions

      if (binding.resumable && !hasEventOptions) {
        const emitted = emitResumableEventBinding(
          targetId,
          eventName,
          binding.expr,
          statements,
          ctx,
          containingRegion,
          createResumableEventBindingOps(),
          { explicit: binding.resumableExplicit === true },
        )
        if (emitted) continue
      }

      // Try to extract handler and data from HIR before lowering
      // This preserves function references without transforming them to call expressions
      const hirDataBinding =
        isDelegated && binding.expr ? extractDelegatedEventDataFromHIR(binding.expr, ctx) : null

      if (hirDataBinding) {
        // Optimized path - handler and data extracted from HIR
        // Pattern: onClick={() => select(__key)} compiles to:
        //   $$click = select
        //   $$clickData = () => __key
        // This avoids creating per-item closures in lists while maintaining
        // the runtime's (data, event) calling convention
        ctx.delegatedEventsUsed?.add(eventName)

        // Lower handler as a simple identifier (not as getter call)
        const handlerExpr =
          hirDataBinding.handler.kind === 'Identifier'
            ? t.identifier(hirDataBinding.handler.name)
            : lowerExpression(hirDataBinding.handler, ctx)

        // Lower data with proper tracking (wrapped in getter for reactivity)
        const dataExpr = lowerDomExpression(hirDataBinding.data, ctx, containingRegion, {
          skipHookAccessors: false,
          skipRegionRootOverride: true,
        })

        const dataValue = isStaticDelegatedDataExpression(hirDataBinding.data, ctx)
          ? dataExpr
          : markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], dataExpr))
        ctx.helpersUsed.add('addEventListener')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.addEventListener), [
              targetId,
              t.stringLiteral(eventName),
              t.arrayExpression([handlerExpr, dataValue]),
              t.booleanLiteral(true),
            ]),
          ),
        )
      } else {
        // Standard path - lower the entire expression
        const shouldWrapHandler = isExpressionReactive(binding.expr, ctx)
        const prevWrapTracked = ctx.wrapTrackedExpressions
        ctx.wrapTrackedExpressions = false
        const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion, {
          skipHookAccessors: true,
          skipRegionRootOverride: true,
        })
        ctx.wrapTrackedExpressions = prevWrapTracked
        const eventParam = t.identifier('_e')
        const isFn = t.isArrowFunctionExpression(valueExpr) || t.isFunctionExpression(valueExpr)
        const ensureHandlerParam = (fn: BabelCore.types.Expression): BabelCore.types.Expression => {
          if (t.isArrowFunctionExpression(fn)) {
            return fn
          }
          if (t.isFunctionExpression(fn)) {
            return fn
          }
          // Don't wrap identifiers and member expressions in arrow functions.
          // Arrow functions don't respect .call() for `this` binding.
          // The runtime's callEventHandler uses .call(element, event) to set `this` to the element.
          // By passing the function directly, the `this` binding works correctly.
          if (t.isIdentifier(fn) || t.isMemberExpression(fn)) {
            return fn
          }
          // For other expressions (e.g., conditional, call expression), wrap in a function
          // and defer invocation semantics to runtime callEventHandler.
          return t.functionExpression(
            null,
            [],
            t.blockStatement([t.returnStatement(fn as BabelCore.types.Expression)]),
          )
        }
        const handlerExpr =
          !isFn && shouldWrapHandler
            ? markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], valueExpr))
            : ensureHandlerParam(valueExpr)

        let dataBinding =
          isDelegated && !shouldWrapHandler
            ? extractDelegatedEventData(valueExpr, t, {
                isKnownHandlerIdentifier: name =>
                  ctx.functionVars?.has(deSSAVarName(name)) ?? false,
              })
            : null
        if (dataBinding && t.isIdentifier(dataBinding.handler)) {
          const handlerName = dataBinding.handler.name
          if (
            ctx.signalVars?.has(handlerName) ||
            ctx.memoVars?.has(handlerName) ||
            ctx.aliasVars?.has(handlerName) ||
            ctx.storeVars?.has(handlerName) ||
            ctx.trackedVars.has(handlerName)
          ) {
            dataBinding = null
          }
        }

        // Attempt data-binding for delegated events to avoid per-node closures
        if (isDelegated) {
          // Optimization: Direct property assignment for delegated events
          // This avoids creating cleanup functions and onDestroy registrations
          // The runtime's global event handler will pick up handlers stored as $$eventName
          ctx.delegatedEventsUsed?.add(eventName)

          // For reactive handlers (non-function expressions), we need to wrap them
          // so that when called, they resolve the handler and invoke it with the event
          // fix: Use regular function (not arrow) with .call(this, ...) to preserve `this` binding
          // The runtime's delegated event handler calls handlers with .call(element, event),
          // so we need to propagate `this` through to the actual handler.
          //
          // Critical: The AST nodes can be mutated by later processing steps. To preserve the
          // original identifier, we extract the name and create a fresh identifier node.
          let handlerName: string | null = null
          if (t.isIdentifier(valueExpr)) {
            handlerName = valueExpr.name
          }

          // Create a fresh identifier to avoid mutation issues
          const handlerForCall = handlerName
            ? t.identifier(handlerName)
            : t.cloneNode(valueExpr, true)
          const finalHandler =
            !isFn && shouldWrapHandler
              ? t.functionExpression(
                  null,
                  [eventParam],
                  t.blockStatement([
                    t.returnStatement(
                      t.callExpression(t.memberExpression(handlerForCall, t.identifier('call')), [
                        t.thisExpression(),
                        eventParam,
                      ]),
                    ),
                  ]),
                )
              : handlerExpr

          const normalizeHandler = (
            expr: BabelCore.types.Expression,
          ): BabelCore.types.Expression => {
            return expr
          }

          const normalizedDataHandler =
            dataBinding !== null
              ? normalizeHandler(
                  (dataBinding?.handler ?? handlerExpr) as BabelCore.types.Expression,
                )
              : null

          const dataForDelegate =
            dataBinding?.data &&
            (t.isArrowFunctionExpression(dataBinding.data) ||
            t.isFunctionExpression(dataBinding.data)
              ? dataBinding.data
              : isStaticDelegatedDataAst(dataBinding.data, ctx)
                ? dataBinding.data
                : markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], dataBinding.data)))

          const handlerForDelegate =
            normalizedDataHandler ??
            (dataBinding
              ? normalizeHandler(handlerExpr as BabelCore.types.Expression)
              : finalHandler)
          const handlerIsCallableExpr =
            t.isArrowFunctionExpression(handlerForDelegate) ||
            t.isFunctionExpression(handlerForDelegate) ||
            t.isIdentifier(handlerForDelegate) ||
            t.isMemberExpression(handlerForDelegate)

          const handlerToAssign: BabelCore.types.Expression = handlerIsCallableExpr
            ? handlerForDelegate
            : t.arrowFunctionExpression([eventParam], handlerForDelegate)

          ctx.helpersUsed.add('addEventListener')
          const delegatedValue = dataForDelegate
            ? t.arrayExpression([handlerToAssign, dataForDelegate])
            : handlerToAssign
          statements.push(
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.addEventListener), [
                targetId,
                t.stringLiteral(eventName),
                delegatedValue,
                t.booleanLiteral(true),
              ]),
            ),
          )
        } else {
          // Fallback: Use bindEvent for non-delegated events or events with options
          ctx.helpersUsed.add('bindEvent')
          ctx.helpersUsed.add('onDestroy')
          const cleanupId = genTemp(ctx, 'evt')
          const args: BabelCore.types.Expression[] = [
            targetId,
            t.stringLiteral(eventName),
            handlerExpr,
          ]
          if (hasEventOptions && binding.eventOptions) {
            const optionProps: BabelCore.types.ObjectProperty[] = []
            if (binding.eventOptions.capture) {
              optionProps.push(t.objectProperty(t.identifier('capture'), t.booleanLiteral(true)))
            }
            if (binding.eventOptions.passive) {
              optionProps.push(t.objectProperty(t.identifier('passive'), t.booleanLiteral(true)))
            }
            if (binding.eventOptions.once) {
              optionProps.push(t.objectProperty(t.identifier('once'), t.booleanLiteral(true)))
            }
            args.push(t.objectExpression(optionProps))
          }
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                cleanupId,
                t.callExpression(t.identifier(RUNTIME_ALIASES.bindEvent), args),
              ),
            ]),
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [cleanupId]),
            ),
          )
        }
      }
    } else if (binding.type === 'attr' && binding.name) {
      // Attribute binding
      const attrName = binding.name
      const valueWithRegion = lowerBindingValueExpression(binding.expr)
      const isReactiveAttr =
        !!binding.expr &&
        !isListKeyConstExpression(binding.expr, ctx) &&
        isExpressionReactive(binding.expr, ctx)

      if (attrName === 'ref') {
        ctx.helpersUsed.add('bindRef')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindRef), [targetId, valueWithRegion]),
          ),
        )
      } else if (attrName === 'class' || attrName === 'className') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.setClass), [targetId, valueWithRegion]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindClass), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setClass',
              fallbackHelper: 'bindClass',
            })
          ) {
            ctx.helpersUsed.add('bindClass')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setClass')
          statements.push(
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.setClass), [targetId, valueWithRegion]),
            ),
          )
        }
      } else if (attrName === 'style') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.setStyle), [targetId, valueWithRegion]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindStyle), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setStyle',
              fallbackHelper: 'bindStyle',
            })
          ) {
            ctx.helpersUsed.add('bindStyle')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setStyle')
          statements.push(
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.setStyle), [targetId, valueWithRegion]),
            ),
          )
        }
      } else if (isDOMProperty(attrName)) {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.setProp), [
              targetId,
              t.stringLiteral(attrName),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindProperty), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setProp',
              fallbackHelper: 'bindProperty',
            })
          ) {
            ctx.helpersUsed.add('bindProperty')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setProp')
          statements.push(
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.setProp), [
                targetId,
                t.stringLiteral(attrName),
                valueWithRegion,
              ]),
            ),
          )
        }
      } else {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.setAttr), [
              targetId,
              t.stringLiteral(attrName),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindAttribute), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setAttr',
              fallbackHelper: 'bindAttribute',
            })
          ) {
            ctx.helpersUsed.add('bindAttribute')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setAttr')
          statements.push(
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.setAttr), [
                targetId,
                t.stringLiteral(attrName),
                valueWithRegion,
              ]),
            ),
          )
        }
      }
    } else if (binding.type === 'key' && binding.expr) {
      statements.push(
        t.expressionStatement(lowerDomExpression(binding.expr, ctx, containingRegion)),
      )
    } else if (binding.type === 'text' && binding.expr) {
      const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      // Only use bindText for reactive expressions; static text uses direct assignment
      if (!isListKeyConstExpression(binding.expr, ctx) && isExpressionReactive(binding.expr, ctx)) {
        const patch = t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.setText), [targetId, valueExpr]),
        )
        const fallback = t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.bindText), [
            targetId,
            t.arrowFunctionExpression([], valueExpr),
          ]),
        )
        if (
          !queueFusedPatch(binding.expr, {
            patch,
            fallback,
            patchHelper: 'setText',
            fallbackHelper: 'bindText',
          })
        ) {
          ctx.helpersUsed.add('bindText')
          statements.push(fallback)
        }
      } else {
        // Static text: direct assignment - no effect needed
        statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(targetId, t.identifier('data')),
              t.callExpression(t.identifier('String'), [valueExpr]),
            ),
          ),
        )
      }
    } else if (binding.type === 'child' && binding.expr) {
      // Child binding (dynamic expression at placeholder)
      // Pass the binding's namespace to ensure correct SVG/MathML context
      emitHIRChildBinding(
        targetId,
        binding.expr,
        statements,
        ctx,
        containingRegion,
        createHIRChildBindingOps(),
        binding.namespace,
      )
    }
  }

  flushFusedPatchGroups()

  // Restore previous region
  applyRegionToContext(ctx, prevRegion ?? null)

  // Restore previous namespace context
  ctx.namespaceContext = prevNamespace

  // Return element
  statements.push(t.returnStatement(elId))

  const body = t.blockStatement(statements)

  // Wrap in memo if region suggests memoization
  if (shouldMemo && containingRegion) {
    // __fictUseMemo returns a getter function - invoke it to get the actual DOM element
    const memoBody = t.arrowFunctionExpression([], body)
    if (ctx.inModule) {
      return t.callExpression(t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [memoBody]), [])
    }
    const memoArgs: BabelCore.types.Expression[] = [t.identifier('__fictCtx'), memoBody]
    if (ctx.isComponentFn) {
      const slot = reserveHookSlot(ctx)
      if (slot >= 0) {
        memoArgs.push(t.numericLiteral(slot))
      }
    }
    return t.callExpression(t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), memoArgs), [])
  }

  // Wrap in IIFE
  return t.callExpression(t.arrowFunctionExpression([], body), [])
}

/**
 * Lower a JSX child to a Babel expression
 */
function lowerJSXChild(child: JSXChild, ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx

  if (child.kind === 'text') {
    return t.stringLiteral(child.value)
  } else if (child.kind === 'element') {
    return lowerJSXElement(child.value, ctx)
  } else {
    return applyRegionMetadataToExpression(lowerExpression(child.value, ctx), ctx)
  }
}

/**
 * Enhanced codegen that uses reactive scope information
 * This is the main entry point for HIR → fine-grained DOM generation
 */
export function codegenWithScopes(
  program: HIRProgram,
  scopes: ReactiveScopeResult | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  ctx.resumableEnabled = ctx.options?.resumable === true
  ctx.autoExtractEnabled = ctx.options?.autoExtractHandlers ?? ctx.resumableEnabled
  ctx.autoExtractThreshold = ctx.options?.autoExtractThreshold ?? 3
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.scopes = scopes

  // Mark tracked variables based on scope analysis
  if (scopes) {
    for (const scope of scopes.scopes) {
      for (const decl of scope.declarations) {
        const baseName = deSSAVarName(decl)
        ctx.trackedVars.add(baseName)
        // Derived variables (those with dependencies) are memos - shouldn't be cached
        if (scope.dependencies.size > 0) {
          ctx.memoVars?.add(baseName)
        }
      }
    }
  }

  const body: BabelCore.types.Statement[] = []
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithScopes(fn, ctx)
    if (funcStmt) body.push(funcStmt)
  }

  return t.file(t.program(body))
}

/**
 * Lower a function with reactive scope information
 */
function lowerFunctionWithScopes(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const params = buildOutputParams(fn, t)
  const statements: BabelCore.types.Statement[] = []

  // Emit instructions with scope-aware transformations
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      const stmt = lowerInstructionWithScopes(instr, ctx)
      if (stmt) statements.push(stmt)
    }
    statements.push(...lowerTerminator(block, ctx))
  }

  const result = setNodeLoc(
    t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements)),
    fn.loc,
  )
  result.async = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  result.generator = !!fn.meta?.isGenerator || functionHasYield(fn)
  return result
}

/**
 * Lower an instruction with reactive scope awareness
 */
function lowerInstructionWithScopes(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  const applyLoc = <T extends BabelCore.types.Statement | null>(stmt: T): T => {
    if (!stmt) return stmt
    const baseLoc =
      instr.loc ??
      (instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value.loc : undefined)
    return setNodeLoc(stmt, baseLoc) as T
  }

  if (instr.kind === 'Assign') {
    const targetName = instr.target.name
    const targetBase = deSSAVarName(targetName)
    const isFunctionDecl =
      instr.value.kind === 'FunctionExpression' &&
      (instr.declarationKind === 'function' ||
        (!instr.declarationKind && instr.value.name === targetBase))
    if (isFunctionDecl) {
      const loweredFn = lowerExpression(instr.value, ctx)
      if (t.isFunctionExpression(loweredFn)) {
        return applyLoc(
          t.functionDeclaration(
            t.identifier(targetBase),
            loweredFn.params as BabelCore.types.Identifier[],
            loweredFn.body as BabelCore.types.BlockStatement,
            loweredFn.generator ?? false,
            loweredFn.async ?? false,
          ),
        )
      }
    }
    const declKind = instr.declarationKind === 'function' ? undefined : instr.declarationKind
    let valueExpr: BabelCore.types.Expression
    if (declKind && getReactiveCallKind(instr.value, ctx) === 'signal') {
      ctx.signalVars?.add(targetBase)
      ctx.trackedVars.add(targetBase)
      ctx.currentAssignmentName = targetBase
      try {
        valueExpr = lowerExpression(instr.value, ctx)
      } finally {
        ctx.currentAssignmentName = undefined
      }
    } else {
      valueExpr = lowerExpression(instr.value, ctx)
    }

    // Check if target is a tracked variable (use de-versioned name for lookup)
    if (ctx.trackedVars.has(targetBase)) {
      // Wrap in memo if it depends on other tracked vars
      ctx.helpersUsed.add('useMemo')
      return applyLoc(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(targetName),
            t.callExpression(t.identifier('__fictUseMemo'), [
              t.arrowFunctionExpression([], valueExpr),
            ]),
          ),
        ]),
      )
    }

    // Check if this is a declaration or just an assignment
    if (declKind) {
      // Actual declaration - emit variableDeclaration
      return applyLoc(
        t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(targetName), valueExpr),
        ]),
      )
    } else {
      // Pure assignment (e.g. api = {...}) - emit assignmentExpression to update existing variable
      return applyLoc(
        t.expressionStatement(t.assignmentExpression('=', t.identifier(targetName), valueExpr)),
      )
    }
  }

  if (instr.kind === 'Expression') {
    return applyLoc(t.expressionStatement(lowerExpression(instr.value, ctx)))
  }

  return applyLoc(null)
}

// ============================================================================
// Region-Based Codegen (P0 Integration)
// ============================================================================

interface MacroAliases {
  state?: Set<string>
  effect?: Set<string>
  memo?: Set<string>
}

/**
 * Lower HIR to Babel AST with full region-based reactive scope analysis.
 * This is the P0 integration point that bridges:
 * - HIR analysis passes (scopes, shapes, control flow)
 * - Region generation (scope-to-region conversion)
 * - Fine-grained DOM helpers (memo wrappers, bindings)
 */
export function lowerHIRWithRegions(
  program: HIRProgram,
  t: typeof BabelCore.types,
  options?: FictCompilerOptions,
  macroAliases?: MacroAliases,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.options = options
  ctx.resumableEnabled = options?.resumable === true
  // Auto-extract defaults to true when resumable is enabled, unless explicitly disabled
  ctx.autoExtractEnabled = options?.autoExtractHandlers ?? options?.resumable === true
  ctx.autoExtractThreshold = options?.autoExtractThreshold ?? 3
  const body: BabelCore.types.Statement[] = []
  const topLevelAliases = new Set<string>()
  let topLevelCtxInjected = false
  const emittedFunctionNames = new Set<string>()
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]
  ctx.moduleDeclaredNames = collectDeclaredNames(originalBody, t)
  const runtimeImports = collectRuntimeImports(originalBody, t)
  ctx.moduleRuntimeNames = runtimeImports.names
  ctx.moduleRuntimeImportMap = runtimeImports.importMap
  ctx.moduleRuntimeNamespaceImports = runtimeImports.namespaces
  applyImportedReactiveMetadata(originalBody, ctx, t, options, {
    setImportedHookInfo(localName, info) {
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(localName, deserializeHookReturnInfo(info))
    },
  })
  const stateMacroNames = new Set<string>(['$state', ...(macroAliases?.state ?? [])])
  const memoMacroNames = new Set<string>(macroAliases?.memo ?? ctx.memoMacroNames ?? [])
  if (!memoMacroNames.has('$memo')) memoMacroNames.add('$memo')
  if (!memoMacroNames.has('createMemo')) memoMacroNames.add('createMemo')
  ctx.stateMacroNames = stateMacroNames
  ctx.memoMacroNames = memoMacroNames

  // Pre-mark top-level tracked variables so nested functions can treat captured signals as reactive
  for (const stmt of originalBody) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (
          t.isIdentifier(decl.id) &&
          decl.init &&
          (t.isCallExpression(decl.init) || t.isOptionalCallExpression(decl.init))
        ) {
          const callKind = getReactiveCallKindFromBabel(decl.init, ctx, t)
          if (callKind === 'signal') {
            ctx.trackedVars.add(decl.id.name)
          } else if (callKind === 'store') {
            ctx.trackedVars.add(decl.id.name)
            ctx.storeVars?.add(decl.id.name)
          }
        }
      }
    }
  }
  const ensureTopLevelCtx = () => {
    if (topLevelCtxInjected) return
    ctx.helpersUsed.add('pushContext')
    body.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__fictCtx'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.pushContext), []),
        ),
      ]),
    )
    topLevelCtxInjected = true
  }

  // Map generated functions by name for replacement when walking original body
  const generatedFunctions = new Map<
    string,
    { fn: HIRFunction; stmt: BabelCore.types.FunctionDeclaration }
  >()
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithRegions(fn, ctx)
    if (funcStmt && fn.name) {
      generatedFunctions.set(fn.name, { fn, stmt: funcStmt })
    } else if (funcStmt && !fn.name) {
      // Anonymous function - emit immediately
      body.push(funcStmt)
    }
  }

  const lowerableBuffer: BabelCore.types.Statement[] = []
  let segmentCounter = 0

  const flushLowerableBuffer = () => {
    if (lowerableBuffer.length === 0) return
    const { statements, aliases } = lowerTopLevelStatementBlock(
      lowerableBuffer,
      ctx,
      t,
      `__module_segment_${segmentCounter++}`,
      topLevelAliases,
    )
    topLevelAliases.clear()
    aliases.forEach(a => topLevelAliases.add(a))
    if (statements.length > 0 && ctx.needsCtx && !topLevelCtxInjected) {
      ensureTopLevelCtx()
    }
    body.push(...statements)
    lowerableBuffer.length = 0
  }

  // Rebuild program body preserving original order
  for (const stmt of originalBody as BabelCore.types.Statement[]) {
    if (t.isImportDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
      continue
    }

    if (t.isBlockStatement(stmt)) {
      flushLowerableBuffer()
      const { statements, aliases } = lowerTopLevelStatementBlock(
        stmt.body as BabelCore.types.Statement[],
        ctx,
        t,
        `__block_segment_${segmentCounter++}`,
        topLevelAliases,
      )
      topLevelAliases.clear()
      aliases.forEach(a => topLevelAliases.add(a))
      body.push(t.blockStatement(statements))
      continue
    }

    // Function declarations
    if (t.isFunctionDeclaration(stmt) && stmt.id?.name) {
      flushLowerableBuffer()
      const generated = generatedFunctions.get(stmt.id.name)
      if (generated) {
        body.push(generated.stmt)
        generatedFunctions.delete(stmt.id.name)
        emittedFunctionNames.add(stmt.id.name)
        continue
      }
      body.push(stmt)
      emittedFunctionNames.add(stmt.id.name)
      continue
    }

    // Export named with function declaration
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      flushLowerableBuffer()
      if (t.isFunctionDeclaration(stmt.declaration) && stmt.declaration.id?.name) {
        const name = stmt.declaration.id.name
        const generated = generatedFunctions.get(name)
        if (generated) {
          body.push(t.exportNamedDeclaration(generated.stmt, []))
          generatedFunctions.delete(name)
          emittedFunctionNames.add(name)
          continue
        }
      }
      if (t.isVariableDeclaration(stmt.declaration)) {
        // Split generated function declarations from remaining declarators
        const remainingDeclarators: typeof stmt.declaration.declarations = []
        const generated: { fn: HIRFunction; stmt: BabelCore.types.FunctionDeclaration }[] = []

        for (const decl of stmt.declaration.declarations) {
          if (t.isIdentifier(decl.id)) {
            const found = generatedFunctions.get(decl.id.name)
            if (found) {
              generated.push(found)
              generatedFunctions.delete(decl.id.name)
              continue
            }
          }
          remainingDeclarators.push(decl)
        }

        if (generated.length > 0) {
          flushLowerableBuffer()
          for (const entry of generated) {
            body.push(t.exportNamedDeclaration(entry.stmt, []))
            if (entry.stmt.id?.name) emittedFunctionNames.add(entry.stmt.id.name)
          }
          if (remainingDeclarators.length > 0) {
            body.push(
              t.exportNamedDeclaration(
                t.variableDeclaration(stmt.declaration.kind, remainingDeclarators),
                [],
              ),
            )
          }
          continue
        }

        const { statements, aliases } = lowerTopLevelStatementBlock(
          [stmt.declaration],
          ctx,
          t,
          `__export_segment_${segmentCounter++}`,
          topLevelAliases,
        )
        topLevelAliases.clear()
        aliases.forEach(a => topLevelAliases.add(a))
        if (statements.length > 0) {
          if (ctx.needsCtx && !topLevelCtxInjected) {
            ensureTopLevelCtx()
          }
          statements
            .filter(s => t.isDeclaration(s))
            .forEach(d => body.push(t.exportNamedDeclaration(d as BabelCore.types.Declaration, [])))
          continue
        }
      }
      body.push(stmt)
      continue
    }

    if (t.isExportNamedDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
      continue
    }

    // Export default function declaration
    if (t.isExportDefaultDeclaration(stmt) && t.isFunctionDeclaration(stmt.declaration)) {
      flushLowerableBuffer()
      const name = stmt.declaration.id?.name ?? '__default'
      const generated = generatedFunctions.get(name)
      if (generated) {
        body.push(t.exportDefaultDeclaration(generated.stmt))
        generatedFunctions.delete(name)
        emittedFunctionNames.add(name)
        continue
      }
      body.push(stmt)
      if (stmt.declaration.id?.name) emittedFunctionNames.add(stmt.declaration.id.name)
      continue
    }

    if (t.isExportDefaultDeclaration(stmt) || t.isExportAllDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
      continue
    }

    // Variable declarations that were converted to generated functions
    if (t.isVariableDeclaration(stmt)) {
      const remainingDeclarators: typeof stmt.declarations = []
      let rebuilt = false
      const rebuiltDeclarators: typeof stmt.declarations = []

      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id)) {
          const found = generatedFunctions.get(decl.id.name)
          if (found) {
            rebuilt = true
            let arrowBody: BabelCore.types.BlockStatement | BabelCore.types.Expression =
              found.stmt.body
            if (found.fn.meta?.isArrow && t.isBlockStatement(found.stmt.body)) {
              const bodyStatements = found.stmt.body.body
              if (
                bodyStatements.length === 1 &&
                t.isReturnStatement(bodyStatements[0]) &&
                bodyStatements[0].argument
              ) {
                arrowBody = bodyStatements[0].argument
              }
            }
            const shouldUseArrow = !!(found.fn.meta?.isArrow && found.fn.meta?.hasExpressionBody)
            const funcExpr = found.fn.meta?.fromExpression
              ? found.fn.meta.isArrow
                ? shouldUseArrow
                  ? t.arrowFunctionExpression(found.stmt.params, arrowBody)
                  : t.functionExpression(
                      t.isIdentifier(decl.id) ? t.identifier(decl.id.name) : null,
                      found.stmt.params,
                      found.stmt.body,
                    )
                : t.functionExpression(null, found.stmt.params, found.stmt.body)
              : t.functionExpression(
                  found.stmt.id ? t.identifier(found.stmt.id.name) : null,
                  found.stmt.params,
                  found.stmt.body,
                  found.stmt.generator,
                  found.stmt.async,
                )
            if (found.fn.meta?.isAsync) {
              if (t.isArrowFunctionExpression(funcExpr) || t.isFunctionExpression(funcExpr)) {
                funcExpr.async = true
              }
            }
            if (t.isFunctionExpression(funcExpr)) {
              funcExpr.generator = !!(found.fn.meta?.isGenerator || found.stmt.generator)
            }
            rebuiltDeclarators.push(t.variableDeclarator(decl.id, funcExpr))
            generatedFunctions.delete(decl.id.name)
            continue
          }
        }
        remainingDeclarators.push(decl)
        rebuiltDeclarators.push(decl)
      }

      if (rebuilt) {
        flushLowerableBuffer()
        if (rebuiltDeclarators.length > 0) {
          lowerableBuffer.push(t.variableDeclaration(stmt.kind, rebuiltDeclarators))
        } else if (remainingDeclarators.length > 0) {
          lowerableBuffer.push(t.variableDeclaration(stmt.kind, remainingDeclarators))
        }
        continue
      }
    }

    lowerableBuffer.push(stmt)
  }

  flushLowerableBuffer()

  if (
    ctx.resumableEnabled &&
    ctx.hoistedResumableStatements &&
    ctx.hoistedResumableStatements.length > 0
  ) {
    body.push(...ctx.hoistedResumableStatements)
  }

  // Emit any remaining generated functions (not present in original order)
  for (const func of generatedFunctions.values()) {
    body.push(func.stmt)
    if (func.stmt.id?.name) emittedFunctionNames.add(func.stmt.id.name)
  }

  if (topLevelCtxInjected) {
    ctx.helpersUsed.add('popContext')
    body.push(t.expressionStatement(t.callExpression(t.identifier(RUNTIME_ALIASES.popContext), [])))
  }

  const moduleMeta = buildModuleReactiveMetadata(originalBody, ctx, t, options, {
    getLocalHookInfo(localName) {
      const info = getHookReturnInfo(localName, ctx)
      return info ? serializeHookReturnInfo(info) : undefined
    },
  })
  setModuleMetadata(options?.filename, moduleMeta, options)
  return t.file(t.program(attachHelperImports(ctx, body, t)))
}

/**
 * Lower a sequence of top-level statements (non-import/export) using the HIR region path.
 */
function lowerTopLevelStatementBlock(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  name = '__module_segment',
  existingAliases?: Set<string>,
): { statements: BabelCore.types.Statement[]; aliases: Set<string> } {
  if (statements.length === 0) return { statements: [], aliases: new Set() }

  const reactiveScopes = ctx.options?.reactiveScopes
  const fn = convertStatementsToHIRFunction(
    name,
    statements,
    reactiveScopes && reactiveScopes.length > 0
      ? { reactiveScopes: new Set(reactiveScopes) }
      : undefined,
  )
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult, ctx)
  ctx.scopes = scopeResult

  const regionResult = generateRegions(fn, scopeResult)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)
  if (ctx.nextHookSlot === undefined) {
    ctx.nextHookSlot = HOOK_SLOT_BASE
  }
  const aliasVars = existingAliases ? new Set(existingAliases) : new Set<string>()
  ctx.aliasVars = aliasVars

  const functionVars = ctx.functionVars ?? new Set<string>()
  const signalVars = ctx.signalVars ?? new Set<string>()
  const storeVars = ctx.storeVars ?? new Set<string>()
  const memoVars = ctx.memoVars ?? new Set<string>()
  const mutatedVars = new Set<string>()
  ctx.functionVars = functionVars
  ctx.signalVars = signalVars
  ctx.storeVars = storeVars
  ctx.memoVars = memoVars
  ctx.mutatedVars = mutatedVars

  // Initialize componentFunctionDefs for this component to track function definitions
  // These may need to be hoisted for handler dependency resolution
  const componentFunctionDefs = ctx.componentFunctionDefs ?? new Map<string, Expression>()
  ctx.componentFunctionDefs = componentFunctionDefs

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          functionVars.add(target)
          // Store the HIR expression for potential hoisting in handlers
          componentFunctionDefs.set(target, instr.value)
        }
        if (
          instr.value.kind === 'CallExpression' ||
          instr.value.kind === 'OptionalCallExpression'
        ) {
          const callKind = getReactiveCallKind(instr.value, ctx)
          if (callKind === 'signal') {
            signalVars.add(target)
          } else if (callKind === 'store') {
            storeVars.add(target)
          } else if (callKind === 'memo') {
            memoVars.add(target)
          }
        }
        if (!instr.declarationKind) {
          mutatedVars.add(target)
        }
      } else if (instr.kind === 'Phi') {
        mutatedVars.add(deSSAVarName(instr.target.name))
      }
    }
  }
  collectMutatedIdentifiers(fn).forEach(name => mutatedVars.add(name))

  const reactive = computeReactiveAccessors(fn, ctx)
  ctx.trackedVars = reactive.tracked
  ctx.memoVars = reactive.memo
  ctx.controlDepsByInstr = reactive.controlDepsByInstr
  if (fn.name && isHookName(fn.name)) {
    const info = analyzeHookReturnInfo(fn, ctx)
    if (info) {
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(fn.name, info)
    }
  }

  const prevInModule = ctx.inModule
  ctx.inModule = true
  try {
    const lowered = generateRegionCode(fn, scopeResult, t, ctx)
    return { statements: lowered, aliases: aliasVars }
  } finally {
    ctx.inModule = prevInModule
  }
}

function transformControlFlowReturns(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Statement[] | null {
  if (ctx.options?.lazyConditional === false) {
    return null
  }

  const { t } = ctx
  const reactiveAccessorNames = new Set<string>([
    ...ctx.trackedVars,
    ...(ctx.signalVars ?? []),
    ...(ctx.memoVars ?? []),
    ...(ctx.aliasVars ?? []),
    ...(ctx.storeVars ?? []),
  ])

  const toStatements = (node: BabelCore.types.Statement | BabelCore.types.BlockStatement) =>
    t.isBlockStatement(node) ? node.body : [node]

  const endsWithReturn = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    const tail = stmts[stmts.length - 1]!
    if (t.isReturnStatement(tail)) return true
    if (t.isBlockStatement(tail)) {
      return endsWithReturn(tail.body)
    }
    if (t.isIfStatement(tail) && tail.consequent && tail.alternate) {
      const conseqStmts = toStatements(tail.consequent)
      const altStmts = toStatements(tail.alternate)
      return endsWithReturn(conseqStmts) && endsWithReturn(altStmts)
    }
    if (t.isTryStatement(tail)) {
      if (tail.finalizer && endsWithReturn(tail.finalizer.body)) return true
      if (!tail.handler) return false
      return endsWithReturn(tail.block.body) && endsWithReturn(tail.handler.body.body)
    }
    return false
  }

  function hasNodeMatch(
    nodes: BabelCore.types.Node[],
    predicate: (node: BabelCore.types.Node) => boolean,
    options?: { skipNestedFunctions?: boolean },
  ): boolean {
    let found = false

    const visit = (node: BabelCore.types.Node | null | undefined, isRoot = false): void => {
      if (!node || found) return
      if (
        !isRoot &&
        options?.skipNestedFunctions &&
        (t.isFunctionExpression(node) ||
          t.isArrowFunctionExpression(node) ||
          t.isFunctionDeclaration(node) ||
          t.isObjectMethod(node) ||
          t.isClassMethod(node))
      ) {
        return
      }
      if (predicate(node)) {
        found = true
        return
      }

      const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
      const visitorKeys = keys?.[(node as { type: string }).type] ?? []
      for (const key of visitorKeys) {
        const value = (node as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in (child as object)) {
              visit(child as BabelCore.types.Node)
            }
            if (found) return
          }
        } else if (value && typeof value === 'object' && 'type' in (value as object)) {
          visit(value as BabelCore.types.Node)
        }
        if (found) return
      }
    }

    for (const node of nodes) {
      visit(node, true)
      if (found) return true
    }

    return found
  }

  const containsReturnStatement = (nodes: BabelCore.types.Node[]) =>
    hasNodeMatch(nodes, node => t.isReturnStatement(node))

  const getMemberRootIdentifier = (
    expr: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  ): BabelCore.types.Identifier | null => {
    let current: BabelCore.types.Expression = expr.object as BabelCore.types.Expression
    while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
      current = current.object as BabelCore.types.Expression
    }
    return t.isIdentifier(current) ? current : null
  }

  const containsReactiveAccessorRead = (
    nodes: BabelCore.types.Node[],
    options?: { skipNestedFunctions?: boolean },
  ) =>
    hasNodeMatch(
      nodes,
      node => {
        if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
          const callee = node.callee
          return t.isIdentifier(callee) && reactiveAccessorNames.has(callee.name)
        }
        if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
          const root = getMemberRootIdentifier(node)
          return !!(root && reactiveAccessorNames.has(root.name))
        }
        return false
      },
      options,
    )

  const containsReactiveControlFlowRead = (nodes: BabelCore.types.Node[]): boolean =>
    hasNodeMatch(
      nodes,
      node => {
        if (t.isIfStatement(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isSwitchStatement(node)) {
          return containsReactiveAccessorRead([node.discriminant], { skipNestedFunctions: true })
        }
        if (t.isConditionalExpression(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isForStatement(node)) {
          const parts: BabelCore.types.Node[] = []
          if (node.init) parts.push(node.init)
          if (node.test) parts.push(node.test)
          if (node.update) parts.push(node.update)
          return (
            parts.length > 0 && containsReactiveAccessorRead(parts, { skipNestedFunctions: true })
          )
        }
        if (t.isForOfStatement(node) || t.isForInStatement(node)) {
          return containsReactiveAccessorRead([node.right], { skipNestedFunctions: true })
        }
        return false
      },
      { skipNestedFunctions: true },
    )

  const hasRiskyBranchControlFlow = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    return containsReactiveControlFlowRead(stmts)
  }

  const isJSXLikeNode = (node: BabelCore.types.Node | null | undefined): boolean =>
    !!node && (t.isJSXElement(node) || t.isJSXFragment(node))

  const isStoreSourceExpression = (expr: BabelCore.types.Expression): boolean => {
    if (t.isIdentifier(expr)) {
      return !!ctx.storeVars?.has(expr.name)
    }
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
      const root = getMemberRootIdentifier(expr)
      return !!(root && ctx.storeVars?.has(root.name))
    }
    return false
  }

  const hasRiskyStoreDestructureRead = (stmt: BabelCore.types.Statement): boolean => {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (!decl.init) continue
        const hasPattern = t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)
        if (!hasPattern) continue
        if (isStoreSourceExpression(decl.init as BabelCore.types.Expression)) {
          return true
        }
      }
      return false
    }

    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      const assignment = stmt.expression
      const isPatternLhs = t.isObjectPattern(assignment.left) || t.isArrayPattern(assignment.left)
      if (!isPatternLhs) return false
      return isStoreSourceExpression(assignment.right as BabelCore.types.Expression)
    }

    return false
  }

  const hasRiskyBranchPreludeReads = (stmts: BabelCore.types.Statement[]): boolean => {
    for (const stmt of stmts) {
      if (hasRiskyStoreDestructureRead(stmt)) {
        return true
      }
      if (t.isReturnStatement(stmt)) {
        const arg = stmt.argument
        if (!arg || isJSXLikeNode(arg)) continue
        if (containsReactiveAccessorRead([arg], { skipNestedFunctions: true })) {
          return true
        }
        continue
      }
      if (containsReactiveAccessorRead([stmt], { skipNestedFunctions: true })) {
        return true
      }
    }
    return false
  }

  const hasRiskyImmediateInvocationReads = (stmts: BabelCore.types.Statement[]): boolean =>
    hasNodeMatch(
      stmts,
      node => {
        if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return false
        const callee = node.callee
        if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) {
          return false
        }
        const bodyNodes = t.isBlockStatement(callee.body) ? callee.body.body : [callee.body]
        return containsReactiveAccessorRead(bodyNodes, { skipNestedFunctions: true })
      },
      { skipNestedFunctions: true },
    )

  const needsTrackedBranchReads = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    return (
      hasRiskyBranchControlFlow(stmts) ||
      hasRiskyBranchPreludeReads(stmts) ||
      hasRiskyImmediateInvocationReads(stmts)
    )
  }

  const emitControlFlowFallbackWarning = (
    node: BabelCore.types.Node,
    kind: 'if' | 'switch',
  ): void => {
    const onWarn = ctx.options?.onWarn
    if (!onWarn) return
    const loc = node.loc?.start
    onWarn({
      code: DiagnosticCode.FICT_R003,
      message:
        `Reactive ${kind}-return lowering was skipped for this branch. ` +
        `The branch structure will not update reactively; refactor to a supported ` +
        `${kind} form or use explicit runtime conditionals.`,
      fileName: ctx.options?.filename ?? '<unknown>',
      line: loc?.line ?? 0,
      column: loc ? loc.column + 1 : 0,
    })
  }

  function buildReturnBlock(
    stmts: BabelCore.types.Statement[],
  ): BabelCore.types.Statement[] | null {
    if (stmts.length === 0) return null
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      if (!t.isIfStatement(stmt)) continue
      const conditionalExpr = buildConditionalExpr(stmt, stmts.slice(i + 1))
      if (conditionalExpr) {
        const prefix = stmts.slice(0, i)
        return [...prefix, t.returnStatement(conditionalExpr)]
      }
    }
    if (!endsWithReturn(stmts)) return null
    return stmts
  }

  function buildBranchFunction(
    stmts: BabelCore.types.Statement[],
    options?: { disallowRenderHooks?: boolean },
  ): BabelCore.types.ArrowFunctionExpression | null {
    const block = buildReturnBlock(stmts)
    if (!block) return null
    if (options?.disallowRenderHooks && containsRenderOnlyHooks(block)) return null
    return t.arrowFunctionExpression([], t.blockStatement(block))
  }

  function containsRenderOnlyHooks(nodes: BabelCore.types.Node[]): boolean {
    let found = false

    const visit = (node: BabelCore.types.Node | null | undefined): void => {
      if (!node || found) return

      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const callee = node.callee
        if (t.isIdentifier(callee) && callee.name.startsWith('__fictUse')) {
          if (callee.name !== '__fictUseEffect') {
            found = true
            return
          }
        }
      }

      const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
      const visitorKeys = keys?.[(node as { type: string }).type] ?? []
      for (const key of visitorKeys) {
        const value = (node as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in (child as object)) {
              visit(child as BabelCore.types.Node)
            }
            if (found) return
          }
        } else if (value && typeof value === 'object' && 'type' in (value as object)) {
          visit(value as BabelCore.types.Node)
        }
        if (found) return
      }
    }

    for (const node of nodes) {
      visit(node)
      if (found) break
    }

    return found
  }

  function buildConditionalBindingExpr(
    testExpr: BabelCore.types.Expression,
    trueFn: BabelCore.types.ArrowFunctionExpression,
    falseFn: BabelCore.types.ArrowFunctionExpression,
    options?: { trackBranchReads?: boolean },
  ): BabelCore.types.Expression {
    ctx.helpersUsed.add('conditional')
    ctx.helpersUsed.add('createElement')
    ctx.helpersUsed.add('onDestroy')
    const bindingId = genTemp(ctx, 'cond')
    const args: BabelCore.types.Expression[] = [
      t.arrowFunctionExpression([], testExpr),
      trueFn,
      t.identifier(RUNTIME_ALIASES.createElement),
      falseFn,
    ]
    if (options?.trackBranchReads) {
      const undefinedExpr = t.unaryExpression('void', t.numericLiteral(0))
      args.push(
        undefinedExpr,
        t.cloneNode(undefinedExpr) as BabelCore.types.Expression,
        t.objectExpression([
          t.objectProperty(t.identifier('trackBranchReads'), t.booleanLiteral(true)),
        ]),
      )
    }
    const bindingCall = t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), args)

    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.variableDeclaration('const', [t.variableDeclarator(bindingId, bindingCall)]),
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
              t.memberExpression(bindingId, t.identifier('dispose')),
            ]),
          ),
          t.returnStatement(bindingId),
        ]),
      ),
      [],
    )
  }

  function buildConditionalExpr(
    ifStmt: BabelCore.types.IfStatement,
    rest: BabelCore.types.Statement[],
  ): BabelCore.types.Expression | null {
    const consequentStmts = toStatements(ifStmt.consequent)
    if (!endsWithReturn(consequentStmts)) return null

    let alternateStmts: BabelCore.types.Statement[]
    if (ifStmt.alternate) {
      if (rest.length > 0) return null
      alternateStmts = toStatements(ifStmt.alternate)
      if (!endsWithReturn(alternateStmts)) return null
    } else {
      if (rest.length === 0) return null
      alternateStmts = rest
      if (!buildReturnBlock(alternateStmts)) return null
    }

    const trueFn = buildBranchFunction(consequentStmts)
    const falseFn = buildBranchFunction(alternateStmts)
    if (!trueFn || !falseFn) return null
    const shouldTrackBranchReads =
      needsTrackedBranchReads(consequentStmts) || needsTrackedBranchReads(alternateStmts)

    return buildConditionalBindingExpr(
      ifStmt.test as BabelCore.types.Expression,
      trueFn,
      falseFn,
      shouldTrackBranchReads ? { trackBranchReads: true } : undefined,
    )
  }

  function isSupportedSwitchDiscriminant(_expr: BabelCore.types.Expression): boolean {
    // Any expression can participate in switch lowering; the discriminant will be
    // re-used in branch predicates just like a lowered if/else chain.
    return true
  }

  function buildSwitchConditionalExpr(
    switchStmt: BabelCore.types.SwitchStatement,
    rest: BabelCore.types.Statement[],
  ): BabelCore.types.Expression | null {
    const discriminant = switchStmt.discriminant as BabelCore.types.Expression
    if (!isSupportedSwitchDiscriminant(discriminant)) return null

    interface SwitchBranch {
      tests: BabelCore.types.Expression[]
      statements: BabelCore.types.Statement[]
    }

    const trailingStatements = rest.length > 0 ? buildReturnBlock([...rest]) : []
    if (rest.length > 0 && !trailingStatements) return null

    const caseEntryCache = new Map<number, BabelCore.types.Statement[] | null>()
    const resolveCaseEntry = (startIndex: number): BabelCore.types.Statement[] | null => {
      if (caseEntryCache.has(startIndex)) {
        return caseEntryCache.get(startIndex) ?? null
      }

      const entry: BabelCore.types.Statement[] = []
      for (let i = startIndex; i < switchStmt.cases.length; i++) {
        const currentCase = switchStmt.cases[i]!
        const consequent = currentCase.consequent

        for (let stmtIndex = 0; stmtIndex < consequent.length; stmtIndex++) {
          const stmt = consequent[stmtIndex]!
          if (t.isBreakStatement(stmt)) {
            if (stmt.label || stmtIndex !== consequent.length - 1) {
              caseEntryCache.set(startIndex, null)
              return null
            }
            if (!trailingStatements || trailingStatements.length === 0) {
              caseEntryCache.set(startIndex, null)
              return null
            }
            const withTrailing = [...entry, ...trailingStatements]
            caseEntryCache.set(startIndex, withTrailing)
            return withTrailing
          }
          if (t.isContinueStatement(stmt)) {
            caseEntryCache.set(startIndex, null)
            return null
          }
          entry.push(stmt)
        }

        if (endsWithReturn(entry)) {
          caseEntryCache.set(startIndex, entry)
          return entry
        }
      }

      if (!trailingStatements || trailingStatements.length === 0) {
        caseEntryCache.set(startIndex, null)
        return null
      }
      const withTrailing = [...entry, ...trailingStatements]
      caseEntryCache.set(startIndex, withTrailing)
      return withTrailing
    }

    const branches: SwitchBranch[] = []
    let defaultStatements: BabelCore.types.Statement[] | null = null
    for (let i = 0; i < switchStmt.cases.length; i++) {
      const caseNode = switchStmt.cases[i]!
      const statements = resolveCaseEntry(i)
      if (!statements) return null

      if (caseNode.test) {
        branches.push({
          tests: [caseNode.test as BabelCore.types.Expression],
          statements,
        })
      } else {
        defaultStatements = statements
      }
    }

    if (branches.length === 0 && !defaultStatements) return null

    const fallbackStatements = defaultStatements ?? trailingStatements
    if (!fallbackStatements || fallbackStatements.length === 0) return null
    const fallbackFn = buildBranchFunction(fallbackStatements, { disallowRenderHooks: true })
    if (!fallbackFn) return null

    // Preserve switch discriminant semantics: compute once per reactive evaluation
    // and reuse across case predicate checks.
    ctx.helpersUsed.add('memo')
    const discriminantAccessor = genTemp(ctx, 'switchDisc')
    const discriminantMemoDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        discriminantAccessor,
        t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [
          t.arrowFunctionExpression(
            [],
            t.cloneNode(discriminant, true) as BabelCore.types.Expression,
          ),
        ]),
      ),
    ])

    let currentExpr: BabelCore.types.Expression = t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement((fallbackFn.body as BabelCore.types.BlockStatement).body),
      ),
      [],
    )
    let currentExprNeedsTrackedBranchReads = needsTrackedBranchReads(fallbackStatements)

    for (let i = branches.length - 1; i >= 0; i--) {
      const branch = branches[i]!
      const trueFn = buildBranchFunction(branch.statements, { disallowRenderHooks: true })
      if (!trueFn) return null
      const trueBranchNeedsTrackedBranchReads = needsTrackedBranchReads(branch.statements)
      const trackBranchReads =
        trueBranchNeedsTrackedBranchReads || currentExprNeedsTrackedBranchReads

      const falseFn = t.arrowFunctionExpression(
        [],
        t.blockStatement([t.returnStatement(currentExpr)]),
      )
      const comparisons: BabelCore.types.Expression[] = branch.tests.map(test =>
        t.binaryExpression(
          '===',
          t.callExpression(t.cloneNode(discriminantAccessor), []),
          t.cloneNode(test, true) as BabelCore.types.Expression,
        ),
      )
      if (comparisons.length === 0) return null
      const testExpr = comparisons
        .slice(1)
        .reduce<BabelCore.types.Expression>(
          (acc, expr) => t.logicalExpression('||', acc, expr),
          comparisons[0]!,
        )
      currentExpr = buildConditionalBindingExpr(
        testExpr,
        trueFn,
        falseFn,
        trackBranchReads ? { trackBranchReads: true } : undefined,
      )
      currentExprNeedsTrackedBranchReads = trackBranchReads
    }

    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([discriminantMemoDecl, t.returnStatement(currentExpr)]),
      ),
      [],
    )
  }

  let nestedChanged = false
  const rewrittenStatements = statements.map(stmt => {
    if (!t.isTryStatement(stmt)) return stmt

    const transformedTryBlock = transformControlFlowReturns(stmt.block.body, ctx)
    const nextTryBlockBody = transformedTryBlock ?? stmt.block.body

    let nextHandler = stmt.handler
    if (stmt.handler) {
      const transformedCatchBlock = transformControlFlowReturns(stmt.handler.body.body, ctx)
      if (transformedCatchBlock) {
        nextHandler = t.catchClause(
          stmt.handler.param
            ? (t.cloneNode(stmt.handler.param, true) as BabelCore.types.CatchClause['param'])
            : null,
          t.blockStatement(transformedCatchBlock),
        )
      }
    }

    let nextFinalizer = stmt.finalizer
    if (stmt.finalizer) {
      const transformedFinalizer = transformControlFlowReturns(stmt.finalizer.body, ctx)
      if (transformedFinalizer) {
        nextFinalizer = t.blockStatement(transformedFinalizer)
      }
    }

    if (!transformedTryBlock && nextHandler === stmt.handler && nextFinalizer === stmt.finalizer) {
      return stmt
    }

    nestedChanged = true
    return t.tryStatement(
      t.blockStatement(nextTryBlockBody),
      nextHandler,
      nextFinalizer ? (t.cloneNode(nextFinalizer, true) as BabelCore.types.BlockStatement) : null,
    )
  })

  for (let i = 0; i < rewrittenStatements.length; i++) {
    const stmt = rewrittenStatements[i]
    if (!t.isIfStatement(stmt)) continue
    const rest = rewrittenStatements.slice(i + 1)
    const conditionalExpr = buildConditionalExpr(stmt, rest)
    if (!conditionalExpr) {
      const hasReturn = containsReturnStatement([stmt, ...rest])
      const hasReactiveReads = containsReactiveAccessorRead([stmt, ...rest])
      if (hasReturn && hasReactiveReads) {
        emitControlFlowFallbackWarning(stmt, 'if')
      }
      continue
    }
    const prefix = rewrittenStatements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  for (let i = 0; i < rewrittenStatements.length; i++) {
    const stmt = rewrittenStatements[i]
    if (!t.isSwitchStatement(stmt)) continue
    const rest = rewrittenStatements.slice(i + 1)
    const conditionalExpr = buildSwitchConditionalExpr(stmt, rest)
    if (!conditionalExpr) {
      const hasReturn = containsReturnStatement([stmt, ...rest])
      const hasReactiveReads = containsReactiveAccessorRead([stmt, ...rest])
      if (hasReturn && hasReactiveReads) {
        emitControlFlowFallbackWarning(stmt, 'switch')
      }
      continue
    }
    const prefix = rewrittenStatements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  return nestedChanged ? rewrittenStatements : null
}

/**
 * Lower a function with region-based code generation
 */
function lowerFunctionWithRegions(
  fn: HIRFunction,
  ctx: CodegenContext,
  options?: { forceHookContext?: boolean },
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const prevSignalVars = ctx.signalVars
  const prevFunctionVars = ctx.functionVars
  const prevMemoVars = ctx.memoVars
  const prevStoreVars = ctx.storeVars
  const prevMutatedVars = ctx.mutatedVars
  const prevAliasVars = ctx.aliasVars
  const prevNoMemo = ctx.noMemo
  const prevWrapTracked = ctx.wrapTrackedExpressions
  const prevIsComponent = ctx.isComponentFn
  const prevHookResultVarMap = ctx.hookResultVarMap
  const prevInModule = ctx.inModule
  const scopedTracked = new Set(ctx.trackedVars)
  const shadowedParams = new Set(fn.params.map(p => deSSAVarName(p.name)))
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  const prevNeedsCtx = ctx.needsCtx
  ctx.needsCtx = false
  ctx.inModule = false
  const prevShadowed = ctx.shadowedNames
  const functionShadowed = new Set(prevShadowed ?? [])
  shadowedParams.forEach(n => functionShadowed.add(n))
  ctx.shadowedNames = functionShadowed
  const prevLocalDeclared = ctx.localDeclaredNames
  const localDeclared = new Set(prevLocalDeclared ?? [])
  for (const name of collectLocalDeclaredNames(fn.params, fn.blocks, t)) {
    localDeclared.add(name)
  }
  ctx.localDeclaredNames = localDeclared
  const prevExternalTracked = ctx.externalTracked
  const inheritedTracked = new Set(ctx.trackedVars)
  ctx.externalTracked = inheritedTracked
  // Always ensure context exists to support memo/region wrappers
  ctx.aliasVars = new Set(prevAliasVars ?? [])
  ctx.signalVars = new Set(prevSignalVars ?? [])
  ctx.functionVars = new Set(prevFunctionVars ?? [])
  ctx.memoVars = new Set(prevMemoVars ?? [])
  ctx.storeVars = new Set(prevStoreVars ?? [])
  ctx.mutatedVars = new Set()
  ctx.noMemo = !!(prevNoMemo || fn.meta?.noMemo)
  ctx.hookResultVarMap = new Map()
  // Save and initialize componentFunctionDefs for this function scope
  const prevComponentFunctionDefs = ctx.componentFunctionDefs
  ctx.componentFunctionDefs = new Map()
  const hookResultVars = new Set<string>()
  const hookAccessorAliases = new Set<string>()
  const prevPropsParam = ctx.propsParamName
  const prevPropAccessors = ctx.propAccessorDecls
  ctx.propAccessorDecls = new Map()
  const prevDelegatedEventsUsed = ctx.delegatedEventsUsed
  ctx.delegatedEventsUsed = new Set()
  const calledIdentifiers = collectCalledIdentifiers(fn)
  const propsPlanAliases = new Set<string>()
  let propsDestructurePlan: {
    statements: BabelCore.types.Statement[]
    usesProp: boolean
    usesPropsRest: boolean
  } | null = null

  // Collect function-valued bindings, signals, and mutation info in this function
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          ctx.functionVars?.add(target)
          // Store HIR expression for potential hoisting in resumable handlers
          ctx.componentFunctionDefs?.set(target, instr.value)
        }
        if (
          instr.value.kind === 'CallExpression' ||
          instr.value.kind === 'OptionalCallExpression'
        ) {
          const callKind = getReactiveCallKind(instr.value, ctx)
          if (callKind === 'signal') {
            ctx.signalVars?.add(target)
          } else if (callKind === 'store') {
            ctx.storeVars?.add(target)
          } else if (callKind === 'memo') {
            ctx.memoVars?.add(target)
          }
        }
        if (
          instr.value.kind === 'CallExpression' &&
          instr.value.callee.kind === 'Identifier' &&
          isHookName(instr.value.callee.name)
        ) {
          hookResultVars.add(target)
          ctx.hookResultVarMap?.set(target, instr.value.callee.name)
        }
        const namespaceHookCall = resolveNamespaceHookCallInfo(instr.value, ctx)
        if (namespaceHookCall) {
          hookResultVars.add(target)
          ctx.hookResultVarMap?.set(target, namespaceHookCall.hookName)
        }
        if (
          instr.value.kind === 'MemberExpression' &&
          instr.value.object.kind === 'Identifier' &&
          hookResultVars.has(deSSAVarName(instr.value.object.name))
        ) {
          hookAccessorAliases.add(target)
        }
        if (!instr.declarationKind) {
          ctx.mutatedVars?.add(target)
        }
      } else if (instr.kind === 'Phi') {
        ctx.mutatedVars?.add(deSSAVarName(instr.target.name))
      }
    }
  }
  collectMutatedIdentifiers(fn).forEach(name => ctx.mutatedVars?.add(name))
  hookAccessorAliases.forEach(name => {
    ctx.aliasVars?.add(name)
    ctx.trackedVars.add(name)
  })

  const inferredHook = options?.forceHookContext ? true : isHookLikeFunction(fn)
  // Analyze reactive scopes with SSA/CFG awareness
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult, ctx)
  ctx.scopes = scopeResult

  // Generate region result for metadata
  const regionResult = generateRegions(fn, scopeResult)

  const prevHookFlag = ctx.currentFnIsHook
  ctx.currentFnIsHook = inferredHook
  const isComponent = !!(fn.name && fn.name[0] === fn.name[0]?.toUpperCase())
  ctx.isComponentFn = isComponent
  // Non-component, non-hook functions should use non-hook-based primitives (createSignal, createMemo)
  // to avoid requiring hook context. Only component functions and hooks use hook-based APIs.
  if (!isComponent && !inferredHook) {
    ctx.inModule = true
  }
  const rawPropsParam =
    fn.params.length === 1 && fn.params[0] ? deSSAVarName(fn.params[0].name) : undefined
  if (isComponent && rawPropsParam) {
    ctx.propsParamName = rawPropsParam
    ctx.trackedVars.add(rawPropsParam)
    scopedTracked.add(rawPropsParam)
  } else {
    ctx.propsParamName = undefined
  }

  // Build RegionInfo array for DOM integration (with de-versioned names, flattened with children)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)
  if (ctx.nextHookSlot === undefined) {
    ctx.nextHookSlot = HOOK_SLOT_BASE
  }

  // Precompute a reactive props destructuring plan for component params
  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    const pattern =
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
        ? rawParam.type === 'AssignmentPattern'
          ? rawParam.left
          : rawParam
        : null

    if (pattern && pattern.type === 'ObjectPattern') {
      const stmts: BabelCore.types.Statement[] = []
      const excludeKeys: BabelCore.types.Expression[] = []
      let supported = true
      let usesProp = false
      let usesPropsRest = false
      let warnedNested = false
      const reportedPatternNodes = new Set<BabelCore.types.Node>()

      const reportPatternDiagnostic = (node: BabelCore.types.Node, code: DiagnosticCode): void => {
        if (reportedPatternNodes.has(node)) return
        reportedPatternNodes.add(node)
        reportDiagnostic(ctx, code, node)
      }

      const reportPropsPatternIssues = (
        objectPattern: BabelCore.types.ObjectPattern,
        allowRest: boolean,
      ): void => {
        for (const prop of objectPattern.properties) {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              continue
            }
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              continue
            }

            const value = prop.value
            if (t.isIdentifier(value)) {
              continue
            }
            if (t.isObjectPattern(value)) {
              reportPropsPatternIssues(value, false)
              continue
            }
            if (t.isAssignmentPattern(value)) {
              if (t.isIdentifier(value.left)) {
                continue
              }
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
              continue
            }
            if (t.isArrayPattern(value)) {
              const hasRest = value.elements.some(el => t.isRestElement(el))
              reportPatternDiagnostic(
                value,
                hasRest ? DiagnosticCode.FICT_P002 : DiagnosticCode.FICT_P001,
              )
              continue
            }

            reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
            continue
          }

          if (t.isRestElement(prop)) {
            if (!allowRest || !t.isIdentifier(prop.argument)) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
            }
            continue
          }

          reportPatternDiagnostic(prop as BabelCore.types.Node, DiagnosticCode.FICT_P004)
        }
      }

      const memberExprForKey = (
        base: BabelCore.types.Expression,
        key: string,
      ): BabelCore.types.MemberExpression => t.memberExpression(base, t.identifier(key), false)

      const buildDestructure = (
        objectPattern: BabelCore.types.ObjectPattern,
        baseExpr: BabelCore.types.Expression,
        allowRest: boolean,
      ): void => {
        for (const prop of objectPattern.properties) {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              supported = false
              warnedNested = true
              break
            }
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              supported = false
              warnedNested = true
              break
            }
            if (allowRest) {
              excludeKeys.push(t.stringLiteral(keyName))
            }
            const member = memberExprForKey(baseExpr, keyName)
            const value = prop.value

            if (t.isIdentifier(value)) {
              const shouldWrapProp = !calledIdentifiers.has(value.name)
              if (shouldWrapProp) {
                usesProp = true
                propsPlanAliases.add(value.name)
              }
              stmts.push(
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(value.name),
                    shouldWrapProp
                      ? t.callExpression(t.identifier(RUNTIME_ALIASES.prop), [
                          t.arrowFunctionExpression([], member),
                        ])
                      : member,
                  ),
                ]),
              )
              continue
            }

            if (t.isObjectPattern(value)) {
              buildDestructure(value, member, false)
              if (!supported) break
              continue
            }

            if (t.isAssignmentPattern(value)) {
              if (t.isIdentifier(value.left)) {
                const shouldWrapProp = !calledIdentifiers.has(value.left.name)
                if (shouldWrapProp) {
                  usesProp = true
                  propsPlanAliases.add(value.left.name)
                }
                const baseInit = t.logicalExpression('??', member, value.right)
                const init = shouldWrapProp
                  ? t.callExpression(t.identifier(RUNTIME_ALIASES.prop), [
                      t.arrowFunctionExpression([], baseInit),
                    ])
                  : baseInit
                stmts.push(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(t.identifier(value.left.name), init),
                  ]),
                )
                continue
              }
              supported = false
              if (!warnedNested) {
                reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
                warnedNested = true
              }
              break
            }

            if (t.isArrayPattern(value)) {
              const hasRest = value.elements.some(el => t.isRestElement(el))
              reportPatternDiagnostic(
                value,
                hasRest ? DiagnosticCode.FICT_P002 : DiagnosticCode.FICT_P001,
              )
              supported = false
              warnedNested = true
              break
            }

            supported = false
            if (!warnedNested) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
              warnedNested = true
            }
            break
          } else if (t.isRestElement(prop) && allowRest && t.isIdentifier(prop.argument)) {
            usesPropsRest = true
            stmts.push(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier(prop.argument.name),
                  t.callExpression(t.identifier(RUNTIME_ALIASES.propsRest), [
                    baseExpr,
                    t.arrayExpression(excludeKeys),
                  ]),
                ),
              ]),
            )
            continue
          } else {
            supported = false
            if (!warnedNested) {
              reportPatternDiagnostic(prop as BabelCore.types.Node, DiagnosticCode.FICT_P004)
              warnedNested = true
            }
            break
          }
        }
      }

      reportPropsPatternIssues(pattern, true)

      // Build destructuring for top-level pattern
      buildDestructure(pattern, t.identifier('__props'), true)

      if (supported) {
        propsDestructurePlan = {
          statements: stmts,
          usesProp,
          usesPropsRest,
        }
        propsPlanAliases.forEach(name => {
          ctx.aliasVars?.add(name)
          ctx.trackedVars.add(name)
          ctx.shadowedNames?.delete(name)
        })
      }
    }
  }

  const reactive = computeReactiveAccessors(fn, ctx)
  ctx.trackedVars = reactive.tracked
  ctx.memoVars = reactive.memo
  ctx.controlDepsByInstr = reactive.controlDepsByInstr
  if (fn.name && isHookName(fn.name)) {
    const info = analyzeHookReturnInfo(fn, ctx)
    if (info) {
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(fn.name, info)
    }
  }
  if (fn.name === 'Counter') {
    debugLog('region', 'Tracked vars for Counter', Array.from(ctx.trackedVars))
    debugLog('region', 'Memo vars for Counter', Array.from(ctx.memoVars))
  }

  // Ensure hook call results that return direct accessors are treated as reactive aliases
  hookResultVars.forEach(varName => {
    const hookName = ctx.hookResultVarMap?.get(varName)
    const info = hookName ? getHookReturnInfo(hookName, ctx) : null
    if (info?.directAccessor === 'signal') {
      ctx.signalVars?.add(varName)
      ctx.trackedVars.add(varName)
    } else if (info?.directAccessor === 'memo') {
      ctx.memoVars?.add(varName)
    }
  })

  const hasJSX = regionResult.regions.some(r => r.hasJSX) || functionContainsJSX(fn)
  emitReactiveControlFlowReexecutionWarning(fn, scopeResult, ctx, { hasJSX, isComponent })
  ctx.wrapTrackedExpressions = hasJSX
  const hasTrackedValues =
    ctx.trackedVars.size > 0 ||
    (ctx.signalVars?.size ?? 0) > 0 ||
    (ctx.storeVars?.size ?? 0) > 0 ||
    (ctx.memoVars?.size ?? 0) > 0 ||
    (ctx.aliasVars?.size ?? 0) > 0
  const isAsync = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  const isGenerator = !!fn.meta?.isGenerator || functionHasYield(fn)
  if (!hasJSX && !hasTrackedValues) {
    // For pure functions without JSX or tracked values, check if we can safely lower from HIR.
    // We skip functions with complex control flow (loops, async) as the simple lowering
    // doesn't handle all cases correctly.
    const structured = structurizeCFG(fn)
    const hasComplexControlFlow = structuredNodeHasComplexControlFlow(structured)

    if (!hasComplexControlFlow && !isAsync) {
      // For simple pure functions, generate code from optimized HIR
      // This ensures constant propagation, DCE, and algebraic simplifications are applied
      const pureDeclaredVars = new Set<string>()
      const pureStatements = lowerStructuredNodeWithoutRegions(structured, t, ctx, pureDeclaredVars)
      const params = buildOutputParams(fn, t)
      const funcDecl = setNodeLoc(
        t.functionDeclaration(
          t.identifier(fn.name ?? 'fn'),
          params,
          t.blockStatement(pureStatements),
        ),
        fn.loc,
      )
      funcDecl.async = isAsync
      funcDecl.generator = isGenerator
      ctx.needsCtx = prevNeedsCtx
      ctx.shadowedNames = prevShadowed
      ctx.localDeclaredNames = prevLocalDeclared
      ctx.trackedVars = prevTracked
      ctx.externalTracked = prevExternalTracked
      ctx.signalVars = prevSignalVars
      ctx.functionVars = prevFunctionVars
      ctx.componentFunctionDefs = prevComponentFunctionDefs
      ctx.memoVars = prevMemoVars
      ctx.storeVars = prevStoreVars
      ctx.mutatedVars = prevMutatedVars
      ctx.aliasVars = prevAliasVars
      ctx.noMemo = prevNoMemo
      ctx.wrapTrackedExpressions = prevWrapTracked
      ctx.hookResultVarMap = prevHookResultVarMap
      ctx.inModule = prevInModule
      return funcDecl
    }

    // Fall back to returning null for complex functions
    ctx.needsCtx = prevNeedsCtx
    ctx.shadowedNames = prevShadowed
    ctx.localDeclaredNames = prevLocalDeclared
    ctx.trackedVars = prevTracked
    ctx.externalTracked = prevExternalTracked
    ctx.signalVars = prevSignalVars
    ctx.functionVars = prevFunctionVars
    ctx.componentFunctionDefs = prevComponentFunctionDefs
    ctx.memoVars = prevMemoVars
    ctx.storeVars = prevStoreVars
    ctx.mutatedVars = prevMutatedVars
    ctx.aliasVars = prevAliasVars
    ctx.noMemo = prevNoMemo
    ctx.wrapTrackedExpressions = prevWrapTracked
    ctx.hookResultVarMap = prevHookResultVarMap
    ctx.inModule = prevInModule
    return null
  }

  // Generate region-based statements (JSX-bearing functions)
  let statements: BabelCore.types.Statement[]
  statements = generateRegionCode(fn, scopeResult, t, ctx)

  if (ctx.currentFnIsHook) {
    statements = statements.map(stmt => {
      if (t.isReturnStatement(stmt) && stmt.argument && t.isExpression(stmt.argument)) {
        return t.returnStatement(unwrapAccessorCalls(stmt.argument, ctx))
      }
      return stmt
    })
  }

  // Ensure context if signals/effects are used in HIR path
  if (ctx.needsCtx) {
    ctx.helpersUsed.add('useContext')
    statements.unshift(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__fictCtx'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
        ),
      ]),
    )
  }

  // Handle props destructuring pattern for component functions
  // If first rawParam is ObjectPattern, emit __props and add destructuring
  let finalParams = buildOutputParams(fn, t)
  const propsDestructuring: BabelCore.types.Statement[] = []

  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    // Check if it's an ObjectPattern or AssignmentPattern with ObjectPattern
    if (
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
    ) {
      const pattern = rawParam.type === 'AssignmentPattern' ? rawParam.left : rawParam
      const defaultExpr = rawParam.type === 'AssignmentPattern' ? rawParam.right : null
      if (defaultExpr) {
        const propsParamName = '__propsParam'
        finalParams = [t.identifier(propsParamName)]
        propsDestructuring.push(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('__props'),
              t.conditionalExpression(
                t.binaryExpression('===', t.identifier(propsParamName), t.identifier('undefined')),
                t.cloneNode(defaultExpr, true) as BabelCore.types.Expression,
                t.identifier(propsParamName),
              ),
            ),
          ]),
        )
      } else {
        // Replace params with __props
        finalParams = [t.identifier('__props')]
      }
      // Add destructuring statement at start of function
      if (propsDestructurePlan) {
        if (propsDestructurePlan.usesProp) {
          ctx.helpersUsed.add('prop')
        }
        if (propsDestructurePlan.usesPropsRest) {
          ctx.helpersUsed.add('propsRest')
        }
        propsDestructuring.push(...propsDestructurePlan.statements)
      } else {
        propsDestructuring.push(
          t.variableDeclaration('const', [t.variableDeclarator(pattern, t.identifier('__props'))]),
        )
      }
    }
  }

  // Add props destructuring before other statements
  if (propsDestructuring.length > 0) {
    statements.unshift(...propsDestructuring)
  }

  if (isComponent && !ctx.noMemo) {
    const transformed = transformControlFlowReturns(statements, ctx)
    if (transformed) {
      statements = transformed
    }
  }

  // De-version param names for clean output
  const params = finalParams
  const funcDecl = setNodeLoc(
    t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements)),
    fn.loc,
  )
  funcDecl.async = isAsync
  funcDecl.generator = isGenerator
  if (isComponent && fn.name) {
    registerResumableComponent(fn.name, ctx)
  }
  ctx.needsCtx = prevNeedsCtx
  ctx.shadowedNames = prevShadowed
  ctx.localDeclaredNames = prevLocalDeclared
  ctx.trackedVars = prevTracked
  ctx.externalTracked = prevExternalTracked
  ctx.signalVars = prevSignalVars
  ctx.functionVars = prevFunctionVars
  ctx.componentFunctionDefs = prevComponentFunctionDefs
  ctx.memoVars = prevMemoVars
  ctx.storeVars = prevStoreVars
  ctx.mutatedVars = prevMutatedVars
  ctx.aliasVars = prevAliasVars
  ctx.noMemo = prevNoMemo
  ctx.wrapTrackedExpressions = prevWrapTracked
  ctx.currentFnIsHook = prevHookFlag
  ctx.isComponentFn = prevIsComponent
  ctx.hookResultVarMap = prevHookResultVarMap
  ctx.propsParamName = prevPropsParam
  ctx.propAccessorDecls = prevPropAccessors
  ctx.delegatedEventsUsed = prevDelegatedEventsUsed
  ctx.inModule = prevInModule
  return funcDecl
}

/**
 * Flatten region tree into a list of RegionInfo with de-SSA names.
 * Children are ordered before parents so narrower regions are preferred when matching.
 */
function flattenRegions(regions: Region[]): RegionInfo[] {
  const result: RegionInfo[] = []

  const visit = (region: Region) => {
    const info: RegionInfo = {
      id: region.id,
      dependencies: new Set(Array.from(region.dependencies).map(d => deSSAVarName(d))),
      declarations: new Set(Array.from(region.declarations).map(d => deSSAVarName(d))),
      hasControlFlow: region.hasControlFlow,
      hasReactiveWrites: region.declarations.size > 0,
    }
    // Visit children first so that more specific regions are matched earlier
    region.children.forEach(child => visit(child))
    result.push(info)
  }

  regions.forEach(region => visit(region))

  // Prefer smaller regions when searching for containment
  return result.sort((a, b) => {
    const aSize = a.dependencies.size + a.declarations.size
    const bSize = b.dependencies.size + b.declarations.size
    if (aSize === bSize) return a.id - b.id
    return aSize - bSize
  })
}

/**
 * Get region metadata for fine-grained DOM integration.
 * Returns RegionMetadata[] that can be passed to applyRegionMetadata.
 */
export function getRegionMetadataForFunction(fn: HIRFunction): RegionMetadata[] {
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  const regionResult = generateRegions(fn, scopeResult)
  return regionResult.topLevelRegions.map(r => regionToMetadata(r))
}

/**
 * Check if a function has reactive regions that need memoization.
 */
export function hasReactiveRegions(fn: HIRFunction): boolean {
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  return scopeResult.scopes.some(s => s.shouldMemoize)
}

/**
 * Get helper functions used during codegen.
 */
export function getHelpersUsed(ctx: CodegenContext): Set<string> {
  return ctx.helpersUsed
}
