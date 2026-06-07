import type * as BabelCore from '@babel/core'

import { parseCanonicalArrayPropIndex } from '../metadata-indices'
import type { HookReturnInfoSerializable, ReactiveExportKind } from '../types'

import type { CodegenContext } from './codegen'
import { collectMutatedIdentifiers } from './codegen-analysis'
import { computeReactiveAccessors } from './codegen-reactive-accessors'
import { getReactiveCallKind, getStaticPropName } from './codegen-reactive-kind'
import type { Expression, HIRFunction } from './hir'
import { isHookName } from './hook-utils'
import { deSSAVarName, generateRegions, type Region } from './regions'
import { analyzeReactiveScopesWithSSA, type ReactiveScopeResult } from './scopes'

export type HookAccessorKind = ReactiveExportKind

export interface HookReturnInfo {
  objectProps?: Map<string, HookAccessorKind> | undefined
  arrayProps?: Map<number, HookAccessorKind> | undefined
  directAccessor?: HookAccessorKind | undefined
}

export interface HookReturnInfoAnalysisOps {
  createCodegenContext: (t: typeof BabelCore.types) => CodegenContext
  detectDerivedCycles: (
    fn: HIRFunction,
    scopeResult: ReactiveScopeResult,
    ctx: CodegenContext,
  ) => void
  flattenRegions: (regions: Region[]) => NonNullable<CodegenContext['regions']>
}

function getStaticHookReturnPropName(expr: Expression, computed: boolean): string | number | null {
  const propName = getStaticPropName(expr, computed)
  if (propName !== null) return propName
  if (computed && expr.kind === 'Literal' && typeof expr.value === 'bigint') {
    return expr.value.toString()
  }
  return null
}

function getStaticNamespaceMetadataKey(expr: Expression, computed: boolean): string | null {
  const propName = getStaticHookReturnPropName(expr, computed)
  return propName === null ? null : String(propName)
}

export function serializeHookReturnInfo(info: HookReturnInfo): HookReturnInfoSerializable {
  const objectProps: Record<string, HookAccessorKind> | undefined = info.objectProps
    ? Object.fromEntries(info.objectProps.entries())
    : undefined
  const arrayProps: Record<string, HookAccessorKind> | undefined = info.arrayProps
    ? Object.fromEntries(Array.from(info.arrayProps.entries()).map(([k, v]) => [String(k), v]))
    : undefined
  return {
    objectProps,
    arrayProps,
    directAccessor: info.directAccessor,
  }
}

export function deserializeHookReturnInfo(info: HookReturnInfoSerializable): HookReturnInfo {
  const objectProps = info.objectProps ? new Map(Object.entries(info.objectProps)) : undefined
  const arrayProps = info.arrayProps
    ? new Map(
        Object.entries(info.arrayProps).flatMap(([k, v]) => {
          const index = parseCanonicalArrayPropIndex(k)
          return index === null ? [] : [[index, v]]
        }),
      )
    : undefined
  return {
    objectProps,
    arrayProps,
    directAccessor: info.directAccessor,
  }
}

function collectHookReactiveVars(
  fn: HIRFunction,
  ctx: CodegenContext,
): {
  signalVars: Set<string>
  storeVars: Set<string>
  memoVars: Set<string>
  functionVars: Set<string>
  mutatedVars: Set<string>
  localVars: Set<string>
} {
  const signalVars = new Set<string>()
  const storeVars = new Set<string>()
  const memoVars = new Set<string>()
  const functionVars = new Set<string>()
  const mutatedVars = new Set<string>()
  const localVars = new Set<string>(fn.params.map(param => deSSAVarName(param.name)))

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.declarationKind) {
          localVars.add(target)
        }
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          functionVars.add(target)
        }
        if (
          instr.value.kind === 'CallExpression' ||
          instr.value.kind === 'OptionalCallExpression'
        ) {
          const callKind = getReactiveCallKind(instr.value, ctx)
          if (callKind === 'signal') {
            signalVars.add(target)
          } else if (callKind === 'store') {
            storeVars.add(target)
          } else if (callKind === 'memo') {
            memoVars.add(target)
          }
        }
        if (!instr.declarationKind) {
          mutatedVars.add(target)
        }
      } else if (instr.kind === 'Phi') {
        mutatedVars.add(deSSAVarName(instr.target.name))
      }
    }
  }
  collectMutatedIdentifiers(fn).forEach(name => mutatedVars.add(name))

  return { signalVars, storeVars, memoVars, functionVars, mutatedVars, localVars }
}

export function analyzeHookReturnInfo(
  fn: HIRFunction,
  ctx: CodegenContext,
  ops: HookReturnInfoAnalysisOps,
): HookReturnInfo | null {
  if (!isHookName(fn.name)) return null

  const { signalVars, storeVars, memoVars, functionVars, mutatedVars, localVars } =
    collectHookReactiveVars(fn, ctx)
  const seedImportedVars = (source: Set<string> | undefined, target: Set<string>) => {
    source?.forEach(name => {
      const base = deSSAVarName(name)
      if (!localVars.has(base)) {
        target.add(base)
      }
    })
  }
  seedImportedVars(ctx.signalVars, signalVars)
  seedImportedVars(ctx.storeVars, storeVars)
  seedImportedVars(ctx.memoVars, memoVars)
  const tmpCtx = ops.createCodegenContext(ctx.t)
  tmpCtx.signalVars = new Set(signalVars)
  tmpCtx.storeVars = new Set(storeVars)
  tmpCtx.functionVars = new Set(functionVars)
  tmpCtx.mutatedVars = new Set(mutatedVars)
  tmpCtx.aliasVars = new Set()
  tmpCtx.trackedVars = new Set()
  tmpCtx.memoVars = new Set(memoVars)

  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  ops.detectDerivedCycles(fn, scopeResult, ctx)
  tmpCtx.scopes = scopeResult
  const regionResult = generateRegions(fn, scopeResult)
  tmpCtx.regions = ops.flattenRegions(regionResult.topLevelRegions)
  const reactive = computeReactiveAccessors(fn, tmpCtx)
  tmpCtx.trackedVars = reactive.tracked
  tmpCtx.memoVars = reactive.memo

  const info: HookReturnInfo = {}
  let hasInfo = false

  const recordAccessor = (kind: HookAccessorKind | undefined, handler: () => void) => {
    if (kind) {
      hasInfo = true
      handler()
    }
  }

  const copyHookInfo = (source: HookReturnInfo | null) => {
    if (!source) return
    if (source.objectProps) {
      info.objectProps = new Map(source.objectProps)
      hasInfo = true
    }
    if (source.arrayProps) {
      info.arrayProps = new Map(source.arrayProps)
      hasInfo = true
    }
    if (source.directAccessor) {
      info.directAccessor = source.directAccessor
      hasInfo = true
    }
  }

  const exprAccessorKind = (name: string | undefined): HookAccessorKind | undefined => {
    if (!name) return undefined
    const base = deSSAVarName(name)
    if (tmpCtx.signalVars?.has(base)) return 'signal'
    if (tmpCtx.storeVars?.has(base)) return 'store'
    if (tmpCtx.memoVars?.has(base)) return 'memo'
    return undefined
  }
  const namespaceMemberAccessorKind = (expr: Expression): HookAccessorKind | undefined => {
    if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') {
      return undefined
    }
    if (expr.object.kind !== 'Identifier') return undefined
    const nsMeta = ctx.importedNamespaces?.get(deSSAVarName(expr.object.name))
    if (!nsMeta) return undefined
    const propName = getStaticNamespaceMetadataKey(expr.property as Expression, expr.computed)
    if (propName === null) return undefined
    const kind = nsMeta.exports[propName]
    return kind
  }
  const namespaceHookCallInfo = (expr: Expression): HookReturnInfo | null => {
    if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
    const callee = expr.callee
    if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
      return null
    }
    if (callee.object.kind !== 'Identifier') return null
    const nsMeta = ctx.importedNamespaces?.get(deSSAVarName(callee.object.name))
    if (!nsMeta?.hooks) return null
    const propName = getStaticNamespaceMetadataKey(callee.property as Expression, callee.computed)
    if (propName === null) return null
    const hookInfo = nsMeta.hooks[propName]
    return hookInfo ? deserializeHookReturnInfo(hookInfo) : null
  }
  const staticMemberPath = (expr: Expression): string[] | null => {
    if (expr.kind === 'Identifier') return [deSSAVarName(expr.name)]
    if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
    const objectPath = staticMemberPath(expr.object as Expression)
    if (!objectPath) return null
    const propName = getStaticHookReturnPropName(expr.property as Expression, expr.computed)
    if (propName === null) return null
    return [...objectPath, String(propName)]
  }
  const localHookMemberCallInfo = (expr: Expression): HookReturnInfo | null => {
    if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
    const callee = expr.callee
    if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
      return null
    }
    const path = staticMemberPath(callee)
    if (!path || path.length < 2) return null
    const hookName = ctx.hookFunctionMemberAliases?.get(path.join('.'))
    return hookName ? getHookReturnInfo(hookName, ctx, ops) : null
  }
  const hookCallDirectAccessorKind = (expr: Expression): HookAccessorKind | undefined => {
    if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return undefined
    const info =
      namespaceHookCallInfo(expr) ??
      localHookMemberCallInfo(expr) ??
      (expr.callee.kind === 'Identifier' ? getHookReturnInfo(expr.callee.name, ctx, ops) : null)
    const kind = info?.directAccessor
    return kind
  }
  const compatibleAccessorKind = (
    left: HookAccessorKind | undefined,
    right: HookAccessorKind | undefined,
  ): HookAccessorKind | undefined => (left && left === right ? left : undefined)

  const isAlwaysTruthy = (expr: Expression): boolean => {
    if (returnExprAccessorKind(expr)) return true
    if (expr.kind === 'Literal') return !!expr.value
    if (
      expr.kind === 'ArrayExpression' ||
      expr.kind === 'ObjectExpression' ||
      expr.kind === 'ArrowFunction' ||
      expr.kind === 'FunctionExpression' ||
      expr.kind === 'ClassExpression'
    ) {
      return true
    }
    if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
      return isAlwaysTruthy(expr.expressions[expr.expressions.length - 1]!)
    }
    return false
  }

  const isAlwaysFalsy = (expr: Expression): boolean => {
    if (returnExprAccessorKind(expr)) return false
    if (expr.kind === 'Literal') return !expr.value
    if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
      return isAlwaysFalsy(expr.expressions[expr.expressions.length - 1]!)
    }
    return false
  }

  const isAlwaysNullish = (expr: Expression): boolean => {
    if (returnExprAccessorKind(expr)) return false
    if (expr.kind === 'Literal') return expr.value == null
    if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
      return isAlwaysNullish(expr.expressions[expr.expressions.length - 1]!)
    }
    return false
  }

  function iifeAccessorKind(expr: Expression): HookAccessorKind | undefined {
    if (expr.kind !== 'CallExpression' || expr.arguments.length > 0) return undefined
    if (
      expr.callee.kind === 'ArrowFunction' &&
      expr.callee.params.length === 0 &&
      expr.callee.isExpression &&
      !Array.isArray(expr.callee.body)
    ) {
      return returnExprAccessorKind(expr.callee.body)
    }
    return undefined
  }

  function logicalAccessorKind(expr: Extract<Expression, { kind: 'LogicalExpression' }>) {
    const leftKind = returnExprAccessorKind(expr.left)
    if (expr.operator === '&&') {
      if (isAlwaysFalsy(expr.left)) return undefined
      return leftKind || isAlwaysTruthy(expr.left) ? returnExprAccessorKind(expr.right) : undefined
    }
    if (expr.operator === '||') {
      if (leftKind) return leftKind
      return isAlwaysFalsy(expr.left) ? returnExprAccessorKind(expr.right) : undefined
    }
    if (leftKind) return leftKind
    return isAlwaysNullish(expr.left) ? returnExprAccessorKind(expr.right) : undefined
  }

  function returnExprAccessorKind(expr: Expression): HookAccessorKind | undefined {
    if (expr.kind === 'Identifier') return exprAccessorKind(expr.name)
    const namespaceKind = namespaceMemberAccessorKind(expr)
    if (namespaceKind) return namespaceKind
    const hookCallKind = hookCallDirectAccessorKind(expr)
    if (hookCallKind) return hookCallKind
    if (expr.kind === 'ConditionalExpression') {
      return compatibleAccessorKind(
        returnExprAccessorKind(expr.consequent),
        returnExprAccessorKind(expr.alternate),
      )
    }
    if (expr.kind === 'LogicalExpression') {
      return logicalAccessorKind(expr)
    }
    if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
      return returnExprAccessorKind(expr.expressions[expr.expressions.length - 1]!)
    }
    return iifeAccessorKind(expr)
  }

  const visitReturnExpr = (expr: Expression) => {
    if (expr.kind === 'ObjectExpression') {
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          info.objectProps?.clear()
          return
        }
        if (prop.kind !== 'Property') return
        const propName = getStaticHookReturnPropName(prop.key as Expression, prop.computed === true)
        if (propName === null) return
        if (prop.computed !== true && propName === '__proto__') return
        const keyName = String(propName)
        const kind = returnExprAccessorKind(prop.value)
        if (!kind) {
          info.objectProps?.delete(keyName)
          return
        }
        recordAccessor(kind, () => {
          if (!info.objectProps) info.objectProps = new Map()
          info.objectProps.set(keyName, kind!)
        })
      })
    } else if (expr.kind === 'ArrayExpression') {
      let canRecordArrayProps = true
      expr.elements.forEach((el, idx) => {
        if (!el) return
        if (el.kind === 'SpreadElement') {
          canRecordArrayProps = false
          return
        }
        if (!canRecordArrayProps) return
        const kind = returnExprAccessorKind(el)
        recordAccessor(kind, () => {
          if (!info.arrayProps) info.arrayProps = new Map()
          info.arrayProps.set(idx, kind!)
        })
      })
    } else if (expr.kind === 'CallExpression' || expr.kind === 'OptionalCallExpression') {
      const memberInfo = namespaceHookCallInfo(expr) ?? localHookMemberCallInfo(expr)
      if (memberInfo) {
        copyHookInfo(memberInfo)
      } else if (expr.callee.kind === 'Identifier') {
        copyHookInfo(getHookReturnInfo(expr.callee.name, ctx, ops))
      } else {
        const kind = returnExprAccessorKind(expr)
        recordAccessor(kind, () => {
          info.directAccessor = kind
        })
      }
    } else {
      const kind = returnExprAccessorKind(expr)
      recordAccessor(kind, () => {
        info.directAccessor = kind
      })
    }
  }

  for (const block of fn.blocks) {
    if (block.terminator.kind === 'Return' && block.terminator.argument) {
      visitReturnExpr(block.terminator.argument)
    }
  }

  return hasInfo ? info : null
}

export function getHookReturnInfo(
  name: string,
  ctx: CodegenContext,
  ops: HookReturnInfoAnalysisOps,
): HookReturnInfo | null {
  if (!ctx.hookReturnInfo) ctx.hookReturnInfo = new Map()
  const cached = ctx.hookReturnInfo.get(name)
  if (cached) return cached
  if (!isHookName(name)) return null

  const fn = ctx.programFunctions?.get(name)
  if (!fn) return null

  // Priority: meta annotation > same-file analysis
  // Check for @fictReturn annotation in function meta first
  if (fn.meta?.hookReturnInfo) {
    const annotationInfo: HookReturnInfo = {
      objectProps: fn.meta.hookReturnInfo.objectProps,
      arrayProps: fn.meta.hookReturnInfo.arrayProps,
      directAccessor: fn.meta.hookReturnInfo.directAccessor,
    }
    ctx.hookReturnInfo.set(name, annotationInfo)
    return annotationInfo
  }

  // Fallback to same-file analysis
  const info = analyzeHookReturnInfo(fn, ctx, ops)
  if (info) {
    ctx.hookReturnInfo.set(name, info)
  }
  return info ?? null
}
