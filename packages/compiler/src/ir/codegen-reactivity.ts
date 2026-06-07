import type { CodegenContext } from './codegen'
import { collectExpressionDependencies } from './codegen-expression-deps'
import { isListKeyDependency } from './codegen-list-keys'
import type { Expression } from './hir'

/**
 * Check if an HIR expression references a tracked/reactive variable.
 */
export function isExpressionReactive(expr: Expression, ctx: CodegenContext): boolean {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  for (const dep of deps) {
    if (isListKeyDependency(dep, ctx)) continue
    if (ctx.trackedVars.has(dep)) return true
  }

  if (ctx.memoVars) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (ctx.memoVars.has(dep)) return true
    }
  }

  if (ctx.signalVars) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (ctx.signalVars.has(dep)) return true
    }
  }

  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        return true
      }
    }
  }

  return false
}

/**
 * Get reactive dependencies of an expression that require binding.
 */
export function getReactiveDependencies(expr: Expression, ctx: CodegenContext): Set<string> {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  const reactiveDeps = new Set<string>()

  for (const dep of deps) {
    if (isListKeyDependency(dep, ctx)) continue
    if (ctx.trackedVars.has(dep)) {
      reactiveDeps.add(dep)
    }
  }

  if (ctx.memoVars) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (ctx.memoVars.has(dep)) {
        reactiveDeps.add(dep)
      }
    }
  }

  if (ctx.signalVars) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (ctx.signalVars.has(dep)) {
        reactiveDeps.add(dep)
      }
    }
  }

  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (isListKeyDependency(dep, ctx)) continue
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        reactiveDeps.add(dep)
      }
    }
  }

  return reactiveDeps
}

interface HookInfoLike {
  directAccessor?: string | undefined
}

export interface TextExpressionOps {
  getHookReturnInfo: (name: string, ctx: CodegenContext) => HookInfoLike | null
}

export function isLikelyTextExpression(
  expr: Expression,
  ctx: CodegenContext,
  ops: TextExpressionOps,
): boolean {
  let ok = true
  const isReactiveIdentifier = (name: string) => {
    if (ctx.storeVars?.has(name)) return false
    const isAlias = ctx.aliasVars?.has(name) ?? false
    if (!isAlias && ctx.memoVars?.has(name)) return false
    if (ctx.trackedVars.has(name)) return true
    if (ctx.signalVars?.has(name) || isAlias) return true
    const hookName = ctx.hookResultVarMap?.get(name)
    if (hookName) {
      const info = ops.getHookReturnInfo(hookName, ctx)
      if (info?.directAccessor) return true
    }
    return false
  }
  const getRootIdentifierName = (node: Expression): string | null => {
    if (node.kind === 'Identifier') return node.name
    if (node.kind === 'MemberExpression' || node.kind === 'OptionalMemberExpression') {
      return getRootIdentifierName(node.object)
    }
    return null
  }
  const getStaticPropertyName = (node: Expression): string | null => {
    if (node.kind !== 'MemberExpression' && node.kind !== 'OptionalMemberExpression') return null
    if (!node.computed && node.property.kind === 'Identifier') return node.property.name
    if (node.property.kind === 'Literal') return String(node.property.value)
    return null
  }
  const isAmbiguousRootChildValue = (node: Expression): boolean => {
    if (node.kind === 'Identifier') return isReactiveIdentifier(node.name)
    if (node.kind === 'MemberExpression' || node.kind === 'OptionalMemberExpression') {
      const rootName = getRootIdentifierName(node)
      const propertyName = getStaticPropertyName(node)
      return propertyName === 'children' || (!!rootName && isReactiveIdentifier(rootName))
    }
    return false
  }
  if (isAmbiguousRootChildValue(expr)) {
    return false
  }
  const visit = (node: Expression, allowNonSignalReference = false): void => {
    if (!ok) return
    switch (node.kind) {
      case 'JSXElement':
      case 'ArrayExpression':
      case 'ObjectExpression':
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'ClassExpression':
      case 'NewExpression':
        ok = false
        return
      case 'CallExpression':
      case 'OptionalCallExpression':
        ok = false
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object, true)
        if (node.computed) {
          visit(node.property)
        }
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(node.left)
        visit(node.right)
        return
      case 'ConditionalExpression':
        visit(node.test)
        visit(node.consequent)
        visit(node.alternate)
        return
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'AwaitExpression':
        visit(node.argument)
        return
      case 'AssignmentExpression':
        visit(node.left)
        visit(node.right)
        return
      case 'SequenceExpression':
        node.expressions.forEach(item => visit(item))
        return
      case 'TemplateLiteral':
        node.expressions.forEach(item => visit(item))
        return
      case 'TaggedTemplateExpression':
        visit(node.tag)
        node.quasi.expressions.forEach(item => visit(item))
        return
      case 'YieldExpression':
        if (node.argument) visit(node.argument)
        return
      case 'SpreadElement':
        visit(node.argument)
        return
      case 'ImportExpression':
      case 'MetaProperty':
        ok = false
        return
      case 'Identifier':
        if (!isReactiveIdentifier(node.name) && !allowNonSignalReference) {
          ok = false
        }
        return
      case 'Literal':
      case 'SuperExpression':
        return
      case 'ThisExpression':
        ok = false
        return
      default:
        ok = false
        return
    }
  }

  visit(expr)
  return ok
}
