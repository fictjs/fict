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

function expressionCanReturnNonJSX(expression: Expression): boolean {
  if (expression.kind === 'JSXElement') {
    return false
  }
  if (expression.kind === 'SequenceExpression') {
    const tail = expression.expressions[expression.expressions.length - 1]
    return tail ? expressionCanReturnNonJSX(tail) : true
  }
  if (expression.kind === 'ConditionalExpression') {
    return (
      expressionCanReturnNonJSX(expression.consequent) ||
      expressionCanReturnNonJSX(expression.alternate)
    )
  }
  if (expression.kind === 'LogicalExpression') {
    return true
  }
  return true
}

function expressionContainsBranching(expression: Expression): boolean {
  if (expression.kind === 'ConditionalExpression' || expression.kind === 'LogicalExpression') {
    return true
  }
  if (expression.kind === 'SequenceExpression') {
    return expression.expressions.some(expressionContainsBranching)
  }
  return false
}

function expressionHasSequencePrefix(expression: Expression): boolean {
  if (expression.kind === 'SequenceExpression') {
    return expression.expressions.length > 1
  }
  if (expression.kind === 'ConditionalExpression') {
    return (
      expressionHasSequencePrefix(expression.consequent) ||
      expressionHasSequencePrefix(expression.alternate)
    )
  }
  if (expression.kind === 'LogicalExpression') {
    return (
      expressionHasSequencePrefix(expression.left) || expressionHasSequencePrefix(expression.right)
    )
  }
  return false
}

function isSafeToDuplicateForKeyExtraction(expression: Expression): boolean {
  switch (expression.kind) {
    case 'Literal':
    case 'Identifier':
    case 'ThisExpression':
      return true
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        isSafeToDuplicateForKeyExtraction(expression.object) &&
        (!expression.computed || isSafeToDuplicateForKeyExtraction(expression.property))
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        isSafeToDuplicateForKeyExtraction(expression.left) &&
        isSafeToDuplicateForKeyExtraction(expression.right)
      )
    case 'ConditionalExpression':
      return (
        isSafeToDuplicateForKeyExtraction(expression.test) &&
        isSafeToDuplicateForKeyExtraction(expression.consequent) &&
        isSafeToDuplicateForKeyExtraction(expression.alternate)
      )
    case 'UnaryExpression':
      return isSafeToDuplicateForKeyExtraction(expression.argument)
    case 'TemplateLiteral':
      return expression.expressions.every(isSafeToDuplicateForKeyExtraction)
    default:
      return false
  }
}

function extractKeyExpressionFromReturnedExpression(
  expression: Expression,
): Expression | undefined {
  if (expression.kind === 'JSXElement') {
    return extractKeyFromAttributes(expression.attributes)
  }
  if (expression.kind === 'ConditionalExpression') {
    const consequentKey = extractKeyExpressionFromReturnedExpression(expression.consequent)
    const alternateKey = extractKeyExpressionFromReturnedExpression(expression.alternate)
    if (!consequentKey || !alternateKey) return undefined
    if (
      !isSafeToDuplicateForKeyExtraction(expression.test) ||
      !isSafeToDuplicateForKeyExtraction(consequentKey) ||
      !isSafeToDuplicateForKeyExtraction(alternateKey)
    ) {
      return undefined
    }
    return {
      kind: 'ConditionalExpression',
      test: expression.test,
      consequent: consequentKey,
      alternate: alternateKey,
      loc: expression.loc,
    }
  }
  if (expression.kind === 'SequenceExpression') {
    const tail = expression.expressions[expression.expressions.length - 1]
    if (!tail) return undefined
    const tailKey = extractKeyExpressionFromReturnedExpression(tail)
    if (!tailKey) return undefined
    if (expression.expressions.length <= 1) return tailKey
    return {
      kind: 'SequenceExpression',
      expressions: [...expression.expressions.slice(0, -1), tailKey],
      loc: expression.loc,
    }
  }
  return undefined
}

function getReturnedKeyExpressionsFromCallback(callback: Expression): Expression[] {
  const returned: Expression[] = []

  if (callback.kind === 'ArrowFunction') {
    if (callback.isExpression && !Array.isArray(callback.body)) {
      const keyExpr = extractKeyExpressionFromReturnedExpression(callback.body)
      if (keyExpr) returned.push(keyExpr)
      return returned
    }
    if (Array.isArray(callback.body)) {
      for (const block of callback.body) {
        const term = block.terminator
        if (term.kind !== 'Return' || !term.argument) continue
        const keyExpr = extractKeyExpressionFromReturnedExpression(term.argument)
        if (keyExpr) returned.push(keyExpr)
      }
    }
    return returned
  }

  if (callback.kind === 'FunctionExpression') {
    for (const block of callback.body ?? []) {
      const term = block.terminator
      if (term.kind !== 'Return' || !term.argument) continue
      const keyExpr = extractKeyExpressionFromReturnedExpression(term.argument)
      if (keyExpr) returned.push(keyExpr)
    }
  }

  return returned
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

function getReturnedExpressionsFromCallback(callback: Expression): Expression[] {
  const returned: Expression[] = []

  if (callback.kind === 'ArrowFunction') {
    if (callback.isExpression && !Array.isArray(callback.body)) {
      returned.push(callback.body)
      return returned
    }
    if (Array.isArray(callback.body)) {
      for (const block of callback.body) {
        const term = block.terminator
        if (term.kind === 'Return' && term.argument) {
          returned.push(term.argument)
        }
      }
    }
    return returned
  }

  if (callback.kind === 'FunctionExpression') {
    for (const block of callback.body ?? []) {
      const term = block.terminator
      if (term.kind === 'Return' && term.argument) {
        returned.push(term.argument)
      }
    }
  }

  return returned
}

export function getReturnedJSXElementsFromMapCallback(
  callback: Expression,
): JSXElementExpression[] {
  return getReturnedJSXFromCallback(callback)
}

export function keyExpressionSignature(expression: Expression): string {
  try {
    return (
      JSON.stringify(expression, (key, value) => {
        if (key === 'loc') return undefined
        if (typeof value === 'bigint') {
          return { __fictLiteralType: 'bigint', value: value.toString() }
        }
        if (value instanceof RegExp) {
          return { __fictLiteralType: 'regexp', source: value.source, flags: value.flags }
        }
        return value
      }) ?? ''
    )
  } catch {
    return ''
  }
}

export function getReturnedKeyAttributeExpressionsFromMapCallback(
  callback: Expression,
): Expression[] {
  return getReturnedJSXFromCallback(callback)
    .map(jsx => extractKeyFromAttributes(jsx.attributes))
    .filter((expr): expr is Expression => !!expr)
}

export function extractKeyFromMapCallback(callback: Expression): Expression | undefined {
  const returnedKeyExpressions = getReturnedKeyExpressionsFromCallback(callback)
  if (returnedKeyExpressions.length === 1) {
    return returnedKeyExpressions[0]
  }
  if (returnedKeyExpressions.length > 1) {
    const [firstKey, ...restKeys] = returnedKeyExpressions
    if (!firstKey) return undefined
    const firstSignature = keyExpressionSignature(firstKey)
    if (
      firstSignature &&
      restKeys.every(keyExpr => keyExpressionSignature(keyExpr) === firstSignature)
    ) {
      return firstKey
    }
  }

  const returnedExpressions = getReturnedExpressionsFromCallback(callback)
  if (
    returnedExpressions.length === 0 ||
    returnedExpressions.some(expressionCanReturnNonJSX) ||
    returnedExpressions.some(expressionContainsBranching) ||
    returnedExpressions.some(expressionHasSequencePrefix)
  ) {
    return undefined
  }

  const returned = getReturnedJSXFromCallback(callback)
  if (returned.length === 0) return undefined

  const keyExpressions = returned.map(jsx => extractKeyFromAttributes(jsx.attributes))
  if (keyExpressions.some(expr => !expr)) return undefined

  const [firstKey, ...restKeys] = keyExpressions as Expression[]
  if (!firstKey) return undefined
  const firstSignature = keyExpressionSignature(firstKey)
  if (!firstSignature) return undefined

  const allBranchesSameKey = restKeys.every(
    keyExpr => keyExpressionSignature(keyExpr) === firstSignature,
  )
  if (!allBranchesSameKey) return undefined

  return firstKey
}
