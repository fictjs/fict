import type * as BabelCore from '@babel/core'

import {
  detectRuntimeImportFamily,
  getRuntimeHelperModule,
  getRuntimeModule,
  RUNTIME_ALIASES,
  RUNTIME_HELPERS,
} from '../constants'

import type { CodegenContext } from './codegen'

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
      for (const spec of stmt.specifiers) {
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
      } else {
        for (const spec of stmt.specifiers) {
          if (t.isExportSpecifier(spec)) {
            declared.add(spec.local.name)
          }
        }
      }
      continue
    }
    if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration)) {
      declared.add(stmt.declaration.name)
    }
  }

  return declared
}

export function attachHelperImports(
  ctx: CodegenContext,
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (ctx.helpersUsed.size === 0) return body
  const declared = collectDeclaredNames(body, t)
  const runtimeImportFamily = detectRuntimeImportFamily(body)
  const runtimeModule = getRuntimeModule(runtimeImportFamily)

  const specifiersByModule = new Map<string, BabelCore.types.ImportSpecifier[]>()

  for (const name of ctx.helpersUsed) {
    const alias = (RUNTIME_ALIASES as Record<string, string>)[name]
    const helper = (RUNTIME_HELPERS as Record<string, string>)[name]
    if (alias && helper) {
      if (declared.has(alias)) continue
      const modulePath = getRuntimeHelperModule(
        runtimeImportFamily,
        name as keyof typeof RUNTIME_HELPERS,
      )
      const moduleSpecifiers = specifiersByModule.get(modulePath) ?? []
      moduleSpecifiers.push(t.importSpecifier(t.identifier(alias), t.identifier(helper)))
      specifiersByModule.set(modulePath, moduleSpecifiers)
    }
  }

  if (specifiersByModule.size === 0) return body

  const helpers: BabelCore.types.Statement[] = []
  if (ctx.needsForOfHelper) {
    const itemId = t.identifier('item')
    const iterableId = t.identifier('iterable')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForOf'),
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
    const keyId = t.identifier('key')
    const objId = t.identifier('obj')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForIn'),
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
