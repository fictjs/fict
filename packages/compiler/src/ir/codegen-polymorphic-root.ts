import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { getSSABaseName, type Expression } from './hir'

export function withDeferredJSXMaterialization<T>(ctx: CodegenContext, fn: () => T): T {
  const previous = ctx.deferJSXMaterialization
  ctx.deferJSXMaterialization = true
  try {
    return fn()
  } finally {
    ctx.deferJSXMaterialization = previous
  }
}

export function createPolymorphicRootResult(
  ctx: CodegenContext,
  options: {
    tagName: string
    elementNamespace: 'html' | 'svg' | 'mathml'
    optimizedResult: BabelCore.types.Expression
    qrls: WeakMap<Expression, Map<string, BabelCore.types.Expression>> | null
    createFallbackVNode: () => BabelCore.types.Expression
  },
): BabelCore.types.Expression {
  const { t } = ctx
  ctx.helpersUsed.add('elementNamespaceMatches')
  const namespaceMatches = t.callExpression(runtimeIdentifier(ctx, 'elementNamespaceMatches'), [
    t.stringLiteral(options.tagName),
    t.stringLiteral(options.elementNamespace),
  ])
  const previousQrls = ctx.polymorphicRootQrls
  ctx.polymorphicRootQrls = options.qrls ?? undefined
  let fallbackVNode: BabelCore.types.Expression
  try {
    fallbackVNode = options.createFallbackVNode()
  } finally {
    ctx.polymorphicRootQrls = previousQrls
  }

  const assignmentTarget = ctx.jsxAssignmentTargetName
    ? getSSABaseName(ctx.jsxAssignmentTargetName)
    : null
  const fallbackNeedsDOM =
    assignmentTarget !== null && !(ctx.renderOnlyJSXLocalNames?.has(assignmentTarget) ?? false)
  let fallbackResult = fallbackVNode
  if (fallbackNeedsDOM) {
    ctx.helpersUsed.add('createElement')
    fallbackResult = t.callExpression(runtimeIdentifier(ctx, 'createElement'), [fallbackVNode])
  }
  return t.conditionalExpression(namespaceMatches, options.optimizedResult, fallbackResult)
}
