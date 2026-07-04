import type * as BabelCore from '@babel/core'

import {
  detectRuntimeImportFamily,
  getRuntimeHelperModule,
  getRuntimeModule,
  RUNTIME_HELPERS,
} from '../constants'
import type { RUNTIME_ALIASES } from '../constants'

import type { CodegenContext } from './codegen'
import { inlineHelperName, runtimeHelperLocalName } from './codegen-runtime-helpers'

export function collectDeclaredNames(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const declared = new Set<string>()
  const addPatternNames = (pattern: BabelCore.types.LVal | BabelCore.types.PatternLike): void => {
    if (t.isIdentifier(pattern)) {
      declared.add(pattern.name)
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      addPatternNames(pattern.left as BabelCore.types.PatternLike)
      return
    }
    if (t.isRestElement(pattern)) {
      addPatternNames(pattern.argument as BabelCore.types.PatternLike)
      return
    }
    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          addPatternNames(prop.argument as BabelCore.types.PatternLike)
        } else if (t.isObjectProperty(prop)) {
          addPatternNames(prop.value as BabelCore.types.PatternLike)
        }
      }
      return
    }
    if (t.isArrayPattern(pattern)) {
      for (const el of pattern.elements) {
        if (!el) continue
        if (t.isPatternLike(el)) addPatternNames(el as BabelCore.types.PatternLike)
      }
    }
  }

  for (const stmt of body) {
    if (t.isImportDeclaration(stmt)) {
      if ((stmt as { importKind?: string | null }).importKind === 'type') continue
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec) && spec.importKind === 'type') continue
        declared.add(spec.local.name)
      }
      continue
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
      declared.add(stmt.id.name)
      continue
    }
    if (t.isClassDeclaration(stmt) && stmt.id) {
      declared.add(stmt.id.name)
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        addPatternNames(decl.id)
      }
      continue
    }
    if (t.isExportNamedDeclaration(stmt)) {
      if (stmt.declaration) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.id) declared.add(decl.id.name)
        if (t.isClassDeclaration(decl) && decl.id) declared.add(decl.id.name)
        if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) addPatternNames(d.id)
        }
      } else if (!stmt.source) {
        for (const spec of stmt.specifiers) {
          if ((spec as { exportKind?: string | null }).exportKind === 'type') continue
          if (t.isExportSpecifier(spec)) {
            declared.add(spec.local.name)
          }
        }
      }
      continue
    }
    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration
      if (t.isIdentifier(decl)) {
        declared.add(decl.name)
      } else if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
        declared.add(decl.id.name)
      }
    }
  }

  return declared
}

/**
 * Collect every binding identifier declared anywhere in the module, including
 * inside nested function/arrow bodies, block scopes, loops and catch clauses.
 *
 * `collectDeclaredNames` only reports module-scope bindings, which is not enough
 * to allocate collision-free runtime-helper aliases: a helper alias is chosen
 * once per module, so it must avoid names declared as locals in *any* function
 * (e.g. `function C(){ const template = 5; ... }` must not shadow the emitted
 * `template` helper import).
 */
export function collectDeeplyDeclaredNameCounts(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Map<string, number> {
  const declared = new Map<string, number>()
  const addName = (name: string): void => {
    declared.set(name, (declared.get(name) ?? 0) + 1)
  }
  const addPatternNames = (pattern: BabelCore.types.Node | null | undefined): void => {
    if (!pattern) return
    if (t.isIdentifier(pattern)) {
      addName(pattern.name)
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      addPatternNames(pattern.left)
      return
    }
    if (t.isRestElement(pattern)) {
      addPatternNames(pattern.argument)
      return
    }
    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) addPatternNames(prop.argument)
        else if (t.isObjectProperty(prop)) addPatternNames(prop.value)
      }
      return
    }
    if (t.isArrayPattern(pattern)) {
      for (const el of pattern.elements) addPatternNames(el)
    }
  }

  const visit = (node: BabelCore.types.Node): void => {
    if (
      t.isImportSpecifier(node) ||
      t.isImportDefaultSpecifier(node) ||
      t.isImportNamespaceSpecifier(node)
    ) {
      addName(node.local.name)
      return
    }
    if (t.isVariableDeclarator(node)) {
      addPatternNames(node.id)
      return
    }
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isObjectMethod(node) ||
      t.isClassMethod(node) ||
      t.isClassPrivateMethod(node)
    ) {
      if ('id' in node && node.id) addName(node.id.name)
      for (const param of node.params) {
        addPatternNames(t.isTSParameterProperty(param) ? param.parameter : param)
      }
      return
    }
    if (t.isClassDeclaration(node) || t.isClassExpression(node)) {
      if (node.id) addName(node.id.name)
      return
    }
    if (t.isCatchClause(node)) {
      addPatternNames(node.param)
      return
    }
  }

  const traverseFast = (
    t as unknown as {
      traverseFast: (node: BabelCore.types.Node, enter: (n: BabelCore.types.Node) => void) => void
    }
  ).traverseFast
  for (const stmt of body) {
    visit(stmt)
    traverseFast(stmt, visit)
  }
  return declared
}

export function collectDeeplyDeclaredNames(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  return new Set(collectDeeplyDeclaredNameCounts(body, t).keys())
}

export function attachHelperImports(
  ctx: CodegenContext,
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (ctx.helpersUsed.size === 0 && !ctx.needsForOfHelper && !ctx.needsForInHelper) return body
  const declared = collectDeclaredNames(body, t)
  const runtimeImportFamily = detectRuntimeImportFamily(body)
  const runtimeModule = getRuntimeModule(runtimeImportFamily)

  const specifiersByModule = new Map<string, BabelCore.types.ImportSpecifier[]>()

  for (const name of ctx.helpersUsed) {
    const helper = (RUNTIME_HELPERS as Record<string, string>)[name]
    if (helper) {
      const localName = runtimeHelperLocalName(ctx, name as keyof typeof RUNTIME_ALIASES)
      if (declared.has(localName) && ctx.moduleRuntimeImportMap?.get(localName) === helper) {
        continue
      }
      const modulePath = getRuntimeHelperModule(
        runtimeImportFamily,
        name as keyof typeof RUNTIME_HELPERS,
      )
      const moduleSpecifiers = specifiersByModule.get(modulePath) ?? []
      moduleSpecifiers.push(t.importSpecifier(t.identifier(localName), t.identifier(helper)))
      specifiersByModule.set(modulePath, moduleSpecifiers)
    }
  }

  if (specifiersByModule.size === 0 && !ctx.needsForOfHelper && !ctx.needsForInHelper) return body

  const helpers: BabelCore.types.Statement[] = []
  if (ctx.needsForOfHelper) {
    const helperId = t.identifier(inlineHelperName(ctx, 'forOf'))
    const itemId = t.identifier('item')
    const iterableId = t.identifier('iterable')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        helperId,
        [iterableId, cbId],
        t.blockStatement([
          t.forOfStatement(
            t.variableDeclaration('const', [t.variableDeclarator(itemId)]),
            iterableId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [itemId]))]),
          ),
        ]),
      ),
    )
  }
  if (ctx.needsForInHelper) {
    const helperId = t.identifier(inlineHelperName(ctx, 'forIn'))
    const keyId = t.identifier('key')
    const objId = t.identifier('obj')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        helperId,
        [objId, cbId],
        t.blockStatement([
          t.forInStatement(
            t.variableDeclaration('const', [t.variableDeclarator(keyId)]),
            objId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [keyId]))]),
          ),
        ]),
      ),
    )
  }

  const modulePaths = Array.from(specifiersByModule.keys()).sort((a, b) => {
    if (a === runtimeModule) return -1
    if (b === runtimeModule) return 1
    return a.localeCompare(b)
  })
  const importDecls = modulePaths.map(modulePath =>
    t.importDeclaration(specifiersByModule.get(modulePath) ?? [], t.stringLiteral(modulePath)),
  )

  return [...importDecls, ...helpers, ...body]
}
