import type * as BabelCore from '@babel/core'

export function ignoresInlineEventHandlerReturn(
  fn: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return fn

  const argsId = t.identifier('__fictArgs')
  const callExpr = t.isArrowFunctionExpression(fn)
    ? t.callExpression(fn, [t.spreadElement(argsId)])
    : t.callExpression(t.memberExpression(fn, t.identifier('apply')), [t.thisExpression(), argsId])

  const body = t.blockStatement([t.expressionStatement(callExpr)])
  const params = [t.restElement(argsId)]

  return t.isArrowFunctionExpression(fn)
    ? t.arrowFunctionExpression(params, body)
    : t.functionExpression(null, params, body)
}
