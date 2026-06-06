import type * as BabelCore from '@babel/core'

import { isRuntimeImportModule } from '../constants'

export interface RuntimeImportCollection {
  names: Set<string>
  importMap: Map<string, string>
  importSources: Map<string, string>
  namespaces: Set<string>
  namespaceSources: Map<string, string>
}

export function collectRuntimeImports(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): RuntimeImportCollection {
  const names = new Set<string>()
  const importMap = new Map<string, string>()
  const importSources = new Map<string, string>()
  const namespaces = new Set<string>()
  const namespaceSources = new Map<string, string>()

  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt)) continue
    if ((stmt as { importKind?: string }).importKind === 'type') continue
    if (!isRuntimeImportModule(stmt.source.value)) continue
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
        importSources.set(spec.local.name, stmt.source.value)
      } else if (t.isImportNamespaceSpecifier(spec)) {
        namespaces.add(spec.local.name)
        namespaceSources.set(spec.local.name, stmt.source.value)
      }
    }
  }

  return { names, importMap, importSources, namespaces, namespaceSources }
}
