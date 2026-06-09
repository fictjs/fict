/**
 * Region Generation from HIR Reactive Scopes
 *
 * This module bridges HIR reactive scope analysis with fine-grained DOM generation.
 * It replaces the legacy findNextRegion/generateRegionMemo with a CFG-aware approach.
 */

import type * as BabelCore from '@babel/core'
import type { LVal } from '@babel/types'

import { debugLog, debugWarn } from '../debug'
import type { RegionMetadata } from '../fine-grained-dom'

import type { CodegenContext, RegionInfo, RegionLoweringOps } from './codegen'
import { markCompilerReactiveGetter } from './codegen-reactive-getter'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import type {
  AssignInstruction,
  BlockId,
  HIRFunction,
  Expression,
  Instruction,
  JSXElementExpression as HJSXElementExpression,
  TemplateLiteral,
  TemplateQuasi,
  Terminator,
} from './hir'
import { getSSABaseName, HIRError } from './hir'
import { isComponentName } from './hook-utils'
import type { ReactiveScope, ReactiveScopeResult } from './scopes'
import { getScopeDependencies } from './scopes'
import {
  analyzeObjectShapes,
  getPropertySubscription,
  shouldUseWholeObjectSubscription,
  type ShapeAnalysisResult,
} from './shapes'
import { structurizeCFG, StructurizationError, type StructuredNode } from './structurize'

function voidZero(t: typeof BabelCore.types): BabelCore.types.UnaryExpression {
  return t.unaryExpression('void', t.numericLiteral(0), true)
}

function regionOutputProperty(
  t: typeof BabelCore.types,
  name: string,
  value: BabelCore.types.Expression | BabelCore.types.PatternLike,
  shorthand = false,
): BabelCore.types.ObjectProperty {
  const computed = name === '__proto__'
  const key = computed ? t.stringLiteral(name) : t.identifier(name)
  return t.objectProperty(key, value, computed, shorthand && !computed)
}

function regionOutputMember(
  t: typeof BabelCore.types,
  object: BabelCore.types.Expression,
  name: string,
): BabelCore.types.MemberExpression {
  return name === '__proto__'
    ? t.memberExpression(object, t.stringLiteral(name), true)
    : t.memberExpression(object, t.identifier(name))
}

function numericValueExpression(
  value: number,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (Object.is(value, -0)) {
    return t.unaryExpression('-', t.numericLiteral(0), true)
  }
  if (Number.isNaN(value)) {
    return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0))
  }
  if (value === Infinity) {
    return t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0))
  }
  if (value === -Infinity) {
    return t.binaryExpression(
      '/',
      t.unaryExpression('-', t.numericLiteral(1), true),
      t.numericLiteral(0),
    )
  }
  return t.numericLiteral(value)
}

/**
 * A Region represents a contiguous section of code that should be
 * evaluated together and memoized based on its dependencies.
 */
export interface Region {
  id: number
  /** Scope ID this region was derived from */
  scopeId: number
  /** Block IDs covered by this region */
  blocks: Set<BlockId>
  /** Instructions in this region (in order) */
  instructions: Instruction[]
  /** Variable dependencies (inputs) */
  dependencies: Set<string>
  /** Variable declarations (outputs) */
  declarations: Set<string>
  /** Whether this region contains control flow */
  hasControlFlow: boolean
  /** Whether this region contains JSX */
  hasJSX: boolean
  /** Whether this region contains syntax that must remain in an async execution context. */
  hasAsyncSyntax: boolean
  /** Whether this region should be memoized */
  shouldMemoize: boolean
  /** Child regions (for nested scopes) */
  children: Region[]
  /** Parent region ID if nested */
  parentId?: number | undefined
}

type ReactiveCreationInstruction = AssignInstruction & {
  value: Extract<Expression, { kind: 'CallExpression' }>
  declarationKind: NonNullable<AssignInstruction['declarationKind']>
}

function templateElementFromQuasi(
  quasi: TemplateQuasi,
  tail: boolean,
  t: typeof BabelCore.types,
): BabelCore.types.TemplateElement {
  const raw = typeof quasi === 'string' ? quasi : quasi.raw
  const cooked = typeof quasi === 'string' ? quasi : quasi.cooked
  const element =
    cooked === null ? t.templateElement({ raw }, tail) : t.templateElement({ raw, cooked }, tail)
  ;(element.value as { raw: string; cooked: string | null }).cooked = cooked
  return element
}

export function expressionNeedsAsyncContext(expr: Expression): boolean {
  switch (expr.kind) {
    case 'AwaitExpression':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        expressionNeedsAsyncContext(expr.callee) ||
        expr.arguments.some(arg => expressionNeedsAsyncContext(arg))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        expressionNeedsAsyncContext(expr.object) ||
        (expr.computed ? expressionNeedsAsyncContext(expr.property) : false)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return expressionNeedsAsyncContext(expr.left) || expressionNeedsAsyncContext(expr.right)
    case 'UnaryExpression':
      return expressionNeedsAsyncContext(expr.argument)
    case 'ConditionalExpression':
      return (
        expressionNeedsAsyncContext(expr.test) ||
        expressionNeedsAsyncContext(expr.consequent) ||
        expressionNeedsAsyncContext(expr.alternate)
      )
    case 'ArrayExpression':
      return expr.elements.some(element => (element ? expressionNeedsAsyncContext(element) : false))
    case 'ObjectExpression':
      return expr.properties.some(prop =>
        prop.kind === 'SpreadElement'
          ? expressionNeedsAsyncContext(prop.argument)
          : (prop.computed && expressionNeedsAsyncContext(prop.key)) ||
            expressionNeedsAsyncContext(prop.value),
      )
    case 'AssignmentExpression':
      return expressionNeedsAsyncContext(expr.left) || expressionNeedsAsyncContext(expr.right)
    case 'UpdateExpression':
      return expressionNeedsAsyncContext(expr.argument)
    case 'TemplateLiteral':
      return expr.expressions.some(part => expressionNeedsAsyncContext(part))
    case 'SpreadElement':
      return expressionNeedsAsyncContext(expr.argument)
    case 'NewExpression':
      return (
        expressionNeedsAsyncContext(expr.callee) ||
        expr.arguments.some(arg => expressionNeedsAsyncContext(arg))
      )
    case 'ImportExpression':
      return (
        expressionNeedsAsyncContext(expr.source) ||
        (!!expr.options && expressionNeedsAsyncContext(expr.options))
      )
    case 'SequenceExpression':
      return expr.expressions.some(part => expressionNeedsAsyncContext(part))
    case 'YieldExpression':
      return true
    case 'TaggedTemplateExpression':
      return (
        expressionNeedsAsyncContext(expr.tag) ||
        expr.quasi.expressions.some(part => expressionNeedsAsyncContext(part))
      )
    case 'ClassExpression':
      return expr.superClass ? expressionNeedsAsyncContext(expr.superClass) : false
    case 'JSXElement':
      return (
        (typeof expr.tagName !== 'string' && expressionNeedsAsyncContext(expr.tagName)) ||
        expr.attributes.some(attr =>
          attr.isSpread
            ? !!attr.spreadExpr && expressionNeedsAsyncContext(attr.spreadExpr)
            : attr.value
              ? expressionNeedsAsyncContext(attr.value)
              : false,
        ) ||
        expr.children.some(child =>
          child.kind === 'expression' ? expressionNeedsAsyncContext(child.value) : false,
        )
      )
    case 'ArrowFunction':
    case 'FunctionExpression':
    case 'Identifier':
    case 'Literal':
    case 'MetaProperty':
    case 'ThisExpression':
    case 'SuperExpression':
      return false
  }
}

function instructionNeedsAsyncContext(instr: Instruction): boolean {
  if (instr.kind === 'Assign' || instr.kind === 'Expression') {
    return expressionNeedsAsyncContext(instr.value)
  }
  return false
}

function terminatorNeedsAsyncContext(term: Terminator): boolean {
  switch (term.kind) {
    case 'Branch':
      return expressionNeedsAsyncContext(term.test)
    case 'Switch':
      return (
        expressionNeedsAsyncContext(term.discriminant) ||
        term.cases.some(c => (c.test ? expressionNeedsAsyncContext(c.test) : false))
      )
    case 'ForOf':
      return !!term.await || expressionNeedsAsyncContext(term.iterable)
    case 'ForIn':
      return expressionNeedsAsyncContext(term.object)
    case 'Return':
      return term.argument ? expressionNeedsAsyncContext(term.argument) : false
    case 'Throw':
      return expressionNeedsAsyncContext(term.argument)
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
    case 'Try':
      return false
  }
}

/**
 * Result of region generation
 */
export interface RegionResult {
  regions: Region[]
  regionsByBlock: Map<BlockId, Region[]>
  topLevelRegions: Region[]
}

const REACTIVE_CREATORS = new Set(['createEffect', 'createMemo', 'createSelector', '$memo'])

function getRegionLoweringOps(ctx: CodegenContext): RegionLoweringOps {
  const ops = ctx.regionLoweringOps
  if (ops) return ops
  throw new HIRError('Missing region lowering operations in codegen context', 'CODEGEN_ERROR', {
    file: ctx.options?.filename,
  })
}

const applyRegionToContext: RegionLoweringOps['applyRegionToContext'] = (ctx, region) =>
  getRegionLoweringOps(ctx).applyRegionToContext(ctx, region)

const applyRegionMetadataToExpression: RegionLoweringOps['applyRegionMetadataToExpression'] = (
  expr,
  ctx,
  regionOverride,
) => getRegionLoweringOps(ctx).applyRegionMetadataToExpression(expr, ctx, regionOverride)

const buildDependencyGetter: RegionLoweringOps['buildDependencyGetter'] = (deps, ctx) =>
  getRegionLoweringOps(ctx).buildDependencyGetter(deps, ctx)

const getReactiveCallKind: RegionLoweringOps['getReactiveCallKind'] = (expr, ctx) =>
  getRegionLoweringOps(ctx).getReactiveCallKind(expr, ctx)

const assertWritableImportedReactiveIdentifier: RegionLoweringOps['assertWritableImportedReactiveIdentifier'] =
  (name, ctx, loc) =>
    getRegionLoweringOps(ctx).assertWritableImportedReactiveIdentifier(name, ctx, loc)

const lowerExpression: RegionLoweringOps['lowerExpression'] = (expr, ctx, isAssigned = false) =>
  getRegionLoweringOps(ctx).lowerExpression(expr, ctx, isAssigned)

const propagateHookResultAlias: RegionLoweringOps['propagateHookResultAlias'] = (
  targetBase,
  value,
  ctx,
) => getRegionLoweringOps(ctx).propagateHookResultAlias(targetBase, value, ctx)

const resolveHookReturnMemberAccessorKind: RegionLoweringOps['resolveHookReturnMemberAccessorKind'] =
  (expr, ctx) => getRegionLoweringOps(ctx).resolveHookReturnMemberAccessorKind(expr, ctx)

const resolveHookMemberValue: RegionLoweringOps['resolveHookMemberValue'] = (expr, ctx) =>
  getRegionLoweringOps(ctx).resolveHookMemberValue(expr, ctx)

const contextIdentifier: RegionLoweringOps['contextIdentifier'] = ctx =>
  getRegionLoweringOps(ctx).contextIdentifier(ctx)

const reserveFunctionLocalName: RegionLoweringOps['reserveFunctionLocalName'] = (ctx, preferred) =>
  getRegionLoweringOps(ctx).reserveFunctionLocalName(ctx, preferred)

function buildEffectCall(
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  effectFn: BabelCore.types.Expression,
  options?: { slot?: number | undefined; forceSlot?: boolean | undefined },
): BabelCore.types.CallExpression {
  if (ctx.inModule) {
    ctx.helpersUsed.add('effect')
    return t.callExpression(runtimeIdentifier(ctx, 'effect'), [effectFn])
  }
  ctx.helpersUsed.add('useEffect')
  ctx.needsCtx = true
  const args: BabelCore.types.Expression[] = [contextIdentifier(ctx), effectFn]
  const slot = options?.slot
  if (options?.forceSlot) {
    args.push(slot !== undefined && slot >= 0 ? t.numericLiteral(slot) : voidZero(t))
  } else if (slot !== undefined && slot >= 0) {
    args.push(t.numericLiteral(slot))
  }
  return t.callExpression(runtimeIdentifier(ctx, 'useEffect'), args)
}

function shouldWrapTrackedControlInEffect(test: Expression, ctx: CodegenContext): boolean {
  const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
  return (
    ctx.wrapTrackedExpressions !== false &&
    !ctx.inRegionMemo &&
    !inNonReactiveScope &&
    expressionUsesTracked(test, ctx)
  )
}

function withTrackedControlEffectScope<T>(ctx: CodegenContext, enabled: boolean, fn: () => T): T {
  if (!enabled) return fn()
  const prevDepth = ctx.nonReactiveScopeDepth ?? 0
  ctx.nonReactiveScopeDepth = prevDepth + 1
  try {
    return fn()
  } finally {
    ctx.nonReactiveScopeDepth = prevDepth
  }
}

function wrapTrackedControlStatement(
  stmt: BabelCore.types.Statement,
  shouldWrap: boolean,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (!shouldWrap || statementHasEarlyExit(stmt, t)) return [stmt]
  const effectFn = t.arrowFunctionExpression([], t.blockStatement([stmt]))
  return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
}

function buildMemoCall(
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  memoFn: BabelCore.types.Expression,
  options?: {
    slot?: number | undefined
    name?: string | undefined
    source?: string | undefined
    internal?: boolean | undefined
  },
): BabelCore.types.CallExpression {
  const slot = options?.slot
  const memoOptionsProperties: BabelCore.types.ObjectProperty[] = []
  if (options?.name) {
    memoOptionsProperties.push(
      t.objectProperty(t.identifier('name'), t.stringLiteral(options.name)),
    )
  }
  if (options?.source) {
    memoOptionsProperties.push(
      t.objectProperty(t.identifier('devToolsSource'), t.stringLiteral(options.source)),
    )
  }
  if (options?.internal) {
    memoOptionsProperties.push(t.objectProperty(t.identifier('internal'), t.booleanLiteral(true)))
  }
  const memoOptions =
    memoOptionsProperties.length > 0 ? t.objectExpression(memoOptionsProperties) : null

  if (ctx.inModule) {
    ctx.helpersUsed.add('memo')
    const args: BabelCore.types.Expression[] = [memoFn]
    if (memoOptions) args.push(memoOptions)
    return t.callExpression(runtimeIdentifier(ctx, 'memo'), args)
  }
  ctx.helpersUsed.add('useMemo')
  ctx.needsCtx = true
  const args: BabelCore.types.Expression[] = [contextIdentifier(ctx), memoFn]
  if (memoOptions) {
    args.push(memoOptions)
    if (slot !== undefined && slot >= 0) {
      args.push(t.numericLiteral(slot))
    }
  } else if (slot !== undefined && slot >= 0) {
    args.push(t.numericLiteral(slot))
  }
  return t.callExpression(runtimeIdentifier(ctx, 'useMemo'), args)
}

function expressionCreatesReactive(expr: Expression, memoMacroNames?: Set<string>): boolean {
  if (expr.kind === 'CallExpression' && expr.callee.kind === 'Identifier') {
    const base = getSSABaseName(expr.callee.name)
    return REACTIVE_CREATORS.has(base) || (memoMacroNames?.has(base) ?? false)
  }
  return false
}

function expressionContainsReactiveCreation(
  expr: Expression,
  memoMacroNames?: Set<string>,
): boolean {
  if (expressionCreatesReactive(expr, memoMacroNames)) return true
  switch (expr.kind) {
    case 'CallExpression':
      return (
        expressionContainsReactiveCreation(expr.callee, memoMacroNames) ||
        expr.arguments.some(arg => expressionContainsReactiveCreation(arg, memoMacroNames))
      )
    case 'MemberExpression':
      return (
        expressionContainsReactiveCreation(expr.object, memoMacroNames) ||
        expressionContainsReactiveCreation(expr.property, memoMacroNames)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionContainsReactiveCreation(expr.left, memoMacroNames) ||
        expressionContainsReactiveCreation(expr.right, memoMacroNames)
      )
    case 'UnaryExpression':
      return expressionContainsReactiveCreation(expr.argument, memoMacroNames)
    case 'ConditionalExpression':
      return (
        expressionContainsReactiveCreation(expr.test, memoMacroNames) ||
        expressionContainsReactiveCreation(expr.consequent, memoMacroNames) ||
        expressionContainsReactiveCreation(expr.alternate, memoMacroNames)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => el && expressionContainsReactiveCreation(el, memoMacroNames))
    case 'ObjectExpression':
      return expr.properties.some(prop =>
        prop.kind === 'SpreadElement'
          ? expressionContainsReactiveCreation(prop.argument, memoMacroNames)
          : (prop.computed && expressionContainsReactiveCreation(prop.key, memoMacroNames)) ||
            expressionContainsReactiveCreation(prop.value, memoMacroNames),
      )
    case 'ArrowFunction':
      if (expr.isExpression) {
        return expressionContainsReactiveCreation(expr.body as Expression, memoMacroNames)
      }
      return Array.isArray(expr.body)
        ? expr.body.some(block =>
            block.instructions.some(i => instructionContainsReactiveCreation(i, memoMacroNames)),
          )
        : false
    case 'FunctionExpression':
      return expr.body.some(block =>
        block.instructions.some(i => instructionContainsReactiveCreation(i, memoMacroNames)),
      )
    case 'AssignmentExpression':
      return (
        expressionContainsReactiveCreation(expr.left, memoMacroNames) ||
        expressionContainsReactiveCreation(expr.right, memoMacroNames)
      )
    case 'UpdateExpression':
      return expressionContainsReactiveCreation(expr.argument, memoMacroNames)
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionContainsReactiveCreation(e, memoMacroNames))
    case 'SpreadElement':
      return expressionContainsReactiveCreation(expr.argument, memoMacroNames)
    case 'AwaitExpression':
      return expressionContainsReactiveCreation(expr.argument, memoMacroNames)
    case 'YieldExpression':
      return expr.argument
        ? expressionContainsReactiveCreation(expr.argument, memoMacroNames)
        : false
    case 'NewExpression':
      return (
        expressionContainsReactiveCreation(expr.callee, memoMacroNames) ||
        expr.arguments.some(arg => expressionContainsReactiveCreation(arg, memoMacroNames))
      )
    case 'OptionalCallExpression':
      return (
        expressionContainsReactiveCreation(expr.callee, memoMacroNames) ||
        expr.arguments.some(arg => expressionContainsReactiveCreation(arg, memoMacroNames))
      )
    case 'JSXElement':
      return (
        (typeof expr.tagName !== 'string' &&
          expressionContainsReactiveCreation(expr.tagName as Expression, memoMacroNames)) ||
        expr.attributes.some(attr =>
          attr.isSpread
            ? !!attr.spreadExpr &&
              expressionContainsReactiveCreation(attr.spreadExpr, memoMacroNames)
            : attr.value
              ? expressionContainsReactiveCreation(attr.value, memoMacroNames)
              : false,
        ) ||
        expr.children.some(child =>
          child.kind === 'expression'
            ? expressionContainsReactiveCreation(child.value, memoMacroNames)
            : false,
        )
      )
    default:
      return false
  }
}

function instructionContainsReactiveCreation(
  instr: Instruction,
  memoMacroNames?: Set<string>,
): boolean {
  if (instr.kind === 'Assign') {
    return expressionContainsReactiveCreation(instr.value, memoMacroNames)
  }
  if (instr.kind === 'Expression') {
    return expressionContainsReactiveCreation(instr.value, memoMacroNames)
  }
  return false
}

function instructionIsReactiveSetup(instr: Instruction, memoMacroNames?: Set<string>): boolean {
  if (instr.kind === 'Assign') {
    return expressionCreatesReactive(instr.value, memoMacroNames)
  }
  if (instr.kind === 'Expression') {
    return expressionCreatesReactive(instr.value, memoMacroNames)
  }
  return false
}

function nodeIsPureReactiveScope(node: StructuredNode, memoMacroNames?: Set<string>): boolean {
  let found = false
  const visit = (n: StructuredNode): boolean => {
    switch (n.kind) {
      case 'instruction': {
        const ok = instructionIsReactiveSetup(n.instruction, memoMacroNames)
        if (ok && instructionContainsReactiveCreation(n.instruction, memoMacroNames)) found = true
        return ok
      }
      case 'sequence':
        if (n.nodes.length === 0) return false
        return n.nodes.every(child => visit(child))
      case 'block':
        if (n.statements.length === 0) return false
        return n.statements.every(child => visit(child))
      case 'labeled':
        return visit(n.statement)
      default:
        return false
    }
  }

  return visit(node) && found
}

/**
 * Generate regions from HIR reactive scope analysis
 */
export function generateRegions(
  fn: HIRFunction,
  scopeResult: ReactiveScopeResult,
  shapeResult: ShapeAnalysisResult = analyzeObjectShapes(fn),
): RegionResult {
  const regions: Region[] = []
  const regionsByBlock = new Map<BlockId, Region[]>()
  let nextRegionId = 0

  // Create regions from scopes
  for (const scope of scopeResult.scopes) {
    if (!scope.hasExternalEffect && !scope.shouldMemoize) {
      continue
    }
    const region = createRegionFromScope(scope, fn, nextRegionId++, shapeResult)
    regions.push(region)

    // Index by block
    for (const blockId of region.blocks) {
      const existing = regionsByBlock.get(blockId) ?? []
      existing.push(region)
      regionsByBlock.set(blockId, existing)
    }
  }

  // Determine nesting and top-level regions
  const topLevelRegions = determineRegionHierarchy(regions)

  return { regions, regionsByBlock, topLevelRegions }
}

function structurizeOrThrow(fn: HIRFunction): StructuredNode {
  validateCFGTargets(fn)
  try {
    return structurizeCFG(fn, { useFallback: false, warnOnIssues: false, throwOnIssues: true })
  } catch (err) {
    if (err instanceof StructurizationError) {
      // Fall back to state machine structurization to preserve correctness
      const fallback = structurizeCFG(fn, {
        useFallback: true,
        warnOnIssues: false,
        throwOnIssues: false,
      })
      return fallback
    }
    throw err
  }
}

function validateCFGTargets(fn: HIRFunction): void {
  const ids = new Set(fn.blocks.map(b => b.id))
  const ensure = (target: BlockId | undefined, source: BlockId, kind: string) => {
    if (target === undefined) return
    if (!ids.has(target)) {
      throw new HIRError(
        `Invalid CFG: block ${source} references missing target ${target} (${kind})`,
        'STRUCTURIZE_ERROR',
        { blockId: source },
      )
    }
  }

  for (const block of fn.blocks) {
    const term = block.terminator
    switch (term.kind) {
      case 'Jump':
        ensure(term.target, block.id, 'jump')
        break
      case 'Branch':
        ensure(term.consequent, block.id, 'branch.consequent')
        ensure(term.alternate, block.id, 'branch.alternate')
        break
      case 'Switch':
        term.cases.forEach(c => ensure(c.target, block.id, 'switch.case'))
        break
      case 'ForOf':
        ensure(term.body, block.id, 'forof.body')
        ensure(term.exit, block.id, 'forof.exit')
        break
      case 'ForIn':
        ensure(term.body, block.id, 'forin.body')
        ensure(term.exit, block.id, 'forin.exit')
        break
      case 'Try':
        ensure(term.tryBlock, block.id, 'try.block')
        ensure(term.catchBlock, block.id, 'try.catch')
        ensure(term.finallyBlock, block.id, 'try.finally')
        ensure(term.exit, block.id, 'try.exit')
        break
      case 'Break':
      case 'Continue':
        ensure(term.target, block.id, term.kind.toLowerCase())
        break
      default:
        break
    }
  }
}

export function assertStructurableCFG(fn: HIRFunction): void {
  validateCFGTargets(fn)
}

/**
 * Create a Region from a ReactiveScope
 */
function createRegionFromScope(
  scope: ReactiveScope,
  fn: HIRFunction,
  regionId: number,
  shapeResult: ShapeAnalysisResult,
): Region {
  const blocks = scope.blocks
  const instructions: Instruction[] = []
  let hasControlFlow = false
  let hasJSX = false
  let hasAsyncSyntax = false
  const instructionOrder = new Map<Instruction, number>()
  let order = 0
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      instructionOrder.set(instr, order++)
    }
  }

  // Collect instructions from blocks in this scope
  for (const blockId of blocks) {
    const block = fn.blocks.find(b => b.id === blockId)
    if (!block) continue

    for (const instr of block.instructions) {
      if (isInstructionInScope(instr, scope)) {
        instructions.push(instr)
        if (containsJSX(instr)) {
          hasJSX = true
        }
        if (instructionNeedsAsyncContext(instr)) {
          hasAsyncSyntax = true
        }
      }
    }

    // Check terminator for control flow and JSX
    if (block.terminator.kind === 'Branch' || block.terminator.kind === 'Switch') {
      hasControlFlow = true
    }
    // Check if terminator contains JSX (e.g., return <div>...</div>)
    if (block.terminator.kind === 'Return' && block.terminator.argument) {
      if (containsJSXExpr(block.terminator.argument)) {
        hasJSX = true
      }
    }
    if (terminatorNeedsAsyncContext(block.terminator)) {
      hasAsyncSyntax = true
    }
  }
  instructions.sort((a, b) => compareInstructionSourceOrder(a, b, instructionOrder))

  // Multi-block scopes imply control flow
  if (blocks.size > 1) {
    hasControlFlow = true
  }

  // Compute dependency set with optional shape precision
  const baseDeps = getScopeDependencies(scope)
  const dependencies = new Set<string>()
  for (const dep of baseDeps) {
    const baseName = dep.split('.')[0] ?? dep
    if (scope.dependencies.size > 0 && !scope.dependencies.has(baseName)) {
      continue
    }
    const props = getPropertySubscription(dep, shapeResult)
    if (props && props.size > 0 && !shouldUseWholeObjectSubscription(dep, shapeResult)) {
      props.forEach(p => dependencies.add(`${dep}.${p}`))
    } else {
      dependencies.add(dep)
    }
  }

  return {
    id: regionId,
    scopeId: scope.id,
    blocks,
    instructions,
    dependencies,
    declarations: new Set(scope.declarations),
    hasControlFlow,
    hasJSX,
    hasAsyncSyntax,
    shouldMemoize: scope.shouldMemoize,
    children: [],
  }
}

function compareInstructionSourceOrder(
  a: Instruction,
  b: Instruction,
  instructionOrder: Map<Instruction, number>,
): number {
  const aLoc = a.loc?.start
  const bLoc = b.loc?.start
  if (aLoc && bLoc) {
    if (aLoc.line !== bLoc.line) return aLoc.line - bLoc.line
    if (aLoc.column !== bLoc.column) return aLoc.column - bLoc.column
  }
  return (instructionOrder.get(a) ?? 0) - (instructionOrder.get(b) ?? 0)
}

function compareInstructionLoc(a: Instruction, b: Instruction): number | null {
  const aLoc = a.loc?.start
  const bLoc = b.loc?.start
  if (!aLoc || !bLoc) return null
  if (aLoc.line !== bLoc.line) return aLoc.line - bLoc.line
  return aLoc.column - bLoc.column
}

function instructionSourceBefore(a: Instruction, b: Instruction): boolean {
  const order = compareInstructionLoc(a, b)
  return order !== null && order < 0
}

function isClassEvaluationBarrier(instr: Instruction): boolean {
  return (
    instr.kind === 'Assign' &&
    instr.declarationKind !== undefined &&
    instr.value.kind === 'ClassExpression'
  )
}

/**
 * Check if an instruction belongs to the given scope
 */
function isInstructionInScope(instr: Instruction, scope: ReactiveScope): boolean {
  if (instr.kind === 'Assign') {
    return scope.writes.has(instr.target.name) || scope.declarations.has(instr.target.name)
  }
  if (instr.kind === 'Phi') {
    return scope.writes.has(instr.target.name) || scope.declarations.has(instr.target.name)
  }
  if (instr.kind === 'Expression') {
    const deps = collectExprDependencies(instr.value)
    if (deps.size === 0) return true
    for (const decl of scope.declarations) {
      if (deps.has(deSSAVarName(decl))) return true
    }
    return false
  }
  return false
}

/**
 * Check if an instruction contains JSX
 */
function containsJSX(instr: Instruction): boolean {
  if (instr.kind === 'Assign' || instr.kind === 'Expression') {
    return containsJSXExpr(instr.value)
  }
  return false
}

function containsJSXExpr(expr: Expression | null | undefined): boolean {
  if (!expr) return false
  if (expr.kind === 'JSXElement') return true

  // Recursively check nested expressions
  switch (expr.kind) {
    case 'CallExpression':
      if (containsJSXExpr(expr.callee)) return true
      return expr.arguments.some(a => containsJSXExpr(a))
    case 'ArrayExpression':
      return expr.elements.some(el => containsJSXExpr(el))
    case 'ObjectExpression':
      return expr.properties.some(p =>
        p.kind === 'SpreadElement' ? containsJSXExpr(p.argument) : containsJSXExpr(p.value),
      )
    case 'ConditionalExpression':
      return containsJSXExpr(expr.consequent) || containsJSXExpr(expr.alternate)
    case 'LogicalExpression':
    case 'BinaryExpression':
      return containsJSXExpr(expr.left) || containsJSXExpr(expr.right)
    case 'UnaryExpression':
    case 'AwaitExpression':
      return containsJSXExpr(expr.argument)
    case 'AssignmentExpression':
      return containsJSXExpr(expr.left) || containsJSXExpr(expr.right)
    case 'UpdateExpression':
      return containsJSXExpr(expr.argument)
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        containsJSXExpr(expr.object) ||
        (expr.computed && expr.property.kind !== 'Literal' && containsJSXExpr(expr.property))
      )
    case 'NewExpression':
      if (containsJSXExpr(expr.callee)) return true
      return expr.arguments.some(a => containsJSXExpr(a))
    case 'TemplateLiteral':
      return expr.expressions.some(item => containsJSXExpr(item))
    case 'TaggedTemplateExpression':
      return containsJSXExpr(expr.tag) || containsJSXExpr(expr.quasi)
    case 'SequenceExpression':
      return expr.expressions.some(item => containsJSXExpr(item))
    case 'ImportExpression':
      return containsJSXExpr(expr.source) || (!!expr.options && containsJSXExpr(expr.options))
    case 'ArrowFunction':
      if (expr.isExpression && !Array.isArray(expr.body)) {
        return containsJSXExpr(expr.body)
      }
      if (Array.isArray(expr.body)) {
        return expr.body.some(block =>
          block.instructions.some(
            i => (i.kind === 'Assign' || i.kind === 'Expression') && containsJSXExpr(i.value),
          ),
        )
      }
      return false
    case 'FunctionExpression':
      return expr.body.some(block =>
        block.instructions.some(
          i => (i.kind === 'Assign' || i.kind === 'Expression') && containsJSXExpr(i.value),
        ),
      )
    case 'SpreadElement':
      return containsJSXExpr(expr.argument)
    case 'YieldExpression':
      return expr.argument ? containsJSXExpr(expr.argument) : false
    default:
      return false
  }
}

function getStaticPropertyName(property: Expression, computed: boolean): string | null {
  if (!computed && property.kind === 'Identifier') return property.name
  if (property.kind === 'Literal') {
    if (typeof property.value === 'string' || typeof property.value === 'number') {
      return String(property.value)
    }
  }
  return null
}

const LAZY_MEMO_SAFE_SYNC_CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
])

const LAZY_MEMO_SAFE_GLOBAL_CALLS = new Set(['String', 'Number', 'Boolean', 'BigInt'])

function isLazyMemoSafeSyncCallbackHost(callee: Expression): boolean {
  if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
    return false
  }
  const propName = getStaticPropertyName(callee.property as Expression, callee.computed)
  return !!propName && LAZY_MEMO_SAFE_SYNC_CALLBACK_METHODS.has(propName)
}

function getNamespaceReactiveMemberKind(
  candidate: Expression,
  ctx: CodegenContext,
): 'signal' | 'memo' | 'store' | null {
  if (candidate.kind !== 'MemberExpression' && candidate.kind !== 'OptionalMemberExpression') {
    return null
  }
  if (candidate.object.kind !== 'Identifier') return null
  const nsMeta = ctx.importedNamespaces?.get(deSSAVarName(candidate.object.name))
  if (!nsMeta) return null
  const propName = getStaticPropertyName(candidate.property as Expression, candidate.computed)
  if (!propName) return null
  const kind = nsMeta.exports[propName]
  return kind === 'signal' || kind === 'memo' || kind === 'store' ? kind : null
}

export function expressionUsesTracked(expr: Expression, ctx: CodegenContext): boolean {
  const babelNodeUsesTracked = (node: unknown): boolean => {
    const { t } = ctx
    if (Array.isArray(node)) return node.some(item => babelNodeUsesTracked(item))
    if (
      !node ||
      typeof node !== 'object' ||
      typeof (node as { type?: unknown }).type !== 'string'
    ) {
      return false
    }
    const babelNode = node as BabelCore.types.Node

    if (t.isIdentifier(babelNode)) {
      return expressionUsesTracked({ kind: 'Identifier', name: babelNode.name }, ctx)
    }
    if (
      t.isStringLiteral(babelNode) ||
      t.isNumericLiteral(babelNode) ||
      t.isBooleanLiteral(babelNode) ||
      t.isNullLiteral(babelNode) ||
      t.isBigIntLiteral(babelNode) ||
      t.isRegExpLiteral(babelNode) ||
      t.isThisExpression(babelNode) ||
      t.isSuper(babelNode) ||
      t.isMetaProperty(babelNode)
    ) {
      return false
    }
    if (
      t.isFunctionDeclaration(babelNode) ||
      t.isFunctionExpression(babelNode) ||
      t.isArrowFunctionExpression(babelNode) ||
      t.isObjectMethod(babelNode)
    ) {
      return false
    }
    if (t.isDecorator(babelNode)) return babelNodeUsesTracked(babelNode.expression)
    if (t.isMemberExpression(babelNode) || t.isOptionalMemberExpression(babelNode)) {
      return (
        babelNodeUsesTracked(babelNode.object) ||
        (babelNode.computed ? babelNodeUsesTracked(babelNode.property) : false)
      )
    }
    if (t.isCallExpression(babelNode) || t.isOptionalCallExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.callee) || babelNodeUsesTracked(babelNode.arguments)
    }
    if (t.isNewExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.callee) || babelNodeUsesTracked(babelNode.arguments)
    }
    if (t.isImportExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.source) || babelNodeUsesTracked(babelNode.options)
    }
    if (t.isAssignmentExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.left) || babelNodeUsesTracked(babelNode.right)
    }
    if (t.isUpdateExpression(babelNode)) return babelNodeUsesTracked(babelNode.argument)
    if (t.isVariableDeclaration(babelNode)) return babelNodeUsesTracked(babelNode.declarations)
    if (t.isVariableDeclarator(babelNode)) return babelNodeUsesTracked(babelNode.init)
    if (t.isExpressionStatement(babelNode)) return babelNodeUsesTracked(babelNode.expression)
    if (t.isBlockStatement(babelNode)) return babelNodeUsesTracked(babelNode.body)
    if (t.isReturnStatement(babelNode) || t.isThrowStatement(babelNode)) {
      return babelNodeUsesTracked(babelNode.argument)
    }
    if (t.isObjectExpression(babelNode)) return babelNodeUsesTracked(babelNode.properties)
    if (t.isObjectProperty(babelNode)) {
      return (
        (babelNode.computed ? babelNodeUsesTracked(babelNode.key) : false) ||
        babelNodeUsesTracked(babelNode.value)
      )
    }
    if (t.isArrayExpression(babelNode)) return babelNodeUsesTracked(babelNode.elements)
    if (t.isBinaryExpression(babelNode) || t.isLogicalExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.left) || babelNodeUsesTracked(babelNode.right)
    }
    if (t.isUnaryExpression(babelNode) || t.isAwaitExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.argument)
    }
    if (t.isYieldExpression(babelNode)) return babelNodeUsesTracked(babelNode.argument)
    if (t.isConditionalExpression(babelNode)) {
      return (
        babelNodeUsesTracked(babelNode.test) ||
        babelNodeUsesTracked(babelNode.consequent) ||
        babelNodeUsesTracked(babelNode.alternate)
      )
    }
    if (t.isSequenceExpression(babelNode)) return babelNodeUsesTracked(babelNode.expressions)
    if (t.isTemplateLiteral(babelNode)) return babelNodeUsesTracked(babelNode.expressions)
    if (t.isTaggedTemplateExpression(babelNode)) {
      return babelNodeUsesTracked(babelNode.tag) || babelNodeUsesTracked(babelNode.quasi)
    }
    if (t.isClassExpression(babelNode) || t.isClassDeclaration(babelNode)) {
      return (
        babelNodeUsesTracked(babelNode.superClass) ||
        babelNodeUsesTracked(babelNode.decorators) ||
        babelNodeUsesTracked(babelNode.body.body)
      )
    }
    if (t.isClassMethod(babelNode) || t.isClassPrivateMethod(babelNode)) {
      return (
        babelNodeUsesTracked(babelNode.decorators) ||
        (babelNode.computed ? babelNodeUsesTracked(babelNode.key) : false)
      )
    }
    if (
      t.isClassProperty(babelNode) ||
      t.isClassPrivateProperty(babelNode) ||
      t.isClassAccessorProperty(babelNode)
    ) {
      const staticFieldValueUsesTracked =
        'static' in babelNode && babelNode.static ? babelNodeUsesTracked(babelNode.value) : false

      return (
        babelNodeUsesTracked(babelNode.decorators) ||
        ('computed' in babelNode && babelNode.computed
          ? babelNodeUsesTracked(babelNode.key)
          : false) ||
        staticFieldValueUsesTracked
      )
    }
    if (t.isStaticBlock(babelNode)) return babelNodeUsesTracked(babelNode.body)
    return false
  }

  const assignmentTargetUsesTrackedRead = (target: Expression): boolean => {
    switch (target.kind) {
      case 'Identifier':
        return false
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (expressionUsesTracked(target.object as Expression, ctx)) return true
        if (target.computed && target.property.kind !== 'Literal') {
          return expressionUsesTracked(target.property as Expression, ctx)
        }
        return false
      default:
        return expressionUsesTracked(target, ctx)
    }
  }

  switch (expr.kind) {
    case 'Identifier':
      return (
        ctx.trackedVars.has(deSSAVarName(expr.name)) ||
        (ctx.externalTracked?.has(deSSAVarName(expr.name)) ?? false) ||
        (ctx.memoVars?.has(deSSAVarName(expr.name)) ?? false) ||
        (ctx.aliasVars?.has(deSSAVarName(expr.name)) ?? false) ||
        (ctx.resourceResultVars?.has(deSSAVarName(expr.name)) ?? false)
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (getNamespaceReactiveMemberKind(expr, ctx)) return true
      if (resolveHookReturnMemberAccessorKind(expr, ctx)) return true
      if (expressionUsesTracked(expr.object as Expression, ctx)) return true
      if (expr.computed && expr.property.kind !== 'Literal') {
        return expressionUsesTracked(expr.property as Expression, ctx)
      }
      return false
    case 'CallExpression':
    case 'OptionalCallExpression':
      if (expressionUsesTracked(expr.callee as Expression, ctx)) return true
      return expr.arguments.some(arg => expressionUsesTracked(arg as Expression, ctx))
    case 'NewExpression':
      if (expressionUsesTracked(expr.callee as Expression, ctx)) return true
      return expr.arguments.some(arg => expressionUsesTracked(arg as Expression, ctx))
    case 'LogicalExpression':
      return (
        expressionUsesTracked(expr.left as Expression, ctx) ||
        expressionUsesTracked(expr.right as Expression, ctx)
      )
    case 'BinaryExpression':
      return (
        expressionUsesTracked(expr.left as Expression, ctx) ||
        expressionUsesTracked(expr.right as Expression, ctx)
      )
    case 'ConditionalExpression':
      return (
        expressionUsesTracked(expr.test as Expression, ctx) ||
        expressionUsesTracked(expr.consequent as Expression, ctx) ||
        expressionUsesTracked(expr.alternate as Expression, ctx)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => el && expressionUsesTracked(el as Expression, ctx))
    case 'ObjectExpression':
      return expr.properties.some(p => {
        if (p.kind === 'SpreadElement') return expressionUsesTracked(p.argument as Expression, ctx)
        return (
          (p.computed && expressionUsesTracked(p.key as Expression, ctx)) ||
          expressionUsesTracked(p.value as Expression, ctx)
        )
      })
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionUsesTracked(e as Expression, ctx))
    case 'TaggedTemplateExpression':
      return (
        expressionUsesTracked(expr.tag as Expression, ctx) ||
        expressionUsesTracked(expr.quasi as Expression, ctx)
      )
    case 'SpreadElement':
      return expressionUsesTracked(expr.argument as Expression, ctx)
    case 'UnaryExpression':
      return expressionUsesTracked(expr.argument as Expression, ctx)
    case 'AwaitExpression':
      return expressionUsesTracked(expr.argument as Expression, ctx)
    case 'SequenceExpression':
      return expr.expressions.some(e => expressionUsesTracked(e as Expression, ctx))
    case 'YieldExpression':
      return expr.argument ? expressionUsesTracked(expr.argument as Expression, ctx) : false
    case 'ImportExpression':
      return (
        expressionUsesTracked(expr.source as Expression, ctx) ||
        (expr.options ? expressionUsesTracked(expr.options as Expression, ctx) : false)
      )
    case 'ClassExpression':
      return (
        (expr.superClass ? expressionUsesTracked(expr.superClass as Expression, ctx) : false) ||
        babelNodeUsesTracked(expr.decorators) ||
        babelNodeUsesTracked(expr.body)
      )
    case 'AssignmentExpression':
      return (
        assignmentTargetUsesTrackedRead(expr.left as Expression) ||
        expressionUsesTracked(expr.right as Expression, ctx)
      )
    case 'UpdateExpression':
      return expressionUsesTracked(expr.argument as Expression, ctx)
    default:
      return false
  }
}

/**
 * Determine region hierarchy (nesting) based on block containment
 */
function determineRegionHierarchy(regions: Region[]): Region[] {
  if (regions.length === 0) return []
  if (regions.length === 1) return regions

  const topLevel: Region[] = []

  // Sort regions by size (larger first for parent-first processing)
  // This allows us to check parents before children
  const sorted = [...regions].sort((a, b) => b.blocks.size - a.blocks.size)

  // Build a map of block -> containing regions for O(1) lookup
  const blockToRegions = new Map<BlockId, Region[]>()
  for (const region of regions) {
    for (const blockId of region.blocks) {
      const list = blockToRegions.get(blockId)
      if (list) {
        list.push(region)
      } else {
        blockToRegions.set(blockId, [region])
      }
    }
  }

  // For each region, find its immediate parent (smallest containing region)
  // Process from largest to smallest so parent relationships are established first
  const regionById = new Map<number, Region>()
  for (const region of regions) {
    regionById.set(region.id, region)
  }

  for (const region of sorted) {
    // Skip if already has a parent (shouldn't happen but be safe)
    if (region.parentId !== undefined) continue

    // Find candidate parents by looking at regions that share a block
    // The parent must contain ALL blocks of this region
    const firstBlock = region.blocks.values().next().value as BlockId | undefined
    if (firstBlock === undefined) {
      topLevel.push(region)
      continue
    }

    const candidates = blockToRegions.get(firstBlock) ?? []
    let bestParent: Region | undefined

    for (const candidate of candidates) {
      if (candidate.id === region.id) continue
      // Parent must be larger
      if (candidate.blocks.size <= region.blocks.size) continue

      // Check if candidate contains all blocks of region
      let containsAll = true
      for (const blockId of region.blocks) {
        if (!candidate.blocks.has(blockId)) {
          containsAll = false
          break
        }
      }

      if (containsAll) {
        // Pick smallest containing region as immediate parent
        if (!bestParent || candidate.blocks.size < bestParent.blocks.size) {
          bestParent = candidate
        }
      }
    }

    if (bestParent) {
      region.parentId = bestParent.id
      bestParent.children.push(region)
    } else {
      topLevel.push(region)
    }
  }

  return topLevel
}

/**
 * Convert a Region to RegionMetadata for fine-grained DOM generation
 * Applies SSA de-versioning to ensure clean variable names without _n suffixes
 */
export function regionToMetadata(region: Region): RegionMetadata {
  // De-version all dependency and declaration names to remove SSA suffixes
  const deDependencies = new Set<string>()
  for (const dep of region.dependencies) {
    deDependencies.add(deSSAVarName(dep))
  }

  const deDeclarations = new Set<string>()
  for (const decl of region.declarations) {
    deDeclarations.add(deSSAVarName(decl))
  }

  return {
    id: region.id,
    dependencies: deDependencies,
    declarations: deDeclarations,
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: deDeclarations.size > 0,
    children: region.children.map(c => regionToMetadata(c)),
  }
}

/**
 * Generate region-based code from HIR
 *
 * This is the main entry point for replacing findNextRegion/generateRegionMemo.
 * It takes HIR and produces statements organized by reactive regions.
 * Combines CFG structurization with reactive scope analysis for proper memo/dependency handling.
 */
export function generateRegionCode(
  fn: HIRFunction,
  scopeResult: ReactiveScopeResult,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
): BabelCore.types.Statement[] {
  // Generate regions from scope analysis
  const regionResult = generateRegions(fn, scopeResult)
  const declaredVars = new Set<string>()

  // Build a map of blockId -> instructions that belong to each region
  const regionInstrMap = new Map<number, { region: Region; emitted: boolean }>()
  for (const region of regionResult.regions) {
    regionInstrMap.set(region.id, { region, emitted: false })
  }

  // Use structured code generation for control flow
  const structured = structurizeOrThrow(fn)

  // Lower structured code with region awareness
  return lowerStructuredNodeWithRegions(structured, regionResult, t, ctx, declaredVars)
}

export function lowerStructuredNodeWithoutRegions(
  node: StructuredNode,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
): BabelCore.types.Statement[] {
  return lowerStructuredNodeInternal(node, t, ctx, declaredVars)
}

/**
 * Lower structured node with region awareness
 * This combines CFG structurization with reactive region analysis
 */
function lowerStructuredNodeWithRegions(
  node: StructuredNode,
  regionResult: RegionResult,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
): BabelCore.types.Statement[] {
  return lowerStructuredNodeInternal(node, t, ctx, declaredVars, regionResult)
}

function collectSubsumedChildRegionIds(regionResult: RegionResult): Set<number> {
  const disabled = new Set<number>()
  const regionsById = new Map(regionResult.regions.map(region => [region.id, region]))

  for (const region of regionResult.regions) {
    if (
      region.shouldMemoize ||
      region.parentId === undefined ||
      !region.hasControlFlow ||
      region.hasJSX
    ) {
      continue
    }
    const parent = regionsById.get(region.parentId)
    if (parent?.shouldMemoize && parent.hasControlFlow) {
      disabled.add(region.id)
    }
  }

  return disabled
}

/**
 * Context for tracking region emission during lowering
 */
interface RegionEmitContext {
  regionResult: RegionResult
  emittedRegions: Set<number>
  disabledRegions: Set<number>
  hoistedInstructions: Set<Instruction>
  pendingInstructions: Map<number, Instruction[]>
  rootNode: StructuredNode
  fullRootNode: StructuredNode
  inlineUnownedInRegionBody?: boolean | undefined
}

interface ControlFlowRegionState {
  region?: Region | undefined
  partialRegionIds: Set<number>
  hasUnownedInstructions?: boolean | undefined
  ownedInstructionsByRegion?: Map<number, Instruction[]> | undefined
}

function shouldDisablePartialRegions(node: StructuredNode): boolean {
  switch (node.kind) {
    case 'labeled':
      return shouldDisablePartialRegions(node.statement)
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
      return true
    default:
      return false
  }
}

/**
 * Internal function to lower structured nodes
 * Handles region-aware code generation with memo/dependency tracking
 */
function lowerStructuredNodeInternal(
  node: StructuredNode,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
  regionResult?: RegionResult,
): BabelCore.types.Statement[] {
  // Create region emit context if we have region data
  const regionCtx: RegionEmitContext | undefined = regionResult
    ? {
        regionResult,
        emittedRegions: new Set<number>(),
        disabledRegions: collectSubsumedChildRegionIds(regionResult),
        hoistedInstructions: new Set<Instruction>(),
        pendingInstructions: new Map<number, Instruction[]>(),
        rootNode: node,
        fullRootNode: node,
      }
    : undefined

  return lowerNodeWithRegionContext(node, t, ctx, declaredVars, regionCtx)
}

function ensureSwitchCaseBreak(
  stmts: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
  fallsThrough = false,
): BabelCore.types.Statement[] {
  if (fallsThrough) return stmts
  if (stmts.length === 0) {
    // Preserve label-only cases (`case 'a': case 'b': ...`) by keeping the
    // consequent empty, which allows intentional fallthrough.
    return stmts
  }
  const tail = stmts[stmts.length - 1]
  if (
    tail &&
    (t.isBreakStatement(tail) ||
      t.isReturnStatement(tail) ||
      t.isThrowStatement(tail) ||
      t.isContinueStatement(tail))
  ) {
    return stmts
  }
  return [...stmts, t.breakStatement()]
}

function cloneTrailingStatements(
  statements: BabelCore.types.Statement[] | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  return (statements ?? []).map(stmt => t.cloneNode(stmt, true) as BabelCore.types.Statement)
}

function shouldLabelStructuredNodeDirectly(node: StructuredNode): boolean {
  switch (node.kind) {
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
    case 'switch':
      return true
    default:
      return false
  }
}

function canEmitControlFlowRegionDirectly(node: StructuredNode): boolean {
  switch (node.kind) {
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
    case 'try':
    case 'labeled':
      return true
    default:
      return false
  }
}

function combineDirectEmitNodes(nodes: StructuredNode[]): StructuredNode {
  if (nodes.length === 1) {
    return nodes[0]!
  }
  return { kind: 'sequence', nodes: [...nodes] }
}

function instructionListCoversRegion(
  region: Region,
  candidateInstructions: Instruction[],
): boolean {
  if (candidateInstructions.length < region.instructions.length) {
    return false
  }

  const used = new Array(candidateInstructions.length).fill(false)
  for (const regionInstr of region.instructions) {
    let matched = false
    for (let index = 0; index < candidateInstructions.length; index++) {
      if (used[index]) continue
      const candidate = candidateInstructions[index]
      if (candidate && instructionsMatch(regionInstr, candidate)) {
        used[index] = true
        matched = true
        break
      }
    }
    if (!matched) {
      return false
    }
  }

  return true
}

function collectInstructionDependencies(instr: Instruction): Set<string> {
  if (instr.kind === 'Assign' || instr.kind === 'Expression') {
    return collectExprDependencies(instr.value)
  }
  return new Set()
}

function collectTerminatorDependencies(term: Terminator): Set<string> {
  const deps = new Set<string>()
  const add = (values: Set<string>) => values.forEach(value => deps.add(value))

  switch (term.kind) {
    case 'Return':
      if (term.argument) add(collectExprDependencies(term.argument))
      break
    case 'Throw':
      add(collectExprDependencies(term.argument))
      break
    case 'Branch':
      add(collectExprDependencies(term.test))
      break
    case 'Switch':
      add(collectExprDependencies(term.discriminant))
      term.cases.forEach(item => {
        if (item.test) add(collectExprDependencies(item.test))
      })
      break
    case 'ForOf':
      add(collectExprDependencies(term.iterable))
      break
    case 'ForIn':
      add(collectExprDependencies(term.object))
      break
    default:
      break
  }

  return deps
}

function collectExpressionWrites(expr: Expression): Set<string> {
  const writes = new Set<string>()
  const addTarget = (target: Expression): void => {
    if (target.kind === 'Identifier') {
      writes.add(deSSAVarName(target.name))
    }
  }
  const visit = (current: Expression): void => {
    switch (current.kind) {
      case 'AssignmentExpression':
        addTarget(current.left)
        visit(current.right)
        return
      case 'UpdateExpression':
        addTarget(current.argument)
        return
      case 'SequenceExpression':
        current.expressions.forEach(visit)
        return
      case 'ConditionalExpression':
        visit(current.test)
        visit(current.consequent)
        visit(current.alternate)
        return
      case 'LogicalExpression':
      case 'BinaryExpression':
        visit(current.left)
        visit(current.right)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
      case 'SpreadElement':
        visit(current.argument)
        return
      case 'CallExpression':
      case 'OptionalCallExpression':
        visit(current.callee)
        current.arguments.forEach(visit)
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(current.object)
        if (current.computed) visit(current.property)
        return
      case 'ArrayExpression':
        current.elements.forEach(element => {
          if (element) visit(element)
        })
        return
      case 'ObjectExpression':
        current.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visit(prop.argument)
          } else {
            if (prop.computed) visit(prop.key)
            visit(prop.value)
          }
        })
        return
      case 'TemplateLiteral':
        current.expressions.forEach(visit)
        return
      case 'TaggedTemplateExpression':
        visit(current.tag)
        current.quasi.expressions.forEach(visit)
        return
      case 'NewExpression':
        visit(current.callee)
        current.arguments.forEach(visit)
        return
      case 'YieldExpression':
        if (current.argument) visit(current.argument)
        return
      default:
        return
    }
  }
  visit(expr)
  return writes
}

function collectInstructionWrites(instr: Instruction): Set<string> {
  const writes = new Set<string>()
  if (instr.kind === 'Assign') {
    writes.add(deSSAVarName(instr.target.name))
    collectExpressionWrites(instr.value).forEach(name => writes.add(name))
  } else if (instr.kind === 'Expression') {
    collectExpressionWrites(instr.value).forEach(name => writes.add(name))
  }
  return writes
}

function collectStructuredNodeDependencies(node: StructuredNode): Set<string> {
  const deps = new Set<string>()
  const add = (values: Set<string>) => values.forEach(value => deps.add(value))
  const visit = (current: StructuredNode | null | undefined): void => {
    if (!current) return
    switch (current.kind) {
      case 'instruction':
        add(collectInstructionDependencies(current.instruction))
        return
      case 'sequence':
        current.nodes.forEach(visit)
        return
      case 'block':
        current.statements.forEach(visit)
        return
      case 'labeled':
        visit(current.statement)
        return
      case 'if':
        add(collectExprDependencies(current.test))
        visit(current.consequent)
        visit(current.alternate)
        return
      case 'while':
      case 'doWhile':
        add(collectExprDependencies(current.test))
        visit(current.body)
        return
      case 'for':
        current.init?.forEach(instr => add(collectInstructionDependencies(instr)))
        if (current.test) add(collectExprDependencies(current.test))
        current.update?.forEach(instr => add(collectInstructionDependencies(instr)))
        visit(current.body)
        return
      case 'forOf':
        add(collectExprDependencies(current.iterable))
        visit(current.body)
        return
      case 'forIn':
        add(collectExprDependencies(current.object))
        visit(current.body)
        return
      case 'switch':
        add(collectExprDependencies(current.discriminant))
        current.cases.forEach(item => {
          if (item.test) add(collectExprDependencies(item.test))
          visit(item.body)
        })
        return
      case 'try':
        visit(current.block)
        visit(current.handler?.body)
        visit(current.finalizer)
        return
      case 'return':
      case 'throw':
        if (current.argument) add(collectExprDependencies(current.argument))
        return
      case 'stateMachine':
        current.blocks.forEach(block => {
          block.instructions.forEach(instr => add(collectInstructionDependencies(instr)))
        })
        return
      default:
        return
    }
  }
  visit(node)
  return deps
}

function collectStructuredNodeWrites(node: StructuredNode): Set<string> {
  const writes = new Set<string>()
  const add = (values: Set<string>) => values.forEach(value => writes.add(value))
  const visit = (current: StructuredNode | null | undefined): void => {
    if (!current) return
    switch (current.kind) {
      case 'instruction':
        add(collectInstructionWrites(current.instruction))
        return
      case 'sequence':
        current.nodes.forEach(visit)
        return
      case 'block':
        current.statements.forEach(visit)
        return
      case 'labeled':
        visit(current.statement)
        return
      case 'if':
        visit(current.consequent)
        visit(current.alternate)
        return
      case 'while':
      case 'doWhile':
        visit(current.body)
        return
      case 'for':
        current.update?.forEach(instr => add(collectInstructionWrites(instr)))
        visit(current.body)
        return
      case 'forOf':
      case 'forIn':
        visit(current.body)
        return
      case 'switch':
        current.cases.forEach(item => visit(item.body))
        return
      case 'try':
        visit(current.block)
        visit(current.handler?.body)
        visit(current.finalizer)
        return
      case 'stateMachine':
        current.blocks.forEach(block => {
          block.instructions.forEach(instr => add(collectInstructionWrites(instr)))
        })
        return
      default:
        return
    }
  }
  visit(node)
  return writes
}

function collectPostRegionWrites(rootNode: StructuredNode, region: Region): Set<string> {
  const writes = new Set<string>()
  const remainingRegionInstructionIndexes = new Set<number>()
  region.instructions.forEach((_instr, index) => remainingRegionInstructionIndexes.add(index))
  let afterRegion = remainingRegionInstructionIndexes.size === 0

  const addWrites = (values: Set<string>): void => {
    if (!afterRegion) return
    values.forEach(name => writes.add(name))
  }
  const addExpressionWrites = (expr: Expression | null | undefined): void => {
    if (!expr) return
    addWrites(collectExpressionWrites(expr))
  }
  const addInstructionWrites = (instr: Instruction): void =>
    addWrites(collectInstructionWrites(instr))
  const addTerminatorWrites = (term: Terminator): void => {
    switch (term.kind) {
      case 'Return':
        addExpressionWrites(term.argument)
        return
      case 'Throw':
        addExpressionWrites(term.argument)
        return
      case 'Branch':
        addExpressionWrites(term.test)
        return
      case 'Switch':
        addExpressionWrites(term.discriminant)
        term.cases.forEach(item => addExpressionWrites(item.test))
        return
      case 'ForOf':
        addExpressionWrites(term.iterable)
        return
      case 'ForIn':
        addExpressionWrites(term.object)
        return
      default:
        return
    }
  }
  const noteInstruction = (instr: Instruction): void => {
    for (const index of remainingRegionInstructionIndexes) {
      const regionInstr = region.instructions[index]
      if (regionInstr && instructionsMatch(instr, regionInstr)) {
        remainingRegionInstructionIndexes.delete(index)
        afterRegion = remainingRegionInstructionIndexes.size === 0
        return
      }
    }
    addInstructionWrites(instr)
  }
  const visit = (current: StructuredNode | null | undefined): void => {
    if (!current) return
    switch (current.kind) {
      case 'instruction':
        noteInstruction(current.instruction)
        return
      case 'sequence':
        current.nodes.forEach(visit)
        return
      case 'block':
        current.statements.forEach(visit)
        return
      case 'labeled':
        visit(current.statement)
        return
      case 'if':
        addExpressionWrites(current.test)
        visit(current.consequent)
        visit(current.alternate)
        return
      case 'while':
      case 'doWhile':
        addExpressionWrites(current.test)
        visit(current.body)
        return
      case 'for':
        current.init?.forEach(noteInstruction)
        addExpressionWrites(current.test)
        visit(current.body)
        current.update?.forEach(noteInstruction)
        return
      case 'forOf':
        if (afterRegion && current.leftKind === 'assignment') {
          writes.add(deSSAVarName(current.variable))
          addExpressionWrites(current.assignmentTarget)
        }
        addExpressionWrites(current.iterable)
        visit(current.body)
        return
      case 'forIn':
        if (afterRegion && current.leftKind === 'assignment') {
          writes.add(deSSAVarName(current.variable))
          addExpressionWrites(current.assignmentTarget)
        }
        addExpressionWrites(current.object)
        visit(current.body)
        return
      case 'switch':
        addExpressionWrites(current.discriminant)
        current.cases.forEach(item => {
          addExpressionWrites(item.test)
          visit(item.body)
        })
        return
      case 'try':
        visit(current.block)
        visit(current.handler?.body)
        visit(current.finalizer)
        return
      case 'return':
      case 'throw':
        addExpressionWrites(current.argument)
        return
      case 'stateMachine':
        current.blocks.forEach(block => {
          block.instructions.forEach(noteInstruction)
          addTerminatorWrites(block.terminator)
        })
        return
      default:
        return
    }
  }

  visit(rootNode)
  return writes
}

function getLocalDeclarationName(instr: Instruction): string | null {
  if (instr.kind !== 'Assign' || !instr.declarationKind) return null
  return deSSAVarName(instr.target.name)
}

function isReactiveCreationExpression(expr: Expression): boolean {
  return (
    expr.kind === 'CallExpression' &&
    expr.callee.kind === 'Identifier' &&
    (expr.callee.name === '$state' || expr.callee.name === '$store')
  )
}

function isReactiveCreationInstruction(instr: Instruction): instr is ReactiveCreationInstruction {
  return (
    instr.kind === 'Assign' && !!instr.declarationKind && isReactiveCreationExpression(instr.value)
  )
}

function shouldDeferControlFlowPrefixInstruction(
  instr: Instruction,
  controlFlowDependencies: Set<string>,
  controlFlowWrites: Set<string>,
): boolean {
  const localName = getLocalDeclarationName(instr)
  if (!localName || !controlFlowDependencies.has(localName) || !controlFlowWrites.has(localName)) {
    return false
  }
  if (instr.kind === 'Assign' && isReactiveCreationExpression(instr.value)) return false
  return true
}

function buildDirectRegionEmitCandidate(
  nodes: StructuredNode[],
  startIndex: number,
  state: ControlFlowRegionState,
  instructionBuffer: { instr: Instruction; region?: Region | undefined }[],
  regionCtx?: RegionEmitContext,
): {
  region: Region
  rootNode: StructuredNode
  consumedUntil: number
  bufferedRegionInstructions: Instruction[]
  prefixInstructions: Instruction[]
} | null {
  const region = state.region
  if (!regionCtx || !region) return null

  const bufferedRegionInstructions = instructionBuffer
    .filter(item => item.region?.id === region.id)
    .map(item => item.instr)
  const buildPrefixInstructions = (): Instruction[] => {
    const deps = new Set<string>()
    const writes = new Set<string>()
    selectedNodes.forEach(node => {
      collectStructuredNodeDependencies(node).forEach(dep => deps.add(dep))
      collectStructuredNodeWrites(node).forEach(name => writes.add(name))
    })
    return instructionBuffer
      .filter(
        item =>
          item.region?.id === region.id ||
          shouldDeferControlFlowPrefixInstruction(item.instr, deps, writes),
      )
      .map(item => item.instr)
  }
  const coveredInstructions = [
    ...bufferedRegionInstructions,
    ...(state.ownedInstructionsByRegion?.get(region.id) ?? []),
  ]
  const selectedNodes: StructuredNode[] = [nodes[startIndex]!]

  if (instructionListCoversRegion(region, coveredInstructions)) {
    return {
      region,
      rootNode: combineDirectEmitNodes(selectedNodes),
      consumedUntil: startIndex,
      bufferedRegionInstructions,
      prefixInstructions: buildPrefixInstructions(),
    }
  }

  for (let index = startIndex + 1; index < nodes.length; index++) {
    const sibling = nodes[index]!

    if (sibling.kind === 'instruction') {
      const owner = findRegionForInstruction(sibling.instruction, regionCtx)
      if (!owner || owner.id !== region.id) {
        break
      }
      selectedNodes.push(sibling)
      coveredInstructions.push(sibling.instruction)
    } else {
      const siblingState = analyzeControlFlowRegion(sibling, regionCtx)
      if (siblingState.region?.id !== region.id) {
        break
      }
      selectedNodes.push(sibling)
      coveredInstructions.push(...(siblingState.ownedInstructionsByRegion?.get(region.id) ?? []))
    }

    if (instructionListCoversRegion(region, coveredInstructions)) {
      return {
        region,
        rootNode: combineDirectEmitNodes(selectedNodes),
        consumedUntil: index,
        bufferedRegionInstructions,
        prefixInstructions: buildPrefixInstructions(),
      }
    }
  }

  return null
}

function collectIncompleteBufferedRegionIds(
  buffer: { instr: Instruction; region?: Region | undefined }[],
): Set<number> {
  const disabled = new Set<number>()
  const instructionsByRegion = new Map<number, { region: Region; instructions: Instruction[] }>()

  for (const item of buffer) {
    if (!item.region) continue
    const current = instructionsByRegion.get(item.region.id)
    if (current) {
      current.instructions.push(item.instr)
    } else {
      instructionsByRegion.set(item.region.id, {
        region: item.region,
        instructions: [item.instr],
      })
    }
  }

  for (const [id, item] of instructionsByRegion) {
    if (!instructionListCoversRegion(item.region, item.instructions)) {
      disabled.add(id)
    }
  }

  return disabled
}

function structuredNodeUsesTrackedControlFlow(node: StructuredNode, ctx: CodegenContext): boolean {
  switch (node.kind) {
    case 'sequence':
      return node.nodes.some(child => structuredNodeUsesTrackedControlFlow(child, ctx))
    case 'block':
      return node.statements.some(child => structuredNodeUsesTrackedControlFlow(child, ctx))
    case 'labeled':
      return structuredNodeUsesTrackedControlFlow(node.statement, ctx)
    case 'if':
      return (
        expressionUsesTracked(node.test, ctx) ||
        structuredNodeUsesTrackedControlFlow(node.consequent, ctx) ||
        (node.alternate ? structuredNodeUsesTrackedControlFlow(node.alternate, ctx) : false)
      )
    case 'while':
    case 'doWhile':
      return (
        expressionUsesTracked(node.test, ctx) ||
        structuredNodeUsesTrackedControlFlow(node.body, ctx)
      )
    case 'for':
      return (
        (node.test ? expressionUsesTracked(node.test, ctx) : false) ||
        structuredNodeUsesTrackedControlFlow(node.body, ctx)
      )
    case 'forOf':
      return (
        expressionUsesTracked(node.iterable, ctx) ||
        structuredNodeUsesTrackedControlFlow(node.body, ctx)
      )
    case 'forIn':
      return (
        expressionUsesTracked(node.object, ctx) ||
        structuredNodeUsesTrackedControlFlow(node.body, ctx)
      )
    case 'switch':
      return (
        expressionUsesTracked(node.discriminant, ctx) ||
        node.cases.some(c => structuredNodeUsesTrackedControlFlow(c.body, ctx))
      )
    case 'try':
      return (
        structuredNodeUsesTrackedControlFlow(node.block, ctx) ||
        (node.handler ? structuredNodeUsesTrackedControlFlow(node.handler.body, ctx) : false) ||
        (node.finalizer ? structuredNodeUsesTrackedControlFlow(node.finalizer, ctx) : false)
      )
    default:
      return false
  }
}

function buildLabeledStructuredStatement(
  node: Extract<StructuredNode, { kind: 'labeled' }>,
  stmts: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (stmts.length === 0) return []
  const body =
    shouldLabelStructuredNodeDirectly(node.statement) && stmts.length === 1
      ? stmts[0]!
      : t.blockStatement(stmts)
  return [t.labeledStatement(t.identifier(node.label), body)]
}

function collectPatternBindingNames(
  pattern: LVal | BabelCore.types.PatternLike | null | undefined,
  t: typeof BabelCore.types,
  into: Set<string>,
): void {
  if (!pattern) return
  if (t.isIdentifier(pattern)) {
    into.add(deSSAVarName(pattern.name))
    return
  }
  if (t.isAssignmentPattern(pattern)) {
    collectPatternBindingNames(pattern.left as BabelCore.types.PatternLike, t, into)
    return
  }
  if (t.isRestElement(pattern)) {
    collectPatternBindingNames(pattern.argument as BabelCore.types.PatternLike, t, into)
    return
  }
  if (t.isObjectPattern(pattern)) {
    pattern.properties.forEach(prop => {
      if (t.isRestElement(prop)) {
        collectPatternBindingNames(prop.argument as BabelCore.types.PatternLike, t, into)
      } else if (t.isObjectProperty(prop)) {
        collectPatternBindingNames(prop.value as BabelCore.types.PatternLike, t, into)
      }
    })
    return
  }
  if (t.isArrayPattern(pattern)) {
    pattern.elements.forEach(el => {
      if (el && t.isPatternLike(el)) {
        collectPatternBindingNames(el as BabelCore.types.PatternLike, t, into)
      }
    })
  }
}

function collectStructuredCatchBindingNames(
  handler: Extract<StructuredNode, { kind: 'try' }>['handler'],
  t: typeof BabelCore.types,
): string[] {
  if (!handler) return []
  if (handler.pattern) {
    const names = new Set<string>()
    collectPatternBindingNames(handler.pattern, t, names)
    return Array.from(names)
  }
  return handler.param ? [deSSAVarName(handler.param)] : []
}

function lowerStructuredCatchParam(
  handler: NonNullable<Extract<StructuredNode, { kind: 'try' }>['handler']>,
  t: typeof BabelCore.types,
): BabelCore.types.CatchClause['param'] {
  if (handler.pattern) {
    return t.cloneNode(handler.pattern, true) as BabelCore.types.CatchClause['param']
  }
  return handler.param ? t.identifier(deSSAVarName(handler.param)) : null
}

function collectDirectBlockBindingNames(
  statements: StructuredNode[],
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  for (const statement of statements) {
    if (statement.kind === 'return' || statement.kind === 'throw') {
      statement.trailingStatements?.forEach(stmt =>
        collectBabelStatementBindingNames(stmt, t, names),
      )
      continue
    }
    if (statement.kind !== 'instruction') continue
    collectInstructionBindingName(statement.instruction, names)
  }
  return names
}

function collectBabelStatementBindingNames(
  stmt: BabelCore.types.Statement,
  t: typeof BabelCore.types,
  names: Set<string>,
): void {
  if (t.isVariableDeclaration(stmt)) {
    for (const decl of stmt.declarations) {
      collectPatternBindingNames(decl.id, t, names)
    }
    return
  }
  if (t.isClassDeclaration(stmt) && stmt.id) {
    names.add(stmt.id.name)
  }
}

function collectInstructionBindingName(instruction: Instruction, names: Set<string>): void {
  if (instruction.kind !== 'Assign') return
  const isFunctionDecl =
    instruction.value.kind === 'FunctionExpression' &&
    !!instruction.value.name &&
    !instruction.isMutation &&
    deSSAVarName(instruction.value.name) === deSSAVarName(instruction.target.name)
  if (instruction.declarationKind || isFunctionDecl) {
    names.add(deSSAVarName(instruction.target.name))
  }
}

function collectDirectStructuredBindingNames(
  node: StructuredNode | null | undefined,
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  if (!node) return names
  switch (node.kind) {
    case 'block':
      return collectDirectBlockBindingNames(node.statements, t)
    case 'sequence':
      for (const child of node.nodes) {
        if (child.kind === 'instruction') {
          collectInstructionBindingName(child.instruction, names)
        } else if (child.kind === 'return' || child.kind === 'throw') {
          child.trailingStatements?.forEach(stmt =>
            collectBabelStatementBindingNames(stmt, t, names),
          )
        }
      }
      return names
    case 'instruction':
      collectInstructionBindingName(node.instruction, names)
      return names
    case 'return':
    case 'throw':
      node.trailingStatements?.forEach(stmt => collectBabelStatementBindingNames(stmt, t, names))
      return names
    default:
      return names
  }
}

function withShadowedBindings<T>(ctx: CodegenContext, names: Iterable<string>, fn: () => T): T {
  const bindingNames = Array.from(names, name => deSSAVarName(name))
  if (bindingNames.length === 0) return fn()

  const prevTracked = ctx.trackedVars
  const prevShadowed = ctx.shadowedNames
  const prevSignals = ctx.signalVars
  const prevCallableSignals = ctx.callableSignalVars
  const prevNonSerializableSignals = ctx.nonSerializableSignalVars
  const prevMemos = ctx.memoVars
  const prevAliases = ctx.aliasVars
  const prevResumablePropAccessors = ctx.resumablePropAccessors
  const tracked = new Set(ctx.trackedVars)
  bindingNames.forEach(name => tracked.delete(name))
  ctx.trackedVars = tracked
  if (ctx.signalVars) {
    const signals = new Set(ctx.signalVars)
    bindingNames.forEach(name => signals.delete(name))
    ctx.signalVars = signals
  }
  if (ctx.callableSignalVars) {
    const callableSignals = new Set(ctx.callableSignalVars)
    bindingNames.forEach(name => callableSignals.delete(name))
    ctx.callableSignalVars = callableSignals
  }
  if (ctx.nonSerializableSignalVars) {
    const nonSerializableSignals = new Set(ctx.nonSerializableSignalVars)
    bindingNames.forEach(name => nonSerializableSignals.delete(name))
    ctx.nonSerializableSignalVars = nonSerializableSignals
  }
  if (ctx.memoVars) {
    const memos = new Set(ctx.memoVars)
    bindingNames.forEach(name => memos.delete(name))
    ctx.memoVars = memos
  }
  if (ctx.aliasVars) {
    const aliases = new Set(ctx.aliasVars)
    bindingNames.forEach(name => aliases.delete(name))
    ctx.aliasVars = aliases
  }
  if (ctx.resumablePropAccessors) {
    const resumablePropAccessors = new Map(ctx.resumablePropAccessors)
    bindingNames.forEach(name => resumablePropAccessors.delete(name))
    ctx.resumablePropAccessors = resumablePropAccessors
  }
  const shadowed = new Set(prevShadowed ?? [])
  bindingNames.forEach(name => shadowed.add(name))
  ctx.shadowedNames = shadowed

  try {
    return fn()
  } finally {
    ctx.trackedVars = prevTracked
    ctx.shadowedNames = prevShadowed
    ctx.signalVars = prevSignals
    ctx.callableSignalVars = prevCallableSignals
    ctx.nonSerializableSignalVars = prevNonSerializableSignals
    ctx.memoVars = prevMemos
    ctx.aliasVars = prevAliases
    ctx.resumablePropAccessors = prevResumablePropAccessors
  }
}

function lowerLoopAssignmentTargetWithDeSSA(
  target: Expression,
  ctx: CodegenContext,
): BabelCore.types.Identifier | BabelCore.types.MemberExpression {
  const lowered = lowerExpressionWithDeSSA(target, ctx)
  if (ctx.t.isIdentifier(lowered) || ctx.t.isMemberExpression(lowered)) {
    return lowered
  }
  return ctx.t.identifier('_item')
}

/**
 * Lower a node with region context
 */
function lowerNodeWithRegionContext(
  node: StructuredNode,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
  regionCtx?: RegionEmitContext,
): BabelCore.types.Statement[] {
  switch (node.kind) {
    case 'sequence': {
      const stmts: BabelCore.types.Statement[] = []
      // Collect instructions and emit regions as complete units
      const instructionBuffer: { instr: Instruction; region?: Region | undefined }[] = []

      for (let index = 0; index < node.nodes.length; index++) {
        const child = node.nodes[index]!
        if (child.kind === 'instruction') {
          if (isClassEvaluationBarrier(child.instruction)) {
            const disabledRegionIds = new Set<number>()
            for (const item of instructionBuffer) {
              if (item.region) disabledRegionIds.add(item.region.id)
            }
            const classRegion = findRegionForInstruction(child.instruction, regionCtx)
            if (classRegion) disabledRegionIds.add(classRegion.id)
            disabledRegionIds.forEach(id => regionCtx?.disabledRegions.add(id))
            stmts.push(
              ...flushInstructionBuffer(instructionBuffer, t, ctx, declaredVars, regionCtx),
            )
            instructionBuffer.length = 0
            const stmt = instructionToStatement(child.instruction, t, declaredVars, ctx)
            if (stmt) stmts.push(stmt)
            continue
          }
          const region = findRegionForInstruction(child.instruction, regionCtx)
          instructionBuffer.push({ instr: child.instruction, region })
        } else {
          const controlFlowState = analyzeControlFlowRegion(child, regionCtx)
          const disablePartialRegions = shouldDisablePartialRegions(child)
          const disableEarlyExitRegion = _structuredNodeHasEarlyExit(child)
          const disableAbruptCompletionRegion = _structuredNodeHasReturnOrThrow(child)
          const directEmitCandidate = buildDirectRegionEmitCandidate(
            node.nodes,
            index,
            controlFlowState,
            instructionBuffer,
            regionCtx,
          )
          const partialRegion =
            !controlFlowState.region && controlFlowState.partialRegionIds.size === 1
              ? regionCtx?.regionResult.regions.find(
                  region => region.id === Array.from(controlFlowState.partialRegionIds)[0],
                )
              : undefined
          const controlFlowRegion =
            directEmitCandidate?.region ?? controlFlowState.region ?? partialRegion
          if (controlFlowRegion && regionRequiresEagerDerivedLowering(controlFlowRegion, ctx)) {
            regionCtx?.disabledRegions.add(controlFlowRegion.id)
          }
          const canDirectlyEmitRegion =
            !!directEmitCandidate &&
            !!controlFlowRegion &&
            controlFlowRegion.shouldMemoize &&
            canEmitControlFlowRegionDirectly(child) &&
            !disableAbruptCompletionRegion &&
            !regionCtx?.disabledRegions.has(controlFlowRegion.id)
          const disabledRegionIdsForControlFlow = new Set<number>()
          if (!canDirectlyEmitRegion && (disablePartialRegions || disableEarlyExitRegion)) {
            controlFlowState.partialRegionIds.forEach(id => disabledRegionIdsForControlFlow.add(id))
            if (disableAbruptCompletionRegion && controlFlowState.region) {
              disabledRegionIdsForControlFlow.add(controlFlowState.region.id)
            }
          }
          if (structuredNodeUsesTrackedControlFlow(child, ctx)) {
            const controlFlowOwnedRegionIds = new Set<number>()
            if (controlFlowState.region) controlFlowOwnedRegionIds.add(controlFlowState.region.id)
            controlFlowState.partialRegionIds.forEach(id => controlFlowOwnedRegionIds.add(id))
            controlFlowState.ownedInstructionsByRegion?.forEach((_instructions, id) =>
              controlFlowOwnedRegionIds.add(id),
            )
            collectIncompleteBufferedRegionIds(instructionBuffer).forEach(id => {
              if (!controlFlowOwnedRegionIds.has(id)) {
                regionCtx?.disabledRegions.add(id)
              }
            })
          }
          // Flush pending instructions before control flow
          stmts.push(
            ...flushInstructionBuffer(
              instructionBuffer,
              t,
              ctx,
              declaredVars,
              regionCtx,
              disabledRegionIdsForControlFlow.size > 0
                ? disabledRegionIdsForControlFlow
                : undefined,
              canDirectlyEmitRegion && controlFlowRegion
                ? new Set([controlFlowRegion.id])
                : undefined,
              canDirectlyEmitRegion && directEmitCandidate
                ? new Set(directEmitCandidate.prefixInstructions)
                : undefined,
            ),
          )
          instructionBuffer.length = 0
          if (canDirectlyEmitRegion && controlFlowRegion && regionCtx && directEmitCandidate) {
            if (!regionCtx?.emittedRegions.has(controlFlowRegion.id)) {
              regionCtx?.emittedRegions.add(controlFlowRegion.id)
              stmts.push(
                ...generateRegionStatements(
                  controlFlowRegion,
                  t,
                  declaredVars,
                  ctx,
                  {
                    ...regionCtx,
                    rootNode: directEmitCandidate.rootNode,
                    inlineUnownedInRegionBody: true,
                  },
                  directEmitCandidate.prefixInstructions,
                ),
              )
            }
            index = directEmitCandidate.consumedUntil
            continue
          }
          if (disablePartialRegions) {
            controlFlowState.partialRegionIds.forEach(id => regionCtx?.disabledRegions.add(id))
          }
          if (disableEarlyExitRegion) {
            if (controlFlowState.region) {
              regionCtx?.disabledRegions.add(controlFlowState.region.id)
            }
            controlFlowState.partialRegionIds.forEach(id => regionCtx?.disabledRegions.add(id))
          }
          if (
            controlFlowRegion &&
            controlFlowRegion.shouldMemoize &&
            !regionCtx?.disabledRegions.has(controlFlowRegion.id) &&
            regionCtx?.emittedRegions.has(controlFlowRegion.id)
          ) {
            continue
          }
          if (allOwnedControlFlowRegionsAreHandled(controlFlowState, regionCtx)) {
            continue
          }
          stmts.push(...lowerNodeWithRegionContext(child, t, ctx, declaredVars, regionCtx))
        }
      }
      // Flush remaining instructions
      stmts.push(...flushInstructionBuffer(instructionBuffer, t, ctx, declaredVars, regionCtx))
      return stmts
    }

    case 'labeled': {
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const mightWrapInEffect =
        !shouldLabelStructuredNodeDirectly(node.statement) &&
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        structuredNodeUsesTrackedControlFlow(node.statement, ctx)
      const prevNonReactiveDepth = ctx.nonReactiveScopeDepth ?? 0
      if (mightWrapInEffect) {
        ctx.nonReactiveScopeDepth = prevNonReactiveDepth + 1
      }
      let body: BabelCore.types.Statement[]
      try {
        body = lowerNodeWithRegionContext(node.statement, t, ctx, declaredVars, regionCtx)
      } finally {
        if (mightWrapInEffect) {
          ctx.nonReactiveScopeDepth = prevNonReactiveDepth
        }
      }
      const labeledStmt = buildLabeledStructuredStatement(node, body, t)
      if (
        mightWrapInEffect &&
        labeledStmt.length > 0 &&
        !_structuredNodeHasEarlyExit(node.statement, { ignoreBreakLabel: node.label })
      ) {
        const effectFn = t.arrowFunctionExpression([], t.blockStatement(labeledStmt))
        return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
      }
      return labeledStmt
    }

    case 'block': {
      const stmts: BabelCore.types.Statement[] = []
      const scopedDeclared = new Set(declaredVars)
      const blockBindings = collectDirectBlockBindingNames(node.statements, t)
      withShadowedBindings(ctx, blockBindings, () => {
        for (const child of node.statements) {
          stmts.push(...lowerNodeWithRegionContext(child, t, ctx, scopedDeclared, regionCtx))
        }
      })
      return [t.blockStatement(stmts)]
    }

    case 'instruction': {
      // Single instruction - check if it belongs to a region
      if (instructionWritesHandledRegionOutput(node.instruction, regionCtx)) return []
      const region = findRegionForInstruction(node.instruction, regionCtx)
      if (region && regionRequiresEagerDerivedLowering(region, ctx)) {
        regionCtx?.disabledRegions.add(region.id)
      }
      if (
        !regionCtx?.hoistedInstructions.has(node.instruction) &&
        region &&
        region.shouldMemoize &&
        !regionCtx?.disabledRegions.has(region.id) &&
        !regionCtx?.emittedRegions.has(region.id)
      ) {
        // Emit the entire region with memo
        regionCtx?.emittedRegions.add(region.id)
        return generateRegionStatements(region, t, declaredVars, ctx, regionCtx)
      }
      if (region && region.shouldMemoize && regionCtx?.emittedRegions.has(region.id)) {
        return []
      }
      if (regionCtx?.hoistedInstructions.has(node.instruction)) return []
      // Not in a memoized region or region already emitted
      const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
      return stmt ? [stmt] : []
    }

    case 'return': {
      return [
        t.returnStatement(node.argument ? lowerExpressionWithDeSSA(node.argument, ctx) : null),
        ...cloneTrailingStatements(node.trailingStatements, t),
      ]
    }

    case 'throw': {
      return [
        t.throwStatement(lowerExpressionWithDeSSA(node.argument, ctx)),
        ...cloneTrailingStatements(node.trailingStatements, t),
      ]
    }

    case 'break': {
      return [t.breakStatement(node.label ? t.identifier(node.label) : null)]
    }

    case 'continue': {
      return [t.continueStatement(node.label ? t.identifier(node.label) : null)]
    }

    case 'if': {
      const prevConditional = ctx.inConditional ?? 0
      ctx.inConditional = prevConditional + 1

      // fix: Pre-compute whether we *might* wrap this if in an effect BEFORE lowering children.
      // We check most conditions but NOT early exit (that requires the built statement).
      // If we might wrap in effect, increment nonReactiveScopeDepth to prevent nested effect wrapping.
      // This prevents the bug where nested if statements inside an effect callback also get wrapped
      // in effects, causing __fictUseEffect to be called outside render context.
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const mightWrapInEffect =
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        expressionUsesTracked(node.test, ctx)
      const controlFlowState = analyzeControlFlowRegion(node, regionCtx)
      const partialRegion =
        !controlFlowState.region && controlFlowState.partialRegionIds.size === 1
          ? regionCtx?.regionResult.regions.find(
              region => region.id === Array.from(controlFlowState.partialRegionIds)[0],
            )
          : undefined
      const memoizedControlFlowRegion = controlFlowState.region ?? partialRegion
      if (
        memoizedControlFlowRegion?.shouldMemoize &&
        (regionCtx?.emittedRegions.has(memoizedControlFlowRegion.id) ||
          !regionCtx?.disabledRegions.has(memoizedControlFlowRegion.id))
      ) {
        return []
      }
      if (allOwnedControlFlowRegionsAreHandled(controlFlowState, regionCtx)) {
        return []
      }

      // If we might wrap in effect, mark children as being in a non-reactive scope
      // so they don't also get wrapped in effects
      const prevNonReactiveDepth = ctx.nonReactiveScopeDepth ?? 0
      if (mightWrapInEffect) {
        ctx.nonReactiveScopeDepth = prevNonReactiveDepth + 1
      }

      const lowerBranch = (child: StructuredNode): BabelCore.types.Statement[] => {
        const scopedDeclared = new Set(declaredVars)
        const branchBindings = collectDirectStructuredBindingNames(child, t)
        return withShadowedBindings(ctx, branchBindings, () =>
          lowerNodeWithRegionContext(child, t, ctx, scopedDeclared, regionCtx),
        )
      }
      const conseqStmts = lowerBranch(node.consequent)
      const altStmts = node.alternate ? lowerBranch(node.alternate) : null

      // Restore non-reactive depth
      if (mightWrapInEffect) {
        ctx.nonReactiveScopeDepth = prevNonReactiveDepth
      }
      ctx.inConditional = prevConditional

      const conseqReactiveOnly = nodeIsPureReactiveScope(node.consequent, ctx.memoMacroNames)
      const altReactiveOnly = node.alternate
        ? nodeIsPureReactiveScope(node.alternate, ctx.memoMacroNames)
        : false
      const testExpr = lowerExpressionWithDeSSA(node.test, ctx)
      const unwrapTestExpr = (): BabelCore.types.Expression => {
        if (
          t.isArrowFunctionExpression(testExpr) &&
          testExpr.params.length === 0 &&
          !t.isBlockStatement(testExpr.body)
        ) {
          return t.cloneNode(testExpr.body)
        }
        return t.cloneNode(testExpr)
      }
      const createFlagExpr = (negate = false): BabelCore.types.ArrowFunctionExpression => {
        const body = unwrapTestExpr()
        const bodyExpr = negate ? t.unaryExpression('!', body) : body
        return t.arrowFunctionExpression([], bodyExpr)
      }

      if (conseqReactiveOnly || altReactiveOnly) {
        const stmts: BabelCore.types.Statement[] = []
        const runInScopeId = runtimeIdentifier(ctx, 'runInScope')
        const addScoped = (
          flagExpr: BabelCore.types.Expression,
          body: BabelCore.types.Statement[],
        ) => {
          ctx.helpersUsed.add('runInScope')
          stmts.push(
            t.expressionStatement(
              t.callExpression(runInScopeId, [
                markCompilerReactiveGetter(ctx, flagExpr),
                t.arrowFunctionExpression([], t.blockStatement(body)),
              ]),
            ),
          )
        }

        if (conseqReactiveOnly) {
          addScoped(createFlagExpr(false), conseqStmts)
        }
        if (altReactiveOnly && altStmts) {
          addScoped(createFlagExpr(true), altStmts)
        }

        const needsFallbackConseq = !conseqReactiveOnly && conseqStmts.length > 0
        const needsFallbackAlt = !altReactiveOnly && altStmts && altStmts.length > 0
        if (needsFallbackConseq || needsFallbackAlt) {
          stmts.push(
            t.ifStatement(
              unwrapTestExpr(),
              needsFallbackConseq ? t.blockStatement(conseqStmts) : t.blockStatement([]),
              needsFallbackAlt && altStmts ? t.blockStatement(altStmts) : null,
            ),
          )
        }

        return stmts
      }

      // fix: Don't generate empty if statements (or wrap them in effects).
      // When assignments are moved to a region memo, the if body may become empty.
      const conseqIsEmpty = conseqStmts.length === 0
      const altIsEmpty = !altStmts || altStmts.length === 0
      if (conseqIsEmpty && altIsEmpty) {
        // Both branches are empty - nothing to generate
        return []
      }

      const ifStmt = t.ifStatement(
        testExpr,
        t.blockStatement(conseqStmts),
        altStmts ? t.blockStatement(altStmts) : null,
      )
      // Final check: only wrap in effect if no early exit (after lowering to check the statement)
      const shouldWrapEffect = mightWrapInEffect && !statementHasEarlyExit(ifStmt, t)
      if (shouldWrapEffect) {
        const effectFn = t.arrowFunctionExpression([], t.blockStatement([ifStmt]))
        return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
      }

      return [ifStmt]
    }

    case 'while': {
      const shouldWrap = shouldWrapTrackedControlInEffect(node.test, ctx)
      const scopedDeclared = new Set(declaredVars)
      const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
      const body = t.blockStatement(
        withShadowedBindings(ctx, bodyBindings, () =>
          withTrackedControlEffectScope(ctx, shouldWrap, () =>
            lowerNodeWithRegionContext(node.body, t, ctx, scopedDeclared, regionCtx),
          ),
        ),
      )
      const stmt = t.whileStatement(lowerExpressionWithDeSSA(node.test, ctx), body)
      return wrapTrackedControlStatement(stmt, shouldWrap, ctx, t)
    }

    case 'doWhile': {
      const shouldWrap = shouldWrapTrackedControlInEffect(node.test, ctx)
      const scopedDeclared = new Set(declaredVars)
      const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
      const body = t.blockStatement(
        withShadowedBindings(ctx, bodyBindings, () =>
          withTrackedControlEffectScope(ctx, shouldWrap, () =>
            lowerNodeWithRegionContext(node.body, t, ctx, scopedDeclared, regionCtx),
          ),
        ),
      )
      const stmt = t.doWhileStatement(lowerExpressionWithDeSSA(node.test, ctx), body)
      return wrapTrackedControlStatement(stmt, shouldWrap, ctx, t)
    }

    case 'for': {
      const forBindings = new Set<string>()
      node.init?.forEach(instr => {
        if (instr.kind === 'Assign' && instr.declarationKind) {
          forBindings.add(deSSAVarName(instr.target.name))
        }
      })
      let init: BabelCore.types.VariableDeclaration | BabelCore.types.Expression | null = null
      let test: BabelCore.types.Expression | null = null
      let update: BabelCore.types.Expression | null = null
      let body: BabelCore.types.BlockStatement = t.blockStatement([])
      withShadowedBindings(ctx, forBindings, () => {
        init =
          node.init && node.init.length > 0 ? lowerInstructionsToInitExpr(node.init, t, ctx) : null
        test = node.test ? lowerExpressionWithDeSSA(node.test, ctx) : null
        update =
          node.update && node.update.length > 0
            ? lowerInstructionsToUpdateExpr(node.update, t, ctx)
            : null
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        body = t.blockStatement(
          withShadowedBindings(ctx, bodyBindings, () =>
            lowerNodeWithRegionContext(node.body, t, ctx, bodyDeclared, regionCtx),
          ),
        )
      })

      return [t.forStatement(init, test, update, body)]
    }

    case 'forOf': {
      const varKind = node.variableKind ?? 'const'
      let leftPattern: BabelCore.types.LVal
      if (node.pattern) {
        // Destructuring pattern - use the stored pattern directly
        leftPattern = node.pattern as BabelCore.types.LVal
      } else {
        leftPattern = t.identifier(deSSAVarName(node.variable))
      }
      const right = lowerExpressionWithDeSSA(node.iterable, ctx)
      const isAssignmentTarget = node.leftKind === 'assignment' && !node.pattern
      const targetName = deSSAVarName(node.variable)
      const lowerLoopBody = (): BabelCore.types.Statement[] => {
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        return withShadowedBindings(ctx, bodyBindings, () =>
          lowerNodeWithRegionContext(node.body, t, ctx, bodyDeclared, regionCtx),
        )
      }
      if (isAssignmentTarget && node.assignmentTarget) {
        const bodyStmts = lowerLoopBody()
        return [
          t.forOfStatement(
            lowerLoopAssignmentTargetWithDeSSA(node.assignmentTarget, ctx),
            right,
            t.blockStatement(bodyStmts),
            !!node.await,
          ),
        ]
      }
      if (isAssignmentTarget) {
        const bodyStmts = lowerLoopBody()
        if (ctx.trackedVars.has(targetName)) {
          const valueId = t.identifier(`__forOf_${ctx.tempCounter++}`)
          return [
            t.forOfStatement(
              t.variableDeclaration('const', [t.variableDeclarator(valueId)]),
              right,
              t.blockStatement([
                t.expressionStatement(
                  t.callExpression(t.identifier(targetName), [t.identifier(valueId.name)]),
                ),
                ...bodyStmts,
              ]),
              !!node.await,
            ),
          ]
        }
        return [
          t.forOfStatement(
            t.identifier(targetName),
            right,
            t.blockStatement(bodyStmts),
            !!node.await,
          ),
        ]
      }
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const bindingNames = new Set<string>()
      collectPatternBindingNames(leftPattern, t, bindingNames)
      let body: BabelCore.types.BlockStatement = t.blockStatement([])
      withShadowedBindings(ctx, bindingNames, () => {
        body = t.blockStatement(lowerLoopBody())
      })

      return [t.forOfStatement(left, right, body, !!node.await)]
    }

    case 'forIn': {
      const varKind = node.variableKind ?? 'const'
      let leftPattern: BabelCore.types.LVal
      if (node.pattern) {
        // Destructuring pattern - use the stored pattern directly
        leftPattern = node.pattern as BabelCore.types.LVal
      } else {
        leftPattern = t.identifier(deSSAVarName(node.variable))
      }
      const right = lowerExpressionWithDeSSA(node.object, ctx)
      const isAssignmentTarget = node.leftKind === 'assignment' && !node.pattern
      const targetName = deSSAVarName(node.variable)
      const lowerLoopBody = (): BabelCore.types.Statement[] => {
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        return withShadowedBindings(ctx, bodyBindings, () =>
          lowerNodeWithRegionContext(node.body, t, ctx, bodyDeclared, regionCtx),
        )
      }
      if (isAssignmentTarget && node.assignmentTarget) {
        const bodyStmts = lowerLoopBody()
        return [
          t.forInStatement(
            lowerLoopAssignmentTargetWithDeSSA(node.assignmentTarget, ctx),
            right,
            t.blockStatement(bodyStmts),
          ),
        ]
      }
      if (isAssignmentTarget) {
        const bodyStmts = lowerLoopBody()
        if (ctx.trackedVars.has(targetName)) {
          const valueId = t.identifier(`__forIn_${ctx.tempCounter++}`)
          return [
            t.forInStatement(
              t.variableDeclaration('const', [t.variableDeclarator(valueId)]),
              right,
              t.blockStatement([
                t.expressionStatement(
                  t.callExpression(t.identifier(targetName), [t.identifier(valueId.name)]),
                ),
                ...bodyStmts,
              ]),
            ),
          ]
        }
        return [t.forInStatement(t.identifier(targetName), right, t.blockStatement(bodyStmts))]
      }
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const bindingNames = new Set<string>()
      collectPatternBindingNames(leftPattern, t, bindingNames)
      let body: BabelCore.types.BlockStatement = t.blockStatement([])
      withShadowedBindings(ctx, bindingNames, () => {
        body = t.blockStatement(lowerLoopBody())
      })

      return [t.forInStatement(left, right, body)]
    }

    case 'switch': {
      const prevConditional = ctx.inConditional ?? 0
      ctx.inConditional = prevConditional + 1
      let cases: BabelCore.types.SwitchCase[]
      try {
        cases = node.cases.map(c => {
          const caseDeclared = new Set(declaredVars)
          const caseBindings = collectDirectStructuredBindingNames(c.body, t)
          const stmts = ensureSwitchCaseBreak(
            withShadowedBindings(ctx, caseBindings, () =>
              lowerNodeWithRegionContext(c.body, t, ctx, caseDeclared, regionCtx),
            ),
            t,
            c.fallsThrough === true,
          )
          return t.switchCase(c.test ? lowerExpressionWithDeSSA(c.test, ctx) : null, stmts)
        })
      } finally {
        ctx.inConditional = prevConditional
      }
      return [t.switchStatement(lowerExpressionWithDeSSA(node.discriminant, ctx), cases)]
    }

    case 'try': {
      const blockDeclared = new Set(declaredVars)
      const blockBindings = collectDirectStructuredBindingNames(node.block, t)
      const block = t.blockStatement(
        withShadowedBindings(ctx, blockBindings, () =>
          lowerNodeWithRegionContext(node.block, t, ctx, blockDeclared, regionCtx),
        ),
      )
      const handlerNode = node.handler
      const handler = handlerNode
        ? t.catchClause(
            lowerStructuredCatchParam(handlerNode, t),
            (() => {
              const handlerBindings = collectStructuredCatchBindingNames(handlerNode, t)
              collectDirectStructuredBindingNames(handlerNode.body, t).forEach(name =>
                handlerBindings.push(name),
              )
              const handlerDeclared = new Set(declaredVars)
              let handlerBody = t.blockStatement([])
              withShadowedBindings(ctx, handlerBindings, () => {
                handlerBody = t.blockStatement(
                  lowerNodeWithRegionContext(handlerNode.body, t, ctx, handlerDeclared, regionCtx),
                )
              })
              return handlerBody
            })(),
          )
        : null
      const finalizer = node.finalizer
        ? (() => {
            const finalizerDeclared = new Set(declaredVars)
            const finalizerBindings = collectDirectStructuredBindingNames(node.finalizer, t)
            return t.blockStatement(
              withShadowedBindings(ctx, finalizerBindings, () =>
                lowerNodeWithRegionContext(node.finalizer!, t, ctx, finalizerDeclared, regionCtx),
              ),
            )
          })()
        : null

      return [t.tryStatement(block, handler, finalizer)]
    }

    case 'stateMachine': {
      const unsupportedBlock = node.blocks.find(block => {
        switch (block.terminator.kind) {
          case 'Try':
          case 'Switch':
          case 'ForOf':
          case 'ForIn':
            return true
          default:
            return false
        }
      })
      if (unsupportedBlock) {
        throw new HIRError(
          `Unsafe state-machine fallback: ${unsupportedBlock.terminator.kind} terminator in block ` +
            `${unsupportedBlock.blockId} cannot be lowered without changing semantics`,
          'BUILD_ERROR',
          {
            blockId: unsupportedBlock.blockId,
            file: ctx.options?.filename,
            line: unsupportedBlock.terminator.loc?.start.line,
          },
        )
      }

      const unsafeReactiveFallback = getUnsafeReactiveStateMachineFallback(node, ctx)
      if (unsafeReactiveFallback) {
        throw new HIRError(
          `Unsafe reactive state-machine fallback: local "${unsafeReactiveFallback.localName}" ` +
            `is recomputed from reactive control flow, but the fallback would return stale output. ` +
            `Rewrite the do...while control flow or remove the continue that forces fallback.`,
          'BUILD_ERROR',
          {
            blockId: unsafeReactiveFallback.blockId,
            file: ctx.options?.filename,
            line: unsafeReactiveFallback.line,
          },
        )
      }

      const hoisted: string[] = []
      const normalizedBlocks = node.blocks.map(block => {
        const instructions = block.instructions.map(instr => {
          if (instr.kind === 'Assign' && instr.declarationKind) {
            const base = deSSAVarName(instr.target.name)
            if (!hoisted.includes(base)) hoisted.push(base)
            return { ...instr, declarationKind: undefined }
          }
          return instr
        })
        return { ...block, instructions }
      })
      const hoistedDecl =
        hoisted.length > 0
          ? [
              t.variableDeclaration(
                'let',
                hoisted.map(name => t.variableDeclarator(t.identifier(name))),
              ),
            ]
          : []
      const hoistedInitializers = new Set(hoisted)
      const stateMachineDeclared = new Set(declaredVars)
      hoisted.forEach(n => stateMachineDeclared.add(n))

      // Fallback: generate a switch-based state machine
      // This handles non-structurable CFGs by emulating goto with a state variable
      const stateVar = t.identifier(reserveFunctionLocalName(ctx, '__state'))
      const stateDecl = t.variableDeclaration('let', [
        t.variableDeclarator(stateVar, t.numericLiteral(node.entryBlock)),
      ])

      // Generate switch cases for each block
      const cases: BabelCore.types.SwitchCase[] = []
      for (const block of normalizedBlocks) {
        const stmts: BabelCore.types.Statement[] = []

        // Lower instructions
        for (const instr of block.instructions) {
          const stmt = instructionToStatement(
            instr,
            t,
            stateMachineDeclared,
            ctx,
            undefined,
            hoistedInitializers,
          )
          if (stmt) stmts.push(stmt)
        }

        // Lower terminator
        stmts.push(...lowerTerminatorForStateMachine(block.terminator, t, ctx, stateVar))
        stmts.push(...cloneTrailingStatements(block.postTerminatorStatements, t))

        cases.push(t.switchCase(t.numericLiteral(block.blockId), stmts))
      }

      // Add default case that breaks the loop
      cases.push(t.switchCase(null, [t.breakStatement(t.identifier('__cfgLoop'))]))

      const switchStmt = t.switchStatement(stateVar, cases)
      const whileLoop = t.whileStatement(t.booleanLiteral(true), t.blockStatement([switchStmt]))
      const labeledLoop = t.labeledStatement(t.identifier('__cfgLoop'), whileLoop)

      return [...hoistedDecl, stateDecl, labeledLoop]
    }

    default:
      return []
  }
}

/**
 * Lower a terminator for state machine fallback
 */
function lowerTerminatorForStateMachine(
  term: Terminator,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  stateVar: BabelCore.types.Identifier,
): BabelCore.types.Statement[] {
  switch (term.kind) {
    case 'Return':
      return [
        t.returnStatement(term.argument ? lowerExpressionWithDeSSA(term.argument, ctx) : null),
      ]

    case 'Throw':
      return [t.throwStatement(lowerExpressionWithDeSSA(term.argument, ctx))]

    case 'Jump':
      return [
        t.expressionStatement(t.assignmentExpression('=', stateVar, t.numericLiteral(term.target))),
        t.continueStatement(t.identifier('__cfgLoop')),
      ]

    case 'Branch':
      return [
        t.ifStatement(
          lowerExpressionWithDeSSA(term.test, ctx),
          t.blockStatement([
            t.expressionStatement(
              t.assignmentExpression('=', stateVar, t.numericLiteral(term.consequent)),
            ),
          ]),
          t.blockStatement([
            t.expressionStatement(
              t.assignmentExpression('=', stateVar, t.numericLiteral(term.alternate)),
            ),
          ]),
        ),
        t.continueStatement(t.identifier('__cfgLoop')),
      ]

    case 'Break':
      return [
        t.expressionStatement(t.assignmentExpression('=', stateVar, t.numericLiteral(term.target))),
        t.continueStatement(t.identifier('__cfgLoop')),
      ]

    case 'Continue':
      return [
        t.expressionStatement(t.assignmentExpression('=', stateVar, t.numericLiteral(term.target))),
        t.continueStatement(t.identifier('__cfgLoop')),
      ]

    case 'Unreachable':
      // Insert unreachable marker (throws at runtime if reached)
      return [
        t.throwStatement(
          t.newExpression(t.identifier('Error'), [t.stringLiteral('Unreachable code')]),
        ),
      ]

    default:
      // For complex terminators (ForOf, ForIn, Try, Switch), break the loop
      // The state machine fallback is mainly for simple CFG issues
      return [t.breakStatement(t.identifier('__cfgLoop'))]
  }
}

type StateMachineNode = Extract<StructuredNode, { kind: 'stateMachine' }>

function getUnsafeReactiveStateMachineFallback(
  node: StateMachineNode,
  ctx: CodegenContext,
): { localName: string; blockId: BlockId; line?: number | undefined } | null {
  const reactiveNames = new Set(Array.from(ctx.trackedVars, name => deSSAVarName(name)))
  for (const block of node.blocks) {
    for (const instr of block.instructions) {
      if (isReactiveCreationInstruction(instr)) {
        reactiveNames.add(deSSAVarName(instr.target.name))
      }
    }
  }
  if (reactiveNames.size === 0) return null

  const localDeclarations = new Set<string>()
  const laterWrites = new Set<string>()
  let hasReturn = false
  let reactiveReadBlock: StateMachineNode['blocks'][number] | undefined

  const noteDependencies = (deps: Set<string>, block: StateMachineNode['blocks'][number]) => {
    if (reactiveReadBlock) return
    for (const dep of deps) {
      if (reactiveNames.has(deSSAVarName(dep))) {
        reactiveReadBlock = block
        return
      }
    }
  }

  for (const block of node.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.declarationKind) {
        if (!isReactiveCreationInstruction(instr)) {
          localDeclarations.add(deSSAVarName(instr.target.name))
        }
        collectExpressionWrites(instr.value).forEach(name => laterWrites.add(name))
      } else {
        collectInstructionWrites(instr).forEach(name => laterWrites.add(name))
      }
      noteDependencies(collectInstructionDependencies(instr), block)
    }
    if (block.terminator.kind === 'Return') {
      hasReturn = true
    }
    noteDependencies(collectTerminatorDependencies(block.terminator), block)
  }

  if (!hasReturn || !reactiveReadBlock) return null

  for (const localName of localDeclarations) {
    if (laterWrites.has(localName)) {
      return {
        localName,
        blockId: reactiveReadBlock.blockId,
        line: reactiveReadBlock.terminator.loc?.start.line,
      }
    }
  }

  return null
}

function lowerStructuredNodeForRegion(
  node: StructuredNode,
  region: Region,
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
  regionCtx?: RegionEmitContext,
  skipInstructions?: Set<Instruction>,
): BabelCore.types.Statement[] {
  switch (node.kind) {
    case 'sequence': {
      const stmts: BabelCore.types.Statement[] = []
      for (const child of node.nodes) {
        stmts.push(
          ...lowerStructuredNodeForRegion(
            child,
            region,
            t,
            ctx,
            declaredVars,
            regionCtx,
            skipInstructions,
          ),
        )
      }
      return stmts
    }

    case 'labeled': {
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const mightWrapInEffect =
        !shouldLabelStructuredNodeDirectly(node.statement) &&
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        structuredNodeUsesTrackedControlFlow(node.statement, ctx)
      const prevNonReactiveDepth = ctx.nonReactiveScopeDepth ?? 0
      if (mightWrapInEffect) {
        ctx.nonReactiveScopeDepth = prevNonReactiveDepth + 1
      }
      let body: BabelCore.types.Statement[]
      try {
        body = lowerStructuredNodeForRegion(
          node.statement,
          region,
          t,
          ctx,
          declaredVars,
          regionCtx,
          skipInstructions,
        )
      } finally {
        if (mightWrapInEffect) {
          ctx.nonReactiveScopeDepth = prevNonReactiveDepth
        }
      }
      const labeledStmt = buildLabeledStructuredStatement(node, body, t)
      if (
        mightWrapInEffect &&
        labeledStmt.length > 0 &&
        !_structuredNodeHasEarlyExit(node.statement, { ignoreBreakLabel: node.label })
      ) {
        const effectFn = t.arrowFunctionExpression([], t.blockStatement(labeledStmt))
        return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
      }
      return labeledStmt
    }

    case 'block': {
      const stmts: BabelCore.types.Statement[] = []
      const scopedDeclared = new Set(declaredVars)
      const blockBindings = collectDirectBlockBindingNames(node.statements, t)
      withShadowedBindings(ctx, blockBindings, () => {
        for (const child of node.statements) {
          stmts.push(
            ...lowerStructuredNodeForRegion(
              child,
              region,
              t,
              ctx,
              scopedDeclared,
              regionCtx,
              skipInstructions,
            ),
          )
        }
      })
      if (stmts.length === 0) return []
      return [t.blockStatement(stmts)]
    }

    case 'instruction': {
      if (skipInstructions?.has(node.instruction)) return []
      if (regionCtx?.hoistedInstructions.has(node.instruction)) return []
      const owner = findRegionForInstruction(node.instruction, regionCtx)
      if (!owner) {
        if (!regionCtx?.inlineUnownedInRegionBody) return []
        const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
        return stmt ? [stmt] : []
      }
      if (
        owner.id !== region.id &&
        regionCtx?.inlineUnownedInRegionBody &&
        node.instruction.kind === 'Expression' &&
        owner.declarations.size === 0
      ) {
        const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
        return stmt ? [stmt] : []
      }
      if (owner.id !== region.id) return []
      const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
      return stmt ? [stmt] : []
    }

    case 'if': {
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const controlFlowState = regionCtx ? analyzeControlFlowRegion(node, regionCtx) : undefined
      const shouldInlineUnownedInstructions =
        regionCtx?.inlineUnownedInRegionBody === true ||
        (controlFlowState?.hasUnownedInstructions === true &&
          ((controlFlowState.region !== undefined &&
            controlFlowState.partialRegionIds.size === 0) ||
            controlFlowState.partialRegionIds.size <= 1))
      const childRegionCtx =
        shouldInlineUnownedInstructions && regionCtx && !regionCtx.inlineUnownedInRegionBody
          ? { ...regionCtx, inlineUnownedInRegionBody: true }
          : regionCtx
      // fix: Pre-compute whether we *might* wrap this if in an effect BEFORE lowering children.
      // We check most conditions but NOT early exit (that requires the built statement).
      // If we might wrap in effect, process children with forceNonReactive=true to prevent nested effects.
      const mightWrapInEffect =
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        expressionUsesTracked(node.test, ctx)

      const prevConditional = ctx.inConditional ?? 0
      ctx.inConditional = prevConditional + 1

      const lowerChild = (
        child: StructuredNode | null | undefined,
        forceNonReactive: boolean,
      ): BabelCore.types.Statement[] => {
        if (!child) return []
        const scopedDeclared = new Set(declaredVars)
        const branchBindings = collectDirectStructuredBindingNames(child, t)
        return withShadowedBindings(ctx, branchBindings, () => {
          if (!forceNonReactive) {
            return lowerStructuredNodeForRegion(
              child,
              region,
              t,
              ctx,
              scopedDeclared,
              childRegionCtx,
              skipInstructions,
            )
          }
          const prevDepth = ctx.nonReactiveScopeDepth ?? 0
          ctx.nonReactiveScopeDepth = prevDepth + 1
          try {
            return lowerStructuredNodeForRegion(
              child,
              region,
              t,
              ctx,
              scopedDeclared,
              childRegionCtx,
              skipInstructions,
            )
          } finally {
            ctx.nonReactiveScopeDepth = prevDepth
          }
        })
      }

      let consequent: BabelCore.types.Statement[] = []
      let alternate: BabelCore.types.Statement[] = []
      try {
        // Lower children with forceNonReactive=true if we might wrap in effect
        consequent = lowerChild(
          node.consequent,
          mightWrapInEffect || shouldInlineUnownedInstructions,
        )
        alternate = node.alternate
          ? lowerChild(node.alternate, mightWrapInEffect || shouldInlineUnownedInstructions)
          : []
      } finally {
        ctx.inConditional = prevConditional
      }
      if (consequent.length === 0 && alternate.length === 0) return []
      const buildIfStmt = (
        cons: BabelCore.types.Statement[],
        alt: BabelCore.types.Statement[],
      ): BabelCore.types.IfStatement =>
        t.ifStatement(
          lowerExpressionWithDeSSA(node.test, ctx),
          t.blockStatement(cons),
          alt.length > 0 ? t.blockStatement(alt) : null,
        )

      let ifStmt = buildIfStmt(consequent, alternate)
      // Final check: only wrap in effect if no early exit (after lowering to check the statement)
      const hasEarlyExit = statementHasEarlyExit(ifStmt, t)
      const shouldWrapEffect = mightWrapInEffect && !hasEarlyExit

      // fix: When there's an early exit (createConditional case), DON'T re-lower without
      // the non-reactive guard. The children will be inside a createConditional callback which
      // is already reactive, so they don't need to be wrapped in effects themselves.
      // Only re-lower without the guard if there's no early exit AND we won't wrap in effect.
      if (!shouldWrapEffect && mightWrapInEffect && !hasEarlyExit) {
        // Re-lower without the non-reactive guard to preserve previous behavior
        consequent = lowerChild(node.consequent, shouldInlineUnownedInstructions)
        alternate = node.alternate
          ? lowerChild(node.alternate, shouldInlineUnownedInstructions)
          : []
        if (consequent.length === 0 && alternate.length === 0) return []
        ifStmt = buildIfStmt(consequent, alternate)
      }

      if (shouldWrapEffect) {
        const effectFn = t.arrowFunctionExpression([], t.blockStatement([ifStmt]))
        return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
      }
      return [ifStmt]
    }

    case 'while': {
      const shouldWrap = shouldWrapTrackedControlInEffect(node.test, ctx)
      const scopedDeclared = new Set(declaredVars)
      const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
      const body = withShadowedBindings(ctx, bodyBindings, () =>
        withTrackedControlEffectScope(ctx, shouldWrap, () =>
          lowerStructuredNodeForRegion(
            node.body,
            region,
            t,
            ctx,
            scopedDeclared,
            regionCtx,
            skipInstructions,
          ),
        ),
      )
      const stmt = t.whileStatement(
        lowerExpressionWithDeSSA(node.test, ctx),
        t.blockStatement(body),
      )
      return wrapTrackedControlStatement(stmt, shouldWrap, ctx, t)
    }

    case 'doWhile': {
      const shouldWrap = shouldWrapTrackedControlInEffect(node.test, ctx)
      const scopedDeclared = new Set(declaredVars)
      const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
      const body = withShadowedBindings(ctx, bodyBindings, () =>
        withTrackedControlEffectScope(ctx, shouldWrap, () =>
          lowerStructuredNodeForRegion(
            node.body,
            region,
            t,
            ctx,
            scopedDeclared,
            regionCtx,
            skipInstructions,
          ),
        ),
      )
      const stmt = t.doWhileStatement(
        lowerExpressionWithDeSSA(node.test, ctx),
        t.blockStatement(body),
      )
      return wrapTrackedControlStatement(stmt, shouldWrap, ctx, t)
    }

    case 'for': {
      const forBindings = new Set<string>()
      node.init?.forEach(instr => {
        if (instr.kind === 'Assign' && instr.declarationKind) {
          forBindings.add(deSSAVarName(instr.target.name))
        }
      })
      let body: BabelCore.types.Statement[] = []
      let init: BabelCore.types.VariableDeclaration | BabelCore.types.Expression | null = null
      let test: BabelCore.types.Expression | null = null
      let update: BabelCore.types.Expression | null = null
      withShadowedBindings(ctx, forBindings, () => {
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        body = withShadowedBindings(ctx, bodyBindings, () =>
          lowerStructuredNodeForRegion(
            node.body,
            region,
            t,
            ctx,
            bodyDeclared,
            regionCtx,
            skipInstructions,
          ),
        )
        init =
          node.init && node.init.length > 0 ? lowerInstructionsToInitExpr(node.init, t, ctx) : null
        test = node.test ? lowerExpressionWithDeSSA(node.test, ctx) : null
        update =
          node.update && node.update.length > 0
            ? lowerInstructionsToUpdateExpr(node.update, t, ctx)
            : null
      })
      return [t.forStatement(init, test, update, t.blockStatement(body))]
    }

    case 'forOf': {
      const bindingNames = new Set<string>()
      const leftPattern = node.pattern
        ? (node.pattern as BabelCore.types.LVal)
        : t.identifier(deSSAVarName(node.variable))
      const isAssignmentTarget = node.leftKind === 'assignment' && !node.pattern
      let body: BabelCore.types.Statement[] = []
      const lowerBody = () => {
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        body = withShadowedBindings(ctx, bodyBindings, () =>
          lowerStructuredNodeForRegion(
            node.body,
            region,
            t,
            ctx,
            bodyDeclared,
            regionCtx,
            skipInstructions,
          ),
        )
      }
      if (isAssignmentTarget) {
        lowerBody()
      } else {
        collectPatternBindingNames(leftPattern, t, bindingNames)
        withShadowedBindings(ctx, bindingNames, lowerBody)
      }
      const varKind = node.variableKind ?? 'const'
      const right = lowerExpressionWithDeSSA(node.iterable, ctx)
      const targetName = deSSAVarName(node.variable)
      if (isAssignmentTarget && node.assignmentTarget) {
        return [
          t.forOfStatement(
            lowerLoopAssignmentTargetWithDeSSA(node.assignmentTarget, ctx),
            right,
            t.blockStatement(body),
            !!node.await,
          ),
        ]
      }
      if (isAssignmentTarget && ctx.trackedVars.has(targetName)) {
        const valueId = t.identifier(`__forOf_${ctx.tempCounter++}`)
        return [
          t.forOfStatement(
            t.variableDeclaration('const', [t.variableDeclarator(valueId)]),
            right,
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.identifier(targetName), [t.identifier(valueId.name)]),
              ),
              ...body,
            ]),
            !!node.await,
          ),
        ]
      }
      if (isAssignmentTarget) {
        return [
          t.forOfStatement(t.identifier(targetName), right, t.blockStatement(body), !!node.await),
        ]
      }
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      return [t.forOfStatement(left, right, t.blockStatement(body), !!node.await)]
    }

    case 'forIn': {
      const leftPattern = node.pattern
        ? (node.pattern as BabelCore.types.LVal)
        : t.identifier(deSSAVarName(node.variable))
      const bindingNames = new Set<string>()
      const isAssignmentTarget = node.leftKind === 'assignment' && !node.pattern
      let body: BabelCore.types.Statement[] = []
      const lowerBody = () => {
        const bodyDeclared = new Set(declaredVars)
        const bodyBindings = collectDirectStructuredBindingNames(node.body, t)
        body = withShadowedBindings(ctx, bodyBindings, () =>
          lowerStructuredNodeForRegion(
            node.body,
            region,
            t,
            ctx,
            bodyDeclared,
            regionCtx,
            skipInstructions,
          ),
        )
      }
      if (isAssignmentTarget) {
        lowerBody()
      } else {
        collectPatternBindingNames(leftPattern, t, bindingNames)
        withShadowedBindings(ctx, bindingNames, lowerBody)
      }
      const varKind = node.variableKind ?? 'const'
      const right = lowerExpressionWithDeSSA(node.object, ctx)
      const targetName = deSSAVarName(node.variable)
      if (isAssignmentTarget && node.assignmentTarget) {
        return [
          t.forInStatement(
            lowerLoopAssignmentTargetWithDeSSA(node.assignmentTarget, ctx),
            right,
            t.blockStatement(body),
          ),
        ]
      }
      if (isAssignmentTarget && ctx.trackedVars.has(targetName)) {
        const valueId = t.identifier(`__forIn_${ctx.tempCounter++}`)
        return [
          t.forInStatement(
            t.variableDeclaration('const', [t.variableDeclarator(valueId)]),
            right,
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.identifier(targetName), [t.identifier(valueId.name)]),
              ),
              ...body,
            ]),
          ),
        ]
      }
      if (isAssignmentTarget) {
        return [t.forInStatement(t.identifier(targetName), right, t.blockStatement(body))]
      }
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      return [t.forInStatement(left, right, t.blockStatement(body))]
    }

    case 'switch': {
      const prevConditional = ctx.inConditional ?? 0
      ctx.inConditional = prevConditional + 1
      let cases: BabelCore.types.SwitchCase[]
      try {
        cases = node.cases
          .map(c => {
            const caseDeclared = new Set(declaredVars)
            const caseBindings = collectDirectStructuredBindingNames(c.body, t)
            const stmts = ensureSwitchCaseBreak(
              withShadowedBindings(ctx, caseBindings, () =>
                lowerStructuredNodeForRegion(
                  c.body,
                  region,
                  t,
                  ctx,
                  caseDeclared,
                  regionCtx,
                  skipInstructions,
                ),
              ),
              t,
              c.fallsThrough === true,
            )
            if (stmts.length === 0) return null
            return t.switchCase(c.test ? lowerExpressionWithDeSSA(c.test, ctx) : null, stmts)
          })
          .filter((c): c is BabelCore.types.SwitchCase => !!c)
      } finally {
        ctx.inConditional = prevConditional
      }
      if (cases.length === 0) return []
      return [t.switchStatement(lowerExpressionWithDeSSA(node.discriminant, ctx), cases)]
    }

    case 'try': {
      const executableRegionCtx = regionCtx
        ? { ...regionCtx, inlineUnownedInRegionBody: true }
        : regionCtx
      const lowerExecutableChild = (
        child: StructuredNode,
        extraBindings: Iterable<string> = [],
      ): BabelCore.types.Statement[] => {
        const scopedDeclared = new Set(declaredVars)
        const childBindings = collectDirectStructuredBindingNames(child, t)
        for (const binding of extraBindings) {
          childBindings.add(binding)
        }
        return withShadowedBindings(ctx, childBindings, () =>
          withTrackedControlEffectScope(ctx, true, () =>
            lowerStructuredNodeForRegion(
              child,
              region,
              t,
              ctx,
              scopedDeclared,
              executableRegionCtx,
              skipInstructions,
            ),
          ),
        )
      }
      const blockStmts = lowerExecutableChild(node.block)
      let handlerStmts: BabelCore.types.Statement[] = []
      if (node.handler) {
        const handlerBindings = collectStructuredCatchBindingNames(node.handler, t)
        handlerStmts = lowerExecutableChild(node.handler.body, handlerBindings)
      }
      const finalizerStmts = node.finalizer ? lowerExecutableChild(node.finalizer) : []
      const handler = node.handler
        ? t.catchClause(lowerStructuredCatchParam(node.handler, t), t.blockStatement(handlerStmts))
        : null
      const finalizer = node.finalizer ? t.blockStatement(finalizerStmts) : null
      return [t.tryStatement(t.blockStatement(blockStmts), handler, finalizer)]
    }

    case 'break':
      return [t.breakStatement(node.label ? t.identifier(node.label) : null)]

    case 'continue':
      return [t.continueStatement(node.label ? t.identifier(node.label) : null)]

    case 'return':
      return []

    case 'throw':
      return [t.throwStatement(lowerExpressionWithDeSSA(node.argument, ctx))]

    case 'stateMachine':
    default:
      return []
  }
}

/**
 * Find the region an instruction belongs to
 */
function findRegionForInstruction(
  instr: Instruction,
  regionCtx?: RegionEmitContext,
): Region | undefined {
  if (!regionCtx) return undefined

  for (const region of regionCtx.regionResult.regions) {
    for (const regionInstr of region.instructions) {
      if (instructionsMatch(instr, regionInstr)) {
        return region
      }
    }
  }
  return undefined
}

function analyzeControlFlowRegion(
  node: StructuredNode,
  regionCtx?: RegionEmitContext,
): ControlFlowRegionState {
  if (!regionCtx || node.kind === 'instruction') {
    return { partialRegionIds: new Set() }
  }

  const regionIds = new Set<number>()
  let sawInstruction = false
  let hasUnownedInstruction = false
  const ownedInstructionsByRegion = new Map<number, Instruction[]>()

  const visit = (current: StructuredNode): void => {
    switch (current.kind) {
      case 'instruction': {
        sawInstruction = true
        if (current.instruction.kind === 'Expression') {
          hasUnownedInstruction = true
          return
        }
        const owner = findRegionForInstruction(current.instruction, regionCtx)
        if (!owner) {
          hasUnownedInstruction = true
          return
        }
        regionIds.add(owner.id)
        const existing = ownedInstructionsByRegion.get(owner.id) ?? []
        existing.push(current.instruction)
        ownedInstructionsByRegion.set(owner.id, existing)
        return
      }
      case 'sequence':
        current.nodes.forEach(visit)
        return
      case 'block':
        current.statements.forEach(visit)
        return
      case 'labeled':
        visit(current.statement)
        return
      case 'if':
        visit(current.consequent)
        if (current.alternate) visit(current.alternate)
        return
      case 'while':
      case 'doWhile':
      case 'for':
      case 'forOf':
      case 'forIn':
        visit(current.body)
        return
      case 'switch':
        current.cases.forEach(c => visit(c.body))
        return
      case 'try':
        visit(current.block)
        if (current.handler) visit(current.handler.body)
        if (current.finalizer) visit(current.finalizer)
        return
      default:
        return
    }
  }

  visit(node)

  if (!sawInstruction || regionIds.size === 0) {
    return { partialRegionIds: new Set() }
  }

  if (hasUnownedInstruction) {
    if (regionIds.size === 1) {
      const [regionId] = Array.from(regionIds)
      return {
        region: regionCtx.regionResult.regions.find(
          region => region.id === regionId && region.hasControlFlow,
        ),
        partialRegionIds: new Set(regionIds),
        hasUnownedInstructions: true,
        ownedInstructionsByRegion,
      }
    }
    return {
      partialRegionIds: new Set(regionIds),
      hasUnownedInstructions: true,
      ownedInstructionsByRegion,
    }
  }

  if (regionIds.size !== 1) {
    return { partialRegionIds: new Set(), ownedInstructionsByRegion }
  }

  const [regionId] = Array.from(regionIds)
  return {
    region: regionCtx.regionResult.regions.find(
      region => region.id === regionId && region.hasControlFlow,
    ),
    partialRegionIds: new Set(),
    ownedInstructionsByRegion,
  }
}

function allOwnedControlFlowRegionsAreHandled(
  state: ControlFlowRegionState,
  regionCtx?: RegionEmitContext,
): boolean {
  if (!regionCtx || state.hasUnownedInstructions) return false
  const ownedRegionIds = Array.from(state.ownedInstructionsByRegion?.keys() ?? [])
  if (ownedRegionIds.length === 0) return false

  return ownedRegionIds.every(id => {
    const region = regionCtx.regionResult.regions.find(candidate => candidate.id === id)
    if (!region?.shouldMemoize) return false
    return regionCtx.emittedRegions.has(id)
  })
}

function assignmentExpressionTargetName(expr: Expression): string | null {
  if (expr.kind !== 'AssignmentExpression') return null
  return expr.left.kind === 'Identifier' ? deSSAVarName(expr.left.name) : null
}

function instructionWritesHandledRegionOutput(
  instr: Instruction,
  regionCtx?: RegionEmitContext,
): boolean {
  if (!regionCtx) return false
  const target =
    instr.kind === 'Assign'
      ? deSSAVarName(instr.target.name)
      : instr.kind === 'Expression'
        ? assignmentExpressionTargetName(instr.value)
        : null
  if (!target) return false

  return regionCtx.regionResult.regions.some(
    region =>
      region.shouldMemoize &&
      regionCtx.emittedRegions.has(region.id) &&
      Array.from(region.declarations).some(declaration => deSSAVarName(declaration) === target),
  )
}

/**
 * Check if two instructions are the same
 */
function instructionsMatch(a: Instruction, b: Instruction): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'Assign' && b.kind === 'Assign') {
    return a.target.name === b.target.name
  }
  // For expressions, compare by reference or structure
  return a === b
}

function expressionHasOrderingEffects(expr: Expression): boolean {
  switch (expr.kind) {
    case 'Identifier':
    case 'Literal':
    case 'MetaProperty':
    case 'ThisExpression':
    case 'SuperExpression':
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'ImportExpression':
    case 'NewExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
    case 'ClassExpression':
    case 'JSXElement':
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'SpreadElement':
      return true
    case 'BinaryExpression':
    case 'LogicalExpression':
      return expressionHasOrderingEffects(expr.left) || expressionHasOrderingEffects(expr.right)
    case 'UnaryExpression':
      return expr.operator === 'delete' || expressionHasOrderingEffects(expr.argument)
    case 'ConditionalExpression':
      return (
        expressionHasOrderingEffects(expr.test) ||
        expressionHasOrderingEffects(expr.consequent) ||
        expressionHasOrderingEffects(expr.alternate)
      )
    case 'ArrayExpression':
      return expr.elements.some(element =>
        element ? expressionHasOrderingEffects(element) : false,
      )
    case 'ObjectExpression':
      return expr.properties.some(prop =>
        prop.kind === 'SpreadElement'
          ? true
          : (prop.computed && expressionHasOrderingEffects(prop.key)) ||
            expressionHasOrderingEffects(prop.value),
      )
    case 'TemplateLiteral':
      return expr.expressions.some(part => expressionHasOrderingEffects(part))
    case 'SequenceExpression':
      return expr.expressions.some(part => expressionHasOrderingEffects(part))
  }
}

function instructionHasOrderingEffects(instr: Instruction): boolean {
  if (instr.kind === 'Debugger') return true
  if (instr.kind === 'Phi') return false
  if (instr.kind === 'Expression') return expressionHasOrderingEffects(instr.value)
  if (!instr.declarationKind) return true
  if (instr.declarationKind === 'function') return false
  return expressionHasOrderingEffects(instr.value)
}

function collectOrderingBarrierRegionIds(
  buffer: { instr: Instruction; region?: Region | undefined }[],
): Set<number> {
  const disabled = new Set<number>()
  const ranges = new Map<number, { first: number; last: number }>()

  buffer.forEach((item, index) => {
    const region = item.region
    if (!region || region.hasControlFlow) return
    const range = ranges.get(region.id)
    if (range) {
      range.last = index
    } else {
      ranges.set(region.id, { first: index, last: index })
    }
  })

  if (ranges.size === 0) return disabled

  buffer.forEach((item, index) => {
    if (item.instr.kind !== 'Expression' || !instructionHasOrderingEffects(item.instr)) return
    for (const [id, range] of ranges) {
      if (index <= range.first || index >= range.last) continue
      if (item.region?.id === id) continue
      disabled.add(id)
    }
  })

  return disabled
}

/**
 * Flush pending instructions, emitting regions as needed
 */
function flushInstructionBuffer(
  buffer: { instr: Instruction; region?: Region | undefined }[],
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
  regionCtx?: RegionEmitContext,
  suppressedRegionIds?: Set<number>,
  deferredRegionIds?: Set<number>,
  deferredInstructions?: Set<Instruction>,
): BabelCore.types.Statement[] {
  const stmts: BabelCore.types.Statement[] = []
  collectSnapshotInterruptedRegionIds(buffer).forEach(id => regionCtx?.disabledRegions.add(id))
  collectSignalWriteDeclarationBarrierRegionIds(buffer, ctx).forEach(id =>
    regionCtx?.disabledRegions.add(id),
  )
  collectOrderingBarrierRegionIds(buffer).forEach(id => regionCtx?.disabledRegions.add(id))

  for (const item of buffer) {
    if (regionCtx?.hoistedInstructions.has(item.instr)) {
      continue
    }
    if (deferredInstructions?.has(item.instr)) {
      continue
    }
    if (item.region && regionRequiresEagerDerivedLowering(item.region, ctx)) {
      regionCtx?.disabledRegions.add(item.region.id)
    }
    if (item.region && deferredRegionIds?.has(item.region.id)) {
      continue
    }
    if (
      item.region &&
      !suppressedRegionIds?.has(item.region.id) &&
      !regionCtx?.disabledRegions.has(item.region.id)
    ) {
      if (regionCtx?.emittedRegions.has(item.region.id)) {
        continue
      }
      regionCtx?.emittedRegions.add(item.region.id)
      stmts.push(...generateRegionStatements(item.region, t, declaredVars, ctx, regionCtx))
      continue
    }

    if (instructionWritesHandledRegionOutput(item.instr, regionCtx)) {
      continue
    }

    const stmt = instructionToStatement(item.instr, t, declaredVars, ctx)
    if (stmt) stmts.push(stmt)
  }

  return stmts
}

function collectSignalWriteDeclarationBarrierRegionIds(
  buffer: { instr: Instruction; region?: Region | undefined }[],
  ctx: CodegenContext,
): Set<number> {
  const disabled = new Set<number>()
  const signalNames = new Set<string>(ctx.signalVars ?? [])
  const priorDeclarations = new Map<string, { index: number; region?: Region | undefined }>()

  for (let index = 0; index < buffer.length; index++) {
    const item = buffer[index]
    const instr = item?.instr
    if (!instr) continue

    if (instr.kind === 'Assign' && instr.declarationKind) {
      const name = deSSAVarName(instr.target.name)
      priorDeclarations.set(name, { index, region: item.region })
      if (getReactiveCallKind(instr.value, ctx) === 'signal') {
        signalNames.add(name)
      }
      continue
    }

    if (
      item.region &&
      instr.kind === 'Expression' &&
      (isComputedMemberMutation(instr.value) || expressionUsesTracked(instr.value, ctx))
    ) {
      for (const dep of collectInstructionDependencies(instr)) {
        const depName = deSSAVarName(dep)
        const declaration = priorDeclarations.get(depName)
        if (!declaration || declaration.index >= index) continue
        if (declaration.region?.id === item.region.id) continue
        disabled.add(item.region.id)
      }
      continue
    }

    if (!item.region || instr.kind !== 'Assign' || instr.declarationKind) continue

    const targetName = deSSAVarName(instr.target.name)
    if (!signalNames.has(targetName)) continue

    for (const dep of collectInstructionDependencies(instr)) {
      const depName = deSSAVarName(dep)
      if (depName === targetName) continue
      const declaration = priorDeclarations.get(depName)
      if (!declaration || declaration.index >= index) continue
      if (declaration.region?.id === item.region.id) continue
      disabled.add(item.region.id)
    }
  }

  return disabled
}

function isComputedMemberMutation(expr: Expression): boolean {
  if (expr.kind === 'AssignmentExpression') {
    return (
      (expr.left.kind === 'MemberExpression' || expr.left.kind === 'OptionalMemberExpression') &&
      expr.left.computed === true
    )
  }
  if (expr.kind === 'UpdateExpression') {
    return (
      (expr.argument.kind === 'MemberExpression' ||
        expr.argument.kind === 'OptionalMemberExpression') &&
      expr.argument.computed === true
    )
  }
  return false
}

function collectSnapshotInterruptedRegionIds(
  buffer: { instr: Instruction; region?: Region | undefined }[],
): Set<number> {
  const disabled = new Set<number>()

  for (let start = 0; start < buffer.length; start++) {
    const startItem = buffer[start]
    const region = startItem?.region
    const instr = startItem?.instr
    if (!region || !instr || instr.kind !== 'Assign' || !instr.declarationKind) continue

    const name = deSSAVarName(instr.target.name)
    const regionDeclarations = new Set(Array.from(region.declarations, dep => deSSAVarName(dep)))
    if (!regionDeclarations.has(name)) continue

    for (let end = start + 1; end < buffer.length; end++) {
      const endItem = buffer[end]
      if (endItem?.region?.id !== region.id || !endItem.instr) continue
      if (!collectInstructionWrites(endItem.instr).has(name)) continue

      for (let between = start + 1; between < end; between++) {
        const betweenItem = buffer[between]
        if (!betweenItem?.instr || betweenItem.region?.id === region.id) continue
        if (!collectInstructionDependencies(betweenItem.instr).has(name)) continue

        disabled.add(region.id)
        if (betweenItem.region) disabled.add(betweenItem.region.id)
      }
    }
  }

  return disabled
}

/**
 * Lower instructions to a for-loop initializer
 */
function lowerInstructionsToInitExpr(
  instrs: Instruction[],
  t: typeof BabelCore.types,
  ctx: CodegenContext,
): BabelCore.types.VariableDeclaration | BabelCore.types.Expression | null {
  if (instrs.length === 0) return null

  // Check if all are assignments - can use VariableDeclaration
  const allAssigns = instrs.every(i => i.kind === 'Assign')
  if (allAssigns) {
    const decls = instrs.map(i => {
      if (i.kind === 'Assign') {
        const hookMember = resolveHookMemberValue(i.value, ctx)
        const base = deSSAVarName(i.target.name)
        if (hookMember) {
          if (hookMember.kind === 'signal') {
            ctx.signalVars?.add(base)
            ctx.trackedVars.add(base)
          } else if (hookMember.kind === 'memo') {
            ctx.memoVars?.add(base)
          } else if (hookMember.kind === 'store') {
            ctx.storeVars?.add(base)
            ctx.trackedVars.add(base)
          }
        }
        return t.variableDeclarator(
          t.identifier(deSSAVarName(i.target.name)),
          hookMember ? hookMember.member : lowerExpression(i.value, ctx),
        )
      }
      return t.variableDeclarator(t.identifier('_'))
    })
    const firstDeclKind =
      instrs[0]?.kind === 'Assign' && instrs[0].declarationKind !== 'function'
        ? instrs[0].declarationKind
        : undefined
    const declKind =
      firstDeclKind && instrs.every(i => i.kind === 'Assign' && i.declarationKind === firstDeclKind)
        ? firstDeclKind
        : 'let'
    return t.variableDeclaration(declKind, decls)
  }

  // Otherwise use sequence expression
  const exprs = instrs.map(i => {
    if (i.kind === 'Assign') {
      const hookMember = resolveHookMemberValue(i.value, ctx)
      const base = deSSAVarName(i.target.name)
      if (hookMember) {
        if (hookMember.kind === 'signal') {
          ctx.signalVars?.add(base)
          ctx.trackedVars.add(base)
        } else if (hookMember.kind === 'memo') {
          ctx.memoVars?.add(base)
        } else if (hookMember.kind === 'store') {
          ctx.storeVars?.add(base)
          ctx.trackedVars.add(base)
        }
      }
      return t.assignmentExpression(
        '=',
        t.identifier(base),
        hookMember ? hookMember.member : lowerExpression(i.value, ctx),
      )
    }
    if (i.kind === 'Expression') {
      return lowerExpression(i.value, ctx)
    }
    return voidZero(t)
  })

  if (exprs.length === 1 && exprs[0]) {
    return exprs[0]
  }
  return t.sequenceExpression(exprs)
}

/**
 * Lower instructions to a for-loop update expression
 */
function lowerInstructionsToUpdateExpr(
  instrs: Instruction[],
  t: typeof BabelCore.types,
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  if (instrs.length === 0) return null

  const exprs = instrs.map(i => {
    if (i.kind === 'Assign') {
      return t.assignmentExpression(
        '=',
        t.identifier(deSSAVarName(i.target.name)),
        lowerExpression(i.value, ctx),
      )
    }
    if (i.kind === 'Expression') {
      return lowerExpression(i.value, ctx)
    }
    return voidZero(t)
  })

  if (exprs.length === 1 && exprs[0]) {
    return exprs[0]
  }
  return t.sequenceExpression(exprs)
}

function statementHasEarlyExit(
  stmt: BabelCore.types.Statement,
  t: typeof BabelCore.types,
): boolean {
  if (
    t.isReturnStatement(stmt) ||
    t.isThrowStatement(stmt) ||
    t.isBreakStatement(stmt) ||
    t.isContinueStatement(stmt)
  ) {
    return true
  }

  if (t.isIfStatement(stmt)) {
    return (
      (stmt.consequent ? statementHasEarlyExit(stmt.consequent, t) : false) ||
      (stmt.alternate ? statementHasEarlyExit(stmt.alternate, t) : false)
    )
  }

  if (t.isBlockStatement(stmt)) {
    return stmt.body.some(child => statementHasEarlyExit(child, t))
  }

  return false
}

/**
 * Check if a StructuredNode contains an early exit (return, throw, break, continue).
 * This is used to determine if we should wrap an if statement in an effect
 * BEFORE lowering its children.
 */
function _structuredNodeHasEarlyExit(
  node: StructuredNode | null | undefined,
  options?: { ignoreBreak?: boolean; ignoreBreakLabel?: string },
): boolean {
  if (!node) return false

  switch (node.kind) {
    case 'return':
    case 'throw':
    case 'continue':
      return true
    case 'break':
      return !(
        options?.ignoreBreak === true ||
        (options?.ignoreBreakLabel !== undefined && node.label === options.ignoreBreakLabel)
      )

    case 'block':
      return node.statements.some(stmt => _structuredNodeHasEarlyExit(stmt, options))

    case 'sequence':
      return node.nodes.some(n => _structuredNodeHasEarlyExit(n, options))

    case 'labeled':
      return _structuredNodeHasEarlyExit(node.statement, {
        ...options,
        ignoreBreakLabel: node.label,
      })

    case 'if':
      return (
        _structuredNodeHasEarlyExit(node.consequent, options) ||
        _structuredNodeHasEarlyExit(node.alternate, options)
      )

    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
      return _structuredNodeHasEarlyExit(node.body)

    case 'switch':
      // `break` is the normal terminator for a switch case and should not disable
      // region lowering for a trailing return that consumes case-assigned locals.
      return node.cases.some(c => _structuredNodeHasEarlyExit(c.body, { ignoreBreak: true }))

    case 'try':
      return (
        _structuredNodeHasEarlyExit(node.block, options) ||
        _structuredNodeHasEarlyExit(node.handler?.body, options) ||
        _structuredNodeHasEarlyExit(node.finalizer, options)
      )

    default:
      return false
  }
}

function _structuredNodeHasReturnOrThrow(node: StructuredNode | null | undefined): boolean {
  if (!node) return false

  switch (node.kind) {
    case 'return':
    case 'throw':
      return true

    case 'block':
      return node.statements.some(stmt => _structuredNodeHasReturnOrThrow(stmt))

    case 'sequence':
      return node.nodes.some(child => _structuredNodeHasReturnOrThrow(child))

    case 'labeled':
      return _structuredNodeHasReturnOrThrow(node.statement)

    case 'if':
      return (
        _structuredNodeHasReturnOrThrow(node.consequent) ||
        _structuredNodeHasReturnOrThrow(node.alternate)
      )

    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
      return _structuredNodeHasReturnOrThrow(node.body)

    case 'switch':
      return node.cases.some(c => _structuredNodeHasReturnOrThrow(c.body))

    case 'try':
      return (
        _structuredNodeHasReturnOrThrow(node.block) ||
        _structuredNodeHasReturnOrThrow(node.handler?.body) ||
        _structuredNodeHasReturnOrThrow(node.finalizer)
      )

    default:
      return false
  }
}

/**
 * Remove SSA version suffix from variable name.
 * Exported for use in codegen.ts and other modules that need SSA de-versioning.
 * Uses the centralized SSA naming utilities from hir.ts.
 */
export function deSSAVarName(name: string): string {
  return getSSABaseName(name)
}

/**
 * Generate statements for a single region
 */
function generateRegionStatements(
  region: Region,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
  regionCtx?: RegionEmitContext,
  prefixInstructions?: Instruction[],
): BabelCore.types.Statement[] {
  const statements: BabelCore.types.Statement[] = []
  const regionInfo = {
    id: region.id,
    dependencies: new Set(Array.from(region.dependencies).map(d => deSSAVarName(d))),
    declarations: new Set(Array.from(region.declarations).map(d => deSSAVarName(d))),
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: region.declarations.size > 0,
  }
  const prevRegion = applyRegionToContext(ctx, regionInfo)

  const hasTrackedOutputs =
    region.hasControlFlow &&
    Array.from(region.declarations).some(name => ctx.trackedVars.has(deSSAVarName(name)))
  const postRegionWrites = regionCtx
    ? collectPostRegionWrites(regionCtx.fullRootNode, region)
    : new Set<string>()
  const shouldInline =
    (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) ||
    ctx.noMemo ||
    region.hasAsyncSyntax ||
    !region.shouldMemoize ||
    (region.dependencies.size === 0 && !hasTrackedOutputs)

  const hoistedStatements: BabelCore.types.Statement[] = []
  const memoInstructions: Instruction[] = []
  const memoDeclarations = new Set(region.declarations)
  const hoistedInstructionSet = new Set<Instruction>()
  const instructionIndexes = new Map<Instruction, number>()
  const declarationByName = new Map<string, Instruction>()
  region.instructions.forEach((instr, index) => {
    if (regionCtx?.hoistedInstructions.has(instr)) return
    instructionIndexes.set(instr, index)
    if (instr.kind === 'Assign' && instr.declarationKind) {
      declarationByName.set(deSSAVarName(instr.target.name), instr)
    }
  })
  const controlFlowLocalDeclarations = regionCtx
    ? collectControlFlowLocalRegionDeclarations(regionCtx.rootNode, region, regionCtx, t)
    : new Set<string>()
  if (controlFlowLocalDeclarations.size > 0) {
    for (const declaration of Array.from(memoDeclarations)) {
      if (controlFlowLocalDeclarations.has(deSSAVarName(declaration))) {
        memoDeclarations.delete(declaration)
      }
    }
  }
  const emitHoistedInstruction = (instr: Instruction): void => {
    if (hoistedInstructionSet.has(instr)) return
    if (regionCtx?.hoistedInstructions.has(instr)) return
    const stmt = instructionToStatement(instr, t, declaredVars, ctx)
    if (stmt) hoistedStatements.push(stmt)
    hoistedInstructionSet.add(instr)
    regionCtx?.hoistedInstructions.add(instr)
    if (instr.kind === 'Assign') {
      memoDeclarations.delete(instr.target.name)
    }
  }
  const hoistMutableSnapshotDeclarations = (instr: AssignInstruction, deps: string[]): void => {
    if (!regionCtx) return
    for (const dep of deps) {
      if (declaredVars.has(dep)) continue
      const declaration = findPriorDeclarationInstruction(regionCtx.rootNode, dep, instr)
      if (!declaration || declaration === instr) continue
      emitHoistedInstruction(declaration)
    }
  }
  const hoistPriorLocalDependencies = (
    expr: Expression,
    beforeIndex: number,
    visiting = new Set<Instruction>(),
  ): void => {
    for (const dep of collectExprDependencies(expr)) {
      const producer = declarationByName.get(dep)
      if (!producer || hoistedInstructionSet.has(producer) || visiting.has(producer)) continue
      const producerIndex = instructionIndexes.get(producer)
      if (producerIndex === undefined || producerIndex >= beforeIndex) continue
      visiting.add(producer)
      if (producer.kind === 'Assign') {
        hoistPriorLocalDependencies(producer.value, producerIndex, visiting)
        emitHoistedInstruction(producer)
      }
      visiting.delete(producer)
    }
  }

  for (const instr of region.instructions) {
    if (regionCtx?.hoistedInstructions.has(instr)) {
      continue
    }
    if (instr.kind === 'Assign') {
      const baseName = deSSAVarName(instr.target.name)
      const mutableSnapshotDeps = collectMutableNonReactiveDependencies(instr.value, ctx, baseName)
      if (mutableSnapshotDeps.length > 0) {
        hoistMutableSnapshotDeclarations(instr, mutableSnapshotDeps)
      }
    }
    if (hoistedInstructionSet.has(instr)) {
      continue
    }
    if (instr.kind === 'Assign' && instr.preserveEagerEvaluation && !region.hasControlFlow) {
      const index = instructionIndexes.get(instr) ?? 0
      hoistPriorLocalDependencies(instr.value, index)
      emitHoistedInstruction(instr)
      continue
    }
    if (isReactiveCreationInstruction(instr)) {
      const index = instructionIndexes.get(instr) ?? 0
      instr.value.arguments.forEach(arg => hoistPriorLocalDependencies(arg, index))
      emitHoistedInstruction(instr)
      continue
    }
    memoInstructions.push(instr)
  }

  if (region.hasControlFlow && regionCtx?.rootNode) {
    const localDeclared = new Set<string>()
    const prevInRegionMemo = ctx.inRegionMemo
    const prevLocalValueVars = ctx.localValueVars
    if (!shouldInline) {
      ctx.inRegionMemo = true
      ctx.localValueVars = new Set(prevLocalValueVars ?? [])
    }
    const prefixStatements =
      prefixInstructions?.flatMap(instr => {
        if (hoistedInstructionSet.has(instr)) return []
        if (regionCtx?.hoistedInstructions.has(instr)) return []
        const stmt = instructionToStatement(instr, t, localDeclared, ctx)
        return stmt ? [stmt] : []
      }) ?? []
    const bodyStatements = lowerStructuredNodeForRegion(
      regionCtx.rootNode,
      region,
      t,
      ctx,
      localDeclared,
      regionCtx,
      hoistedInstructionSet.size > 0 ? hoistedInstructionSet : undefined,
    )
    ctx.inRegionMemo = prevInRegionMemo
    ctx.localValueVars = prevLocalValueVars
    if (shouldInline) {
      statements.push(...hoistedStatements)
      statements.push(...prefixStatements)
      statements.push(...bodyStatements)
    } else {
      const outputNamesOverride = Array.from(memoDeclarations).map(name => deSSAVarName(name))
      statements.push(...hoistedStatements)
      statements.push(
        ...wrapInMemo(
          region,
          t,
          declaredVars,
          ctx,
          [...prefixStatements, ...bodyStatements],
          outputNamesOverride,
          postRegionWrites,
        ),
      )
    }
  } else if (shouldInline) {
    // No memoization needed - just emit instructions directly
    statements.push(...hoistedStatements)
    for (const instr of memoInstructions) {
      const stmt = instructionToStatement(instr, t, declaredVars, ctx)
      if (stmt) statements.push(stmt)
    }
  } else {
    // Wrap in memo
    const outputNamesOverride = Array.from(memoDeclarations).map(name => deSSAVarName(name))
    let bodyStatementsOverride: BabelCore.types.Statement[] | undefined
    if (memoInstructions.length !== region.instructions.length) {
      const localDeclared = new Set<string>()
      bodyStatementsOverride = []
      const prevInRegionMemo = ctx.inRegionMemo
      const prevLocalValueVars = ctx.localValueVars
      ctx.inRegionMemo = true
      ctx.localValueVars = new Set(prevLocalValueVars ?? [])
      for (const instr of memoInstructions) {
        const stmt = instructionToStatement(instr, t, localDeclared, ctx)
        if (stmt) bodyStatementsOverride.push(stmt)
      }
      ctx.inRegionMemo = prevInRegionMemo
      ctx.localValueVars = prevLocalValueVars
    }
    statements.push(...hoistedStatements)
    const memoStatements = wrapInMemo(
      region,
      t,
      declaredVars,
      ctx,
      bodyStatementsOverride,
      outputNamesOverride,
      postRegionWrites,
    )
    statements.push(...memoStatements)
  }

  applyRegionToContext(ctx, prevRegion ?? null)
  return statements
}

/**
 * Wrap a region's instructions in a memo call
 */
function wrapInMemo(
  region: Region,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
  bodyStatementsOverride?: BabelCore.types.Statement[],
  outputNamesOverride?: string[],
  mutableGetterOutputs?: Set<string>,
): BabelCore.types.Statement[] {
  const statements: BabelCore.types.Statement[] = []
  const bodyStatements: BabelCore.types.Statement[] = []
  if (bodyStatementsOverride) {
    bodyStatements.push(...bodyStatementsOverride)
  } else {
    const localDeclared = new Set<string>()
    // Convert instructions to statements
    const prevInRegionMemo = ctx.inRegionMemo
    const prevLocalValueVars = ctx.localValueVars
    ctx.inRegionMemo = true
    ctx.localValueVars = new Set(prevLocalValueVars ?? [])
    for (const instr of region.instructions) {
      const stmt = instructionToStatement(instr, t, localDeclared, ctx)
      if (stmt) bodyStatements.push(stmt)
    }
    ctx.inRegionMemo = prevInRegionMemo
    ctx.localValueVars = prevLocalValueVars
  }

  // Build return object with declarations - de-version SSA names
  const outputNames =
    outputNamesOverride ?? Array.from(region.declarations).map(name => deSSAVarName(name))
  // Remove duplicates that may result from de-versioning (e.g., count_1 and count_2 both become count)
  const uniqueOutputNames = [...new Set(outputNames)]
  const mutablePropOutputs = uniqueOutputNames.filter(name => ctx.mutablePropVars?.has(name))
  const bindableOutputs = uniqueOutputNames.filter(
    name => !declaredVars.has(name) && !(ctx.mutablePropVars?.has(name) ?? false),
  )

  debugLog('region', `Region memo ${region.id}`, {
    instructions: region.instructions.map(instr => instr.kind),
    outputs: uniqueOutputNames,
  })

  if (uniqueOutputNames.length === 0) {
    // No outputs - just execute for side effects
    const effectFn = t.arrowFunctionExpression([], t.blockStatement(bodyStatements))
    const slot = ctx.inModule ? undefined : reserveHookSlot(ctx)
    const effectCall = buildEffectCall(ctx, t, effectFn, { slot })
    statements.push(t.expressionStatement(effectCall))
  } else {
    // Check for lazy conditional optimization (instruction-based only)
    if (!bodyStatementsOverride) {
      const lazyInfo = analyzeHIRConditionalUsage(region, ctx)
      if (lazyInfo) {
        // Generate lazy conditional memo
        return generateLazyConditionalMemo(
          region,
          uniqueOutputNames,
          bodyStatements,
          lazyInfo,
          t,
          declaredVars,
          ctx,
        )
      }
    }

    // Has outputs - memo with destructuring
    const buildOutputProperty = (name: string): BabelCore.types.ObjectProperty => {
      return regionOutputProperty(t, name, t.identifier(name), true)
    }
    const returnObj = t.objectExpression(uniqueOutputNames.map(name => buildOutputProperty(name)))

    const memoBody = t.blockStatement([...bodyStatements, t.returnStatement(returnObj)])

    const slot = ctx.inModule ? undefined : reserveHookSlot(ctx)
    const memoCall = buildMemoCall(ctx, t, t.arrowFunctionExpression([], memoBody), {
      slot,
      internal: true,
    })

    const regionVarName = reserveFunctionLocalName(ctx, `__region_${region.id}`)

    // Declare region variable
    statements.push(
      t.variableDeclaration('const', [t.variableDeclarator(t.identifier(regionVarName), memoCall)]),
    )

    const isAccessorOutput = (name: string) =>
      ctx.signalVars?.has(name) ||
      ctx.memoVars?.has(name) ||
      ctx.aliasVars?.has(name) ||
      ctx.storeVars?.has(name)

    const getterOutputs = bindableOutputs.filter(
      name => ctx.trackedVars.has(name) && !isAccessorOutput(name),
    )
    const directOutputs = bindableOutputs.filter(name => !getterOutputs.includes(name))

    debugLog('region', `Region debug ${region.id}`, {
      outputs: uniqueOutputNames,
      getterOutputs,
      directOutputs,
      tracked: Array.from(ctx.trackedVars),
      memoVars: Array.from(ctx.memoVars ?? []),
    })

    const regionResultName =
      mutablePropOutputs.length > 0
        ? reserveFunctionLocalName(ctx, `__region_${region.id}_value`)
        : null
    if (regionResultName) {
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(regionResultName),
            t.callExpression(t.identifier(regionVarName), []),
          ),
        ]),
      )
    }
    const directOutputSource = regionResultName
      ? t.identifier(regionResultName)
      : t.callExpression(t.identifier(regionVarName), [])

    // Destructure outputs that are already accessors or non-reactive values.
    if (directOutputs.length > 0) {
      directOutputs.forEach(name => declaredVars.add(name))
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.objectPattern(
              directOutputs.map(name => regionOutputProperty(t, name, t.identifier(name), true)),
            ),
            directOutputSource,
          ),
        ]),
      )
    }

    for (const name of mutablePropOutputs) {
      statements.push(
        t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.identifier(name),
            regionOutputMember(
              t,
              regionResultName
                ? t.identifier(regionResultName)
                : t.callExpression(t.identifier(regionVarName), []),
              name,
            ),
          ),
        ),
      )
    }

    // Wrap pending outputs in getters that call the region accessor lazily.
    // These become memo-like getters that should be called with () when used.
    for (const name of getterOutputs) {
      declaredVars.add(name)
      const callRegion = t.callExpression(t.identifier(regionVarName), [])
      const baseAccess = regionOutputMember(t, callRegion, name)
      const accessorExpr = (() => {
        if (!mutableGetterOutputs?.has(name)) {
          return t.arrowFunctionExpression([], baseAccess)
        }

        const overrideName = reserveFunctionLocalName(ctx, `__region_${name}_value`)
        const hasOverrideName = reserveFunctionLocalName(ctx, `__region_${name}_hasValue`)
        const argsName = reserveFunctionLocalName(ctx, `__region_${name}_args`)
        const overrideId = t.identifier(overrideName)
        const hasOverrideId = t.identifier(hasOverrideName)
        const argsId = t.identifier(argsName)
        statements.push(
          t.variableDeclaration('let', [t.variableDeclarator(overrideId)]),
          t.variableDeclaration('let', [
            t.variableDeclarator(hasOverrideId, t.booleanLiteral(false)),
          ]),
        )
        return t.arrowFunctionExpression(
          [t.restElement(argsId)],
          t.conditionalExpression(
            t.memberExpression(t.cloneNode(argsId), t.identifier('length')),
            t.sequenceExpression([
              t.assignmentExpression('=', t.cloneNode(hasOverrideId), t.booleanLiteral(true)),
              t.assignmentExpression(
                '=',
                t.cloneNode(overrideId),
                t.memberExpression(t.cloneNode(argsId), t.numericLiteral(0), true),
              ),
            ]),
            t.conditionalExpression(
              t.cloneNode(hasOverrideId),
              t.cloneNode(overrideId),
              baseAccess,
            ),
          ),
        )
      })()
      statements.push(
        t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), accessorExpr)]),
      )
      // Mark as a memo so buildDependencyGetter will add () when this name is used
      ctx.memoVars?.add(name)
    }

    // fix: Removed unnecessary effect that just called getter outputs.
    // The getterOutputs are already tracked through the memo - DOM bindings
    // that read them will trigger the memo's dependency tracking.
    // An effect that just calls heading() and extra() without side effects is wasteful.
  }

  return statements
}

/**
 * HIR-based lazy conditional analysis result
 */
interface HIRConditionalInfo {
  /** The condition expression (HIR) */
  condition: Expression
  /** Derived values only used in true branch */
  trueBranchOnlyDerived: Set<string>
  /** Derived values only used in false branch */
  falseBranchOnlyDerived: Set<string>
}

/**
 * Analyze a region to detect conditional patterns where derived values
 * are only used in specific branches. This enables lazy evaluation.
 */
function analyzeHIRConditionalUsage(
  region: Region,
  _ctx: CodegenContext,
): HIRConditionalInfo | null {
  const declarations = new Set(Array.from(region.declarations).map(d => deSSAVarName(d)))
  if (declarations.size < 2) {
    // Need at least 2 derived values for lazy optimization to matter
    return null
  }

  // Find conditional patterns in the region's instructions
  for (const instr of region.instructions) {
    if (instr.kind !== 'Assign') continue
    const expr = instr.value

    // Check for if-like patterns (ternary or logical &&)
    if (expr.kind === 'ConditionalExpression') {
      if (dependenciesIntersect(collectExprDependencies(expr.test), declarations)) {
        continue
      }
      const trueBranchDeps = collectExprDependencies(expr.consequent)
      const falseBranchDeps = collectExprDependencies(expr.alternate)

      const trueBranchOnlyDerived = new Set<string>()
      const falseBranchOnlyDerived = new Set<string>()

      for (const dep of trueBranchDeps) {
        if (declarations.has(dep) && !falseBranchDeps.has(dep)) {
          trueBranchOnlyDerived.add(dep)
        }
      }

      for (const dep of falseBranchDeps) {
        if (declarations.has(dep) && !trueBranchDeps.has(dep)) {
          falseBranchOnlyDerived.add(dep)
        }
      }

      if (trueBranchOnlyDerived.size > 0 || falseBranchOnlyDerived.size > 0) {
        return {
          condition: expr.test,
          trueBranchOnlyDerived,
          falseBranchOnlyDerived,
        }
      }
    }

    // Check for logical && patterns
    if (expr.kind === 'LogicalExpression' && expr.operator === '&&') {
      if (dependenciesIntersect(collectExprDependencies(expr.left), declarations)) {
        continue
      }
      const rightDeps = collectExprDependencies(expr.right)
      const trueBranchOnlyDerived = new Set<string>()

      for (const dep of rightDeps) {
        if (declarations.has(dep)) {
          trueBranchOnlyDerived.add(dep)
        }
      }

      if (trueBranchOnlyDerived.size > 0) {
        return {
          condition: expr.left,
          trueBranchOnlyDerived,
          falseBranchOnlyDerived: new Set(),
        }
      }
    }
  }

  return null
}

function dependenciesIntersect(deps: Set<string>, declarations: Set<string>): boolean {
  for (const dep of deps) {
    if (declarations.has(dep)) return true
  }
  return false
}

/**
 * Collect all identifier dependencies from an HIR expression
 */
function collectExprDependencies(expr: Expression): Set<string> {
  const deps = new Set<string>()

  const visit = (e: Expression): void => {
    if (!e || typeof e !== 'object') return

    switch (e.kind) {
      case 'Identifier':
        deps.add(deSSAVarName(e.name))
        break
      case 'MemberExpression':
        visit(e.object)
        if (e.computed && e.property.kind !== 'Literal') {
          visit(e.property)
        }
        break
      case 'CallExpression':
        visit(e.callee)
        e.arguments.forEach(a => visit(a))
        break
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(e.left)
        visit(e.right)
        break
      case 'ConditionalExpression':
        visit(e.test)
        visit(e.consequent)
        visit(e.alternate)
        break
      case 'UnaryExpression':
        visit(e.argument)
        break
      case 'ArrayExpression':
        e.elements.forEach(el => el && visit(el))
        break
      case 'ObjectExpression':
        e.properties.forEach(p => {
          if (p.kind === 'SpreadElement') {
            visit(p.argument)
          } else {
            if (p.computed) visit(p.key)
            visit(p.value)
          }
        })
        break
      case 'TemplateLiteral':
        e.expressions.forEach(ex => visit(ex))
        break
      case 'ArrowFunction':
      case 'FunctionExpression':
        // Don't traverse into function bodies - they create new scopes
        break
      // Handle newly added expression types
      case 'AwaitExpression':
        visit(e.argument)
        break
      case 'NewExpression':
        visit(e.callee)
        e.arguments.forEach(a => visit(a))
        break
      case 'SequenceExpression':
        e.expressions.forEach(ex => visit(ex))
        break
      case 'YieldExpression':
        if (e.argument) visit(e.argument)
        break
      case 'OptionalCallExpression':
        visit(e.callee)
        e.arguments.forEach(a => visit(a))
        break
      case 'TaggedTemplateExpression':
        visit(e.tag)
        if (e.quasi && e.quasi.expressions) {
          e.quasi.expressions.forEach(ex => visit(ex))
        }
        break
      case 'OptionalMemberExpression':
        visit(e.object)
        if (e.computed && e.property.kind !== 'Literal') {
          visit(e.property)
        }
        break
      case 'UpdateExpression':
        visit(e.argument)
        break
      case 'AssignmentExpression':
        visit(e.left)
        visit(e.right)
        break
      case 'SpreadElement':
        visit(e.argument)
        break
    }
  }

  visit(expr)
  return deps
}

function isAccessorSnapshotSource(name: string, ctx: CodegenContext): boolean {
  return (
    (ctx.memoVars?.has(name) ?? false) ||
    (ctx.aliasVars?.has(name) ?? false) ||
    (ctx.signalVars?.has(name) ?? false) ||
    (ctx.storeVars?.has(name) ?? false) ||
    (ctx.namespaceStoreAliasVars?.has(name) ?? false) ||
    (ctx.importedNamespaces?.has(name) ?? false)
  )
}

function isReactiveSnapshotExcludedName(
  name: string,
  ctx: CodegenContext,
  localValueNames?: Set<string>,
): boolean {
  if (localValueNames?.has(name) && !isAccessorSnapshotSource(name, ctx)) {
    return false
  }
  return (
    ctx.trackedVars.has(name) ||
    (ctx.externalTracked?.has(name) ?? false) ||
    isAccessorSnapshotSource(name, ctx)
  )
}

function collectMutableNonReactiveDependencies(
  expr: Expression,
  ctx: CodegenContext,
  targetName?: string,
  localValueNames?: Set<string>,
): string[] {
  const names = new Set<string>()
  for (const dep of collectExprDependencies(expr)) {
    const name = deSSAVarName(dep)
    if (name === targetName) continue
    if (!(ctx.mutatedVars?.has(name) ?? false) && !(ctx.memberMutatedVars?.has(name) ?? false)) {
      continue
    }
    if (isReactiveSnapshotExcludedName(name, ctx, localValueNames)) continue
    names.add(name)
  }
  return Array.from(names)
}

function isReactiveAccessorReadCall(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  if (expr.arguments.length !== 0) return false
  const callee = expr.callee
  if (callee.kind === 'Identifier') {
    const name = deSSAVarName(callee.name)
    return (
      ctx.trackedVars.has(name) ||
      (ctx.externalTracked?.has(name) ?? false) ||
      (ctx.memoVars?.has(name) ?? false) ||
      (ctx.aliasVars?.has(name) ?? false) ||
      (ctx.signalVars?.has(name) ?? false)
    )
  }
  return getNamespaceReactiveMemberKind(callee, ctx) !== null
}

function isFunctionExpressionValue(expr: Expression | undefined): boolean {
  return expr?.kind === 'ArrowFunction' || expr?.kind === 'FunctionExpression'
}

function instructionIsLazyMemoSafe(
  instr: Instruction,
  ctx: CodegenContext,
  safeLocalRoots = new Set<string>(),
): boolean {
  if (instr.kind === 'Phi') return true
  if (instr.kind === 'Expression') return expressionIsLazyMemoSafe(instr.value, ctx, safeLocalRoots)
  if (instr.kind !== 'Assign') return true
  if (!instr.declarationKind) return false
  return expressionIsLazyMemoSafe(instr.value, ctx, safeLocalRoots)
}

function terminatorIsLazyMemoSafe(
  term: Terminator,
  ctx: CodegenContext,
  safeLocalRoots = new Set<string>(),
): boolean {
  switch (term.kind) {
    case 'Return':
      return !term.argument || expressionIsLazyMemoSafe(term.argument, ctx, safeLocalRoots)
    case 'Branch':
      return expressionIsLazyMemoSafe(term.test, ctx, safeLocalRoots)
    case 'Switch':
      return (
        expressionIsLazyMemoSafe(term.discriminant, ctx, safeLocalRoots) &&
        term.cases.every(
          item => !item.test || expressionIsLazyMemoSafe(item.test, ctx, safeLocalRoots),
        )
      )
    case 'Throw':
    case 'ForOf':
    case 'ForIn':
    case 'Try':
      return false
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
      return true
  }
}

function functionParamNames(
  expr: Extract<Expression, { kind: 'ArrowFunction' | 'FunctionExpression' }>,
): Set<string> {
  return new Set(expr.params.map(param => deSSAVarName(param.name)))
}

function expressionRootName(expr: Expression): string | null {
  let current = expr
  while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
    current = current.object
  }
  return current.kind === 'Identifier' ? deSSAVarName(current.name) : null
}

function expressionHasSafeLocalRoot(expr: Expression, safeLocalRoots: Set<string>): boolean {
  const root = expressionRootName(expr)
  return !!root && safeLocalRoots.has(root)
}

function functionExpressionBodyIsLazyMemoSafe(
  expr: Expression,
  ctx: CodegenContext,
  safeLocalRoots = new Set<string>(),
): boolean {
  if (expr.kind === 'ArrowFunction') {
    const functionSafeLocalRoots = new Set(safeLocalRoots)
    functionParamNames(expr).forEach(name => functionSafeLocalRoots.add(name))
    if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
      return expressionIsLazyMemoSafe(expr.body as Expression, ctx, functionSafeLocalRoots)
    }
    if (!Array.isArray(expr.body)) return true
    return expr.body.every(
      block =>
        block.instructions.every(instr =>
          instructionIsLazyMemoSafe(instr, ctx, functionSafeLocalRoots),
        ) && terminatorIsLazyMemoSafe(block.terminator, ctx, functionSafeLocalRoots),
    )
  }
  if (expr.kind === 'FunctionExpression') {
    const functionSafeLocalRoots = new Set(safeLocalRoots)
    functionParamNames(expr).forEach(name => functionSafeLocalRoots.add(name))
    return expr.body.every(
      block =>
        block.instructions.every(instr =>
          instructionIsLazyMemoSafe(instr, ctx, functionSafeLocalRoots),
        ) && terminatorIsLazyMemoSafe(block.terminator, ctx, functionSafeLocalRoots),
    )
  }
  return false
}

function classExpressionDefinitionIsLazyMemoSafe(
  expr: Extract<Expression, { kind: 'ClassExpression' }>,
  t: typeof BabelCore.types,
): boolean {
  if ((expr.decorators?.length ?? 0) > 0) return false
  return (expr.body ?? []).every(member => {
    if (((member as { decorators?: unknown[] }).decorators?.length ?? 0) > 0) return false
    if ((member as { computed?: boolean }).computed) return false
    if (t.isStaticBlock(member)) return false
    if (
      (member as { static?: boolean }).static === true &&
      (t.isClassProperty(member) ||
        t.isClassPrivateProperty(member) ||
        t.isClassAccessorProperty(member))
    ) {
      return !member.value
    }
    return true
  })
}

function expressionIsLazyMemoSafe(
  expr: Expression,
  ctx: CodegenContext,
  safeLocalRoots = new Set<string>(),
): boolean {
  switch (expr.kind) {
    case 'Identifier':
    case 'Literal':
    case 'MetaProperty':
    case 'ThisExpression':
    case 'SuperExpression':
    case 'ArrowFunction':
    case 'FunctionExpression':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression':
      if (isReactiveAccessorReadCall(expr, ctx)) return true
      if (isFunctionExpressionValue(expr.callee)) {
        return (
          functionExpressionBodyIsLazyMemoSafe(expr.callee, ctx, safeLocalRoots) &&
          expr.arguments.every(arg => expressionIsLazyMemoSafe(arg, ctx, safeLocalRoots))
        )
      }
      if (
        expr.callee.kind === 'Identifier' &&
        LAZY_MEMO_SAFE_GLOBAL_CALLS.has(deSSAVarName(expr.callee.name))
      ) {
        return expr.arguments.every(arg => expressionIsLazyMemoSafe(arg, ctx, safeLocalRoots))
      }
      if (
        expr.callee.kind === 'MemberExpression' ||
        expr.callee.kind === 'OptionalMemberExpression'
      ) {
        if (isLazyMemoSafeSyncCallbackHost(expr.callee)) {
          return (
            expressionIsLazyMemoSafe(expr.callee.object as Expression, ctx, safeLocalRoots) &&
            (!expr.callee.computed ||
              expressionIsLazyMemoSafe(expr.callee.property, ctx, safeLocalRoots)) &&
            expr.arguments.every(arg => {
              const argExpr = arg as Expression
              return isFunctionExpressionValue(argExpr)
                ? functionExpressionBodyIsLazyMemoSafe(argExpr, ctx, safeLocalRoots)
                : expressionIsLazyMemoSafe(argExpr, ctx, safeLocalRoots)
            })
          )
        }
        return (
          (expressionUsesTracked(expr.callee.object, ctx) ||
            expressionHasSafeLocalRoot(expr.callee.object, safeLocalRoots)) &&
          expressionIsLazyMemoSafe(expr.callee, ctx, safeLocalRoots) &&
          expr.arguments.every(arg => expressionIsLazyMemoSafe(arg, ctx, safeLocalRoots))
        )
      }
      return false
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionIsLazyMemoSafe(expr.left, ctx, safeLocalRoots) &&
        expressionIsLazyMemoSafe(expr.right, ctx, safeLocalRoots)
      )
    case 'UnaryExpression':
      return (
        expr.operator !== 'delete' && expressionIsLazyMemoSafe(expr.argument, ctx, safeLocalRoots)
      )
    case 'ConditionalExpression':
      return (
        expressionIsLazyMemoSafe(expr.test, ctx, safeLocalRoots) &&
        expressionIsLazyMemoSafe(expr.consequent, ctx, safeLocalRoots) &&
        expressionIsLazyMemoSafe(expr.alternate, ctx, safeLocalRoots)
      )
    case 'ArrayExpression':
      return expr.elements.every(
        element => !element || expressionIsLazyMemoSafe(element, ctx, safeLocalRoots),
      )
    case 'ObjectExpression':
      return expr.properties.every(prop => {
        if (prop.kind === 'SpreadElement') {
          return expressionIsLazyMemoSafe(prop.argument, ctx, safeLocalRoots)
        }
        return (
          (!prop.computed || expressionIsLazyMemoSafe(prop.key, ctx, safeLocalRoots)) &&
          (prop.propertyKind === 'method' ||
            prop.propertyKind === 'get' ||
            prop.propertyKind === 'set' ||
            expressionIsLazyMemoSafe(prop.value, ctx, safeLocalRoots))
        )
      })
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (resolveHookMemberValue(expr, ctx)) return true
      if (getNamespaceReactiveMemberKind(expr, ctx)) return true
      if (!expressionUsesTracked(expr, ctx) && !expressionHasSafeLocalRoot(expr, safeLocalRoots)) {
        return false
      }
      return (
        expressionIsLazyMemoSafe(expr.object, ctx, safeLocalRoots) &&
        (!expr.computed || expressionIsLazyMemoSafe(expr.property, ctx, safeLocalRoots))
      )
    case 'JSXElement':
      return (
        (typeof expr.tagName === 'string' ||
          expressionIsLazyMemoSafe(expr.tagName, ctx, safeLocalRoots)) &&
        expr.attributes.every(attr =>
          attr.isSpread
            ? !attr.spreadExpr || expressionIsLazyMemoSafe(attr.spreadExpr, ctx, safeLocalRoots)
            : !attr.value || expressionIsLazyMemoSafe(attr.value, ctx, safeLocalRoots),
        ) &&
        expr.children.every(child => {
          if (child.kind === 'text') return true
          return expressionIsLazyMemoSafe(child.value, ctx, safeLocalRoots)
        })
      )
    case 'TemplateLiteral':
      return expr.expressions.every(item => expressionIsLazyMemoSafe(item, ctx, safeLocalRoots))
    case 'SequenceExpression':
      return expr.expressions.every(item => expressionIsLazyMemoSafe(item, ctx, safeLocalRoots))
    case 'SpreadElement':
      return expressionIsLazyMemoSafe(expr.argument, ctx, safeLocalRoots)
    case 'ImportExpression':
      return (
        expressionIsLazyMemoSafe(expr.source, ctx, safeLocalRoots) &&
        (!expr.options || expressionIsLazyMemoSafe(expr.options, ctx, safeLocalRoots))
      )
    case 'TaggedTemplateExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'NewExpression':
    case 'YieldExpression':
      return false
    case 'ClassExpression':
      return (
        (!expr.superClass || expressionIsLazyMemoSafe(expr.superClass, ctx)) &&
        classExpressionDefinitionIsLazyMemoSafe(expr, ctx.t)
      )
  }
}

function expressionIsLocalFunctionDirectCall(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  if (expr.callee.kind !== 'Identifier') return false
  const calleeName = deSSAVarName(expr.callee.name)
  if (calleeName === 'prop') return false
  return ctx.componentFunctionDefs?.has(calleeName) ?? false
}

function expressionReturnsAccessorOrReactiveObject(expr: Expression, ctx: CodegenContext): boolean {
  const callKind = getReactiveCallKind(expr, ctx)
  return callKind === 'memo' || isRuntimePropCall(expr, ctx)
}

function isRuntimePropCall(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression') return false
  if (expr.callee.kind !== 'Identifier') return false
  const calleeName = deSSAVarName(expr.callee.name)
  if (
    (ctx.shadowedNames?.has(calleeName) ?? false) ||
    (ctx.localDeclaredNames?.has(calleeName) ?? false)
  ) {
    return false
  }
  return ctx.moduleRuntimeImportMap?.get(calleeName) === 'prop'
}

function classExpressionNeedsReactiveMemo(instr: Instruction, ctx: CodegenContext): boolean {
  if (instr.kind !== 'Assign') return false
  if (instr.value.kind !== 'ClassExpression') return false
  const baseName = deSSAVarName(instr.target.name)
  return expressionUsesTracked(instr.value, ctx) || (ctx.memoVars?.has(baseName) ?? false)
}

function instructionRequiresEagerDerivedLowering(instr: Instruction, ctx: CodegenContext): boolean {
  if (instr.kind !== 'Assign') return false
  const baseName = deSSAVarName(instr.target.name)
  if (baseName.startsWith('__destruct_')) return false
  const mutableDeps = collectMutableNonReactiveDependencies(instr.value, ctx, baseName)
  if (mutableDeps.some(name => ctx.memberMutatedVars?.has(name) ?? false)) return true
  if (!expressionUsesTracked(instr.value, ctx) && !(ctx.memoVars?.has(baseName) ?? false)) {
    return false
  }
  if (resolveHookMemberValue(instr.value, ctx)) return false
  if (getNamespaceReactiveMemberKind(instr.value, ctx)) return false
  if (expressionNeedsAsyncContext(instr.value)) return false
  if (expressionReturnsAccessorOrReactiveObject(instr.value, ctx)) return false
  if (classExpressionNeedsReactiveMemo(instr, ctx)) return false
  return !expressionIsLazyMemoSafe(instr.value, ctx)
}

function regionRequiresEagerDerivedLowering(region: Region, ctx: CodegenContext): boolean {
  return region.instructions.some(instr => instructionRequiresEagerDerivedLowering(instr, ctx))
}

function replaceMutableSnapshotIdentifiers(
  expr: Expression,
  replacements: Map<string, string>,
): Expression {
  const replace = (current: Expression): Expression => {
    switch (current.kind) {
      case 'Identifier': {
        const replacement = replacements.get(deSSAVarName(current.name))
        return replacement ? { ...current, name: replacement } : current
      }
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
        return current
      case 'ImportExpression':
        return {
          ...current,
          source: replace(current.source),
          options: current.options ? replace(current.options) : undefined,
        }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return {
          ...current,
          object: replace(current.object),
          property: current.computed ? replace(current.property) : current.property,
        }
      case 'CallExpression':
      case 'OptionalCallExpression':
        return {
          ...current,
          callee: replace(current.callee),
          arguments: current.arguments.map(arg => replace(arg)),
        }
      case 'BinaryExpression':
      case 'LogicalExpression':
        return { ...current, left: replace(current.left), right: replace(current.right) }
      case 'UnaryExpression':
      case 'SpreadElement':
      case 'AwaitExpression':
        return { ...current, argument: replace(current.argument) }
      case 'ConditionalExpression':
        return {
          ...current,
          test: replace(current.test),
          consequent: replace(current.consequent),
          alternate: replace(current.alternate),
        }
      case 'ArrayExpression':
        return {
          ...current,
          elements: current.elements.map(element => (element ? replace(element) : null)),
        }
      case 'ObjectExpression':
        return {
          ...current,
          properties: current.properties.map(prop =>
            prop.kind === 'SpreadElement'
              ? { ...prop, argument: replace(prop.argument) }
              : {
                  ...prop,
                  key: prop.computed ? replace(prop.key) : prop.key,
                  value: replace(prop.value),
                },
          ),
        }
      case 'JSXElement':
        return {
          ...current,
          tagName: typeof current.tagName === 'string' ? current.tagName : replace(current.tagName),
          attributes: current.attributes.map(attr =>
            attr.isSpread
              ? {
                  ...attr,
                  spreadExpr: attr.spreadExpr ? replace(attr.spreadExpr) : undefined,
                }
              : { ...attr, value: attr.value ? replace(attr.value) : null },
          ),
          children: current.children.map(child => {
            if (child.kind === 'text') return child
            if (child.kind === 'expression') return { ...child, value: replace(child.value) }
            return { ...child, value: replace(child.value) as HJSXElementExpression }
          }),
        }
      case 'TemplateLiteral':
        return { ...current, expressions: current.expressions.map(expr => replace(expr)) }
      case 'AssignmentExpression':
        return { ...current, left: replace(current.left), right: replace(current.right) }
      case 'UpdateExpression':
        return { ...current, argument: replace(current.argument) }
      case 'NewExpression':
        return {
          ...current,
          callee: replace(current.callee),
          arguments: current.arguments.map(arg => replace(arg)),
        }
      case 'SequenceExpression':
        return { ...current, expressions: current.expressions.map(expr => replace(expr)) }
      case 'YieldExpression':
        return { ...current, argument: current.argument ? replace(current.argument) : null }
      case 'TaggedTemplateExpression':
        return {
          ...current,
          tag: replace(current.tag),
          quasi: replace(current.quasi) as TemplateLiteral,
        }
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'ClassExpression':
        return current
    }
  }

  return replace(expr)
}

function collectStructuredAssignDeclarations(
  node: StructuredNode,
  into: AssignInstruction[] = [],
): AssignInstruction[] {
  switch (node.kind) {
    case 'instruction':
      if (node.instruction.kind === 'Assign' && node.instruction.declarationKind) {
        into.push(node.instruction)
      }
      break
    case 'sequence':
      node.nodes.forEach(child => collectStructuredAssignDeclarations(child, into))
      break
    case 'block':
      node.statements.forEach(child => collectStructuredAssignDeclarations(child, into))
      break
    case 'labeled':
      collectStructuredAssignDeclarations(node.statement, into)
      break
    case 'if':
      collectStructuredAssignDeclarations(node.consequent, into)
      if (node.alternate) collectStructuredAssignDeclarations(node.alternate, into)
      break
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
      collectStructuredAssignDeclarations(node.body, into)
      break
    case 'switch':
      node.cases.forEach(item => collectStructuredAssignDeclarations(item.body, into))
      break
    case 'try':
      collectStructuredAssignDeclarations(node.block, into)
      if (node.handler) collectStructuredAssignDeclarations(node.handler.body, into)
      if (node.finalizer) collectStructuredAssignDeclarations(node.finalizer, into)
      break
    default:
      break
  }
  return into
}

function collectControlFlowLocalRegionDeclarations(
  rootNode: StructuredNode,
  region: Region,
  regionCtx: RegionEmitContext,
  t: typeof BabelCore.types,
): Set<string> {
  const localNames = new Set<string>()
  const regionDeclarations = new Set(
    Array.from(region.declarations, declaration => deSSAVarName(declaration)),
  )

  const addRegionInstructionDeclaration = (instr: Instruction): void => {
    if (instr.kind !== 'Assign') return
    if (instr.declarationKind !== 'const' && instr.declarationKind !== 'let') return
    const name = deSSAVarName(instr.target.name)
    if (!regionDeclarations.has(name)) return
    if (findRegionForInstruction(instr, regionCtx)?.id !== region.id) return
    localNames.add(name)
  }

  const addLoopBindingName = (name: string, kind: 'const' | 'let' | 'var'): void => {
    if (kind === 'var' || !regionDeclarations.has(name)) return
    localNames.add(name)
  }

  const visit = (node: StructuredNode, inControlFlowScope: boolean): void => {
    switch (node.kind) {
      case 'instruction':
        if (inControlFlowScope) addRegionInstructionDeclaration(node.instruction)
        return
      case 'sequence':
        node.nodes.forEach(child => visit(child, inControlFlowScope))
        return
      case 'block':
        node.statements.forEach(child => visit(child, inControlFlowScope))
        return
      case 'labeled':
        visit(node.statement, inControlFlowScope)
        return
      case 'if':
        visit(node.consequent, true)
        if (node.alternate) visit(node.alternate, true)
        return
      case 'while':
      case 'doWhile':
        visit(node.body, true)
        return
      case 'for':
        node.init?.forEach(addRegionInstructionDeclaration)
        visit(node.body, true)
        return
      case 'forOf':
      case 'forIn': {
        if (node.leftKind !== 'assignment') {
          addLoopBindingName(deSSAVarName(node.variable), node.variableKind)
          if (node.pattern) {
            const patternNames = new Set<string>()
            collectPatternBindingNames(node.pattern, t, patternNames)
            patternNames.forEach(name => addLoopBindingName(name, node.variableKind))
          }
        }
        visit(node.body, true)
        return
      }
      case 'switch':
        node.cases.forEach(item => visit(item.body, true))
        return
      case 'try':
        visit(node.block, true)
        if (node.handler) {
          if (node.handler.param) addLoopBindingName(deSSAVarName(node.handler.param), 'let')
          if (node.handler.pattern) {
            const patternNames = new Set<string>()
            collectPatternBindingNames(node.handler.pattern, t, patternNames)
            patternNames.forEach(name => addLoopBindingName(name, 'let'))
          }
          visit(node.handler.body, true)
        }
        if (node.finalizer) visit(node.finalizer, true)
        return
      default:
        return
    }
  }

  visit(rootNode, false)
  return localNames
}

function findPriorDeclarationInstruction(
  rootNode: StructuredNode,
  name: string,
  before: Instruction,
): AssignInstruction | null {
  let best: AssignInstruction | null = null
  for (const declaration of collectStructuredAssignDeclarations(rootNode)) {
    if (deSSAVarName(declaration.target.name) !== name) continue
    if (!instructionSourceBefore(declaration, before)) continue
    if (!best || instructionSourceBefore(best, declaration)) {
      best = declaration
    }
  }
  return best
}

/**
 * Generate a lazy conditional memo that defers evaluation of branch-specific derived values
 */
function generateLazyConditionalMemo(
  region: Region,
  orderedOutputs: string[],
  bodyStatements: BabelCore.types.Statement[],
  conditionalInfo: HIRConditionalInfo,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
): BabelCore.types.Statement[] {
  const statements: BabelCore.types.Statement[] = []

  // Tag statements by their branch requirement
  interface TaggedStatement {
    stmt: BabelCore.types.Statement
    kind: 'always' | 'lazyTrue' | 'lazyFalse'
  }

  const taggedStatements: TaggedStatement[] = bodyStatements.map(stmt => {
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const decl = stmt.declarations[0]
      if (decl && t.isIdentifier(decl.id)) {
        if (conditionalInfo.trueBranchOnlyDerived.has(decl.id.name)) {
          return { stmt, kind: 'lazyTrue' }
        }
        if (conditionalInfo.falseBranchOnlyDerived.has(decl.id.name)) {
          return { stmt, kind: 'lazyFalse' }
        }
      }
    }
    return { stmt, kind: 'always' }
  })

  const lazyTrueStatements = taggedStatements
    .filter(tg => tg.kind === 'lazyTrue')
    .map(tg => tg.stmt)
  const lazyFalseStatements = taggedStatements
    .filter(tg => tg.kind === 'lazyFalse')
    .map(tg => tg.stmt)

  // Find first lazy index to split always statements
  const firstLazyIndex = taggedStatements.findIndex(tg => tg.kind !== 'always')
  const alwaysBeforeLazy: BabelCore.types.Statement[] = []
  const alwaysAfterLazy: BabelCore.types.Statement[] = []

  taggedStatements.forEach((tg, idx) => {
    if (tg.kind === 'always') {
      if (firstLazyIndex === -1 || idx < firstLazyIndex) {
        alwaysBeforeLazy.push(tg.stmt)
      } else {
        alwaysAfterLazy.push(tg.stmt)
      }
    }
  })

  // Create condition variable
  const conditionStmt = lowerExpressionWithDeSSA(conditionalInfo.condition, ctx)
  const conditionId = t.identifier(`__cond_${region.id}`)
  const conditionDecl = t.variableDeclaration('const', [
    t.variableDeclarator(conditionId, conditionStmt),
  ])
  const ignoredSignatureKeys = new Set([
    'loc',
    'start',
    'end',
    'leadingComments',
    'innerComments',
    'trailingComments',
    'extra',
  ])
  const nodeSignature = (node: BabelCore.types.Node): string =>
    JSON.stringify(node, (key, value) => (ignoredSignatureKeys.has(key) ? undefined : value))
  const conditionSignature = nodeSignature(conditionStmt)
  const visitorKeys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
  const rewriteConditionalTests = (statements: BabelCore.types.Statement[]): void => {
    const visitValue = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visitValue)
        return
      }
      if (!value || typeof value !== 'object' || !('type' in value)) return
      visitNode(value as BabelCore.types.Node)
    }
    const visitNode = (node: BabelCore.types.Node): void => {
      if (t.isConditionalExpression(node) && nodeSignature(node.test) === conditionSignature) {
        node.test = t.cloneNode(conditionId)
      }
      for (const key of visitorKeys?.[node.type] ?? []) {
        visitValue((node as unknown as Record<string, unknown>)[key])
      }
    }
    statements.forEach(visitNode)
  }
  rewriteConditionalTests(alwaysAfterLazy)

  // Create return statement helper
  const createReturnWithNulls = (nullFields: Set<string>): BabelCore.types.ReturnStatement => {
    return t.returnStatement(
      t.objectExpression(
        orderedOutputs.map(name => {
          if (nullFields.has(name)) {
            return regionOutputProperty(t, name, t.nullLiteral())
          }
          return regionOutputProperty(t, name, t.identifier(name), true)
        }),
      ),
    )
  }

  // Build memo body with conditional evaluation
  const memoBody: BabelCore.types.Statement[] = [...alwaysBeforeLazy, conditionDecl]

  if (
    lazyTrueStatements.length > 0 ||
    lazyFalseStatements.length > 0 ||
    alwaysAfterLazy.length > 0
  ) {
    const trueBlock = [
      ...lazyTrueStatements,
      ...alwaysAfterLazy,
      createReturnWithNulls(conditionalInfo.falseBranchOnlyDerived),
    ]
    const falseBlock = [
      ...lazyFalseStatements,
      ...alwaysAfterLazy,
      createReturnWithNulls(conditionalInfo.trueBranchOnlyDerived),
    ]
    memoBody.push(
      t.ifStatement(conditionId, t.blockStatement(trueBlock), t.blockStatement(falseBlock)),
    )
  }

  const regionVarName = reserveFunctionLocalName(ctx, `__region_${region.id}`)

  const memoCall = buildMemoCall(
    ctx,
    t,
    t.arrowFunctionExpression([], t.blockStatement(memoBody)),
    {
      slot: ctx.inModule ? undefined : reserveHookSlot(ctx),
      internal: true,
    },
  )

  statements.push(
    t.variableDeclaration('const', [t.variableDeclarator(t.identifier(regionVarName), memoCall)]),
  )

  // Destructure outputs
  for (const name of orderedOutputs) {
    declaredVars.add(name)
  }
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.objectPattern(
          orderedOutputs.map(name => regionOutputProperty(t, name, t.identifier(name), true)),
        ),
        t.callExpression(t.identifier(regionVarName), []),
      ),
    ]),
  )

  return statements
}

/**
 * Convert an instruction to a Babel statement
 * Handles SSA name de-versioning
 */
function reserveHookSlot(ctx: CodegenContext): number {
  if (ctx.dynamicHookSlotDepth && ctx.dynamicHookSlotDepth > 0) {
    return -1
  }
  const slot = ctx.nextHookSlot ?? 0
  ctx.nextHookSlot = slot + 1
  return slot
}

/**
 * fix helper: Create a plain variable declaration for non-reactive scopes.
 * Variables declared inside non-reactive scopes (like createConditional callbacks)
 * should be plain variables, not reactive accessors.
 *
 * This function:
 * 1. Removes the variable from trackedVars and memoVars so it won't be called as an accessor later
 * 2. Returns a 'let' declaration (allowing future reassignment in the scope)
 */
function createNonReactiveVarDecl(
  baseName: string,
  derivedExpr: BabelCore.types.Expression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): BabelCore.types.VariableDeclaration {
  ctx.trackedVars.delete(baseName)
  ctx.memoVars?.delete(baseName)
  return t.variableDeclaration('let', [t.variableDeclarator(t.identifier(baseName), derivedExpr)])
}

function isCallableSignalInitializer(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  return getReactiveCallKind(expr, ctx) === 'signal' && isFunctionExpressionValue(expr.arguments[0])
}

function expressionContainsNonSerializableFunctionValue(
  expr: Expression | null | undefined,
): boolean {
  if (!expr) return false
  switch (expr.kind) {
    case 'ArrowFunction':
    case 'FunctionExpression':
      return true
    case 'ArrayExpression':
      return expr.elements.some(element => expressionContainsNonSerializableFunctionValue(element))
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'SpreadElement') {
          return expressionContainsNonSerializableFunctionValue(prop.argument)
        }
        return (
          (prop.propertyKind !== undefined && prop.propertyKind !== 'init') ||
          expressionContainsNonSerializableFunctionValue(prop.value)
        )
      })
    default:
      return false
  }
}

function isNonSerializableSignalInitializer(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  return (
    getReactiveCallKind(expr, ctx) === 'signal' &&
    expressionContainsNonSerializableFunctionValue(expr.arguments[0])
  )
}

function markCallableSignalIfFunctionValue(
  name: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  if (isFunctionExpressionValue(value) || isCallableSignalInitializer(value, ctx)) {
    ctx.callableSignalVars?.add(name)
  }
}

function markNonSerializableSignalIfFunctionValue(
  name: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  if (
    expressionContainsNonSerializableFunctionValue(value) ||
    isNonSerializableSignalInitializer(value, ctx)
  ) {
    ctx.nonSerializableSignalVars?.add(name)
  }
}

function instructionToStatement(
  instr: Instruction,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
  _buildMemoCall?: (expr: BabelCore.types.Expression, name?: string) => BabelCore.types.Expression,
  hoistedDeclarationInitializers?: Set<string>,
): BabelCore.types.Statement | null {
  const applyLoc = <T extends BabelCore.types.Statement | null>(stmt: T): T => {
    if (!stmt) return stmt
    const baseLoc =
      instr.loc ??
      (instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value.loc : undefined)
    if (baseLoc !== undefined) {
      stmt.loc = baseLoc ?? null
    }
    return stmt
  }

  if (instr.kind === 'Assign') {
    const ssaName = instr.target.name
    const baseName = deSSAVarName(ssaName)
    const declKindRaw = instr.declarationKind
    const listKeyAliasReplacement =
      ctx.inListRender && ctx.listKeyParamName && ctx.listKeyAliasNames?.has(baseName)
        ? ctx.listKeyParamName
        : null
    if (listKeyAliasReplacement && declKindRaw && declKindRaw !== 'function') {
      declaredVars.add(baseName)
      return applyLoc(
        t.variableDeclaration(declKindRaw, [
          t.variableDeclarator(t.identifier(baseName), t.identifier(listKeyAliasReplacement)),
        ]),
      )
    }
    propagateHookResultAlias(baseName, instr.value, ctx)
    const hookMember = resolveHookMemberValue(instr.value, ctx)
    if (hookMember) {
      if (hookMember.kind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (hookMember.kind === 'memo') {
        ctx.memoVars?.add(baseName)
      } else if (hookMember.kind === 'store') {
        ctx.storeVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      }
      const declKind =
        declKindRaw && declKindRaw !== 'function' ? (declKindRaw as 'const' | 'let' | 'var') : null
      if (declKind) {
        declaredVars.add(baseName)
        return t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(baseName), hookMember.member),
        ])
      }
      if (declaredVars.has(baseName)) {
        return t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), hookMember.member),
        )
      }
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), hookMember.member),
      )
    }
    const declKind = declKindRaw && declKindRaw !== 'function' ? declKindRaw : undefined
    const isFunctionDecl =
      instr.value.kind === 'FunctionExpression' &&
      (declKindRaw === 'function' ||
        (!declKindRaw && !instr.isMutation && instr.value.name === baseName))
    if (isFunctionDecl) {
      const loweredFn = lowerExpressionWithDeSSA(instr.value, ctx)
      if (t.isFunctionExpression(loweredFn)) {
        declaredVars.add(baseName)
        return t.functionDeclaration(
          t.identifier(baseName),
          loweredFn.params,
          loweredFn.body as BabelCore.types.BlockStatement,
          loweredFn.generator ?? false,
          loweredFn.async ?? false,
        )
      }
    }
    if (!declKindRaw) {
      assertWritableImportedReactiveIdentifier(baseName, ctx, instr.loc ?? instr.value.loc)
    }
    const isTracked = ctx.trackedVars.has(baseName)
    const isSignal = ctx.signalVars?.has(baseName) ?? false
    const aliasVars = ctx.aliasVars ?? (ctx.aliasVars = new Set())
    const preserveEagerEvaluation = instr.preserveEagerEvaluation === true
    if (preserveEagerEvaluation) {
      ctx.memoVars?.delete(baseName)
    }
    const isLocalValue = ctx.localValueVars?.has(baseName) ?? false
    const isFunctionBinding = ctx.functionVars?.has(baseName) ?? false
    // Check both expression-level dependencies AND pre-computed memoVars (from computeReactiveAccessors)
    // This handles cases where dependencies are inside callbacks (e.g., array.find(n => n === target))
    const dependsOnTracked =
      !preserveEagerEvaluation &&
      !isLocalValue &&
      !isFunctionBinding &&
      (expressionUsesTracked(instr.value, ctx) || (ctx.memoVars?.has(baseName) ?? false))
    const capturedTracked =
      ctx.externalTracked && ctx.externalTracked.has(baseName) && !declaredVars.has(baseName)
    const isShadowDeclaration = !!declKind && declaredVars.has(baseName)
    const treatAsTracked = !isShadowDeclaration && isTracked
    const isDestructuringTemp = baseName.startsWith('__destruct_')
    const namespaceMemberKind = getNamespaceReactiveMemberKind(instr.value, ctx)
    const isNamespaceAccessorAlias =
      namespaceMemberKind === 'signal' || namespaceMemberKind === 'memo'
    const isNamespaceStoreAlias =
      namespaceMemberKind === 'store' ||
      (instr.value.kind === 'Identifier' &&
        (ctx.namespaceStoreAliasVars?.has(deSSAVarName(instr.value.name)) ?? false))
    const markNamespaceStoreAlias = (): void => {
      const namespaceStoreAliasVars =
        ctx.namespaceStoreAliasVars ?? (ctx.namespaceStoreAliasVars = new Set())
      namespaceStoreAliasVars.add(baseName)
      const storeVars = ctx.storeVars ?? (ctx.storeVars = new Set())
      storeVars.add(baseName)
      ctx.trackedVars.add(baseName)
    }
    const markReactiveAliasIfNeeded = (): void => {
      if (isDestructuringTemp) return
      if (isNamespaceAccessorAlias) {
        aliasVars.add(baseName)
        return
      }
      if (
        instr.value.kind === 'Identifier' &&
        ctx.trackedVars.has(deSSAVarName(instr.value.name))
      ) {
        aliasVars.add(baseName)
      }
    }
    const callKind = getReactiveCallKind(instr.value, ctx)
    const isStateCall = callKind === 'signal'
    const inRegionMemo = ctx.inRegionMemo ?? false
    const isFunctionValue =
      instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression'
    if (isStateCall || isSignal) {
      markCallableSignalIfFunctionValue(baseName, instr.value, ctx)
      markNonSerializableSignalIfFunctionValue(baseName, instr.value, ctx)
    }
    const isHoistedDeclarationInitializer = hoistedDeclarationInitializers?.has(baseName) ?? false
    const markLocalValue = (): void => {
      const localValueVars = ctx.localValueVars ?? (ctx.localValueVars = new Set())
      localValueVars.add(baseName)
    }
    // Detect accessor-returning calls ($memo, createMemo, runtime prop).
    const isAccessorReturningCall = callKind === 'memo' || isRuntimePropCall(instr.value, ctx)
    // Combined check for skipping memo wrapping
    const isMemoReturningCall = isAccessorReturningCall
    const canLazyMemoizeDerived = expressionIsLazyMemoSafe(instr.value, ctx)
    const needsReactiveClassMemo = classExpressionNeedsReactiveMemo(instr, ctx)
    const derivedValueContainsJSX = containsJSXExpr(instr.value)
    // fix: Check if variable will be mutated (assigned to later without declaration)
    const needsMutable = ctx.mutatedVars?.has(baseName) ?? false
    const lowerWithoutRenderMemo = <T>(fn: () => T): T => {
      const prevNoMemo = ctx.noMemo
      const prevDynamicHookSlotDepth = ctx.dynamicHookSlotDepth ?? 0
      ctx.noMemo = true
      ctx.dynamicHookSlotDepth = prevDynamicHookSlotDepth + 1
      try {
        return fn()
      } finally {
        ctx.noMemo = prevNoMemo
        ctx.dynamicHookSlotDepth = prevDynamicHookSlotDepth
      }
    }
    const lowerAssignedValue = (forceAssigned = false, noRenderMemo = false) => {
      const prevObjectLiteralPath = ctx.objectLiteralPath
      const prevComponentWrapperName = ctx.componentWrapperName
      if (instr.value.kind === 'ObjectExpression') {
        ctx.objectLiteralPath = [baseName]
      }
      if (isComponentName(baseName) && ctx.jsxComponentNames?.has(baseName)) {
        ctx.componentWrapperName = baseName
      }
      try {
        const lower = () =>
          lowerExpressionWithDeSSA(instr.value, ctx, forceAssigned || isFunctionValue)
        return noRenderMemo ? lowerWithoutRenderMemo(lower) : lower()
      } finally {
        ctx.objectLiteralPath = prevObjectLiteralPath
        ctx.componentWrapperName = prevComponentWrapperName
      }
    }
    const needsAsyncContext = expressionNeedsAsyncContext(instr.value)
    const isLocalFunctionDerivedCall = expressionIsLocalFunctionDirectCall(instr.value, ctx)
    const shouldUseNoMemoDerivedValue =
      ctx.noMemo || (inRegionMemo && (derivedValueContainsJSX || (ctx.inConditional ?? 0) > 0))
    const shouldEagerDerivedValue =
      !shouldUseNoMemoDerivedValue &&
      !needsAsyncContext &&
      !isMemoReturningCall &&
      !isLocalFunctionDerivedCall &&
      !canLazyMemoizeDerived &&
      !needsReactiveClassMemo &&
      !derivedValueContainsJSX
    const lowerEagerDerivedValue = (): BabelCore.types.Expression => {
      trackDerivedMemoVar()
      const memoExpr = buildDerivedMemoCall(lowerAssignedValue(true))
      const valueName = reserveFunctionLocalName(ctx, `__eager_${baseName}`)
      const valueId = t.identifier(valueName)
      return t.callExpression(
        t.arrowFunctionExpression(
          [valueId],
          t.sequenceExpression([t.callExpression(t.cloneNode(valueId), []), t.cloneNode(valueId)]),
        ),
        [memoExpr],
      )
    }
    const throwAliasReassignment = (): never => {
      const loc = instr.loc?.start
      throw new HIRError(
        `Alias reassignment is not supported for "${baseName}".\n\n` +
          `"${baseName}" was assigned from a reactive value and cannot be reassigned.\n` +
          `Consider:\n` +
          `  - Using a new variable name for the new value\n` +
          `  - Updating the original reactive source instead`,
        'BUILD_ERROR',
        {
          file: ctx.options?.filename,
          line: loc?.line,
          variable: baseName,
        },
      )
    }
    interface DerivedSnapshot {
      sourceName: string
      paramName: string
    }
    const createDerivedSnapshotPlan = (): DerivedSnapshot[] => {
      const deps = collectMutableNonReactiveDependencies(instr.value, ctx, baseName, declaredVars)
      return deps.map(sourceName => ({
        sourceName,
        paramName: reserveFunctionLocalName(ctx, `__snapshot_${sourceName}`),
      }))
    }
    const lowerDerivedAssignedValue = (): {
      expr: BabelCore.types.Expression
      snapshots: DerivedSnapshot[]
    } => {
      const snapshots = createDerivedSnapshotPlan()
      if (snapshots.length === 0) {
        return { expr: lowerAssignedValue(true, derivedValueContainsJSX), snapshots }
      }
      const replacements = new Map(
        snapshots.map(snapshot => [snapshot.sourceName, snapshot.paramName]),
      )
      const snapshotExpr = replaceMutableSnapshotIdentifiers(instr.value, replacements)
      const lowerSnapshotExpr = () => lowerExpressionWithDeSSA(snapshotExpr, ctx, true)
      return {
        expr: derivedValueContainsJSX
          ? lowerWithoutRenderMemo(lowerSnapshotExpr)
          : lowerSnapshotExpr(),
        snapshots,
      }
    }
    const wrapDerivedWithSnapshots = (
      value: BabelCore.types.Expression,
      snapshots: DerivedSnapshot[],
    ): BabelCore.types.Expression => {
      if (snapshots.length === 0) return value
      return t.callExpression(
        t.arrowFunctionExpression(
          snapshots.map(snapshot => t.identifier(snapshot.paramName)),
          value,
        ),
        snapshots.map(snapshot => t.identifier(snapshot.sourceName)),
      )
    }
    const buildDerivedMemoCall = (
      expr: BabelCore.types.Expression,
      snapshots: DerivedSnapshot[] = [],
    ) => {
      const slot = !ctx.inModule && inRegionMemo ? reserveHookSlot(ctx) : undefined
      const source =
        ctx.options?.dev !== false && instr.loc
          ? `${ctx.options?.filename ?? ''}:${instr.loc.start.line}:${instr.loc.start.column}`
          : undefined
      return wrapDerivedWithSnapshots(
        buildMemoCall(ctx, t, t.arrowFunctionExpression([], expr), {
          slot,
          name: baseName,
          source,
        }),
        snapshots,
      )
    }
    const trackDerivedMemoVar = (): void => {
      if (!needsAsyncContext) ctx.memoVars?.add(baseName)
    }
    const buildDerivedValue = (
      expr: BabelCore.types.Expression,
      snapshots: DerivedSnapshot[] = [],
    ): BabelCore.types.Expression =>
      needsAsyncContext || isMemoReturningCall ? expr : buildDerivedMemoCall(expr, snapshots)
    const buildNoMemoDerivedValue = (
      expr: BabelCore.types.Expression,
      snapshots: DerivedSnapshot[] = [],
    ): BabelCore.types.Expression =>
      needsAsyncContext
        ? expr
        : wrapDerivedWithSnapshots(t.arrowFunctionExpression([], expr), snapshots)
    const buildHoistedInitializer = (): BabelCore.types.Expression => {
      if (isStateCall) {
        ctx.currentAssignmentName = baseName
        try {
          return lowerAssignedValue(true)
        } finally {
          ctx.currentAssignmentName = undefined
        }
      }

      if (dependsOnTracked && !isDestructuringTemp) {
        markReactiveAliasIfNeeded()
        if (needsMutable) {
          ctx.memoVars?.delete(baseName)
          return lowerAssignedValue(true)
        }
        if (shouldEagerDerivedValue) {
          return lowerEagerDerivedValue()
        }
        const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
        trackDerivedMemoVar()
        if (shouldUseNoMemoDerivedValue) {
          return buildNoMemoDerivedValue(derivedExpr, snapshots)
        }
        return buildDerivedValue(derivedExpr, snapshots)
      }

      return lowerAssignedValue(true)
    }

    if (isShadowDeclaration && declKind) {
      ctx.trackedVars.delete(baseName)
    }

    if (isHoistedDeclarationInitializer) {
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), buildHoistedInitializer()),
      )
    }

    if (isNamespaceStoreAlias && !isDestructuringTemp) {
      markNamespaceStoreAlias()
      if (declKind) {
        declaredVars.add(baseName)
        return t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
        ])
      }
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), lowerAssignedValue(true)),
      )
    }

    if (declKind) {
      type VarDecl = 'const' | 'let' | 'var'
      const normalizedDecl: VarDecl =
        isStateCall || (dependsOnTracked && !isDestructuringTemp) ? 'const' : declKind
      const isExternalAlias =
        declKind === 'const' &&
        instr.value.kind === 'Identifier' &&
        !(ctx.scopes?.byName?.has(deSSAVarName(instr.value.name)) ?? false)
      const fallbackDecl: VarDecl =
        !treatAsTracked && (!dependsOnTracked || isDestructuringTemp)
          ? declKind === 'const' && (needsMutable || isExternalAlias)
            ? 'let'
            : declKind
          : normalizedDecl
      declaredVars.add(baseName)

      if (treatAsTracked && !isDestructuringTemp) {
        if (isStateCall) {
          // Set currentAssignmentName so the signal gets a name option for resumability
          ctx.currentAssignmentName = baseName
          try {
            return t.variableDeclaration(normalizedDecl, [
              t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
            ])
          } finally {
            ctx.currentAssignmentName = undefined
          }
        }

        if (dependsOnTracked) {
          markReactiveAliasIfNeeded()
          if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
            const derivedExpr = lowerAssignedValue(true)
            return createNonReactiveVarDecl(baseName, derivedExpr, ctx, t)
          }
          // fix: Don't wrap mutable variables in memo - they will be reassigned later
          // The containing region's memo will handle reactivity
          // Also remove from memoVars so wrapInMemo treats this as a getter output, not direct output
          if (needsMutable) {
            ctx.memoVars?.delete(baseName)
            const derivedExpr = lowerAssignedValue(true)
            markLocalValue()
            return t.variableDeclaration('let', [
              t.variableDeclarator(t.identifier(baseName), derivedExpr),
            ])
          }
          if (shouldEagerDerivedValue) {
            return t.variableDeclaration(normalizedDecl, [
              t.variableDeclarator(t.identifier(baseName), lowerEagerDerivedValue()),
            ])
          }
          const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
          // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
          trackDerivedMemoVar()
          if (shouldUseNoMemoDerivedValue) {
            return t.variableDeclaration(normalizedDecl, [
              t.variableDeclarator(
                t.identifier(baseName),
                buildNoMemoDerivedValue(derivedExpr, snapshots),
              ),
            ])
          }
          // Skip memo wrapping if expression already returns an accessor
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(t.identifier(baseName), buildDerivedValue(derivedExpr, snapshots)),
          ])
        }
      }

      if (dependsOnTracked && !isDestructuringTemp) {
        markReactiveAliasIfNeeded()
        if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
          const derivedExpr = lowerAssignedValue(true)
          return createNonReactiveVarDecl(baseName, derivedExpr, ctx, t)
        }
        // fix: Don't wrap mutable variables in memo - they will be reassigned later
        // The containing region's memo will handle reactivity
        // Also remove from memoVars so wrapInMemo treats this as a getter output, not direct output
        if (needsMutable) {
          ctx.memoVars?.delete(baseName)
          const derivedExpr = lowerAssignedValue(true)
          markLocalValue()
          return t.variableDeclaration('let', [
            t.variableDeclarator(t.identifier(baseName), derivedExpr),
          ])
        }
        if (shouldEagerDerivedValue) {
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(t.identifier(baseName), lowerEagerDerivedValue()),
          ])
        }
        const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
        // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
        trackDerivedMemoVar()
        if (shouldUseNoMemoDerivedValue) {
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(
              t.identifier(baseName),
              buildNoMemoDerivedValue(derivedExpr, snapshots),
            ),
          ])
        }
        // Skip memo wrapping if expression already returns an accessor
        return t.variableDeclaration(normalizedDecl, [
          t.variableDeclarator(t.identifier(baseName), buildDerivedValue(derivedExpr, snapshots)),
        ])
      }

      return applyLoc(
        t.variableDeclaration(fallbackDecl, [
          t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
        ]),
      )
    }

    if (!isSignal && aliasVars.has(baseName) && declaredVars.has(baseName)) {
      throwAliasReassignment()
    }

    if (capturedTracked && isSignal) {
      // Captured tracked binding from an outer scope - treat as setter call
      return t.expressionStatement(
        t.callExpression(t.identifier(baseName), [lowerAssignedValue(true)]),
      )
    }

    if (!isSignal && aliasVars.has(baseName) && !declaredVars.has(baseName)) {
      throwAliasReassignment()
    }

    // Handle tracked assignments to already-declared vars (e.g., let alias; alias = count)
    if (
      dependsOnTracked &&
      !declKind &&
      !isDestructuringTemp &&
      !isTracked &&
      !isSignal &&
      (isNamespaceAccessorAlias ||
        (instr.value.kind === 'Identifier' && ctx.trackedVars.has(deSSAVarName(instr.value.name))))
    ) {
      markReactiveAliasIfNeeded()

      if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
        const derivedExpr = lowerAssignedValue(true)
        return t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), derivedExpr),
        )
      }

      if (shouldEagerDerivedValue) {
        return t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), lowerEagerDerivedValue()),
        )
      }

      const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
      trackDerivedMemoVar()
      if (shouldUseNoMemoDerivedValue) {
        return t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.identifier(baseName),
            buildNoMemoDerivedValue(derivedExpr, snapshots),
          ),
        )
      }

      return t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.identifier(baseName),
          buildDerivedValue(derivedExpr, snapshots),
        ),
      )
    }

    if (declaredVars.has(baseName)) {
      if (!isSignal && aliasVars.has(baseName)) {
        throwAliasReassignment()
      }

      // Already declared - use assignment expression
      if (isSignal) {
        return t.expressionStatement(
          t.callExpression(t.identifier(baseName), [lowerAssignedValue(true)]),
        )
      }
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), lowerAssignedValue(true)),
      )
    }

    // If no declarationKind, this is a pure assignment (e.g. api = {...})
    // Emit setter call for signals, otherwise use assignment expression.
    if (!declKind) {
      if (isSignal) {
        return t.expressionStatement(
          t.callExpression(t.identifier(baseName), [lowerAssignedValue(true)]),
        )
      }
      return t.expressionStatement(
        t.assignmentExpression('=', t.identifier(baseName), lowerAssignedValue(true)),
      )
    }

    // First declaration - use let (allows reassignment)
    declaredVars.add(baseName)
    if (isTracked) {
      // $state calls remain signals; other tracked values become memos
      if (
        instr.value.kind === 'CallExpression' &&
        instr.value.callee.kind === 'Identifier' &&
        instr.value.callee.name === '$state'
      ) {
        return t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
        ])
      }

      if (dependsOnTracked) {
        if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
          const derivedExpr = lowerAssignedValue(true)
          return createNonReactiveVarDecl(baseName, derivedExpr, ctx, t)
        }
        // fix: Don't wrap mutable variables in memo - they will be reassigned later
        if (needsMutable) {
          const derivedExpr = lowerAssignedValue(true)
          markLocalValue()
          return t.variableDeclaration('let', [
            t.variableDeclarator(t.identifier(baseName), derivedExpr),
          ])
        }
        if (shouldEagerDerivedValue) {
          return t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier(baseName), lowerEagerDerivedValue()),
          ])
        }
        const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
        // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
        trackDerivedMemoVar()
        if (shouldUseNoMemoDerivedValue) {
          return t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(baseName),
              buildNoMemoDerivedValue(derivedExpr, snapshots),
            ),
          ])
        }
        // Skip memo wrapping if expression already returns an accessor
        return t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(baseName), buildDerivedValue(derivedExpr, snapshots)),
        ])
      }

      return t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
      ])
    }

    if (dependsOnTracked) {
      if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
        const derivedExpr = lowerAssignedValue(true)
        return createNonReactiveVarDecl(baseName, derivedExpr, ctx, t)
      }
      // fix: Don't wrap mutable variables in memo - they will be reassigned later
      if (needsMutable) {
        const derivedExpr = lowerAssignedValue(true)
        markLocalValue()
        return t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier(baseName), derivedExpr),
        ])
      }
      if (shouldEagerDerivedValue) {
        return t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(baseName), lowerEagerDerivedValue()),
        ])
      }
      const { expr: derivedExpr, snapshots } = lowerDerivedAssignedValue()
      // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
      trackDerivedMemoVar()
      if (shouldUseNoMemoDerivedValue) {
        return t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(baseName),
            buildNoMemoDerivedValue(derivedExpr, snapshots),
          ),
        ])
      }
      // Skip memo wrapping if expression already returns an accessor
      return t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(baseName), buildDerivedValue(derivedExpr, snapshots)),
      ])
    }

    return t.variableDeclaration('let', [
      t.variableDeclarator(
        t.identifier(baseName),
        lowerExpressionWithDeSSA(instr.value, ctx, true),
      ),
    ])
  }
  if (instr.kind === 'Expression') {
    const controlDeps = ctx.controlDepsByInstr?.get(instr) ?? new Set<string>()
    const hasTrackedControlDep = Array.from(controlDeps).some(dep =>
      ctx.trackedVars.has(deSSAVarName(dep)),
    )
    const usesTracked = expressionUsesTracked(instr.value, ctx)
    const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
    const shouldWrapExpr =
      ctx.wrapTrackedExpressions !== false &&
      !inNonReactiveScope &&
      (usesTracked || hasTrackedControlDep)
    if (shouldWrapExpr) {
      const depReads: BabelCore.types.Statement[] = []
      if (hasTrackedControlDep) {
        const uniqueDeps = new Set(Array.from(controlDeps).map(dep => deSSAVarName(dep)))
        uniqueDeps.forEach(dep => {
          if (!ctx.trackedVars.has(dep)) return
          const depExpr = buildDependencyGetter(dep, ctx)
          depReads.push(ctx.t.expressionStatement(depExpr))
        })
      }
      const loweredExpr = lowerExpressionWithDeSSA(instr.value, ctx)
      const effectBody =
        depReads.length > 0
          ? ctx.t.blockStatement([...depReads, ctx.t.expressionStatement(loweredExpr)])
          : loweredExpr
      const effectFn = ctx.t.isBlockStatement(effectBody)
        ? t.arrowFunctionExpression([], effectBody)
        : t.arrowFunctionExpression([], effectBody as BabelCore.types.Expression)
      // fix: Always use numbered slots for effects so they work when called
      // outside render context (e.g., in conditional callbacks that re-run).
      const slot = ctx.inModule ? undefined : reserveHookSlot(ctx)
      return applyLoc(t.expressionStatement(buildEffectCall(ctx, t, effectFn, { slot })))
    }
    return applyLoc(t.expressionStatement(lowerExpressionWithDeSSA(instr.value, ctx)))
  }
  if (instr.kind === 'Debugger') {
    return applyLoc(t.debuggerStatement())
  }
  // Phi nodes are handled by SSA elimination pass
  return null
}

/**
 * Lower expression with SSA name de-versioning
 */
function lowerExpressionWithDeSSA(
  expr: Expression,
  ctx: CodegenContext,
  isAssigned = false,
): BabelCore.types.Expression {
  const regionOverride =
    ctx.currentRegion ??
    (ctx.trackedVars.size
      ? {
          id: -1,
          dependencies: new Set(ctx.trackedVars),
          declarations: new Set<string>(),
          hasControlFlow: false,
          hasReactiveWrites: false,
        }
      : null)

  const lowered = lowerExpression(expr, ctx, isAssigned)
  let regionApplied: BabelCore.types.Expression

  if (ctx.t.isAssignmentExpression(lowered)) {
    const right = applyRegionMetadataToExpression(
      lowered.right,
      ctx,
      (regionOverride as RegionInfo | null) ?? undefined,
    )
    regionApplied = ctx.t.assignmentExpression(lowered.operator, lowered.left, right)
  } else if (ctx.t.isUpdateExpression(lowered)) {
    const arg = applyRegionMetadataToExpression(
      lowered.argument as BabelCore.types.Expression,
      ctx,
      (regionOverride as RegionInfo | null) ?? undefined,
    )
    regionApplied = ctx.t.updateExpression(
      lowered.operator,
      arg as BabelCore.types.Expression,
      lowered.prefix,
    )
  } else {
    regionApplied = applyRegionMetadataToExpression(
      lowered,
      ctx,
      (regionOverride as RegionInfo | null) ?? undefined,
    )
  }
  return deSSAExpression(regionApplied, ctx.t)
}

/**
 * Recursively de-version SSA names in an expression
 * Traverses all expression types and converts SSA names back to original names
 */
function deSSAExpression(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (t.isIdentifier(expr)) {
    return t.identifier(deSSAVarName(expr.name))
  }

  if (t.isMemberExpression(expr)) {
    const property = expr.property
    // If the property has been transformed to a CallExpression (e.g., reactive access),
    // we need to preserve it and mark as computed since CallExpression is not valid for non-computed access
    if (!expr.computed && t.isCallExpression(property)) {
      return t.memberExpression(
        deSSAExpression(expr.object as BabelCore.types.Expression, t),
        deSSAExpression(property, t),
        true, // Must be computed when property is a CallExpression
        expr.optional,
      )
    }
    return t.memberExpression(
      deSSAExpression(expr.object as BabelCore.types.Expression, t),
      expr.computed ? deSSAExpression(property as BabelCore.types.Expression, t) : property,
      expr.computed,
      expr.optional,
    )
  }

  if (t.isCallExpression(expr)) {
    return t.callExpression(
      deSSAExpression(expr.callee as BabelCore.types.Expression, t),
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(deSSAExpression(arg.argument, t))
        }
        if (t.isExpression(arg)) {
          return deSSAExpression(arg, t)
        }
        return arg
      }),
    )
  }

  if (t.isOptionalCallExpression(expr)) {
    return t.optionalCallExpression(
      deSSAExpression(expr.callee as BabelCore.types.Expression, t),
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(deSSAExpression(arg.argument, t))
        }
        if (t.isExpression(arg)) {
          return deSSAExpression(arg, t)
        }
        return arg
      }),
      expr.optional,
    )
  }

  if (t.isOptionalMemberExpression(expr)) {
    return t.optionalMemberExpression(
      deSSAExpression(expr.object as BabelCore.types.Expression, t),
      expr.computed
        ? deSSAExpression(expr.property as BabelCore.types.Expression, t)
        : expr.property,
      expr.computed,
      expr.optional,
    )
  }

  if (t.isBinaryExpression(expr)) {
    return t.binaryExpression(
      expr.operator,
      deSSAExpression(expr.left as BabelCore.types.Expression, t),
      deSSAExpression(expr.right as BabelCore.types.Expression, t),
    )
  }

  if (t.isUnaryExpression(expr)) {
    return t.unaryExpression(expr.operator, deSSAExpression(expr.argument, t), expr.prefix)
  }

  if (t.isLogicalExpression(expr)) {
    return t.logicalExpression(
      expr.operator,
      deSSAExpression(expr.left, t),
      deSSAExpression(expr.right, t),
    )
  }

  if (t.isConditionalExpression(expr)) {
    return t.conditionalExpression(
      deSSAExpression(expr.test, t),
      deSSAExpression(expr.consequent, t),
      deSSAExpression(expr.alternate, t),
    )
  }

  if (t.isArrayExpression(expr)) {
    return t.arrayExpression(
      expr.elements.map(el => {
        if (el === null) return null
        if (t.isSpreadElement(el)) {
          return t.spreadElement(deSSAExpression(el.argument, t))
        }
        if (t.isExpression(el)) {
          return deSSAExpression(el, t)
        }
        return el
      }),
    )
  }

  if (t.isObjectExpression(expr)) {
    return t.objectExpression(
      expr.properties.map(prop => {
        if (t.isSpreadElement(prop)) {
          return t.spreadElement(deSSAExpression(prop.argument, t))
        }
        if (t.isObjectProperty(prop)) {
          const key =
            prop.computed && t.isExpression(prop.key) ? deSSAExpression(prop.key, t) : prop.key
          const value = t.isExpression(prop.value) ? deSSAExpression(prop.value, t) : prop.value
          let keyName = ''
          if (!prop.computed && t.isIdentifier(prop.key)) {
            keyName = prop.key.name
          }
          const keyIsIdentifier = keyName !== ''
          const useShorthand =
            prop.shorthand &&
            keyIsIdentifier &&
            t.isIdentifier(value) &&
            deSSAVarName(keyName) === value.name
          const forceComputedProtoKey =
            prop.shorthand &&
            !useShorthand &&
            keyIsIdentifier &&
            deSSAVarName(keyName) === '__proto__'
          return t.objectProperty(
            forceComputedProtoKey ? t.stringLiteral('__proto__') : key,
            value,
            forceComputedProtoKey ? true : prop.computed,
            forceComputedProtoKey ? false : prop.shorthand,
          )
        }
        if (t.isObjectMethod(prop)) {
          // Object methods - de-SSA the body if needed
          return prop
        }
        return prop
      }),
    )
  }

  if (t.isArrowFunctionExpression(expr)) {
    // De-SSA parameters and body
    const params = expr.params.map(p => {
      if (t.isIdentifier(p)) {
        return t.identifier(deSSAVarName(p.name))
      }
      return p
    })
    const body = t.isExpression(expr.body) ? deSSAExpression(expr.body, t) : expr.body // Block body would need statement-level traversal
    return t.arrowFunctionExpression(params, body, expr.async)
  }

  if (t.isFunctionExpression(expr)) {
    const params = expr.params.map(p => {
      if (t.isIdentifier(p)) {
        return t.identifier(deSSAVarName(p.name))
      }
      return p
    })
    return t.functionExpression(
      expr.id ? t.identifier(deSSAVarName(expr.id.name)) : null,
      params,
      expr.body,
      expr.generator,
      expr.async,
    )
  }

  if (t.isAssignmentExpression(expr)) {
    const left = t.isIdentifier(expr.left)
      ? t.identifier(deSSAVarName(expr.left.name))
      : t.isMemberExpression(expr.left)
        ? (deSSAExpression(expr.left, t) as BabelCore.types.MemberExpression)
        : expr.left
    return t.assignmentExpression(
      expr.operator,
      left as BabelCore.types.LVal,
      deSSAExpression(expr.right, t),
    )
  }

  if (t.isUpdateExpression(expr)) {
    const arg = t.isIdentifier(expr.argument)
      ? t.identifier(deSSAVarName(expr.argument.name))
      : deSSAExpression(expr.argument as BabelCore.types.Expression, t)
    return t.updateExpression(expr.operator, arg as BabelCore.types.Expression, expr.prefix)
  }

  if (t.isSequenceExpression(expr)) {
    return t.sequenceExpression(expr.expressions.map(e => deSSAExpression(e, t)))
  }

  if (t.isTemplateLiteral(expr)) {
    return t.templateLiteral(
      expr.quasis,
      expr.expressions.map(e => deSSAExpression(e as BabelCore.types.Expression, t)),
    )
  }

  if (t.isTaggedTemplateExpression(expr)) {
    return t.taggedTemplateExpression(
      deSSAExpression(expr.tag, t),
      t.templateLiteral(
        expr.quasi.quasis,
        expr.quasi.expressions.map(e => deSSAExpression(e as BabelCore.types.Expression, t)),
      ),
    )
  }

  if (t.isNewExpression(expr)) {
    return t.newExpression(
      deSSAExpression(expr.callee as BabelCore.types.Expression, t),
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(deSSAExpression(arg.argument, t))
        }
        if (t.isExpression(arg)) {
          return deSSAExpression(arg, t)
        }
        return arg
      }),
    )
  }

  if (t.isAwaitExpression(expr)) {
    return t.awaitExpression(deSSAExpression(expr.argument, t))
  }

  if (t.isYieldExpression(expr)) {
    return t.yieldExpression(
      expr.argument ? deSSAExpression(expr.argument, t) : null,
      expr.delegate,
    )
  }

  if (t.isJSXElement(expr)) {
    // Recursively handle JSX expressions
    return deSSAJSXElement(expr, t)
  }

  if (t.isJSXFragment(expr)) {
    return t.jsxFragment(
      expr.openingFragment,
      expr.closingFragment,
      expr.children.map(child => deSSAJSXChild(child, t)),
    )
  }

  // For other expression types (literals, this, etc.), return as-is
  return expr
}

/**
 * De-SSA a JSX element recursively
 */
function deSSAJSXElement(
  elem: BabelCore.types.JSXElement,
  t: typeof BabelCore.types,
): BabelCore.types.JSXElement {
  // De-SSA attributes
  const attrs = elem.openingElement.attributes.map(attr => {
    if (t.isJSXAttribute(attr)) {
      if (t.isJSXExpressionContainer(attr.value)) {
        const expr = attr.value.expression
        if (t.isExpression(expr)) {
          return t.jsxAttribute(attr.name, t.jsxExpressionContainer(deSSAExpression(expr, t)))
        }
      }
      return attr
    }
    if (t.isJSXSpreadAttribute(attr)) {
      return t.jsxSpreadAttribute(deSSAExpression(attr.argument, t))
    }
    return attr
  })

  const opening = t.jsxOpeningElement(
    elem.openingElement.name,
    attrs,
    elem.openingElement.selfClosing,
  )

  const children = elem.children.map(child => deSSAJSXChild(child, t))

  return t.jsxElement(opening, elem.closingElement, children, elem.selfClosing)
}

/**
 * De-SSA a JSX child
 */
function deSSAJSXChild(
  child: BabelCore.types.JSXElement['children'][number],
  t: typeof BabelCore.types,
): BabelCore.types.JSXElement['children'][number] {
  if (t.isJSXExpressionContainer(child)) {
    const expr = child.expression
    if (t.isExpression(expr)) {
      return t.jsxExpressionContainer(deSSAExpression(expr, t))
    }
    return child
  }
  if (t.isJSXElement(child)) {
    return deSSAJSXElement(child, t)
  }
  if (t.isJSXFragment(child)) {
    return t.jsxFragment(
      child.openingFragment,
      child.closingFragment,
      child.children.map(c => deSSAJSXChild(c, t)),
    )
  }
  if (t.isJSXSpreadChild(child)) {
    return t.jsxSpreadChild(deSSAExpression(child.expression, t))
  }
  return child
}

/**
 * Convert HIR Expression to Babel AST Expression
 */
function exprToAST(
  expr: Expression | null | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (!expr) return voidZero(t)

  switch (expr.kind) {
    case 'Identifier':
      return t.identifier(expr.name)

    case 'Literal':
      if (expr.value === null) return t.nullLiteral()
      if (expr.value === undefined) return voidZero(t)
      if (typeof expr.value === 'string') return t.stringLiteral(expr.value)
      if (typeof expr.value === 'number') return numericValueExpression(expr.value, t)
      if (typeof expr.value === 'boolean') return t.booleanLiteral(expr.value)
      if (typeof expr.value === 'bigint') return t.bigIntLiteral(expr.value.toString())
      if (expr.value instanceof RegExp) {
        return t.regExpLiteral(expr.value.source, expr.value.flags)
      }
      return voidZero(t)

    case 'ImportExpression':
      return t.importExpression(
        exprToAST(expr.source, t),
        expr.options ? exprToAST(expr.options, t) : null,
      )

    case 'MetaProperty':
      return t.metaProperty(t.identifier(expr.meta.name), t.identifier(expr.property.name))

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as BabelCore.types.BinaryExpression['operator'],
        exprToAST(expr.left, t),
        exprToAST(expr.right, t),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as BabelCore.types.UnaryExpression['operator'],
        exprToAST(expr.argument, t),
        expr.prefix !== false,
      )

    case 'LogicalExpression':
      return t.logicalExpression(
        expr.operator as '&&' | '||' | '??',
        exprToAST(expr.left, t),
        exprToAST(expr.right, t),
      )

    case 'ConditionalExpression':
      return t.conditionalExpression(
        exprToAST(expr.test, t),
        exprToAST(expr.consequent, t),
        exprToAST(expr.alternate, t),
      )

    case 'CallExpression':
      return t.callExpression(
        exprToAST(expr.callee, t),
        expr.arguments.map(a => exprToAST(a, t)),
      )

    case 'MemberExpression':
      return t.memberExpression(
        exprToAST(expr.object, t),
        exprToAST(expr.property, t),
        expr.computed || false,
      )

    case 'ArrayExpression':
      return t.arrayExpression(
        expr.elements.map(el =>
          el ? exprToAST(el, t) : null,
        ) as (BabelCore.types.Expression | null)[],
      )

    case 'ObjectExpression':
      return t.objectExpression(
        expr.properties.map(p => {
          if (p.kind === 'SpreadElement') {
            return t.spreadElement(exprToAST(p.argument, t))
          }
          const key = exprToAST(p.key, t)
          const value = exprToAST(p.value, t)
          let keyName = ''
          if (!p.computed && p.key.kind === 'Identifier') {
            keyName = p.key.name
          }
          const keyIsIdentifier = keyName !== ''
          const useShorthand =
            p.shorthand &&
            keyIsIdentifier &&
            t.isIdentifier(value) &&
            deSSAVarName(keyName) === value.name
          const forceComputedProtoKey =
            p.shorthand && !useShorthand && keyIsIdentifier && deSSAVarName(keyName) === '__proto__'
          return t.objectProperty(
            forceComputedProtoKey ? t.stringLiteral('__proto__') : key,
            value,
            forceComputedProtoKey ? true : p.computed || false,
            forceComputedProtoKey ? false : p.shorthand || false,
          )
        }),
      )

    case 'ArrowFunction': {
      const params = expr.params.map(p => t.identifier(p.name))
      if (expr.isExpression && !Array.isArray(expr.body)) {
        return t.arrowFunctionExpression(params, exprToAST(expr.body, t))
      } else {
        // Block body - need to convert blocks to statements
        const stmts: BabelCore.types.Statement[] = []
        if (Array.isArray(expr.body)) {
          for (const block of expr.body) {
            if (block.instructions) {
              for (const instr of block.instructions) {
                if (instr.kind === 'Assign') {
                  stmts.push(
                    t.variableDeclaration('let', [
                      t.variableDeclarator(
                        t.identifier(instr.target.name),
                        exprToAST(instr.value, t),
                      ),
                    ]),
                  )
                } else if (instr.kind === 'Expression') {
                  stmts.push(t.expressionStatement(exprToAST(instr.value, t)))
                }
              }
            }
            if (block.terminator?.kind === 'Return') {
              stmts.push(
                t.returnStatement(
                  block.terminator.argument ? exprToAST(block.terminator.argument, t) : null,
                ),
              )
            }
          }
        }
        return t.arrowFunctionExpression(params, t.blockStatement(stmts))
      }
    }

    case 'FunctionExpression': {
      const fnParams = expr.params.map(p => t.identifier(p.name))
      return t.functionExpression(
        expr.name ? t.identifier(expr.name) : null,
        fnParams,
        t.blockStatement([]),
      )
    }

    case 'AssignmentExpression':
      return t.assignmentExpression(
        expr.operator || '=',
        exprToAST(expr.left, t) as BabelCore.types.LVal,
        exprToAST(expr.right, t),
      )

    case 'UpdateExpression':
      return t.updateExpression(
        expr.operator as '++' | '--',
        exprToAST(expr.argument, t) as BabelCore.types.Expression,
        expr.prefix || false,
      )

    case 'TemplateLiteral': {
      const quasis = expr.quasis.map((q, i, arr) =>
        templateElementFromQuasi(q, i === arr.length - 1, t),
      )
      const expressions = expr.expressions.map(e => exprToAST(e, t))
      return t.templateLiteral(quasis, expressions)
    }

    case 'SpreadElement':
      // Spread is handled in ArrayExpression/ObjectExpression, here just return the argument
      return exprToAST(expr.argument, t)

    case 'JSXElement':
      // Convert JSX to createElement call or return as-is if possible
      return jsxToAST(expr, t)

    default:
      // Unknown expression type - log warning and return undefined
      if (expr.kind) {
        debugWarn('region', `Unsupported expression kind: ${expr.kind}`)
      }
      return voidZero(t)
  }
}

/**
 * Convert JSX HIR to Babel JSX AST
 */
function jsxToAST(
  jsx: HJSXElementExpression | null | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.JSXElement {
  if (!jsx || jsx.kind !== 'JSXElement') {
    return t.jsxElement(t.jsxOpeningElement(t.jsxIdentifier('div'), [], true), null, [], true)
  }

  const tagName = typeof jsx.tagName === 'string' ? jsx.tagName : undefined
  const openingName = tagName ? t.jsxIdentifier(tagName) : t.jsxIdentifier('div')

  const attrs = jsx.attributes.map(attr => {
    if (attr.isSpread) {
      return t.jsxSpreadAttribute(exprToAST(attr.spreadExpr, t))
    }
    const name = t.jsxIdentifier(attr.name)
    let value: BabelCore.types.JSXAttribute['value'] = null
    if (attr.value !== undefined && attr.value !== null) {
      if (typeof attr.value === 'string') {
        value = t.stringLiteral(attr.value)
      } else {
        value = t.jsxExpressionContainer(exprToAST(attr.value, t))
      }
    }
    return t.jsxAttribute(name, value)
  })

  const children = jsx.children.map(child => {
    if (child.kind === 'text') {
      return t.jsxText(child.value)
    }
    if (child.kind === 'element') {
      return jsxToAST(child.value, t)
    }
    if (child.kind === 'expression') {
      return t.jsxExpressionContainer(exprToAST(child.value, t))
    }
    return t.jsxText('')
  })

  const opening = t.jsxOpeningElement(openingName, attrs, children.length === 0)
  const closing = children.length > 0 ? t.jsxClosingElement(openingName) : null

  return t.jsxElement(opening, closing, children, children.length === 0)
}

/**
 * Analyze a function and determine which regions need memoization
 */
export function analyzeRegionMemoization(regionResult: RegionResult): Map<number, boolean> {
  const shouldMemoize = new Map<number, boolean>()

  for (const region of regionResult.regions) {
    // Region should be memoized if:
    // 1. It has dependencies on reactive values
    // 2. It contains control flow
    // 3. It has JSX with dynamic bindings
    const needsMemo =
      region.dependencies.size > 0 ||
      region.hasControlFlow ||
      (region.hasJSX && region.dependencies.size > 0)

    shouldMemoize.set(region.id, needsMemo)
  }

  return shouldMemoize
}
