import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'
import { isListKeyParamIdentifier } from './codegen-list-keys'

const DOM_PROPERTY_NAMES = new Set([
  'value',
  'checked',
  'selected',
  'disabled',
  'readOnly',
  'multiple',
  'muted',
  'innerHTML',
  'innerText',
  'textContent',
  'defaultValue',
  'defaultChecked',
  'defaultSelected',
  'defaultMuted',
])

const DOM_TEMPLATE_PROPERTY_NAMES = new Set([
  'innerHTML',
  'innerText',
  'textContent',
  'defaultValue',
  'defaultChecked',
  'defaultSelected',
  'defaultMuted',
])

export function isStaticDelegatedDataAst(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
): boolean {
  const { t } = ctx
  if (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr) ||
    t.isBigIntLiteral(expr)
  ) {
    return true
  }
  return t.isIdentifier(expr) && isListKeyParamIdentifier(expr.name, ctx)
}

export function normalizeAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
}

export function isDOMProperty(name: string): boolean {
  return DOM_PROPERTY_NAMES.has(name)
}

export function isDOMTemplateProperty(name: string): boolean {
  return DOM_TEMPLATE_PROPERTY_NAMES.has(name)
}
