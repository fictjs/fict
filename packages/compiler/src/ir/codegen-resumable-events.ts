import type * as BabelCore from '@babel/core'

import { collectBindingNames } from '../utils'

import type { CodegenContext, RegionInfo } from './codegen'
import { ignoresInlineEventHandlerReturn } from './codegen-event-handlers'
import { reserveGeneratedIndexedModuleName } from './codegen-name-allocation'
import { replaceIdentifiersWithOverrides, type RegionOverrideMap } from './codegen-overrides'
import {
  collectFreeIdentifiersInExpr,
  capturesLexicalArgumentsInExpr,
  capturesLexicalNewTargetInExpr,
  capturesLexicalThisInExpr,
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

function getPreventDefaultParamName(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): string | null {
  if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return null
  const [param] = expr.params
  return param && t.isIdentifier(param) ? param.name : null
}

function isPreventDefaultCallForName(
  node: BabelCore.types.Node,
  eventParamName: string,
  shadowed: boolean,
  t: typeof BabelCore.types,
): boolean {
  if (shadowed || (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))) return false
  const callee = node.callee
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false
  if (!t.isIdentifier(callee.object) || callee.object.name !== eventParamName) return false
  if (!callee.computed && t.isIdentifier(callee.property)) {
    return callee.property.name === 'preventDefault'
  }
  return t.isStringLiteral(callee.property) && callee.property.value === 'preventDefault'
}

function functionOwnBindings(fn: BabelCore.types.Function, t: typeof BabelCore.types): Set<string> {
  const names = new Set<string>()
  for (const param of fn.params) {
    if (t.isTSParameterProperty(param)) {
      collectBindingNames(param.parameter as BabelCore.types.LVal, names, t)
    } else {
      collectBindingNames(param as BabelCore.types.LVal, names, t)
    }
  }
  return names
}

function callsEventPreventDefault(
  expr: BabelCore.types.Expression | undefined,
  t: typeof BabelCore.types,
): boolean {
  if (!expr) return false
  const eventParamName = getPreventDefaultParamName(expr, t)
  if (!eventParamName) return false

  let found = false
  const visit = (node: BabelCore.types.Node, shadowed: boolean): void => {
    if (found) return
    if (node !== expr && t.isFunction(node)) {
      const ownBindings = functionOwnBindings(node, t)
      const nestedShadowed = shadowed || ownBindings.has(eventParamName)
      if (node.body) visit(node.body, nestedShadowed)
      return
    }
    if (isPreventDefaultCallForName(node, eventParamName, shadowed, t)) {
      found = true
      return
    }

    const visitorKeys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
    const keys = visitorKeys?.[node.type] ?? []
    const record = node as unknown as Record<string, unknown>
    for (const key of keys) {
      if (found) return
      const value = record[key]
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isBabelNode(item)) visit(item, shadowed)
          if (found) return
        }
        continue
      }
      if (isBabelNode(value)) {
        visit(value, shadowed)
      }
    }
  }

  visit(expr, false)
  return found
}

export function emitResumableEventBinding(
  targetId: BabelCore.types.Identifier,
  eventName: string,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
  ops: ResumableEventBindingOps,
  options?: {
    explicit?: boolean
    onQrl?: (qrl: BabelCore.types.Expression) => void
  },
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

  if (t.isMemberExpression(valueExpr) || t.isOptionalMemberExpression(valueExpr)) {
    if (options?.explicit) {
      const loc = expr.loc?.start
      throw new HIRError(
        `Resumable event handlers cannot use member-expression handler values because member reads must be evaluated during render. Store the handler in a stable function binding or remove '$' suffix.`,
        'BUILD_ERROR',
        {
          file: ctx.options?.filename ?? '<unknown>',
          line: loc?.line,
          variable: eventName,
        },
      )
    }
    return false
  }

  if (t.isIdentifier(valueExpr)) {
    const name = valueExpr.name
    const isFunctionLocal = ctx.currentFunctionDeclaredNames?.has(name) ?? false
    const isModuleBinding = !isFunctionLocal && (ctx.moduleDeclaredNames?.has(name) ?? false)
    const kind = ctx.moduleBindingKinds?.get(name) ?? 'unknown'
    const isStableModuleBinding = kind === 'const' || kind === 'function' || kind === 'class'

    if (isModuleBinding && !isStableModuleBinding) {
      if (options?.explicit) {
        const loc = expr.loc?.start
        throw new HIRError(
          `Resumable event handlers cannot use mutable module handler identifiers because they are read at event time instead of render time. Use a module const/function binding or remove '$' suffix.`,
          'BUILD_ERROR',
          {
            file: ctx.options?.filename ?? '<unknown>',
            line: loc?.line,
            variable: name,
          },
        )
      }
      return false
    }
  }

  const ensureHandlerParam = (fn: BabelCore.types.Expression): BabelCore.types.Expression => {
    if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) {
      return ignoresInlineEventHandlerReturn(fn, t)
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
  const wrappedFactoryExpr = handlerExpr !== valueExpr
  const handlerName = reserveGeneratedIndexedModuleName(
    ctx,
    '__fict_e',
    ctx.resumableHandlerCounter ?? 0,
  )
  ctx.resumableHandlerCounter = handlerName.nextIndex
  const handlerId = t.identifier(handlerName.name)

  const captured = collectFreeIdentifiersInExpr(handlerExpr, t)
  const allPropAccessors = Array.from(ctx.resumablePropAccessors ?? [])
  const propAccessorRestoreNames = new Set(
    allPropAccessors.filter(([name]) => captured.has(name)).map(([name]) => name),
  )
  let addedPropAccessorRestore = true
  while (addedPropAccessorRestore) {
    addedPropAccessorRestore = false
    for (const [name, restore] of allPropAccessors) {
      if (!propAccessorRestoreNames.has(name) || !restore.defaultValue) continue
      const defaultDeps = collectFreeIdentifiersInExpr(restore.defaultValue, t)
      for (const dep of defaultDeps) {
        if (!ctx.resumablePropAccessors?.has(dep) || propAccessorRestoreNames.has(dep)) continue
        propAccessorRestoreNames.add(dep)
        addedPropAccessorRestore = true
      }
    }
  }
  const propAccessorRestores = new Map(
    allPropAccessors.filter(([name]) => propAccessorRestoreNames.has(name)),
  )
  const propRestRestores = new Map(
    Array.from(ctx.resumablePropRests ?? []).filter(([name]) => captured.has(name)),
  )

  const isImportedReactiveCapture = (name: string): boolean =>
    (ctx.importedReactiveVars?.has(name) ?? false) &&
    !(ctx.currentFunctionDeclaredNames?.has(name) ?? false)
  const lexicalNameSet = new Set(
    Array.from(captured).filter(
      name => ctx.signalVars?.has(name) && !isImportedReactiveCapture(name),
    ),
  )
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
  const inlineFunctionDeps = new Map<string, BabelCore.types.Expression>()
  const unsafeFunctionCaptures: string[] = []
  const lexicalArgumentsCaptures: string[] = []
  const lexicalNewTargetCaptures: string[] = []
  const lexicalThisCaptures: string[] = []
  const mutatedFunctionDeps: string[] = []
  let functionDepsCaptureProps = false
  if (wrappedFactoryExpr && capturesLexicalArgumentsInExpr(valueExpr, t)) {
    lexicalArgumentsCaptures.push('factory -> arguments')
  }
  if (wrappedFactoryExpr && capturesLexicalNewTargetInExpr(valueExpr, t)) {
    lexicalNewTargetCaptures.push('factory -> new.target')
  }
  if (wrappedFactoryExpr && capturesLexicalThisInExpr(valueExpr, t)) {
    lexicalThisCaptures.push('factory -> this')
  }
  if (capturesLexicalArgumentsInExpr(handlerExpr, t)) {
    lexicalArgumentsCaptures.push('handler -> arguments')
  }
  if (capturesLexicalNewTargetInExpr(handlerExpr, t)) {
    lexicalNewTargetCaptures.push('handler -> new.target')
  }
  if (capturesLexicalThisInExpr(handlerExpr, t)) {
    lexicalThisCaptures.push('handler -> this')
  }
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
    if (capturesLexicalArgumentsInExpr(loweredFn, t)) {
      lexicalArgumentsCaptures.push(`${name} -> arguments`)
      continue
    }
    if (capturesLexicalNewTargetInExpr(loweredFn, t)) {
      lexicalNewTargetCaptures.push(`${name} -> new.target`)
      continue
    }
    if (capturesLexicalThisInExpr(loweredFn, t)) {
      lexicalThisCaptures.push(`${name} -> this`)
      continue
    }
    const fnCaptured = collectFreeIdentifiersInExpr(loweredFn, t)
    const localFnCaptures = Array.from(fnCaptured)
      .filter(dep => ctx.localDeclaredNames?.has(dep))
      .sort()
    const restorablePropFnCaptures = localFnCaptures.filter(
      dep => ctx.propsParamName && dep === ctx.propsParamName,
    )
    const restorableSignalFnCaptures = localFnCaptures.filter(dep => ctx.signalVars?.has(dep))
    const restorableFnCaptures = new Set([
      ...restorablePropFnCaptures,
      ...restorableSignalFnCaptures,
    ])
    const unsafeFnCaptures = localFnCaptures.filter(dep => !restorableFnCaptures.has(dep))
    if (unsafeFnCaptures.length > 0) {
      unsafeFunctionCaptures.push(`${name} -> ${unsafeFnCaptures.join(', ')}`)
      continue
    }
    const capturesRestorableProps = ctx.propsParamName
      ? restorablePropFnCaptures.includes(ctx.propsParamName)
      : false
    if (capturesRestorableProps && ctx.propsParamName) {
      const fnCalledPropMembers = collectCalledPropMembers(loweredFn, ctx.propsParamName, t)
      if (fnCalledPropMembers.length > 0) {
        calledPropMembers.push(...fnCalledPropMembers.map(path => `${name} -> ${path}`))
        continue
      }
      functionDepsCaptureProps = true
    }
    for (const signalName of restorableSignalFnCaptures) {
      lexicalNameSet.add(signalName)
    }
    if (capturesRestorableProps || restorableSignalFnCaptures.length > 0) {
      inlineFunctionDeps.set(name, loweredFn)
      continue
    }
    loweredFunctionDeps.set(name, loweredFn)
  }

  const lexicalNames = Array.from(lexicalNameSet)
  const nonSerializableSignalCaptures = lexicalNames.filter(name =>
    ctx.nonSerializableSignalVars?.has(name),
  )
  const outerSignalCaptures = ctx.currentFunctionDeclaredNames
    ? lexicalNames.filter(name => !ctx.currentFunctionDeclaredNames?.has(name))
    : []

  const loweredHandlerFunctionDep = t.isIdentifier(handlerExpr)
    ? (loweredFunctionDeps.get(handlerExpr.name) ?? inlineFunctionDeps.get(handlerExpr.name))
    : undefined
  const handlerMayPreventDefault =
    callsEventPreventDefault(valueExpr, t) ||
    callsEventPreventDefault(handlerExpr, t) ||
    callsEventPreventDefault(loweredHandlerFunctionDep, t)

  if (
    unsupportedLocals.length > 0 ||
    nonSerializableSignalCaptures.length > 0 ||
    outerSignalCaptures.length > 0 ||
    unsafeFunctionCaptures.length > 0 ||
    lexicalArgumentsCaptures.length > 0 ||
    lexicalNewTargetCaptures.length > 0 ||
    lexicalThisCaptures.length > 0 ||
    mutatedFunctionDeps.length > 0 ||
    calledPropMembers.length > 0
  ) {
    const detailParts: string[] = []
    if (unsupportedLocals.length > 0) {
      detailParts.push(`direct: ${unsupportedLocals.sort().join(', ')}`)
    }
    if (nonSerializableSignalCaptures.length > 0) {
      detailParts.push(`signals: ${nonSerializableSignalCaptures.sort().join(', ')}`)
    }
    if (outerSignalCaptures.length > 0) {
      detailParts.push(`outer signals: ${outerSignalCaptures.sort().join(', ')}`)
    }
    if (unsafeFunctionCaptures.length > 0) {
      detailParts.push(`function deps: ${unsafeFunctionCaptures.sort().join('; ')}`)
    }
    if (lexicalArgumentsCaptures.length > 0) {
      detailParts.push(`arguments: ${lexicalArgumentsCaptures.sort().join('; ')}`)
    }
    if (lexicalNewTargetCaptures.length > 0) {
      detailParts.push(`new.target: ${lexicalNewTargetCaptures.sort().join('; ')}`)
    }
    if (lexicalThisCaptures.length > 0) {
      detailParts.push(`this: ${lexicalThisCaptures.sort().join('; ')}`)
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
      if (inlineFunctionDeps.has(name)) continue
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
  if (!propsName && functionDepsCaptureProps && ctx.propsParamName) {
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(ctx.propsParamName), ensureScopeProps()),
      ]),
    )
  }

  const restoredPropAccessorNames = new Set<string>()
  const lowerRestoredDefaultValue = (
    defaultValue: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    const overrides: RegionOverrideMap = Object.create(null) as RegionOverrideMap
    for (const name of restoredPropAccessorNames) {
      overrides[name] = () => t.callExpression(t.identifier(name), [])
    }
    const lowered = t.cloneNode(defaultValue, true) as BabelCore.types.Expression
    replaceIdentifiersWithOverrides(lowered, overrides, t, undefined, undefined, false, true)
    return lowered
  }

  for (const [name, restore] of propAccessorRestores) {
    const valueExpr = buildPropsPathRead(restore.path)
    const restoredValue = restore.defaultValue
      ? t.callExpression(
          t.arrowFunctionExpression(
            [t.identifier('__value')],
            t.conditionalExpression(
              t.binaryExpression('===', t.identifier('__value'), voidZero(t)),
              lowerRestoredDefaultValue(restore.defaultValue),
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
    restoredPropAccessorNames.add(name)
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

  for (const [name, loweredFn] of inlineFunctionDeps) {
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(name), t.cloneNode(loweredFn, true)),
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
    ...(handlerMayPreventDefault ? [t.stringLiteral('pd')] : []),
  ])

  if (options?.onQrl) {
    options.onQrl(qrlExpr)
    return true
  }

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
