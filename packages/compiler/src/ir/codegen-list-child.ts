import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'
import { extractKeyFromMapCallback } from './codegen-jsx-keys'
import { replaceIdentifiersWithOverrides, type RegionOverrideMap } from './codegen-overrides'
import { applySelectorHoist } from './codegen-selector-hoist'
import type { Expression } from './hir'
import { deSSAVarName } from './regions'

export interface ListChildOps {
  applyRegionMetadataToExpression: (
    expr: BabelCore.types.Expression,
    ctx: CodegenContext,
  ) => BabelCore.types.Expression
  genTemp: (ctx: CodegenContext, prefix?: string) => BabelCore.types.Identifier
  lowerDomExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
  lowerExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
}

/**
 * Build a list binding call expression (array.map).
 */
export function buildListCallExpression(
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  ops: ListChildOps,
): BabelCore.types.Expression | null {
  const { t } = ctx

  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') {
    return null
  }
  if (expr.callee.kind !== 'MemberExpression' && expr.callee.kind !== 'OptionalMemberExpression') {
    return null
  }
  if (expr.callee.property.kind !== 'Identifier' || expr.callee.property.name !== 'map') {
    return null
  }

  const isOptional =
    expr.kind === 'OptionalCallExpression' ||
    (expr.callee.kind === 'OptionalMemberExpression' && expr.callee.optional)
  const arrayExprBase = ops.lowerDomExpression(expr.callee.object, ctx)
  const arrayExpr = isOptional
    ? t.logicalExpression('??', arrayExprBase, t.arrayExpression([]))
    : arrayExprBase
  const mapCallback = expr.arguments[0]
  if (!mapCallback) {
    throw new Error('map callback is required')
  }
  const keyExpr = extractKeyFromMapCallback(mapCallback)
  const isKeyed = !!keyExpr
  const hasRestParam =
    (mapCallback.kind === 'ArrowFunction' || mapCallback.kind === 'FunctionExpression') &&
    Array.isArray(mapCallback.rawParams) &&
    mapCallback.rawParams.some(param => t.isRestElement(param))
  const canConstifyKey = isKeyed && keyExpr && !hasRestParam

  if (isKeyed) {
    ctx.helpersUsed.add('keyedList')
  } else {
    ctx.helpersUsed.add('keyedList')
    ctx.helpersUsed.add('createElement')
  }

  // Save and reset hoisted template state for this list render callback.
  const prevHoistedTemplates = ctx.hoistedTemplates
  const prevHoistedTemplateStatements = ctx.hoistedTemplateStatements
  ctx.hoistedTemplates = new Map()
  ctx.hoistedTemplateStatements = []

  // Key constification: store key expression in context for downstream optimization.
  const prevListKeyExpr = ctx.listKeyExpr
  const prevListItemParamName = ctx.listItemParamName
  const prevListKeyParamName = ctx.listKeyParamName

  if (canConstifyKey && keyExpr) {
    ctx.listKeyExpr = keyExpr
    ctx.listKeyParamName = '__key'
    // Extract item param name from callback.
    if (mapCallback.kind === 'ArrowFunction' || mapCallback.kind === 'FunctionExpression') {
      const firstParam = mapCallback.params[0]
      if (firstParam) {
        ctx.listItemParamName = deSSAVarName(firstParam.name)
      }
    }
  }

  const prevInListRender = ctx.inListRender
  ctx.inListRender = true
  let callbackExpr = ops.lowerExpression(mapCallback, ctx)
  ctx.inListRender = prevInListRender

  // Capture key param name BEFORE restoring context (for selector hoist).
  const capturedKeyParamName = ctx.listKeyParamName

  // Restore key constification context.
  ctx.listKeyExpr = prevListKeyExpr
  ctx.listItemParamName = prevListItemParamName
  ctx.listKeyParamName = prevListKeyParamName

  callbackExpr = ops.applyRegionMetadataToExpression(callbackExpr, ctx)

  // Collect hoisted template declarations to insert before list call.
  const hoistedStatements = ctx.hoistedTemplateStatements
  ctx.hoistedTemplates = prevHoistedTemplates
  ctx.hoistedTemplateStatements = prevHoistedTemplateStatements

  if (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) {
    const [firstParam, secondParam] = callbackExpr.params
    const overrides: RegionOverrideMap = {}

    if (t.isIdentifier(firstParam)) {
      overrides[firstParam.name] = () => t.callExpression(t.identifier(firstParam.name), [])
    }
    if (t.isIdentifier(secondParam)) {
      overrides[secondParam.name] = () => t.callExpression(t.identifier(secondParam.name), [])
    }

    if (Object.keys(overrides).length > 0) {
      if (t.isBlockStatement(callbackExpr.body)) {
        for (const stmt of callbackExpr.body.body) {
          if (!t.isVariableDeclaration(stmt)) continue
          for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id) || !decl.init) continue
            const replacement = t.cloneNode(decl.init, true) as BabelCore.types.Expression
            replaceIdentifiersWithOverrides(replacement, overrides, t, callbackExpr.type, 'body')
            overrides[decl.id.name] = () =>
              t.cloneNode(replacement, true) as BabelCore.types.Expression
          }
        }
      }

      if (t.isBlockStatement(callbackExpr.body)) {
        replaceIdentifiersWithOverrides(callbackExpr.body, overrides, t, callbackExpr.type, 'body')
      } else {
        const newBody = t.cloneNode(callbackExpr.body, true) as BabelCore.types.Expression
        replaceIdentifiersWithOverrides(newBody, overrides, t, callbackExpr.type, 'body')
        callbackExpr = t.arrowFunctionExpression(callbackExpr.params, newBody)
      }
    }
  }

  if (isKeyed) {
    const itemParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? t.isIdentifier(callbackExpr.params[0])
          ? callbackExpr.params[0].name
          : null
        : null
    // Use captured key param name for selector patterns like `__key === selected()`.
    applySelectorHoist(
      callbackExpr as BabelCore.types.Expression,
      itemParamName,
      capturedKeyParamName ?? null,
      statements,
      ctx,
    )
  }

  let listCall: BabelCore.types.Expression
  if (isKeyed && keyExpr) {
    let keyExprAst = ops.lowerExpression(keyExpr, ctx)
    if (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) {
      const itemParam = callbackExpr.params[0]
      const indexParam = callbackExpr.params[1]
      const shadowed = new Set(ctx.shadowedNames ?? [])
      if (t.isIdentifier(itemParam)) shadowed.add(itemParam.name)
      if (t.isIdentifier(indexParam)) shadowed.add(indexParam.name)
      const prevShadowed = ctx.shadowedNames
      ctx.shadowedNames = shadowed
      keyExprAst = ops.applyRegionMetadataToExpression(keyExprAst, ctx)
      ctx.shadowedNames = prevShadowed
    }

    const itemParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? callbackExpr.params[0]
        : null
    const indexParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? callbackExpr.params[1]
        : null
    const keyFn = t.arrowFunctionExpression(
      [
        t.isIdentifier(itemParamName) ? itemParamName : t.identifier('__item'),
        t.isIdentifier(indexParamName) ? indexParamName : t.identifier('__index'),
      ],
      keyExprAst,
    )

    const hasIndexParam =
      (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) &&
      callbackExpr.params.length >= 2

    // Add __key as third parameter to the callback for key constification.
    if (
      canConstifyKey &&
      (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr))
    ) {
      const newParams = [...callbackExpr.params]
      // Ensure we have at least 2 params (item, index) before adding key.
      while (newParams.length < 2) {
        newParams.push(t.identifier(newParams.length === 0 ? '__item' : '__index'))
      }
      // Add __key as third param.
      newParams.push(t.identifier('__key'))
      if (t.isArrowFunctionExpression(callbackExpr)) {
        callbackExpr = t.arrowFunctionExpression(newParams, callbackExpr.body, callbackExpr.async)
      } else {
        callbackExpr = t.functionExpression(
          callbackExpr.id,
          newParams,
          callbackExpr.body as BabelCore.types.BlockStatement,
          callbackExpr.generator,
          callbackExpr.async,
        )
      }
    }

    // Insert hoisted template declarations before list call.
    statements.push(...hoistedStatements)

    listCall = t.callExpression(t.identifier(RUNTIME_ALIASES.keyedList), [
      t.arrowFunctionExpression([], arrayExpr),
      keyFn,
      callbackExpr,
      t.booleanLiteral(hasIndexParam),
    ])
  } else {
    // Insert hoisted template declarations before list call.
    statements.push(...hoistedStatements)

    const itemParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? t.isIdentifier(callbackExpr.params[0])
          ? callbackExpr.params[0].name
          : '__item'
        : '__item'
    const indexParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? t.isIdentifier(callbackExpr.params[1])
          ? callbackExpr.params[1].name
          : '__index'
        : '__index'
    const hasIndexParam =
      (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) &&
      callbackExpr.params.length >= 2

    const keyFn = t.arrowFunctionExpression(
      [t.identifier(itemParamName), t.identifier(indexParamName)],
      t.identifier(indexParamName),
    )

    listCall = t.callExpression(t.identifier(RUNTIME_ALIASES.keyedList), [
      t.arrowFunctionExpression([], arrayExpr),
      keyFn,
      callbackExpr,
      t.booleanLiteral(hasIndexParam),
    ])
  }

  return listCall
}

/**
 * Emit a list rendering child (array.map).
 */
export function emitListChild(
  startMarkerId: BabelCore.types.Expression,
  endMarkerId: BabelCore.types.Expression,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  ops: ListChildOps,
): void {
  const { t } = ctx

  const listCall = buildListCallExpression(expr, statements, ctx, ops)
  if (!listCall) return

  if (t.isCallExpression(listCall)) {
    listCall.arguments.push(startMarkerId, endMarkerId)
  }

  ctx.helpersUsed.add('onDestroy')

  const listId = ops.genTemp(ctx, 'list')
  statements.push(t.variableDeclaration('const', [t.variableDeclarator(listId, listCall)]))

  // Flush and cleanup.
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(listId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(listId, t.identifier('dispose')),
      ]),
    ),
  )
}
