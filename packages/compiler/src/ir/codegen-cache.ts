import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { runtimeIdentifier } from './codegen-runtime-helpers'

function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return ctx.t.identifier(`__${prefix}_${ctx.tempCounter++}`)
}

/**
 * Rule L: Enable getter caching for a sync function scope.
 * Returns cache declarations that should be emitted before generated statements.
 */
export function withGetterCache<T>(
  ctx: CodegenContext,
  fn: () => T,
  disabledGetters?: Iterable<string>,
): { result: T; cacheDeclarations: BabelCore.types.Statement[] } {
  if (ctx.options?.getterCache === false) {
    return { result: fn(), cacheDeclarations: [] }
  }

  const prevCache = ctx.getterCache
  const prevDeclarations = ctx.getterCacheDeclarations
  const prevEnabled = ctx.getterCacheEnabled
  const prevInvalidated = ctx.getterCacheInvalidated

  ctx.getterCache = new Map()
  ctx.getterCacheDeclarations = new Map()
  ctx.getterCacheInvalidated = new Set(disabledGetters)
  ctx.getterCacheEnabled = true

  const result = fn()

  const cacheDeclarations: BabelCore.types.Statement[] = []
  if (ctx.getterCacheDeclarations && ctx.getterCacheDeclarations.size > 0) {
    for (const [varName, initExpr] of ctx.getterCacheDeclarations) {
      cacheDeclarations.push(
        ctx.t.variableDeclaration('let', [
          ctx.t.variableDeclarator(ctx.t.identifier(varName), initExpr),
        ]),
      )
    }
  }

  ctx.getterCache = prevCache
  ctx.getterCacheDeclarations = prevDeclarations
  ctx.getterCacheInvalidated = prevInvalidated
  ctx.getterCacheEnabled = prevEnabled

  return { result, cacheDeclarations }
}

/**
 * Get or create a cached getter expression.
 * Rule L: only cache after the same getter is read multiple times in one sync scope.
 */
export function getCachedGetterExpression(
  ctx: CodegenContext,
  getterName: string,
  callExpr: BabelCore.types.Expression,
): BabelCore.types.Expression {
  if (
    !ctx.getterCacheEnabled ||
    !ctx.getterCache ||
    !ctx.getterCacheDeclarations ||
    ctx.getterCacheInvalidated?.has(getterName)
  ) {
    return callExpr
  }

  if (ctx.memoVars?.has(getterName)) {
    return callExpr
  }

  const existingEntry = ctx.getterCache.get(getterName)

  if (existingEntry === undefined) {
    ctx.getterCache.set(getterName, '')
    return callExpr
  }

  if (existingEntry === '') {
    const cacheVar = `__cached_${getterName}_${ctx.tempCounter++}`
    ctx.getterCache.set(getterName, cacheVar)
    ctx.getterCacheDeclarations.set(cacheVar, null)
    return ctx.t.assignmentExpression('=', ctx.t.identifier(cacheVar), callExpr)
  }

  return ctx.t.identifier(existingEntry)
}

export function invalidateCachedGetter(ctx: CodegenContext, getterName: string): void {
  if (!ctx.getterCacheEnabled) return
  ctx.getterCache?.delete(getterName)
  ctx.getterCacheInvalidated?.add(getterName)
}

export function clearCachedGetters(ctx: CodegenContext): void {
  if (!ctx.getterCacheEnabled) return
  ctx.getterCache?.clear()
}

/**
 * Get or create a hoisted template identifier for the given HTML.
 * In list render context, templates are hoisted to avoid repeated HTML parsing.
 */
export function getOrCreateHoistedTemplate(
  html: string,
  ctx: CodegenContext,
  isSVG?: boolean,
  isMathML?: boolean,
): BabelCore.types.Identifier | null {
  if (!ctx.inListRender || !ctx.hoistedTemplates || !ctx.hoistedTemplateStatements) {
    return null
  }

  const cacheKey = isSVG ? `svg:${html}` : isMathML ? `mathml:${html}` : html
  const existing = ctx.hoistedTemplates.get(cacheKey)
  if (existing) {
    return existing
  }

  const { t } = ctx
  ctx.helpersUsed.add('template')
  const tmplId = genTemp(ctx, 'htmpl')
  ctx.hoistedTemplates.set(cacheKey, tmplId)

  const templateArgs: BabelCore.types.Expression[] = [t.stringLiteral(html)]
  if (isSVG || isMathML) {
    templateArgs.push(t.identifier('undefined'))
    templateArgs.push(isSVG ? t.booleanLiteral(true) : t.identifier('undefined'))
    if (isMathML) {
      templateArgs.push(t.booleanLiteral(true))
    }
  }

  ctx.hoistedTemplateStatements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        tmplId,
        t.callExpression(runtimeIdentifier(ctx, 'template'), templateArgs),
      ),
    ]),
  )

  return tmplId
}
