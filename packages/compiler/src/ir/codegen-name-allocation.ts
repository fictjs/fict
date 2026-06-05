import type { CodegenContext } from './codegen'

function isReservedName(ctx: CodegenContext, name: string): boolean {
  return (
    (ctx.generatedTempNames?.has(name) ?? false) ||
    (ctx.localDeclaredNames?.has(name) ?? false) ||
    (ctx.shadowedNames?.has(name) ?? false) ||
    (ctx.moduleDeclaredNames?.has(name) ?? false) ||
    (ctx.moduleRuntimeNames?.has(name) ?? false) ||
    Array.from(ctx.runtimeHelperLocalNames?.values() ?? []).includes(name) ||
    Array.from(ctx.inlineHelperLocalNames?.values() ?? []).includes(name)
  )
}

export function reserveGeneratedName(ctx: CodegenContext, prefix = 'tmp'): string {
  ctx.generatedTempNames ??= new Set()

  while (true) {
    const candidate = `__${prefix}_${ctx.tempCounter++}`
    if (isReservedName(ctx, candidate)) continue
    ctx.generatedTempNames.add(candidate)
    return candidate
  }
}

export function createGeneratedIdentifier(ctx: CodegenContext, prefix = 'tmp') {
  return ctx.t.identifier(reserveGeneratedName(ctx, prefix))
}
