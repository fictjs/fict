import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'

export function markCompilerReactiveGetter(
  ctx: CodegenContext,
  getter: BabelCore.types.Expression,
): BabelCore.types.CallExpression {
  ctx.helpersUsed.add('reactiveGetter')
  return ctx.t.callExpression(ctx.t.identifier(RUNTIME_ALIASES.reactiveGetter), [getter])
}
