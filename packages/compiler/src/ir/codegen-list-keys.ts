import type { CodegenContext } from './codegen'
import { keyExpressionSignature } from './codegen-jsx-keys'
import type { Expression } from './hir'
import { deSSAVarName } from './regions'

/**
 * Check if a MemberExpression matches the list key pattern.
 * Matches equivalent item property reads when the key expression reads that same property.
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

  const exprObj = expr.object
  if (exprObj.kind !== 'Identifier') {
    return false
  }
  const exprItemName = deSSAVarName(exprObj.name)
  if (exprItemName !== ctx.listItemParamName) {
    return false
  }

  return memberPropertiesMatch(keyExpr, expr)
}

function getMemberPropertyName(expr: Expression): string | null {
  if (expr.kind === 'Identifier') return expr.name
  if (expr.kind === 'Literal') {
    if (typeof expr.value === 'string' || typeof expr.value === 'number') {
      return String(expr.value)
    }
  }
  return null
}

function hasComputedLiteralProperty(
  member: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
): boolean {
  return (
    member.computed &&
    member.property.kind === 'Literal' &&
    (typeof member.property.value === 'string' || typeof member.property.value === 'number')
  )
}

function memberPropertiesMatch(
  keyExpr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
): boolean {
  if ((keyExpr.optional ?? false) !== (expr.optional ?? false)) {
    return false
  }

  const keyPropName = getMemberPropertyName(keyExpr.property)
  const exprPropName = getMemberPropertyName(expr.property)
  if (keyPropName === null || exprPropName === null || keyPropName !== exprPropName) {
    return false
  }

  if (keyExpr.computed === expr.computed) return true

  return hasComputedLiteralProperty(keyExpr) || hasComputedLiteralProperty(expr)
}

export function isListKeyParamIdentifier(name: string, ctx: CodegenContext): boolean {
  if (!ctx.listKeyParamName) return false
  return deSSAVarName(name) === deSSAVarName(ctx.listKeyParamName)
}

export function getListKeyAliasReplacementName(name: string, ctx: CodegenContext): string | null {
  if (!ctx.inListRender || !ctx.listKeyParamName || !ctx.listKeyAliasNames) return null
  return ctx.listKeyAliasNames.has(deSSAVarName(name)) ? ctx.listKeyParamName : null
}

export function shouldSuppressListKeyBindingExpression(
  expr: Expression,
  ctx: CodegenContext,
): boolean {
  if (!ctx.inListRender || !ctx.listKeyParamName || !ctx.listKeyBindingSignatures) {
    return false
  }

  const signature = keyExpressionSignature(expr)
  return !!signature && ctx.listKeyBindingSignatures.has(signature)
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
