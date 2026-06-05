import type * as BabelCore from '@babel/core'

import { resolveModuleMetadata } from '../module-metadata'
import { MODULE_REACTIVE_METADATA_VERSION } from '../types'
import type {
  FictCompilerOptions,
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ReactiveExportKind,
} from '../types'

import type { CodegenContext } from './codegen'
import { getReactiveCallKindFromBabel } from './codegen-reactive-kind'
import { deSSAVarName } from './regions'

function addImportedReactiveBinding(
  name: string,
  kind: ReactiveExportKind,
  ctx: CodegenContext,
): void {
  const base = deSSAVarName(name)
  if (kind === 'signal') {
    ctx.signalVars?.add(base)
  } else if (kind === 'store') {
    ctx.storeVars?.add(base)
  } else if (kind === 'memo') {
    ctx.memoVars?.add(base)
  }
  ctx.trackedVars.add(base)
}

function classifyReactiveExport(name: string, ctx: CodegenContext): ReactiveExportKind | null {
  const base = deSSAVarName(name)
  if (ctx.aliasVars?.has(base)) return 'memo'
  if (ctx.storeVars?.has(base)) return 'store'
  if (ctx.signalVars?.has(base)) return 'signal'
  if (ctx.memoVars?.has(base)) return 'memo'
  return null
}

function isTypeOnlyKind(kind: string | null | undefined): boolean {
  return kind === 'type' || kind === 'typeof'
}

function isTypeOnlyImportSpecifier(spec: BabelCore.types.ImportDeclaration['specifiers'][number]) {
  return isTypeOnlyKind((spec as { importKind?: string | null }).importKind)
}

function isTypeOnlyExportSpecifier(
  spec: BabelCore.types.ExportNamedDeclaration['specifiers'][number],
) {
  return isTypeOnlyKind((spec as { exportKind?: string | null }).exportKind)
}

export function applyImportedReactiveMetadata(
  body: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  options: FictCompilerOptions | undefined,
  hooks?: {
    setImportedHookInfo?: (localName: string, info: HookReturnInfoSerializable) => void
  },
): void {
  const importer = options?.filename
  const namespaces = new Map<string, ModuleReactiveMetadata>()

  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt)) continue
    if (isTypeOnlyKind(stmt.importKind)) continue
    const meta = resolveModuleMetadata(stmt.source.value, importer, options)
    if (!meta) continue

    for (const spec of stmt.specifiers) {
      if (isTypeOnlyImportSpecifier(spec)) continue
      if (t.isImportSpecifier(spec)) {
        const importedName = t.isIdentifier(spec.imported)
          ? spec.imported.name
          : String(spec.imported.value)
        const localName = spec.local.name
        const kind = meta.exports[importedName]
        if (kind) {
          addImportedReactiveBinding(localName, kind, ctx)
        }
        const namespaceMeta = meta.namespaces?.[importedName]
        if (namespaceMeta) {
          namespaces.set(localName, namespaceMeta)
        }
        const hookInfo = meta.hooks?.[importedName]
        if (hookInfo && hooks?.setImportedHookInfo) {
          hooks.setImportedHookInfo(localName, hookInfo)
        }
        continue
      }
      if (t.isImportDefaultSpecifier(spec)) {
        const localName = spec.local.name
        const kind = meta.exports.default
        if (kind) {
          addImportedReactiveBinding(localName, kind, ctx)
        }
        const hookInfo = meta.hooks?.default
        if (hookInfo && hooks?.setImportedHookInfo) {
          hooks.setImportedHookInfo(localName, hookInfo)
        }
        continue
      }
      if (t.isImportNamespaceSpecifier(spec)) {
        namespaces.set(spec.local.name, meta)
      }
    }
  }

  if (namespaces.size > 0) {
    ctx.importedNamespaces = namespaces
  }
}

export function buildModuleReactiveMetadata(
  body: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  options: FictCompilerOptions | undefined,
  hooks?: {
    getLocalHookInfo?: (localName: string) => HookReturnInfoSerializable | undefined
  },
): ModuleReactiveMetadata {
  const metadata: ModuleReactiveMetadata = {
    version: MODULE_REACTIVE_METADATA_VERSION,
    exports: {},
  }
  const hookExports: Record<string, HookReturnInfoSerializable> = {}
  const namespaceExports: Record<string, ModuleReactiveMetadata> = {}
  const getExportedName = (
    exported: BabelCore.types.Identifier | BabelCore.types.StringLiteral,
  ): string => (t.isIdentifier(exported) ? exported.name : exported.value)
  const addExport = (exportName: string, localName: string) => {
    const kind = classifyReactiveExport(localName, ctx)
    if (kind) {
      metadata.exports[exportName] = kind
    }
    const hookInfo = hooks?.getLocalHookInfo?.(localName)
    if (hookInfo) {
      hookExports[exportName] = hookInfo
    }
  }
  const addNamespaceExportFromSource = (source: string, exportName: string) => {
    const sourceMeta = resolveModuleMetadata(source, options?.filename, options)
    if (sourceMeta) {
      namespaceExports[exportName] = sourceMeta
    }
  }
  const addExportFromSource = (source: string, importedName: string, exportName: string) => {
    const sourceMeta = resolveModuleMetadata(source, options?.filename, options)
    if (!sourceMeta) return
    const kind = sourceMeta.exports[importedName]
    if (kind) {
      metadata.exports[exportName] = kind
    }
    const hookInfo = sourceMeta.hooks?.[importedName]
    if (hookInfo) {
      hookExports[exportName] = hookInfo
    }
  }
  const addDefaultExportKind = (kind: ReactiveExportKind | null) => {
    if (kind) {
      metadata.exports.default = kind
    }
  }

  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt)) {
      if (isTypeOnlyKind(stmt.exportKind)) continue
      if (stmt.source && stmt.specifiers.length > 0) {
        for (const spec of stmt.specifiers) {
          if (isTypeOnlyExportSpecifier(spec)) continue
          if (t.isExportNamespaceSpecifier(spec)) {
            addNamespaceExportFromSource(stmt.source.value, getExportedName(spec.exported))
            continue
          }
          if (!t.isExportSpecifier(spec)) continue
          const importedName = spec.local.name
          const exportName = getExportedName(spec.exported)
          addExportFromSource(stmt.source.value, importedName, exportName)
        }
        continue
      }
      if (stmt.declaration) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.id) {
          addExport(decl.id.name, decl.id.name)
        } else if (t.isClassDeclaration(decl) && decl.id) {
          addExport(decl.id.name, decl.id.name)
        } else if (t.isVariableDeclaration(decl)) {
          for (const v of decl.declarations) {
            if (t.isIdentifier(v.id)) {
              addExport(v.id.name, v.id.name)
            }
          }
        }
      } else {
        for (const spec of stmt.specifiers) {
          if (isTypeOnlyExportSpecifier(spec)) continue
          if (!t.isExportSpecifier(spec)) continue
          const localName = spec.local.name
          const exportName = getExportedName(spec.exported)
          addExport(exportName, localName)
        }
      }
      continue
    }

    if (t.isExportAllDeclaration(stmt)) {
      if (isTypeOnlyKind(stmt.exportKind)) continue
      const sourceMeta = resolveModuleMetadata(stmt.source.value, options?.filename, options)
      if (!sourceMeta) continue
      for (const [exportName, kind] of Object.entries(sourceMeta.exports)) {
        if (exportName === 'default') continue
        metadata.exports[exportName] = kind
      }
      if (sourceMeta.hooks) {
        for (const [exportName, info] of Object.entries(sourceMeta.hooks)) {
          if (exportName === 'default') continue
          hookExports[exportName] = info
        }
      }
      continue
    }

    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration
      if (t.isIdentifier(decl)) {
        addExport('default', decl.name)
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        addExport('default', decl.id.name)
      } else if (t.isClassDeclaration(decl) && decl.id) {
        addExport('default', decl.id.name)
      } else if (t.isCallExpression(decl) || t.isOptionalCallExpression(decl)) {
        const kind = getReactiveCallKindFromBabel(decl, ctx, t)
        addDefaultExportKind(kind)
      }
    }
  }

  if (Object.keys(hookExports).length > 0) {
    metadata.hooks = hookExports
  }
  if (Object.keys(namespaceExports).length > 0) {
    metadata.namespaces = namespaceExports
  }
  return metadata
}
