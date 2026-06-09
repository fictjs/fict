import type { CodegenContext } from './codegen'
import type { Expression, HIRFunction } from './hir'
import { deSSAVarName, isRegionMemoizable } from './regions'
import type { RegionResult } from './regions'
import type { SSAEnhancedScopeResult } from './scopes'
import { walkExpression } from './walk-expression'

export function emitReactiveControlFlowReexecutionWarning(
  fn: HIRFunction,
  scopeResult: SSAEnhancedScopeResult,
  ctx: CodegenContext,
  options: {
    hasJSX: boolean
    isComponent: boolean
    regionResult?: RegionResult
    controlFlowReturnsLowered?: boolean
  },
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

  const guaranteedControlFlowReads = collectGuaranteedControlFlowReads(options.regionResult)
  if (options.controlFlowReturnsLowered) {
    collectSimpleBranchControlFlowReads(fn).forEach(name => guaranteedControlFlowReads.add(name))
  }
  const unsupportedControlFlowReads = collectUnsupportedControlFlowReads(fn)
  const controlFlowReactiveReads = new Set<string>()
  for (const name of scopeResult.controlFlowAnalysis.controlFlowReads) {
    const base = deSSAVarName(name)
    if (
      reactiveVars.has(base) &&
      (!guaranteedControlFlowReads.has(base) || unsupportedControlFlowReads.has(base))
    ) {
      controlFlowReactiveReads.add(base)
    }
  }
  for (const name of scopeResult.controlFlowAnalysis.mixedReads) {
    const base = deSSAVarName(name)
    if (
      reactiveVars.has(base) &&
      (!guaranteedControlFlowReads.has(base) || unsupportedControlFlowReads.has(base))
    ) {
      controlFlowReactiveReads.add(base)
    }
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

function collectSimpleBranchControlFlowReads(fn: HIRFunction): Set<string> {
  const reads = new Set<string>()
  for (const block of fn.blocks) {
    const term = block.terminator
    if (term.kind === 'Branch') {
      if (!containsCallLikeExpression(term.test)) collectExpressionReads(term.test, reads)
    } else if (term.kind === 'Switch') {
      if (!containsCallLikeExpression(term.discriminant)) {
        collectExpressionReads(term.discriminant, reads)
      }
    }
  }
  return reads
}

function collectGuaranteedControlFlowReads(regionResult: RegionResult | undefined): Set<string> {
  const reads = new Set<string>()
  if (!regionResult) return reads
  for (const region of regionResult.regions) {
    if (!region.hasControlFlow || !isRegionMemoizable(region)) continue
    for (const dependency of region.dependencies) {
      const base = deSSAVarName(dependency.split('.')[0] ?? dependency)
      reads.add(base)
    }
  }
  return reads
}

function collectUnsupportedControlFlowReads(fn: HIRFunction): Set<string> {
  const reads = new Set<string>()
  for (const block of fn.blocks) {
    const term = block.terminator
    switch (term.kind) {
      case 'Branch':
        if (containsCallLikeExpression(term.test)) collectExpressionReads(term.test, reads)
        break
      case 'Switch':
        if (containsCallLikeExpression(term.discriminant)) {
          collectExpressionReads(term.discriminant, reads)
        }
        break
      case 'ForOf':
        collectExpressionReads(term.iterable, reads)
        if (term.assignmentTarget) collectExpressionReads(term.assignmentTarget, reads)
        break
      case 'ForIn':
        collectExpressionReads(term.object, reads)
        if (term.assignmentTarget) collectExpressionReads(term.assignmentTarget, reads)
        break
      default:
        break
    }
  }
  return reads
}

function containsCallLikeExpression(expr: Expression): boolean {
  let found = false
  walkExpression(
    expr,
    node => {
      switch (node.kind) {
        case 'CallExpression':
        case 'OptionalCallExpression':
        case 'NewExpression':
        case 'ImportExpression':
        case 'TaggedTemplateExpression':
          found = true
          break
        default:
          break
      }
    },
    { includeFunctionBodies: false },
  )
  return found
}

function collectExpressionReads(expr: Expression, reads: Set<string>): void {
  walkExpression(
    expr,
    node => {
      if (node.kind === 'Identifier') reads.add(deSSAVarName(node.name))
    },
    { includeFunctionBodies: false },
  )
}
