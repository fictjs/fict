import type * as BabelCore from '@babel/core'

import type { ReactiveExportKind } from '../types'

import type { CodegenContext } from './codegen'
import type { Expression } from './hir'
import { getFictMacroKind } from './macro-bindings'
import { deSSAVarName } from './regions'

const RUNTIME_REACTIVE_CREATORS = new Map<string, ReactiveExportKind>([
  ['createSignal', 'signal'],
  ['createStore', 'store'],
  ['createMemo', 'memo'],
  ['$memo', 'memo'],
  ['$store', 'store'],
])

function isInternalRuntimeModule(source: string | undefined): boolean {
  return source === 'fict/internal' || source === '@fictjs/runtime/internal'
}

export function isInternalCreateStoreRuntimeImport(
  importedName: string,
  source: string | undefined,
): boolean {
  return importedName === 'createStore' && isInternalRuntimeModule(source)
}

export function getRuntimeReactiveCreatorKind(
  name: string,
  source?: string | undefined,
): ReactiveExportKind | null {
  if (isInternalCreateStoreRuntimeImport(name, source)) return null
  return RUNTIME_REACTIVE_CREATORS.get(name) ?? null
}

function isNameShadowed(name: string, ctx: CodegenContext): boolean {
  return !!(ctx.shadowedNames?.has(name) || ctx.localDeclaredNames?.has(name))
}

function getRuntimeImportedKind(name: string, ctx: CodegenContext): ReactiveExportKind | null {
  if (isNameShadowed(name, ctx)) return null
  const imported = ctx.moduleRuntimeImportMap?.get(name)
  if (!imported) return null
  return getRuntimeReactiveCreatorKind(imported, ctx.moduleRuntimeImportSources?.get(name))
}

function getRuntimeMemberKind(expr: Expression, ctx: CodegenContext): ReactiveExportKind | null {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  if (expr.object.kind !== 'Identifier') return null
  const objectName = deSSAVarName(expr.object.name)
  if (isNameShadowed(objectName, ctx)) return null
  if (!ctx.moduleRuntimeNamespaceImports?.has(objectName)) return null
  const propName = getStaticPropName(expr.property as Expression, expr.computed)
  if (typeof propName !== 'string') return null
  return getRuntimeReactiveCreatorKind(
    propName,
    ctx.moduleRuntimeNamespaceImportSources?.get(objectName),
  )
}

function normalizeReactiveCallee(expr: Expression): Expression {
  if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
    return normalizeReactiveCallee(expr.expressions[expr.expressions.length - 1]!)
  }
  return expr
}

function normalizeBabelReactiveCallee(
  expr: BabelCore.types.CallExpression['callee'] | BabelCore.types.OptionalCallExpression['callee'],
  t: typeof BabelCore.types,
): BabelCore.types.CallExpression['callee'] | BabelCore.types.OptionalCallExpression['callee'] {
  if (t.isSequenceExpression(expr) && expr.expressions.length > 0) {
    return normalizeBabelReactiveCallee(expr.expressions[expr.expressions.length - 1]!, t)
  }
  if (t.isParenthesizedExpression(expr)) {
    return normalizeBabelReactiveCallee(expr.expression, t)
  }
  if (t.isTSAsExpression(expr) || t.isTSTypeAssertion(expr) || t.isTSNonNullExpression(expr)) {
    return normalizeBabelReactiveCallee(expr.expression, t)
  }
  return expr
}

export function getStaticPropName(expr: Expression, computed: boolean): string | number | null {
  if (!computed) {
    if (expr.kind === 'Identifier') {
      return deSSAVarName(expr.name)
    }
    if (expr.kind === 'Literal') {
      return typeof expr.value === 'string' || typeof expr.value === 'number' ? expr.value : null
    }
    return null
  }
  if (expr.kind === 'Literal') {
    return typeof expr.value === 'string' || typeof expr.value === 'number' ? expr.value : null
  }
  return null
}

function getStaticBabelPropName(
  property:
    | BabelCore.types.MemberExpression['property']
    | BabelCore.types.OptionalMemberExpression['property'],
  computed: boolean | undefined,
  t: typeof BabelCore.types,
): string | number | null {
  if (!computed) {
    if (t.isIdentifier(property)) return property.name
    if (t.isStringLiteral(property)) return property.value
    if (t.isNumericLiteral(property)) return property.value
    return null
  }
  if (t.isStringLiteral(property)) return property.value
  if (t.isNumericLiteral(property)) return property.value
  return null
}

export function getReactiveCallKind(
  expr: Expression,
  ctx: CodegenContext,
): ReactiveExportKind | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  const callee = normalizeReactiveCallee(expr.callee)
  if (callee.kind === 'Identifier') {
    const name = deSSAVarName(callee.name)
    if (expr.macro === 'state') return 'signal'
    if (expr.macro === 'memo') return 'memo'
    if (!ctx.strictMacroBindings && ctx.stateMacroNames?.has(name)) return 'signal'
    if (!ctx.strictMacroBindings && ctx.storeMacroNames?.has(name) && !isNameShadowed(name, ctx)) {
      return 'store'
    }
    if (!ctx.strictMacroBindings && ctx.memoMacroNames?.has(name)) return 'memo'
    return getRuntimeImportedKind(name, ctx)
  }
  return getRuntimeMemberKind(callee, ctx)
}

export function getReactiveCallKindFromBabel(
  callExpr: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): ReactiveExportKind | null {
  const callee = normalizeBabelReactiveCallee(callExpr.callee, t)
  if (t.isIdentifier(callee)) {
    const name = callee.name
    const macroKind = getFictMacroKind(callExpr)
    if (macroKind === 'state') return 'signal'
    if (macroKind === 'memo') return 'memo'
    if (!ctx.strictMacroBindings && ctx.stateMacroNames?.has(name)) return 'signal'
    if (!ctx.strictMacroBindings && ctx.storeMacroNames?.has(name) && !isNameShadowed(name, ctx)) {
      return 'store'
    }
    if (!ctx.strictMacroBindings && ctx.memoMacroNames?.has(name)) return 'memo'
    return getRuntimeImportedKind(name, ctx)
  }
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const memberCallee = callee
    if (!t.isIdentifier(memberCallee.object)) return null
    const objectName = memberCallee.object.name
    if (isNameShadowed(objectName, ctx)) return null
    if (!ctx.moduleRuntimeNamespaceImports?.has(objectName)) return null
    const propName = getStaticBabelPropName(memberCallee.property, memberCallee.computed, t)
    if (typeof propName !== 'string') return null
    return getRuntimeReactiveCreatorKind(
      propName,
      ctx.moduleRuntimeNamespaceImportSources?.get(objectName),
    )
  }
  return null
}
