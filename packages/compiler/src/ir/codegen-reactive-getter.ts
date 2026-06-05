import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'

export function markCompilerReactiveGetter(
  ctx: CodegenContext,
  getter: BabelCore.types.Expression,
): BabelCore.types.CallExpression {
  ctx.helpersUsed.add('reactiveGetter')
  return ctx.t.callExpression(runtimeIdentifier(ctx, 'reactiveGetter'), [getter])
}
