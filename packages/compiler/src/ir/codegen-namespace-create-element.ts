import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import type { NamespaceContext } from './codegen-template-extraction'

export type RuntimeElementNamespace = 'svg' | 'mathml'

export function runtimeElementNamespace(
  namespace: NamespaceContext | undefined,
): RuntimeElementNamespace | null {
  return namespace === 'svg' || namespace === 'mathml' ? namespace : null
}

export function createElementForNamespace(
  ctx: CodegenContext,
  namespace: NamespaceContext | undefined,
): BabelCore.types.Expression {
  const runtimeNamespace = runtimeElementNamespace(namespace)
  if (!runtimeNamespace) {
    ctx.helpersUsed.add('createElement')
    return runtimeIdentifier(ctx, 'createElement')
  }

  const { t } = ctx
  const nodeId = t.identifier('__node')
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
  const runtimeNamespace = runtimeElementNamespace(namespace)
  if (!runtimeNamespace) return

  const { t } = ctx
  while (args.length < 7) {
    args.push(t.unaryExpression('void', t.numericLiteral(0), true))
  }
  args.push(t.stringLiteral(runtimeNamespace))
}
