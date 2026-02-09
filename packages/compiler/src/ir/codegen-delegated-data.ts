import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import type { Expression } from './hir'
import { deSSAVarName } from './regions'

export function expressionUsesIdentifier(
  expr: BabelCore.types.Node,
  name: string,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const visit = (node?: BabelCore.types.Node | null): void => {
    if (!node || found) return
    if (t.isIdentifier(node)) {
      if (node.name === name) found = true
      return
    }
    if (
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isClassExpression(node)
    ) {
      return
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      visit(node.object)
      if (node.computed) visit(node.property)
      return
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      visit(node.callee)
      node.arguments.forEach(arg => {
        if (t.isExpression(arg)) visit(arg)
      })
      return
    }
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
      visit(node.left)
      visit(node.right)
      return
    }
    if (t.isConditionalExpression(node)) {
      visit(node.test)
      visit(node.consequent)
      visit(node.alternate)
      return
    }
    if (t.isUnaryExpression(node) || t.isUpdateExpression(node)) {
      visit(node.argument)
      return
    }
    if (t.isAssignmentExpression(node)) {
      visit(node.left)
      visit(node.right)
      return
    }
    if (t.isSequenceExpression(node)) {
      node.expressions.forEach(expr => visit(expr))
      return
    }
    if (t.isTemplateLiteral(node)) {
      node.expressions.forEach(expr => visit(expr))
      return
    }
    if (t.isArrayExpression(node)) {
      node.elements.forEach(el => {
        if (t.isExpression(el)) visit(el)
      })
      return
    }
    if (t.isObjectExpression(node)) {
      node.properties.forEach(prop => {
        if (t.isObjectProperty(prop)) {
          if (prop.computed) visit(prop.key)
          visit(prop.value)
          return
        }
        if (t.isSpreadElement(prop)) {
          visit(prop.argument)
        }
      })
      return
    }
    if (t.isParenthesizedExpression(node)) {
      visit(node.expression)
      return
    }
    if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTSNonNullExpression(node)) {
      visit(node.expression)
    }
  }

  visit(expr)
  return found
}

export function extractDelegatedEventData(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
  options?: { isKnownHandlerIdentifier?: (name: string) => boolean },
): { handler: BabelCore.types.Expression; data?: BabelCore.types.Expression } | null {
  const isSimpleHandler = t.isIdentifier(expr) || t.isMemberExpression(expr)
  if (isSimpleHandler) {
    return { handler: expr }
  }

  if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) {
    return null
  }

  const paramNames = expr.params
    .map(p => (t.isIdentifier(p) ? p.name : null))
    .filter((n): n is string => !!n)
  const bodyExpr = t.isBlockStatement(expr.body)
    ? expr.body.body.length === 1 &&
      t.isReturnStatement(expr.body.body[0]) &&
      expr.body.body[0].argument &&
      t.isExpression(expr.body.body[0].argument)
      ? (expr.body.body[0].argument as BabelCore.types.Expression)
      : null
    : (expr.body as BabelCore.types.Expression)

  if (!bodyExpr || !t.isCallExpression(bodyExpr)) return null
  if (paramNames.some(name => expressionUsesIdentifier(bodyExpr, name, t))) return null
  if (!t.isIdentifier(bodyExpr.callee)) return null
  if (
    options?.isKnownHandlerIdentifier &&
    !options.isKnownHandlerIdentifier(bodyExpr.callee.name)
  ) {
    return null
  }
  if (bodyExpr.arguments.length === 0) return null
  if (bodyExpr.arguments.length > 1) return null

  const dataArg = bodyExpr.arguments[0]
  return {
    handler: bodyExpr.callee as BabelCore.types.Expression,
    data: dataArg && t.isExpression(dataArg) ? (dataArg as BabelCore.types.Expression) : undefined,
  }
}

export function hirExpressionUsesIdentifiers(expr: Expression, names: Set<string>): boolean {
  if (expr.kind === 'Identifier') {
    return names.has(deSSAVarName(expr.name))
  }

  switch (expr.kind) {
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        hirExpressionUsesIdentifiers(expr.left, names) ||
        hirExpressionUsesIdentifiers(expr.right, names)
      )
    case 'UnaryExpression':
      return hirExpressionUsesIdentifiers(expr.argument, names)
    case 'ConditionalExpression':
      return (
        hirExpressionUsesIdentifiers(expr.test, names) ||
        hirExpressionUsesIdentifiers(expr.consequent, names) ||
        hirExpressionUsesIdentifiers(expr.alternate, names)
      )
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        hirExpressionUsesIdentifiers(expr.callee, names) ||
        expr.arguments.some(arg => hirExpressionUsesIdentifiers(arg, names))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        hirExpressionUsesIdentifiers(expr.object, names) ||
        (expr.computed && hirExpressionUsesIdentifiers(expr.property, names))
      )
    case 'ArrayExpression':
      return expr.elements.some(el => el && hirExpressionUsesIdentifiers(el, names))
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'SpreadElement') {
          return hirExpressionUsesIdentifiers(prop.argument, names)
        }
        return (
          ((prop.computed ?? false) && hirExpressionUsesIdentifiers(prop.key, names)) ||
          hirExpressionUsesIdentifiers(prop.value, names)
        )
      })
    case 'TemplateLiteral':
      return expr.expressions.some(e => hirExpressionUsesIdentifiers(e, names))
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    default:
      return false
  }
}

/**
 * Extract delegated event data from HIR expression before lowering.
 * Pattern: `() => handler(data)`
 */
export function extractDelegatedEventDataFromHIR(
  expr: Expression,
  ctx: CodegenContext,
): { handler: Expression; data: Expression } | null {
  if (expr.kind !== 'ArrowFunction' && expr.kind !== 'FunctionExpression') {
    return null
  }

  let bodyExpr: Expression | null = null

  if (expr.kind === 'ArrowFunction') {
    if (expr.isExpression && !Array.isArray(expr.body)) {
      bodyExpr = expr.body as Expression
    }
  }

  if (!bodyExpr || bodyExpr.kind !== 'CallExpression') {
    return null
  }

  const callee = bodyExpr.callee
  if (callee.kind !== 'Identifier') {
    return null
  }

  const handlerName = callee.name
  const normalizedHandlerName = deSSAVarName(handlerName)
  if (!ctx.functionVars?.has(normalizedHandlerName)) {
    return null
  }
  if (
    ctx.signalVars?.has(handlerName) ||
    ctx.memoVars?.has(handlerName) ||
    ctx.aliasVars?.has(handlerName) ||
    ctx.storeVars?.has(handlerName) ||
    ctx.trackedVars.has(handlerName)
  ) {
    return null
  }

  if (bodyExpr.arguments.length !== 1) {
    return null
  }

  const isTrackedAccessor =
    ctx.signalVars?.has(deSSAVarName(callee.name)) ||
    ctx.memoVars?.has(deSSAVarName(callee.name)) ||
    ctx.aliasVars?.has(deSSAVarName(callee.name))
  if (isTrackedAccessor) {
    return null
  }

  const paramNames = new Set(expr.params.map(p => deSSAVarName(p.name)))
  if (paramNames.has(deSSAVarName(callee.name))) {
    return null
  }
  const dataExpr = bodyExpr.arguments[0]
  if (!dataExpr) {
    return null
  }
  if (hirExpressionUsesIdentifiers(dataExpr, paramNames)) {
    return null
  }

  return {
    handler: callee,
    data: dataExpr,
  }
}
