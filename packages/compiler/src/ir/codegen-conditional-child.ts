import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'
import type { Expression } from './hir'

export interface ConditionalChildOps {
  buildListCallExpression: (
    expr: Expression,
    statements: BabelCore.types.Statement[],
    ctx: CodegenContext,
  ) => BabelCore.types.Expression | null
  genTemp: (ctx: CodegenContext, prefix?: string) => BabelCore.types.Identifier
  lowerDomExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
}

/**
 * Emit a conditional child expression.
 */
export function emitConditionalChild(
  startMarkerId: BabelCore.types.Expression,
  endMarkerId: BabelCore.types.Expression,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  ops: ConditionalChildOps,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('conditional')
  ctx.helpersUsed.add('createElement')
  ctx.helpersUsed.add('onDestroy')

  let condition: BabelCore.types.Expression
  let consequent: BabelCore.types.Expression
  let alternate: BabelCore.types.Expression | null = null
  const lowerBranch = (branch: Expression): BabelCore.types.Expression => {
    const listExpr = ops.buildListCallExpression(branch, statements, ctx)
    if (listExpr) return listExpr
    return ops.lowerDomExpression(branch, ctx)
  }

  const enterConditional = () => {
    ctx.inConditional = (ctx.inConditional ?? 0) + 1
  }
  const exitConditional = () => {
    ctx.inConditional = Math.max(0, (ctx.inConditional ?? 1) - 1)
  }

  if (expr.kind === 'ConditionalExpression') {
    condition = ops.lowerDomExpression(expr.test, ctx)
    enterConditional()
    consequent = lowerBranch(expr.consequent)
    alternate = lowerBranch(expr.alternate)
    exitConditional()
  } else if (expr.kind === 'LogicalExpression' && expr.operator === '&&') {
    condition = ops.lowerDomExpression(expr.left, ctx)
    enterConditional()
    consequent = lowerBranch(expr.right)
    exitConditional()
  } else {
    return
  }

  const bindingId = ops.genTemp(ctx, 'cond')
  const args: BabelCore.types.Expression[] = [
    t.arrowFunctionExpression([], condition),
    t.arrowFunctionExpression([], consequent),
    t.identifier(RUNTIME_ALIASES.createElement),
  ]
  if (alternate) {
    args.push(t.arrowFunctionExpression([], alternate))
  } else {
    args.push(t.identifier('undefined'))
  }
  args.push(startMarkerId, endMarkerId)

  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        bindingId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), args),
      ),
    ]),
  )

  // Flush and cleanup.
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(bindingId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(bindingId, t.identifier('dispose')),
      ]),
    ),
  )
}
