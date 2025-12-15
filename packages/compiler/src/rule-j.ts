/**
 * Rule J: Lazy Conditional Evaluation
 *
 * This module implements the optimization that defers evaluation of
 * derived values that are only used in specific branches of conditionals.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from './constants'
import type { TransformContext } from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * Information about conditional usage of derived values
 */
export interface ConditionalDerivedInfo {
  /** The condition expression */
  condition: BabelCore.types.Expression
  /** Derived values only used when condition is true */
  trueBranchOnlyDerived: Set<string>
  /** Derived values only used when condition is false */
  falseBranchOnlyDerived: Set<string>
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Analyze which derived values are only used in conditional branches
 */
export function analyzeConditionalUsage(
  statements: BabelCore.types.Statement[],
  derivedOutputs: Set<string>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): ConditionalDerivedInfo | null {
  interface ConditionalNode {
    node:
      | BabelCore.types.IfStatement
      | BabelCore.types.ConditionalExpression
      | BabelCore.types.CallExpression
    condition: BabelCore.types.Expression
    trueBranch: BabelCore.types.Node
    falseBranch: BabelCore.types.Node | undefined
  }

  const trueBranchUsed = new Set<string>()
  const falseBranchUsed = new Set<string>()
  const outsideConditionUsed = new Set<string>()

  // Collect derived values used in a subtree
  const collectUsedDerived = (
    node: BabelCore.types.Node,
    target: Set<string>,
    skipNode?: BabelCore.types.Node,
  ): void => {
    if (node === skipNode) return

    // Traverse memo callbacks
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === RUNTIME_ALIASES.memo
    ) {
      const fn = node.arguments[0]
      if (fn && (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) {
        if (t.isBlockStatement(fn.body)) {
          for (const stmt of fn.body.body) {
            if (stmt) collectUsedDerived(stmt, target, skipNode)
          }
        } else {
          collectUsedDerived(fn.body, target, skipNode)
        }
      }
    }

    // Skip declaration bodies, but allow arrow functions/expressions (callbacks)
    if (t.isFunctionDeclaration(node)) {
      return
    }

    // Skip variable declaration names - they are definitions, not usages
    if (t.isVariableDeclarator(node)) {
      if (node.init) {
        collectUsedDerived(node.init, target, skipNode)
      }
      return
    }

    if (t.isIdentifier(node) && derivedOutputs.has(node.name)) {
      target.add(node.name)
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
            collectUsedDerived(c as unknown as BabelCore.types.Node, target, skipNode)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as unknown as { type: unknown }).type === 'string'
      ) {
        collectUsedDerived(child as unknown as BabelCore.types.Node, target, skipNode)
      }
    }
  }

  // Find conditionals in the statements
  const conditionals: ConditionalNode[] = []

  const findConditional = (node: BabelCore.types.Node): void => {
    // Skip declaration bodies, but allow arrow functions/expressions (callbacks)
    if (t.isFunctionDeclaration(node)) {
      return
    }

    // Traverse memo callbacks
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === RUNTIME_ALIASES.memo
    ) {
      const fn = node.arguments[0]
      if (fn && (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) {
        if (t.isBlockStatement(fn.body)) {
          for (const stmt of fn.body.body) {
            if (stmt) findConditional(stmt)
          }
        } else {
          findConditional(fn.body)
        }
      }
    }

    if (t.isIfStatement(node)) {
      conditionals.push({
        node,
        condition: node.test,
        trueBranch: node.consequent,
        falseBranch: node.alternate ?? undefined,
      })
      return
    }

    if (t.isConditionalExpression(node)) {
      conditionals.push({
        node,
        condition: node.test,
        trueBranch: node.consequent,
        falseBranch: node.alternate ?? undefined,
      })
      return
    }

    // Handle createConditional calls
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === RUNTIME_ALIASES.conditional
    ) {
      const conditionParam = node.arguments[0]
      const trueParam = node.arguments[1]
      // element factory is arg 2
      const falseParam = node.arguments[3]

      // Helper to extract body from () => expr or () => { return expr }
      const unwrap = (
        arg: BabelCore.types.Node | null | undefined,
      ): BabelCore.types.Node | undefined => {
        if (!arg) return undefined
        if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
          return arg.body
        }
        return arg
      }

      const unwrapCondition = (arg: BabelCore.types.Node): BabelCore.types.Expression => {
        if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
          if (t.isExpression(arg.body)) return arg.body
          if (t.isBlockStatement(arg.body)) {
            const ret = arg.body.body.find((s): s is BabelCore.types.ReturnStatement =>
              t.isReturnStatement(s),
            )
            if (ret && ret.argument) return ret.argument
          }
        }
        return arg as BabelCore.types.Expression
      }

      if (conditionParam && trueParam) {
        conditionals.push({
          node: node, // Treat the call as the conditional node
          condition: unwrapCondition(conditionParam),
          trueBranch: unwrap(trueParam)!,
          falseBranch: unwrap(falseParam),
        })
      }
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
            findConditional(c as unknown as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as unknown as { type: unknown }).type === 'string'
      ) {
        findConditional(child as unknown as BabelCore.types.Node)
      }
    }
  }

  for (const stmt of statements) {
    findConditional(stmt)
  }

  for (const conditional of conditionals) {
    trueBranchUsed.clear()
    falseBranchUsed.clear()
    outsideConditionUsed.clear()

    // Check each branch of the conditional
    collectUsedDerived(conditional.trueBranch, trueBranchUsed)
    if (conditional.falseBranch) {
      collectUsedDerived(conditional.falseBranch, falseBranchUsed)
    }

    // Check usages outside the conditional node
    for (const stmt of statements) {
      collectUsedDerived(stmt, outsideConditionUsed, conditional.node)
    }

    // Find derived values only used in true branch
    const trueBranchOnlyDerived = new Set<string>()
    for (const name of trueBranchUsed) {
      if (!falseBranchUsed.has(name) && !outsideConditionUsed.has(name)) {
        trueBranchOnlyDerived.add(name)
      }
    }

    // Find derived values only used in false branch
    const falseBranchOnlyDerived = new Set<string>()
    for (const name of falseBranchUsed) {
      if (!trueBranchUsed.has(name) && !outsideConditionUsed.has(name)) {
        falseBranchOnlyDerived.add(name)
      }
    }

    if (trueBranchOnlyDerived.size === 0 && falseBranchOnlyDerived.size === 0) {
      continue
    }

    return {
      condition: conditional.condition,
      trueBranchOnlyDerived,
      falseBranchOnlyDerived,
    }
  }

  return null
}
