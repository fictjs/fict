import type { CodegenContext } from './codegen'
import type { Expression } from './hir'
import { deSSAVarName } from './regions'

/**
 * Check if a MemberExpression matches the list key pattern.
 * Matches `item.prop` when key expression is `item.prop`.
 */
export function matchesListKeyPattern(expr: Expression, ctx: CodegenContext): boolean {
  if (!ctx.listKeyExpr || !ctx.listItemParamName || !ctx.listKeyParamName) {
    return false
  }

  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') {
    return false
  }

  const keyExpr = ctx.listKeyExpr
  if (keyExpr.kind !== 'MemberExpression' && keyExpr.kind !== 'OptionalMemberExpression') {
    return false
  }

  if (keyExpr.object.kind !== 'Identifier') {
    return false
  }
  const keyItemName = deSSAVarName(keyExpr.object.name)
  if (keyItemName !== ctx.listItemParamName) {
    return false
  }

  if (keyExpr.property.kind !== 'Identifier' && keyExpr.property.kind !== 'Literal') {
    return false
  }
  const keyPropName =
    keyExpr.property.kind === 'Identifier' ? keyExpr.property.name : String(keyExpr.property.value)

  const exprObj = expr.object
  if (exprObj.kind !== 'Identifier') {
    return false
  }
  const exprItemName = deSSAVarName(exprObj.name)
  if (exprItemName !== ctx.listItemParamName) {
    return false
  }

  if (expr.property.kind !== 'Identifier' && expr.property.kind !== 'Literal') {
    return false
  }
  const exprPropName =
    expr.property.kind === 'Identifier' ? expr.property.name : String(expr.property.value)

  return exprPropName === keyPropName
}

export function isListKeyParamIdentifier(name: string, ctx: CodegenContext): boolean {
  if (!ctx.listKeyParamName) return false
  return deSSAVarName(name) === deSSAVarName(ctx.listKeyParamName)
}

export function isListKeyConstExpression(expr: Expression, ctx: CodegenContext): boolean {
  if (!ctx.inListRender || !ctx.listKeyParamName) return false
  if (expr.kind === 'Identifier' && isListKeyParamIdentifier(expr.name, ctx)) {
    return true
  }
  return matchesListKeyPattern(expr, ctx)
}

export function isListKeyDependency(dep: string, ctx: CodegenContext): boolean {
  if (!ctx.inListRender || !ctx.listKeyParamName) return false
  const key = deSSAVarName(ctx.listKeyParamName)
  return dep === key || dep.startsWith(`${key}.`)
}

export function isStaticDelegatedDataExpression(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind === 'Literal') return true
  return isListKeyConstExpression(expr, ctx)
}
