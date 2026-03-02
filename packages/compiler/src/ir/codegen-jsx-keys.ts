import type { Expression, JSXAttribute, JSXElementExpression } from './hir'

function extractKeyFromAttributes(attributes: JSXAttribute[]): Expression | undefined {
  for (const attr of attributes) {
    if (attr.name === 'key' && attr.value) {
      return attr.value
    }
  }
  return undefined
}

function collectReturnedJSXFromExpression(
  expression: Expression,
  returned: JSXElementExpression[],
): void {
  if (expression.kind === 'JSXElement') {
    returned.push(expression)
    return
  }
  if (expression.kind === 'ConditionalExpression') {
    collectReturnedJSXFromExpression(expression.consequent, returned)
    collectReturnedJSXFromExpression(expression.alternate, returned)
    return
  }
  if (expression.kind === 'LogicalExpression') {
    collectReturnedJSXFromExpression(expression.left, returned)
    collectReturnedJSXFromExpression(expression.right, returned)
    return
  }
  if (expression.kind === 'SequenceExpression') {
    const tail = expression.expressions[expression.expressions.length - 1]
    if (tail) collectReturnedJSXFromExpression(tail, returned)
  }
}

function getReturnedJSXFromCallback(callback: Expression): JSXElementExpression[] {
  const returned: JSXElementExpression[] = []

  if (callback.kind === 'ArrowFunction') {
    if (callback.isExpression && !Array.isArray(callback.body)) {
      collectReturnedJSXFromExpression(callback.body, returned)
      return returned
    }
    if (Array.isArray(callback.body)) {
      for (const block of callback.body) {
        const term = block.terminator
        if (term.kind === 'Return' && term.argument) {
          collectReturnedJSXFromExpression(term.argument, returned)
        }
      }
    }
    return returned
  }

  if (callback.kind === 'FunctionExpression') {
    for (const block of callback.body ?? []) {
      const term = block.terminator
      if (term.kind === 'Return' && term.argument) {
        collectReturnedJSXFromExpression(term.argument, returned)
      }
    }
  }

  return returned
}

function keyExpressionSignature(expression: Expression): string {
  try {
    return (
      JSON.stringify(expression, (key, value) => {
        if (key === 'loc') return undefined
        if (typeof value === 'bigint') return `__bigint:${value.toString()}`
        return value
      }) ?? ''
    )
  } catch {
    return ''
  }
}

export function extractKeyFromMapCallback(callback: Expression): Expression | undefined {
  const returned = getReturnedJSXFromCallback(callback)
  if (returned.length === 0) return undefined

  const keyExpressions = returned.map(jsx => extractKeyFromAttributes(jsx.attributes))
  if (keyExpressions.some(expr => !expr)) return undefined

  const [firstKey, ...restKeys] = keyExpressions as Expression[]
  const firstSignature = keyExpressionSignature(firstKey)
  if (!firstSignature) return undefined

  const allBranchesSameKey = restKeys.every(
    keyExpr => keyExpressionSignature(keyExpr) === firstSignature,
  )
  if (!allBranchesSameKey) return undefined

  return firstKey
}
