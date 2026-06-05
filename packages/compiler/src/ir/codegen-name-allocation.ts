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

function isReservedModuleName(ctx: CodegenContext, name: string): boolean {
  return (
    (ctx.moduleDeclaredNames?.has(name) ?? false) ||
    (ctx.moduleRuntimeNames?.has(name) ?? false) ||
    Array.from(ctx.runtimeHelperLocalNames?.values() ?? []).includes(name) ||
    Array.from(ctx.inlineHelperLocalNames?.values() ?? []).includes(name)
  )
}

function reserveModuleName(ctx: CodegenContext, candidate: string): boolean {
  if (isReservedModuleName(ctx, candidate)) return false
  ctx.moduleDeclaredNames ??= new Set()
  ctx.moduleDeclaredNames.add(candidate)
  return true
}

export function reserveGeneratedModuleName(ctx: CodegenContext, baseName: string): string {
  if (reserveModuleName(ctx, baseName)) return baseName

  let index = 1
  while (true) {
    const candidate = `${baseName}_${index++}`
    if (reserveModuleName(ctx, candidate)) return candidate
  }
}

export function reserveGeneratedIndexedModuleName(
  ctx: CodegenContext,
  prefix: string,
  startIndex = 0,
): { name: string; nextIndex: number } {
  let index = startIndex
  while (true) {
    const candidate = `${prefix}${index++}`
    if (reserveModuleName(ctx, candidate)) {
      return { name: candidate, nextIndex: index }
    }
  }
}
