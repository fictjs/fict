/**
 * Rule D: Control Flow Region Grouping
 *
 * This module implements the optimization that groups multiple derived values
 * within a control flow region into a single memo, reducing the number of
 * reactive subscriptions.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from './constants'
import type { TransformContext } from './types'
import { isStateCall } from './utils'

// ============================================================================
// Types
// ============================================================================

interface RegionCandidate {
  start: number
  end: number
  outputs: Set<string>
}

interface RegionMemoResult {
  memoDecl: BabelCore.types.Statement
  getterDecls: BabelCore.types.Statement[]
  regionId: BabelCore.types.Identifier
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Collect all derived outputs from a list of statements.
 * A derived output is a const variable whose initializer depends on tracked variables.
 */
export function collectDerivedOutputsFromStatements(
  statements: BabelCore.types.Statement[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Set<string> {
  const outputs = new Set<string>()
  const localStateVars = collectLocalStateVars(statements, ctx, t)
  let changed = true

  // Fixed-point iteration to collect all derived outputs
  while (changed) {
    changed = false
    const tracked = new Set<string>([
      ...ctx.stateVars,
      ...ctx.memoVars,
      ...localStateVars,
      ...outputs,
    ])

    for (const stmt of statements) {
      if (collectOutputsFromStatement(stmt, tracked, outputs, ctx, t)) {
        changed = true
      }
    }
  }

  return outputs
}

/**
 * Collect local $state variables from statements
 */
function collectLocalStateVars(
  statements: BabelCore.types.Statement[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Set<string> {
  const locals = new Set<string>()

  for (const stmt of statements) {
    if (!t.isVariableDeclaration(stmt)) continue

    for (const decl of stmt.declarations) {
      if (t.isIdentifier(decl.id) && decl.init && isStateCall(decl.init, t)) {
        locals.add(decl.id.name)
      }
    }
  }

  return locals
}

/**
 * Collect outputs from a single statement
 */
function collectOutputsFromStatement(
  stmt: BabelCore.types.Statement,
  tracked: Set<string>,
  outputs: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  let changed = false

  if (t.isVariableDeclaration(stmt)) {
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !decl.init) continue

      // Skip $state calls
      if (isStateCall(decl.init, t)) {
        tracked.add(decl.id.name)
        continue
      }

      // Skip function initializers
      if (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init)) {
        continue
      }

      // Check if depends on tracked
      if (dependsOnTrackedSet(decl.init, tracked, ctx.shadowedVars, t)) {
        if (!outputs.has(decl.id.name)) {
          outputs.add(decl.id.name)
          changed = true
        }
      }
    }
  }

  // Handle assignment expressions
  if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
    const expr = stmt.expression
    if (t.isIdentifier(expr.left)) {
      const target = expr.left.name
      if (!ctx.shadowedVars.has(target)) {
        if (dependsOnTrackedSet(expr.right, tracked, ctx.shadowedVars, t)) {
          if (!outputs.has(target)) {
            outputs.add(target)
            changed = true
          }
        }
      }
    }
  }

  return changed
}

/**
 * Check if expression depends on any tracked variables (Set version)
 */
function dependsOnTrackedSet(
  expr: BabelCore.types.Node,
  tracked: Set<string>,
  shadowedVars: Set<string>,
  t: typeof BabelCore.types,
): boolean {
  let depends = false

  const visit = (node: BabelCore.types.Node, locals: Set<string>): void => {
    if (depends) return

    if (t.isIdentifier(node)) {
      const name = node.name
      if (!locals.has(name) && !shadowedVars.has(name) && tracked.has(name)) {
        depends = true
      }
      return
    }

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    // Handle variable declarations
    if (t.isVariableDeclaration(node)) {
      const newLocals = new Set(locals)
      for (const decl of node.declarations) {
        if (t.isIdentifier(decl.id)) {
          newLocals.add(decl.id.name)
        }
      }
      for (const decl of node.declarations) {
        if (decl.init) {
          visit(decl.init, newLocals)
        }
      }
      return
    }

    // Recurse into children
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as unknown as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, locals)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as unknown as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, locals)
      }
    }
  }

  visit(expr, new Set())
  return depends
}

/**
 * Check if a statement touches any outputs
 */
export function statementTouchesOutputs(
  stmt: BabelCore.types.Statement,
  outputs: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  let touches = false

  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    if (touches) return

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (t.isIdentifier(node) && outputs.has(node.name) && !shadow.has(node.name)) {
      touches = true
      return
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && outputs.has(node.id.name)) {
      touches = true
      return
    }

    if (
      t.isAssignmentExpression(node) &&
      t.isIdentifier(node.left) &&
      outputs.has(node.left.name)
    ) {
      touches = true
      return
    }

    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      nextShadow.add(node.id.name)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as unknown as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as unknown as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, nextShadow)
      }
    }
  }

  visit(stmt, new Set(ctx.shadowedVars))
  return touches
}

/**
 * Collect outputs in declaration order
 */
export function collectOutputsInOrder(
  statements: BabelCore.types.Statement[],
  outputs: Set<string>,
  t: typeof BabelCore.types,
): string[] {
  const order: string[] = []
  const seen = new Set<string>()

  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (t.isIdentifier(node) && outputs.has(node.name) && !shadow.has(node.name)) {
      if (!seen.has(node.name)) {
        seen.add(node.name)
        order.push(node.name)
      }
    }

    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      if (outputs.has(node.id.name) && !shadow.has(node.id.name)) {
        if (!seen.has(node.id.name)) {
          seen.add(node.id.name)
          order.push(node.id.name)
        }
      }
      nextShadow.add(node.id.name)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as unknown as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as unknown as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, nextShadow)
      }
    }
  }

  for (const stmt of statements) {
    visit(stmt, new Set())
  }

  return order
}

/**
 * Find the next region of statements that can be grouped
 */
export function findNextRegion(
  statements: BabelCore.types.Statement[],
  derivedOutputs: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  startIndex: number,
): RegionCandidate | null {
  let start = -1
  let end = -1
  const outputs = new Set<string>()

  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (!stmt) continue

    const touched = statementTouchesOutputs(stmt, derivedOutputs, ctx, t)

    if (touched) {
      if (start === -1) start = i
      end = i

      // Collect outputs from this statement
      if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
          if (t.isIdentifier(decl.id) && derivedOutputs.has(decl.id.name)) {
            outputs.add(decl.id.name)
          }
        }
      }
    } else if (start !== -1) {
      // Non-touching statement after region started - end region
      break
    }

    // Check for early return
    if (t.isReturnStatement(stmt)) {
      break
    }
  }

  if (start === -1 || outputs.size === 0) return null
  if (end === -1) return null

  return { start, end, outputs }
}

/**
 * Generate a region memo that groups multiple derived values
 */
export function generateRegionMemo(
  regionStatements: BabelCore.types.Statement[],
  orderedOutputs: string[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): RegionMemoResult {
  ctx.helpersUsed.memo = true

  const regionId = t.identifier(`__fictRegion_${++ctx.fineGrainedTemplateId}`)

  // Create return statement with object containing all outputs
  const returnStatement = t.returnStatement(
    t.objectExpression(
      orderedOutputs.map(name =>
        t.objectProperty(
          t.identifier(name),
          t.conditionalExpression(
            t.binaryExpression('!==', t.identifier(name), t.identifier('undefined')),
            t.identifier(name),
            t.identifier('undefined'),
          ),
        ),
      ),
    ),
  )

  // Create memo arrow function
  const memoArrow = t.arrowFunctionExpression(
    [],
    t.blockStatement([...regionStatements, returnStatement]),
  )

  // Create memo declaration
  const memoDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      regionId,
      t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [memoArrow]),
    ),
  ])

  // Create getter declarations for each output
  const getterDecls = orderedOutputs.map(name =>
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier(name),
        t.arrowFunctionExpression(
          [],
          t.memberExpression(t.callExpression(regionId, []), t.identifier(name)),
        ),
      ),
    ]),
  )

  // Register outputs as memo vars / getters
  orderedOutputs.forEach(out => {
    ctx.memoVars.add(out)
    ctx.getterOnlyVars.add(out)
  })

  return { memoDecl, getterDecls, regionId }
}
