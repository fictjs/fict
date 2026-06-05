import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { collectExpressionDependencies } from './codegen-expression-deps'
import { extractKeyFromMapCallback } from './codegen-jsx-keys'
import { replaceIdentifiersWithOverrides, type RegionOverrideMap } from './codegen-overrides'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { applySelectorHoist } from './codegen-selector-hoist'
import type { BasicBlock, Expression } from './hir'
import { deSSAVarName } from './regions'
import { walkExpression } from './walk-expression'

export interface ListChildOps {
  applyRegionMetadataToExpression: (
    expr: BabelCore.types.Expression,
    ctx: CodegenContext,
  ) => BabelCore.types.Expression
  genTemp: (ctx: CodegenContext, prefix?: string) => BabelCore.types.Identifier
  lowerDomExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
  lowerExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
}

function getCallbackBlocks(callback: Expression): BasicBlock[] {
  if (callback.kind === 'FunctionExpression') {
    return callback.body
  }
  if (callback.kind === 'ArrowFunction' && Array.isArray(callback.body)) {
    return callback.body
  }
  return []
}

function collectMapCallbackAliasDeclarations(callback: Expression): Map<string, Expression> {
  const blocks = getCallbackBlocks(callback)
  if (blocks.length === 0) {
    return new Map()
  }

  const paramNames =
    callback.kind === 'ArrowFunction' || callback.kind === 'FunctionExpression'
      ? new Set(callback.params.map(param => param.name))
      : new Set<string>()

  const declarationState = new Map<
    string,
    {
      declarationCount: number
      hasNonDeclarationWrite: boolean
      declarationValue: Expression | null
      lastAssignedValue: Expression
    }
  >()

  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign' || instr.target.kind !== 'Identifier') {
        continue
      }
      const name = instr.target.name
      if (paramNames.has(name)) continue
      const isDeclaration = !!instr.declarationKind
      const previous = declarationState.get(name)
      if (previous) {
        declarationState.set(name, {
          declarationCount: previous.declarationCount + (isDeclaration ? 1 : 0),
          hasNonDeclarationWrite: previous.hasNonDeclarationWrite || !isDeclaration,
          declarationValue: previous.declarationValue,
          lastAssignedValue: instr.value,
        })
      } else {
        declarationState.set(name, {
          declarationCount: isDeclaration ? 1 : 0,
          hasNonDeclarationWrite: !isDeclaration,
          declarationValue: isDeclaration ? instr.value : null,
          lastAssignedValue: instr.value,
        })
      }
    }
  }

  const aliasMap = new Map<string, Expression>()
  const effectiveBlocks = blocks.filter(
    block => block.instructions.length > 0 || block.terminator.kind !== 'Unreachable',
  )
  const isSingleLinearBlock =
    effectiveBlocks.length === 1 && effectiveBlocks[0]?.terminator.kind === 'Return'
  for (const [name, state] of declarationState) {
    if (isSingleLinearBlock) {
      if (state.declarationCount <= 1) {
        aliasMap.set(name, state.lastAssignedValue)
      }
      continue
    }
    if (state.declarationCount === 1 && !state.hasNonDeclarationWrite && state.declarationValue) {
      aliasMap.set(name, state.declarationValue)
    }
  }

  return aliasMap
}

function resolveMapCallbackKeyExpression(keyExpr: Expression, callback: Expression): Expression {
  if (keyExpr.kind !== 'Identifier') {
    return keyExpr
  }

  const aliasMap = collectMapCallbackAliasDeclarations(callback)

  if (aliasMap.size === 0) {
    return keyExpr
  }

  let resolved: Expression = keyExpr
  const seen = new Set<string>()
  while (resolved.kind === 'Identifier') {
    const next = aliasMap.get(resolved.name)
    if (!next || seen.has(resolved.name)) break
    seen.add(resolved.name)
    resolved = next
  }
  return resolved
}

function collectMapCallbackLocalNames(callback: Expression): Set<string> {
  const blocks = getCallbackBlocks(callback)
  if (blocks.length === 0) {
    return new Set()
  }

  const paramNames =
    callback.kind === 'ArrowFunction' || callback.kind === 'FunctionExpression'
      ? new Set(callback.params.map(param => deSSAVarName(param.name)))
      : new Set<string>()

  const locals = new Set<string>()
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.target.kind === 'Identifier') {
        const name = deSSAVarName(instr.target.name)
        if (!paramNames.has(name)) locals.add(name)
      }
      if (instr.kind === 'Phi' && instr.target.kind === 'Identifier') {
        const name = deSSAVarName(instr.target.name)
        if (!paramNames.has(name)) locals.add(name)
      }
    }
  }

  return locals
}

function hasUnresolvedCallbackLocalKeyDependencies(
  keyExpr: Expression,
  callback: Expression,
  keyAliasDeclarations: Map<string, Expression>,
): boolean {
  const callbackLocals = collectMapCallbackLocalNames(callback)
  if (callbackLocals.size === 0) {
    return false
  }

  const resolvableAliases = new Set(
    Array.from(keyAliasDeclarations.keys()).map(name => deSSAVarName(name)),
  )
  const deps = new Set<string>()
  collectExpressionDependencies(keyExpr, deps)

  for (const dep of deps) {
    const base = dep.split('.')[0] ?? dep
    if (!base) continue
    if (callbackLocals.has(base) && !resolvableAliases.has(base)) {
      return true
    }
  }

  return false
}

function isDefinitelyNonCallableMapCallback(expr: Expression): boolean {
  switch (expr.kind) {
    case 'Literal':
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'TemplateLiteral':
    case 'JSXElement':
    case 'ClassExpression':
    case 'MetaProperty':
    case 'ThisExpression':
    case 'SuperExpression':
      return true
    default:
      return false
  }
}

function blocksUseArguments(blocks: BasicBlock[]): boolean {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        let found = false
        walkExpression(instr.value, expr => {
          if (expr.kind === 'Identifier' && expr.name === 'arguments') {
            found = true
          }
        })
        if (found) return true
      }
    }

    const term = block.terminator
    const termExprs: Expression[] = []
    switch (term.kind) {
      case 'Return':
        if (term.argument) termExprs.push(term.argument)
        break
      case 'Throw':
        termExprs.push(term.argument)
        break
      case 'Branch':
        termExprs.push(term.test)
        break
      case 'Switch':
        termExprs.push(term.discriminant)
        term.cases.forEach(c => {
          if (c.test) termExprs.push(c.test)
        })
        break
      case 'ForOf':
        termExprs.push(term.iterable)
        break
      case 'ForIn':
        termExprs.push(term.object)
        break
      default:
        break
    }
    for (const expr of termExprs) {
      let found = false
      walkExpression(expr, inner => {
        if (inner.kind === 'Identifier' && inner.name === 'arguments') {
          found = true
        }
      })
      if (found) return true
    }
  }

  return false
}

function blocksUseThis(blocks: BasicBlock[]): boolean {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        let found = false
        walkExpression(instr.value, expr => {
          if (expr.kind === 'ThisExpression') {
            found = true
          }
        })
        if (found) return true
      }
    }

    const term = block.terminator
    const termExprs: Expression[] = []
    switch (term.kind) {
      case 'Return':
        if (term.argument) termExprs.push(term.argument)
        break
      case 'Throw':
        termExprs.push(term.argument)
        break
      case 'Branch':
        termExprs.push(term.test)
        break
      case 'Switch':
        termExprs.push(term.discriminant)
        term.cases.forEach(c => {
          if (c.test) termExprs.push(c.test)
        })
        break
      case 'ForOf':
        termExprs.push(term.iterable)
        break
      case 'ForIn':
        termExprs.push(term.object)
        break
      default:
        break
    }
    for (const expr of termExprs) {
      let found = false
      walkExpression(expr, inner => {
        if (inner.kind === 'ThisExpression') {
          found = true
        }
      })
      if (found) return true
    }
  }

  return false
}

function callbackUsesArguments(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind === 'ArrowFunction' || expr.kind === 'FunctionExpression') {
    return blocksUseArguments(getCallbackBlocks(expr))
  }

  if (expr.kind === 'Identifier') {
    const resolved = ctx.componentFunctionDefs?.get(deSSAVarName(expr.name))
    if (resolved && (resolved.kind === 'ArrowFunction' || resolved.kind === 'FunctionExpression')) {
      return blocksUseArguments(getCallbackBlocks(resolved))
    }

    const programFn = ctx.programFunctions?.get(expr.name)
    if (programFn) {
      return blocksUseArguments(programFn.blocks)
    }
  }

  return false
}

function callbackUsesThis(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind === 'FunctionExpression') {
    return blocksUseThis(getCallbackBlocks(expr))
  }

  if (expr.kind === 'Identifier') {
    const resolved = ctx.componentFunctionDefs?.get(deSSAVarName(expr.name))
    if (resolved?.kind === 'FunctionExpression') {
      return blocksUseThis(getCallbackBlocks(resolved))
    }

    const programFn = ctx.programFunctions?.get(expr.name)
    if (programFn) {
      return blocksUseThis(programFn.blocks)
    }
  }

  return false
}

function getMapCallbackSignature(
  expr: Expression,
  ctx: CodegenContext,
): { paramCount: number; hasRest: boolean } | null {
  if (expr.kind === 'ArrowFunction' || expr.kind === 'FunctionExpression') {
    return {
      paramCount: expr.rawParams?.length ?? expr.params.length,
      hasRest:
        Array.isArray(expr.rawParams) && expr.rawParams.some(param => ctx.t.isRestElement(param)),
    }
  }

  if (expr.kind === 'Identifier') {
    const resolved = ctx.componentFunctionDefs?.get(deSSAVarName(expr.name))
    if (resolved && (resolved.kind === 'ArrowFunction' || resolved.kind === 'FunctionExpression')) {
      return {
        paramCount: resolved.rawParams?.length ?? resolved.params.length,
        hasRest:
          Array.isArray(resolved.rawParams) &&
          resolved.rawParams.some(param => ctx.t.isRestElement(param)),
      }
    }

    const programFn = ctx.programFunctions?.get(expr.name)
    if (programFn) {
      return {
        paramCount: programFn.params.length,
        hasRest: false,
      }
    }
  }

  return null
}

function hasUnsupportedMapCallbackParams(expr: Expression, ctx: CodegenContext): boolean {
  const rawParams =
    expr.kind === 'ArrowFunction' || expr.kind === 'FunctionExpression' ? expr.rawParams : undefined

  if (rawParams && rawParams.length > 0) {
    return rawParams.some(param => !ctx.t.isIdentifier(param))
  }

  return false
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
  if (expr.arguments.length !== 1) return null
  const mapCallback = expr.arguments[0]
  if (!mapCallback) return null
  if (mapCallback.kind !== 'ArrowFunction' && mapCallback.kind !== 'FunctionExpression') {
    return null
  }
  if (
    mapCallback.isAsync ||
    (mapCallback.kind === 'FunctionExpression' && mapCallback.isGenerator)
  ) {
    return null
  }
  if (hasUnsupportedMapCallbackParams(mapCallback, ctx)) return null
  if (isDefinitelyNonCallableMapCallback(mapCallback)) return null
  if (callbackUsesArguments(mapCallback, ctx)) return null
  if (callbackUsesThis(mapCallback, ctx)) return null
  const callbackSignature = getMapCallbackSignature(mapCallback, ctx)
  if (!callbackSignature) return null
  if (callbackSignature.hasRest || callbackSignature.paramCount >= 3) return null
  const extractedKeyExpr = extractKeyFromMapCallback(mapCallback)
  const keyExpr = extractedKeyExpr
    ? resolveMapCallbackKeyExpression(extractedKeyExpr, mapCallback)
    : undefined
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

  const shouldDeferOptionalCallbackEvaluation =
    isOptional &&
    !t.isArrowFunctionExpression(callbackExpr) &&
    !t.isFunctionExpression(callbackExpr)

  let deferredCallbackId: BabelCore.types.Identifier | null = null
  let deferredCallbackInitId: BabelCore.types.Identifier | null = null
  let deferredItemsId: BabelCore.types.Identifier | null = null
  if (shouldDeferOptionalCallbackEvaluation) {
    deferredCallbackId = ops.genTemp(ctx, 'mapCb')
    deferredCallbackInitId = ops.genTemp(ctx, 'mapCbReady')
    deferredItemsId = ops.genTemp(ctx, 'mapItems')
  }

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
          if (!t.isVariableDeclaration(stmt) || stmt.kind !== 'const') continue
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
    const keyAliasDeclarations = collectMapCallbackAliasDeclarations(mapCallback)
    const hasUnresolvedLocalKeyDeps = hasUnresolvedCallbackLocalKeyDependencies(
      keyExpr,
      mapCallback,
      keyAliasDeclarations,
    )
    let keyExprAst = ops.lowerExpression(keyExpr, ctx)
    if (keyAliasDeclarations.size > 0) {
      const keyOverrides: RegionOverrideMap = {}
      for (const [name, value] of keyAliasDeclarations) {
        const replacement = ops.lowerExpression(value, ctx)
        replaceIdentifiersWithOverrides(replacement, keyOverrides, t)
        keyOverrides[name] = () => t.cloneNode(replacement, true) as BabelCore.types.Expression
      }
      if (Object.keys(keyOverrides).length > 0) {
        replaceIdentifiersWithOverrides(
          keyExprAst,
          keyOverrides,
          t,
          undefined,
          undefined,
          false,
          true,
        )
      }
    }
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
    if (hasUnresolvedLocalKeyDeps) {
      keyExprAst = t.identifier(t.isIdentifier(indexParamName) ? indexParamName.name : '__index')
    }
    const keyFn = t.arrowFunctionExpression(
      [
        t.isIdentifier(itemParamName) ? itemParamName : t.identifier('__item'),
        t.isIdentifier(indexParamName) ? indexParamName : t.identifier('__index'),
      ],
      keyExprAst,
    )

    const hasIndexParam =
      shouldDeferOptionalCallbackEvaluation ||
      ((t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) &&
        callbackExpr.params.length >= 2)

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

    if (shouldDeferOptionalCallbackEvaluation) {
      statements.push(
        t.variableDeclaration('let', [
          t.variableDeclarator(t.cloneNode(deferredCallbackId!, true)),
        ]),
        t.variableDeclaration('let', [
          t.variableDeclarator(t.cloneNode(deferredCallbackInitId!, true), t.booleanLiteral(false)),
        ]),
      )
    }

    const getItemsExpr = shouldDeferOptionalCallbackEvaluation
      ? t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.cloneNode(deferredItemsId!, true),
                t.cloneNode(arrayExprBase, true) as BabelCore.types.Expression,
              ),
            ]),
            t.ifStatement(
              t.binaryExpression('==', t.cloneNode(deferredItemsId!, true), t.nullLiteral()),
              t.blockStatement([t.returnStatement(t.arrayExpression([]))]),
            ),
            t.ifStatement(
              t.unaryExpression('!', t.cloneNode(deferredCallbackInitId!, true)),
              t.blockStatement([
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.cloneNode(deferredCallbackId!, true),
                    t.cloneNode(callbackExpr, true) as BabelCore.types.Expression,
                  ),
                ),
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.cloneNode(deferredCallbackInitId!, true),
                    t.booleanLiteral(true),
                  ),
                ),
              ]),
            ),
            t.returnStatement(t.cloneNode(deferredItemsId!, true)),
          ]),
        )
      : t.arrowFunctionExpression([], arrayExpr)
    const renderExpr = shouldDeferOptionalCallbackEvaluation
      ? t.arrowFunctionExpression(
          [t.identifier('__item'), t.identifier('__index'), t.identifier('__key')],
          t.callExpression(t.cloneNode(deferredCallbackId!, true), [
            t.identifier('__item'),
            t.identifier('__index'),
            t.identifier('__key'),
          ]),
        )
      : callbackExpr

    listCall = t.callExpression(runtimeIdentifier(ctx, 'keyedList'), [
      getItemsExpr,
      keyFn,
      renderExpr,
      t.booleanLiteral(hasIndexParam),
    ])
  } else {
    // Insert hoisted template declarations before list call.
    statements.push(...hoistedStatements)

    if (shouldDeferOptionalCallbackEvaluation) {
      statements.push(
        t.variableDeclaration('let', [
          t.variableDeclarator(t.cloneNode(deferredCallbackId!, true)),
        ]),
        t.variableDeclaration('let', [
          t.variableDeclarator(t.cloneNode(deferredCallbackInitId!, true), t.booleanLiteral(false)),
        ]),
      )
    }

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
      shouldDeferOptionalCallbackEvaluation ||
      ((t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) &&
        callbackExpr.params.length >= 2)

    const getItemsExpr = shouldDeferOptionalCallbackEvaluation
      ? t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.cloneNode(deferredItemsId!, true),
                t.cloneNode(arrayExprBase, true) as BabelCore.types.Expression,
              ),
            ]),
            t.ifStatement(
              t.binaryExpression('==', t.cloneNode(deferredItemsId!, true), t.nullLiteral()),
              t.blockStatement([t.returnStatement(t.arrayExpression([]))]),
            ),
            t.ifStatement(
              t.unaryExpression('!', t.cloneNode(deferredCallbackInitId!, true)),
              t.blockStatement([
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.cloneNode(deferredCallbackId!, true),
                    t.cloneNode(callbackExpr, true) as BabelCore.types.Expression,
                  ),
                ),
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.cloneNode(deferredCallbackInitId!, true),
                    t.booleanLiteral(true),
                  ),
                ),
              ]),
            ),
            t.returnStatement(t.cloneNode(deferredItemsId!, true)),
          ]),
        )
      : t.arrowFunctionExpression([], arrayExpr)
    const renderExpr = shouldDeferOptionalCallbackEvaluation
      ? t.arrowFunctionExpression(
          [t.identifier('__item'), t.identifier('__index'), t.identifier('__key')],
          t.callExpression(t.cloneNode(deferredCallbackId!, true), [
            t.identifier('__item'),
            t.identifier('__index'),
            t.identifier('__key'),
          ]),
        )
      : callbackExpr

    const keyFn = t.arrowFunctionExpression(
      [t.identifier(itemParamName), t.identifier(indexParamName)],
      t.identifier(indexParamName),
    )

    listCall = t.callExpression(runtimeIdentifier(ctx, 'keyedList'), [
      getItemsExpr,
      keyFn,
      renderExpr,
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
): boolean {
  const { t } = ctx

  const listCall = buildListCallExpression(expr, statements, ctx, ops)
  if (!listCall) return false

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
      t.callExpression(runtimeIdentifier(ctx, 'onDestroy'), [
        t.memberExpression(listId, t.identifier('dispose')),
      ]),
    ),
  )
  return true
}
