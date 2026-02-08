import type * as BabelCore from '@babel/core'

import { RUNTIME_HELPER_MODULES, RUNTIME_MODULE } from '../constants'

export interface RuntimeImportCollection {
  names: Set<string>
  importMap: Map<string, string>
  namespaces: Set<string>
}

const RUNTIME_IMPORT_MODULES = new Set([
  RUNTIME_MODULE,
  ...Object.values(RUNTIME_HELPER_MODULES),
  '@fictjs/runtime',
  '@fictjs/runtime/advanced',
  'fict',
  'fict/advanced',
])

export function collectRuntimeImports(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): RuntimeImportCollection {
  const names = new Set<string>()
  const importMap = new Map<string, string>()
  const namespaces = new Set<string>()

  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt)) continue
    if ((stmt as { importKind?: string }).importKind === 'type') continue
    if (!RUNTIME_IMPORT_MODULES.has(stmt.source.value)) continue
    for (const spec of stmt.specifiers) {
      if (t.isImportSpecifier(spec) && spec.importKind === 'type') {
        continue
      }
      names.add(spec.local.name)
      if (t.isImportSpecifier(spec)) {
        const importedName = t.isIdentifier(spec.imported)
          ? spec.imported.name
          : spec.imported.value
        importMap.set(spec.local.name, importedName)
      } else if (t.isImportNamespaceSpecifier(spec) || t.isImportDefaultSpecifier(spec)) {
        namespaces.add(spec.local.name)
      }
    }
  }

  return { names, importMap, namespaces }
}
