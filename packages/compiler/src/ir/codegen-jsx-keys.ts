import type { Expression, JSXAttribute, JSXElementExpression } from './hir'

function extractKeyFromAttributes(attributes: JSXAttribute[]): Expression | undefined {
  for (const attr of attributes) {
    if (attr.name === 'key' && attr.value) {
      return attr.value
    }
  }
  return undefined
}

function getReturnedJSXFromCallback(callback: Expression): JSXElementExpression | null {
  if (callback.kind === 'ArrowFunction') {
    if (
      callback.isExpression &&
      !Array.isArray(callback.body) &&
      callback.body.kind === 'JSXElement'
    ) {
      return callback.body
    }
    if (Array.isArray(callback.body)) {
      for (const block of callback.body) {
        const term = block.terminator
        if (term.kind === 'Return' && term.argument?.kind === 'JSXElement') {
          return term.argument as JSXElementExpression
        }
      }
    }
  }
  if (callback.kind === 'FunctionExpression') {
    for (const block of callback.body ?? []) {
      const term = block.terminator
      if (term.kind === 'Return' && term.argument?.kind === 'JSXElement') {
        return term.argument as JSXElementExpression
      }
    }
  }
  return null
}

export function extractKeyFromMapCallback(callback: Expression): Expression | undefined {
  const jsx = getReturnedJSXFromCallback(callback)
  if (!jsx) return undefined
  return extractKeyFromAttributes(jsx.attributes)
}
