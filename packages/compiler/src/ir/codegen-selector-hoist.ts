import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'
import { expressionUsesIdentifier } from './codegen-delegated-data'
import { deSSAVarName } from './regions'

function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return ctx.t.identifier(`__${prefix}_${ctx.tempCounter++}`)
}

function getTrackedCallIdentifier(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  itemParamName: string,
): string | null {
  if (ctx.t.isCallExpression(expr) && ctx.t.isIdentifier(expr.callee)) {
    if (expr.arguments.length !== 0) return null
    const name = deSSAVarName(expr.callee.name)
    if (name === itemParamName) return null
    if (!ctx.trackedVars.has(name)) return null
    return expr.callee.name
  }
  return null
}

function rewriteSelectorExpression(
  expr: BabelCore.types.Expression,
  itemParamName: string,
  keyParamName: string | null,
  getSelectorId: (name: string) => BabelCore.types.Identifier,
  ctx: CodegenContext,
): { expr: BabelCore.types.Expression; changed: boolean } {
  const { t } = ctx

  const usesParamIdentifier = (e: BabelCore.types.Expression): boolean => {
    if (expressionUsesIdentifier(e, itemParamName, t)) return true
    if (keyParamName && expressionUsesIdentifier(e, keyParamName, t)) return true
    return false
  }

  if (t.isBinaryExpression(expr) && (expr.operator === '===' || expr.operator === '==')) {
    const leftTracked = getTrackedCallIdentifier(
      expr.left as BabelCore.types.Expression,
      ctx,
      itemParamName,
    )
    const rightTracked = getTrackedCallIdentifier(
      expr.right as BabelCore.types.Expression,
      ctx,
      itemParamName,
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
    const result = rewriteSelectorExpression(node, itemParamName, keyParamName, getSelectorId, ctx)
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
    const selectorId = genTemp(ctx, 'sel')
    selectorIds.set(name, selectorId)
    return selectorId
  }

  const rewriteInFunction = (
    fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
  ): void => {
    if (t.isBlockStatement(fn.body)) {
      for (const stmt of fn.body.body) {
        if (t.isReturnStatement(stmt) && stmt.argument && t.isExpression(stmt.argument)) {
          const result = rewriteSelectorExpression(
            stmt.argument,
            itemParamName,
            keyParamName,
            getSelectorId,
            ctx,
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
      )
      if (result.changed) {
        fn.body = result.expr
      }
    }
  }

  const visitNode = (node: BabelCore.types.Node): void => {
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
      if (node !== callbackExpr) {
        if (t.isBlockStatement(node.body)) {
          node.body.body.forEach(stmt => visitNode(stmt))
        } else if (t.isExpression(node.body)) {
          visitNode(node.body)
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
          rewriteInFunction(handler)
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
          )
          if (result.changed) {
            node.arguments[1] = result.expr
          }
        }
      }
    }

    if (t.isBlockStatement(node)) {
      node.body.forEach(stmt => visitNode(stmt))
      return
    }
    if (t.isExpressionStatement(node)) {
      visitNode(node.expression)
      return
    }
    if (t.isReturnStatement(node) && node.argument) {
      visitNode(node.argument)
      return
    }
    if (t.isIfStatement(node)) {
      visitNode(node.test)
      visitNode(node.consequent)
      if (node.alternate) visitNode(node.alternate)
      return
    }
    if (t.isExpression(node)) {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        visitNode(node.callee as BabelCore.types.Node)
        node.arguments.forEach(arg => {
          if (t.isExpression(arg)) visitNode(arg)
        })
      } else if (t.isConditionalExpression(node)) {
        visitNode(node.test)
        visitNode(node.consequent)
        visitNode(node.alternate)
      } else if (t.isLogicalExpression(node) || t.isBinaryExpression(node)) {
        visitNode(node.left as BabelCore.types.Node)
        visitNode(node.right as BabelCore.types.Node)
      } else if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        visitNode(node.object as BabelCore.types.Node)
        if (node.computed) visitNode(node.property as BabelCore.types.Node)
      } else if (t.isSequenceExpression(node)) {
        node.expressions.forEach(expr => visitNode(expr))
      } else if (t.isArrayExpression(node)) {
        node.elements.forEach(el => {
          if (t.isExpression(el)) visitNode(el)
        })
      } else if (t.isObjectExpression(node)) {
        node.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) visitNode(prop.key as BabelCore.types.Node)
            visitNode(prop.value as BabelCore.types.Node)
          } else if (t.isSpreadElement(prop)) {
            visitNode(prop.argument as BabelCore.types.Node)
          }
        })
      } else if (t.isUnaryExpression(node) || t.isUpdateExpression(node)) {
        visitNode(node.argument as BabelCore.types.Node)
      } else if (t.isAssignmentExpression(node)) {
        visitNode(node.left as BabelCore.types.Node)
        visitNode(node.right as BabelCore.types.Node)
      } else if (t.isParenthesizedExpression(node)) {
        visitNode(node.expression)
      }
    }
  }

  visitNode(callbackExpr.body)

  if (selectorIds.size > 0) {
    ctx.helpersUsed.add('createSelector')
    for (const [name, selectorId] of selectorIds) {
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            selectorId,
            t.callExpression(t.identifier(RUNTIME_ALIASES.createSelector), [
              t.arrowFunctionExpression([], t.callExpression(t.identifier(name), [])),
            ]),
          ),
        ]),
      )
    }
  }
}
