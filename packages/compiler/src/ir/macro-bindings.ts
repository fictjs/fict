import type * as BabelCore from '@babel/core'

export type FictMacroKind = 'state' | 'effect' | 'memo'

const FICT_MACRO_KIND_EXTRA_KEY = '__fictMacroKind'

type MacroNode = BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression

export function markFictMacroCall(node: MacroNode, kind: FictMacroKind): void {
  const extra = (node.extra ?? {}) as Record<string, unknown>
  extra[FICT_MACRO_KIND_EXTRA_KEY] = kind
  node.extra = extra
}

export function getFictMacroKind(
  node: BabelCore.types.Node | null | undefined,
): FictMacroKind | null {
  const extra = (node?.extra ?? {}) as Record<string, unknown>
  const kind = extra[FICT_MACRO_KIND_EXTRA_KEY]
  return kind === 'state' || kind === 'effect' || kind === 'memo' ? kind : null
}
