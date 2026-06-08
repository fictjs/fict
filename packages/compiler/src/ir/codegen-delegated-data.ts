import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import type { Expression } from './hir'
import { deSSAVarName } from './regions'
import { walkExpression } from './walk-expression'

export function expressionUsesIdentifier(
  expr: BabelCore.types.Node,
  name: string,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const visitDecorators = (decorators?: readonly BabelCore.types.Decorator[] | null): void => {
    decorators?.forEach(decorator => visit(decorator.expression))
  }
  const visitClassMember = (member: BabelCore.types.ClassBody['body'][number]): void => {
    visitDecorators((member as { decorators?: BabelCore.types.Decorator[] | null }).decorators)

    if (t.isStaticBlock(member)) {
      member.body.forEach(statement => visit(statement))
      return
    }

    if (t.isClassMethod(member) || t.isClassPrivateMethod(member)) {
      if (member.computed) visit(member.key)
      return
    }

    if (
      t.isClassProperty(member) ||
      t.isClassPrivateProperty(member) ||
      t.isClassAccessorProperty(member)
    ) {
      if ((t.isClassProperty(member) || t.isClassAccessorProperty(member)) && member.computed) {
        visit(member.key)
      }
      visit(member.value)
    }
  }
  function visit(node?: BabelCore.types.Node | null): void {
    if (!node || found) return
    if (t.isIdentifier(node)) {
      if (node.name === name) found = true
      return
    }
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
      return
    }
    if (t.isClassExpression(node)) {
      visitDecorators(node.decorators)
      visit(node.superClass)
      node.body.body.forEach(member => visitClassMember(member))
      return
    }
    if (t.isBlockStatement(node)) {
      node.body.forEach(statement => visit(statement))
      return
    }
    if (t.isExpressionStatement(node)) {
      visit(node.expression)
      return
    }
    if (t.isReturnStatement(node) || t.isThrowStatement(node)) {
      visit(node.argument)
      return
    }
    if (t.isVariableDeclaration(node)) {
      node.declarations.forEach(declaration => visit(declaration.init))
      return
    }
    if (t.isIfStatement(node)) {
      visit(node.test)
      visit(node.consequent)
      visit(node.alternate)
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
    if (t.isTaggedTemplateExpression(node)) {
      visit(node.tag)
      node.quasi.expressions.forEach(expr => visit(expr))
      return
    }
    if (t.isNewExpression(node)) {
      visit(node.callee)
      node.arguments.forEach(arg => {
        if (t.isExpression(arg) || t.isSpreadElement(arg)) visit(arg)
      })
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
    if (t.isAwaitExpression(node)) {
      visit(node.argument)
      return
    }
    if (t.isYieldExpression(node)) {
      visit(node.argument)
      return
    }
    if (t.isImportExpression(node)) {
      visit(node.source)
      visit(node.options)
      return
    }
    if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTSNonNullExpression(node)) {
      visit(node.expression)
    }
  }

  visit(expr)
  return found
}

function expressionCapturesIdentifiersInNestedFunctions(
  expr: BabelCore.types.Node,
  names: Set<string>,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const visitDecorators = (
    decorators: readonly BabelCore.types.Decorator[] | null | undefined,
    inFunctionBody: boolean,
  ): void => {
    decorators?.forEach(decorator => visit(decorator.expression, inFunctionBody))
  }
  const visitClassMember = (
    member: BabelCore.types.ClassBody['body'][number],
    inFunctionBody: boolean,
  ): void => {
    visitDecorators(
      (member as { decorators?: BabelCore.types.Decorator[] | null }).decorators,
      inFunctionBody,
    )

    if (t.isStaticBlock(member)) {
      member.body.forEach(statement => visit(statement, inFunctionBody))
      return
    }

    if (t.isClassMethod(member) || t.isClassPrivateMethod(member)) {
      if (member.computed) visit(member.key, inFunctionBody)
      visit(member.body, true)
      return
    }

    if (
      t.isClassProperty(member) ||
      t.isClassPrivateProperty(member) ||
      t.isClassAccessorProperty(member)
    ) {
      if ((t.isClassProperty(member) || t.isClassAccessorProperty(member)) && member.computed) {
        visit(member.key, inFunctionBody)
      }
      visit(member.value, inFunctionBody)
    }
  }
  function visit(node?: BabelCore.types.Node | null, inFunctionBody = false): void {
    if (!node || found) return
    if (t.isIdentifier(node)) {
      if (inFunctionBody && names.has(node.name)) found = true
      return
    }
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
      visit(node.body, true)
      return
    }
    if (t.isObjectMethod(node)) {
      if (node.computed) visit(node.key, inFunctionBody)
      visit(node.body, true)
      return
    }
    if (t.isClassExpression(node)) {
      visitDecorators(node.decorators, inFunctionBody)
      visit(node.superClass, inFunctionBody)
      node.body.body.forEach(member => visitClassMember(member, inFunctionBody))
      return
    }
    if (t.isBlockStatement(node)) {
      node.body.forEach(stmt => visit(stmt, inFunctionBody))
      return
    }
    if (t.isExpressionStatement(node)) {
      visit(node.expression, inFunctionBody)
      return
    }
    if (t.isReturnStatement(node)) {
      visit(node.argument, inFunctionBody)
      return
    }
    if (t.isVariableDeclaration(node)) {
      node.declarations.forEach(decl => visit(decl.init, inFunctionBody))
      return
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      visit(node.object, inFunctionBody)
      if (node.computed) visit(node.property, inFunctionBody)
      return
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      visit(node.callee, inFunctionBody)
      node.arguments.forEach(arg => visit(arg, inFunctionBody))
      return
    }
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
      visit(node.left, inFunctionBody)
      visit(node.right, inFunctionBody)
      return
    }
    if (t.isConditionalExpression(node)) {
      visit(node.test, inFunctionBody)
      visit(node.consequent, inFunctionBody)
      visit(node.alternate, inFunctionBody)
      return
    }
    if (t.isUnaryExpression(node) || t.isUpdateExpression(node)) {
      visit(node.argument, inFunctionBody)
      return
    }
    if (t.isAssignmentExpression(node)) {
      visit(node.left, inFunctionBody)
      visit(node.right, inFunctionBody)
      return
    }
    if (t.isSequenceExpression(node)) {
      node.expressions.forEach(item => visit(item, inFunctionBody))
      return
    }
    if (t.isTemplateLiteral(node)) {
      node.expressions.forEach(item => visit(item, inFunctionBody))
      return
    }
    if (t.isTaggedTemplateExpression(node)) {
      visit(node.tag, inFunctionBody)
      node.quasi.expressions.forEach(item => visit(item, inFunctionBody))
      return
    }
    if (t.isNewExpression(node)) {
      visit(node.callee, inFunctionBody)
      node.arguments.forEach(arg => visit(arg, inFunctionBody))
      return
    }
    if (t.isArrayExpression(node)) {
      node.elements.forEach(item => visit(item, inFunctionBody))
      return
    }
    if (t.isObjectExpression(node)) {
      node.properties.forEach(prop => {
        if (t.isObjectProperty(prop)) {
          if (prop.computed) visit(prop.key, inFunctionBody)
          visit(prop.value, inFunctionBody)
        } else if (t.isSpreadElement(prop)) {
          visit(prop.argument, inFunctionBody)
        } else {
          visit(prop, inFunctionBody)
        }
      })
      return
    }
    if (t.isParenthesizedExpression(node)) {
      visit(node.expression, inFunctionBody)
      return
    }
    if (t.isAwaitExpression(node)) {
      visit(node.argument, inFunctionBody)
      return
    }
    if (t.isYieldExpression(node)) {
      visit(node.argument, inFunctionBody)
      return
    }
    if (t.isImportExpression(node)) {
      visit(node.source, inFunctionBody)
      visit(node.options, inFunctionBody)
      return
    }
    if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTSNonNullExpression(node)) {
      visit(node.expression, inFunctionBody)
    }
  }

  visit(expr)
  return found
}

export function extractDelegatedEventData(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
  options?: { isKnownHandlerIdentifier?: (name: string) => boolean },
): { handler: BabelCore.types.Expression; data?: BabelCore.types.Expression | undefined } | null {
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
  if (expressionCapturesIdentifiersInNestedFunctions(bodyExpr, new Set(paramNames), t)) return null
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
  let found = false
  walkExpression(
    expr,
    node => {
      if (found || node.kind !== 'Identifier') return
      found = names.has(deSSAVarName(node.name))
    },
    { includeFunctionBodies: false },
  )
  return found
}

function hirExpressionContainsClassExpression(expr: Expression): boolean {
  let found = false
  walkExpression(
    expr,
    node => {
      if (node.kind === 'ClassExpression') found = true
    },
    { includeFunctionBodies: false },
  )
  return found
}

function hirExpressionCapturesIdentifiersInNestedFunctions(
  expr: Expression,
  names: Set<string>,
): boolean {
  let found = false
  walkExpression(
    expr,
    (node, state) => {
      if (found || !state.inFunctionBody || node.kind !== 'Identifier') return
      found = names.has(deSSAVarName(node.name))
    },
    { includeFunctionBodies: true },
  )
  return found
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
  if (ctx.mutatedVars?.has(normalizedHandlerName)) {
    return null
  }
  if (ctx.componentFunctionMutations?.has(normalizedHandlerName)) {
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
  if (hirExpressionContainsClassExpression(dataExpr)) {
    return null
  }
  if (hirExpressionUsesIdentifiers(dataExpr, paramNames)) {
    return null
  }
  if (hirExpressionCapturesIdentifiersInNestedFunctions(dataExpr, paramNames)) {
    return null
  }

  return {
    handler: callee,
    data: dataExpr,
  }
}
