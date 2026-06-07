import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'
import { expressionUsesIdentifier } from './codegen-delegated-data'
import { createGeneratedIdentifier } from './codegen-name-allocation'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { deSSAVarName } from './regions'

function getTrackedCallIdentifier(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  itemParamName: string,
  shadowedNames: ReadonlySet<string>,
): string | null {
  if (ctx.t.isCallExpression(expr) && ctx.t.isIdentifier(expr.callee)) {
    if (expr.arguments.length !== 0) return null
    const name = deSSAVarName(expr.callee.name)
    if (name === itemParamName) return null
    if (shadowedNames.has(name)) return null
    if (!ctx.trackedVars.has(name)) return null
    return expr.callee.name
  }
  return null
}

function addBindingName(name: string | null | undefined, into: Set<string>): void {
  if (name) into.add(deSSAVarName(name))
}

function addPatternBindingNames(
  node: BabelCore.types.Node | null | undefined,
  into: Set<string>,
  t: typeof BabelCore.types,
): void {
  if (!node) return
  const ids = t.getBindingIdentifiers(node)
  for (const name of Object.keys(ids)) {
    addBindingName(name, into)
  }
}

function collectStatementBindings(
  stmt: BabelCore.types.Statement,
  into: Set<string>,
  t: typeof BabelCore.types,
): void {
  if (t.isVariableDeclaration(stmt)) {
    stmt.declarations.forEach(decl => addPatternBindingNames(decl.id, into, t))
    return
  }
  if (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) {
    addBindingName(stmt.id?.name, into)
  }
}

function functionShadowSet(
  fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
  parent: ReadonlySet<string>,
  t: typeof BabelCore.types,
): Set<string> {
  const next = new Set(parent)
  if (t.isFunctionExpression(fn)) addBindingName(fn.id?.name, next)
  fn.params.forEach(param => addPatternBindingNames(param, next, t))
  return next
}

function blockShadowSet(
  block: BabelCore.types.BlockStatement,
  parent: ReadonlySet<string>,
  t: typeof BabelCore.types,
): Set<string> {
  const next = new Set(parent)
  block.body.forEach(stmt => collectStatementBindings(stmt, next, t))
  return next
}

function rewriteSelectorExpression(
  expr: BabelCore.types.Expression,
  itemParamName: string,
  keyParamName: string | null,
  getSelectorId: (name: string) => BabelCore.types.Identifier,
  ctx: CodegenContext,
  shadowedNames: ReadonlySet<string>,
): { expr: BabelCore.types.Expression; changed: boolean } {
  const { t } = ctx

  const usesParamIdentifier = (e: BabelCore.types.Expression): boolean => {
    if (expressionUsesIdentifier(e, itemParamName, t)) return true
    if (keyParamName && expressionUsesIdentifier(e, keyParamName, t)) return true
    return false
  }

  if (t.isBinaryExpression(expr) && expr.operator === '===') {
    const leftTracked = getTrackedCallIdentifier(
      expr.left as BabelCore.types.Expression,
      ctx,
      itemParamName,
      shadowedNames,
    )
    const rightTracked = getTrackedCallIdentifier(
      expr.right as BabelCore.types.Expression,
      ctx,
      itemParamName,
      shadowedNames,
    )
    if (leftTracked && usesParamIdentifier(expr.right as BabelCore.types.Expression)) {
      return {
        expr: t.callExpression(getSelectorId(leftTracked), [
          expr.right as BabelCore.types.Expression,
        ]),
        changed: true,
      }
    }
    if (rightTracked && usesParamIdentifier(expr.left as BabelCore.types.Expression)) {
      return {
        expr: t.callExpression(getSelectorId(rightTracked), [
          expr.left as BabelCore.types.Expression,
        ]),
        changed: true,
      }
    }
  }

  let changed = false
  const rewrite = (node: BabelCore.types.Expression): BabelCore.types.Expression => {
    const result = rewriteSelectorExpression(
      node,
      itemParamName,
      keyParamName,
      getSelectorId,
      ctx,
      shadowedNames,
    )
    if (result.changed) changed = true
    return result.expr
  }

  if (t.isConditionalExpression(expr)) {
    expr.test = rewrite(expr.test)
    expr.consequent = rewrite(expr.consequent)
    expr.alternate = rewrite(expr.alternate)
  } else if (t.isLogicalExpression(expr) || t.isBinaryExpression(expr)) {
    expr.left = rewrite(expr.left as BabelCore.types.Expression)
    expr.right = rewrite(expr.right as BabelCore.types.Expression)
  } else if (t.isUnaryExpression(expr) || t.isUpdateExpression(expr)) {
    expr.argument = rewrite(expr.argument as BabelCore.types.Expression)
  } else if (t.isAssignmentExpression(expr)) {
    expr.right = rewrite(expr.right as BabelCore.types.Expression)
  } else if (t.isSequenceExpression(expr)) {
    expr.expressions = expr.expressions.map(item => rewrite(item as BabelCore.types.Expression))
  } else if (t.isTemplateLiteral(expr)) {
    expr.expressions = expr.expressions.map(item => rewrite(item as BabelCore.types.Expression))
  } else if (t.isArrayExpression(expr)) {
    expr.elements = expr.elements.map(el => {
      if (t.isExpression(el)) return rewrite(el)
      return el
    })
  } else if (t.isObjectExpression(expr)) {
    expr.properties = expr.properties.map(prop => {
      if (t.isObjectProperty(prop)) {
        if (prop.computed && t.isExpression(prop.key)) {
          prop.key = rewrite(prop.key)
        }
        if (t.isExpression(prop.value)) {
          prop.value = rewrite(prop.value)
        }
        return prop
      }
      if (t.isSpreadElement(prop)) {
        prop.argument = rewrite(prop.argument as BabelCore.types.Expression)
        return prop
      }
      return prop
    })
  } else if (t.isCallExpression(expr) || t.isOptionalCallExpression(expr)) {
    if (t.isExpression(expr.callee)) {
      expr.callee = rewrite(expr.callee)
    }
    expr.arguments = expr.arguments.map(arg => {
      if (t.isExpression(arg)) return rewrite(arg)
      return arg
    })
  } else if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    expr.object = rewrite(expr.object as BabelCore.types.Expression)
    if (expr.computed && t.isExpression(expr.property)) {
      expr.property = rewrite(expr.property)
    }
  } else if (t.isParenthesizedExpression(expr)) {
    expr.expression = rewrite(expr.expression)
  } else if (
    t.isTSAsExpression(expr) ||
    t.isTSTypeAssertion(expr) ||
    t.isTSNonNullExpression(expr)
  ) {
    expr.expression = rewrite(expr.expression)
  }

  return { expr, changed }
}

export function applySelectorHoist(
  callbackExpr: BabelCore.types.Expression,
  itemParamName: string | null,
  keyParamName: string | null,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx
  if (!itemParamName) return
  if (!t.isArrowFunctionExpression(callbackExpr) && !t.isFunctionExpression(callbackExpr)) return

  const selectorIds = new Map<string, BabelCore.types.Identifier>()
  const getSelectorId = (name: string): BabelCore.types.Identifier => {
    const existing = selectorIds.get(name)
    if (existing) return existing
    const selectorId = createGeneratedIdentifier(ctx, 'sel')
    selectorIds.set(name, selectorId)
    return selectorId
  }

  const rewriteInFunction = (
    fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
    parentShadowedNames: ReadonlySet<string>,
  ): void => {
    const functionShadowedNames = functionShadowSet(fn, parentShadowedNames, t)
    if (t.isBlockStatement(fn.body)) {
      const bodyShadowedNames = blockShadowSet(fn.body, functionShadowedNames, t)
      for (const stmt of fn.body.body) {
        if (t.isReturnStatement(stmt) && stmt.argument && t.isExpression(stmt.argument)) {
          const result = rewriteSelectorExpression(
            stmt.argument,
            itemParamName,
            keyParamName,
            getSelectorId,
            ctx,
            bodyShadowedNames,
          )
          if (result.changed) {
            stmt.argument = result.expr
          }
        }
      }
      return
    }
    if (t.isExpression(fn.body)) {
      const result = rewriteSelectorExpression(
        fn.body,
        itemParamName,
        keyParamName,
        getSelectorId,
        ctx,
        functionShadowedNames,
      )
      if (result.changed) {
        fn.body = result.expr
      }
    }
  }

  const visitNode = (node: BabelCore.types.Node, shadowedNames: ReadonlySet<string>): void => {
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
      if (node !== callbackExpr) {
        const functionShadowedNames = functionShadowSet(node, shadowedNames, t)
        if (t.isBlockStatement(node.body)) {
          const bodyShadowedNames = blockShadowSet(node.body, functionShadowedNames, t)
          node.body.body.forEach(stmt => visitNode(stmt, bodyShadowedNames))
        } else if (t.isExpression(node.body)) {
          visitNode(node.body, functionShadowedNames)
        }
        return
      }
    }
    if (t.isCallExpression(node)) {
      const calleeName = t.isIdentifier(node.callee)
        ? node.callee.name
        : t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)
          ? node.callee.property.name
          : null
      if (calleeName === RUNTIME_ALIASES.bindClass || calleeName === 'bindClass') {
        const handler = node.arguments[1]
        if (handler && (t.isArrowFunctionExpression(handler) || t.isFunctionExpression(handler))) {
          rewriteInFunction(handler, shadowedNames)
        }
      }
      if (calleeName === RUNTIME_ALIASES.setClass || calleeName === 'setClass') {
        const classValue = node.arguments[1]
        if (classValue && t.isExpression(classValue)) {
          const result = rewriteSelectorExpression(
            classValue,
            itemParamName,
            keyParamName,
            getSelectorId,
            ctx,
            shadowedNames,
          )
          if (result.changed) {
            node.arguments[1] = result.expr
          }
        }
      }
    }

    if (t.isBlockStatement(node)) {
      const blockShadowedNames = blockShadowSet(node, shadowedNames, t)
      node.body.forEach(stmt => visitNode(stmt, blockShadowedNames))
      return
    }
    if (t.isExpressionStatement(node)) {
      visitNode(node.expression, shadowedNames)
      return
    }
    if (t.isReturnStatement(node) && node.argument) {
      visitNode(node.argument, shadowedNames)
      return
    }
    if (t.isIfStatement(node)) {
      visitNode(node.test, shadowedNames)
      visitNode(node.consequent, shadowedNames)
      if (node.alternate) visitNode(node.alternate, shadowedNames)
      return
    }
    if (t.isTryStatement(node)) {
      visitNode(node.block, shadowedNames)
      if (node.handler) {
        const handlerShadowedNames = new Set(shadowedNames)
        if (node.handler.param) {
          addPatternBindingNames(node.handler.param, handlerShadowedNames, t)
        }
        visitNode(node.handler.body, handlerShadowedNames)
      }
      if (node.finalizer) visitNode(node.finalizer, shadowedNames)
      return
    }
    if (t.isExpression(node)) {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        visitNode(node.callee as BabelCore.types.Node, shadowedNames)
        node.arguments.forEach(arg => {
          if (t.isExpression(arg)) visitNode(arg, shadowedNames)
        })
      } else if (t.isConditionalExpression(node)) {
        visitNode(node.test, shadowedNames)
        visitNode(node.consequent, shadowedNames)
        visitNode(node.alternate, shadowedNames)
      } else if (t.isLogicalExpression(node) || t.isBinaryExpression(node)) {
        visitNode(node.left as BabelCore.types.Node, shadowedNames)
        visitNode(node.right as BabelCore.types.Node, shadowedNames)
      } else if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        visitNode(node.object as BabelCore.types.Node, shadowedNames)
        if (node.computed) visitNode(node.property as BabelCore.types.Node, shadowedNames)
      } else if (t.isSequenceExpression(node)) {
        node.expressions.forEach(expr => visitNode(expr, shadowedNames))
      } else if (t.isArrayExpression(node)) {
        node.elements.forEach(el => {
          if (t.isExpression(el)) visitNode(el, shadowedNames)
        })
      } else if (t.isObjectExpression(node)) {
        node.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) visitNode(prop.key as BabelCore.types.Node, shadowedNames)
            visitNode(prop.value as BabelCore.types.Node, shadowedNames)
          } else if (t.isSpreadElement(prop)) {
            visitNode(prop.argument as BabelCore.types.Node, shadowedNames)
          }
        })
      } else if (t.isUnaryExpression(node) || t.isUpdateExpression(node)) {
        visitNode(node.argument as BabelCore.types.Node, shadowedNames)
      } else if (t.isAssignmentExpression(node)) {
        visitNode(node.left as BabelCore.types.Node, shadowedNames)
        visitNode(node.right as BabelCore.types.Node, shadowedNames)
      } else if (t.isParenthesizedExpression(node)) {
        visitNode(node.expression, shadowedNames)
      }
    }
  }

  const initialShadowedNames = functionShadowSet(callbackExpr, new Set(), t)
  if (t.isBlockStatement(callbackExpr.body)) {
    visitNode(callbackExpr.body, blockShadowSet(callbackExpr.body, initialShadowedNames, t))
  } else {
    visitNode(callbackExpr.body, initialShadowedNames)
  }

  if (selectorIds.size > 0) {
    ctx.helpersUsed.add('createSelector')
    for (const [name, selectorId] of selectorIds) {
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            selectorId,
            t.callExpression(runtimeIdentifier(ctx, 'createSelector'), [
              t.arrowFunctionExpression([], t.callExpression(t.identifier(name), [])),
            ]),
          ),
        ]),
      )
    }
  }
}
