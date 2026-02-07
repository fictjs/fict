import { pathToFileURL } from 'node:url'

import type * as BabelCore from '@babel/core'

import type { CodegenContext } from './codegen'

/**
 * Rename identifiers in a Babel AST expression according to a rename map.
 * Used to rewrite references to hoisted function dependencies in resumable handlers.
 */
export function renameIdentifiersInExpr(
  expr: BabelCore.types.Expression,
  renames: Map<string, string>,
): BabelCore.types.Expression {
  const cloned = JSON.parse(JSON.stringify(expr)) as BabelCore.types.Expression

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>

    if (n.type === 'Identifier' && typeof n.name === 'string') {
      const newName = renames.get(n.name)
      if (newName) {
        n.name = newName
      }
    }

    for (const key of Object.keys(n)) {
      if (
        key === 'loc' ||
        key === 'start' ||
        key === 'end' ||
        key === 'extra' ||
        key === 'comments' ||
        key === 'leadingComments' ||
        key === 'trailingComments'
      ) {
        continue
      }
      const value = n[key]
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item)
        }
      } else if (value && typeof value === 'object') {
        visit(value)
      }
    }
  }

  visit(cloned)
  return cloned
}

/**
 * Generate module URL expression for QRL generation.
 * Uses filename from compiler options when available; falls back to import.meta.url.
 */
export function genModuleUrlExpr(ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx
  const filename = ctx.options?.filename
  if (filename) {
    let fileUrl: string
    if (filename.startsWith('file://')) {
      fileUrl = filename
    } else {
      fileUrl = pathToFileURL(filename).href
    }
    return t.stringLiteral(fileUrl)
  }
  return t.memberExpression(
    t.metaProperty(t.identifier('import'), t.identifier('meta')),
    t.identifier('url'),
  )
}
