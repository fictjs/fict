import type * as BabelCore from '@babel/core'

import type { HookReturnInfoSerializable } from '../types'

import type { CodegenContext } from './codegen'
import { computeReactiveAccessors } from './codegen-reactive-accessors'
import { getReactiveCallKind } from './codegen-reactive-kind'
import type { Expression, HIRFunction } from './hir'
import { isHookName } from './hook-utils'
import { deSSAVarName, generateRegions, type Region } from './regions'
import { analyzeReactiveScopesWithSSA, type ReactiveScopeResult } from './scopes'

export type HookAccessorKind = 'signal' | 'memo'

export interface HookReturnInfo {
  objectProps?: Map<string, HookAccessorKind>
  arrayProps?: Map<number, HookAccessorKind>
  directAccessor?: HookAccessorKind
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
    ? new Map(Object.entries(info.arrayProps).map(([k, v]) => [Number.parseInt(k, 10), v]))
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
} {
  const signalVars = new Set<string>()
  const storeVars = new Set<string>()
  const memoVars = new Set<string>()
  const functionVars = new Set<string>()
  const mutatedVars = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
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

  return { signalVars, storeVars, memoVars, functionVars, mutatedVars }
}

export function analyzeHookReturnInfo(
  fn: HIRFunction,
  ctx: CodegenContext,
  ops: HookReturnInfoAnalysisOps,
): HookReturnInfo | null {
  if (!isHookName(fn.name)) return null

  const { signalVars, storeVars, memoVars, functionVars, mutatedVars } = collectHookReactiveVars(
    fn,
    ctx,
  )
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
    if (tmpCtx.memoVars?.has(base)) return 'memo'
    return undefined
  }

  const visitReturnExpr = (expr: Expression) => {
    if (expr.kind === 'ObjectExpression') {
      expr.properties.forEach(prop => {
        if (prop.kind !== 'Property') return
        if (prop.computed) return
        const keyName =
          prop.key.kind === 'Identifier'
            ? prop.key.name
            : prop.key.kind === 'Literal'
              ? String(prop.key.value)
              : undefined
        if (!keyName) return
        if (prop.value.kind === 'Identifier') {
          const kind = exprAccessorKind(prop.value.name)
          recordAccessor(kind, () => {
            if (!info.objectProps) info.objectProps = new Map()
            info.objectProps.set(keyName, kind!)
          })
        }
      })
    } else if (expr.kind === 'ArrayExpression') {
      expr.elements.forEach((el, idx) => {
        if (!el || el.kind !== 'Identifier') return
        const kind = exprAccessorKind(el.name)
        recordAccessor(kind, () => {
          if (!info.arrayProps) info.arrayProps = new Map()
          info.arrayProps.set(idx, kind!)
        })
      })
    } else if (expr.kind === 'Identifier') {
      const kind = exprAccessorKind(expr.name)
      recordAccessor(kind, () => {
        info.directAccessor = kind
      })
    } else if (
      (expr.kind === 'CallExpression' || expr.kind === 'OptionalCallExpression') &&
      expr.callee.kind === 'Identifier'
    ) {
      copyHookInfo(getHookReturnInfo(expr.callee.name, ctx, ops))
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
