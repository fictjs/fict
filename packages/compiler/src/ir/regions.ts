/**
 * Region Generation from HIR Reactive Scopes
 *
 * This module bridges HIR reactive scope analysis with fine-grained DOM generation.
 * It replaces the legacy findNextRegion/generateRegionMemo with a CFG-aware approach.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'
import type { RegionMetadata } from '../fine-grained-dom'

import type { CodegenContext, RegionInfo } from './codegen'
import { applyRegionToContext, applyRegionMetadataToExpression, lowerExpression } from './codegen'
import type { BasicBlock, BlockId, HIRFunction, HIRProgram, Expression, Instruction } from './hir'
import type { ReactiveScope, ReactiveScopeResult } from './scopes'
import { getScopeDependencies } from './scopes'
import { structurizeCFG, type StructuredNode } from './structurize'
import {
  analyzeObjectShapes,
  getPropertySubscription,
  shouldUseWholeObjectSubscription,
  type ShapeAnalysisResult,
} from './shapes'

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

    // Check terminator for control flow
    if (block.terminator.kind === 'Branch' || block.terminator.kind === 'Switch') {
      hasControlFlow = true
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
    const baseName = dep.split('.')[0]
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
    const phi = instr as any
    return scope.writes.has(phi.target.name) || scope.declarations.has(phi.target.name)
  }
  if (instr.kind === 'Expression') {
    // Include all expression instructions (side effects, console.log, $effect calls, etc.)
    return true
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
      return expr.properties?.some((p: any) => containsJSXExpr(p.value)) ?? false
    case 'ConditionalExpression':
      return containsJSXExpr(expr.consequent) || containsJSXExpr(expr.alternate)
    case 'ArrowFunction':
      return containsJSXExpr(expr.body)
    default:
      return false
  }

  return false
}

function expressionUsesTracked(expr: Expression, ctx: CodegenContext): boolean {
  switch (expr.kind) {
    case 'Identifier':
      return ctx.trackedVars.has(deSSAVarName(expr.name))
    case 'MemberExpression':
      return expressionUsesTracked(expr.object as Expression, ctx)
    case 'CallExpression':
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
    default:
      return false
  }
}

/**
 * Determine region hierarchy (nesting) based on block containment
 */
function determineRegionHierarchy(regions: Region[]): Region[] {
  const topLevel: Region[] = []

  // Sort regions by size (smaller first, so inner regions are processed before outer)
  const sorted = [...regions].sort((a, b) => a.blocks.size - b.blocks.size)

  for (const region of sorted) {
    let parent: Region | undefined

    // Find the smallest containing region
    for (const candidate of sorted) {
      if (candidate.id === region.id) continue
      if (candidate.blocks.size <= region.blocks.size) continue

      // Check if candidate contains all blocks of region
      let contains = true
      for (const blockId of region.blocks) {
        if (!candidate.blocks.has(blockId)) {
          contains = false
          break
        }
      }

      if (contains) {
        if (!parent || parent.blocks.size > candidate.blocks.size) {
          parent = candidate
        }
      }
    }

    if (parent) {
      region.parentId = parent.id
      parent.children.push(region)
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
  const structured = structurizeCFG(fn)

  // Lower structured code with region awareness
  return lowerStructuredNodeWithRegions(structured, regionResult, t, ctx, declaredVars)
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
      for (const child of node.statements) {
        stmts.push(...lowerNodeWithRegionContext(child, t, ctx, declaredVars, regionCtx))
      }
      return stmts
    }

    case 'instruction': {
      // Single instruction - check if it belongs to a region
      const region = findRegionForInstruction(node.instruction, regionCtx)
      if (region && region.shouldMemoize && !regionCtx?.emittedRegions.has(region.id)) {
        // Emit the entire region with memo
        regionCtx?.emittedRegions.add(region.id)
        return generateRegionStatements(region, t, declaredVars, ctx)
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
      const conseq = t.blockStatement(
        lowerNodeWithRegionContext(node.consequent, t, ctx, declaredVars, regionCtx),
      )
      const alt = node.alternate
        ? t.blockStatement(
            lowerNodeWithRegionContext(node.alternate, t, ctx, declaredVars, regionCtx),
          )
        : null

      return [t.ifStatement(lowerExpressionWithDeSSA(node.test, ctx), conseq, alt)]
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
  const regionGroups = new Map<number, { region: Region; instrs: Instruction[] }>()
  const noRegionInstrs: Instruction[] = []

  // Group instructions by region
  for (const item of buffer) {
    if (item.region) {
      const existing = regionGroups.get(item.region.id)
      if (existing) {
        existing.instrs.push(item.instr)
      } else {
        regionGroups.set(item.region.id, { region: item.region, instrs: [item.instr] })
      }
    } else {
      noRegionInstrs.push(item.instr)
    }
  }

  // Emit regions with memo if needed
  for (const [regionId, { region }] of regionGroups) {
    if (regionCtx?.emittedRegions.has(regionId)) {
      // Region already emitted, skip
      continue
    }
    regionCtx?.emittedRegions.add(regionId)
    stmts.push(...generateRegionStatements(region, t, declaredVars, ctx))
  }

  // Emit non-region instructions directly
  for (const instr of noRegionInstrs) {
    const stmt = instructionToStatement(instr, t, declaredVars, ctx)
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
        return t.variableDeclarator(
          t.identifier(deSSAVarName(i.target.name)),
          lowerExpression(i.value, ctx),
        )
      }
      return t.variableDeclarator(t.identifier('_'))
    })
    return t.variableDeclaration('let', decls)
  }

  // Otherwise use sequence expression
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

/**
 * Remove SSA version suffix from variable name.
 * Exported for use in codegen.ts and other modules that need SSA de-versioning.
 */
export function deSSAVarName(name: string): string {
  // Skip internal names that start with __ (these are compiler-generated)
  if (name.startsWith('__')) return name
  const match = name.match(/^(.+?)_\d+$/)
  return match ? match[1] : name
}

/**
 * Generate statements for a single region
 */
function generateRegionStatements(
  region: Region,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
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

  if (!region.shouldMemoize || region.dependencies.size === 0) {
    // No memoization needed - just emit instructions directly
    for (const instr of region.instructions) {
      const stmt = instructionToStatement(instr, t, declaredVars, ctx)
      if (stmt) statements.push(stmt)
    }
  } else {
    // Wrap in memo
    const memoStatements = wrapInMemo(region, t, declaredVars, ctx)
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
): BabelCore.types.Statement[] {
  const statements: BabelCore.types.Statement[] = []
  const bodyStatements: BabelCore.types.Statement[] = []
  const localDeclared = new Set<string>()
  ctx.helpersUsed.add('useMemo')

  // Convert instructions to statements
  for (const instr of region.instructions) {
    const stmt = instructionToStatement(instr, t, localDeclared, ctx)
    if (stmt) bodyStatements.push(stmt)
  }

  // Build return object with declarations - de-version SSA names
  const outputNames = Array.from(region.declarations).map(name => deSSAVarName(name))
  // Remove duplicates that may result from de-versioning (e.g., count_1 and count_2 both become count)
  const uniqueOutputNames = [...new Set(outputNames)]

  if (uniqueOutputNames.length === 0) {
    // No outputs - just execute for side effects
    const effectCall = t.callExpression(t.identifier('__fictUseMemo'), [
      t.identifier('__fictCtx'),
      t.arrowFunctionExpression([], t.blockStatement(bodyStatements)),
      t.numericLiteral(region.id),
    ])
    statements.push(t.expressionStatement(effectCall))
  } else {
    // Has outputs - memo with destructuring
    const returnObj = t.objectExpression(
      uniqueOutputNames.map(name =>
        t.objectProperty(t.identifier(name), t.identifier(name), false, true),
      ),
    )

    const memoBody = t.blockStatement([...bodyStatements, t.returnStatement(returnObj)])

    const memoCall = t.callExpression(t.identifier('__fictUseMemo'), [
      t.identifier('__fictCtx'),
      t.arrowFunctionExpression([], memoBody),
      t.numericLiteral(region.id),
    ])

    const regionVarName = `__region_${region.id}`

    // Declare region variable
    statements.push(
      t.variableDeclaration('const', [t.variableDeclarator(t.identifier(regionVarName), memoCall)]),
    )

    // Destructure outputs - mark them as declared
    for (const name of uniqueOutputNames) {
      declaredVars.add(name)
    }
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.objectPattern(
            uniqueOutputNames.map(name =>
              t.objectProperty(t.identifier(name), t.identifier(name), false, true),
            ),
          ),
          t.identifier(regionVarName),
        ),
      ]),
    )
  }

  return statements
}

/**
 * Convert an instruction to a Babel statement
 * Handles SSA name de-versioning
 */
function instructionToStatement(
  instr: Instruction,
  t: typeof BabelCore.types,
  declaredVars: Set<string>,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  if (instr.kind === 'Assign') {
    const ssaName = instr.target.name
    const baseName = deSSAVarName(ssaName)
    const isTracked = ctx.trackedVars.has(baseName)
    const aliasVars = ctx.aliasVars ?? (ctx.aliasVars = new Set())
    const dependsOnTracked = expressionUsesTracked(instr.value, ctx)
    const capturedTracked =
      ctx.externalTracked && ctx.externalTracked.has(baseName) && !declaredVars.has(baseName)

    if (aliasVars.has(baseName) && declaredVars.has(baseName)) {
      throw new Error(`Alias reassignment is not supported for "${baseName}"`)
    }

    if (capturedTracked && isTracked) {
      // Captured tracked binding from an outer scope - treat as setter call
      return t.expressionStatement(
        t.callExpression(t.identifier(baseName), [lowerExpressionWithDeSSA(instr.value, ctx)]),
      )
    }

    // Alias of a tracked variable: const alias = count -> const alias = () => count()
    if (instr.value.kind === 'Identifier') {
      const source = deSSAVarName(instr.value.name)
      if (ctx.trackedVars.has(source) && !declaredVars.has(baseName)) {
        aliasVars.add(baseName)
        ctx.trackedVars.add(baseName)
        return t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(baseName),
            t.arrowFunctionExpression([], t.callExpression(t.identifier(source), [])),
          ),
        ])
      }
    }

    if (aliasVars.has(baseName) && !declaredVars.has(baseName)) {
      throw new Error(`Alias reassignment is not supported for "${baseName}"`)
    }

    if (declaredVars.has(baseName)) {
      if (aliasVars.has(baseName)) {
        throw new Error(`Alias reassignment is not supported for "${baseName}"`)
      }

      // Already declared - use assignment expression
      if (isTracked) {
        return t.expressionStatement(
          t.callExpression(t.identifier(baseName), [lowerExpressionWithDeSSA(instr.value, ctx)]),
        )
      }
      return t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.identifier(baseName),
          lowerExpressionWithDeSSA(instr.value, ctx),
        ),
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
          t.variableDeclarator(t.identifier(baseName), lowerExpressionWithDeSSA(instr.value, ctx)),
        ])
      }

      if (dependsOnTracked) {
        ctx.helpersUsed.add('useMemo')
        ctx.needsCtx = true
        return t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(baseName),
            t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), [
              t.identifier('__fictCtx'),
              t.arrowFunctionExpression([], lowerExpressionWithDeSSA(instr.value, ctx)),
            ]),
          ),
        ])
      }

      return t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(baseName), lowerExpressionWithDeSSA(instr.value, ctx)),
      ])
    }

    if (dependsOnTracked) {
      ctx.helpersUsed.add('useMemo')
      ctx.needsCtx = true
      return t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(baseName),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), [
            t.identifier('__fictCtx'),
            t.arrowFunctionExpression([], lowerExpressionWithDeSSA(instr.value, ctx)),
          ]),
        ),
      ])
    }

    return t.variableDeclaration('let', [
      t.variableDeclarator(t.identifier(baseName), lowerExpressionWithDeSSA(instr.value, ctx)),
    ])
  }
  if (instr.kind === 'Expression') {
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

  const result = lowerExpression(expr, ctx)
  const regionApplied = applyRegionMetadataToExpression(
    result,
    ctx,
    (regionOverride as RegionInfo | null) ?? undefined,
  )
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
    return t.memberExpression(
      deSSAExpression(expr.object as BabelCore.types.Expression, t),
      expr.computed
        ? deSSAExpression(expr.property as BabelCore.types.Expression, t)
        : expr.property,
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
      if (expr.value instanceof RegExp) {
        return t.regExpLiteral(expr.value.source, expr.value.flags)
      }
      return t.identifier('undefined')

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

    case 'ArrowFunction':
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

    case 'FunctionExpression':
      const fnParams = (expr.params || []).map((p: any) => t.identifier(p.name))
      return t.functionExpression(
        expr.name ? t.identifier(expr.name) : null,
        fnParams,
        t.blockStatement([]),
      )

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

    case 'TemplateLiteral':
      const quasis = (expr.quasis || []).map((q: string, i: number, arr: any[]) =>
        t.templateElement({ raw: q, cooked: q }, i === arr.length - 1),
      )
      const expressions = (expr.expressions || []).map((e: any) => exprToAST(e, t))
      return t.templateLiteral(quasis, expressions)

    case 'SpreadElement':
      // Spread is handled in ArrayExpression/ObjectExpression, here just return the argument
      return exprToAST(expr.argument, t)

    case 'JSXElement':
      // Convert JSX to createElement call or return as-is if possible
      return jsxToAST(expr, t)

    default:
      // Unknown expression type - log warning and return undefined
      if (expr.kind) {
        console.warn(`[HIR exprToAST] Unsupported expression kind: ${expr.kind}`)
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
