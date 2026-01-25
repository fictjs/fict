/**
 * Region Generation from HIR Reactive Scopes
 *
 * This module bridges HIR reactive scope analysis with fine-grained DOM generation.
 * It replaces the legacy findNextRegion/generateRegionMemo with a CFG-aware approach.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'
import { debugLog, debugWarn } from '../debug'
import type { RegionMetadata } from '../fine-grained-dom'

import type { CodegenContext, RegionInfo } from './codegen'
import {
  applyRegionToContext,
  applyRegionMetadataToExpression,
  buildDependencyGetter,
  lowerExpression,
  propagateHookResultAlias,
  resolveHookMemberValue,
} from './codegen'
import type { BlockId, HIRFunction, Expression, Instruction } from './hir'
import { getSSABaseName, HIRError } from './hir'
import type { ReactiveScope, ReactiveScopeResult } from './scopes'
import { getScopeDependencies } from './scopes'
import {
  analyzeObjectShapes,
  getPropertySubscription,
  shouldUseWholeObjectSubscription,
  type ShapeAnalysisResult,
} from './shapes'
import { structurizeCFG, StructurizationError, type StructuredNode } from './structurize'

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
  /** Whether this region should be memoized */
  shouldMemoize: boolean
  /** Child regions (for nested scopes) */
  children: Region[]
  /** Parent region ID if nested */
  parentId?: number
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

function buildEffectCall(
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  effectFn: BabelCore.types.Expression,
  options?: { slot?: number; forceSlot?: boolean },
): BabelCore.types.CallExpression {
  if (ctx.inModule) {
    ctx.helpersUsed.add('effect')
    return t.callExpression(t.identifier(RUNTIME_ALIASES.effect), [effectFn])
  }
  ctx.helpersUsed.add('useEffect')
  ctx.needsCtx = true
  const args: BabelCore.types.Expression[] = [t.identifier('__fictCtx'), effectFn]
  const slot = options?.slot
  if (options?.forceSlot) {
    args.push(slot !== undefined && slot >= 0 ? t.numericLiteral(slot) : t.identifier('undefined'))
  } else if (slot !== undefined && slot >= 0) {
    args.push(t.numericLiteral(slot))
  }
  return t.callExpression(t.identifier(RUNTIME_ALIASES.useEffect), args)
}

function buildMemoCall(
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  memoFn: BabelCore.types.Expression,
  slot?: number,
): BabelCore.types.CallExpression {
  if (ctx.inModule) {
    ctx.helpersUsed.add('memo')
    return t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [memoFn])
  }
  ctx.helpersUsed.add('useMemo')
  ctx.needsCtx = true
  const args: BabelCore.types.Expression[] = [t.identifier('__fictCtx'), memoFn]
  if (slot !== undefined && slot >= 0) {
    args.push(t.numericLiteral(slot))
  }
  return t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), args)
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
          : expressionContainsReactiveCreation(prop.value, memoMacroNames),
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
  }

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
    shouldMemoize: scope.shouldMemoize,
    children: [],
  }
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

function containsJSXExpr(expr: any): boolean {
  if (!expr || typeof expr !== 'object') return false
  if (expr.kind === 'JSXElement') return true

  // Recursively check nested expressions
  switch (expr.kind) {
    case 'CallExpression':
      if (containsJSXExpr(expr.callee)) return true
      return expr.arguments?.some((a: any) => containsJSXExpr(a)) ?? false
    case 'ArrayExpression':
      return expr.elements?.some((el: any) => containsJSXExpr(el)) ?? false
    case 'ObjectExpression':
      return (
        expr.properties?.some((p: any) =>
          p.kind === 'SpreadElement' ? containsJSXExpr(p.argument) : containsJSXExpr(p.value),
        ) ?? false
      )
    case 'ConditionalExpression':
      return containsJSXExpr(expr.consequent) || containsJSXExpr(expr.alternate)
    case 'ArrowFunction':
      return containsJSXExpr(expr.body)
    case 'SpreadElement':
      return containsJSXExpr(expr.argument)
    default:
      return false
  }

  return false
}

export function expressionUsesTracked(expr: Expression, ctx: CodegenContext): boolean {
  switch (expr.kind) {
    case 'Identifier':
      return (
        ctx.trackedVars.has(deSSAVarName(expr.name)) ||
        (ctx.externalTracked?.has(deSSAVarName(expr.name)) ?? false) ||
        (ctx.memoVars?.has(deSSAVarName(expr.name)) ?? false) ||
        (ctx.aliasVars?.has(deSSAVarName(expr.name)) ?? false)
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return expressionUsesTracked(expr.object as Expression, ctx)
    case 'CallExpression':
    case 'OptionalCallExpression':
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
        return expressionUsesTracked(p.value as Expression, ctx)
      })
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionUsesTracked(e as Expression, ctx))
    case 'SpreadElement':
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

/**
 * Context for tracking region emission during lowering
 */
interface RegionEmitContext {
  regionResult: RegionResult
  emittedRegions: Set<number>
  pendingInstructions: Map<number, Instruction[]>
  rootNode: StructuredNode
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
        pendingInstructions: new Map<number, Instruction[]>(),
        rootNode: node,
      }
    : undefined

  return lowerNodeWithRegionContext(node, t, ctx, declaredVars, regionCtx)
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
      const instructionBuffer: { instr: Instruction; region?: Region }[] = []

      for (const child of node.nodes) {
        if (child.kind === 'instruction') {
          const region = findRegionForInstruction(child.instruction, regionCtx)
          instructionBuffer.push({ instr: child.instruction, region })
        } else {
          // Flush pending instructions before control flow
          stmts.push(...flushInstructionBuffer(instructionBuffer, t, ctx, declaredVars, regionCtx))
          instructionBuffer.length = 0
          stmts.push(...lowerNodeWithRegionContext(child, t, ctx, declaredVars, regionCtx))
        }
      }
      // Flush remaining instructions
      stmts.push(...flushInstructionBuffer(instructionBuffer, t, ctx, declaredVars, regionCtx))
      return stmts
    }

    case 'block': {
      const stmts: BabelCore.types.Statement[] = []
      const scopedDeclared = new Set(declaredVars)
      const prevTracked = ctx.trackedVars
      ctx.trackedVars = new Set(ctx.trackedVars)
      for (const child of node.statements) {
        stmts.push(...lowerNodeWithRegionContext(child, t, ctx, scopedDeclared, regionCtx))
      }
      ctx.trackedVars = prevTracked
      return [t.blockStatement(stmts)]
    }

    case 'instruction': {
      // Single instruction - check if it belongs to a region
      const region = findRegionForInstruction(node.instruction, regionCtx)
      if (region && region.shouldMemoize && !regionCtx?.emittedRegions.has(region.id)) {
        // Emit the entire region with memo
        regionCtx?.emittedRegions.add(region.id)
        return generateRegionStatements(region, t, declaredVars, ctx, regionCtx)
      }
      // Not in a memoized region or region already emitted
      const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
      return stmt ? [stmt] : []
    }

    case 'return': {
      return [
        t.returnStatement(node.argument ? lowerExpressionWithDeSSA(node.argument, ctx) : null),
      ]
    }

    case 'throw': {
      return [t.throwStatement(lowerExpressionWithDeSSA(node.argument, ctx))]
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
      const conseqStmts = lowerNodeWithRegionContext(
        node.consequent,
        t,
        ctx,
        declaredVars,
        regionCtx,
      )
      const altStmts = node.alternate
        ? lowerNodeWithRegionContext(node.alternate, t, ctx, declaredVars, regionCtx)
        : null
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
        const runInScopeId = t.identifier(RUNTIME_ALIASES.runInScope)
        const addScoped = (
          flagExpr: BabelCore.types.Expression,
          body: BabelCore.types.Statement[],
        ) => {
          ctx.helpersUsed.add('runInScope')
          stmts.push(
            t.expressionStatement(
              t.callExpression(runInScopeId, [
                flagExpr,
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

      const ifStmt = t.ifStatement(
        testExpr,
        t.blockStatement(conseqStmts),
        altStmts ? t.blockStatement(altStmts) : null,
      )
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const shouldWrapEffect =
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        expressionUsesTracked(node.test, ctx) &&
        !statementHasEarlyExit(ifStmt, t)
      if (shouldWrapEffect) {
        const effectFn = t.arrowFunctionExpression([], t.blockStatement([ifStmt]))
        return [t.expressionStatement(buildEffectCall(ctx, t, effectFn))]
      }

      return [ifStmt]
    }

    case 'while': {
      const body = t.blockStatement(
        lowerNodeWithRegionContext(node.body, t, ctx, declaredVars, regionCtx),
      )
      return [t.whileStatement(lowerExpressionWithDeSSA(node.test, ctx), body)]
    }

    case 'doWhile': {
      const body = t.blockStatement(
        lowerNodeWithRegionContext(node.body, t, ctx, declaredVars, regionCtx),
      )
      return [t.doWhileStatement(lowerExpressionWithDeSSA(node.test, ctx), body)]
    }

    case 'for': {
      const init =
        node.init && node.init.length > 0 ? lowerInstructionsToInitExpr(node.init, t, ctx) : null
      const test = node.test ? lowerExpressionWithDeSSA(node.test, ctx) : null
      const update =
        node.update && node.update.length > 0
          ? lowerInstructionsToUpdateExpr(node.update, t, ctx)
          : null
      const body = t.blockStatement(
        lowerNodeWithRegionContext(node.body, t, ctx, declaredVars, regionCtx),
      )

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
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const right = lowerExpressionWithDeSSA(node.iterable, ctx)
      const body = t.blockStatement(
        lowerNodeWithRegionContext(node.body, t, ctx, declaredVars, regionCtx),
      )

      return [t.forOfStatement(left, right, body)]
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
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const right = lowerExpressionWithDeSSA(node.object, ctx)
      const body = t.blockStatement(
        lowerNodeWithRegionContext(node.body, t, ctx, declaredVars, regionCtx),
      )

      return [t.forInStatement(left, right, body)]
    }

    case 'switch': {
      const cases = node.cases.map(c => {
        const stmts = lowerNodeWithRegionContext(c.body, t, ctx, declaredVars, regionCtx)
        return t.switchCase(c.test ? lowerExpressionWithDeSSA(c.test, ctx) : null, stmts)
      })
      return [t.switchStatement(lowerExpressionWithDeSSA(node.discriminant, ctx), cases)]
    }

    case 'try': {
      const block = t.blockStatement(
        lowerNodeWithRegionContext(node.block, t, ctx, declaredVars, regionCtx),
      )
      const handler = node.handler
        ? t.catchClause(
            node.handler.param ? t.identifier(deSSAVarName(node.handler.param)) : null,
            t.blockStatement(
              lowerNodeWithRegionContext(node.handler.body, t, ctx, declaredVars, regionCtx),
            ),
          )
        : null
      const finalizer = node.finalizer
        ? t.blockStatement(
            lowerNodeWithRegionContext(node.finalizer, t, ctx, declaredVars, regionCtx),
          )
        : null

      return [t.tryStatement(block, handler, finalizer)]
    }

    case 'stateMachine': {
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
      const stateMachineDeclared = new Set(declaredVars)
      hoisted.forEach(n => stateMachineDeclared.add(n))

      // Fallback: generate a switch-based state machine
      // This handles non-structurable CFGs by emulating goto with a state variable
      const stateVar = t.identifier('__state')
      const stateDecl = t.variableDeclaration('let', [
        t.variableDeclarator(stateVar, t.numericLiteral(node.entryBlock)),
      ])

      // Generate switch cases for each block
      const cases: BabelCore.types.SwitchCase[] = []
      for (const block of normalizedBlocks) {
        const stmts: BabelCore.types.Statement[] = []

        // Lower instructions
        for (const instr of block.instructions) {
          const stmt = instructionToStatement(instr, t, stateMachineDeclared, ctx)
          if (stmt) stmts.push(stmt)
        }

        // Lower terminator
        stmts.push(...lowerTerminatorForStateMachine(block.terminator, t, ctx, stateVar))

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
  term: any,
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
      // State machine doesn't preserve break semantics perfectly
      // For labeled breaks, we'd need more complex handling
      return [t.breakStatement(term.label ? t.identifier(term.label) : t.identifier('__cfgLoop'))]

    case 'Continue':
      return [
        t.continueStatement(term.label ? t.identifier(term.label) : t.identifier('__cfgLoop')),
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

    case 'block': {
      const stmts: BabelCore.types.Statement[] = []
      const scopedDeclared = new Set(declaredVars)
      const prevTracked = ctx.trackedVars
      ctx.trackedVars = new Set(ctx.trackedVars)
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
      ctx.trackedVars = prevTracked
      if (stmts.length === 0) return []
      return [t.blockStatement(stmts)]
    }

    case 'instruction': {
      if (skipInstructions?.has(node.instruction)) return []
      const owner = findRegionForInstruction(node.instruction, regionCtx)
      if (!owner || owner.id !== region.id) return []
      const stmt = instructionToStatement(node.instruction, t, declaredVars, ctx)
      return stmt ? [stmt] : []
    }

    case 'if': {
      const inNonReactiveScope = !!(ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0)
      const baseShouldWrapEffect =
        ctx.wrapTrackedExpressions !== false &&
        !ctx.inRegionMemo &&
        !inNonReactiveScope &&
        expressionUsesTracked(node.test, ctx)
      const lowerChild = (
        child: StructuredNode | null | undefined,
        forceNonReactive: boolean,
      ): BabelCore.types.Statement[] => {
        if (!child) return []
        if (!forceNonReactive) {
          return lowerStructuredNodeForRegion(
            child,
            region,
            t,
            ctx,
            declaredVars,
            regionCtx,
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
            declaredVars,
            regionCtx,
            skipInstructions,
          )
        } finally {
          ctx.nonReactiveScopeDepth = prevDepth
        }
      }

      let consequent = lowerChild(node.consequent, baseShouldWrapEffect)
      let alternate = node.alternate ? lowerChild(node.alternate, baseShouldWrapEffect) : []
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
      const shouldWrapEffect = baseShouldWrapEffect && !statementHasEarlyExit(ifStmt, t)

      if (!shouldWrapEffect && baseShouldWrapEffect) {
        // Re-lower without the non-reactive guard to preserve previous behavior
        consequent = lowerChild(node.consequent, false)
        alternate = node.alternate ? lowerChild(node.alternate, false) : []
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
      const body = lowerStructuredNodeForRegion(
        node.body,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      if (body.length === 0) return []
      return [t.whileStatement(lowerExpressionWithDeSSA(node.test, ctx), t.blockStatement(body))]
    }

    case 'doWhile': {
      const body = lowerStructuredNodeForRegion(
        node.body,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      if (body.length === 0) return []
      return [t.doWhileStatement(lowerExpressionWithDeSSA(node.test, ctx), t.blockStatement(body))]
    }

    case 'for': {
      const body = lowerStructuredNodeForRegion(
        node.body,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      if (body.length === 0) return []
      const init =
        node.init && node.init.length > 0 ? lowerInstructionsToInitExpr(node.init, t, ctx) : null
      const test = node.test ? lowerExpressionWithDeSSA(node.test, ctx) : null
      const update =
        node.update && node.update.length > 0
          ? lowerInstructionsToUpdateExpr(node.update, t, ctx)
          : null
      return [t.forStatement(init, test, update, t.blockStatement(body))]
    }

    case 'forOf': {
      const body = lowerStructuredNodeForRegion(
        node.body,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      if (body.length === 0) return []
      const varKind = node.variableKind ?? 'const'
      const leftPattern = node.pattern
        ? (node.pattern as BabelCore.types.LVal)
        : t.identifier(deSSAVarName(node.variable))
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const right = lowerExpressionWithDeSSA(node.iterable, ctx)
      return [t.forOfStatement(left, right, t.blockStatement(body))]
    }

    case 'forIn': {
      const body = lowerStructuredNodeForRegion(
        node.body,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      if (body.length === 0) return []
      const varKind = node.variableKind ?? 'const'
      const leftPattern = node.pattern
        ? (node.pattern as BabelCore.types.LVal)
        : t.identifier(deSSAVarName(node.variable))
      const left = t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      const right = lowerExpressionWithDeSSA(node.object, ctx)
      return [t.forInStatement(left, right, t.blockStatement(body))]
    }

    case 'switch': {
      const cases = node.cases
        .map(c => {
          const stmts = lowerStructuredNodeForRegion(
            c.body,
            region,
            t,
            ctx,
            declaredVars,
            regionCtx,
            skipInstructions,
          )
          if (stmts.length === 0) return null
          return t.switchCase(c.test ? lowerExpressionWithDeSSA(c.test, ctx) : null, stmts)
        })
        .filter((c): c is BabelCore.types.SwitchCase => !!c)
      if (cases.length === 0) return []
      return [t.switchStatement(lowerExpressionWithDeSSA(node.discriminant, ctx), cases)]
    }

    case 'try': {
      const blockStmts = lowerStructuredNodeForRegion(
        node.block,
        region,
        t,
        ctx,
        declaredVars,
        regionCtx,
        skipInstructions,
      )
      const handlerStmts = node.handler
        ? lowerStructuredNodeForRegion(
            node.handler.body,
            region,
            t,
            ctx,
            declaredVars,
            regionCtx,
            skipInstructions,
          )
        : []
      const finalizerStmts = node.finalizer
        ? lowerStructuredNodeForRegion(
            node.finalizer,
            region,
            t,
            ctx,
            declaredVars,
            regionCtx,
            skipInstructions,
          )
        : []
      if (blockStmts.length === 0 && handlerStmts.length === 0 && finalizerStmts.length === 0) {
        return []
      }
      const handler = node.handler
        ? t.catchClause(
            node.handler.param ? t.identifier(deSSAVarName(node.handler.param)) : null,
            t.blockStatement(handlerStmts),
          )
        : null
      const finalizer = node.finalizer ? t.blockStatement(finalizerStmts) : null
      return [t.tryStatement(t.blockStatement(blockStmts), handler, finalizer)]
    }

    case 'break':
      return [t.breakStatement(node.label ? t.identifier(node.label) : null)]

    case 'continue':
      return [t.continueStatement(node.label ? t.identifier(node.label) : null)]

    case 'return':
    case 'throw':
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

/**
 * Flush pending instructions, emitting regions as needed
 */
function flushInstructionBuffer(
  buffer: { instr: Instruction; region?: Region }[],
  t: typeof BabelCore.types,
  ctx: CodegenContext,
  declaredVars: Set<string>,
  regionCtx?: RegionEmitContext,
): BabelCore.types.Statement[] {
  const stmts: BabelCore.types.Statement[] = []

  for (const item of buffer) {
    if (item.region) {
      if (regionCtx?.emittedRegions.has(item.region.id)) {
        continue
      }
      regionCtx?.emittedRegions.add(item.region.id)
      stmts.push(...generateRegionStatements(item.region, t, declaredVars, ctx, regionCtx))
      continue
    }

    const stmt = instructionToStatement(item.instr, t, declaredVars, ctx)
    if (stmt) stmts.push(stmt)
  }

  return stmts
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
          }
        }
        return t.variableDeclarator(
          t.identifier(deSSAVarName(i.target.name)),
          hookMember ? hookMember.member : lowerExpression(i.value, ctx),
        )
      }
      return t.variableDeclarator(t.identifier('_'))
    })
    return t.variableDeclaration('let', decls)
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
    return t.identifier('undefined')
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
    return t.identifier('undefined')
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
  const shouldInline =
    (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) ||
    ctx.noMemo ||
    !region.shouldMemoize ||
    (region.dependencies.size === 0 && !hasTrackedOutputs)

  const hoistedStatements: BabelCore.types.Statement[] = []
  const memoInstructions: Instruction[] = []
  const memoDeclarations = new Set(region.declarations)
  const hoistedInstructionSet = new Set<Instruction>()

  for (const instr of region.instructions) {
    if (
      instr.kind === 'Assign' &&
      instr.declarationKind &&
      instr.value.kind === 'CallExpression' &&
      instr.value.callee.kind === 'Identifier' &&
      (instr.value.callee.name === '$state' || instr.value.callee.name === '$store')
    ) {
      const stmt = instructionToStatement(instr, t, declaredVars, ctx)
      if (stmt) hoistedStatements.push(stmt)
      hoistedInstructionSet.add(instr)
      memoDeclarations.delete(instr.target.name)
      continue
    }
    memoInstructions.push(instr)
  }

  if (region.hasControlFlow && regionCtx?.rootNode) {
    const localDeclared = new Set<string>()
    const prevInRegionMemo = ctx.inRegionMemo
    if (!shouldInline) {
      ctx.inRegionMemo = true
    }
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
    if (shouldInline) {
      statements.push(...hoistedStatements)
      statements.push(...bodyStatements)
    } else {
      const outputNamesOverride = Array.from(memoDeclarations).map(name => deSSAVarName(name))
      statements.push(...hoistedStatements)
      statements.push(
        ...wrapInMemo(region, t, declaredVars, ctx, bodyStatements, outputNamesOverride),
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
      ctx.inRegionMemo = true
      for (const instr of memoInstructions) {
        const stmt = instructionToStatement(instr, t, localDeclared, ctx)
        if (stmt) bodyStatementsOverride.push(stmt)
      }
      ctx.inRegionMemo = prevInRegionMemo
    }
    statements.push(...hoistedStatements)
    const memoStatements = wrapInMemo(
      region,
      t,
      declaredVars,
      ctx,
      bodyStatementsOverride,
      outputNamesOverride,
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
): BabelCore.types.Statement[] {
  const statements: BabelCore.types.Statement[] = []
  const bodyStatements: BabelCore.types.Statement[] = []
  if (bodyStatementsOverride) {
    bodyStatements.push(...bodyStatementsOverride)
  } else {
    const localDeclared = new Set<string>()
    // Convert instructions to statements
    const prevInRegionMemo = ctx.inRegionMemo
    ctx.inRegionMemo = true
    for (const instr of region.instructions) {
      const stmt = instructionToStatement(instr, t, localDeclared, ctx)
      if (stmt) bodyStatements.push(stmt)
    }
    ctx.inRegionMemo = prevInRegionMemo
  }

  // Build return object with declarations - de-version SSA names
  const outputNames =
    outputNamesOverride ?? Array.from(region.declarations).map(name => deSSAVarName(name))
  // Remove duplicates that may result from de-versioning (e.g., count_1 and count_2 both become count)
  const uniqueOutputNames = [...new Set(outputNames)]
  const bindableOutputs = uniqueOutputNames.filter(name => !declaredVars.has(name))

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
      if (!region.hasControlFlow) {
        return t.objectProperty(t.identifier(name), t.identifier(name), false, true)
      }
      const guard = t.binaryExpression('!=', t.identifier(name), t.identifier('undefined'))
      const valueExpr = t.conditionalExpression(
        guard,
        t.identifier(name),
        t.identifier('undefined'),
      )
      return t.objectProperty(t.identifier(name), valueExpr)
    }
    const returnObj = t.objectExpression(uniqueOutputNames.map(name => buildOutputProperty(name)))

    const memoBody = t.blockStatement([...bodyStatements, t.returnStatement(returnObj)])

    const slot = ctx.inModule ? undefined : reserveHookSlot(ctx)
    const memoCall = buildMemoCall(ctx, t, t.arrowFunctionExpression([], memoBody), slot)

    const regionVarName = `__region_${region.id}`

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

    // Destructure outputs that are already accessors or non-reactive values.
    if (directOutputs.length > 0) {
      directOutputs.forEach(name => declaredVars.add(name))
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.objectPattern(
              directOutputs.map(name =>
                t.objectProperty(t.identifier(name), t.identifier(name), false, true),
              ),
            ),
            t.callExpression(t.identifier(regionVarName), []),
          ),
        ]),
      )
    }

    // Wrap pending outputs in getters that call the region accessor lazily.
    // These become memo-like getters that should be called with () when used.
    for (const name of getterOutputs) {
      declaredVars.add(name)
      const callRegion = t.callExpression(t.identifier(regionVarName), [])
      const baseAccess = t.memberExpression(callRegion, t.identifier(name))
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(name), t.arrowFunctionExpression([], baseAccess)),
        ]),
      )
      // Mark as a memo so buildDependencyGetter will add () when this name is used
      ctx.memoVars?.add(name)
    }

    if (region.hasControlFlow && getterOutputs.length > 0) {
      const effectBody = t.blockStatement(
        getterOutputs.map(name => t.expressionStatement(t.callExpression(t.identifier(name), []))),
      )
      statements.push(
        t.expressionStatement(
          buildEffectCall(ctx, t, t.arrowFunctionExpression([], effectBody), {
            slot: ctx.inModule ? undefined : reserveHookSlot(ctx),
            forceSlot: true,
          }),
        ),
      )
    }
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

  // Create return statement helper
  const createReturnWithNulls = (nullFields: Set<string>): BabelCore.types.ReturnStatement => {
    return t.returnStatement(
      t.objectExpression(
        orderedOutputs.map(name => {
          if (nullFields.has(name)) {
            return t.objectProperty(t.identifier(name), t.nullLiteral())
          }
          return t.objectProperty(t.identifier(name), t.identifier(name), false, true)
        }),
      ),
    )
  }

  // Build memo body with conditional evaluation
  const memoBody: BabelCore.types.Statement[] = [conditionDecl, ...alwaysBeforeLazy]

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

  const regionVarName = `__region_${region.id}`

  const memoCall = buildMemoCall(
    ctx,
    t,
    t.arrowFunctionExpression([], t.blockStatement(memoBody)),
    ctx.inModule ? undefined : reserveHookSlot(ctx),
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
          orderedOutputs.map(name =>
            t.objectProperty(t.identifier(name), t.identifier(name), false, true),
          ),
        ),
        t.identifier(regionVarName),
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

function instructionToStatement(
  instr: Instruction,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
  _buildMemoCall?: (expr: BabelCore.types.Expression, name?: string) => BabelCore.types.Expression,
): BabelCore.types.Statement | null {
  if (instr.kind === 'Assign') {
    const ssaName = instr.target.name
    const baseName = deSSAVarName(ssaName)
    const memoMacroNames = ctx.memoMacroNames ?? new Set(['$memo', 'createMemo'])
    const declKindRaw = instr.declarationKind
    propagateHookResultAlias(baseName, instr.value, ctx)
    const hookMember = resolveHookMemberValue(instr.value, ctx)
    if (hookMember) {
      if (hookMember.kind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
      } else if (hookMember.kind === 'memo') {
        ctx.memoVars?.add(baseName)
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
      (declKindRaw === 'function' || (!declKindRaw && (instr.value as any).name === baseName))
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
    const isTracked = ctx.trackedVars.has(baseName)
    const isSignal = ctx.signalVars?.has(baseName) ?? false
    const aliasVars = ctx.aliasVars ?? (ctx.aliasVars = new Set())
    // Check both expression-level dependencies AND pre-computed memoVars (from computeReactiveAccessors)
    // This handles cases where dependencies are inside callbacks (e.g., array.find(n => n === target))
    const dependsOnTracked =
      expressionUsesTracked(instr.value, ctx) || (ctx.memoVars?.has(baseName) ?? false)
    const capturedTracked =
      ctx.externalTracked && ctx.externalTracked.has(baseName) && !declaredVars.has(baseName)
    const isShadowDeclaration = !!declKind && declaredVars.has(baseName)
    const treatAsTracked = !isShadowDeclaration && isTracked
    const isDestructuringTemp = baseName.startsWith('__destruct_')
    const isStateCall =
      instr.value.kind === 'CallExpression' &&
      instr.value.callee.kind === 'Identifier' &&
      instr.value.callee.name === '$state'
    const inRegionMemo = ctx.inRegionMemo ?? false
    const isFunctionValue =
      instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression'
    // Detect accessor-returning calls ($memo, createMemo, prop) - these return accessors and should be added to memoVars
    const isAccessorReturningCall =
      instr.value.kind === 'CallExpression' &&
      instr.value.callee.kind === 'Identifier' &&
      (memoMacroNames.has(instr.value.callee.name) || instr.value.callee.name === 'prop')
    // Detect reactive object calls (mergeProps) - these return objects/getters, not accessors
    // They should NOT be wrapped in __fictUseMemo AND should NOT be added to memoVars
    const isReactiveObjectCall =
      instr.value.kind === 'CallExpression' &&
      instr.value.callee.kind === 'Identifier' &&
      ['mergeProps'].includes(instr.value.callee.name)
    // Combined check for skipping memo wrapping
    const isMemoReturningCall = isAccessorReturningCall || isReactiveObjectCall
    const lowerAssignedValue = (forceAssigned = false) =>
      lowerExpressionWithDeSSA(instr.value, ctx, forceAssigned || isFunctionValue)
    const buildDerivedMemoCall = (expr: BabelCore.types.Expression) => {
      const slot = !ctx.inModule && inRegionMemo ? reserveHookSlot(ctx) : undefined
      return buildMemoCall(ctx, t, t.arrowFunctionExpression([], expr), slot)
    }

    if (isShadowDeclaration && declKind) {
      ctx.trackedVars.delete(baseName)
    }

    if (declKind) {
      type VarDecl = 'const' | 'let' | 'var'
      const normalizedDecl: VarDecl =
        isStateCall || (dependsOnTracked && !isDestructuringTemp) ? 'const' : declKind
      const needsMutable = ctx.mutatedVars?.has(baseName) ?? false
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
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
          ])
        }

        if (dependsOnTracked) {
          if (
            instr.value.kind === 'Identifier' &&
            ctx.trackedVars.has(deSSAVarName(instr.value.name)) &&
            !isDestructuringTemp
          ) {
            aliasVars.add(baseName)
          }
          const derivedExpr = lowerAssignedValue(true)
          if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
            return t.variableDeclaration(normalizedDecl, [
              t.variableDeclarator(t.identifier(baseName), derivedExpr),
            ])
          }
          // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
          if (!isReactiveObjectCall) ctx.memoVars?.add(baseName)
          if (ctx.noMemo) {
            return t.variableDeclaration(normalizedDecl, [
              t.variableDeclarator(
                t.identifier(baseName),
                t.arrowFunctionExpression([], derivedExpr),
              ),
            ])
          }
          // Skip memo wrapping if expression already returns an accessor
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(
              t.identifier(baseName),
              isMemoReturningCall ? derivedExpr : buildDerivedMemoCall(derivedExpr),
            ),
          ])
        }
      }

      if (dependsOnTracked && !isDestructuringTemp) {
        if (
          instr.value.kind === 'Identifier' &&
          ctx.trackedVars.has(deSSAVarName(instr.value.name)) &&
          !isDestructuringTemp
        ) {
          aliasVars.add(baseName)
        }
        const derivedExpr = lowerAssignedValue(true)
        if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(t.identifier(baseName), derivedExpr),
          ])
        }
        // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
        if (!isReactiveObjectCall) ctx.memoVars?.add(baseName)
        if (ctx.noMemo) {
          return t.variableDeclaration(normalizedDecl, [
            t.variableDeclarator(
              t.identifier(baseName),
              t.arrowFunctionExpression([], derivedExpr),
            ),
          ])
        }
        // Skip memo wrapping if expression already returns an accessor
        return t.variableDeclaration(normalizedDecl, [
          t.variableDeclarator(
            t.identifier(baseName),
            isMemoReturningCall ? derivedExpr : buildDerivedMemoCall(derivedExpr),
          ),
        ])
      }

      return t.variableDeclaration(fallbackDecl, [
        t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
      ])
    }

    if (aliasVars.has(baseName) && declaredVars.has(baseName)) {
      throw new Error(
        `Alias reassignment is not supported for "${baseName}".\n\n` +
          `"${baseName}" was assigned from a reactive value and cannot be reassigned.\n` +
          `Consider:\n` +
          `  - Using a new variable name for the new value\n` +
          `  - Updating the original reactive source instead`,
      )
    }

    if (capturedTracked && isSignal) {
      // Captured tracked binding from an outer scope - treat as setter call
      return t.expressionStatement(
        t.callExpression(t.identifier(baseName), [lowerAssignedValue(true)]),
      )
    }

    if (aliasVars.has(baseName) && !declaredVars.has(baseName)) {
      throw new Error(
        `Alias reassignment is not supported for "${baseName}".\n\n` +
          `"${baseName}" was assigned from a reactive value and cannot be reassigned.\n` +
          `Consider:\n` +
          `  - Using a new variable name for the new value\n` +
          `  - Updating the original reactive source instead`,
      )
    }

    // Handle tracked assignments to already-declared vars (e.g., let alias; alias = count)
    if (
      dependsOnTracked &&
      !declKind &&
      !isDestructuringTemp &&
      !isTracked &&
      !isSignal &&
      instr.value.kind === 'Identifier' &&
      ctx.trackedVars.has(deSSAVarName(instr.value.name))
    ) {
      const derivedExpr = lowerAssignedValue(true)
      aliasVars.add(baseName)

      if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
        return t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), derivedExpr),
        )
      }

      if (!isReactiveObjectCall) ctx.memoVars?.add(baseName)
      if (ctx.noMemo) {
        return t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.identifier(baseName),
            t.arrowFunctionExpression([], derivedExpr),
          ),
        )
      }

      return t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.identifier(baseName),
          isMemoReturningCall ? derivedExpr : buildDerivedMemoCall(derivedExpr),
        ),
      )
    }

    if (declaredVars.has(baseName)) {
      if (aliasVars.has(baseName)) {
        throw new Error(
          `Alias reassignment is not supported for "${baseName}".\n\n` +
            `"${baseName}" was assigned from a reactive value and cannot be reassigned.\n` +
            `Consider:\n` +
            `  - Using a new variable name for the new value\n` +
            `  - Updating the original reactive source instead`,
        )
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
    // Emit assignmentExpression to update existing variable, not create new declaration
    if (!declKind) {
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
        const derivedExpr = lowerAssignedValue(true)
        if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
          return t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier(baseName), derivedExpr),
          ])
        }
        // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
        if (!isReactiveObjectCall) ctx.memoVars?.add(baseName)
        if (ctx.noMemo) {
          return t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(baseName),
              t.arrowFunctionExpression([], derivedExpr),
            ),
          ])
        }
        // Skip memo wrapping if expression already returns an accessor
        return t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(baseName),
            isMemoReturningCall ? derivedExpr : buildDerivedMemoCall(derivedExpr),
          ),
        ])
      }

      return t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(baseName), lowerAssignedValue(true)),
      ])
    }

    if (dependsOnTracked) {
      const derivedExpr = lowerAssignedValue(true)
      if (ctx.nonReactiveScopeDepth && ctx.nonReactiveScopeDepth > 0) {
        return t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier(baseName), derivedExpr),
        ])
      }
      // Track as memo only for accessor-returning calls - reactive objects shouldn't be treated as accessors
      if (!isReactiveObjectCall) ctx.memoVars?.add(baseName)
      if (ctx.noMemo) {
        return t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(baseName), t.arrowFunctionExpression([], derivedExpr)),
        ])
      }
      // Skip memo wrapping if expression already returns an accessor
      return t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(baseName),
          isMemoReturningCall ? derivedExpr : buildDerivedMemoCall(derivedExpr),
        ),
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
      return t.expressionStatement(buildEffectCall(ctx, t, effectFn))
    }
    return t.expressionStatement(lowerExpressionWithDeSSA(instr.value, ctx))
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
    regionApplied = ctx.t.updateExpression(lowered.operator, arg as any, lowered.prefix)
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
          return t.objectProperty(key, value, prop.computed, prop.shorthand)
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
function exprToAST(expr: any, t: typeof BabelCore.types): BabelCore.types.Expression {
  if (!expr) return t.identifier('undefined')

  switch (expr.kind) {
    case 'Identifier':
      return t.identifier(expr.name)

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
      return t.importExpression(exprToAST(expr.source, t))

    case 'MetaProperty':
      return t.metaProperty(t.identifier(expr.meta.name), t.identifier(expr.property.name))

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as any,
        exprToAST(expr.left, t),
        exprToAST(expr.right, t),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as any,
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
        (expr.arguments || []).map((a: any) => exprToAST(a, t)),
      )

    case 'MemberExpression':
      return t.memberExpression(
        exprToAST(expr.object, t),
        exprToAST(expr.property, t),
        expr.computed || false,
      )

    case 'ArrayExpression':
      return t.arrayExpression(
        (expr.elements || []).map((el: any) =>
          el ? exprToAST(el, t) : null,
        ) as (BabelCore.types.Expression | null)[],
      )

    case 'ObjectExpression':
      return t.objectExpression(
        (expr.properties || []).map((p: any) => {
          if (p.kind === 'SpreadElement') {
            return t.spreadElement(exprToAST(p.argument, t))
          }
          return t.objectProperty(
            exprToAST(p.key, t),
            exprToAST(p.value, t),
            p.computed || false,
            p.shorthand || false,
          )
        }),
      )

    case 'ArrowFunction': {
      const params = (expr.params || []).map((p: any) => t.identifier(p.name))
      if (expr.isExpression) {
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
      const fnParams = (expr.params || []).map((p: any) => t.identifier(p.name))
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
      const quasis = (expr.quasis || []).map((q: string, i: number, arr: any[]) =>
        t.templateElement({ raw: q, cooked: q }, i === arr.length - 1),
      )
      const expressions = (expr.expressions || []).map((e: any) => exprToAST(e, t))
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
      return t.identifier('undefined')
  }
}

/**
 * Convert JSX HIR to Babel JSX AST
 */
function jsxToAST(jsx: any, t: typeof BabelCore.types): BabelCore.types.Expression {
  if (!jsx || jsx.kind !== 'JSXElement') {
    return t.identifier('undefined')
  }

  const tagName = typeof jsx.tagName === 'string' ? jsx.tagName : undefined
  const openingName = tagName ? t.jsxIdentifier(tagName) : t.jsxIdentifier('div')

  const attrs = (jsx.attributes || []).map((attr: any) => {
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

  const children = (jsx.children || []).map((child: any) => {
    if (child.kind === 'text') {
      return t.jsxText(child.value)
    }
    if (child.kind === 'element') {
      return jsxToAST(child.value, t) as any
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
