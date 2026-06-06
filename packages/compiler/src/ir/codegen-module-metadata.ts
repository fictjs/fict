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
import {
  getReactiveCallKindFromBabel,
  getRuntimeReactiveCreatorKind,
} from './codegen-reactive-kind'
import { collectRuntimeImports } from './codegen-runtime-imports'
import { isHookName } from './hook-utils'
import { deSSAVarName } from './regions'

function addImportedReactiveBinding(
  name: string,
  kind: ReactiveExportKind,
  ctx: CodegenContext,
): void {
  const base = deSSAVarName(name)
  ctx.importedReactiveVars?.add(base)
  ctx.importedReactiveKinds?.set(base, kind)
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
    markImportedHook?: (localName: string, hasMetadata: boolean) => void
    setImportedHookInfo?: (localName: string, info: HookReturnInfoSerializable) => void
  },
): void {
  const importer = options?.filename
  const namespaces = new Map<string, ModuleReactiveMetadata>()
  const markHookImport = (
    localName: string,
    importedName: string | undefined,
    hasMetadata: boolean,
  ) => {
    if (isHookName(localName) || isHookName(importedName)) {
      hooks?.markImportedHook?.(localName, hasMetadata)
    }
  }

  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt)) continue
    if (isTypeOnlyKind(stmt.importKind)) continue
    const meta = resolveModuleMetadata(stmt.source.value, importer, options)
    if (!meta) {
      for (const spec of stmt.specifiers) {
        if (isTypeOnlyImportSpecifier(spec)) continue
        if (t.isImportSpecifier(spec)) {
          const importedName = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : String(spec.imported.value)
          markHookImport(spec.local.name, importedName, false)
        } else if (t.isImportDefaultSpecifier(spec)) {
          markHookImport(spec.local.name, 'default', false)
        }
      }
      continue
    }

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
        markHookImport(localName, importedName, !!hookInfo)
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
        markHookImport(localName, 'default', !!hookInfo)
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
  const explicitExportNames = new Set<string>()
  const starExportNames = new Set<string>()
  const runtimeImports = collectRuntimeImports(body, t)
  const runtimeImportMap = new Map(runtimeImports.importMap)
  ctx.moduleRuntimeImportMap?.forEach((importedName, localName) => {
    runtimeImportMap.set(localName, importedName)
  })
  const runtimeNamespaceImports = new Set(runtimeImports.namespaces)
  ctx.moduleRuntimeNamespaceImports?.forEach(name => runtimeNamespaceImports.add(name))
  const markExplicitExport = (exportName: string) => {
    explicitExportNames.add(exportName)
    delete metadata.exports[exportName]
    delete hookExports[exportName]
  }
  const addStarExport = (
    exportName: string,
    kind: ReactiveExportKind | undefined,
    hookInfo: HookReturnInfoSerializable | undefined,
  ) => {
    if (exportName === 'default' || explicitExportNames.has(exportName)) return
    if (starExportNames.has(exportName)) {
      delete metadata.exports[exportName]
      delete hookExports[exportName]
      return
    }
    starExportNames.add(exportName)
    if (kind) {
      metadata.exports[exportName] = kind
    }
    if (hookInfo) {
      hookExports[exportName] = hookInfo
    }
  }
  const getSpecifierName = (
    specifierName: BabelCore.types.Identifier | BabelCore.types.StringLiteral,
  ): string => (t.isIdentifier(specifierName) ? specifierName.name : specifierName.value)
  const getStaticMemberName = (
    member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  ): string | number | null => {
    if (!member.computed && t.isIdentifier(member.property)) return member.property.name
    if (t.isStringLiteral(member.property)) return member.property.value
    if (t.isNumericLiteral(member.property)) return member.property.value
    return null
  }
  const isStaticUndefined = (expr: BabelCore.types.Expression): boolean =>
    t.isIdentifier(expr, { name: 'undefined' }) ||
    (t.isUnaryExpression(expr) && expr.operator === 'void')
  type StaticValue =
    | { kind: 'known'; value: BabelCore.types.Expression | null }
    | { kind: 'unknown' }
  const unknownStaticValue = (): StaticValue => ({ kind: 'unknown' })
  const knownStaticValue = (value: BabelCore.types.Expression | null): StaticValue => ({
    kind: 'known',
    value,
  })
  const getObjectKey = (
    key: BabelCore.types.Expression | BabelCore.types.PrivateName,
    computed: boolean,
  ): string | number | null => {
    if (t.isPrivateName(key)) return null
    if (!computed && t.isIdentifier(key)) return key.name
    if (t.isStringLiteral(key)) return key.value
    if (t.isNumericLiteral(key)) return key.value
    return null
  }
  const getStaticObjectPropertyMap = (
    expr: BabelCore.types.Expression | null,
  ): Map<string | number, BabelCore.types.Expression> | null => {
    if (!expr || !t.isObjectExpression(expr)) return null
    const props = new Map<string | number, BabelCore.types.Expression>()
    for (const prop of expr.properties) {
      if (t.isSpreadElement(prop)) return null
      if (!t.isObjectProperty(prop)) continue
      const key = getObjectKey(prop.key, prop.computed)
      if (key === null) continue
      props.set(key, prop.value as BabelCore.types.Expression)
    }
    return props
  }
  const getStaticArrayElement = (
    expr: BabelCore.types.Expression | null,
    key: string | number,
  ): StaticValue => {
    if (!expr || !t.isArrayExpression(expr)) return unknownStaticValue()
    if (expr.elements.some(element => element && t.isSpreadElement(element))) {
      return unknownStaticValue()
    }
    const index = typeof key === 'number' ? key : Number(key)
    if (!Number.isSafeInteger(index) || String(index) !== String(key)) return unknownStaticValue()
    if (index < 0 || index >= expr.elements.length) return knownStaticValue(null)
    const element = expr.elements[index]
    return element && t.isExpression(element) ? knownStaticValue(element) : knownStaticValue(null)
  }
  const staticLocalValues = new Map<string, StaticValue>()
  const getStaticUndefinedState = (value: StaticValue): boolean | null => {
    if (value.kind !== 'known') return null
    return !value.value || isStaticUndefined(value.value)
  }
  const evaluateStaticBoolean = (expr: BabelCore.types.Expression): boolean | null => {
    if (!t.isBinaryExpression(expr)) return null
    if (
      expr.operator !== '===' &&
      expr.operator !== '==' &&
      expr.operator !== '!==' &&
      expr.operator !== '!='
    ) {
      return null
    }
    const leftUndefined = getStaticUndefinedState(
      resolveStaticValue(expr.left as BabelCore.types.Expression),
    )
    const rightUndefined = getStaticUndefinedState(
      resolveStaticValue(expr.right as BabelCore.types.Expression),
    )
    if (leftUndefined === null || rightUndefined === null) return null
    if (!leftUndefined && !rightUndefined) return null
    const equal = leftUndefined === rightUndefined
    return expr.operator === '===' || expr.operator === '==' ? equal : !equal
  }
  const resolveStaticValue = (expr: BabelCore.types.Expression | null | undefined): StaticValue => {
    if (!expr) return unknownStaticValue()
    if (t.isConditionalExpression(expr)) {
      const test = evaluateStaticBoolean(expr.test as BabelCore.types.Expression)
      if (test === true) return resolveStaticValue(expr.consequent as BabelCore.types.Expression)
      if (test === false) return resolveStaticValue(expr.alternate as BabelCore.types.Expression)
    }
    if (t.isIdentifier(expr)) {
      return staticLocalValues.get(deSSAVarName(expr.name)) ?? knownStaticValue(expr)
    }
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
      if (!t.isIdentifier(expr.object)) return knownStaticValue(expr)
      const objectValue = staticLocalValues.get(deSSAVarName(expr.object.name))
      if (!objectValue || objectValue.kind !== 'known') return knownStaticValue(expr)
      const memberName = getStaticMemberName(expr)
      if (memberName === null) return unknownStaticValue()
      if (objectValue.value && t.isArrayExpression(objectValue.value)) {
        return getStaticArrayElement(objectValue.value, memberName)
      }
      const props = getStaticObjectPropertyMap(objectValue.value)
      if (!props) return unknownStaticValue()
      return props.has(memberName)
        ? knownStaticValue(props.get(memberName) ?? null)
        : knownStaticValue(null)
    }
    return knownStaticValue(expr)
  }
  const classifyStaticValue = (source: StaticValue): ReactiveExportKind | null => {
    if (source.kind !== 'known' || !source.value) return null
    if (t.isCallExpression(source.value) || t.isOptionalCallExpression(source.value)) {
      const kind = getReactiveCallKindFromBabel(source.value, ctx, t)
      if (kind) return kind
      const callee = source.value.callee
      if (t.isIdentifier(callee)) {
        const importedName = runtimeImportMap.get(callee.name)
        return importedName ? getRuntimeReactiveCreatorKind(importedName) : null
      }
      if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
        if (!t.isIdentifier(callee.object)) return null
        if (!runtimeNamespaceImports.has(callee.object.name)) return null
        const memberName = getStaticMemberName(callee)
        return typeof memberName === 'string' ? getRuntimeReactiveCreatorKind(memberName) : null
      }
    }
    return null
  }
  const visitDestructuredBindings = (
    pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
    source: StaticValue,
    visit: (name: string, source: StaticValue) => void,
  ): void => {
    if (t.isIdentifier(pattern)) {
      visit(pattern.name, source)
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      const shouldUseDefault =
        source.kind === 'known' &&
        (!source.value || (source.value && isStaticUndefined(source.value)))
      const defaultSource = shouldUseDefault
        ? knownStaticValue(pattern.right as BabelCore.types.Expression)
        : source
      visitDestructuredBindings(pattern.left as BabelCore.types.PatternLike, defaultSource, visit)
      return
    }
    if (t.isRestElement(pattern)) {
      visitDestructuredBindings(
        pattern.argument as BabelCore.types.PatternLike,
        unknownStaticValue(),
        visit,
      )
      return
    }
    if (t.isArrayPattern(pattern)) {
      const elements =
        source.kind === 'known' &&
        source.value &&
        t.isArrayExpression(source.value) &&
        !source.value.elements.some(element => element && t.isSpreadElement(element))
          ? source.value.elements
          : null
      pattern.elements.forEach((element, index) => {
        if (!element) return
        const elementSource =
          elements && index < elements.length
            ? elements[index] && t.isExpression(elements[index])
              ? knownStaticValue(elements[index])
              : knownStaticValue(null)
            : elements
              ? knownStaticValue(null)
              : unknownStaticValue()
        visitDestructuredBindings(element as BabelCore.types.PatternLike, elementSource, visit)
      })
      return
    }
    if (t.isObjectPattern(pattern)) {
      const props = source.kind === 'known' ? getStaticObjectPropertyMap(source.value) : null
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          visitDestructuredBindings(
            prop.argument as BabelCore.types.PatternLike,
            unknownStaticValue(),
            visit,
          )
          continue
        }
        if (!t.isObjectProperty(prop)) continue
        const key = getObjectKey(prop.key, prop.computed)
        const propSource =
          props && key !== null && props.has(key)
            ? knownStaticValue(props.get(key) ?? null)
            : props
              ? knownStaticValue(null)
              : unknownStaticValue()
        visitDestructuredBindings(prop.value as BabelCore.types.PatternLike, propSource, visit)
      }
    }
  }
  const localReactiveKinds = new Map<string, ReactiveExportKind>()
  const collectDestructuredReactiveLocals = (decl: BabelCore.types.VariableDeclaration): void => {
    for (const v of decl.declarations) {
      if (t.isIdentifier(v.id)) {
        const source = resolveStaticValue(v.init as BabelCore.types.Expression | null | undefined)
        staticLocalValues.set(deSSAVarName(v.id.name), source)
        const kind = classifyStaticValue(source)
        if (kind) {
          localReactiveKinds.set(deSSAVarName(v.id.name), kind)
        }
        continue
      }
      visitDestructuredBindings(
        v.id,
        resolveStaticValue(v.init as BabelCore.types.Expression | null | undefined),
        (name, source) => {
          const kind = classifyStaticValue(source)
          if (kind) {
            localReactiveKinds.set(deSSAVarName(name), kind)
          }
        },
      )
    }
  }
  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt)) {
      collectDestructuredReactiveLocals(stmt)
    } else if (
      t.isExportNamedDeclaration(stmt) &&
      stmt.declaration &&
      t.isVariableDeclaration(stmt.declaration)
    ) {
      collectDestructuredReactiveLocals(stmt.declaration)
    }
  }
  const addExport = (exportName: string, localName: string) => {
    markExplicitExport(exportName)
    const kind =
      classifyReactiveExport(localName, ctx) ?? localReactiveKinds.get(deSSAVarName(localName))
    if (kind) {
      metadata.exports[exportName] = kind
    }
    const hookInfo = hooks?.getLocalHookInfo?.(localName)
    if (hookInfo) {
      hookExports[exportName] = hookInfo
    }
  }
  const addDestructuredExport = (
    pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
    source: StaticValue,
  ): void => {
    visitDestructuredBindings(pattern, source, (name, source) => {
      markExplicitExport(name)
      const kind = classifyStaticValue(source) ?? localReactiveKinds.get(deSSAVarName(name))
      if (kind) {
        metadata.exports[name] = kind
      }
    })
  }
  const addNamespaceExportFromSource = (source: string, exportName: string) => {
    const sourceMeta = resolveModuleMetadata(source, options?.filename, options)
    if (sourceMeta) {
      namespaceExports[exportName] = sourceMeta
    }
  }
  const addExportFromSource = (source: string, importedName: string, exportName: string) => {
    markExplicitExport(exportName)
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
    markExplicitExport('default')
    if (kind) {
      metadata.exports.default = kind
    }
  }
  const addDefaultExportFromNamespaceMember = (
    member: BabelCore.types.MemberExpression,
  ): boolean => {
    if (!t.isIdentifier(member.object)) return false
    const namespaceMeta = ctx.importedNamespaces?.get(member.object.name)
    if (!namespaceMeta) return false
    const memberName = getStaticMemberName(member)
    if (memberName === null) return false

    markExplicitExport('default')
    const key = String(memberName)
    const kind = namespaceMeta.exports[key]
    if (kind) {
      metadata.exports.default = kind
    }
    const hookInfo = namespaceMeta.hooks?.[key]
    if (hookInfo) {
      hookExports.default = hookInfo
    }
    return true
  }

  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt)) {
      if (isTypeOnlyKind(stmt.exportKind)) continue
      if (stmt.source && stmt.specifiers.length > 0) {
        for (const spec of stmt.specifiers) {
          if (isTypeOnlyExportSpecifier(spec)) continue
          if (t.isExportNamespaceSpecifier(spec)) {
            addNamespaceExportFromSource(stmt.source.value, getSpecifierName(spec.exported))
            continue
          }
          if (!t.isExportSpecifier(spec)) continue
          const importedName = getSpecifierName(spec.local)
          const exportName = getSpecifierName(spec.exported)
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
            } else {
              addDestructuredExport(
                v.id,
                v.init
                  ? knownStaticValue(v.init as BabelCore.types.Expression)
                  : unknownStaticValue(),
              )
            }
          }
        }
      } else {
        for (const spec of stmt.specifiers) {
          if (isTypeOnlyExportSpecifier(spec)) continue
          if (!t.isExportSpecifier(spec)) continue
          const localName = getSpecifierName(spec.local)
          const exportName = getSpecifierName(spec.exported)
          addExport(exportName, localName)
        }
      }
      continue
    }

    if (t.isExportAllDeclaration(stmt)) {
      if (isTypeOnlyKind(stmt.exportKind)) continue
      const sourceMeta = resolveModuleMetadata(stmt.source.value, options?.filename, options)
      if (!sourceMeta) continue
      const starNames = new Set([
        ...Object.keys(sourceMeta.exports),
        ...Object.keys(sourceMeta.hooks ?? {}),
      ])
      for (const exportName of starNames) {
        addStarExport(exportName, sourceMeta.exports[exportName], sourceMeta.hooks?.[exportName])
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
      } else if (t.isMemberExpression(decl)) {
        addDefaultExportFromNamespaceMember(decl)
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
