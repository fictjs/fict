/**
 * Rule D: Control Flow Region Grouping
 *
 * This module implements the optimization that groups multiple derived values
 * within a control flow region into a single memo, reducing the number of
 * reactive subscriptions.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from './constants'
import { analyzeConditionalUsage } from './rule-j'
import type { TransformContext } from './types'
import { collectBindingNames, dependsOnTracked, isStateCall } from './utils'

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

  // Collect all locally declared variables (not just $state ones)
  const localDeclarations = collectLocalDeclarations(statements, t)

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
      if (collectOutputsFromStatement(stmt, tracked, outputs, localDeclarations, ctx, t)) {
        changed = true
      }
    }
  }

  if (outputs.size < 2 && localStateVars.size) {
    for (const stmt of statements) {
      if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
          if (
            t.isIdentifier(decl.id) &&
            decl.init &&
            !isStateCall(decl.init, t) &&
            referencesNames(decl.init, localStateVars, new Set(ctx.shadowedVars), t)
          ) {
            outputs.add(decl.id.name)
          }
        }
      }

      // Only add assignments to locally declared variables as outputs
      // This prevents capturing external variables like module-level exports
      if (
        t.isExpressionStatement(stmt) &&
        t.isAssignmentExpression(stmt.expression) &&
        t.isIdentifier(stmt.expression.left) &&
        localDeclarations.has(stmt.expression.left.name) &&
        referencesNames(stmt.expression.right, localStateVars, new Set(ctx.shadowedVars), t)
      ) {
        outputs.add(stmt.expression.left.name)
      }
    }
  }

  return outputs
}

/**
 * Collect all locally declared variable names from statements
 */
function collectLocalDeclarations(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const locals = new Set<string>()
  for (const stmt of statements) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id)) {
          locals.add(decl.id.name)
        }
      }
    }
    // Also handle function declarations
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
      locals.add(stmt.id.name)
    }
  }
  return locals
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
  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      node.init &&
      !shadow.has(node.id.name) &&
      isStateCall(node.init, t)
    ) {
      locals.add(node.id.name)
    }

    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      collectBindingNames(node.id, nextShadow, t)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, nextShadow)
      }
    }
  }

  for (const stmt of statements) {
    visit(stmt, new Set(ctx.shadowedVars))
  }

  return locals
}

function referencesNames(
  expr: BabelCore.types.Expression,
  names: Set<string>,
  shadow: Set<string>,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const visit = (node: BabelCore.types.Node, localShadow: Set<string>): void => {
    if (found) return
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (t.isIdentifier(node) && names.has(node.name) && !localShadow.has(node.name)) {
      found = true
      return
    }

    const nextShadow = new Set(localShadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      collectBindingNames(node.id, nextShadow, t)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, nextShadow)
      }
    }
  }

  visit(expr, shadow)
  return found
}

/**
 * Collect outputs from a single statement
 */
function collectOutputsFromStatement(
  stmt: BabelCore.types.Statement,
  tracked: Set<string>,
  outputs: Set<string>,
  localDeclarations: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  let changed = false

  const topLevelDeclarations = new Set<string>()

  if (t.isVariableDeclaration(stmt)) {
    for (const decl of stmt.declarations) {
      if (t.isIdentifier(decl.id)) {
        topLevelDeclarations.add(decl.id.name)
        if (decl.init && isStateCall(decl.init, t)) {
          tracked.add(decl.id.name)
        }
      }
    }
  }

  const visit = (
    node: BabelCore.types.Node,
    shadow: Set<string>,
    controlFlowTracked = false,
    isTopLevel = true,
  ): void => {
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (t.isIfStatement(node)) {
      const condTracked = dependsOnTrackedSetWithShadow(node.test, tracked, shadow, ctx, t)
      visit(node.consequent, shadow, controlFlowTracked || condTracked, false)
      if (node.alternate) {
        visit(node.alternate, shadow, controlFlowTracked || condTracked, false)
      }
      return
    }

    if (t.isSwitchStatement(node)) {
      const condTracked = dependsOnTrackedSetWithShadow(node.discriminant, tracked, shadow, ctx, t)
      for (const clause of node.cases) {
        for (const test of clause.test ? [clause.test] : []) {
          visit(test, shadow, controlFlowTracked || condTracked, false)
        }
        for (const consequent of clause.consequent) {
          visit(consequent, shadow, controlFlowTracked || condTracked, false)
        }
      }
      return
    }

    if (t.isBlockStatement(node)) {
      node.body.forEach(child => visit(child, shadow, controlFlowTracked, false))
      return
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && node.init) {
      const nextShadow = new Set(shadow)
      collectBindingNames(node.id, nextShadow, t)
      const isFunctionInitializer =
        t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init)
      const isTopLevelDecl = topLevelDeclarations.has(node.id.name)
      if (isTopLevel || isTopLevelDecl) {
        if (!isStateCall(node.init, t) && !isFunctionInitializer) {
          if (dependsOnTrackedSetWithShadow(node.init, tracked, nextShadow, ctx, t)) {
            if (!outputs.has(node.id.name)) {
              outputs.add(node.id.name)
              changed = true
            }
          }
        }
      }
      visit(node.init, nextShadow, controlFlowTracked, false)
      return
    }

    if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
      const target = node.left.name
      // Only add assignments to locally declared variables (not external/module-level variables)
      const isLocallyDeclared = localDeclarations.has(target) || topLevelDeclarations.has(target)
      if (!shadow.has(target) && isLocallyDeclared) {
        if (
          controlFlowTracked ||
          dependsOnTrackedSetWithShadow(
            node.right as BabelCore.types.Expression,
            tracked,
            shadow,
            ctx,
            t,
          )
        ) {
          if (!outputs.has(target)) {
            outputs.add(target)
            changed = true
          }
        }
      }
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      const nextShadow = new Set(shadow)
      collectBindingNames(node.id, nextShadow, t)
      for (const key of Object.keys(node) as (keyof typeof node)[]) {
        const child = (node as any)[key]
        if (Array.isArray(child)) {
          for (const c of child) {
            if (
              c &&
              typeof c === 'object' &&
              'type' in c &&
              typeof (c as { type: unknown }).type === 'string'
            ) {
              visit(c as unknown as BabelCore.types.Node, nextShadow, controlFlowTracked, false)
            }
          }
        } else if (
          child &&
          typeof child === 'object' &&
          'type' in child &&
          typeof (child as { type: unknown }).type === 'string'
        ) {
          visit(child as unknown as BabelCore.types.Node, nextShadow, controlFlowTracked, false)
        }
      }
      return
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, shadow, controlFlowTracked, isTopLevel)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, shadow, controlFlowTracked, isTopLevel)
      }
    }
  }

  visit(stmt, new Set(ctx.shadowedVars), false, true)

  return changed
}

/**
 * Check if expression depends on any tracked variables (Set version)
 */
function dependsOnTrackedSetWithShadow(
  expr: BabelCore.types.Node,
  tracked: Set<string>,
  shadow: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  if (dependsOnTracked(expr, ctx, t, tracked)) return true

  if (
    t.isCallExpression(expr) &&
    t.isIdentifier(expr.callee) &&
    expr.callee.name === RUNTIME_ALIASES.memo
  ) {
    const firstArg = expr.arguments[0]
    if (firstArg && (t.isArrowFunctionExpression(firstArg) || t.isFunctionExpression(firstArg))) {
      const body = firstArg.body
      let inner: BabelCore.types.Expression | null = null
      if (t.isBlockStatement(body)) {
        const ret = body.body.find(
          (stmt): stmt is BabelCore.types.ReturnStatement =>
            t.isReturnStatement(stmt) && !!stmt.argument,
        )
        inner = (ret && t.isExpression(ret.argument) ? ret.argument : null) ?? null
      } else if (t.isExpression(body)) {
        inner = body
      }
      if (inner) {
        return dependsOnTrackedSetWithShadow(inner, tracked, shadow, ctx, t)
      }
    }
  }

  let depends = false
  const visit = (node: BabelCore.types.Node, locals: Set<string>): void => {
    if (depends) return

    if (t.isIdentifier(node)) {
      const name = node.name
      if (!locals.has(name) && !shadow.has(name) && tracked.has(name)) {
        depends = true
      }
      return
    }

    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      const nextShadow = new Set(locals)
      node.params.forEach(param => collectBindingNames(param as any, nextShadow, t))
      if (functionBodyDependsOnTracked(node as any, tracked, nextShadow, ctx, t)) {
        depends = true
      }
      return
    }

    if (t.isVariableDeclaration(node)) {
      const newLocals = new Set(locals)
      for (const decl of node.declarations) {
        collectBindingNames(decl.id, newLocals, t)
      }
      for (const decl of node.declarations) {
        if (decl.init) {
          visit(decl.init, newLocals)
        }
      }
      return
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, locals)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, locals)
      }
    }
  }

  visit(expr, new Set(shadow))
  return depends
}

function functionBodyDependsOnTracked(
  fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
  tracked: Set<string>,
  shadow: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  const body = fn.body
  let expr: BabelCore.types.Expression | null = null
  if (t.isBlockStatement(body)) {
    const ret = body.body.find(
      (stmt): stmt is BabelCore.types.ReturnStatement =>
        t.isReturnStatement(stmt) && !!stmt.argument,
    )
    expr = (ret && t.isExpression(ret.argument) ? ret.argument : null) ?? null
  } else if (t.isExpression(body)) {
    expr = body
  }
  if (!expr) return false
  return dependsOnTrackedSetWithShadow(expr, tracked, shadow, ctx, t)
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
 * Check if a statement DEFINES (declares/assigns) any outputs.
 * This is used to avoid pulling pure "consumer" statements (e.g. console.log(output))
 * into a region memo, which would change evaluation order and (with lazy memos) can
 * drop side effects entirely.
 */
function statementDefinesOutputs(
  stmt: BabelCore.types.Statement,
  outputs: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  let defines = false

  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    if (defines) return

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && outputs.has(node.id.name)) {
      defines = true
      return
    }

    if (
      t.isAssignmentExpression(node) &&
      t.isIdentifier(node.left) &&
      outputs.has(node.left.name) &&
      !shadow.has(node.left.name)
    ) {
      defines = true
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
  return defines
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
  let lastNonEarlyReturnTouched = -1
  const outputs = new Set<string>()

  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (!stmt) continue

    const touched = statementTouchesOutputs(stmt, derivedOutputs, ctx, t)
    const defines = touched ? statementDefinesOutputs(stmt, derivedOutputs, ctx, t) : false

    if (touched) {
      // Ignore pure reads until we hit the first defining statement. This prevents
      // accidental regions starting at consumer-only statements.
      if (start === -1) {
        if (!defines) continue
        start = i
      }

      // If we've started a region, stop BEFORE consumer-only statements so side effects
      // remain in original order (outside the lazy memo callback).
      if (start !== -1 && !defines && !containsEarlyReturn(stmt, t)) {
        break
      }

      if (defines && !containsEarlyReturn(stmt, t)) {
        end = i
        lastNonEarlyReturnTouched = i
      }

      if (defines && t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
          if (t.isIdentifier(decl.id) && derivedOutputs.has(decl.id.name)) {
            outputs.add(decl.id.name)
          }
        }
      }
    } else if (start !== -1 && !containsEarlyReturn(stmt, t)) {
      break
    }

    if (containsEarlyReturn(stmt, t)) {
      if (lastNonEarlyReturnTouched !== -1) {
        end = lastNonEarlyReturnTouched
      }
      break
    }
  }

  if (start === -1 || outputs.size === 0) return null
  if (end === -1) return null

  return { start, end, outputs }
}

function containsEarlyReturn(stmt: BabelCore.types.Statement, t: typeof BabelCore.types): boolean {
  let hasReturn = false
  const visit = (node: BabelCore.types.Node): void => {
    if (hasReturn) return
    if (t.isReturnStatement(node) || t.isThrowStatement(node)) {
      hasReturn = true
      return
    }
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as BabelCore.types.Node)
      }
    }
  }
  visit(stmt)
  return hasReturn
}

/**
 * Generate a region memo that groups multiple derived values
 */
export function generateRegionMemo(
  regionStatements: BabelCore.types.Statement[],
  orderedOutputs: string[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
  analysisStatements?: BabelCore.types.Statement[],
): RegionMemoResult {
  const { hoistDecls, transformedStatements } = hoistConditions(regionStatements, ctx, t)

  // Rule J: lazy conditional optimization
  if (ctx.options.lazyConditional) {
    const conditionalInfo = analyzeConditionalUsage(
      analysisStatements ?? regionStatements,
      new Set(orderedOutputs),
      ctx,
      t,
    )
    if (conditionalInfo) {
      const lazy = generateLazyConditionalRegionMemo(
        [...hoistDecls, ...transformedStatements],
        orderedOutputs,
        conditionalInfo,
        ctx,
        t,
      )
      if (lazy) return lazy
    }
  }

  ctx.helpersUsed.memo = true

  const regionId = t.identifier(`__fictRegion_${++ctx.fineGrainedTemplateId}`)

  // Create return statement with object containing all outputs
  const returnStatement = t.returnStatement(
    t.objectExpression(
      orderedOutputs.map(name =>
        // If the value is a function (e.g., memo accessor), call it; otherwise return as-is.
        // Preserve undefined so callers can detect missing values.
        t.objectProperty(
          t.identifier(name),
          t.conditionalExpression(
            t.binaryExpression('!=', t.identifier(name), t.identifier('undefined')),
            t.conditionalExpression(
              t.binaryExpression(
                '===',
                t.unaryExpression('typeof', t.identifier(name)),
                t.stringLiteral('function'),
              ),
              t.callExpression(t.identifier(name), []),
              t.identifier(name),
            ),
            t.identifier('undefined'),
          ),
        ),
      ),
    ),
  )

  // Create memo arrow function
  const memoArrow = t.arrowFunctionExpression(
    [],
    t.blockStatement([...hoistDecls, ...transformedStatements, returnStatement]),
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

function hoistConditions(
  statements: BabelCore.types.Statement[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): { hoistDecls: BabelCore.types.Statement[]; transformedStatements: BabelCore.types.Statement[] } {
  const hoistDecls: BabelCore.types.Statement[] = []

  const hoistCondition = (expr: BabelCore.types.Expression): BabelCore.types.Identifier => {
    const condId = t.identifier(`__fictCond_${ctx.fineGrainedTemplateId++}`)
    hoistDecls.push(t.variableDeclaration('const', [t.variableDeclarator(condId, expr)]))
    return condId
  }

  // Manual recursive visitor to hoist conditions
  const visitNode = (node: BabelCore.types.Node): void => {
    if (!node || typeof node !== 'object') return

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    // Hoist if statement test
    if (t.isIfStatement(node) && t.isExpression(node.test)) {
      const condId = hoistCondition(node.test)
      node.test = condId
    }

    // Hoist conditional expression test
    if (t.isConditionalExpression(node)) {
      const condId = hoistCondition(node.test)
      node.test = condId
    }

    // Recursively visit children
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof c.type === 'string') {
            visitNode(c as unknown as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type?: unknown }).type === 'string'
      ) {
        visitNode(child as unknown as BabelCore.types.Node)
      }
    }
  }

  const transformedStatements = statements.map(stmt => {
    const cloned = t.cloneNode(stmt, true) as BabelCore.types.Statement
    visitNode(cloned)
    return cloned
  })

  return { hoistDecls, transformedStatements }
}

function generateLazyConditionalRegionMemo(
  regionStatements: BabelCore.types.Statement[],
  orderedOutputs: string[],
  conditionalInfo: {
    condition: BabelCore.types.Expression
    trueBranchOnlyDerived: Set<string>
    falseBranchOnlyDerived: Set<string>
  },
  ctx: TransformContext,
  t: typeof BabelCore.types,
): RegionMemoResult | null {
  const conditionId = t.identifier(`__fictCond_${ctx.fineGrainedTemplateId}`)
  const conditionDecl = t.variableDeclaration('const', [
    t.variableDeclarator(conditionId, conditionalInfo.condition),
  ])

  interface TaggedStatement {
    stmt: BabelCore.types.Statement
    index: number
    kind: 'always' | 'lazyTrue' | 'lazyFalse'
  }

  const taggedStatements: TaggedStatement[] = regionStatements.map((stmt, index) => {
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const decl = stmt.declarations[0]
      if (decl && t.isIdentifier(decl.id)) {
        if (conditionalInfo.trueBranchOnlyDerived.has(decl.id.name)) {
          return { stmt, index, kind: 'lazyTrue' }
        }
        if (conditionalInfo.falseBranchOnlyDerived.has(decl.id.name)) {
          return { stmt, index, kind: 'lazyFalse' }
        }
      }
    }
    return { stmt, index, kind: 'always' }
  })

  const lazyTrueStatements = taggedStatements
    .filter(tg => tg.kind === 'lazyTrue')
    .map(tg => tg.stmt)
  const lazyFalseStatements = taggedStatements
    .filter(tg => tg.kind === 'lazyFalse')
    .map(tg => tg.stmt)

  const firstLazyIndex = taggedStatements.findIndex(tg => tg.kind !== 'always')
  const alwaysBeforeLazy: BabelCore.types.Statement[] = []
  const alwaysAfterLazy: BabelCore.types.Statement[] = []
  for (const tg of taggedStatements) {
    if (tg.kind === 'always') {
      if (firstLazyIndex === -1 || tg.index < firstLazyIndex) {
        alwaysBeforeLazy.push(tg.stmt)
      } else {
        alwaysAfterLazy.push(tg.stmt)
      }
    }
  }

  const createReturnWithNulls = (nullFields: Set<string>): BabelCore.types.ReturnStatement => {
    return t.returnStatement(
      t.objectExpression(
        orderedOutputs.map(name => {
          if (nullFields.has(name)) {
            return t.objectProperty(t.identifier(name), t.nullLiteral())
          }
          return t.objectProperty(t.identifier(name), t.identifier(name))
        }),
      ),
    )
  }

  const memoBody: BabelCore.types.Statement[] = [...alwaysBeforeLazy]
  memoBody.unshift(conditionDecl)

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

  ctx.helpersUsed.memo = true
  const regionId = t.identifier(`__fictRegion_${++ctx.fineGrainedTemplateId}`)

  const memoArrow = t.arrowFunctionExpression([], t.blockStatement(memoBody))
  const memoDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      regionId,
      t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [memoArrow]),
    ),
  ])

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

  orderedOutputs.forEach(out => {
    ctx.memoVars.add(out)
    ctx.getterOnlyVars.add(out)
  })

  return { memoDecl, getterDecls, regionId }
}
