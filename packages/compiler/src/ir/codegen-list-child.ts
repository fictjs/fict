import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { collectExpressionDependencies } from './codegen-expression-deps'
import {
  extractKeyFromMapCallback,
  getReturnedJSXElementsFromMapCallback,
  getReturnedKeyAttributeExpressionsFromMapCallback,
  keyExpressionSignature,
} from './codegen-jsx-keys'
import { appendKeyedListNamespaceArgs } from './codegen-namespace-create-element'
import { replaceIdentifiersWithOverrides, type RegionOverrideMap } from './codegen-overrides'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { applySelectorHoist } from './codegen-selector-hoist'
import type { BasicBlock, Expression, JSXElementExpression } from './hir'
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

export interface BuildListCallOptions {
  startMarkerId?: BabelCore.types.Expression | undefined
  endMarkerId?: BabelCore.types.Expression | undefined
  skipHoles?: boolean | undefined
}

function finalizeKeyedListArgs(
  args: BabelCore.types.Expression[],
  ctx: CodegenContext,
  options?: BuildListCallOptions,
): BabelCore.types.Expression[] {
  const { t } = ctx
  if (options?.startMarkerId && options.endMarkerId) {
    args.push(options.startMarkerId, options.endMarkerId, t.booleanLiteral(!!options.skipHoles))
  }
  appendKeyedListNamespaceArgs(ctx, args, ctx.namespaceContext)
  return args
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

function stripExpressionBodySequencePrefix(callback: Expression, keyExpr: Expression): Expression {
  if (
    callback.kind !== 'ArrowFunction' ||
    !callback.isExpression ||
    Array.isArray(callback.body) ||
    callback.body.kind !== 'SequenceExpression' ||
    callback.body.expressions.length <= 1 ||
    keyExpr.kind !== 'SequenceExpression'
  ) {
    return callback
  }

  const tail = callback.body.expressions[callback.body.expressions.length - 1]
  if (!tail) return callback

  return {
    ...callback,
    body: tail,
  }
}

function addPatternNames(
  pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
  names: Set<string>,
  t: typeof BabelCore.types,
): void {
  if (t.isIdentifier(pattern)) {
    names.add(deSSAVarName(pattern.name))
    return
  }
  if (t.isAssignmentPattern(pattern)) {
    addPatternNames(pattern.left as BabelCore.types.PatternLike, names, t)
    return
  }
  if (t.isRestElement(pattern)) {
    addPatternNames(pattern.argument as BabelCore.types.PatternLike, names, t)
    return
  }
  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        addPatternNames(prop.argument as BabelCore.types.PatternLike, names, t)
      } else if (t.isObjectProperty(prop)) {
        addPatternNames(prop.value as BabelCore.types.PatternLike, names, t)
      }
    }
    return
  }
  if (t.isArrayPattern(pattern)) {
    for (const el of pattern.elements) {
      if (el && t.isPatternLike(el)) {
        addPatternNames(el as BabelCore.types.PatternLike, names, t)
      }
    }
  }
}

function collectCallbackVisibleNames(
  callback: Expression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  ctx.localDeclaredNames?.forEach(name => names.add(deSSAVarName(name)))
  ctx.shadowedNames?.forEach(name => names.add(deSSAVarName(name)))

  if (callback.kind === 'ArrowFunction' || callback.kind === 'FunctionExpression') {
    callback.params.forEach(param => names.add(deSSAVarName(param.name)))
    callback.rawParams?.forEach(param =>
      addPatternNames(param as BabelCore.types.PatternLike, names, t),
    )
  }

  for (const block of getCallbackBlocks(callback)) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const isFunctionDecl =
        instr.value.kind === 'FunctionExpression' &&
        !!instr.value.name &&
        deSSAVarName(instr.value.name) === target
      if (instr.declarationKind || isFunctionDecl) {
        names.add(target)
      }
    }
    const term = block.terminator
    if (term.kind === 'ForOf' || term.kind === 'ForIn') {
      if (term.leftKind !== 'assignment') {
        names.add(deSSAVarName(term.variable))
      }
      if (term.leftKind !== 'assignment' && term.pattern) {
        addPatternNames(term.pattern as BabelCore.types.PatternLike, names, t)
      }
    } else if (term.kind === 'Try') {
      if (term.catchPattern) {
        addPatternNames(term.catchPattern as BabelCore.types.PatternLike, names, t)
      } else if (term.catchParam) {
        names.add(deSSAVarName(term.catchParam))
      }
    }
  }

  walkExpression(callback, expr => {
    if (expr.kind === 'Identifier') {
      names.add(deSSAVarName(expr.name))
    }
  })

  return names
}

function reserveFreshName(baseName: string, reserved: Set<string>): string {
  let name = baseName
  let suffix = 0
  while (reserved.has(name)) {
    name = `${baseName}_${suffix++}`
  }
  reserved.add(name)
  return name
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
      if (state.declarationCount <= 1 && !state.hasNonDeclarationWrite) {
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

function resolveMapCallbackKeyExpression(
  keyExpr: Expression,
  aliasMap: Map<string, Expression>,
): Expression {
  if (keyExpr.kind !== 'Identifier') {
    return keyExpr
  }

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

function getAliasDeclaration(
  aliasMap: Map<string, Expression>,
  name: string,
): Expression | undefined {
  return aliasMap.get(name) ?? aliasMap.get(deSSAVarName(name))
}

function collectResolvedKeyAliasNames(
  keyExpr: Expression,
  aliasMap: Map<string, Expression>,
): Set<string> {
  const aliases = new Set<string>()
  if (aliasMap.size === 0) {
    return aliases
  }

  const visitIdentifier = (name: string, seen: Set<string>): void => {
    const baseName = deSSAVarName(name)
    if (seen.has(baseName)) {
      return
    }
    const aliasValue = getAliasDeclaration(aliasMap, name)
    if (!aliasValue) {
      return
    }
    seen.add(baseName)
    aliases.add(baseName)
    walkExpression(
      aliasValue,
      expr => {
        if (expr.kind === 'Identifier') {
          visitIdentifier(expr.name, new Set(seen))
        }
      },
      { includeFunctionBodies: false },
    )
  }

  walkExpression(
    keyExpr,
    expr => {
      if (expr.kind === 'Identifier') {
        visitIdentifier(expr.name, new Set())
      }
    },
    { includeFunctionBodies: false },
  )

  return aliases
}

function collectReturnedKeyBindingSignatures(callback: Expression): Set<string> {
  const signatures = new Set<string>()
  for (const keyExpr of getReturnedKeyAttributeExpressionsFromMapCallback(callback)) {
    const signature = keyExpressionSignature(keyExpr)
    if (signature) {
      signatures.add(signature)
    }
  }
  return signatures
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

const ARRAY_RETURNING_METHODS = new Set(['filter', 'map', 'slice', 'toReversed', 'toSorted'])

function getStaticMemberName(expr: Expression): string | null {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  if (!expr.computed && expr.property.kind === 'Identifier') return expr.property.name
  if (expr.property.kind === 'Literal') return String(expr.property.value)
  return null
}

function getRootIdentifierName(expr: Expression): string | null {
  let current = expr
  while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
    current = current.object
  }
  return current.kind === 'Identifier' ? deSSAVarName(current.name) : null
}

function isTrustedArrayMapReceiver(expr: Expression, ctx: CodegenContext): boolean {
  switch (expr.kind) {
    case 'ArrayExpression':
      return true
    case 'Identifier':
      return !!(
        ctx.signalVars?.has(deSSAVarName(expr.name)) ||
        ctx.knownArrayVars?.has(deSSAVarName(expr.name))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const rootName = getRootIdentifierName(expr)
      return !!(rootName && ctx.storeVars?.has(rootName))
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      if (expr.kind === 'OptionalCallExpression' && expr.optional) return false
      if (
        expr.callee.kind !== 'MemberExpression' &&
        expr.callee.kind !== 'OptionalMemberExpression'
      ) {
        return false
      }
      const methodName = getStaticMemberName(expr.callee)
      return !!(
        methodName &&
        ARRAY_RETURNING_METHODS.has(methodName) &&
        isTrustedArrayMapReceiver(expr.callee.object, ctx)
      )
    }
    default:
      return false
  }
}

function collectExpressionNodes(expr: Expression, nodes: Set<Expression>): void {
  walkExpression(
    expr,
    node => {
      nodes.add(node)
    },
    { includeFunctionBodies: false },
  )
}

function collectJSXContentExpressionNodes(
  element: JSXElementExpression,
  nodes: Set<Expression>,
): void {
  if (typeof element.tagName !== 'string') {
    collectExpressionNodes(element.tagName, nodes)
  }

  for (const attr of element.attributes) {
    if (attr.isSpread && attr.spreadExpr) {
      collectExpressionNodes(attr.spreadExpr, nodes)
      continue
    }
    if (attr.value) {
      collectExpressionNodes(attr.value, nodes)
    }
  }

  for (const child of element.children) {
    if (child.kind === 'expression') {
      collectExpressionNodes(child.value, nodes)
    } else if (child.kind === 'element') {
      collectJSXContentExpressionNodes(child.value, nodes)
    }
  }
}

function collectIgnoredKeyEffectNodes(
  callback: Expression,
  extractedKeyExpr: Expression | undefined,
  aliasMap: Map<string, Expression>,
): Set<Expression> | undefined {
  if (!extractedKeyExpr) {
    return undefined
  }

  const ignoredNodes = new Set<Expression>()
  collectExpressionNodes(extractedKeyExpr, ignoredNodes)
  for (const keyExpr of getReturnedKeyAttributeExpressionsFromMapCallback(callback)) {
    collectExpressionNodes(keyExpr, ignoredNodes)
  }
  for (const aliasName of collectResolvedKeyAliasNames(extractedKeyExpr, aliasMap)) {
    const aliasValue = getAliasDeclaration(aliasMap, aliasName)
    if (aliasValue) {
      collectExpressionNodes(aliasValue, ignoredNodes)
    }
  }
  for (const element of getReturnedJSXElementsFromMapCallback(callback)) {
    collectJSXContentExpressionNodes(element, ignoredNodes)
  }

  return ignoredNodes.size > 0 ? ignoredNodes : undefined
}

function expressionHasObservableMapCallbackEffect(
  expr: Expression,
  ignoredNodes?: Set<Expression> | undefined,
): boolean {
  let hasEffect = false
  walkExpression(
    expr,
    node => {
      if (hasEffect) return
      if (ignoredNodes?.has(node)) return
      switch (node.kind) {
        case 'CallExpression':
        case 'OptionalCallExpression':
        case 'NewExpression':
        case 'TaggedTemplateExpression':
        case 'AwaitExpression':
        case 'YieldExpression':
        case 'ImportExpression':
        case 'AssignmentExpression':
        case 'UpdateExpression':
          hasEffect = true
          return
        default:
          return
      }
    },
    { includeFunctionBodies: false },
  )
  return hasEffect
}

function mapCallbackHasObservableEffects(
  callback: Expression,
  ignoredNodes?: Set<Expression> | undefined,
): boolean {
  if (callback.kind === 'ArrowFunction' && callback.isExpression && !Array.isArray(callback.body)) {
    return expressionHasObservableMapCallbackEffect(callback.body, ignoredNodes)
  }
  if (callback.kind !== 'ArrowFunction' && callback.kind !== 'FunctionExpression') return false

  for (const block of getCallbackBlocks(callback)) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Debugger' || instr.kind === 'Expression') return true
      if (instr.kind === 'Assign') {
        if (!instr.declarationKind) return true
        if (expressionHasObservableMapCallbackEffect(instr.value, ignoredNodes)) return true
      }
    }

    const term = block.terminator
    switch (term.kind) {
      case 'Return':
        if (
          term.argument &&
          expressionHasObservableMapCallbackEffect(term.argument, ignoredNodes)
        ) {
          return true
        }
        break
      case 'Jump':
      case 'Unreachable':
      case 'Break':
      case 'Continue':
        break
      default:
        return true
    }
  }

  return false
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

function getMutationTargetRootName(expr: Expression): string | null {
  let current = expr
  while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
    current = current.object
  }
  return current.kind === 'Identifier' ? deSSAVarName(current.name) : null
}

function expressionMutatesAnyName(expr: Expression, names: Set<string>): boolean {
  let mutates = false
  walkExpression(
    expr,
    node => {
      if (mutates) return
      if (node.kind === 'AssignmentExpression') {
        const root = getMutationTargetRootName(node.left)
        if (root && names.has(root)) mutates = true
      } else if (node.kind === 'UpdateExpression') {
        const root = getMutationTargetRootName(node.argument)
        if (root && names.has(root)) mutates = true
      }
    },
    { includeFunctionBodies: false },
  )
  return mutates
}

function callbackMutatesParameters(callback: Expression): boolean {
  if (callback.kind !== 'ArrowFunction' && callback.kind !== 'FunctionExpression') return false
  const paramNames = new Set(callback.params.map(param => deSSAVarName(param.name)))
  if (paramNames.size === 0) return false

  const expressionMutatesParams = (expr: Expression): boolean =>
    expressionMutatesAnyName(expr, paramNames)

  if (callback.kind === 'ArrowFunction' && callback.isExpression && !Array.isArray(callback.body)) {
    return expressionMutatesParams(callback.body)
  }

  for (const block of getCallbackBlocks(callback)) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && paramNames.has(deSSAVarName(instr.target.name))) {
        return true
      }
      if (
        (instr.kind === 'Assign' || instr.kind === 'Expression') &&
        expressionMutatesParams(instr.value)
      ) {
        return true
      }
    }

    const term = block.terminator
    switch (term.kind) {
      case 'Return':
        if (term.argument && expressionMutatesParams(term.argument)) return true
        break
      case 'Throw':
        if (expressionMutatesParams(term.argument)) return true
        break
      case 'Branch':
        if (expressionMutatesParams(term.test)) return true
        break
      case 'Switch':
        if (expressionMutatesParams(term.discriminant)) return true
        for (const switchCase of term.cases) {
          if (switchCase.test && expressionMutatesParams(switchCase.test)) return true
        }
        break
      case 'ForOf':
        if (expressionMutatesParams(term.iterable)) return true
        break
      case 'ForIn':
        if (expressionMutatesParams(term.object)) return true
        break
      default:
        break
    }
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
  options?: BuildListCallOptions,
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
  if (expr.kind === 'OptionalCallExpression' && expr.optional) {
    return null
  }
  if (!isTrustedArrayMapReceiver(expr.callee.object, ctx)) {
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
  if (callbackMutatesParameters(mapCallback)) return null
  if (isDefinitelyNonCallableMapCallback(mapCallback)) return null
  const extractedKeyExpr = extractKeyFromMapCallback(mapCallback)
  const keyAliasDeclarations = extractedKeyExpr
    ? collectMapCallbackAliasDeclarations(mapCallback)
    : new Map<string, Expression>()
  const ignoredKeyEffectNodes = collectIgnoredKeyEffectNodes(
    mapCallback,
    extractedKeyExpr,
    keyAliasDeclarations,
  )
  if (mapCallbackHasObservableEffects(mapCallback, ignoredKeyEffectNodes)) return null
  if (callbackUsesArguments(mapCallback, ctx)) return null
  if (callbackUsesThis(mapCallback, ctx)) return null
  const callbackSignature = getMapCallbackSignature(mapCallback, ctx)
  if (!callbackSignature) return null
  if (callbackSignature.hasRest || callbackSignature.paramCount >= 3) return null
  const keyExpr = extractedKeyExpr
    ? resolveMapCallbackKeyExpression(extractedKeyExpr, keyAliasDeclarations)
    : undefined
  const isKeyed = !!keyExpr
  const hasRestParam =
    (mapCallback.kind === 'ArrowFunction' || mapCallback.kind === 'FunctionExpression') &&
    Array.isArray(mapCallback.rawParams) &&
    mapCallback.rawParams.some(param => t.isRestElement(param))
  const hasUnresolvedLocalKeyDeps =
    isKeyed && keyExpr
      ? hasUnresolvedCallbackLocalKeyDependencies(keyExpr, mapCallback, keyAliasDeclarations)
      : false
  if (hasUnresolvedLocalKeyDeps) return null
  const canReuseComputedKey = !!(isKeyed && keyExpr)
  const canConstifyKey = canReuseComputedKey && !hasRestParam
  const generatedNameReservations = collectCallbackVisibleNames(mapCallback, ctx, t)
  const generatedItemParamName = reserveFreshName('__item', generatedNameReservations)
  const generatedIndexParamName = reserveFreshName('__index', generatedNameReservations)
  const generatedKeyParamName = reserveFreshName('__key', generatedNameReservations)
  const renderMapCallback =
    extractedKeyExpr && keyExpr
      ? stripExpressionBodySequencePrefix(mapCallback, keyExpr)
      : mapCallback

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
  const prevListKeyBindingSignatures = ctx.listKeyBindingSignatures
  const prevListKeyAliasNames = ctx.listKeyAliasNames

  if (canConstifyKey && keyExpr) {
    ctx.listKeyExpr = keyExpr
    ctx.listKeyParamName = generatedKeyParamName
    ctx.listKeyBindingSignatures = collectReturnedKeyBindingSignatures(renderMapCallback)
    ctx.listKeyAliasNames = extractedKeyExpr
      ? collectResolvedKeyAliasNames(extractedKeyExpr, keyAliasDeclarations)
      : undefined
    // Extract item param name from callback.
    if (mapCallback.kind === 'ArrowFunction' || mapCallback.kind === 'FunctionExpression') {
      const firstParam = mapCallback.params[0]
      if (firstParam) {
        ctx.listItemParamName = deSSAVarName(firstParam.name)
      }
    }
  }

  const prevInListRender = ctx.inListRender
  const prevListItemAccessorParamNames = ctx.listItemAccessorParamNames
  const prevListKeyConstificationDepth = ctx.listKeyConstificationDepth
  const prevListKeyConstificationDisabled = ctx.listKeyConstificationDisabled
  ctx.inListRender = true
  ctx.listKeyConstificationDepth = canConstifyKey ? 0 : undefined
  ctx.listKeyConstificationDisabled = false
  if (mapCallback.params[0]) {
    ctx.listItemAccessorParamNames = new Set(prevListItemAccessorParamNames ?? [])
    ctx.listItemAccessorParamNames.add(deSSAVarName(mapCallback.params[0].name))
    if (mapCallback.params[1]) {
      ctx.listItemAccessorParamNames.add(deSSAVarName(mapCallback.params[1].name))
    }
  }
  let callbackExpr: BabelCore.types.Expression
  try {
    callbackExpr = ops.lowerExpression(renderMapCallback, ctx)
  } finally {
    ctx.inListRender = prevInListRender
    ctx.listItemAccessorParamNames = prevListItemAccessorParamNames
    ctx.listKeyConstificationDepth = prevListKeyConstificationDepth
    ctx.listKeyConstificationDisabled = prevListKeyConstificationDisabled
  }

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
  ctx.listKeyBindingSignatures = prevListKeyBindingSignatures
  ctx.listKeyAliasNames = prevListKeyAliasNames

  callbackExpr = ops.applyRegionMetadataToExpression(callbackExpr, ctx)

  // Collect hoisted template declarations to insert before list call.
  const hoistedStatements = ctx.hoistedTemplateStatements
  ctx.hoistedTemplates = prevHoistedTemplates
  ctx.hoistedTemplateStatements = prevHoistedTemplateStatements

  if (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) {
    const [firstParam, secondParam] = callbackExpr.params
    const overrides = Object.create(null) as RegionOverrideMap

    if (t.isIdentifier(firstParam)) {
      overrides[firstParam.name] = () => t.callExpression(t.identifier(firstParam.name), [])
    }
    if (t.isIdentifier(secondParam)) {
      overrides[secondParam.name] = () => t.callExpression(t.identifier(secondParam.name), [])
    }

    if (Object.keys(overrides).length > 0) {
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
    if (keyAliasDeclarations.size > 0) {
      const keyOverrides = Object.create(null) as RegionOverrideMap
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
    const keyFn = t.arrowFunctionExpression(
      [
        t.isIdentifier(itemParamName) ? itemParamName : t.identifier(generatedItemParamName),
        t.isIdentifier(indexParamName) ? indexParamName : t.identifier(generatedIndexParamName),
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
        newParams.push(
          t.identifier(newParams.length === 0 ? generatedItemParamName : generatedIndexParamName),
        )
      }
      // Add __key as third param.
      newParams.push(t.identifier(generatedKeyParamName))
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
          [
            t.identifier(generatedItemParamName),
            t.identifier(generatedIndexParamName),
            t.identifier(generatedKeyParamName),
          ],
          t.callExpression(t.cloneNode(deferredCallbackId!, true), [
            t.identifier(generatedItemParamName),
            t.identifier(generatedIndexParamName),
            t.identifier(generatedKeyParamName),
          ]),
        )
      : callbackExpr

    listCall = t.callExpression(
      runtimeIdentifier(ctx, 'keyedList'),
      finalizeKeyedListArgs(
        [getItemsExpr, keyFn, renderExpr, t.booleanLiteral(hasIndexParam)],
        ctx,
        options,
      ),
    )
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
          : generatedItemParamName
        : generatedItemParamName
    const indexParamName =
      t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)
        ? t.isIdentifier(callbackExpr.params[1])
          ? callbackExpr.params[1].name
          : generatedIndexParamName
        : generatedIndexParamName
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
          [
            t.identifier(generatedItemParamName),
            t.identifier(generatedIndexParamName),
            t.identifier(generatedKeyParamName),
          ],
          t.callExpression(t.cloneNode(deferredCallbackId!, true), [
            t.identifier(generatedItemParamName),
            t.identifier(generatedIndexParamName),
            t.identifier(generatedKeyParamName),
          ]),
        )
      : callbackExpr

    const keyFn = t.arrowFunctionExpression(
      [t.identifier(itemParamName), t.identifier(indexParamName)],
      t.identifier(indexParamName),
    )

    listCall = t.callExpression(
      runtimeIdentifier(ctx, 'keyedList'),
      finalizeKeyedListArgs(
        [getItemsExpr, keyFn, renderExpr, t.booleanLiteral(hasIndexParam)],
        ctx,
        options,
      ),
    )
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

  const listCall = buildListCallExpression(expr, statements, ctx, ops, {
    startMarkerId,
    endMarkerId,
    skipHoles: true,
  })
  if (!listCall) return false

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
