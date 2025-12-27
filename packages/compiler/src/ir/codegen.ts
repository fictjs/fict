import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES, RUNTIME_HELPERS, RUNTIME_MODULE } from '../constants'
import { debugEnabled } from '../debug'
import type { FictCompilerOptions } from '../types'

import {
  HIRError,
  type BasicBlock,
  type Expression,
  type HIRFunction,
  type HIRProgram,
  type Instruction,
  type JSXAttribute,
  type JSXChild,
  type JSXElementExpression,
} from './hir'
import {
  deSSAVarName,
  expressionUsesTracked,
  lowerStructuredNodeWithoutRegions,
  type Region,
} from './regions'
import type { ReactiveScopeResult } from './scopes'
import { analyzeCFG } from './ssa'
import { structurizeCFG, structurizeCFGWithDiagnostics, type StructuredNode } from './structurize'

const HOOK_SLOT_BASE = 1000
const HOOK_NAME_PREFIX = 'use'

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

type HookAccessorKind = 'signal' | 'memo'

interface HookReturnInfo {
  objectProps?: Map<string, HookAccessorKind>
  arrayProps?: Map<number, HookAccessorKind>
  directAccessor?: HookAccessorKind
}

function isHookName(name: string | undefined): boolean {
  return !!name && name.startsWith(HOOK_NAME_PREFIX)
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

function reserveHookSlot(ctx: CodegenContext): number {
  const slot = ctx.nextHookSlot ?? HOOK_SLOT_BASE
  ctx.nextHookSlot = slot + 1
  return slot
}

function expressionContainsJSX(expr: any): boolean {
  if (!expr || typeof expr !== 'object') return false
  if (expr.kind === 'JSXElement') return true

  switch (expr.kind) {
    case 'CallExpression':
      if (expressionContainsJSX(expr.callee as Expression)) return true
      return expr.arguments?.some((arg: Expression) => expressionContainsJSX(arg)) ?? false
    case 'ArrayExpression':
      return expr.elements?.some((el: Expression) => expressionContainsJSX(el)) ?? false
    case 'ObjectExpression':
      return expr.properties?.some((p: any) => expressionContainsJSX(p.value)) ?? false
    case 'ConditionalExpression':
      return (
        expressionContainsJSX(expr.test as Expression) ||
        expressionContainsJSX(expr.consequent as Expression) ||
        expressionContainsJSX(expr.alternate as Expression)
      )
    case 'ArrowFunction':
      return expressionContainsJSX(expr.body as Expression)
    default:
      return false
  }
}

function functionContainsJSX(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (
        (instr.kind === 'Assign' || instr.kind === 'Expression') &&
        expressionContainsJSX((instr as any).value)
      ) {
        return true
      }
    }

    const term = block.terminator
    if (term.kind === 'Return' && term.argument && expressionContainsJSX(term.argument as any)) {
      return true
    }
  }
  return false
}

function collectCalledIdentifiers(fn: HIRFunction): Set<string> {
  const called = new Set<string>()

  const visitExpr = (expr: Expression | undefined | null) => {
    if (!expr) return
    switch (expr.kind) {
      case 'Identifier':
        return
      case 'CallExpression': {
        if (expr.callee.kind === 'Identifier') {
          called.add(deSSAVarName(expr.callee.name))
        } else {
          visitExpr(expr.callee as Expression)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression))
        return
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitExpr(expr.object as Expression)
        visitExpr(expr.property as Expression)
        return
      case 'UnaryExpression':
        visitExpr(expr.argument as Expression)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitExpr(expr.left as Expression)
        visitExpr(expr.right as Expression)
        return
      case 'ConditionalExpression':
        visitExpr(expr.test as Expression)
        visitExpr(expr.consequent as Expression)
        visitExpr(expr.alternate as Expression)
        return
      case 'ArrayExpression':
        expr.elements.forEach(el => visitExpr(el as Expression))
        return
      case 'ObjectExpression':
        expr.properties.forEach(p => {
          if (p.kind === 'SpreadElement') {
            visitExpr(p.argument as Expression)
          } else {
            visitExpr(p.value as Expression)
          }
        })
        return
      case 'ArrowFunction':
      case 'FunctionExpression':
        if (Array.isArray(expr.body)) {
          expr.body.forEach(block => {
            block.instructions.forEach(instr => {
              if (instr.kind === 'Assign' || instr.kind === 'Expression') {
                visitExpr((instr as any).value as Expression)
              }
            })
          })
        } else {
          visitExpr(expr.body as Expression)
        }
        return
      case 'JSXElement':
        expr.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visitExpr(attr.spreadExpr)
          } else if (attr.value) {
            visitExpr(attr.value)
          }
        })
        expr.children.forEach(child => {
          if (child.kind === 'expression') {
            visitExpr(child.value)
          } else if (child.kind === 'element') {
            visitExpr(child.value)
          }
        })
        return
      default:
        return
    }
  }

  const visitTerminator = (term: BasicBlock['terminator']) => {
    switch (term.kind) {
      case 'Branch':
        visitExpr(term.test)
        return
      case 'Switch':
        visitExpr(term.discriminant)
        term.cases.forEach(c => visitExpr(c.test))
        return
      case 'ForOf':
        visitExpr(term.iterable)
        return
      case 'ForIn':
        visitExpr(term.object)
        return
      case 'Return':
        visitExpr(term.argument ?? null)
        return
      case 'Throw':
        visitExpr(term.argument)
        return
      default:
        return
    }
  }

  for (const block of fn.blocks) {
    block.instructions.forEach(instr => {
      if (instr.kind === 'Assign') {
        visitExpr(instr.value)
      } else if (instr.kind === 'Expression') {
        visitExpr(instr.value)
      }
    })
    visitTerminator(block.terminator)
  }

  return called
}

/**
 * Codegen context for tracking state during code generation
 */
export interface CodegenContext {
  t: typeof BabelCore.types
  /** Compiler options (for feature toggles like lazyConditional). */
  options?: FictCompilerOptions
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
  /** Variables initialized with $state (signal accessors) */
  signalVars?: Set<string>
  /** Variables assigned to function expressions (should not be treated as reactive accessors) */
  functionVars?: Set<string>
  /** Variables that are memos (derived values) - these shouldn't be cached by getter cache */
  memoVars?: Set<string>
  /** Variables that are assigned after declaration (need mutable binding) */
  mutatedVars?: Set<string>
  /** Whether we are emitting statements inside a region memo */
  inRegionMemo?: boolean
  /** Whether we are lowering a list item render callback */
  inListRender?: boolean
  /** Next explicit slot index for nested memo hooks */
  nextHookSlot?: number
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
}

/**
 * Creates a fresh codegen context
 */
export function createCodegenContext(t: typeof BabelCore.types): CodegenContext {
  return {
    t,
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
    signalVars: new Set(),
    functionVars: new Set(),
    memoVars: new Set(),
    mutatedVars: new Set(),
    inRegionMemo: false,
    inListRender: false,
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
  }
}

/**
 * Rule L: Enable getter caching for a sync function scope.
 * Returns a function to collect the cache declarations after processing.
 */
function withGetterCache<T>(
  ctx: CodegenContext,
  fn: () => T,
): { result: T; cacheDeclarations: BabelCore.types.Statement[] } {
  const prevCache = ctx.getterCache
  const prevDeclarations = ctx.getterCacheDeclarations
  const prevEnabled = ctx.getterCacheEnabled

  ctx.getterCache = new Map()
  ctx.getterCacheDeclarations = new Map()
  ctx.getterCacheEnabled = true

  const result = fn()

  // Collect cache declarations
  const cacheDeclarations: BabelCore.types.Statement[] = []
  if (ctx.getterCacheDeclarations && ctx.getterCacheDeclarations.size > 0) {
    for (const [varName, initExpr] of ctx.getterCacheDeclarations) {
      cacheDeclarations.push(
        ctx.t.variableDeclaration('const', [
          ctx.t.variableDeclarator(ctx.t.identifier(varName), initExpr),
        ]),
      )
    }
  }

  // Restore previous state
  ctx.getterCache = prevCache
  ctx.getterCacheDeclarations = prevDeclarations
  ctx.getterCacheEnabled = prevEnabled

  return { result, cacheDeclarations }
}

function collectHookReactiveVars(fn: HIRFunction): {
  signalVars: Set<string>
  storeVars: Set<string>
  functionVars: Set<string>
  mutatedVars: Set<string>
} {
  const signalVars = new Set<string>()
  const storeVars = new Set<string>()
  const functionVars = new Set<string>()
  const mutatedVars = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          functionVars.add(target)
        }
        if (instr.value.kind === 'CallExpression' && instr.value.callee.kind === 'Identifier') {
          if (instr.value.callee.name === '$state') {
            signalVars.add(target)
          } else if (instr.value.callee.name === '$store') {
            storeVars.add(target)
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

  return { signalVars, storeVars, functionVars, mutatedVars }
}

function analyzeHookReturnInfo(fn: HIRFunction, ctx: CodegenContext): HookReturnInfo | null {
  if (!isHookName(fn.name)) return null

  const { signalVars, storeVars, functionVars, mutatedVars } = collectHookReactiveVars(fn)
  const tmpCtx = createCodegenContext(ctx.t)
  tmpCtx.signalVars = new Set(signalVars)
  tmpCtx.storeVars = new Set(storeVars)
  tmpCtx.functionVars = new Set(functionVars)
  tmpCtx.mutatedVars = new Set(mutatedVars)
  tmpCtx.aliasVars = new Set()
  tmpCtx.trackedVars = new Set()
  tmpCtx.memoVars = new Set()

  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult)
  tmpCtx.scopes = scopeResult
  const regionResult = generateRegions(fn, scopeResult)
  tmpCtx.regions = flattenRegions(regionResult.topLevelRegions)
  const reactive = computeReactiveAccessors(fn, tmpCtx)
  tmpCtx.trackedVars = reactive.tracked
  tmpCtx.memoVars = reactive.memo

  const info: HookReturnInfo = {}
  let hasInfo = false

  const recordAccessor = (kind: HookAccessorKind | undefined, handler: () => void) => {
    if (kind) {
      hasInfo = true
      handler()
    }
  }

  const exprAccessorKind = (name: string | undefined): HookAccessorKind | undefined => {
    if (!name) return undefined
    const base = deSSAVarName(name)
    if (tmpCtx.signalVars?.has(base)) return 'signal'
    if (tmpCtx.memoVars?.has(base)) return 'memo'
    return undefined
  }

  const visitReturnExpr = (expr: Expression) => {
    if (expr.kind === 'ObjectExpression') {
      expr.properties.forEach(prop => {
        if (prop.kind !== 'Property') return
        const keyName =
          prop.key.kind === 'Identifier'
            ? prop.key.name
            : prop.key.kind === 'Literal'
              ? String(prop.key.value)
              : undefined
        if (!keyName) return
        if (prop.value.kind === 'Identifier') {
          const kind = exprAccessorKind(prop.value.name)
          recordAccessor(kind, () => {
            if (!info.objectProps) info.objectProps = new Map()
            info.objectProps.set(keyName, kind!)
          })
        }
      })
    } else if (expr.kind === 'ArrayExpression') {
      expr.elements.forEach((el, idx) => {
        if (!el || el.kind !== 'Identifier') return
        const kind = exprAccessorKind(el.name)
        recordAccessor(kind, () => {
          if (!info.arrayProps) info.arrayProps = new Map()
          info.arrayProps.set(idx, kind!)
        })
      })
    } else if (expr.kind === 'Identifier') {
      const kind = exprAccessorKind(expr.name)
      recordAccessor(kind, () => {
        info.directAccessor = kind
      })
    }
  }

  for (const block of fn.blocks) {
    if (block.terminator.kind === 'Return' && block.terminator.argument) {
      visitReturnExpr(block.terminator.argument)
    }
  }

  return hasInfo ? info : null
}

function getHookReturnInfo(name: string, ctx: CodegenContext): HookReturnInfo | null {
  if (!isHookName(name)) return null
  if (!ctx.hookReturnInfo) ctx.hookReturnInfo = new Map()
  const cached = ctx.hookReturnInfo.get(name)
  if (cached) return cached

  const fn = ctx.programFunctions?.get(name)
  if (!fn) return null

  const info = analyzeHookReturnInfo(fn, ctx)
  if (info) {
    ctx.hookReturnInfo.set(name, info)
  }
  return info ?? null
}

function getStaticPropName(expr: Expression, computed: boolean): string | number | null {
  if (!computed) {
    if ((expr as any).kind === 'Identifier') {
      return deSSAVarName((expr as any).name as string)
    }
    if ((expr as any).kind === 'Literal') {
      return (expr as any).value as any
    }
    return null
  }
  if (expr.kind === 'Literal') {
    return expr.value as any
  }
  return null
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
 * Get or create a cached getter expression.
 * Rule L: Only cache when a getter is accessed multiple times in the same sync block.
 * First access returns the call expression directly; subsequent accesses use the cache.
 */
function getCachedGetterExpression(
  ctx: CodegenContext,
  getterName: string,
  callExpr: BabelCore.types.Expression,
): BabelCore.types.Expression {
  if (!ctx.getterCacheEnabled || !ctx.getterCache || !ctx.getterCacheDeclarations) {
    return callExpr
  }

  // Skip caching for memo variables - memos already cache internally
  if (ctx.memoVars?.has(getterName)) {
    return callExpr
  }

  const existingEntry = ctx.getterCache.get(getterName)

  if (existingEntry === undefined) {
    // First access - just record that we've seen it, don't cache yet
    // Use empty string as marker for "seen once"
    ctx.getterCache.set(getterName, '')
    return callExpr
  }

  if (existingEntry === '') {
    // Second access - NOW create the cache variable
    const cacheVar = `__cached_${getterName}_${ctx.tempCounter++}`
    ctx.getterCache.set(getterName, cacheVar)
    ctx.getterCacheDeclarations.set(cacheVar, callExpr)
    return ctx.t.identifier(cacheVar)
  }

  // Third+ access - use existing cache variable
  return ctx.t.identifier(existingEntry)
}

function detectDerivedCycles(fn: HIRFunction, _scopeResult: ReactiveScopeResult): void {
  if (debugEnabled('cycles_throw')) {
    throw new Error('cycle check invoked')
  }
  const declared = new Map<
    string,
    { isState: boolean; isStore: boolean; declaredHere: boolean; count: number }
  >()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const isStateCall =
        instr.value.kind === 'CallExpression' &&
        instr.value.callee.kind === 'Identifier' &&
        instr.value.callee.name === '$state'
      const isStoreCall =
        instr.value.kind === 'CallExpression' &&
        instr.value.callee.kind === 'Identifier' &&
        instr.value.callee.name === '$store'
      const prev = declared.get(target)
      declared.set(target, {
        isState: (prev?.isState ?? false) || isStateCall,
        isStore: (prev?.isStore ?? false) || isStoreCall,
        declaredHere: prev?.declaredHere || !!instr.declarationKind,
        count: (prev?.count ?? 0) + 1,
      })
    }
  }

  const graph = new Map<string, Set<string>>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const declInfo = declared.get(target)
      if (declInfo?.isState || !declInfo?.declaredHere) continue
      if ((declInfo.count ?? 0) !== 1) continue
      const deps = graph.get(target) ?? new Set<string>()
      const rawDeps = new Set<string>()
      collectExpressionDependencies(instr.value, rawDeps)
      for (const dep of rawDeps) {
        const base = deSSAVarName(dep.split('.')[0] ?? dep)
        const depInfo = declared.get(base)
        if (depInfo && depInfo.declaredHere && !depInfo.isState && (depInfo.count ?? 0) === 1) {
          deps.add(base)
        }
      }
      graph.set(target, deps)
    }
  }
  if (graph.size === 0) return

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node)
      const cycle = idx >= 0 ? [...stack.slice(idx), node] : [...stack, node]
      throw new Error(`Detected cyclic derived dependency: ${cycle.join(' -> ')}`)
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const dep of graph.get(node) ?? []) {
      visit(dep)
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    visit(node)
  }

  if (debugEnabled('cycles')) {
    console.error(
      'cycle graph',
      Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)]),
    )
  }
}

function collectExpressionIdentifiers(expr: Expression, into: Set<string>): void {
  if (!expr || typeof expr !== 'object') return

  switch (expr.kind) {
    case 'Identifier':
      into.add(deSSAVarName(expr.name))
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExpressionIdentifiers(expr.object as Expression, into)
      if (expr.computed && expr.property.kind !== 'Literal') {
        collectExpressionIdentifiers(expr.property as Expression, into)
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')
      if (!isMacroCallee) {
        collectExpressionIdentifiers(expr.callee as Expression, into)
      }
      expr.arguments.forEach(arg => collectExpressionIdentifiers(arg as Expression, into))
      return
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExpressionIdentifiers(expr.left as Expression, into)
      collectExpressionIdentifiers(expr.right as Expression, into)
      return
    case 'UnaryExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'ConditionalExpression':
      collectExpressionIdentifiers(expr.test as Expression, into)
      collectExpressionIdentifiers(expr.consequent as Expression, into)
      collectExpressionIdentifiers(expr.alternate as Expression, into)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) collectExpressionIdentifiers(el as Expression, into)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          collectExpressionIdentifiers(prop.argument as Expression, into)
          return
        }
        // HIR ObjectProperty keys are always Identifier | Literal, not computed expressions
        collectExpressionIdentifiers(prop.value as Expression, into)
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'ArrowFunction':
    case 'FunctionExpression':
      // Avoid traversing nested function bodies.
      return
    case 'AssignmentExpression':
      collectExpressionIdentifiers(expr.left as Expression, into)
      collectExpressionIdentifiers(expr.right as Expression, into)
      return
    case 'UpdateExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'AwaitExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'NewExpression':
      collectExpressionIdentifiers(expr.callee as Expression, into)
      expr.arguments.forEach(arg => collectExpressionIdentifiers(arg as Expression, into))
      return
    case 'SequenceExpression':
      expr.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'YieldExpression':
      if (expr.argument) collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'TaggedTemplateExpression':
      collectExpressionIdentifiers(expr.tag as Expression, into)
      expr.quasi.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'SpreadElement':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'JSXElement': {
      if (typeof expr.tagName !== 'string') {
        collectExpressionIdentifiers(expr.tagName as Expression, into)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          collectExpressionIdentifiers(attr.spreadExpr, into)
          return
        }
        if (attr.value) {
          collectExpressionIdentifiers(attr.value, into)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          collectExpressionIdentifiers(child.value as Expression, into)
        } else if (child.kind === 'element') {
          collectExpressionIdentifiers(child.value as Expression, into)
        }
      })
      return
    }
    case 'Literal':
      return
  }
}

function collectExpressionIdentifiersDeep(
  expr: Expression,
  into: Set<string>,
  bound = new Set<string>(),
): void {
  if (!expr || typeof expr !== 'object') return

  const addIdentifier = (name: string) => {
    const base = deSSAVarName(name)
    if (!bound.has(base)) {
      into.add(base)
    }
  }

  switch (expr.kind) {
    case 'Identifier':
      addIdentifier(expr.name)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExpressionIdentifiersDeep(expr.object as Expression, into, bound)
      if (expr.computed && expr.property.kind !== 'Literal') {
        collectExpressionIdentifiersDeep(expr.property as Expression, into, bound)
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')
      if (!isMacroCallee) {
        collectExpressionIdentifiersDeep(expr.callee as Expression, into, bound)
      }
      expr.arguments.forEach(arg =>
        collectExpressionIdentifiersDeep(arg as Expression, into, bound),
      )
      return
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExpressionIdentifiersDeep(expr.left as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.right as Expression, into, bound)
      return
    case 'UnaryExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'ConditionalExpression':
      collectExpressionIdentifiersDeep(expr.test as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.consequent as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.alternate as Expression, into, bound)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) collectExpressionIdentifiersDeep(el as Expression, into, bound)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          collectExpressionIdentifiersDeep(prop.argument as Expression, into, bound)
          return
        }
        // HIR ObjectProperty keys are always Identifier | Literal, not computed expressions
        collectExpressionIdentifiersDeep(prop.value as Expression, into, bound)
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'ArrowFunction': {
      const nextBound = new Set(bound)
      expr.params.forEach(p => nextBound.add(deSSAVarName(p.name)))
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        collectExpressionIdentifiersDeep(expr.body as Expression, into, nextBound)
      } else if (Array.isArray(expr.body)) {
        for (const block of expr.body) {
          for (const instr of block.instructions) {
            if (instr.kind === 'Assign') {
              collectExpressionIdentifiersDeep(instr.value, into, nextBound)
            } else if (instr.kind === 'Expression') {
              collectExpressionIdentifiersDeep(instr.value, into, nextBound)
            } else if (instr.kind === 'Phi') {
              instr.sources.forEach(src => addIdentifier(src.id.name))
            }
          }
          const term = block.terminator
          if (term.kind === 'Branch') {
            collectExpressionIdentifiersDeep(term.test, into, nextBound)
          } else if (term.kind === 'Switch') {
            collectExpressionIdentifiersDeep(term.discriminant, into, nextBound)
            term.cases.forEach(c => {
              if (c.test) collectExpressionIdentifiersDeep(c.test, into, nextBound)
            })
          } else if (term.kind === 'ForOf') {
            collectExpressionIdentifiersDeep(term.iterable, into, nextBound)
          } else if (term.kind === 'ForIn') {
            collectExpressionIdentifiersDeep(term.object, into, nextBound)
          } else if (term.kind === 'Return' && term.argument) {
            collectExpressionIdentifiersDeep(term.argument, into, nextBound)
          } else if (term.kind === 'Throw') {
            collectExpressionIdentifiersDeep(term.argument, into, nextBound)
          }
        }
      }
      return
    }
    case 'FunctionExpression': {
      const nextBound = new Set(bound)
      expr.params.forEach(p => nextBound.add(deSSAVarName(p.name)))
      for (const block of expr.body) {
        for (const instr of block.instructions) {
          if (instr.kind === 'Assign') {
            collectExpressionIdentifiersDeep(instr.value, into, nextBound)
          } else if (instr.kind === 'Expression') {
            collectExpressionIdentifiersDeep(instr.value, into, nextBound)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach(src => addIdentifier(src.id.name))
          }
        }
        const term = block.terminator
        if (term.kind === 'Branch') {
          collectExpressionIdentifiersDeep(term.test, into, nextBound)
        } else if (term.kind === 'Switch') {
          collectExpressionIdentifiersDeep(term.discriminant, into, nextBound)
          term.cases.forEach(c => {
            if (c.test) collectExpressionIdentifiersDeep(c.test, into, nextBound)
          })
        } else if (term.kind === 'ForOf') {
          collectExpressionIdentifiersDeep(term.iterable, into, nextBound)
        } else if (term.kind === 'ForIn') {
          collectExpressionIdentifiersDeep(term.object, into, nextBound)
        } else if (term.kind === 'Return' && term.argument) {
          collectExpressionIdentifiersDeep(term.argument, into, nextBound)
        } else if (term.kind === 'Throw') {
          collectExpressionIdentifiersDeep(term.argument, into, nextBound)
        }
      }
      return
    }
    case 'AssignmentExpression':
      collectExpressionIdentifiersDeep(expr.left as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.right as Expression, into, bound)
      return
    case 'UpdateExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'AwaitExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'NewExpression':
      collectExpressionIdentifiersDeep(expr.callee as Expression, into, bound)
      expr.arguments.forEach(arg =>
        collectExpressionIdentifiersDeep(arg as Expression, into, bound),
      )
      return
    case 'SequenceExpression':
      expr.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'YieldExpression':
      if (expr.argument) collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'TaggedTemplateExpression':
      collectExpressionIdentifiersDeep(expr.tag as Expression, into, bound)
      expr.quasi.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'SpreadElement':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'JSXElement': {
      if (typeof expr.tagName !== 'string') {
        collectExpressionIdentifiersDeep(expr.tagName as Expression, into, bound)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          collectExpressionIdentifiersDeep(attr.spreadExpr, into, bound)
          return
        }
        if (attr.value) {
          collectExpressionIdentifiersDeep(attr.value, into, bound)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          collectExpressionIdentifiersDeep(child.value as Expression, into, bound)
        } else if (child.kind === 'element') {
          collectExpressionIdentifiersDeep(child.value as Expression, into, bound)
        }
      })
      return
    }
    case 'Literal':
      return
  }
}

function getExpressionIdentifiers(expr?: Expression | null): Set<string> {
  const deps = new Set<string>()
  if (expr) {
    collectExpressionIdentifiers(expr, deps)
  }
  return deps
}

function buildControlDependencyMap(fn: HIRFunction): Map<Instruction, Set<string>> {
  const depsByInstruction = new Map<Instruction, Set<string>>()
  let structured: StructuredNode
  try {
    structured = structurizeCFG(fn, {
      warnOnIssues: false,
      throwOnIssues: false,
      useFallback: true,
    })
  } catch {
    return depsByInstruction
  }

  const mergeDeps = (base: Set<string>, extra: Set<string>): Set<string> => {
    if (extra.size === 0) return base
    const merged = new Set(base)
    extra.forEach(dep => merged.add(dep))
    return merged
  }

  const registerInstruction = (instr: Instruction, deps: Set<string>) => {
    depsByInstruction.set(instr, new Set(deps))
  }

  const walk = (node: StructuredNode, activeDeps: Set<string>) => {
    switch (node.kind) {
      case 'sequence':
        node.nodes.forEach(child => walk(child, activeDeps))
        return
      case 'block':
        node.statements.forEach(child => walk(child, activeDeps))
        return
      case 'instruction':
        registerInstruction(node.instruction, activeDeps)
        return
      case 'if': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.consequent, nextDeps)
        if (node.alternate) walk(node.alternate, nextDeps)
        return
      }
      case 'while': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.body, nextDeps)
        return
      }
      case 'doWhile': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.body, nextDeps)
        return
      }
      case 'for': {
        const initDeps = activeDeps
        node.init?.forEach(instr => registerInstruction(instr, initDeps))
        const condDeps = node.test ? getExpressionIdentifiers(node.test) : new Set<string>()
        const loopDeps = mergeDeps(activeDeps, condDeps)
        node.update?.forEach(instr => registerInstruction(instr, loopDeps))
        walk(node.body, loopDeps)
        return
      }
      case 'forOf': {
        const iterDeps = getExpressionIdentifiers(node.iterable)
        const loopDeps = mergeDeps(activeDeps, iterDeps)
        walk(node.body, loopDeps)
        return
      }
      case 'forIn': {
        const iterDeps = getExpressionIdentifiers(node.object)
        const loopDeps = mergeDeps(activeDeps, iterDeps)
        walk(node.body, loopDeps)
        return
      }
      case 'switch': {
        const discDeps = getExpressionIdentifiers(node.discriminant)
        const nextDeps = mergeDeps(activeDeps, discDeps)
        node.cases.forEach(c => walk(c.body, nextDeps))
        return
      }
      case 'try':
        walk(node.block, activeDeps)
        if (node.handler) walk(node.handler.body, activeDeps)
        if (node.finalizer) walk(node.finalizer, activeDeps)
        return
      case 'stateMachine':
        node.blocks.forEach(block => {
          block.instructions.forEach(instr => registerInstruction(instr, activeDeps))
        })
        return
      case 'return':
      case 'throw':
      case 'break':
      case 'continue':
        return
    }
  }

  walk(structured, new Set())
  return depsByInstruction
}

function computeReactiveAccessors(
  fn: HIRFunction,
  ctx: CodegenContext,
): { tracked: Set<string>; memo: Set<string>; controlDepsByInstr: Map<Instruction, Set<string>> } {
  const activeReadVars = new Set<string>()
  const dataDepsByTarget = new Map<string, Set<string>>()
  const controlDepsByTarget = new Map<string, Set<string>>()
  const controlDepsByInstr = buildControlDependencyMap(fn)

  const addActiveReads = (expr?: Expression | null, deep = false) => {
    if (!expr) return
    const deps = new Set<string>()
    if (deep) {
      collectExpressionIdentifiersDeep(expr, deps)
    } else {
      collectExpressionIdentifiers(expr, deps)
    }
    deps.forEach(dep => activeReadVars.add(dep))
  }

  const addDepsToTarget = (target: string, deps: Set<string>, map: Map<string, Set<string>>) => {
    if (deps.size === 0) return
    const existing = map.get(target)
    if (!existing) {
      map.set(target, new Set(deps))
      return
    }
    deps.forEach(dep => existing.add(dep))
  }

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        const dataDeps = getExpressionIdentifiers(instr.value)
        addDepsToTarget(target, dataDeps, dataDepsByTarget)
        const controlDeps = controlDepsByInstr.get(instr) ?? new Set<string>()
        addDepsToTarget(target, controlDeps, controlDepsByTarget)
      } else if (instr.kind === 'Expression') {
        addActiveReads(instr.value)
      } else if (instr.kind === 'Phi') {
        const target = deSSAVarName(instr.target.name)
        const sources = new Set(instr.sources.map(src => deSSAVarName(src.id.name)))
        addDepsToTarget(target, sources, dataDepsByTarget)
      }
    }
    const term = block.terminator
    if (term.kind === 'Branch') {
      addActiveReads(term.test)
    } else if (term.kind === 'Switch') {
      addActiveReads(term.discriminant)
      term.cases.forEach(c => addActiveReads(c.test))
    } else if (term.kind === 'ForOf') {
      addActiveReads(term.iterable)
    } else if (term.kind === 'ForIn') {
      addActiveReads(term.object)
    } else if (term.kind === 'Return') {
      addActiveReads(term.argument ?? null, true)
    } else if (term.kind === 'Throw') {
      addActiveReads(term.argument)
    }
  }

  const neededVars = new Set(activeReadVars)
  let needsChanged = true
  while (needsChanged) {
    needsChanged = false
    for (const [target, dataDeps] of dataDepsByTarget) {
      if (!neededVars.has(target)) continue
      const controlDeps = controlDepsByTarget.get(target)
      const mergedDeps = new Set(dataDeps)
      controlDeps?.forEach(dep => mergedDeps.add(dep))
      for (const dep of mergedDeps) {
        if (!neededVars.has(dep)) {
          neededVars.add(dep)
          needsChanged = true
        }
      }
    }
  }

  const tracked = new Set(ctx.trackedVars)
  ctx.signalVars?.forEach(dep => tracked.add(dep))
  ctx.aliasVars?.forEach(dep => tracked.add(dep))
  ctx.storeVars?.forEach(dep => tracked.add(dep))
  const memo = new Set(ctx.memoVars)

  const isFunctionVar = (name: string) => ctx.functionVars?.has(name) ?? false
  const isSignal = (name: string) => ctx.signalVars?.has(name) ?? false
  const isStore = (name: string) => ctx.storeVars?.has(name) ?? false

  let changed = true
  while (changed) {
    changed = false
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          const target = deSSAVarName(instr.target.name)
          if (isFunctionVar(target)) continue

          const dataDeps = getExpressionIdentifiers(instr.value)
          const controlDepsForInstr = controlDepsByInstr.get(instr) ?? new Set<string>()
          const hasDataDep = Array.from(dataDeps).some(dep => tracked.has(dep))
          const hasControlDep = Array.from(controlDepsForInstr).some(dep => tracked.has(dep))

          if (!hasDataDep && !hasControlDep) continue
          if (!neededVars.has(target)) continue

          if (!tracked.has(target)) {
            tracked.add(target)
            changed = true
          }
          if (hasDataDep && !isSignal(target) && !isStore(target)) {
            memo.add(target)
          }
        } else if (instr.kind === 'Phi') {
          const target = deSSAVarName(instr.target.name)
          if (isFunctionVar(target)) continue
          const hasDep = instr.sources.some(src => tracked.has(deSSAVarName(src.id.name)))
          if (!hasDep || !neededVars.has(target)) continue
          if (!tracked.has(target)) {
            tracked.add(target)
            changed = true
          }
          if (!isSignal(target) && !isStore(target)) {
            memo.add(target)
          }
        }
      }
    }
  }

  return { tracked, memo, controlDepsByInstr }
}

/**
 * Generate a unique temporary identifier
 */
function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return ctx.t.identifier(`__${prefix}_${ctx.tempCounter++}`)
}

/**
 * Normalized attribute information for HIR codegen
 */
interface NormalizedAttribute {
  name: string
  kind: 'attr' | 'class' | 'style' | 'event' | 'ref' | 'property' | 'skip'
  eventName?: string
  capture?: boolean
  passive?: boolean
  once?: boolean
}

/**
 * Normalize an attribute name for HIR codegen
 * Mirrors the logic from fine-grained-dom.ts normalizeAttributeName
 */
function _normalizeAttribute(name: string): NormalizedAttribute {
  // Event handlers: onClick, onSubmit, etc.
  if (name.length > 2 && name.startsWith('on') && name[2]?.toUpperCase() === name[2]) {
    let eventName = name.slice(2)
    let capture = false
    let passive = false
    let once = false

    // Support suffix modifiers (Capture/Passive/Once)
    let changed = true
    while (changed) {
      changed = false
      if (eventName.endsWith('Capture')) {
        eventName = eventName.slice(0, -7)
        capture = true
        changed = true
      }
      if (eventName.endsWith('Passive')) {
        eventName = eventName.slice(0, -7)
        passive = true
        changed = true
      }
      if (eventName.endsWith('Once')) {
        eventName = eventName.slice(0, -4)
        once = true
        changed = true
      }
    }

    return {
      name,
      kind: 'event',
      eventName: eventName.toLowerCase(),
      capture,
      passive,
      once,
    }
  }

  switch (name) {
    case 'key':
      return { name, kind: 'skip' }
    case 'ref':
      return { name, kind: 'ref' }
    case 'value':
    case 'checked':
    case 'selected':
    case 'disabled':
    case 'readOnly':
    case 'multiple':
    case 'muted':
      return { name, kind: 'property' }
    case 'class':
    case 'className':
      return { name: 'class', kind: 'class' }
    case 'style':
      return { name: 'style', kind: 'style' }
    case 'htmlFor':
      return { name: 'for', kind: 'attr' }
    default:
      return { name, kind: 'attr' }
  }
}

/**
 * Extract key attribute value from JSX attributes
 */
function extractKeyFromAttributes(attributes: JSXAttribute[]): Expression | undefined {
  for (const attr of attributes) {
    if (attr.name === 'key' && attr.value) {
      return attr.value
    }
  }
  return undefined
}

function getReturnedJSXFromCallback(callback: Expression): JSXElementExpression | null {
  if (callback.kind === 'ArrowFunction') {
    if (callback.isExpression && callback.body && (callback.body as any).kind === 'JSXElement') {
      return callback.body as JSXElementExpression
    }
    if (Array.isArray(callback.body)) {
      for (const block of callback.body) {
        const term = block.terminator
        if (term.kind === 'Return' && term.argument?.kind === 'JSXElement') {
          return term.argument as JSXElementExpression
        }
      }
    }
  }
  if (callback.kind === 'FunctionExpression') {
    for (const block of callback.body ?? []) {
      const term = block.terminator
      if (term.kind === 'Return' && term.argument?.kind === 'JSXElement') {
        return term.argument as JSXElementExpression
      }
    }
  }
  return null
}

function extractKeyFromMapCallback(callback: Expression): Expression | undefined {
  const jsx = getReturnedJSXFromCallback(callback)
  if (!jsx) return undefined
  return extractKeyFromAttributes(jsx.attributes)
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
  const params = fn.params.map(p => t.identifier(p.name))
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

  const result = t.functionDeclaration(
    t.identifier(fn.name ?? 'fn'),
    params,
    t.blockStatement(statements),
  )
  ctx.trackedVars = prevTracked
  return result
}

function lowerTrackedExpression(expr: Expression, ctx: CodegenContext): BabelCore.types.Expression {
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
  const lowered = lowerExpression(expr, ctx)
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
    return ctx.t.updateExpression(lowered.operator, arg as any, lowered.prefix)
  }
  return applyRegionMetadataToExpression(lowered, ctx, regionOverride ?? undefined)
}

function lowerInstruction(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  if (instr.kind === 'Assign') {
    const baseName = deSSAVarName(instr.target.name)
    propagateHookResultAlias(baseName, instr.value, ctx)
    const hookMember = resolveHookMemberValue(instr.value, ctx)
    if (hookMember) {
      if (hookMember.kind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (hookMember.kind === 'memo') {
        ctx.memoVars?.add(baseName)
      }
      if (instr.declarationKind) {
        return t.variableDeclaration(instr.declarationKind, [
          t.variableDeclarator(t.identifier(baseName), hookMember.member),
        ])
      }
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), hookMember.member),
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
    if (ctx.signalVars?.has(baseName)) {
      return t.expressionStatement(
        t.callExpression(t.identifier(baseName), [lowerTrackedExpression(instr.value, ctx)]),
      )
    }
    return t.expressionStatement(
      t.assignmentExpression('=', t.identifier(baseName), lowerTrackedExpression(instr.value, ctx)),
    )
  }
  if (instr.kind === 'Expression') {
    return t.expressionStatement(lowerTrackedExpression(instr.value, ctx))
  }
  if (instr.kind === 'Phi') {
    // Phi nodes are typically eliminated in SSA-out pass; emit comment for debugging
    return null
  }
  return null
}

function lowerTerminator(block: BasicBlock, ctx: CodegenContext): BabelCore.types.Statement[] {
  const { t } = ctx
  switch (block.terminator.kind) {
    case 'Return': {
      const prevRegion = ctx.currentRegion
      const preserveAccessors = ctx.currentFnIsHook
      if (preserveAccessors) ctx.currentRegion = undefined
      ctx.inReturn = true
      let retExpr = block.terminator.argument
        ? lowerTrackedExpression(block.terminator.argument, ctx)
        : null
      if (preserveAccessors && retExpr) {
        retExpr = unwrapAccessorCalls(retExpr, ctx)
      }
      ctx.inReturn = false
      ctx.currentRegion = prevRegion
      return [t.returnStatement(retExpr)]
    }
    case 'Throw':
      return [t.throwStatement(lowerTrackedExpression(block.terminator.argument, ctx))]
    case 'Jump':
      return [t.expressionStatement(t.stringLiteral(`jump ${block.terminator.target}`))]
    case 'Branch':
      return [
        t.ifStatement(
          lowerTrackedExpression(block.terminator.test, ctx),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.consequent}`)),
          ]),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.alternate}`)),
          ]),
        ),
      ]
    case 'Switch':
      return [
        t.switchStatement(
          lowerTrackedExpression(block.terminator.discriminant, ctx),
          block.terminator.cases.map(({ test, target }) =>
            t.switchCase(test ? lowerTrackedExpression(test, ctx) : null, [
              t.expressionStatement(t.stringLiteral(`goto ${target}`)),
            ]),
          ),
        ),
      ]
    case 'ForOf': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return [
        t.forOfStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.iterable, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ]
    }
    case 'ForIn': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return [
        t.forInStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.object, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ]
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
      return [t.tryStatement(tryBlock, catchClause, finallyBlock)]
    }
    case 'Unreachable':
      return []
    case 'Break':
      return [
        t.breakStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ]
    case 'Continue':
      return [
        t.continueStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ]
    default:
      return []
  }
}

/**
 * Attach runtime helper imports used during codegen.
 */
function attachHelperImports(
  ctx: CodegenContext,
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (ctx.helpersUsed.size === 0) return body

  const declared = new Set<string>()
  const addPatternNames = (pattern: BabelCore.types.LVal | BabelCore.types.PatternLike): void => {
    if (t.isIdentifier(pattern)) {
      declared.add(pattern.name)
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

  for (const stmt of body) {
    if (t.isImportDeclaration(stmt)) {
      for (const spec of stmt.specifiers) {
        declared.add(spec.local.name)
      }
      continue
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
      declared.add(stmt.id.name)
      continue
    }
    if (t.isClassDeclaration(stmt) && stmt.id) {
      declared.add(stmt.id.name)
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        addPatternNames(decl.id)
      }
      continue
    }
    if (t.isExportNamedDeclaration(stmt)) {
      if (stmt.declaration) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.id) declared.add(decl.id.name)
        if (t.isClassDeclaration(decl) && decl.id) declared.add(decl.id.name)
        if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) addPatternNames(d.id)
        }
      } else {
        for (const spec of stmt.specifiers) {
          if (t.isExportSpecifier(spec)) {
            declared.add(spec.local.name)
          }
        }
      }
      continue
    }
    if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration)) {
      declared.add(stmt.declaration.name)
    }
  }

  const specifiers: BabelCore.types.ImportSpecifier[] = []

  for (const name of ctx.helpersUsed) {
    const alias = (RUNTIME_ALIASES as Record<string, string>)[name]
    const helper = (RUNTIME_HELPERS as Record<string, string>)[name]
    if (alias && helper) {
      if (declared.has(alias)) continue
      specifiers.push(t.importSpecifier(t.identifier(alias), t.identifier(helper)))
    }
  }

  if (specifiers.length === 0) return body

  const importDecl = t.importDeclaration(specifiers, t.stringLiteral(RUNTIME_MODULE))

  const helpers: BabelCore.types.Statement[] = []
  if (ctx.needsForOfHelper) {
    const itemId = t.identifier('item')
    const iterableId = t.identifier('iterable')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForOf'),
        [iterableId, cbId],
        t.blockStatement([
          t.forOfStatement(
            t.variableDeclaration('const', [t.variableDeclarator(itemId)]),
            iterableId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [itemId]))]),
          ),
        ]),
      ),
    )
  }
  if (ctx.needsForInHelper) {
    const keyId = t.identifier('key')
    const objId = t.identifier('obj')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForIn'),
        [objId, cbId],
        t.blockStatement([
          t.forInStatement(
            t.variableDeclaration('const', [t.variableDeclarator(keyId)]),
            objId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [keyId]))]),
          ),
        ]),
      ),
    )
  }

  return [importDecl, ...helpers, ...body]
}

/**
 * Lower an HIR Expression to a Babel AST Expression.
 * All SSA-versioned variable names are automatically de-versioned to their original names.
 */
export function lowerExpression(expr: Expression, ctx: CodegenContext): BabelCore.types.Expression {
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
    return lowerExpressionImpl(expr, ctx)
  } finally {
    ctx.expressionDepth = depth - 1
  }
}

function lowerExpressionImpl(expr: Expression, ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx
  const mapParams = (params: { name: string }[]) =>
    params.map(p => t.identifier(deSSAVarName(p.name)))
  const withFunctionScope = <T>(paramNames: Set<string>, fn: () => T): T => {
    const prevTracked = ctx.trackedVars
    const prevAlias = ctx.aliasVars
    const prevExternal = ctx.externalTracked
    const prevShadowed = ctx.shadowedNames
    const scoped = new Set(ctx.trackedVars)
    paramNames.forEach(n => scoped.delete(deSSAVarName(n)))
    ctx.trackedVars = scoped
    ctx.aliasVars = new Set(ctx.aliasVars)
    ctx.externalTracked = new Set(prevTracked)
    const shadowed = new Set(prevShadowed ?? [])
    paramNames.forEach(n => shadowed.add(deSSAVarName(n)))
    ctx.shadowedNames = shadowed
    const result = fn()
    ctx.trackedVars = prevTracked
    ctx.aliasVars = prevAlias
    ctx.externalTracked = prevExternal
    ctx.shadowedNames = prevShadowed
    return result
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
    paramIds: BabelCore.types.Identifier[],
  ): BabelCore.types.Statement[] => {
    try {
      const fn: HIRFunction = {
        params: params.map(p => ({ kind: 'Identifier', name: p.name })),
        blocks,
        meta: { fromExpression: true },
      }
      const cfg = analyzeCFG(fn.blocks)
      const hasLoop = cfg.loopHeaders.size > 0 || cfg.backEdges.size > 0
      const { node, diagnostics } = structurizeCFGWithDiagnostics(fn)
      const structured =
        node.kind === 'stateMachine' || hasLoop
          ? node.kind === 'stateMachine'
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
      const declared = new Set(paramIds.map(p => p.name))
      return lowerStructuredNodeWithoutRegions(structured, t, ctx, declared)
    } catch {
      return lowerBlocksToStatements(blocks)
    }
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
      return t.identifier('undefined')

    case 'CallExpression': {
      // Handle Fict macros in experimental path
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$state') {
        ctx.helpersUsed.add('useSignal')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useSignal), [
          t.identifier('__fictCtx'),
          ...expr.arguments.map(a => lowerExpression(a, ctx)),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$effect') {
        ctx.helpersUsed.add('useEffect')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useEffect), [
          t.identifier('__fictCtx'),
          ...expr.arguments.map(arg =>
            arg.kind === 'ArrowFunction' || arg.kind === 'FunctionExpression'
              ? withNonReactiveScope(ctx, () => lowerExpression(arg, ctx))
              : lowerExpression(arg, ctx),
          ),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forOf') {
        ctx.needsForOfHelper = true
        const [iterable, cb] = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier('__fictForOf'), [
          iterable ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forIn') {
        ctx.needsForInHelper = true
        const [obj, cb] = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier('__fictForIn'), [
          obj ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__fictPropsRest') {
        ctx.helpersUsed.add('propsRest')
        const args = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier(RUNTIME_ALIASES.propsRest), args)
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === 'mergeProps') {
        ctx.helpersUsed.add('mergeProps')
        const args = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier(RUNTIME_ALIASES.mergeProps), args)
      }
      const isIIFE =
        (expr.callee.kind === 'ArrowFunction' || expr.callee.kind === 'FunctionExpression') &&
        expr.arguments.length === 0 &&
        expr.callee.params.length === 0
      const lowerCallee = () =>
        isIIFE
          ? withNonReactiveScope(ctx, () => lowerExpression(expr.callee, ctx))
          : lowerExpression(expr.callee, ctx)
      return t.callExpression(
        lowerCallee(),
        expr.arguments.map(a => lowerExpression(a, ctx)),
      )
    }

    case 'MemberExpression':
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
            : t.stringLiteral(String((expr.property as any).value ?? '')),
        expr.computed,
        expr.optional,
      )

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as any,
        lowerExpression(expr.argument, ctx),
        expr.prefix,
      )

    case 'LogicalExpression':
      return t.logicalExpression(
        expr.operator as any,
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
                    ctx.helpersUsed.add('useProp')
                    return t.callExpression(t.identifier(RUNTIME_ALIASES.useProp), [
                      t.arrowFunctionExpression([], valueExprRaw),
                    ])
                  }
                  ctx.helpersUsed.add('propGetter')
                  return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                    t.arrowFunctionExpression([], valueExprRaw),
                  ])
                })()
              : valueExprRaw
          const keyName = p.key.kind === 'Identifier' ? p.key.name : String(p.key.value ?? '')
          const keyNode =
            p.key.kind === 'Identifier' ? t.identifier(keyName) : t.stringLiteral(keyName)

          // If shorthand and value is identifier, use de-versioned name for key too
          const useShorthand =
            p.shorthand &&
            t.isIdentifier(valueExpr) &&
            p.key.kind === 'Identifier' &&
            deSSAVarName(keyName) === valueExpr.name

          return t.objectProperty(
            useShorthand ? t.identifier(valueExpr.name) : keyNode,
            valueExpr,
            false,
            useShorthand,
          )
        }),
      )

    case 'JSXElement':
      return lowerJSXElement(expr, ctx)

    case 'ArrowFunction': {
      const paramIds = mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      return withFunctionScope(shadowed, () => {
        let fn: BabelCore.types.ArrowFunctionExpression
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
      })
    }

    case 'FunctionExpression': {
      const paramIds = mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      return withFunctionScope(shadowed, () => {
        let fn: BabelCore.types.FunctionExpression
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
        return fn
      })
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
                  : t.stringLiteral(String((expr.left.property as any).value ?? '')),
              expr.left.computed,
              expr.left.optional,
            )
            const current = t.callExpression(member, [])
            const right = lowerExpression(expr.right, ctx)
            let next: BabelCore.types.Expression
            switch (expr.operator) {
              case '=':
                next = right
                break
              case '+=':
                next = t.binaryExpression('+', current, right)
                break
              case '-=':
                next = t.binaryExpression('-', current, right)
                break
              case '*=':
                next = t.binaryExpression('*', current, right)
                break
              case '/=':
                next = t.binaryExpression('/', current, right)
                break
              default:
                next = right
            }
            return t.callExpression(member, [next])
          }
        }
      }
      if (expr.left.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.left.name)
        if (ctx.trackedVars.has(baseName)) {
          const id = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const right = lowerExpression(expr.right, ctx)
          let next: BabelCore.types.Expression
          switch (expr.operator) {
            case '=':
              next = right
              break
            case '+=':
              next = t.binaryExpression('+', current, right)
              break
            case '-=':
              next = t.binaryExpression('-', current, right)
              break
            case '*=':
              next = t.binaryExpression('*', current, right)
              break
            case '/=':
              next = t.binaryExpression('/', current, right)
              break
            default:
              next = right
          }
          return t.callExpression(id, [next])
        }
      }

      return t.assignmentExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx) as any,
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
                  : t.stringLiteral(String((expr.argument.property as any).value ?? '')),
              expr.argument.computed,
              expr.argument.optional,
            )
            const current = t.callExpression(member, [])
            const delta = t.numericLiteral(1)
            const next =
              expr.operator === '++'
                ? t.binaryExpression('+', current, delta)
                : t.binaryExpression('-', current, delta)
            return t.callExpression(member, [next])
          }
        }
      }
      if (expr.argument.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.argument.name)
        if (ctx.trackedVars.has(baseName)) {
          const id = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const delta = t.numericLiteral(1)
          const next =
            expr.operator === '++'
              ? t.binaryExpression('+', current, delta)
              : t.binaryExpression('-', current, delta)
          return t.callExpression(id, [next])
        }
      }

      return t.updateExpression(
        expr.operator,
        lowerExpression(expr.argument, ctx) as any,
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
      return t.newExpression(
        lowerExpression(expr.callee, ctx),
        expr.arguments.map(a => lowerExpression(a, ctx)),
      )

    case 'SequenceExpression':
      return t.sequenceExpression(expr.expressions.map(e => lowerExpression(e, ctx)))

    case 'YieldExpression':
      return t.yieldExpression(
        expr.argument ? lowerExpression(expr.argument, ctx) : null,
        expr.delegate,
      )

    case 'OptionalCallExpression':
      return t.optionalCallExpression(
        lowerExpression(expr.callee, ctx),
        expr.arguments.map(a => lowerExpression(a, ctx)),
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
            : t.stringLiteral(String((expr.property as any).value ?? '')),
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
): BabelCore.types.Expression {
  let lowered = lowerExpression(expr, ctx)
  if (
    ctx.t.isMemberExpression(lowered) &&
    ctx.t.isIdentifier(lowered.object) &&
    ctx.hookResultVarMap?.has(deSSAVarName(lowered.object.name))
  ) {
    lowered = ctx.t.callExpression(lowered, [])
  } else if (ctx.t.isIdentifier(lowered)) {
    const hookName = ctx.hookResultVarMap?.get(deSSAVarName(lowered.name))
    if (hookName) {
      const info = getHookReturnInfo(hookName, ctx)
      if (info?.directAccessor) {
        lowered = ctx.t.callExpression(ctx.t.identifier(deSSAVarName(lowered.name)), [])
      }
    }
  }
  return applyRegionMetadataToExpression(lowered, ctx, region)
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
    return t.arrowFunctionExpression([], lowered)
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
          valueExpr = t.arrowFunctionExpression([], rawExpr)
        }
      } else if (isExpressionReactive(attr.value, ctx)) {
        valueExpr = t.arrowFunctionExpression([], rawExpr)
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
    const propsObj = buildPropsObject(jsx.attributes, ctx)
    const children = jsx.children.map(c => lowerJSXChild(c, ctx))

    const componentRef =
      typeof jsx.tagName === 'string'
        ? t.identifier(jsx.tagName)
        : lowerExpression(jsx.tagName, ctx)

    // Build props with children included
    const propsWithChildren: BabelCore.types.ObjectProperty[] = []

    // Add existing props
    if (propsObj && t.isObjectExpression(propsObj)) {
      propsWithChildren.push(...(propsObj.properties as BabelCore.types.ObjectProperty[]))
    }

    // Add children if present
    if (children.length === 1 && children[0]) {
      propsWithChildren.push(t.objectProperty(t.identifier('children'), children[0]))
    } else if (children.length > 1) {
      propsWithChildren.push(
        t.objectProperty(t.identifier('children'), t.arrayExpression(children)),
      )
    }

    // Create VNode: { type: Component, props: {...} }
    // Return VNode object directly - runtime render()/insert() will call createElement on it
    return t.objectExpression([
      t.objectProperty(t.identifier('type'), componentRef),
      t.objectProperty(
        t.identifier('props'),
        propsWithChildren.length > 0 ? t.objectExpression(propsWithChildren) : t.nullLiteral(),
      ),
    ])
  }

  const useFineGrainedDom = !ctx.noMemo
  if (!useFineGrainedDom) {
    return lowerIntrinsicElementAsVNode(jsx, ctx)
  }

  // Intrinsic element - use fine-grained DOM
  return lowerIntrinsicElement(jsx, ctx)
}

/**
 * Collect all dependency variable names from an expression (de-versioned).
 */
function getMemberDependencyPath(expr: any): string | undefined {
  if (expr.kind === 'MemberExpression') {
    const prop = expr.property
    let propName: string | undefined
    if (!expr.computed && prop.kind === 'Identifier') {
      propName = prop.name
    } else if (prop.kind === 'Literal' && typeof prop.value === 'string') {
      propName = prop.value
    }
    if (!propName) return undefined
    const object = expr.object
    if (object.kind === 'Identifier') {
      return `${deSSAVarName(object.name)}.${propName}`
    }
    if (object.kind === 'MemberExpression') {
      const parent = getMemberDependencyPath(object)
      return parent ? `${parent}.${propName}` : undefined
    }
  }
  return undefined
}

function collectExpressionDependencies(expr: Expression, deps: Set<string>): void {
  if (expr.kind === 'Identifier') {
    deps.add(deSSAVarName(expr.name))
    return
  }
  if (expr.kind === 'MemberExpression') {
    const path = getMemberDependencyPath(expr)
    if (path) deps.add(path)
    collectExpressionDependencies(expr.object, deps)
    if (expr.computed && expr.property.kind !== 'Literal') {
      collectExpressionDependencies(expr.property, deps)
    }
    return
  }
  if (expr.kind === 'CallExpression') {
    collectExpressionDependencies(expr.callee, deps)
    expr.arguments.forEach(a => collectExpressionDependencies(a, deps))
    return
  }
  if (expr.kind === 'BinaryExpression' || expr.kind === 'LogicalExpression') {
    collectExpressionDependencies(expr.left, deps)
    collectExpressionDependencies(expr.right, deps)
    return
  }
  if (expr.kind === 'ConditionalExpression') {
    collectExpressionDependencies(expr.test, deps)
    collectExpressionDependencies(expr.consequent, deps)
    collectExpressionDependencies(expr.alternate, deps)
    return
  }
  if (expr.kind === 'UnaryExpression') {
    collectExpressionDependencies(expr.argument, deps)
    return
  }
  if (expr.kind === 'ArrayExpression') {
    expr.elements.forEach(el => collectExpressionDependencies(el, deps))
    return
  }
  if (expr.kind === 'ObjectExpression') {
    expr.properties.forEach(p => {
      if (p.kind === 'SpreadElement') {
        collectExpressionDependencies(p.argument, deps)
      } else {
        collectExpressionDependencies(p.value, deps)
      }
    })
    return
  }
  if (expr.kind === 'TemplateLiteral') {
    expr.expressions.forEach(e => collectExpressionDependencies(e, deps))
    return
  }
}

type RegionOverrideMap = Record<string, () => BabelCore.types.Expression>

function normalizeDependencyKey(name: string): string {
  return name
    .split('.')
    .map(part => deSSAVarName(part))
    .join('.')
}

function getDependencyPathFromNode(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(node)) {
    return normalizeDependencyKey(node.name)
  }

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node as any)) {
    const object = (node as any).object as BabelCore.types.Node
    const property = (node as any).property as BabelCore.types.Node
    const objectPath = getDependencyPathFromNode(object, t)
    if (!objectPath) return null

    let propName: string | null = null
    if ((node as any).computed) {
      if (t.isStringLiteral(property) || t.isNumericLiteral(property)) {
        propName = String((property as any).value)
      }
    } else if (t.isIdentifier(property)) {
      propName = property.name
    }

    if (!propName) return objectPath
    return `${objectPath}.${propName}`
  }

  return null
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
): BabelCore.types.Expression {
  if (ctx.inReturn && ctx.currentFnIsHook) {
    return expr
  }
  const region = regionOverride ?? ctx.currentRegion
  if (!region) return expr

  const metadata = regionInfoToMetadata(region)
  const state: { identifierOverrides?: RegionOverrideMap } = {}

  applyRegionMetadata(state as any, {
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

  if (ctx.t.isIdentifier(expr)) {
    const key = normalizeDependencyKey(expr.name)
    const direct = overrides[key] ?? overrides[expr.name]
    if (direct) {
      return direct()
    }
  }

  const cloned = ctx.t.cloneNode(expr, true) as BabelCore.types.Expression
  replaceIdentifiersWithOverrides(cloned, overrides, ctx.t)
  return cloned
}

/**
 * Replace identifiers using overrides while skipping call/optional call callees.
 * This is adapted from fine-grained-dom's replaceIdentifiers helper.
 */
function replaceIdentifiersWithOverrides(
  node: BabelCore.types.Node,
  overrides: RegionOverrideMap,
  t: typeof BabelCore.types,
  parentKind?: string,
  parentKey?: string,
): void {
  const isCallTarget =
    parentKey === 'callee' &&
    (parentKind === 'CallExpression' || parentKind === 'OptionalCallExpression')

  const collectParamNames = (params: BabelCore.types.Function['params']): Set<string> => {
    const names = new Set<string>()
    const addName = (n: string | undefined) => {
      if (n) names.add(normalizeDependencyKey(n).split('.')[0] ?? n)
    }
    const visitPattern = (p: BabelCore.types.LVal | BabelCore.types.PatternLike) => {
      if (t.isIdentifier(p)) {
        addName(p.name)
      } else if (t.isTSParameterProperty(p)) {
        visitPattern(p.parameter as any)
      } else if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
        addName(p.argument.name)
      } else if (t.isAssignmentPattern(p)) {
        visitPattern(p.left)
      } else if (t.isObjectPattern(p)) {
        p.properties.forEach(prop => {
          if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            addName(prop.argument.name)
          } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
            addName(prop.value.name)
          } else if (t.isObjectProperty(prop) && t.isPatternLike(prop.value)) {
            visitPattern(prop.value as BabelCore.types.PatternLike)
          }
        })
      } else if (t.isArrayPattern(p)) {
        p.elements.forEach(el => {
          if (t.isIdentifier(el)) addName(el.name)
          else if (el && t.isPatternLike(el)) visitPattern(el as any)
        })
      }
    }
    params.forEach(p => visitPattern(p))
    return names
  }

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node as any)) {
    const path = getDependencyPathFromNode(node, t)
    const normalized = path ? normalizeDependencyKey(path) : null
    const override = (normalized && overrides[normalized]) || (path ? overrides[path] : undefined)
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isIdentifier(node)) {
    const key = normalizeDependencyKey(node.name)
    const override = overrides[key] ?? overrides[node.name]
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    const paramNames = collectParamNames(node.params)
    let scopedOverrides = overrides
    if (paramNames.size > 0) {
      scopedOverrides = {}
      for (const key of Object.keys(overrides)) {
        const base = normalizeDependencyKey(key).split('.')[0] ?? key
        if (!paramNames.has(base)) {
          scopedOverrides[key] = overrides[key]!
        }
      }
    }
    // Avoid replacing parameter identifiers; only walk the body
    if (t.isBlockStatement(node.body)) {
      replaceIdentifiersWithOverrides(node.body, scopedOverrides, t, node.type, 'body')
    } else {
      replaceIdentifiersWithOverrides(node.body, scopedOverrides, t, node.type, 'body')
    }
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    if (t.isObjectProperty(node as any) && key === 'key' && !(node as any).computed) {
      continue
    }
    if (
      (t.isMemberExpression(node as any) || t.isOptionalMemberExpression(node as any)) &&
      key === 'property' &&
      !(node as any).computed
    ) {
      continue
    }
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in (item as any)) {
          replaceIdentifiersWithOverrides(
            item as BabelCore.types.Node,
            overrides,
            t,
            node.type,
            key,
          )
        }
      }
    } else if (value && typeof value === 'object' && 'type' in (value as any)) {
      replaceIdentifiersWithOverrides(value as BabelCore.types.Node, overrides, t, node.type, key)
    }
  }
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
    const key = /^[a-zA-Z_$][\w$]*$/.test(prop) ? t.identifier(prop) : t.stringLiteral(prop)
    return t.memberExpression(acc, key, t.isStringLiteral(key))
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

function regionInfoToMetadata(region: RegionInfo): RegionMetadata {
  return {
    id: region.id,
    dependencies: new Set(region.dependencies),
    declarations: new Set(region.declarations),
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: region.hasReactiveWrites ?? region.declarations.size > 0,
  }
}

/**
 * Find the region that contains all dependencies of an expression.
 * Returns the region if all deps are covered by a single region, null otherwise.
 */
function findContainingRegion(deps: Set<string>, ctx: CodegenContext): RegionInfo | null {
  if (!ctx.regions || ctx.regions.length === 0 || deps.size === 0) return null

  const depList = Array.from(deps).map(d => normalizeDependencyKey(d))

  // Find a region whose declarations cover all the dependencies
  for (const region of ctx.regions) {
    let allCovered = true
    for (const dep of depList) {
      const coveredByRegion =
        dependencyCoveredByRegion(dep, region) ||
        dependencyCoveredByDeclarations(dep, region) ||
        ctx.trackedVars.has(dep)
      if (!coveredByRegion) {
        allCovered = false
        break
      }
    }
    if (allCovered) return region
  }
  return null
}

function dependencyCoveredByRegion(dep: string, region: RegionInfo): boolean {
  for (const rDep of region.dependencies) {
    const normalized = normalizeDependencyKey(rDep)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
}

function dependencyCoveredByDeclarations(dep: string, region: RegionInfo): boolean {
  for (const decl of region.declarations) {
    const normalized = normalizeDependencyKey(decl)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
}

/**
 * Check if an HIR expression references a tracked/reactive variable.
 * Uses de-versioned names for matching.
 * Also considers region membership for more precise reactivity detection.
 */
function isExpressionReactive(expr: Expression, ctx: CodegenContext): boolean {
  // First collect all dependencies
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  // Check if any dependency is tracked
  for (const dep of deps) {
    if (ctx.trackedVars.has(dep)) return true
  }

  // Check if any dependency is in a reactive region's declarations
  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        return true
      }
    }
  }

  return false
}

/**
 * Get the reactive dependencies of an expression that require binding.
 * Returns the set of tracked variables that the expression depends on.
 */
function _getReactiveDependencies(expr: Expression, ctx: CodegenContext): Set<string> {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  const reactiveDeps = new Set<string>()
  for (const dep of deps) {
    if (ctx.trackedVars.has(dep)) {
      reactiveDeps.add(dep)
    }
  }

  // Also check region declarations
  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        reactiveDeps.add(dep)
      }
    }
  }

  return reactiveDeps
}

// ============================================================================
// HIR Template Extraction (aligned with fine-grained-dom.ts)
// ============================================================================

interface HIRBinding {
  type: 'attr' | 'child' | 'event' | 'key'
  path: number[] // path to navigate from root to target node
  name?: string // for attributes/events
  expr?: Expression // the dynamic expression
  eventOptions?: { capture?: boolean; passive?: boolean; once?: boolean }
}

interface HIRTemplateExtractionResult {
  html: string
  bindings: HIRBinding[]
}

/**
 * Check if an expression is static (can be included in template HTML).
 */
function isStaticValue(expr: Expression | null): expr is Expression & { kind: 'Literal' } {
  if (!expr) return false
  return expr.kind === 'Literal'
}

/**
 * Normalize attribute names for special cases.
 */
function normalizeHIRAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
}

/**
 * Extract static HTML from HIR JSXElementExpression.
 * Similar to extractStaticHtml from fine-grained-dom.ts but works with HIR types.
 */
function extractHIRStaticHtml(
  jsx: JSXElementExpression,
  parentPath: number[] = [],
): HIRTemplateExtractionResult {
  const tagName = jsx.tagName as string
  let html = `<${tagName}`
  const bindings: HIRBinding[] = []

  // Process attributes
  for (const attr of jsx.attributes) {
    if (attr.isSpread) {
      // Spread attributes are always dynamic - skip in template
      continue
    }

    const name = normalizeHIRAttrName(attr.name)

    // Key attribute is for list reconciliation only; keep expression for evaluation
    if (name === 'key') {
      if (attr.value && !isStaticValue(attr.value)) {
        bindings.push({
          type: 'key',
          path: [...parentPath],
          expr: attr.value,
        })
      }
      continue
    }

    // Event handlers are always dynamic
    if (name.startsWith('on') && name.length > 2 && name[2] === name[2]?.toUpperCase()) {
      let eventName = name.slice(2)
      let capture = false
      let passive = false
      let once = false

      // Parse event modifiers
      let changed = true
      while (changed) {
        changed = false
        if (eventName.endsWith('Capture')) {
          eventName = eventName.slice(0, -7)
          capture = true
          changed = true
        }
        if (eventName.endsWith('Passive')) {
          eventName = eventName.slice(0, -7)
          passive = true
          changed = true
        }
        if (eventName.endsWith('Once')) {
          eventName = eventName.slice(0, -4)
          once = true
          changed = true
        }
      }

      bindings.push({
        type: 'event',
        path: [...parentPath],
        name: eventName.toLowerCase(),
        expr: attr.value ?? undefined,
        eventOptions: { capture, passive, once },
      })
      continue
    }

    // ref is always dynamic
    if (name === 'ref') {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name: 'ref',
        expr: attr.value ?? undefined,
      })
      continue
    }

    // Check if value is static
    if (isStaticValue(attr.value)) {
      const value = attr.value.value
      if (typeof value === 'string') {
        // Escape HTML attribute value
        const escaped = String(value).replace(/"/g, '&quot;')
        html += ` ${name}="${escaped}"`
      } else if (typeof value === 'boolean' && value) {
        html += ` ${name}`
      } else if (typeof value === 'number') {
        html += ` ${name}="${value}"`
      }
    } else if (attr.value === null) {
      // Boolean attribute without value
      html += ` ${name}`
    } else {
      // Dynamic attribute
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
      })
    }
  }

  html += '>'

  // Process children
  let childIndex = 0
  for (const child of jsx.children) {
    if (child.kind === 'text') {
      const text = child.value
      if (text.trim()) {
        html += text
        childIndex++
      }
    } else if (child.kind === 'element') {
      const childPath = [...parentPath, childIndex]
      const childResult = extractHIRStaticHtml(child.value, childPath)
      html += childResult.html
      bindings.push(...childResult.bindings)
      childIndex++
    } else if (child.kind === 'expression') {
      // Dynamic expression - insert placeholder comment
      html += '<!---->'
      bindings.push({
        type: 'child',
        path: [...parentPath, childIndex],
        expr: child.value,
      })
      childIndex++
    }
  }

  html += `</${tagName}>`

  return { html, bindings }
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

  // Extract static HTML with bindings (aligned with fine-grained-dom.ts)
  const { html, bindings } = extractHIRStaticHtml(jsx)

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
  const shouldMemo =
    !ctx.inListRender && !(ctx.inConditional && ctx.inConditional > 0) && regionMeta
      ? shouldMemoizeRegion(regionMeta)
      : false
  if (shouldMemo) {
    ctx.helpersUsed.add('useMemo')
    ctx.needsCtx = true
  }

  // Create template with full static HTML
  ctx.helpersUsed.add('template')
  const tmplId = genTemp(ctx, 'tmpl')
  const rootId = genTemp(ctx, 'root')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        tmplId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.template), [t.stringLiteral(html)]),
      ),
    ]),
  )
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(rootId, t.callExpression(t.identifier(tmplId.name), [])),
    ]),
  )
  // Note: template() already returns content.firstChild, so rootId IS the root element
  // We use rootId directly as elId
  const elId = rootId

  // Build a cache for resolved node paths
  const nodeCache = new Map<string, BabelCore.types.Identifier>()
  nodeCache.set('', elId)

  // Precompute node references before any binding mutates the DOM tree
  const pathStatements: BabelCore.types.Statement[] = []
  for (const binding of bindings) {
    resolveHIRBindingPath(binding.path, nodeCache, pathStatements, ctx)
  }
  statements.push(...pathStatements)

  // Apply bindings using path navigation
  for (const binding of bindings) {
    const targetId = resolveHIRBindingPath(binding.path, nodeCache, statements, ctx)

    if (binding.type === 'event' && binding.expr && binding.name) {
      // Event binding
      ctx.helpersUsed.add('bindEvent')
      ctx.helpersUsed.add('onDestroy')
      const prevWrapTracked = ctx.wrapTrackedExpressions
      ctx.wrapTrackedExpressions = false
      const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      ctx.wrapTrackedExpressions = prevWrapTracked
      const handlerExpr =
        t.isArrowFunctionExpression(valueExpr) || t.isFunctionExpression(valueExpr)
          ? valueExpr
          : t.arrowFunctionExpression([], valueExpr)
      const cleanupId = genTemp(ctx, 'evt')
      const args: BabelCore.types.Expression[] = [
        targetId,
        t.stringLiteral(binding.name),
        handlerExpr,
      ]
      if (
        binding.eventOptions &&
        (binding.eventOptions.capture || binding.eventOptions.passive || binding.eventOptions.once)
      ) {
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
    } else if (binding.type === 'attr' && binding.name) {
      // Attribute binding
      const attrName = binding.name
      const valueExpr = binding.expr
        ? lowerDomExpression(binding.expr, ctx, containingRegion)
        : t.booleanLiteral(true)
      const valueIdentifier = ctx.t.isIdentifier(valueExpr)
        ? deSSAVarName(valueExpr.name)
        : undefined
      const valueWithRegion =
        valueIdentifier &&
        (regionMeta?.dependencies.has(valueIdentifier) || ctx.trackedVars.has(valueIdentifier))
          ? buildDependencyGetter(valueIdentifier, ctx)
          : valueExpr

      if (attrName === 'ref') {
        ctx.helpersUsed.add('bindRef')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindRef), [targetId, valueExpr]),
          ),
        )
      } else if (attrName === 'class' || attrName === 'className') {
        ctx.helpersUsed.add('bindClass')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindClass), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else if (attrName === 'style') {
        ctx.helpersUsed.add('bindStyle')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindStyle), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else if (isDOMProperty(attrName)) {
        ctx.helpersUsed.add('bindProperty')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindProperty), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else {
        ctx.helpersUsed.add('bindAttribute')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindAttribute), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      }
    } else if (binding.type === 'key' && binding.expr) {
      statements.push(
        t.expressionStatement(lowerDomExpression(binding.expr, ctx, containingRegion)),
      )
    } else if (binding.type === 'child' && binding.expr) {
      // Child binding (dynamic expression at placeholder)
      emitHIRChildBinding(targetId, binding.expr, statements, ctx, containingRegion)
    }
  }

  // Restore previous region
  applyRegionToContext(ctx, prevRegion ?? null)

  // Return element
  statements.push(t.returnStatement(elId))

  const body = t.blockStatement(statements)

  // Wrap in memo if region suggests memoization
  if (shouldMemo && containingRegion) {
    // __fictUseMemo returns a getter function - invoke it to get the actual DOM element
    const memoArgs: BabelCore.types.Expression[] = [
      t.identifier('__fictCtx'),
      t.arrowFunctionExpression([], body),
    ]
    if (ctx.isComponentFn) {
      memoArgs.push(t.numericLiteral(reserveHookSlot(ctx)))
    }
    return t.callExpression(t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), memoArgs), [])
  }

  // Wrap in IIFE
  return t.callExpression(t.arrowFunctionExpression([], body), [])
}

/**
 * Resolve a path to a DOM node using firstChild/nextSibling navigation.
 * Caches intermediate nodes for efficiency.
 */
function resolveHIRBindingPath(
  path: number[],
  cache: Map<string, BabelCore.types.Identifier>,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Identifier {
  const key = path.join(',')
  if (cache.has(key)) return cache.get(key)!

  const { t } = ctx

  // Find closest ancestor in cache
  const ancestorPath = [...path]
  let ancestorId: BabelCore.types.Identifier | undefined
  let relativePath: number[] = []

  while (ancestorPath.length > 0) {
    ancestorPath.pop()
    const ancestorKey = ancestorPath.join(',')
    if (cache.has(ancestorKey)) {
      ancestorId = cache.get(ancestorKey)
      relativePath = path.slice(ancestorPath.length)
      break
    }
  }

  if (!ancestorId) {
    ancestorId = cache.get('')!
    relativePath = path
  }

  // Navigate relative path using firstChild/nextSibling
  let currentExpr: BabelCore.types.Expression = ancestorId
  for (const index of relativePath) {
    currentExpr = t.memberExpression(currentExpr, t.identifier('firstChild'))
    for (let i = 0; i < index; i++) {
      currentExpr = t.memberExpression(currentExpr, t.identifier('nextSibling'))
    }
  }

  const varId = genTemp(ctx, 'el')
  statements.push(t.variableDeclaration('const', [t.variableDeclarator(varId, currentExpr)]))
  cache.set(key, varId)
  return varId
}

/**
 * Emit a child binding at a placeholder comment node.
 */
function emitHIRChildBinding(
  markerId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
): void {
  const { t } = ctx
  const parentId = t.memberExpression(markerId, t.identifier('parentNode'))

  // createPortal call inside JSX child: register cleanup but don't insert marker into parent
  if (
    expr.kind === 'CallExpression' &&
    expr.callee.kind === 'Identifier' &&
    expr.callee.name === 'createPortal'
  ) {
    ctx.helpersUsed.add('onDestroy')
    const portalId = genTemp(ctx, 'portal')
    const portalExpr = lowerExpression(expr, ctx)
    statements.push(
      t.variableDeclaration('const', [t.variableDeclarator(portalId, portalExpr)]),
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
          t.memberExpression(portalId, t.identifier('dispose')),
        ]),
      ),
    )
    return
  }

  // Check if it's a conditional
  if (
    expr.kind === 'ConditionalExpression' ||
    (expr.kind === 'LogicalExpression' && expr.operator === '&&')
  ) {
    emitConditionalChild(parentId, markerId, expr, statements, ctx)
    return
  }

  // Check if it's a list (.map call)
  if (expr.kind === 'CallExpression') {
    const callee = expr.callee
    if (
      callee.kind === 'MemberExpression' &&
      callee.property.kind === 'Identifier' &&
      callee.property.name === 'map'
    ) {
      emitListChild(parentId, markerId, expr, statements, ctx)
      return
    }
  }

  // Check if it's a JSX element
  if (expr.kind === 'JSXElement') {
    const childExpr = lowerJSXElement(expr, ctx)
    ctx.helpersUsed.add('insert')
    ctx.helpersUsed.add('createElement')
    statements.push(
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
          parentId,
          t.arrowFunctionExpression([], childExpr),
          markerId,
          t.identifier(RUNTIME_ALIASES.createElement),
        ]),
      ),
    )
    return
  }

  // Default: insert dynamic expression
  const valueExpr = lowerDomExpression(expr, ctx, containingRegion)
  ctx.helpersUsed.add('insert')
  ctx.helpersUsed.add('createElement')
  statements.push(
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
        parentId,
        t.arrowFunctionExpression([], valueExpr),
        markerId,
        t.identifier(RUNTIME_ALIASES.createElement),
      ]),
    ),
  )
}

/**
 * Emit a conditional child expression
 */
function emitConditionalChild(
  parentId: BabelCore.types.Expression,
  markerId: BabelCore.types.Expression,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('conditional')
  ctx.helpersUsed.add('createElement')
  ctx.helpersUsed.add('onDestroy')
  ctx.helpersUsed.add('toNodeArray')

  let condition: BabelCore.types.Expression
  let consequent: BabelCore.types.Expression
  let alternate: BabelCore.types.Expression | null = null

  const enterConditional = () => {
    ctx.inConditional = (ctx.inConditional ?? 0) + 1
  }
  const exitConditional = () => {
    ctx.inConditional = Math.max(0, (ctx.inConditional ?? 1) - 1)
  }

  if (expr.kind === 'ConditionalExpression') {
    condition = lowerDomExpression(expr.test, ctx)
    enterConditional()
    consequent = lowerDomExpression(expr.consequent, ctx)
    alternate = lowerDomExpression(expr.alternate, ctx)
    exitConditional()
  } else if (expr.kind === 'LogicalExpression' && expr.operator === '&&') {
    condition = lowerDomExpression(expr.left, ctx)
    enterConditional()
    consequent = lowerDomExpression(expr.right, ctx)
    exitConditional()
  } else {
    return
  }

  const bindingId = genTemp(ctx, 'cond')
  const args: BabelCore.types.Expression[] = [
    t.arrowFunctionExpression([], condition),
    t.arrowFunctionExpression([], consequent),
    t.identifier(RUNTIME_ALIASES.createElement),
  ]
  if (alternate) {
    args.push(t.arrowFunctionExpression([], alternate))
  }

  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        bindingId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), args),
      ),
    ]),
  )

  // Insert markers
  const markersId = genTemp(ctx, 'markers')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        markersId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
          t.memberExpression(bindingId, t.identifier('marker')),
        ]),
      ),
    ]),
  )

  const mId = genTemp(ctx, 'm')
  statements.push(
    t.forOfStatement(
      t.variableDeclaration('const', [t.variableDeclarator(mId)]),
      markersId,
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(t.memberExpression(parentId, t.identifier('insertBefore')), [
            mId,
            markerId,
          ]),
        ),
      ]),
    ),
  )

  // Flush and cleanup
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(bindingId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(bindingId, t.identifier('dispose')),
      ]),
    ),
  )
}

/**
 * Emit a list rendering child (array.map)
 */
function emitListChild(
  parentId: BabelCore.types.Expression,
  markerId: BabelCore.types.Expression,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx

  if (expr.kind !== 'CallExpression' || expr.callee.kind !== 'MemberExpression') {
    return
  }

  const arrayExpr = lowerDomExpression(expr.callee.object, ctx)
  const mapCallback = expr.arguments[0]
  if (!mapCallback) {
    throw new Error('map callback is required')
  }
  const keyExpr = extractKeyFromMapCallback(mapCallback)
  const isKeyed = !!keyExpr

  ctx.helpersUsed.add('onDestroy')
  ctx.helpersUsed.add('toNodeArray')
  if (isKeyed) {
    ctx.helpersUsed.add('keyedList')
  } else {
    ctx.helpersUsed.add('list')
    ctx.helpersUsed.add('createElement')
  }

  const prevInListRender = ctx.inListRender
  ctx.inListRender = true
  let callbackExpr = lowerExpression(mapCallback, ctx)
  ctx.inListRender = prevInListRender
  callbackExpr = applyRegionMetadataToExpression(callbackExpr, ctx)

  if (
    isKeyed &&
    (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr))
  ) {
    const firstParam = callbackExpr.params[0]
    if (t.isIdentifier(firstParam)) {
      const overrides: RegionOverrideMap = {
        [firstParam.name]: () => t.callExpression(t.identifier(firstParam.name), []),
      }
      if (t.isBlockStatement(callbackExpr.body)) {
        replaceIdentifiersWithOverrides(callbackExpr.body, overrides, t, callbackExpr.type, 'body')
      } else {
        const newBody = t.cloneNode(callbackExpr.body, true) as BabelCore.types.Expression
        replaceIdentifiersWithOverrides(newBody, overrides, t, callbackExpr.type, 'body')
        callbackExpr = t.arrowFunctionExpression(callbackExpr.params, newBody)
      }
    }
  }

  const listId = genTemp(ctx, 'list')
  if (isKeyed && keyExpr) {
    let keyExprAst = lowerExpression(keyExpr, ctx)
    if (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) {
      const itemParam = callbackExpr.params[0]
      const indexParam = callbackExpr.params[1]
      const shadowed = new Set(ctx.shadowedNames ?? [])
      if (t.isIdentifier(itemParam)) shadowed.add(itemParam.name)
      if (t.isIdentifier(indexParam)) shadowed.add(indexParam.name)
      const prevShadowed = ctx.shadowedNames
      ctx.shadowedNames = shadowed
      keyExprAst = applyRegionMetadataToExpression(keyExprAst, ctx)
      ctx.shadowedNames = prevShadowed
    }

    const itemParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? callbackExpr.params[0]
        : null
    const indexParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? callbackExpr.params[1]
        : null
    const keyFn = t.arrowFunctionExpression(
      [
        t.isIdentifier(itemParamName) ? itemParamName : t.identifier('__item'),
        t.isIdentifier(indexParamName) ? indexParamName : t.identifier('__index'),
      ],
      keyExprAst,
    )

    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          listId,
          t.callExpression(t.identifier(RUNTIME_ALIASES.keyedList), [
            t.arrowFunctionExpression([], arrayExpr),
            keyFn,
            callbackExpr,
          ]),
        ),
      ]),
    )
  } else {
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          listId,
          t.callExpression(t.identifier(RUNTIME_ALIASES.list), [
            t.arrowFunctionExpression([], arrayExpr),
            callbackExpr,
            t.identifier(RUNTIME_ALIASES.createElement),
          ]),
        ),
      ]),
    )
  }

  // Insert markers
  const markersId = genTemp(ctx, 'markers')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        markersId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
          t.memberExpression(listId, t.identifier('marker')),
        ]),
      ),
    ]),
  )

  const mId = genTemp(ctx, 'm')
  statements.push(
    t.forOfStatement(
      t.variableDeclaration('const', [t.variableDeclarator(mId)]),
      markersId,
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(t.memberExpression(parentId, t.identifier('insertBefore')), [
            mId,
            markerId,
          ]),
        ),
      ]),
    ),
  )

  // Flush and cleanup
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(listId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(listId, t.identifier('dispose')),
      ]),
    ),
  )
}

/**
 * Emit a dynamic text child
 */
function _emitDynamicTextChild(
  parentId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('bindText')
  ctx.helpersUsed.add('insert')
  ctx.helpersUsed.add('createElement')

  statements.push(
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
        parentId,
        t.arrowFunctionExpression(
          [],
          applyRegionMetadataToExpression(lowerExpression(expr, ctx), ctx),
        ),
        t.nullLiteral(),
        t.identifier(RUNTIME_ALIASES.createElement),
      ]),
    ),
  )
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
 * Build props object from JSX attributes
 */
function buildPropsObject(
  attributes: JSXElementExpression['attributes'],
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  const { t } = ctx
  const prevPropsContext = ctx.inPropsContext
  ctx.inPropsContext = true

  try {
    if (attributes.length === 0) return null

    const properties: BabelCore.types.ObjectProperty[] = []
    const spreads: BabelCore.types.SpreadElement[] = []
    const toPropKey = (name: string) =>
      /^[a-zA-Z_$][\w$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name)
    const isAccessorName = (name: string): boolean =>
      (ctx.memoVars?.has(name) ?? false) ||
      (ctx.signalVars?.has(name) ?? false) ||
      (ctx.aliasVars?.has(name) ?? false)

    const wrapAccessorSource = (node: BabelCore.types.Expression): BabelCore.types.Expression => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.arguments.length === 0) {
        const baseName = deSSAVarName(node.callee.name)
        if (isAccessorName(baseName)) {
          // Keep accessor lazy so mergeProps can re-evaluate per access
          return t.arrowFunctionExpression([], node)
        }
      }
      if (t.isIdentifier(node)) {
        const baseName = deSSAVarName(node.name)
        if (isAccessorName(baseName)) {
          return t.arrowFunctionExpression([], t.callExpression(t.identifier(baseName), []))
        }
      }
      return node
    }

    for (const attr of attributes) {
      if (attr.isSpread && attr.spreadExpr) {
        let spreadExpr = lowerDomExpression(attr.spreadExpr, ctx)
        if (t.isCallExpression(spreadExpr)) {
          const callExpr = spreadExpr
          const rewrittenArgs = callExpr.arguments.map(arg =>
            t.isExpression(arg) ? wrapAccessorSource(arg) : arg,
          )
          if (rewrittenArgs.some((arg, idx) => arg !== callExpr.arguments[idx])) {
            spreadExpr = t.callExpression(callExpr.callee, rewrittenArgs as any)
          }
        }
        spreadExpr = wrapAccessorSource(spreadExpr)
        spreads.push(t.spreadElement(spreadExpr))
      } else if (attr.value) {
        const isFunctionLike =
          attr.value.kind === 'ArrowFunction' || attr.value.kind === 'FunctionExpression'
        const prevPropsCtx: boolean | undefined = ctx.inPropsContext
        // Avoid treating function bodies as props context to prevent wrapping internal values
        if (isFunctionLike) {
          ctx.inPropsContext = false
        }
        const lowered = lowerDomExpression(attr.value, ctx)
        if (isFunctionLike) {
          ctx.inPropsContext = prevPropsCtx
        }
        const baseIdent =
          attr.value.kind === 'Identifier' ? deSSAVarName(attr.value.name) : undefined
        const isAccessorBase =
          baseIdent &&
          ((ctx.memoVars?.has(baseIdent) ?? false) ||
            (ctx.signalVars?.has(baseIdent) ?? false) ||
            (ctx.aliasVars?.has(baseIdent) ?? false))
        const isStoreBase = baseIdent ? (ctx.storeVars?.has(baseIdent) ?? false) : false
        const alreadyGetter =
          isFunctionLike ||
          (baseIdent
            ? isStoreBase ||
              (ctx.memoVars?.has(baseIdent) ?? false) ||
              (ctx.aliasVars?.has(baseIdent) ?? false)
            : false)
        const usesTracked =
          (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
          expressionUsesTracked(attr.value, ctx) &&
          !alreadyGetter
        const trackedExpr = usesTracked
          ? (lowerTrackedExpression(attr.value as Expression, ctx) as BabelCore.types.Expression)
          : null
        const useMemoProp =
          usesTracked &&
          trackedExpr &&
          t.isExpression(trackedExpr) &&
          !t.isIdentifier(trackedExpr) &&
          !t.isMemberExpression(trackedExpr) &&
          !t.isLiteral(trackedExpr)
        const valueExpr =
          !isFunctionLike && isAccessorBase && baseIdent
            ? (() => {
                // Preserve accessor laziness for signals/memos passed as props
                ctx.helpersUsed.add('propGetter')
                return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                  t.arrowFunctionExpression([], t.callExpression(t.identifier(baseIdent), [])),
                ])
              })()
            : usesTracked && t.isExpression(lowered)
              ? (() => {
                  if (useMemoProp) {
                    ctx.helpersUsed.add('useProp')
                    return t.callExpression(t.identifier(RUNTIME_ALIASES.useProp), [
                      t.arrowFunctionExpression(
                        [],
                        trackedExpr ?? (lowered as BabelCore.types.Expression),
                      ),
                    ])
                  }
                  ctx.helpersUsed.add('propGetter')
                  return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                    t.arrowFunctionExpression(
                      [],
                      trackedExpr ?? (lowered as BabelCore.types.Expression),
                    ),
                  ])
                })()
              : lowered
        properties.push(t.objectProperty(toPropKey(attr.name), valueExpr))
      } else {
        // Boolean attribute
        properties.push(t.objectProperty(toPropKey(attr.name), t.booleanLiteral(true)))
      }
    }

    if (spreads.length > 0) {
      return t.objectExpression([...spreads, ...properties])
    }

    return t.objectExpression(properties)
  } finally {
    ctx.inPropsContext = prevPropsContext
  }
}

/**
 * Normalize attribute name from JSX to DOM
 */
function _normalizeAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
}

/**
 * Check if an attribute should be set as a DOM property
 */
function isDOMProperty(name: string): boolean {
  return ['value', 'checked', 'selected', 'disabled', 'readOnly', 'multiple', 'muted'].includes(
    name,
  )
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
  const params = fn.params.map(p => t.identifier(p.name))
  const statements: BabelCore.types.Statement[] = []

  // Emit instructions with scope-aware transformations
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      const stmt = lowerInstructionWithScopes(instr, ctx)
      if (stmt) statements.push(stmt)
    }
    statements.push(...lowerTerminator(block, ctx))
  }

  return t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements))
}

/**
 * Lower an instruction with reactive scope awareness
 */
function lowerInstructionWithScopes(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx

  if (instr.kind === 'Assign') {
    const targetName = instr.target.name
    const valueExpr = lowerExpression(instr.value, ctx)

    // Check if target is a tracked variable
    if (ctx.trackedVars.has(targetName)) {
      // Wrap in memo if it depends on other tracked vars
      ctx.helpersUsed.add('useMemo')
      return t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(targetName),
          t.callExpression(t.identifier('__fictUseMemo'), [
            t.arrowFunctionExpression([], valueExpr),
          ]),
        ),
      ])
    }

    // Check if this is a declaration or just an assignment
    if (instr.declarationKind) {
      // Actual declaration - emit variableDeclaration
      return t.variableDeclaration(instr.declarationKind, [
        t.variableDeclarator(t.identifier(targetName), valueExpr),
      ])
    } else {
      // Pure assignment (e.g. api = {...}) - emit assignmentExpression to update existing variable
      return t.expressionStatement(t.assignmentExpression('=', t.identifier(targetName), valueExpr))
    }
  }

  if (instr.kind === 'Expression') {
    return t.expressionStatement(lowerExpression(instr.value, ctx))
  }

  return null
}

// ============================================================================
// Region-Based Codegen (P0 Integration)
// ============================================================================

import { convertStatementsToHIRFunction } from './build-hir'
import { analyzeReactiveScopesWithSSA } from './scopes'
import { generateRegions, generateRegionCode, regionToMetadata } from './regions'

import { applyRegionMetadata, shouldMemoizeRegion, type RegionMetadata } from '../fine-grained-dom'

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
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.options = options
  const body: BabelCore.types.Statement[] = []
  const topLevelAliases = new Set<string>()
  let topLevelCtxInjected = false
  const emittedFunctionNames = new Set<string>()
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]

  // Pre-mark top-level tracked variables so nested functions can treat captured signals as reactive
  for (const stmt of originalBody) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (
          t.isIdentifier(decl.id) &&
          decl.init &&
          t.isCallExpression(decl.init) &&
          t.isIdentifier(decl.init.callee) &&
          decl.init.callee.name === '$state'
        ) {
          ctx.trackedVars.add(decl.id.name)
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

  // Emit any remaining generated functions (not present in original order)
  for (const func of generatedFunctions.values()) {
    body.push(func.stmt)
    if (func.stmt.id?.name) emittedFunctionNames.add(func.stmt.id.name)
  }

  if (topLevelCtxInjected) {
    ctx.helpersUsed.add('popContext')
    body.push(t.expressionStatement(t.callExpression(t.identifier(RUNTIME_ALIASES.popContext), [])))
  }

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

  const fn = convertStatementsToHIRFunction(name, statements)
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult)
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
  const mutatedVars = new Set<string>()
  ctx.functionVars = functionVars
  ctx.signalVars = signalVars
  ctx.storeVars = storeVars
  ctx.mutatedVars = mutatedVars

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          functionVars.add(target)
        }
        if (instr.value.kind === 'CallExpression' && instr.value.callee.kind === 'Identifier') {
          if (instr.value.callee.name === '$state') {
            signalVars.add(target)
          } else if (instr.value.callee.name === '$store') {
            storeVars.add(target)
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

  const lowered = generateRegionCode(fn, scopeResult, t, ctx)
  return { statements: lowered, aliases: aliasVars }
}

function transformControlFlowReturns(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Statement[] | null {
  const { t } = ctx

  const toStatements = (node: BabelCore.types.Statement | BabelCore.types.BlockStatement) =>
    t.isBlockStatement(node) ? node.body : [node]

  const endsWithReturn = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    const tail = stmts[stmts.length - 1]!
    if (t.isReturnStatement(tail)) return true
    if (t.isIfStatement(tail) && tail.consequent && tail.alternate) {
      const conseqStmts = toStatements(tail.consequent)
      const altStmts = toStatements(tail.alternate)
      return endsWithReturn(conseqStmts) && endsWithReturn(altStmts)
    }
    return false
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
  ): BabelCore.types.ArrowFunctionExpression | null {
    const block = buildReturnBlock(stmts)
    if (!block) return null
    return t.arrowFunctionExpression([], t.blockStatement(block))
  }

  function buildConditionalExpr(
    ifStmt: BabelCore.types.IfStatement,
    rest: BabelCore.types.Statement[],
  ): BabelCore.types.Expression | null {
    const consequentStmts = toStatements(ifStmt.consequent)
    if (!endsWithReturn(consequentStmts)) return null

    let alternateStmts: BabelCore.types.Statement[] | null = null
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
    const falseFn = alternateStmts ? buildBranchFunction(alternateStmts) : null
    if (!trueFn || !falseFn) return null

    ctx.helpersUsed.add('conditional')
    ctx.helpersUsed.add('createElement')
    ctx.helpersUsed.add('onDestroy')
    const bindingId = genTemp(ctx, 'cond')
    const args: BabelCore.types.Expression[] = [
      t.arrowFunctionExpression([], ifStmt.test as BabelCore.types.Expression),
      trueFn,
      t.identifier(RUNTIME_ALIASES.createElement),
      falseFn,
    ]
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

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]
    if (!t.isIfStatement(stmt)) continue
    const conditionalExpr = buildConditionalExpr(stmt, statements.slice(i + 1))
    if (!conditionalExpr) continue
    const prefix = statements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  return null
}

/**
 * Lower a function with region-based code generation
 */
function lowerFunctionWithRegions(
  fn: HIRFunction,
  ctx: CodegenContext,
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
  const scopedTracked = new Set(ctx.trackedVars)
  const shadowedParams = new Set(fn.params.map(p => deSSAVarName(p.name)))
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  const prevNeedsCtx = ctx.needsCtx
  ctx.needsCtx = false
  const prevShadowed = ctx.shadowedNames
  const functionShadowed = new Set(prevShadowed ?? [])
  shadowedParams.forEach(n => functionShadowed.add(n))
  ctx.shadowedNames = functionShadowed
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
  const hookResultVars = new Set<string>()
  const hookAccessorAliases = new Set<string>()
  const prevPropsParam = ctx.propsParamName
  const prevPropAccessors = ctx.propAccessorDecls
  ctx.propAccessorDecls = new Map()
  const calledIdentifiers = collectCalledIdentifiers(fn)
  const propsPlanAliases = new Set<string>()
  let propsDestructurePlan: {
    statements: BabelCore.types.Statement[]
    usesUseProp: boolean
    usesPropsRest: boolean
  } | null = null

  // Collect function-valued bindings, signals, and mutation info in this function
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          ctx.functionVars?.add(target)
        }
        if (
          instr.value.kind === 'CallExpression' &&
          instr.value.callee.kind === 'Identifier' &&
          instr.value.callee.name === '$state'
        ) {
          ctx.signalVars?.add(target)
        }
        if (
          instr.value.kind === 'CallExpression' &&
          instr.value.callee.kind === 'Identifier' &&
          instr.value.callee.name.startsWith(HOOK_NAME_PREFIX)
        ) {
          hookResultVars.add(target)
          ctx.hookResultVarMap?.set(target, instr.value.callee.name)
        }
        if (
          instr.value.kind === 'MemberExpression' &&
          instr.value.object.kind === 'Identifier' &&
          hookResultVars.has(deSSAVarName(instr.value.object.name))
        ) {
          hookAccessorAliases.add(target)
        }
        if (
          instr.value.kind === 'CallExpression' &&
          instr.value.callee.kind === 'Identifier' &&
          instr.value.callee.name === '$store'
        ) {
          ctx.storeVars?.add(target)
        }
        if (!instr.declarationKind) {
          ctx.mutatedVars?.add(target)
        }
      } else if (instr.kind === 'Phi') {
        ctx.mutatedVars?.add(deSSAVarName(instr.target.name))
      }
    }
  }
  hookAccessorAliases.forEach(name => {
    ctx.aliasVars?.add(name)
    ctx.trackedVars.add(name)
  })

  const inferredHook =
    (!fn.name || fn.name[0] !== fn.name[0]?.toUpperCase()) &&
    ((ctx.signalVars?.size ?? 0) > 0 || (ctx.storeVars?.size ?? 0) > 0)
  // Analyze reactive scopes with SSA/CFG awareness
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult)
  ctx.scopes = scopeResult

  // Generate region result for metadata
  const regionResult = generateRegions(fn, scopeResult)

  const prevHookFlag = ctx.currentFnIsHook
  ctx.currentFnIsHook = (!!fn.name && fn.name.startsWith(HOOK_NAME_PREFIX)) || inferredHook
  const isComponent = !!(fn.name && fn.name[0] === fn.name[0]?.toUpperCase())
  ctx.isComponentFn = isComponent
  const rawPropsParam = fn.params.length === 1 ? deSSAVarName(fn.params[0].name) : undefined
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
      let usesUseProp = false
      let usesPropsRest = false

      for (const prop of pattern.properties) {
        if (t.isObjectProperty(prop) && !prop.computed) {
          const keyName = t.isIdentifier(prop.key)
            ? prop.key.name
            : t.isStringLiteral(prop.key)
              ? prop.key.value
              : t.isNumericLiteral(prop.key)
                ? String(prop.key.value)
                : null
          if (!keyName || !t.isIdentifier(prop.value)) {
            supported = false
            break
          }
          excludeKeys.push(t.stringLiteral(keyName))
          const member = t.memberExpression(t.identifier('__props'), t.identifier(keyName), false)
          if (!calledIdentifiers.has(prop.value.name)) {
            usesUseProp = true
            propsPlanAliases.add(prop.value.name)
            stmts.push(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier(prop.value.name),
                  t.callExpression(t.identifier(RUNTIME_ALIASES.useProp), [
                    t.arrowFunctionExpression([], member),
                  ]),
                ),
              ]),
            )
          } else {
            stmts.push(
              t.variableDeclaration('const', [
                t.variableDeclarator(t.identifier(prop.value.name), member),
              ]),
            )
          }
          continue
        }

        if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
          usesPropsRest = true
          stmts.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier(prop.argument.name),
                t.callExpression(t.identifier(RUNTIME_ALIASES.propsRest), [
                  t.identifier('__props'),
                  t.arrayExpression(excludeKeys),
                ]),
              ),
            ]),
          )
          continue
        }

        supported = false
        break
      }

      if (supported) {
        propsDestructurePlan = {
          statements: stmts,
          usesUseProp,
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
  if (debugEnabled('region') && fn.name === 'Counter') {
    console.log('Tracked vars for Counter', Array.from(ctx.trackedVars))

    console.log('Memo vars for Counter', Array.from(ctx.memoVars))
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
  ctx.wrapTrackedExpressions = hasJSX
  const hasTrackedValues =
    ctx.trackedVars.size > 0 ||
    (ctx.signalVars?.size ?? 0) > 0 ||
    (ctx.storeVars?.size ?? 0) > 0 ||
    (ctx.memoVars?.size ?? 0) > 0 ||
    (ctx.aliasVars?.size ?? 0) > 0
  if (!hasJSX && !hasTrackedValues) {
    ctx.needsCtx = prevNeedsCtx
    ctx.shadowedNames = prevShadowed
    ctx.trackedVars = prevTracked
    ctx.externalTracked = prevExternalTracked
    ctx.signalVars = prevSignalVars
    ctx.functionVars = prevFunctionVars
    ctx.memoVars = prevMemoVars
    ctx.storeVars = prevStoreVars
    ctx.mutatedVars = prevMutatedVars
    ctx.aliasVars = prevAliasVars
    ctx.noMemo = prevNoMemo
    ctx.wrapTrackedExpressions = prevWrapTracked
    ctx.hookResultVarMap = prevHookResultVarMap
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

  // Ensure context if signals/effects are used in experimental path
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
  let finalParams = fn.params.map(p => t.identifier(deSSAVarName(p.name)))
  const propsDestructuring: BabelCore.types.Statement[] = []

  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    // Check if it's an ObjectPattern or AssignmentPattern with ObjectPattern
    if (
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
    ) {
      // Replace params with __props
      finalParams = [t.identifier('__props')]
      // Add destructuring statement at start of function
      const pattern = rawParam.type === 'AssignmentPattern' ? rawParam.left : rawParam
      if (propsDestructurePlan) {
        if (propsDestructurePlan.usesUseProp) {
          ctx.helpersUsed.add('useProp')
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
  const funcDecl = t.functionDeclaration(
    t.identifier(fn.name ?? 'fn'),
    params,
    t.blockStatement(statements),
  )
  ctx.needsCtx = prevNeedsCtx
  ctx.shadowedNames = prevShadowed
  ctx.trackedVars = prevTracked
  ctx.externalTracked = prevExternalTracked
  ctx.signalVars = prevSignalVars
  ctx.functionVars = prevFunctionVars
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
