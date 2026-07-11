import { pathToFileURL } from 'node:url'

import type * as BabelCore from '@babel/core'
import traverseModule from '@babel/traverse'

import type { CodegenContext } from './codegen'

/**
 * Rename identifiers in a Babel AST expression according to a rename map.
 * Used to rewrite references to hoisted function dependencies in resumable handlers.
 */
export function renameIdentifiersInExpr(
  expr: BabelCore.types.Expression,
  renames: Map<string, string>,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const cloned = t.cloneNode(expr, true)
  const file = t.file(t.program([t.expressionStatement(cloned)]))

  traverse(file, {
    Identifier(path) {
      const oldName = path.node.name
      const nextName = renames.get(oldName)
      if (!nextName) return

      if (!path.isReferencedIdentifier()) return

      // Avoid renaming locally-bound identifiers inside nested scopes.
      const binding = path.scope.getBinding(oldName)
      if (binding && binding.scope !== path.scope.getProgramParent()) return

      // Preserve shorthand key names: { helper } -> { helper: __fict_fn_helper_0 }
      if (
        path.parentPath.isObjectProperty() &&
        path.parentPath.node.shorthand &&
        path.parentPath.node.value === path.node &&
        t.isIdentifier(path.parentPath.node.key)
      ) {
        path.parentPath.node.shorthand = false
        path.parentPath.node.value = t.identifier(nextName)
        return
      }

      path.node.name = nextName
    },
  })

  const first = file.program.body[0]
  return t.isExpressionStatement(first) ? first.expression : cloned
}

/**
 * Collect free (unbound) identifiers from a Babel expression.
 * This is used by resumable event lowering to capture lexical dependencies,
 * including identifiers referenced inside nested returned closures.
 */
export function collectFreeIdentifiersInExpr(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): Set<string> {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr, true))]))
  const names = new Set<string>()

  traverse(file, {
    ReferencedIdentifier(path) {
      const name = path.node.name
      if (path.scope.getBinding(name)) return
      names.add(name)
    },
  })

  return names
}

/**
 * Detect `arguments` reads that would be captured lexically by an arrow function.
 * Non-arrow functions provide their own `arguments` object, so references inside
 * those scopes remain safe after the handler is hoisted.
 */
export function capturesLexicalArgumentsInExpr(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): boolean {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr, true))]))
  let found = false

  traverse(file, {
    Function(path) {
      if (path.isArrowFunctionExpression()) return
      path.skip()
    },
    ReferencedIdentifier(path) {
      if (path.node.name !== 'arguments') return
      if (path.scope.getBinding('arguments')) return
      found = true
      path.stop()
    },
  })

  return found
}

/**
 * Detect `new.target` reads that would be captured lexically by an arrow
 * function. Hoisting those arrows to module scope can produce invalid ESM.
 */
export function capturesLexicalNewTargetInExpr(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): boolean {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr, true))]))
  let found = false

  traverse(file, {
    Function(path) {
      if (path.isArrowFunctionExpression()) return
      path.skip()
    },
    MetaProperty(path) {
      if (!t.isIdentifier(path.node.meta, { name: 'new' })) return
      if (!t.isIdentifier(path.node.property, { name: 'target' })) return
      found = true
      path.stop()
    },
  })

  return found
}

/**
 * Detect `this` reads captured lexically by an arrow function. Non-arrow
 * handlers intentionally receive dynamic DOM `this` via `.call(el, event)`.
 */
export function capturesLexicalThisInExpr(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): boolean {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr, true))]))
  let found = false

  traverse(file, {
    Function(path) {
      if (path.isArrowFunctionExpression()) return
      path.skip()
    },
    ThisExpression(path) {
      found = true
      path.stop()
    },
  })

  return found
}

/**
 * Generate module URL expression for QRL generation.
 * Build integrations can provide a stable public identity without replacing the
 * physical filename used by diagnostics and module resolution. Standalone/dev
 * compilation keeps the historical filename/import.meta.url behavior.
 */
export function genModuleUrlExpr(ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx
  const publicModuleId = ctx.options?.publicModuleId
  if (publicModuleId) return t.stringLiteral(publicModuleId)
  const filename = ctx.options?.filename
  if (filename) {
    const fileUrl = filename.startsWith('file://') ? filename : pathToFileURL(filename).href
    return t.stringLiteral(fileUrl)
  }
  return t.memberExpression(
    t.metaProperty(t.identifier('import'), t.identifier('meta')),
    t.identifier('url'),
  )
}
