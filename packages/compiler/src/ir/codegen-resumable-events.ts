import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext, RegionInfo } from './codegen'
import { collectExpressionIdentifiersDeep } from './codegen-reactive-accessors'
import { genModuleUrlExpr, renameIdentifiersInExpr } from './codegen-resumable-utils'
import type { Expression } from './hir'

export interface ResumableEventBindingOps {
  lowerDomExpression: (
    expr: Expression,
    ctx: CodegenContext,
    containingRegion?: RegionInfo | null,
    options?: { skipHookAccessors?: boolean; skipRegionRootOverride?: boolean },
  ) => BabelCore.types.Expression
}

export function emitResumableEventBinding(
  targetId: BabelCore.types.Identifier,
  eventName: string,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
  ops: ResumableEventBindingOps,
): void {
  const { t } = ctx
  if (!ctx.resumableEnabled) {
    return
  }

  const prevWrapTracked = ctx.wrapTrackedExpressions
  ctx.wrapTrackedExpressions = false
  const valueExpr = ops.lowerDomExpression(expr, ctx, containingRegion, {
    skipHookAccessors: true,
    skipRegionRootOverride: true,
  })
  ctx.wrapTrackedExpressions = prevWrapTracked

  const eventParam = t.identifier('event')
  const elParam = t.identifier('el')
  const scopeParam = t.identifier('scopeId')

  const ensureHandlerParam = (fn: BabelCore.types.Expression): BabelCore.types.Expression => {
    if (t.isArrowFunctionExpression(fn)) {
      if (fn.params.length > 0) return fn
      return t.arrowFunctionExpression([eventParam], fn.body, fn.async)
    }
    if (t.isFunctionExpression(fn)) {
      if (fn.params.length > 0) return fn
      return t.functionExpression(fn.id, [eventParam], fn.body, fn.generator, fn.async)
    }
    if (t.isIdentifier(fn) || t.isMemberExpression(fn)) {
      return fn
    }
    if (
      t.isCallExpression(fn) &&
      fn.arguments.length === 0 &&
      (t.isIdentifier(fn.callee) || t.isMemberExpression(fn.callee))
    ) {
      return fn.callee as BabelCore.types.Expression
    }
    return t.functionExpression(
      null,
      [eventParam],
      t.blockStatement([
        t.returnStatement(
          t.callExpression(
            t.memberExpression(fn as BabelCore.types.Expression, t.identifier('call')),
            [t.thisExpression(), eventParam],
          ),
        ),
      ]),
    )
  }

  const handlerExpr = ensureHandlerParam(valueExpr)
  const handlerId = t.identifier(`__fict_e${ctx.resumableHandlerCounter ?? 0}`)
  ctx.resumableHandlerCounter = (ctx.resumableHandlerCounter ?? 0) + 1

  const captured = new Set<string>()
  collectExpressionIdentifiersDeep(expr, captured)

  const lexicalNames = Array.from(captured).filter(name => ctx.signalVars?.has(name))
  const propsName =
    ctx.propsParamName && captured.has(ctx.propsParamName) ? ctx.propsParamName : null

  // Identify function dependencies that need to be hoisted.
  const functionDepRenames = new Map<string, string>()
  for (const name of captured) {
    if (ctx.functionVars?.has(name) && !ctx.signalVars?.has(name)) {
      const hirDef = ctx.componentFunctionDefs?.get(name)
      if (!hirDef) continue

      // Check if this function has already been hoisted.
      let hoistedName = ctx.hoistedFunctionDepNames?.get(name)
      if (!hoistedName) {
        // Generate a unique hoisted name.
        hoistedName = `__fict_fn_${name}_${ctx.hoistedFunctionDepCounter ?? 0}`
        ctx.hoistedFunctionDepCounter = (ctx.hoistedFunctionDepCounter ?? 0) + 1
        ctx.hoistedFunctionDepNames?.set(name, hoistedName)

        // Lower the HIR function definition to Babel AST and hoist it.
        const loweredFn = ops.lowerDomExpression(hirDef, ctx, null, {
          skipHookAccessors: true,
          skipRegionRootOverride: true,
        })

        // Create a module-level const declaration for the hoisted function.
        const hoistedDecl = t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(hoistedName), loweredFn),
        ])

        // Also export it so vite-plugin can extract it to handler chunks.
        const hoistedExport = t.exportNamedDeclaration(hoistedDecl, [])
        ctx.hoistedResumableStatements?.push(hoistedExport)
      }

      functionDepRenames.set(name, hoistedName)
    }
  }

  // If we have function deps, we need to rename references in the handler.
  let finalHandlerExpr = handlerExpr
  if (functionDepRenames.size > 0) {
    finalHandlerExpr = renameIdentifiersInExpr(handlerExpr, functionDepRenames)
  }

  const bodyStatements: BabelCore.types.Statement[] = []
  if (lexicalNames.length > 0) {
    ctx.helpersUsed.add('useLexicalScope')
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.arrayPattern(lexicalNames.map(name => t.identifier(name))),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useLexicalScope), [
            scopeParam,
            t.arrayExpression(lexicalNames.map(name => t.stringLiteral(name))),
          ]),
        ),
      ]),
    )
  }

  if (propsName) {
    ctx.helpersUsed.add('getScopeProps')
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(propsName),
          t.logicalExpression(
            '||',
            t.callExpression(t.identifier(RUNTIME_ALIASES.getScopeProps), [scopeParam]),
            t.objectExpression([]),
          ),
        ),
      ]),
    )
  }

  const handlerVar = t.identifier('__handler')
  bodyStatements.push(
    t.variableDeclaration('const', [t.variableDeclarator(handlerVar, finalHandlerExpr)]),
  )
  bodyStatements.push(
    t.returnStatement(
      t.callExpression(t.memberExpression(handlerVar, t.identifier('call')), [elParam, eventParam]),
    ),
  )

  const exportedHandler = t.exportNamedDeclaration(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        handlerId,
        t.arrowFunctionExpression(
          [scopeParam, eventParam, elParam],
          t.blockStatement(bodyStatements),
        ),
      ),
    ]),
    [],
  )

  ctx.hoistedResumableStatements?.push(exportedHandler)

  ctx.helpersUsed.add('qrl')
  const qrlExpr = t.callExpression(t.identifier(RUNTIME_ALIASES.qrl), [
    genModuleUrlExpr(ctx),
    t.stringLiteral(handlerId.name),
  ])

  statements.push(
    t.expressionStatement(
      t.callExpression(t.memberExpression(targetId, t.identifier('setAttribute')), [
        t.stringLiteral(`on:${eventName}`),
        qrlExpr,
      ]),
    ),
  )
}
