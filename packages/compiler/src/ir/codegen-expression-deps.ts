import { extractDependencyPath, type Expression } from './hir'
import { deSSAVarName } from './regions'
import { walkExpression } from './walk-expression'

interface CollectExpressionDependencyOptions {
  includeFunctionBodies?: boolean
  includeImmediatelyInvokedFunctionBodies?: boolean
}

function getMemberDependencyPath(expr: Expression): string | undefined {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return undefined
  const depPath = extractDependencyPath(expr)
  if (!depPath || depPath.segments.length === 0) return undefined
  const base = deSSAVarName(depPath.base)
  // Conservative rule: any computed access is tracked at base-object granularity
  // to avoid ambiguous dep keys like obj[key] -> obj.key.
  if (depPath.segments.some(segment => segment.computed)) {
    return base
  }
  const tail = depPath.segments.map(segment => segment.property).join('.')
  return tail ? `${base}.${tail}` : undefined
}

export function collectExpressionDependencies(
  expr: Expression,
  deps: Set<string>,
  options: CollectExpressionDependencyOptions = {},
): void {
  walkExpression(
    expr,
    node => {
      if (
        options.includeImmediatelyInvokedFunctionBodies &&
        (node.kind === 'CallExpression' || node.kind === 'OptionalCallExpression') &&
        (node.callee.kind === 'ArrowFunction' || node.callee.kind === 'FunctionExpression')
      ) {
        collectExpressionDependencies(node.callee, deps, {
          ...options,
          includeFunctionBodies: true,
          includeImmediatelyInvokedFunctionBodies: false,
        })
      }
      if (node.kind === 'Identifier') {
        deps.add(deSSAVarName(node.name))
        return
      }
      const path = getMemberDependencyPath(node)
      if (path) {
        deps.add(path)
      }
    },
    options,
  )
}
