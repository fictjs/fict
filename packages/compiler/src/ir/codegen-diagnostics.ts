import type { CodegenContext } from './codegen'
import type { Expression, HIRFunction } from './hir'
import { deSSAVarName, isRegionMemoizable } from './regions'
import type { RegionResult } from './regions'
import type { SSAEnhancedScopeResult } from './scopes'

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
  switch (expr.kind) {
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'ImportExpression':
    case 'TaggedTemplateExpression':
      return true
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return containsCallLikeExpression(expr.object) || containsCallLikeExpression(expr.property)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return containsCallLikeExpression(expr.left) || containsCallLikeExpression(expr.right)
    case 'UnaryExpression':
      return containsCallLikeExpression(expr.argument)
    case 'ConditionalExpression':
      return (
        containsCallLikeExpression(expr.test) ||
        containsCallLikeExpression(expr.consequent) ||
        containsCallLikeExpression(expr.alternate)
      )
    case 'ArrayExpression':
      return expr.elements.some(element => element && containsCallLikeExpression(element))
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'Property') {
          return containsCallLikeExpression(prop.key) || containsCallLikeExpression(prop.value)
        }
        if (prop.kind === 'SpreadElement') return containsCallLikeExpression(prop.argument)
        return false
      })
    case 'JSXElement':
      return (
        (typeof expr.tagName !== 'string' && containsCallLikeExpression(expr.tagName)) ||
        expr.attributes.some(attr =>
          attr.isSpread
            ? !!attr.spreadExpr && containsCallLikeExpression(attr.spreadExpr)
            : !!attr.value && containsCallLikeExpression(attr.value),
        ) ||
        expr.children.some(child =>
          child.kind === 'text' ? false : containsCallLikeExpression(child.value),
        )
      )
    case 'AssignmentExpression':
      return containsCallLikeExpression(expr.left) || containsCallLikeExpression(expr.right)
    case 'UpdateExpression':
      return containsCallLikeExpression(expr.argument)
    case 'AwaitExpression':
      return containsCallLikeExpression(expr.argument)
    case 'SequenceExpression':
      return expr.expressions.some(containsCallLikeExpression)
    case 'YieldExpression':
      return !!expr.argument && containsCallLikeExpression(expr.argument)
    case 'TemplateLiteral':
      return expr.expressions.some(containsCallLikeExpression)
    case 'ClassExpression':
      return !!expr.superClass && containsCallLikeExpression(expr.superClass)
    default:
      return false
  }
}

function collectExpressionReads(expr: Expression, reads: Set<string>): void {
  switch (expr.kind) {
    case 'Identifier':
      reads.add(deSSAVarName(expr.name))
      return
    case 'CallExpression':
    case 'OptionalCallExpression':
      collectExpressionReads(expr.callee, reads)
      expr.arguments.forEach(arg => collectExpressionReads(arg, reads))
      return
    case 'NewExpression':
      collectExpressionReads(expr.callee, reads)
      expr.arguments.forEach(arg => collectExpressionReads(arg, reads))
      return
    case 'ImportExpression':
      collectExpressionReads(expr.source, reads)
      if (expr.options) collectExpressionReads(expr.options, reads)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExpressionReads(expr.object, reads)
      if (expr.computed) collectExpressionReads(expr.property, reads)
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExpressionReads(expr.left, reads)
      collectExpressionReads(expr.right, reads)
      return
    case 'UnaryExpression':
      collectExpressionReads(expr.argument, reads)
      return
    case 'ConditionalExpression':
      collectExpressionReads(expr.test, reads)
      collectExpressionReads(expr.consequent, reads)
      collectExpressionReads(expr.alternate, reads)
      return
    case 'ArrayExpression':
      expr.elements.forEach(element => {
        if (element) collectExpressionReads(element, reads)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'Property') {
          if (prop.computed) collectExpressionReads(prop.key, reads)
          collectExpressionReads(prop.value, reads)
        } else if (prop.kind === 'SpreadElement') {
          collectExpressionReads(prop.argument, reads)
        }
      })
      return
    case 'JSXElement':
      if (typeof expr.tagName !== 'string') collectExpressionReads(expr.tagName, reads)
      expr.children.forEach(child => {
        if (child.kind !== 'text') collectExpressionReads(child.value, reads)
      })
      expr.attributes.forEach(attr => {
        if (attr.isSpread) {
          if (attr.spreadExpr) collectExpressionReads(attr.spreadExpr, reads)
        } else if (attr.value) {
          collectExpressionReads(attr.value, reads)
        }
      })
      return
    case 'ArrowFunction':
    case 'FunctionExpression':
      return
    case 'ClassExpression':
      if (expr.superClass) collectExpressionReads(expr.superClass, reads)
      return
    case 'AssignmentExpression':
      collectExpressionReads(expr.left, reads)
      collectExpressionReads(expr.right, reads)
      return
    case 'UpdateExpression':
      collectExpressionReads(expr.argument, reads)
      return
    case 'AwaitExpression':
      collectExpressionReads(expr.argument, reads)
      return
    case 'SequenceExpression':
      expr.expressions.forEach(item => collectExpressionReads(item, reads))
      return
    case 'YieldExpression':
      if (expr.argument) collectExpressionReads(expr.argument, reads)
      return
    case 'TaggedTemplateExpression':
      collectExpressionReads(expr.tag, reads)
      expr.quasi.expressions.forEach(item => collectExpressionReads(item, reads))
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(item => collectExpressionReads(item, reads))
      return
    default:
      return
  }
}
