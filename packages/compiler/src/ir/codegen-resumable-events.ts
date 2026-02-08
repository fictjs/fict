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
      return fn
    }
    if (t.isFunctionExpression(fn)) {
      return fn
    }
    if (t.isIdentifier(fn) || t.isMemberExpression(fn)) {
      return fn
    }
    // Preserve original expression semantics; runtime-style invocation happens below.
    return t.functionExpression(
      null,
      [],
      t.blockStatement([t.returnStatement(fn as BabelCore.types.Expression)]),
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
    finalHandlerExpr = renameIdentifiersInExpr(handlerExpr, functionDepRenames, t)
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
  const resultVar = t.identifier('__result')
  bodyStatements.push(
    t.variableDeclaration('const', [t.variableDeclarator(handlerVar, finalHandlerExpr)]),
  )
  bodyStatements.push(
    t.ifStatement(
      t.binaryExpression(
        '===',
        t.unaryExpression('typeof', handlerVar),
        t.stringLiteral('function'),
      ),
      t.blockStatement([
        t.variableDeclaration('const', [
          t.variableDeclarator(
            resultVar,
            t.callExpression(t.memberExpression(handlerVar, t.identifier('call')), [
              elParam,
              eventParam,
            ]),
          ),
        ]),
        t.ifStatement(
          t.logicalExpression(
            '&&',
            t.binaryExpression(
              '===',
              t.unaryExpression('typeof', resultVar),
              t.stringLiteral('function'),
            ),
            t.binaryExpression('!==', resultVar, handlerVar),
          ),
          t.blockStatement([
            t.returnStatement(
              t.callExpression(t.memberExpression(resultVar, t.identifier('call')), [
                elParam,
                eventParam,
              ]),
            ),
          ]),
        ),
        t.ifStatement(
          t.logicalExpression(
            '&&',
            resultVar,
            t.binaryExpression(
              '===',
              t.unaryExpression(
                'typeof',
                t.memberExpression(resultVar, t.identifier('handleEvent')),
              ),
              t.stringLiteral('function'),
            ),
          ),
          t.blockStatement([
            t.returnStatement(
              t.callExpression(
                t.memberExpression(
                  t.memberExpression(resultVar, t.identifier('handleEvent')),
                  t.identifier('call'),
                ),
                [resultVar, eventParam],
              ),
            ),
          ]),
        ),
        t.returnStatement(resultVar),
      ]),
    ),
  )
  bodyStatements.push(
    t.ifStatement(
      t.logicalExpression(
        '&&',
        handlerVar,
        t.binaryExpression(
          '===',
          t.unaryExpression('typeof', t.memberExpression(handlerVar, t.identifier('handleEvent'))),
          t.stringLiteral('function'),
        ),
      ),
      t.blockStatement([
        t.returnStatement(
          t.callExpression(
            t.memberExpression(
              t.memberExpression(handlerVar, t.identifier('handleEvent')),
              t.identifier('call'),
            ),
            [handlerVar, eventParam],
          ),
        ),
      ]),
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
