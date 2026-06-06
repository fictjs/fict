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
])

function isNameShadowed(name: string, ctx: CodegenContext): boolean {
  return !!(ctx.shadowedNames?.has(name) || ctx.localDeclaredNames?.has(name))
}

function getRuntimeImportedKind(name: string, ctx: CodegenContext): ReactiveExportKind | null {
  if (isNameShadowed(name, ctx)) return null
  const imported = ctx.moduleRuntimeImportMap?.get(name)
  if (!imported) return null
  return RUNTIME_REACTIVE_CREATORS.get(imported) ?? null
}

function getRuntimeMemberKind(expr: Expression, ctx: CodegenContext): ReactiveExportKind | null {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  if (expr.object.kind !== 'Identifier') return null
  const objectName = deSSAVarName(expr.object.name)
  if (isNameShadowed(objectName, ctx)) return null
  if (!ctx.moduleRuntimeNamespaceImports?.has(objectName)) return null
  const propName = getStaticPropName(expr.property as Expression, expr.computed)
  if (typeof propName !== 'string') return null
  return RUNTIME_REACTIVE_CREATORS.get(propName) ?? null
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

export function getReactiveCallKind(
  expr: Expression,
  ctx: CodegenContext,
): ReactiveExportKind | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  const callee = expr.callee
  if (callee.kind === 'Identifier') {
    const name = deSSAVarName(callee.name)
    if (expr.macro === 'state') return 'signal'
    if (expr.macro === 'memo') return 'memo'
    if (!ctx.strictMacroBindings && ctx.stateMacroNames?.has(name)) return 'signal'
    if (ctx.storeMacroNames?.has(name)) return 'store'
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
  const callee = callExpr.callee
  if (t.isIdentifier(callee)) {
    const name = callee.name
    const macroKind = getFictMacroKind(callExpr)
    if (macroKind === 'state') return 'signal'
    if (macroKind === 'memo') return 'memo'
    if (!ctx.strictMacroBindings && ctx.stateMacroNames?.has(name)) return 'signal'
    if (ctx.storeMacroNames?.has(name)) return 'store'
    if (!ctx.strictMacroBindings && ctx.memoMacroNames?.has(name)) return 'memo'
    return getRuntimeImportedKind(name, ctx)
  }
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const memberCallee = callee as BabelCore.types.MemberExpression
    if (!t.isIdentifier(memberCallee.object)) return null
    const objectName = memberCallee.object.name
    if (isNameShadowed(objectName, ctx)) return null
    if (!ctx.moduleRuntimeNamespaceImports?.has(objectName)) return null
    const propName = t.isIdentifier(memberCallee.property)
      ? memberCallee.property.name
      : t.isStringLiteral(memberCallee.property)
        ? memberCallee.property.value
        : t.isNumericLiteral(memberCallee.property)
          ? String(memberCallee.property.value)
          : null
    if (!propName) return null
    return RUNTIME_REACTIVE_CREATORS.get(propName) ?? null
  }
  return null
}
