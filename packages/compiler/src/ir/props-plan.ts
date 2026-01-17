import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'
import { DiagnosticCode, reportDiagnostic } from '../validation'

import type { CodegenContext } from './codegen'
import type { Expression, JSXAttribute } from './hir'

export type PropsSegment =
  | { kind: 'object'; properties: BabelCore.types.ObjectProperty[] }
  | { kind: 'spread'; expr: BabelCore.types.Expression }

export interface PropsPlan {
  segments: PropsSegment[]
  flags: {
    needsMergeProps: boolean
    hasLazySource: boolean
  }
}

export interface PropsPlanHelpers {
  lowerDomExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
  lowerTrackedExpression: (expr: Expression, ctx: CodegenContext) => BabelCore.types.Expression
  expressionUsesTracked: (expr: Expression, ctx: CodegenContext) => boolean
  deSSAVarName: (name: string) => string
}

export function buildPropsPlan(
  attributes: JSXAttribute[],
  children: BabelCore.types.Expression[],
  ctx: CodegenContext,
  helpers: PropsPlanHelpers,
): PropsPlan | null {
  const { t } = ctx
  const prevPropsContext = ctx.inPropsContext
  ctx.inPropsContext = true

  try {
    if (attributes.length === 0 && children.length === 0) return null

    const segments: PropsSegment[] = []
    const flags = {
      needsMergeProps: false,
      hasLazySource: false,
    }
    let bucket: BabelCore.types.ObjectProperty[] = []

    const toPropKey = (name: string) =>
      /^[a-zA-Z_$][\w$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name)
    const isAccessorName = (name: string): boolean =>
      (ctx.memoVars?.has(name) ?? false) ||
      (ctx.signalVars?.has(name) ?? false) ||
      (ctx.aliasVars?.has(name) ?? false)

    const isZeroArgFunction = (expr: BabelCore.types.Expression): boolean =>
      (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) &&
      expr.params.length === 0

    const wrapAccessorSource = (node: BabelCore.types.Expression): BabelCore.types.Expression => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.arguments.length === 0) {
        const baseName = helpers.deSSAVarName(node.callee.name)
        if (isAccessorName(baseName)) {
          // Keep accessor lazy so mergeProps can re-evaluate per access
          return t.arrowFunctionExpression([], node)
        }
      }
      if (t.isIdentifier(node)) {
        const baseName = helpers.deSSAVarName(node.name)
        if (isAccessorName(baseName)) {
          return t.arrowFunctionExpression([], t.callExpression(t.identifier(baseName), []))
        }
      }
      return node
    }

    const isAccessorSource = (expr: Expression): boolean => {
      if (expr.kind === 'Identifier') {
        return isAccessorName(helpers.deSSAVarName(expr.name))
      }
      if (expr.kind === 'CallExpression' || expr.kind === 'OptionalCallExpression') {
        if (expr.callee.kind === 'Identifier' && expr.arguments.length === 0) {
          return isAccessorName(helpers.deSSAVarName(expr.callee.name))
        }
      }
      return false
    }

    const isRuntimeMergeProps = (): boolean =>
      !ctx.shadowedNames?.has(RUNTIME_ALIASES.mergeProps) &&
      !ctx.localDeclaredNames?.has(RUNTIME_ALIASES.mergeProps) &&
      (!ctx.moduleDeclaredNames?.has(RUNTIME_ALIASES.mergeProps) ||
        (ctx.moduleRuntimeNames?.has(RUNTIME_ALIASES.mergeProps) ?? false))

    const isMergePropsCall = (expr: Expression): boolean =>
      expr.kind === 'CallExpression' &&
      expr.callee.kind === 'Identifier' &&
      expr.callee.name === RUNTIME_ALIASES.mergeProps &&
      isRuntimeMergeProps()

    const isDynamicMemberSpread = (expr: Expression): boolean => {
      if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return false
      if (expr.computed) return true
      if (expr.kind === 'OptionalMemberExpression' && expr.optional) return true

      let current: Expression = expr
      while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
        const obj: Expression = current.object
        if (
          obj.kind === 'CallExpression' ||
          obj.kind === 'OptionalCallExpression' ||
          obj.kind === 'ConditionalExpression' ||
          obj.kind === 'LogicalExpression' ||
          obj.kind === 'SequenceExpression' ||
          obj.kind === 'AssignmentExpression' ||
          obj.kind === 'UpdateExpression' ||
          obj.kind === 'AwaitExpression' ||
          obj.kind === 'NewExpression' ||
          obj.kind === 'YieldExpression'
        ) {
          return true
        }
        if (obj.kind === 'OptionalMemberExpression' && obj.optional) {
          return true
        }
        if (obj.kind !== 'MemberExpression' && obj.kind !== 'OptionalMemberExpression') {
          return obj.kind !== 'Identifier'
        }
        current = obj
      }
      return false
    }

    const isDynamicPropsSpread = (expr: Expression): boolean => {
      if (isAccessorSource(expr) || isMergePropsCall(expr)) return false
      if (
        expr.kind === 'CallExpression' ||
        expr.kind === 'OptionalCallExpression' ||
        expr.kind === 'ConditionalExpression' ||
        expr.kind === 'LogicalExpression' ||
        expr.kind === 'SequenceExpression' ||
        expr.kind === 'AssignmentExpression' ||
        expr.kind === 'UpdateExpression' ||
        expr.kind === 'AwaitExpression' ||
        expr.kind === 'NewExpression' ||
        expr.kind === 'YieldExpression'
      ) {
        return true
      }
      if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
        return isDynamicMemberSpread(expr)
      }
      if (expr.kind === 'ObjectExpression') {
        return expr.properties.some(p => p.kind === 'SpreadElement')
      }
      return false
    }

    const flushBucket = () => {
      if (bucket.length === 0) return
      segments.push({ kind: 'object', properties: bucket })
      bucket = []
    }

    const pushSpread = (expr: BabelCore.types.Expression) => {
      flags.needsMergeProps = true
      if (isZeroArgFunction(expr)) {
        flags.hasLazySource = true
      }
      segments.push({ kind: 'spread', expr })
    }

    for (const attr of attributes) {
      if (attr.isSpread && attr.spreadExpr) {
        flushBucket()
        if (isDynamicPropsSpread(attr.spreadExpr)) {
          reportDiagnostic(ctx, DiagnosticCode.FICT_P005, attr.spreadExpr)
        }
        let spreadExpr = helpers.lowerDomExpression(attr.spreadExpr, ctx)
        if (
          t.isCallExpression(spreadExpr) &&
          t.isIdentifier(spreadExpr.callee) &&
          spreadExpr.callee.name === RUNTIME_ALIASES.mergeProps &&
          isRuntimeMergeProps()
        ) {
          const callExpr = spreadExpr
          const rewrittenArgs = callExpr.arguments.map(arg =>
            t.isExpression(arg) ? wrapAccessorSource(arg) : arg,
          )
          if (rewrittenArgs.some((arg, idx) => arg !== callExpr.arguments[idx])) {
            spreadExpr = t.callExpression(
              callExpr.callee,
              rewrittenArgs as (
                | BabelCore.types.Expression
                | BabelCore.types.SpreadElement
                | BabelCore.types.ArgumentPlaceholder
              )[],
            )
          }
          const flattenArgs: BabelCore.types.Expression[] = []
          let canFlatten = true
          for (const arg of rewrittenArgs) {
            if (t.isExpression(arg)) {
              flattenArgs.push(arg)
            } else {
              canFlatten = false
              break
            }
          }
          if (canFlatten) {
            for (const arg of flattenArgs) {
              pushSpread(arg)
            }
            continue
          }
        }
        spreadExpr = wrapAccessorSource(spreadExpr)
        pushSpread(spreadExpr)
        continue
      }

      if (attr.value) {
        const isFunctionLike =
          attr.value.kind === 'ArrowFunction' || attr.value.kind === 'FunctionExpression'
        const prevPropsCtx: boolean | undefined = ctx.inPropsContext
        // Avoid treating function bodies as props context to prevent wrapping internal values
        if (isFunctionLike) {
          ctx.inPropsContext = false
        }
        const lowered = helpers.lowerDomExpression(attr.value, ctx)
        if (isFunctionLike) {
          ctx.inPropsContext = prevPropsCtx
        }
        const baseIdent =
          attr.value.kind === 'Identifier' ? helpers.deSSAVarName(attr.value.name) : undefined
        const isAccessorBase =
          baseIdent &&
          ((ctx.memoVars?.has(baseIdent) ?? false) ||
            (ctx.signalVars?.has(baseIdent) ?? false) ||
            (ctx.aliasVars?.has(baseIdent) ?? false))
        const isStoreBase = baseIdent ? (ctx.storeVars?.has(baseIdent) ?? false) : false
        const alreadyGetter =
          isFunctionLike ||
          (baseIdent
            ? isStoreBase ||
              (ctx.memoVars?.has(baseIdent) ?? false) ||
              (ctx.aliasVars?.has(baseIdent) ?? false)
            : false)
        const usesTracked =
          (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
          helpers.expressionUsesTracked(attr.value, ctx) &&
          !alreadyGetter
        const trackedExpr = usesTracked
          ? (helpers.lowerTrackedExpression(
              attr.value as Expression,
              ctx,
            ) as BabelCore.types.Expression)
          : null
        const useMemoProp =
          usesTracked &&
          trackedExpr &&
          t.isExpression(trackedExpr) &&
          !t.isIdentifier(trackedExpr) &&
          !t.isMemberExpression(trackedExpr) &&
          !t.isLiteral(trackedExpr)
        const valueExpr =
          !isFunctionLike && isAccessorBase && baseIdent
            ? (() => {
                // Preserve accessor laziness for signals/memos passed as props
                ctx.helpersUsed.add('propGetter')
                return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                  t.arrowFunctionExpression([], t.callExpression(t.identifier(baseIdent), [])),
                ])
              })()
            : usesTracked && t.isExpression(lowered)
              ? (() => {
                  if (useMemoProp) {
                    ctx.helpersUsed.add('prop')
                    return t.callExpression(t.identifier(RUNTIME_ALIASES.prop), [
                      t.arrowFunctionExpression([], trackedExpr ?? lowered),
                    ])
                  }
                  ctx.helpersUsed.add('propGetter')
                  return t.callExpression(t.identifier(RUNTIME_ALIASES.propGetter), [
                    t.arrowFunctionExpression([], trackedExpr ?? lowered),
                  ])
                })()
              : lowered
        bucket.push(t.objectProperty(toPropKey(attr.name), valueExpr))
        continue
      }

      // Boolean attribute
      bucket.push(t.objectProperty(toPropKey(attr.name), t.booleanLiteral(true)))
    }

    if (children.length === 1 && children[0]) {
      bucket.push(t.objectProperty(t.identifier('children'), children[0]))
    } else if (children.length > 1) {
      bucket.push(t.objectProperty(t.identifier('children'), t.arrayExpression(children)))
    }

    flushBucket()

    if (segments.length === 0) return null

    return { segments, flags }
  } finally {
    ctx.inPropsContext = prevPropsContext
  }
}

export function lowerPropsPlan(
  plan: PropsPlan,
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  const { t } = ctx
  const args: BabelCore.types.Expression[] = []

  for (const segment of plan.segments) {
    if (segment.kind === 'object') {
      if (segment.properties.length === 0) continue
      args.push(t.objectExpression(segment.properties))
      continue
    }
    args.push(segment.expr)
  }

  if (args.length === 0) return null

  if (!plan.flags.needsMergeProps) {
    return args[0] ?? null
  }

  if (args.length === 1 && !plan.flags.hasLazySource) {
    return args[0]
  }

  ctx.helpersUsed.add('mergeProps')
  return t.callExpression(t.identifier(RUNTIME_ALIASES.mergeProps), args)
}

export function buildPropsExpression(
  attributes: JSXAttribute[],
  children: BabelCore.types.Expression[],
  ctx: CodegenContext,
  helpers: PropsPlanHelpers,
): BabelCore.types.Expression | null {
  const plan = buildPropsPlan(attributes, children, ctx, helpers)
  if (!plan) return null
  return lowerPropsPlan(plan, ctx)
}
