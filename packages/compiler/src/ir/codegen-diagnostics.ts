import type { CodegenContext } from './codegen'
import type { HIRFunction } from './hir'
import { deSSAVarName } from './regions'
import type { SSAEnhancedScopeResult } from './scopes'

export function emitReactiveControlFlowReexecutionWarning(
  fn: HIRFunction,
  scopeResult: SSAEnhancedScopeResult,
  ctx: CodegenContext,
  options: { hasJSX: boolean; isComponent: boolean },
): void {
  if (!options.hasJSX || !options.isComponent) return
  const onWarn = ctx.options?.onWarn
  if (!onWarn) return

  const warningKey = `${fn.name ?? '<anonymous>'}:${fn.loc?.start.line ?? 0}:${fn.loc?.start.column ?? 0}`
  const warned = ctx.controlFlowReexecWarnings ?? (ctx.controlFlowReexecWarnings = new Set())
  if (warned.has(warningKey)) return

  const reactiveVars = new Set<string>(ctx.trackedVars)
  ;(ctx.signalVars ?? []).forEach(name => reactiveVars.add(name))
  ;(ctx.storeVars ?? []).forEach(name => reactiveVars.add(name))
  ;(ctx.memoVars ?? []).forEach(name => reactiveVars.add(name))
  ;(ctx.aliasVars ?? []).forEach(name => reactiveVars.add(name))
  if (reactiveVars.size === 0) return

  const controlFlowReactiveReads = new Set<string>()
  for (const name of scopeResult.controlFlowAnalysis.controlFlowReads) {
    const base = deSSAVarName(name)
    if (reactiveVars.has(base)) controlFlowReactiveReads.add(base)
  }
  for (const name of scopeResult.controlFlowAnalysis.mixedReads) {
    const base = deSSAVarName(name)
    if (reactiveVars.has(base)) controlFlowReactiveReads.add(base)
  }
  if (controlFlowReactiveReads.size === 0) return

  warned.add(warningKey)
  const vars = Array.from(controlFlowReactiveReads).sort()
  const displayed = vars.slice(0, 5).join(', ')
  const remainder = vars.length > 5 ? ` (+${vars.length - 5} more)` : ''
  const loc = fn.loc?.start
  onWarn({
    code: 'FICT-R006',
    message:
      `Reactive control-flow reads (${displayed}${remainder}) force region re-execution. ` +
      `Prefer expression-only branching in JSX (e.g. ternary/logical) when you want finer-grained updates.`,
    fileName: ctx.options?.filename ?? '<unknown>',
    line: loc?.line ?? 0,
    column: loc ? loc.column + 1 : 0,
  })
}
