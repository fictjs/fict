import type * as BabelCore from '@babel/core'

import type { CodegenContext, RegionInfo } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import type { NamespaceContext } from './codegen-template-extraction'
import type { Expression } from './hir'

export interface HIRChildBindingOps {
  emitConditionalChild: (
    markerId: BabelCore.types.Identifier,
    endMarkerId: BabelCore.types.Identifier,
    expr: Expression,
    statements: BabelCore.types.Statement[],
    ctx: CodegenContext,
  ) => void
  emitListChild: (
    markerId: BabelCore.types.Identifier,
    endMarkerId: BabelCore.types.Identifier,
    expr: Expression,
    statements: BabelCore.types.Statement[],
    ctx: CodegenContext,
  ) => boolean
  genTemp: (ctx: CodegenContext, prefix?: string) => BabelCore.types.Identifier
  lowerDomExpression: (
    expr: Expression,
    ctx: CodegenContext,
    containingRegion?: RegionInfo | null,
  ) => BabelCore.types.Expression
  lowerExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
  lowerJSXElement: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
}

function isRuntimeCreatePortalCall(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression') return false
  if (expr.callee.kind !== 'Identifier') return false
  const name = expr.callee.name
  if (ctx.shadowedNames?.has(name) || ctx.localDeclaredNames?.has(name)) {
    return false
  }
  return ctx.moduleRuntimeImportMap?.get(name) === 'createPortal'
}

/**
 * Resolve a path to a DOM node using firstChild/nextSibling navigation.
 * Caches intermediate nodes for efficiency.
 */
export function resolveHIRBindingPath(
  path: number[],
  cache: Map<string, BabelCore.types.Identifier>,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  genTemp: (ctx: CodegenContext, prefix?: string) => BabelCore.types.Identifier,
): BabelCore.types.Identifier {
  const key = path.join(',')
  if (cache.has(key)) return cache.get(key)!

  const { t } = ctx

  // Find closest ancestor in cache
  const ancestorPath = [...path]
  let ancestorId: BabelCore.types.Identifier | undefined
  let relativePath: number[] = []

  while (ancestorPath.length > 0) {
    ancestorPath.pop()
    const ancestorKey = ancestorPath.join(',')
    if (cache.has(ancestorKey)) {
      ancestorId = cache.get(ancestorKey)
      relativePath = path.slice(ancestorPath.length)
      break
    }
  }

  if (!ancestorId) {
    ancestorId = cache.get('')!
    relativePath = path
  }

  if (relativePath.length === 0) {
    cache.set(key, ancestorId)
    return ancestorId
  }

  // Navigate relative path using runtime helper that skips slot ranges
  ctx.helpersUsed.add('resolvePath')
  const pathExpr = t.arrayExpression(relativePath.map(index => t.numericLiteral(index)))
  const currentExpr = t.callExpression(runtimeIdentifier(ctx, 'resolvePath'), [
    ancestorId,
    pathExpr,
  ])

  const varId = genTemp(ctx, 'el')
  statements.push(t.variableDeclaration('const', [t.variableDeclarator(varId, currentExpr)]))
  cache.set(key, varId)
  return varId
}

/**
 * Emit a child binding at a placeholder comment node.
 * Accepts namespace parameter for proper SVG/MathML context.
 */
export function emitHIRChildBinding(
  markerId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
  ops: HIRChildBindingOps,
  namespace?: NamespaceContext,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('getSlotEnd')
  const endMarkerId = ops.genTemp(ctx, 'end')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        endMarkerId,
        t.callExpression(runtimeIdentifier(ctx, 'getSlotEnd'), [markerId]),
      ),
    ]),
  )

  // Set namespace context for child element lowering
  if (namespace !== undefined) {
    ctx.namespaceContext = namespace
  }

  // createPortal call inside JSX child: register cleanup but don't insert marker into parent
  if (isRuntimeCreatePortalCall(expr, ctx)) {
    ctx.helpersUsed.add('onDestroy')
    const portalId = ops.genTemp(ctx, 'portal')
    const portalExpr = ops.lowerExpression(expr, ctx)
    statements.push(
      t.variableDeclaration('const', [t.variableDeclarator(portalId, portalExpr)]),
      t.expressionStatement(
        t.callExpression(runtimeIdentifier(ctx, 'onDestroy'), [
          t.memberExpression(portalId, t.identifier('dispose')),
        ]),
      ),
    )
    return
  }

  // Check if it's a conditional
  if (
    expr.kind === 'ConditionalExpression' ||
    (expr.kind === 'LogicalExpression' && expr.operator === '&&')
  ) {
    ops.emitConditionalChild(markerId, endMarkerId, expr, statements, ctx)
    return
  }

  // Check if it's a list (.map call), including optional chaining
  if (expr.kind === 'CallExpression' || expr.kind === 'OptionalCallExpression') {
    const callee = expr.callee
    if (
      (callee.kind === 'MemberExpression' || callee.kind === 'OptionalMemberExpression') &&
      callee.property.kind === 'Identifier' &&
      callee.property.name === 'map'
    ) {
      if (ops.emitListChild(markerId, endMarkerId, expr, statements, ctx)) {
        return
      }
    }
  }

  // Check if it's a JSX element
  if (expr.kind === 'JSXElement') {
    const childExpr = ops.lowerJSXElement(expr, ctx)
    ctx.helpersUsed.add('insertBetween')
    ctx.helpersUsed.add('createElement')
    statements.push(
      t.expressionStatement(
        t.callExpression(runtimeIdentifier(ctx, 'insertBetween'), [
          markerId,
          endMarkerId,
          t.arrowFunctionExpression([], childExpr),
          runtimeIdentifier(ctx, 'createElement'),
        ]),
      ),
    )
    return
  }

  // Default: insert dynamic expression
  const valueExpr = ops.lowerDomExpression(expr, ctx, containingRegion)
  ctx.helpersUsed.add('insertBetween')
  ctx.helpersUsed.add('createElement')
  statements.push(
    t.expressionStatement(
      t.callExpression(runtimeIdentifier(ctx, 'insertBetween'), [
        markerId,
        endMarkerId,
        t.arrowFunctionExpression([], valueExpr),
        runtimeIdentifier(ctx, 'createElement'),
      ]),
    ),
  )
}
