import type * as BabelCore from '@babel/core'

import type { CodegenContext, RegionInfo } from './codegen'
import { reserveGeneratedIndexedModuleName } from './codegen-name-allocation'
import {
  collectFreeIdentifiersInExpr,
  genModuleUrlExpr,
  renameIdentifiersInExpr,
} from './codegen-resumable-utils'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { HIRError, type Expression } from './hir'

function voidZero(t: typeof BabelCore.types): BabelCore.types.UnaryExpression {
  return t.unaryExpression('void', t.numericLiteral(0), true)
}

function preserveInferredFunctionName(
  expr: BabelCore.types.Expression,
  sourceName: string,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return expr
  if (t.isFunctionExpression(expr) && expr.id) return expr

  const localId = t.identifier(sourceName)
  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration('const', [t.variableDeclarator(localId, expr)]),
        t.returnStatement(t.cloneNode(localId)),
      ]),
    ),
    [],
  )
}

export interface ResumableEventBindingOps {
  lowerDomExpression: (
    expr: Expression,
    ctx: CodegenContext,
    containingRegion?: RegionInfo | null,
    options?: { skipHookAccessors?: boolean; skipRegionRootOverride?: boolean },
  ) => BabelCore.types.Expression
}

function isBabelNode(value: unknown): value is BabelCore.types.Node {
  return typeof value === 'object' && value !== null && 'type' in value
}

function visitBabelNode(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
  visit: (node: BabelCore.types.Node) => void,
): void {
  visit(node)
  const visitorKeys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
  const keys = visitorKeys?.[node.type] ?? []
  const record = node as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isBabelNode(item)) visitBabelNode(item, t, visit)
      }
      continue
    }
    if (isBabelNode(value)) {
      visitBabelNode(value, t, visit)
    }
  }
}

function getMemberRootName(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(expr)) return expr.name
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    return getMemberRootName(expr.object as BabelCore.types.Expression, t)
  }
  return null
}

function getStaticMemberSegment(
  expr: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  t: typeof BabelCore.types,
): string {
  if (!expr.computed && t.isIdentifier(expr.property)) return expr.property.name
  if (t.isStringLiteral(expr.property)) return expr.property.value
  if (t.isNumericLiteral(expr.property)) return String(expr.property.value)
  return '*'
}

function formatMemberPath(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(expr)) return expr.name
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    const base = formatMemberPath(expr.object as BabelCore.types.Expression, t)
    if (!base) return null
    return `${base}.${getStaticMemberSegment(expr, t)}`
  }
  return null
}

function collectCalledPropMembers(
  expr: BabelCore.types.Expression,
  propsName: string | null,
  t: typeof BabelCore.types,
): string[] {
  if (!propsName) return []
  const paths = new Set<string>()
  visitBabelNode(expr, t, node => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return
    const callee = node.callee
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return
    if (getMemberRootName(callee, t) !== propsName) return
    paths.add(formatMemberPath(callee, t) ?? `${propsName}.*`)
  })
  return Array.from(paths).sort()
}

export function emitResumableEventBinding(
  targetId: BabelCore.types.Identifier,
  eventName: string,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
  ops: ResumableEventBindingOps,
  options?: { explicit?: boolean },
): boolean {
  const { t } = ctx
  if (!ctx.resumableEnabled) {
    return false
  }

  const prevWrapTracked = ctx.wrapTrackedExpressions
  ctx.wrapTrackedExpressions = false
  const valueExpr = ops.lowerDomExpression(expr, ctx, containingRegion, {
    skipHookAccessors: true,
    skipRegionRootOverride: true,
  })
  ctx.wrapTrackedExpressions = prevWrapTracked

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
  const handlerName = reserveGeneratedIndexedModuleName(
    ctx,
    '__fict_e',
    ctx.resumableHandlerCounter ?? 0,
  )
  ctx.resumableHandlerCounter = handlerName.nextIndex
  const handlerId = t.identifier(handlerName.name)

  const captured = collectFreeIdentifiersInExpr(handlerExpr, t)
  const propAccessorRestores = new Map(
    Array.from(ctx.resumablePropAccessors ?? []).filter(([name]) => captured.has(name)),
  )
  const propRestRestores = new Map(
    Array.from(ctx.resumablePropRests ?? []).filter(([name]) => captured.has(name)),
  )

  const lexicalNames = Array.from(captured).filter(name => ctx.signalVars?.has(name))
  const propsName =
    ctx.propsParamName &&
    captured.has(ctx.propsParamName) &&
    !propAccessorRestores.has(ctx.propsParamName) &&
    !propRestRestores.has(ctx.propsParamName)
      ? ctx.propsParamName
      : null
  const calledPropMembers = collectCalledPropMembers(handlerExpr, propsName, t)
  const unsupportedLocals = Array.from(captured).filter(name => {
    if (ctx.inListRender && ctx.listKeyParamName && name === ctx.listKeyParamName) return true
    if (!ctx.localDeclaredNames?.has(name)) return false
    if (ctx.signalVars?.has(name)) return false
    if (ctx.functionVars?.has(name)) return false
    if (propsName && name === propsName) return false
    if (propAccessorRestores.has(name) || propRestRestores.has(name)) return false
    return true
  })

  // Pre-lower function dependencies and reject any that still capture component-local names.
  // Hoisted resumable helpers execute at module scope, so local closures are unsafe here.
  const loweredFunctionDeps = new Map<string, BabelCore.types.Expression>()
  const unsafeFunctionCaptures: string[] = []
  const mutatedFunctionDeps: string[] = []
  for (const name of captured) {
    if (!ctx.functionVars?.has(name) || ctx.signalVars?.has(name)) continue
    const mutationDetails = ctx.componentFunctionMutations?.get(name)
    if (mutationDetails && mutationDetails.length > 0) {
      mutatedFunctionDeps.push(`${name} -> ${mutationDetails.join(', ')}`)
      continue
    }
    if (ctx.hoistedFunctionDepNames?.has(name)) continue

    const hirDef = ctx.componentFunctionDefs?.get(name)
    if (!hirDef) {
      if (ctx.localDeclaredNames?.has(name)) {
        unsafeFunctionCaptures.push(`${name} -> <unhoistable>`)
      }
      continue
    }

    const loweredFn = ops.lowerDomExpression(hirDef, ctx, null, {
      skipHookAccessors: true,
      skipRegionRootOverride: true,
    })
    const fnCaptured = collectFreeIdentifiersInExpr(loweredFn, t)
    const localFnCaptures = Array.from(fnCaptured)
      .filter(dep => ctx.localDeclaredNames?.has(dep))
      .sort()
    if (localFnCaptures.length > 0) {
      unsafeFunctionCaptures.push(`${name} -> ${localFnCaptures.join(', ')}`)
      continue
    }
    loweredFunctionDeps.set(name, loweredFn)
  }

  if (
    unsupportedLocals.length > 0 ||
    unsafeFunctionCaptures.length > 0 ||
    mutatedFunctionDeps.length > 0 ||
    calledPropMembers.length > 0
  ) {
    const detailParts: string[] = []
    if (unsupportedLocals.length > 0) {
      detailParts.push(`direct: ${unsupportedLocals.sort().join(', ')}`)
    }
    if (unsafeFunctionCaptures.length > 0) {
      detailParts.push(`function deps: ${unsafeFunctionCaptures.sort().join('; ')}`)
    }
    if (mutatedFunctionDeps.length > 0) {
      detailParts.push(`function mutations: ${mutatedFunctionDeps.sort().join('; ')}`)
    }
    if (calledPropMembers.length > 0) {
      detailParts.push(`function props: ${calledPropMembers.join(', ')}`)
    }
    const detail = `Resumable handlers cannot capture non-serializable local variables (${detailParts.join(' | ')}).`
    if (options?.explicit) {
      const loc = expr.loc?.start
      const fileName = ctx.options?.filename ?? '<unknown>'
      throw new HIRError(
        `${detail} Use signals/props/function references or remove '$' suffix.`,
        'BUILD_ERROR',
        {
          file: fileName,
          line: loc?.line,
          variable: detailParts.join(' | '),
        },
      )
    }
    return false
  }

  // Identify function dependencies that need to be hoisted.
  const functionDepRenames = new Map<string, string>()
  for (const name of captured) {
    if (ctx.functionVars?.has(name) && !ctx.signalVars?.has(name)) {
      // Check if this function has already been hoisted.
      let hoistedName = ctx.hoistedFunctionDepNames?.get(name)
      if (!hoistedName) {
        const loweredFn = loweredFunctionDeps.get(name)
        if (!loweredFn) continue

        const allocated = reserveGeneratedIndexedModuleName(
          ctx,
          `__fict_fn_${name}_`,
          ctx.hoistedFunctionDepCounter ?? 0,
        )
        hoistedName = allocated.name
        ctx.hoistedFunctionDepCounter = allocated.nextIndex
        ctx.hoistedFunctionDepNames?.set(name, hoistedName)

        // Create a module-level const declaration for the hoisted function.
        const hoistedDecl = t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(hoistedName),
            preserveInferredFunctionName(loweredFn, name, t),
          ),
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

  const handlerReservedNames = new Set<string>(captured)
  for (const name of functionDepRenames.values()) {
    handlerReservedNames.add(name)
  }
  const reserveHandlerName = (baseName: string): string => {
    if (!handlerReservedNames.has(baseName)) {
      handlerReservedNames.add(baseName)
      return baseName
    }

    let index = 1
    while (true) {
      const candidate = `${baseName}_${index++}`
      if (handlerReservedNames.has(candidate)) continue
      handlerReservedNames.add(candidate)
      return candidate
    }
  }

  const scopeParam = t.identifier(reserveHandlerName('scopeId'))
  const eventParam = t.identifier(reserveHandlerName('event'))
  const elParam = t.identifier(reserveHandlerName('el'))
  const scopePropsId = t.identifier(reserveHandlerName('__scopeProps'))
  const handlerVar = t.identifier(reserveHandlerName('__handler'))
  const resultVar = t.identifier(reserveHandlerName('__result'))

  const bodyStatements: BabelCore.types.Statement[] = []
  let scopePropsDeclared = false
  const ensureScopeProps = (): BabelCore.types.Identifier => {
    if (!scopePropsDeclared) {
      ctx.helpersUsed.add('getScopeProps')
      bodyStatements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            scopePropsId,
            t.logicalExpression(
              '||',
              t.callExpression(runtimeIdentifier(ctx, 'getScopeProps'), [scopeParam]),
              t.objectExpression([]),
            ),
          ),
        ]),
      )
      scopePropsDeclared = true
    }
    return scopePropsId
  }

  const buildPropsPathRead = (path: string[]): BabelCore.types.Expression =>
    path.reduce<BabelCore.types.Expression>(
      (expr, segment) => t.memberExpression(expr, t.identifier(segment), false),
      ensureScopeProps(),
    )

  if (lexicalNames.length > 0) {
    ctx.helpersUsed.add('useLexicalScope')
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.arrayPattern(lexicalNames.map(name => t.identifier(name))),
          t.callExpression(runtimeIdentifier(ctx, 'useLexicalScope'), [
            scopeParam,
            t.arrayExpression(lexicalNames.map(name => t.stringLiteral(name))),
          ]),
        ),
      ]),
    )
  }

  if (propsName) {
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(propsName), ensureScopeProps()),
      ]),
    )
  }

  for (const [name, restore] of propAccessorRestores) {
    const valueExpr = buildPropsPathRead(restore.path)
    const restoredValue = restore.defaultValue
      ? t.callExpression(
          t.arrowFunctionExpression(
            [t.identifier('__value')],
            t.conditionalExpression(
              t.binaryExpression('===', t.identifier('__value'), voidZero(t)),
              t.cloneNode(restore.defaultValue, true) as BabelCore.types.Expression,
              t.identifier('__value'),
            ),
          ),
          [valueExpr],
        )
      : valueExpr
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(name), t.arrowFunctionExpression([], restoredValue)),
      ]),
    )
  }

  for (const [name, restore] of propRestRestores) {
    ctx.helpersUsed.add('propsRest')
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(name),
          t.callExpression(runtimeIdentifier(ctx, 'propsRest'), [
            ensureScopeProps(),
            t.arrayExpression(restore.excludedKeys.map(key => t.stringLiteral(key))),
          ]),
        ),
      ]),
    )
  }

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
  const qrlExpr = t.callExpression(runtimeIdentifier(ctx, 'qrl'), [
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
  return true
}
