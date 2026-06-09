import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from '../constants'
import { DiagnosticCode, reportDiagnostic } from '../validation'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'
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

export interface PropsChild {
  value: BabelCore.types.Expression
  source?: Expression | undefined
}

function isMarkedLazySourceExpression(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
): boolean {
  const { t } = ctx
  return (
    t.isCallExpression(expr) &&
    t.isIdentifier(expr.callee) &&
    (expr.callee.name === RUNTIME_ALIASES.propGetter ||
      expr.callee.name === ctx.runtimeHelperLocalNames?.get('propGetter'))
  )
}

export function buildPropsPlan(
  attributes: JSXAttribute[],
  children: PropsChild[],
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
    const toPropObjectProperty = (name: string, value: BabelCore.types.Expression) =>
      name === '__proto__'
        ? t.objectProperty(t.stringLiteral(name), value, true)
        : t.objectProperty(toPropKey(name), value)
    const isAccessorName = (name: string): boolean =>
      (ctx.memoVars?.has(name) ?? false) ||
      (ctx.signalVars?.has(name) ?? false) ||
      (ctx.aliasVars?.has(name) ?? false)

    const withPropsContextDisabled = <T>(disabled: boolean, fn: () => T): T => {
      if (!disabled) return fn()
      const prevPropsCtx = ctx.inPropsContext
      ctx.inPropsContext = false
      try {
        return fn()
      } finally {
        ctx.inPropsContext = prevPropsCtx
      }
    }

    const wrapNonReactiveFunction = (
      expr: BabelCore.types.Expression,
    ): BabelCore.types.Expression => {
      if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
        ctx.helpersUsed.add('nonReactive')
        return t.callExpression(runtimeIdentifier(ctx, 'nonReactive'), [expr])
      }
      return expr
    }

    const markLazySource = (getter: BabelCore.types.Expression): BabelCore.types.Expression => {
      ctx.helpersUsed.add('propGetter')
      return t.callExpression(runtimeIdentifier(ctx, 'propGetter'), [getter])
    }

    const isMarkedLazySource = (expr: BabelCore.types.Expression): boolean =>
      isMarkedLazySourceExpression(expr, ctx)

    const wrapAccessorSource = (node: BabelCore.types.Expression): BabelCore.types.Expression => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.arguments.length === 0) {
        const baseName = helpers.deSSAVarName(node.callee.name)
        if (isAccessorName(baseName)) {
          // Keep accessor lazy so mergeProps can re-evaluate per access
          return markLazySource(t.arrowFunctionExpression([], node))
        }
      }
      if (
        t.isOptionalCallExpression(node) &&
        t.isIdentifier(node.callee) &&
        node.arguments.length === 0
      ) {
        const baseName = helpers.deSSAVarName(node.callee.name)
        if (isAccessorName(baseName)) {
          return markLazySource(t.arrowFunctionExpression([], node))
        }
      }
      if (t.isIdentifier(node)) {
        const baseName = helpers.deSSAVarName(node.name)
        if (isAccessorName(baseName)) {
          return markLazySource(
            t.arrowFunctionExpression([], t.callExpression(t.identifier(baseName), [])),
          )
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

    const isRuntimeKeyed = (): boolean =>
      !ctx.shadowedNames?.has(RUNTIME_ALIASES.keyed) &&
      !ctx.localDeclaredNames?.has(RUNTIME_ALIASES.keyed) &&
      (!ctx.moduleDeclaredNames?.has(RUNTIME_ALIASES.keyed) ||
        (ctx.moduleRuntimeNames?.has(RUNTIME_ALIASES.keyed) ?? false))

    const isKeyedCall = (expr: Expression): boolean =>
      expr.kind === 'CallExpression' &&
      expr.callee.kind === 'Identifier' &&
      expr.callee.name === RUNTIME_ALIASES.keyed &&
      isRuntimeKeyed()

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
          obj.kind === 'ImportExpression' ||
          obj.kind === 'NewExpression' ||
          obj.kind === 'YieldExpression' ||
          obj.kind === 'TemplateLiteral' ||
          obj.kind === 'TaggedTemplateExpression' ||
          obj.kind === 'ClassExpression'
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
      if (isAccessorSource(expr)) return false
      if (
        expr.kind === 'CallExpression' ||
        expr.kind === 'OptionalCallExpression' ||
        expr.kind === 'ConditionalExpression' ||
        expr.kind === 'LogicalExpression' ||
        expr.kind === 'SequenceExpression' ||
        expr.kind === 'AssignmentExpression' ||
        expr.kind === 'UpdateExpression' ||
        expr.kind === 'AwaitExpression' ||
        expr.kind === 'ImportExpression' ||
        expr.kind === 'NewExpression' ||
        expr.kind === 'YieldExpression' ||
        expr.kind === 'TemplateLiteral' ||
        expr.kind === 'TaggedTemplateExpression' ||
        expr.kind === 'ClassExpression'
      ) {
        return true
      }
      if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
        return isDynamicMemberSpread(expr)
      }
      if (expr.kind === 'ObjectExpression') {
        return expr.properties.some(p => p.kind === 'SpreadElement')
      }
      if (expr.kind === 'ArrayExpression') {
        return expr.elements.some(element => element?.kind === 'SpreadElement')
      }
      return false
    }

    const objectSpreadHasTrackedComputedKey = (expr: Expression): boolean =>
      expr.kind === 'ObjectExpression' &&
      (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
      expr.properties.some(
        p => p.kind === 'Property' && !!p.computed && helpers.expressionUsesTracked(p.key, ctx),
      )

    const getStaticPropertyName = (property: Expression, computed: boolean): string | null => {
      if (!computed && property.kind === 'Identifier') return property.name
      if (property.kind === 'Literal') {
        if (typeof property.value === 'string' || typeof property.value === 'number') {
          return String(property.value)
        }
      }
      return null
    }
    const isNamespaceStoreMember = (expr: Expression): boolean => {
      if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') {
        return false
      }
      if (expr.object.kind === 'Identifier') {
        const nsMeta = ctx.importedNamespaces?.get(helpers.deSSAVarName(expr.object.name))
        const propName = getStaticPropertyName(expr.property as Expression, expr.computed)
        if (nsMeta && propName && nsMeta.exports[propName] === 'store') {
          return true
        }
      }
      return isNamespaceStoreExpression(expr.object as Expression)
    }
    const isNamespaceStoreExpression = (expr: Expression): boolean =>
      expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression'
        ? isNamespaceStoreMember(expr)
        : false
    const isStoreExpression = (expr: Expression): boolean => {
      if (expr.kind === 'Identifier') {
        return ctx.storeVars?.has(helpers.deSSAVarName(expr.name)) ?? false
      }
      if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
        return isNamespaceStoreMember(expr)
      }
      return false
    }

    const isDynamicStoreMember = (expr: Expression): boolean => {
      if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return false
      if (!expr.computed) return false
      if (
        expr.property.kind === 'Literal' &&
        (typeof expr.property.value === 'string' || typeof expr.property.value === 'number')
      ) {
        return false
      }
      return isStoreExpression(expr.object as Expression)
    }

    const getKeyedCandidate = (expr: Expression): { base: Expression; key: Expression } | null => {
      if (expr.kind !== 'MemberExpression') return null
      if (!expr.computed || expr.optional) return null
      if (
        expr.property.kind === 'Literal' &&
        (typeof expr.property.value === 'string' || typeof expr.property.value === 'number')
      ) {
        return null
      }
      return { base: expr.object as Expression, key: expr.property as Expression }
    }

    const lowerPropValue = (value: Expression): BabelCore.types.Expression => {
      const isFunctionLike = value.kind === 'ArrowFunction' || value.kind === 'FunctionExpression'
      const isCompositeValue = value.kind === 'ObjectExpression' || value.kind === 'ArrayExpression'
      const baseIdent = value.kind === 'Identifier' ? helpers.deSSAVarName(value.name) : undefined
      const keyedCandidate = getKeyedCandidate(value)
      const keyedBaseIdent =
        keyedCandidate && keyedCandidate.base.kind === 'Identifier'
          ? helpers.deSSAVarName(keyedCandidate.base.name)
          : undefined
      const isAccessorBase =
        baseIdent &&
        ((ctx.memoVars?.has(baseIdent) ?? false) ||
          (ctx.signalVars?.has(baseIdent) ?? false) ||
          (ctx.aliasVars?.has(baseIdent) ?? false))
      const isStoreBase = baseIdent ? (ctx.storeVars?.has(baseIdent) ?? false) : false
      const alreadyGetter =
        isFunctionLike ||
        isKeyedCall(value) ||
        (baseIdent
          ? isStoreBase ||
            (ctx.memoVars?.has(baseIdent) ?? false) ||
            (ctx.aliasVars?.has(baseIdent) ?? false)
          : false)
      const usesTracked = helpers.expressionUsesTracked(value, ctx) && !alreadyGetter
      const lowered = withPropsContextDisabled(
        isFunctionLike || (usesTracked && isCompositeValue),
        () => helpers.lowerDomExpression(value, ctx),
      )
      const trackedExpr = usesTracked
        ? (withPropsContextDisabled(usesTracked && isCompositeValue, () =>
            helpers.lowerTrackedExpression(value, ctx),
          ) as BabelCore.types.Expression)
        : null
      const useMemoProp =
        usesTracked &&
        trackedExpr &&
        t.isExpression(trackedExpr) &&
        !t.isIdentifier(trackedExpr) &&
        !t.isMemberExpression(trackedExpr) &&
        !t.isLiteral(trackedExpr)
      const forceMemoProp = usesTracked && isDynamicStoreMember(value)
      const shouldMemoProp = useMemoProp || forceMemoProp
      const canKeyed =
        usesTracked &&
        keyedCandidate &&
        keyedBaseIdent &&
        !(ctx.signalVars?.has(keyedBaseIdent) ?? false) &&
        !(ctx.memoVars?.has(keyedBaseIdent) ?? false) &&
        !(ctx.aliasVars?.has(keyedBaseIdent) ?? false) &&
        !(ctx.functionVars?.has(keyedBaseIdent) ?? false)
      const valueExpr =
        !isFunctionLike && isAccessorBase && baseIdent
          ? (() => {
              // Preserve accessor laziness for signals/memos passed as props
              ctx.helpersUsed.add('propGetter')
              return t.callExpression(runtimeIdentifier(ctx, 'propGetter'), [
                t.arrowFunctionExpression([], t.callExpression(t.identifier(baseIdent), [])),
              ])
            })()
          : usesTracked && t.isExpression(lowered)
            ? (() => {
                if (canKeyed && keyedCandidate) {
                  ctx.helpersUsed.add('keyed')
                  const keyExpr = helpers.lowerDomExpression(keyedCandidate.key, ctx)
                  return t.callExpression(runtimeIdentifier(ctx, 'keyed'), [
                    t.identifier(keyedBaseIdent!),
                    t.arrowFunctionExpression([], keyExpr),
                  ])
                }
                if (shouldMemoProp) {
                  ctx.helpersUsed.add('prop')
                  return t.callExpression(runtimeIdentifier(ctx, 'prop'), [
                    t.arrowFunctionExpression([], trackedExpr ?? lowered),
                  ])
                }
                ctx.helpersUsed.add('propGetter')
                return t.callExpression(runtimeIdentifier(ctx, 'propGetter'), [
                  t.arrowFunctionExpression([], trackedExpr ?? lowered),
                ])
              })()
            : lowered
      return isFunctionLike ? wrapNonReactiveFunction(valueExpr) : valueExpr
    }

    const pushArrayLiteralSpread = (expr: Expression): boolean => {
      if (expr.kind !== 'ArrayExpression') return false
      if (expr.elements.some(element => element?.kind === 'SpreadElement')) return false

      flags.needsMergeProps = true
      segments.push({
        kind: 'object',
        properties: expr.elements.flatMap((element, index) =>
          element ? [toPropObjectProperty(String(index), lowerPropValue(element))] : [],
        ),
      })
      return true
    }

    const flushBucket = () => {
      if (bucket.length === 0) return
      segments.push({ kind: 'object', properties: bucket })
      bucket = []
    }

    const pushSpread = (expr: BabelCore.types.Expression) => {
      flags.needsMergeProps = true
      if (isMarkedLazySource(expr)) {
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
        if (pushArrayLiteralSpread(attr.spreadExpr)) {
          continue
        }
        const needsLazyObjectSource =
          objectSpreadHasTrackedComputedKey(attr.spreadExpr) ||
          (isDynamicPropsSpread(attr.spreadExpr) &&
            (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
            helpers.expressionUsesTracked(attr.spreadExpr, ctx))
        let spreadExpr = helpers.lowerDomExpression(attr.spreadExpr, ctx)
        spreadExpr = needsLazyObjectSource
          ? markLazySource(t.arrowFunctionExpression([], spreadExpr))
          : wrapAccessorSource(spreadExpr)
        pushSpread(spreadExpr)
        continue
      }

      if (attr.value) {
        bucket.push(toPropObjectProperty(attr.name, lowerPropValue(attr.value)))
        continue
      }

      // Boolean attribute
      bucket.push(toPropObjectProperty(attr.name, t.booleanLiteral(true)))
    }

    const childrenUseTracked = children.some(
      child =>
        child.source &&
        !(t.isArrowFunctionExpression(child.value) || t.isFunctionExpression(child.value)) &&
        helpers.expressionUsesTracked(child.source, ctx),
    )
    const childValues = children.map(child => wrapNonReactiveFunction(child.value))
    if (children.length === 1 && childValues[0]) {
      const childValue = childrenUseTracked
        ? (() => {
            ctx.helpersUsed.add('prop')
            return t.callExpression(runtimeIdentifier(ctx, 'prop'), [
              t.arrowFunctionExpression([], childValues[0]!),
            ])
          })()
        : childValues[0]
      bucket.push(t.objectProperty(t.identifier('children'), childValue))
    } else if (children.length > 1) {
      const childrenArray = t.arrayExpression(childValues)
      const childrenValue = childrenUseTracked
        ? (() => {
            ctx.helpersUsed.add('prop')
            return t.callExpression(runtimeIdentifier(ctx, 'prop'), [
              t.arrowFunctionExpression([], childrenArray),
            ])
          })()
        : childrenArray
      bucket.push(t.objectProperty(t.identifier('children'), childrenValue))
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
  const snapshotSegments = (): BabelCore.types.ObjectExpression => {
    const properties: (BabelCore.types.ObjectProperty | BabelCore.types.SpreadElement)[] = []
    for (const segment of plan.segments) {
      if (segment.kind === 'object') {
        properties.push(...segment.properties)
        continue
      }
      properties.push(t.spreadElement(segment.expr))
    }
    return t.objectExpression(properties)
  }

  const args: BabelCore.types.Expression[] = []

  for (const segment of plan.segments) {
    if (segment.kind === 'object') {
      if (segment.properties.length === 0) continue
      args.push(t.objectExpression(segment.properties))
      continue
    }
    args.push(
      isMarkedLazySourceExpression(segment.expr, ctx)
        ? segment.expr
        : t.objectExpression([t.spreadElement(segment.expr)]),
    )
  }

  if (args.length === 0) {
    return plan.flags.needsMergeProps ? t.objectExpression([]) : null
  }

  if (!plan.flags.needsMergeProps) {
    return args[0] ?? null
  }

  if (!plan.flags.hasLazySource) {
    return snapshotSegments()
  }

  ctx.helpersUsed.add('mergeProps')
  return t.callExpression(runtimeIdentifier(ctx, 'mergeProps'), args)
}

export function buildPropsExpression(
  attributes: JSXAttribute[],
  children: PropsChild[],
  ctx: CodegenContext,
  helpers: PropsPlanHelpers,
): BabelCore.types.Expression | null {
  const plan = buildPropsPlan(attributes, children, ctx, helpers)
  if (!plan) return null
  return lowerPropsPlan(plan, ctx)
}
