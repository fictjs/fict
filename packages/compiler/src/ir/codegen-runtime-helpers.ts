import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES, RUNTIME_HELPERS } from '../constants'

import type { CodegenContext } from './codegen'

type RuntimeHelperKey = keyof typeof RUNTIME_ALIASES
type InlineHelperKey = 'forOf' | 'forIn'

const INLINE_HELPER_NAMES: Record<InlineHelperKey, string> = {
  forOf: '__fictForOf',
  forIn: '__fictForIn',
}

function hasRuntimeImport(ctx: CodegenContext, localName: string, helperKey: RuntimeHelperKey) {
  return ctx.moduleRuntimeImportMap?.get(localName) === RUNTIME_HELPERS[helperKey]
}

function allocatedNames(ctx: CodegenContext): Set<string> {
  return new Set([
    ...Array.from(ctx.runtimeHelperLocalNames?.values() ?? []),
    ...Array.from(ctx.inlineHelperLocalNames?.values() ?? []),
  ])
}

function isNameTaken(
  ctx: CodegenContext,
  name: string,
  helperKey?: RuntimeHelperKey | undefined,
): boolean {
  if (allocatedNames(ctx).has(name)) return true
  if (ctx.localDeclaredNames?.has(name) || ctx.shadowedNames?.has(name)) return true
  if (!ctx.moduleDeclaredNames?.has(name)) return false
  return helperKey ? !hasRuntimeImport(ctx, name, helperKey) : true
}

function allocateLocalName(
  ctx: CodegenContext,
  preferred: string,
  helperKey?: RuntimeHelperKey | undefined,
): string {
  if (!isNameTaken(ctx, preferred, helperKey)) return preferred
  let index = 1
  let candidate = `${preferred}_${index}`
  while (isNameTaken(ctx, candidate, helperKey)) {
    index += 1
    candidate = `${preferred}_${index}`
  }
  return candidate
}

export function runtimeHelperLocalName(ctx: CodegenContext, helperKey: RuntimeHelperKey): string {
  const existing = ctx.runtimeHelperLocalNames?.get(helperKey)
  if (existing) return existing

  const preferred = RUNTIME_ALIASES[helperKey]
  const localName = allocateLocalName(ctx, preferred, helperKey)
  ctx.runtimeHelperLocalNames = ctx.runtimeHelperLocalNames ?? new Map()
  ctx.runtimeHelperLocalNames.set(helperKey, localName)
  return localName
}

export function runtimeIdentifier(
  ctx: CodegenContext,
  helperKey: RuntimeHelperKey,
): BabelCore.types.Identifier {
  return ctx.t.identifier(runtimeHelperLocalName(ctx, helperKey))
}

export function inlineHelperName(ctx: CodegenContext, helperKey: InlineHelperKey): string {
  const existing = ctx.inlineHelperLocalNames?.get(helperKey)
  if (existing) return existing

  const localName = allocateLocalName(ctx, INLINE_HELPER_NAMES[helperKey])
  ctx.inlineHelperLocalNames = ctx.inlineHelperLocalNames ?? new Map()
  ctx.inlineHelperLocalNames.set(helperKey, localName)
  return localName
}

export function inlineHelperIdentifier(
  ctx: CodegenContext,
  helperKey: InlineHelperKey,
): BabelCore.types.Identifier {
  return ctx.t.identifier(inlineHelperName(ctx, helperKey))
}
