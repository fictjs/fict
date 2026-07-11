import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import type { NamespaceContext } from './codegen-template-extraction'

export type RuntimeElementNamespace = Exclude<NamespaceContext, null | 'parent'>

export function runtimeElementNamespace(
  namespace: NamespaceContext | undefined,
): RuntimeElementNamespace | null {
  return namespace === 'parent' ? null : (namespace ?? null)
}

export function createElementForNamespace(
  ctx: CodegenContext,
  namespace: NamespaceContext | undefined,
  parentMarker?: BabelCore.types.Expression,
): BabelCore.types.Expression {
  const { t } = ctx
  const nodeId = t.identifier('__node')
  if (namespace === 'parent') {
    if (!parentMarker) {
      throw new Error('Parent-derived namespace creation requires a marker.')
    }
    ctx.helpersUsed.add('createElementInParentNamespace')
    return t.arrowFunctionExpression(
      [nodeId],
      t.callExpression(runtimeIdentifier(ctx, 'createElementInParentNamespace'), [
        nodeId,
        t.memberExpression(parentMarker, t.identifier('parentNode')),
      ]),
    )
  }
  const runtimeNamespace = runtimeElementNamespace(namespace)
  if (!runtimeNamespace) {
    ctx.helpersUsed.add('createElement')
    return runtimeIdentifier(ctx, 'createElement')
  }

  ctx.helpersUsed.add('createElementInNamespace')
  return t.arrowFunctionExpression(
    [nodeId],
    t.callExpression(runtimeIdentifier(ctx, 'createElementInNamespace'), [
      nodeId,
      t.stringLiteral(runtimeNamespace),
    ]),
  )
}

export function appendKeyedListNamespaceArgs(
  ctx: CodegenContext,
  args: BabelCore.types.Expression[],
  namespace: NamespaceContext | undefined,
): void {
  if (namespace === 'parent') {
    const { t } = ctx
    while (args.length < 7) {
      args.push(t.unaryExpression('void', t.numericLiteral(0), true))
    }
    args.push(t.stringLiteral('parent'))
    return
  }
  const runtimeNamespace = runtimeElementNamespace(namespace)
  if (!runtimeNamespace) return

  const { t } = ctx
  while (args.length < 7) {
    args.push(t.unaryExpression('void', t.numericLiteral(0), true))
  }
  args.push(t.stringLiteral(runtimeNamespace))
}
