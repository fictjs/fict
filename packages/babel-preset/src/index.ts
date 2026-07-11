// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- upstream has no declarations
/// <reference path="./babel-plugin-syntax-typescript.d.ts" />

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  transformFromAstSync,
  transformSync,
  types as t,
  type ConfigAPI,
  type PluginObj,
  type TransformOptions,
} from '@babel/core'
import type * as BabelCore from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import syntaxTypeScript from '@babel/plugin-syntax-typescript'
import transformModulesCommonJS from '@babel/plugin-transform-modules-commonjs'
import transformTypeScript from '@babel/plugin-transform-typescript'
import {
  createFictPlugin,
  DiagnosticCode,
  invalidateModuleMetadata,
  resolveModuleMetadata as resolveCompilerModuleMetadata,
  setModuleMetadata,
  type CompilerWarning,
  type FictCompilerOptions,
  type ModuleReactiveMetadata,
} from '@fictjs/compiler'

export interface FictPresetOptions extends Omit<FictCompilerOptions, 'typescript'> {
  /**
   * Enable TypeScript support.
   * @default true
   */
  typescript?: boolean

  /**
   * TypeScript transform options.
   * Only used when typescript is true.
   */
  typescriptOptions?: {
    /**
     * Enable TSX parsing when allExtensions is true.
     * @default true in all-extensions mode
     */
    isTSX?: boolean

    /**
     * Parse all files with one TypeScript mode instead of detecting .ts/.tsx.
     * @default false
     */
    allExtensions?: boolean

    /**
     * Allow namespaces.
     * @default true
     */
    allowNamespaces?: boolean

    /**
     * Remove legal `declare` class fields before Fict compilation.
     * @default true
     */
    allowDeclareFields?: boolean

    /** Preserve ordinary imports even when they are referenced only in type positions. */
    onlyRemoveTypeImports?: boolean

    /** Inline exported and local const enums instead of emitting enum objects. */
    optimizeConstEnums?: boolean

    /** JSX factory identifier used to retain its value import during TypeScript lowering. */
    jsxPragma?: string

    /** JSX fragment identifier used to retain its value import during TypeScript lowering. */
    jsxPragmaFrag?: string

    /** Reject syntax that is ambiguous with JSX in all-extensions mode. */
    disallowAmbiguousJSXLike?: boolean

    /** Rewrite relative TypeScript import extensions to their JavaScript equivalents. */
    rewriteImportExtensions?: boolean
  }
}

type TypeScriptOptions = NonNullable<FictPresetOptions['typescriptOptions']>
interface InternalFictPresetOptions extends FictPresetOptions {
  __fictGraphFingerprint?: string
  __fictMetadataOnly?: boolean
  __fictGraphSession?: string
}

interface BabelFileDataStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

const TS_FILENAME_RE = /\.ts(?:[?#].*)?$/i
const TSX_FILENAME_RE = /\.tsx(?:[?#].*)?$/i
const MTS_FILENAME_RE = /\.mts(?:[?#].*)?$/i
const CTS_FILENAME_RE = /\.cts(?:[?#].*)?$/i
const LOCAL_MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const LOCAL_MODULE_EXTENSION_SET = new Set(LOCAL_MODULE_EXTENSIONS)
const NODE_BUILTIN_SOURCES = new Set(
  builtinModules.flatMap(source =>
    source.startsWith('node:') ? [source] : [source, `node:${source}`],
  ),
)
const OPAQUE_MODULE_METADATA: ModuleReactiveMetadata = Object.freeze({
  version: 1,
  exports: Object.freeze({}),
})

interface ImplicitGraphMetadataEntry {
  sourceHash: string
  metadata: ModuleReactiveMetadata
  incomplete: boolean
}

interface ImplicitGraphSession {
  metadata: Map<string, ImplicitGraphMetadataEntry>
  compilerMetadata: Map<string, ModuleReactiveMetadata>
  compiling: Set<string>
}

const implicitGraphSessions = new Map<string, ImplicitGraphSession>()
let implicitGraphSessionCounter = 0

function createImplicitGraphSessionId(): string {
  implicitGraphSessionCounter += 1
  return `${process.pid.toString(36)}-${implicitGraphSessionCounter.toString(36)}`
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeFingerprintValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return `[function:${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => normalizeFingerprintValue(item, seen))
  }
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    normalized[key] = normalizeFingerprintValue((value as Record<string, unknown>)[key], seen)
  }
  return normalized
}

function createGraphOptionsFingerprint(
  compilerOptions: FictCompilerOptions,
  typescript: boolean,
  typescriptOptions: TypeScriptOptions,
): string {
  const metadataNeutralOptions = new Set([
    'emitModuleMetadata',
    'explain',
    'filename',
    'integrationDiagnostics',
    'moduleMetadataCacheDir',
    'moduleMetadataExtension',
    'onModuleMetadata',
    'onModuleMetadataDependency',
    'onWarn',
    'sourcemap',
  ])
  const relevantOptions = Object.fromEntries(
    Object.entries(compilerOptions).filter(([key]) => !metadataNeutralOptions.has(key)),
  )
  return hashText(
    JSON.stringify(
      normalizeFingerprintValue({
        compiler: relevantOptions,
        typescript,
        typescriptOptions,
      }),
    ),
  )
}

interface SplitModuleRequestOptions {
  importer?: string | undefined
  allowPlainRelative?: boolean | undefined
}

interface SplitModuleRequestResult {
  target: string
  suffix: string
}

const isWindowsPath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')

function findSyntacticModuleSuffixStart(value: string): number {
  const queryStart = value.indexOf('?')
  const fragmentStart = value.indexOf('#', value.startsWith('#') ? 1 : 0)
  if (queryStart === -1) return fragmentStart === -1 ? value.length : fragmentStart
  if (fragmentStart === -1) return queryStart
  return Math.min(queryStart, fragmentStart)
}

function resolveLocalTargetPath(
  target: string,
  importer: string | undefined,
  allowPlainRelative: boolean,
): string | null {
  let rawTarget = target
  if (rawTarget.startsWith('/@fs/')) rawTarget = rawTarget.slice('/@fs'.length)
  if (rawTarget.startsWith('file://')) {
    try {
      rawTarget = fileURLToPath(rawTarget)
    } catch {
      return null
    }
  }
  if (rawTarget.includes('://') && !isWindowsPath(rawTarget)) return null

  if (!path.isAbsolute(rawTarget) && !isWindowsPath(rawTarget)) {
    if (rawTarget.startsWith('.')) {
      const baseDirectory = importer ? path.dirname(importer) : process.cwd()
      return path.resolve(baseDirectory, rawTarget)
    }
    return allowPlainRelative ? path.resolve(rawTarget) : null
  }
  return path.resolve(rawTarget)
}

function localModuleCandidates(rawTarget: string): string[] {
  const extension = path.extname(rawTarget).toLowerCase()
  const candidates = [rawTarget]
  if (!extension) {
    for (const suffix of LOCAL_MODULE_EXTENSIONS) candidates.push(`${rawTarget}${suffix}`)
    for (const suffix of LOCAL_MODULE_EXTENSIONS) {
      candidates.push(path.join(rawTarget, `index${suffix}`))
    }
  } else if (extension === '.js' || extension === '.jsx') {
    candidates.push(rawTarget.slice(0, -extension.length) + '.ts')
    candidates.push(rawTarget.slice(0, -extension.length) + '.tsx')
  } else if (extension === '.mjs') {
    candidates.push(rawTarget.slice(0, -extension.length) + '.mts')
  } else if (extension === '.cjs') {
    candidates.push(rawTarget.slice(0, -extension.length) + '.cts')
  }
  return candidates
}

function resolveExistingPhysicalTarget(
  target: string,
  options: SplitModuleRequestOptions,
): string | null {
  if (target.startsWith('file://')) {
    // URL query/hash delimiters are suffixes. Physical delimiters are encoded.
    return null
  }
  const rawTarget = resolveLocalTargetPath(
    target,
    options.importer,
    options.allowPlainRelative === true,
  )
  if (!rawTarget) return null
  if (isFile(rawTarget)) return rawTarget

  const extension = path.extname(rawTarget).toLowerCase()
  if (extension && !LOCAL_MODULE_EXTENSION_SET.has(extension)) return null
  return localModuleCandidates(rawTarget).slice(1).find(isFile) ?? null
}

function splitModuleRequest(
  value: string,
  options: SplitModuleRequestOptions = {},
): SplitModuleRequestResult {
  const syntacticSuffixStart = findSyntacticModuleSuffixStart(value)
  if (syntacticSuffixStart === value.length) return { target: value, suffix: '' }

  if (!value.startsWith('file://')) {
    const candidateEnds = [value.length]
    for (let index = value.length - 1; index >= 0; index--) {
      const character = value[index]
      if ((character === '?' || character === '#') && !(character === '#' && index === 0)) {
        candidateEnds.push(index)
      }
    }
    for (const end of candidateEnds) {
      const target = value.slice(0, end)
      if (target && resolveExistingPhysicalTarget(target, options)) {
        return { target, suffix: value.slice(end) }
      }
    }
  }

  return {
    target: value.slice(0, syntacticSuffixStart),
    suffix: value.slice(syntacticSuffixStart),
  }
}

function normalizeGraphFilename(filename: string | undefined): string | null {
  if (!filename || filename === '<unknown>' || filename.startsWith('\0')) return null
  let normalized = splitModuleRequest(filename, { allowPlainRelative: true }).target
  if (normalized.startsWith('/@fs/')) {
    normalized = normalized.slice('/@fs'.length)
  }
  if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      return null
    }
  }
  if (normalized.includes('://') && !/^[a-zA-Z]:[\\/]/.test(normalized)) return null
  return path.resolve(normalized)
}

function isFile(filename: string): boolean {
  try {
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

type LocalModuleResolution =
  | { kind: 'external' }
  | { kind: 'resource' }
  | { kind: 'missing' }
  | { kind: 'file'; filename: string }

function resolveLocalModuleSource(
  source: string,
  importer: string | undefined,
): LocalModuleResolution {
  const normalizedImporter = normalizeGraphFilename(importer)
  const request = splitModuleRequest(source, {
    importer: normalizedImporter ?? undefined,
  })
  if (request.suffix.startsWith('?')) return { kind: 'resource' }
  const rawSource = request.target
  const windowsPath = isWindowsPath(rawSource)
  const isLocal =
    rawSource.startsWith('.') ||
    rawSource.startsWith('/') ||
    rawSource.startsWith('/@fs/') ||
    rawSource.startsWith('file://') ||
    windowsPath
  if (!isLocal) return { kind: 'external' }

  const rawTarget = resolveLocalTargetPath(rawSource, normalizedImporter ?? undefined, false)
  if (!rawTarget) return { kind: 'missing' }

  const extension = path.extname(rawTarget).toLowerCase()
  if (extension && !LOCAL_MODULE_EXTENSION_SET.has(extension)) {
    return { kind: 'missing' }
  }

  const filename = localModuleCandidates(rawTarget).find(isFile)
  return filename
    ? { kind: 'file', filename: canonicalGraphFilename(filename) }
    : { kind: 'missing' }
}

function canonicalGraphFilename(filename: string): string {
  const resolved = path.resolve(filename)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function graphCacheKey(fingerprint: string, filename: string): string {
  return `${fingerprint}\0${canonicalGraphFilename(filename)}`
}

interface GraphModuleResolution {
  metadata: ModuleReactiveMetadata
  resolved: boolean
}

const HOOK_NAME_RE = /^use[A-Z0-9_]/
const FICT_RUNTIME_SOURCES = new Set([
  'fict',
  'fict/advanced',
  'fict/internal',
  'fict/internal/list',
  'fict/jsx-runtime',
  'fict/jsx-dev-runtime',
  'fict/loader',
  'fict/plus',
  'fict/slim',
  '@fictjs/runtime',
  '@fictjs/runtime/advanced',
  '@fictjs/runtime/internal',
  '@fictjs/runtime/internal/list',
  '@fictjs/runtime/jsx-runtime',
  '@fictjs/runtime/jsx-dev-runtime',
  '@fictjs/runtime/loader',
])

const isHookName = (name: string | undefined): boolean => !!name && HOOK_NAME_RE.test(name)
const isNodeBuiltinSource = (source: string): boolean =>
  source.startsWith('node:') || NODE_BUILTIN_SOURCES.has(source)

function requiresHookMetadata(source: string, importer?: string): boolean {
  const normalizedImporter = normalizeGraphFilename(importer)
  const request = splitModuleRequest(source, {
    importer: normalizedImporter ?? undefined,
  })
  if (request.suffix.startsWith('?')) return false
  return !FICT_RUNTIME_SOURCES.has(request.target)
}

function staticMemberName(
  member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
): string | null {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name
  if (t.isStringLiteral(member.property) || t.isNumericLiteral(member.property)) {
    return String(member.property.value)
  }
  return null
}

const moduleExportName = (
  name: BabelCore.types.Identifier | BabelCore.types.StringLiteral,
): string => (t.isIdentifier(name) ? name.name : name.value)

function staticPropertyName(
  property: BabelCore.types.Expression | BabelCore.types.PrivateName,
  computed: boolean,
): string | null {
  if (!computed && t.isIdentifier(property)) return property.name
  if (t.isStringLiteral(property) || t.isNumericLiteral(property)) {
    return String(property.value)
  }
  return null
}

function targetContainsHookName(node: BabelCore.types.Node | null | undefined): boolean {
  if (!node) return false
  if (t.isIdentifier(node)) return isHookName(node.name)
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const memberName = staticMemberName(node)
    return memberName === null || isHookName(memberName)
  }
  if (t.isAssignmentPattern(node)) return targetContainsHookName(node.left)
  if (t.isRestElement(node)) return targetContainsHookName(node.argument)
  if (t.isArrayPattern(node)) {
    return node.elements.some(element => targetContainsHookName(element))
  }
  if (t.isObjectPattern(node)) {
    return node.properties.some(property => {
      if (t.isRestElement(property)) return targetContainsHookName(property.argument)
      const propertyName = staticPropertyName(property.key, property.computed)
      return (
        propertyName === null || isHookName(propertyName) || targetContainsHookName(property.value)
      )
    })
  }
  return false
}

function isTransparentExpressionParent(
  parentPath: BabelCore.NodePath,
  child: BabelCore.types.Node,
): boolean {
  const node = parentPath.node
  return (
    (t.isTSAsExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTSNonNullExpression(node) ||
      t.isTypeCastExpression(node) ||
      t.isParenthesizedExpression(node)) &&
    node.expression === child
  )
}

function expressionFlowsToHookLikeTarget(
  expressionPath: BabelCore.NodePath,
  namespaceValue = false,
  visitedBindings = new Set<object>(),
): boolean {
  let currentPath = expressionPath
  let currentIsNamespace = namespaceValue
  while (currentPath.parentPath) {
    const parentPath = currentPath.parentPath
    if (
      (parentPath.isMemberExpression() || parentPath.isOptionalMemberExpression()) &&
      parentPath.node.object === currentPath.node
    ) {
      const memberName = staticMemberName(parentPath.node)
      if (memberName === null || isHookName(memberName)) return true
      currentPath = parentPath
      currentIsNamespace = false
      continue
    }
    if (isTransparentExpressionParent(parentPath, currentPath.node)) {
      currentPath = parentPath
      continue
    }
    if (parentPath.isCallExpression() && parentPath.node.callee === currentPath.node) {
      currentPath = parentPath
      continue
    }
    if (parentPath.isVariableDeclarator() && parentPath.node.init === currentPath.node) {
      if (targetContainsHookName(parentPath.node.id)) return true
      if (!t.isIdentifier(parentPath.node.id)) return currentIsNamespace
      const binding = parentPath.scope.getBinding(parentPath.node.id.name)
      if (!binding || visitedBindings.has(binding)) return currentIsNamespace
      visitedBindings.add(binding)
      return binding.referencePaths.some(referencePath =>
        expressionFlowsToHookLikeTarget(referencePath, currentIsNamespace, visitedBindings),
      )
    }
    if (parentPath.isAssignmentExpression() && parentPath.node.right === currentPath.node) {
      if (targetContainsHookName(parentPath.node.left)) return true
      if (!t.isIdentifier(parentPath.node.left)) return currentIsNamespace
      const binding = parentPath.scope.getBinding(parentPath.node.left.name)
      if (!binding || visitedBindings.has(binding)) return currentIsNamespace
      visitedBindings.add(binding)
      return binding.referencePaths.some(referencePath =>
        expressionFlowsToHookLikeTarget(referencePath, currentIsNamespace, visitedBindings),
      )
    }
    if (parentPath.isObjectProperty() && parentPath.node.value === currentPath.node) {
      const propertyName = staticPropertyName(parentPath.node.key, parentPath.node.computed)
      return propertyName === null || isHookName(propertyName) || currentIsNamespace
    }
    if (parentPath.isExportSpecifier() && parentPath.node.local === currentPath.node) {
      return isHookName(moduleExportName(parentPath.node.exported))
    }
    return currentIsNamespace
  }
  return currentIsNamespace
}

function expressionFlowsToValueExport(
  expressionPath: BabelCore.NodePath,
  visitedBindings = new Set<object>(),
): boolean {
  let currentPath = expressionPath
  while (currentPath.parentPath) {
    const parentPath = currentPath.parentPath
    if (
      ((parentPath.isMemberExpression() || parentPath.isOptionalMemberExpression()) &&
        parentPath.node.object === currentPath.node) ||
      (parentPath.isCallExpression() && parentPath.node.callee === currentPath.node) ||
      isTransparentExpressionParent(parentPath, currentPath.node)
    ) {
      currentPath = parentPath
      continue
    }
    if (parentPath.isVariableDeclarator() && parentPath.node.init === currentPath.node) {
      if (parentPath.parentPath?.parentPath?.isExportNamedDeclaration()) return true
      if (!t.isIdentifier(parentPath.node.id)) return false
      const binding = parentPath.scope.getBinding(parentPath.node.id.name)
      if (!binding || visitedBindings.has(binding)) return false
      visitedBindings.add(binding)
      return binding.referencePaths.some(referencePath =>
        expressionFlowsToValueExport(referencePath, visitedBindings),
      )
    }
    if (parentPath.isAssignmentExpression() && parentPath.node.right === currentPath.node) {
      if (!t.isIdentifier(parentPath.node.left)) return false
      const binding = parentPath.scope.getBinding(parentPath.node.left.name)
      if (!binding || visitedBindings.has(binding)) return false
      visitedBindings.add(binding)
      return binding.referencePaths.some(referencePath =>
        expressionFlowsToValueExport(referencePath, visitedBindings),
      )
    }
    if (parentPath.isObjectProperty() && parentPath.node.value === currentPath.node) {
      const objectPath = parentPath.parentPath
      if (!objectPath?.isObjectExpression()) return false
      currentPath = objectPath
      continue
    }
    if (
      parentPath.isArrayExpression() &&
      parentPath.node.elements.some(element => element === currentPath.node)
    ) {
      currentPath = parentPath
      continue
    }
    if (parentPath.isExportSpecifier() && parentPath.node.local === currentPath.node) {
      return parentPath.node.exportKind !== 'type'
    }
    return parentPath.isExportDefaultDeclaration()
  }
  return false
}

function createImplicitGraphValidationPlugin(options: {
  fileName: string
  diagnostics: CompilerWarning[]
  resolve(source: string): GraphModuleResolution
  markIncomplete(): void
}): PluginObj {
  const addDiagnostic = (path: BabelCore.NodePath, message: string): void => {
    const loc = path.node.loc?.start
    options.markIncomplete()
    options.diagnostics.push({
      code: DiagnosticCode.FICT_H003,
      message,
      fileName: options.fileName,
      line: loc?.line ?? 0,
      column: loc ? loc.column + 1 : 0,
    })
  }

  return {
    name: 'fict-implicit-graph-validation',
    visitor: {
      Program: {
        exit(programPath) {
          programPath.scope.crawl()
          programPath.traverse({
            ImportDeclaration(importPath) {
              const source = importPath.node.source.value
              if (
                !requiresHookMetadata(source, options.fileName) ||
                options.resolve(source).resolved
              ) {
                return
              }
              for (const specifier of importPath.node.specifiers) {
                if (t.isImportSpecifier(specifier) && specifier.importKind === 'type') continue
                const binding = importPath.scope.getBinding(specifier.local.name)
                if (!binding || binding.referencePaths.length === 0) continue
                if (
                  binding.referencePaths.some(referencePath =>
                    expressionFlowsToValueExport(referencePath),
                  )
                ) {
                  options.markIncomplete()
                }
                if (t.isImportNamespaceSpecifier(specifier)) {
                  const unsafeReference = binding.referencePaths.find(referencePath =>
                    expressionFlowsToHookLikeTarget(referencePath, true),
                  )
                  if (unsafeReference) {
                    addDiagnostic(
                      unsafeReference,
                      'Imported namespace metadata is unavailable or belongs to an unresolved module cycle; provide a graph-aware resolver or break the cycle before using this import.',
                    )
                  }
                  continue
                }
                const hookMemberReference = binding.referencePaths.find(referencePath =>
                  expressionFlowsToHookLikeTarget(referencePath),
                )
                if (hookMemberReference) {
                  addDiagnostic(
                    hookMemberReference,
                    'Imported namespace metadata is unavailable or belongs to an unresolved module cycle; provide a graph-aware resolver or break the cycle before using this import.',
                  )
                  continue
                }
                const importedName = t.isImportSpecifier(specifier)
                  ? t.isIdentifier(specifier.imported)
                    ? specifier.imported.name
                    : specifier.imported.value
                  : 'default'
                if (isHookName(importedName) || isHookName(specifier.local.name)) {
                  addDiagnostic(
                    binding.referencePaths[0]!,
                    'Imported hook metadata is unavailable or belongs to an unresolved module cycle; provide a graph-aware resolver or break the cycle before using this import.',
                  )
                }
              }
            },
            ExportNamedDeclaration(exportPath) {
              const { source } = exportPath.node
              if (!source || exportPath.node.exportKind === 'type') return
              const valueSpecifiers = exportPath.node.specifiers.filter(
                specifier => !t.isExportSpecifier(specifier) || specifier.exportKind !== 'type',
              )
              if (valueSpecifiers.length === 0) return
              const hookLikeExport = valueSpecifiers.some(specifier => {
                if (t.isExportSpecifier(specifier)) {
                  const localName = moduleExportName(
                    specifier.local as BabelCore.types.Identifier | BabelCore.types.StringLiteral,
                  )
                  return isHookName(localName) || isHookName(moduleExportName(specifier.exported))
                }
                return isHookName(specifier.exported.name)
              })
              if (
                !requiresHookMetadata(source.value, options.fileName) ||
                options.resolve(source.value).resolved
              ) {
                return
              }
              options.markIncomplete()
              if (hookLikeExport) {
                addDiagnostic(
                  exportPath,
                  'Re-exported hook metadata is unavailable or belongs to an unresolved module cycle; provide a graph-aware resolver or break the cycle before publishing this module.',
                )
              }
            },
            ExportAllDeclaration(exportPath) {
              const source = exportPath.node.source.value
              if (
                exportPath.node.exportKind !== 'type' &&
                requiresHookMetadata(source, options.fileName) &&
                !options.resolve(source).resolved
              ) {
                options.markIncomplete()
              }
            },
          })
        },
      },
    },
  }
}

function getFileDataStore(file: unknown): BabelFileDataStore {
  return file as BabelFileDataStore
}

function resolveTypeScriptTransformOptions(
  filename: string | undefined,
  options: TypeScriptOptions,
): Record<string, unknown> | null {
  const baseOptions = {
    allowNamespaces: options.allowNamespaces ?? true,
    allowDeclareFields: options.allowDeclareFields ?? true,
    onlyRemoveTypeImports: options.onlyRemoveTypeImports,
    optimizeConstEnums: options.optimizeConstEnums,
    jsxPragma: options.jsxPragma,
    jsxPragmaFrag: options.jsxPragmaFrag,
  }
  if (options.allExtensions) {
    return {
      ...baseOptions,
      isTSX: options.isTSX ?? true,
      allExtensions: true,
      disallowAmbiguousJSXLike: options.disallowAmbiguousJSXLike ?? false,
    }
  }
  if (!filename) return null
  if (TSX_FILENAME_RE.test(filename)) {
    return { ...baseOptions, isTSX: true, allExtensions: true }
  }
  if (TS_FILENAME_RE.test(filename)) {
    return { ...baseOptions, isTSX: false, allExtensions: true }
  }
  if (MTS_FILENAME_RE.test(filename) || CTS_FILENAME_RE.test(filename)) {
    return {
      ...baseOptions,
      isTSX: false,
      allExtensions: true,
      disallowAmbiguousJSXLike: true,
    }
  }
  return null
}

function shouldCompileTypeScriptAsCommonJS(
  filename: string | undefined,
  options: TypeScriptOptions,
): boolean {
  return !options.allExtensions && !!filename && CTS_FILENAME_RE.test(filename)
}

function rewriteTypeScriptExtension(source: string): string {
  if (!/^\.\.?\//.test(source)) return source
  return source.replace(
    /\.(tsx)$|((?:\.d)?)((?:\.[^./]+)?)\.([cm]?)ts$/i,
    (match, tsx: string | undefined, declaration: string, extension: string, cm: string) => {
      if (tsx) return '.js'
      if (declaration && (!extension || !cm)) return match
      return `${declaration}${extension}.${cm.toLowerCase()}js`
    },
  )
}

function createDynamicImportExtensionRewrite(
  expression: BabelCore.types.Expression,
): BabelCore.types.Expression {
  return t.callExpression(
    t.memberExpression(
      t.binaryExpression('+', expression, t.stringLiteral('')),
      t.identifier('replace'),
    ),
    [t.regExpLiteral('^(\\.\\.?\\/.*\\.[mc]?)tsx?$'), t.stringLiteral('$1js')],
  )
}

interface TypeScriptImportEqualsRewriteState {
  sources: WeakSet<BabelCore.types.StringLiteral>
  // TypeScript/Fict lowering can clone the literal. Its exact source span is
  // clone-stable and cannot alias a handwritten require in the same file.
  sourceLocations: Set<string>
}

type ModuleRequestMappings = Map<string, string>

function rewriteStaticModuleRequest(
  source: BabelCore.types.StringLiteral,
  requestMappings: ModuleRequestMappings,
): void {
  const original = source.value
  const emitted = rewriteTypeScriptExtension(original)
  source.value = emitted
  if (emitted !== original) requestMappings.set(original, emitted)
}

function sourceLocationKey(source: BabelCore.types.StringLiteral): string | null {
  const location = source.loc
  if (!location) return null
  return `${location.start.line}:${location.start.column}-${location.end.line}:${location.end.column}`
}

function isTrackedImportEqualsSource(
  state: TypeScriptImportEqualsRewriteState,
  source: BabelCore.types.StringLiteral,
): boolean {
  if (state.sources.has(source)) return true
  const location = sourceLocationKey(source)
  return location !== null && state.sourceLocations.has(location)
}

function trackTypeScriptImportEqualsSources(state: TypeScriptImportEqualsRewriteState): PluginObj {
  return {
    name: 'fict-track-typescript-import-equals-sources',
    visitor: {
      TSImportEqualsDeclaration(importPath) {
        const reference = importPath.node.moduleReference
        if (t.isTSExternalModuleReference(reference)) {
          state.sources.add(reference.expression)
          const location = sourceLocationKey(reference.expression)
          if (location) state.sourceLocations.add(location)
        }
      },
    },
  }
}

function rewriteTypeScriptImportsPlugin(
  importEqualsState: TypeScriptImportEqualsRewriteState | null,
  requestMappings: ModuleRequestMappings,
): PluginObj {
  return {
    name: 'fict-rewrite-typescript-imports',
    visitor: {
      Program: {
        exit(path) {
          path.traverse({
            ImportDeclaration(importPath) {
              rewriteStaticModuleRequest(importPath.node.source, requestMappings)
            },
            ExportAllDeclaration(exportPath) {
              rewriteStaticModuleRequest(exportPath.node.source, requestMappings)
            },
            ExportNamedDeclaration(exportPath) {
              if (exportPath.node.source) {
                rewriteStaticModuleRequest(exportPath.node.source, requestMappings)
              }
            },
            CallExpression(callPath) {
              const source = callPath.node.arguments[0]
              if (
                importEqualsState &&
                t.isIdentifier(callPath.node.callee, { name: 'require' }) &&
                t.isStringLiteral(source) &&
                isTrackedImportEqualsSource(importEqualsState, source)
              ) {
                rewriteStaticModuleRequest(source, requestMappings)
                return
              }
              if (!t.isImport(callPath.node.callee)) return
              if (t.isStringLiteral(source)) {
                source.value = rewriteTypeScriptExtension(source.value)
              } else if (source && t.isExpression(source)) {
                callPath.node.arguments[0] = createDynamicImportExtensionRewrite(source)
              }
            },
            ImportExpression(importPath) {
              const source = importPath.node.source
              if (t.isStringLiteral(source)) {
                source.value = rewriteTypeScriptExtension(source.value)
              } else {
                importPath.node.source = createDynamicImportExtensionRewrite(source)
              }
            },
          })
        },
      },
    },
  }
}

function removeObsoleteJsxPragmaImportsPlugin(options: TypeScriptOptions): PluginObj {
  return {
    name: 'fict-remove-obsolete-jsx-pragma-imports',
    visitor: {
      Program: {
        exit(path, state) {
          let hasJsx = false
          path.traverse({
            'JSXElement|JSXFragment'(jsxPath) {
              hasJsx = true
              jsxPath.stop()
            },
          })
          if (hasJsx) return

          let jsxPragma = options.jsxPragma ?? 'React.createElement'
          let jsxPragmaFrag = options.jsxPragmaFrag ?? 'React.Fragment'
          const pragmaPattern = /\*?\s*@jsx((?:Frag)?)\s+(\S+)/
          for (const comment of state.file.ast.comments ?? []) {
            const match = pragmaPattern.exec(comment.value)
            if (!match) continue
            if (match[1]) jsxPragmaFrag = match[2] ?? jsxPragmaFrag
            else jsxPragma = match[2] ?? jsxPragma
          }
          const pragmaBindings = new Set(
            [jsxPragma, jsxPragmaFrag]
              .map(pragma => pragma.split('.')[0])
              .filter((name): name is string => !!name),
          )
          if (pragmaBindings.size === 0) return

          path.scope.crawl()
          for (const statementPath of path.get('body')) {
            if (!statementPath.isImportDeclaration()) continue
            // Removing the last specifier intentionally leaves a side-effect-only import.
            for (const specifierPath of statementPath.get('specifiers')) {
              const localName = specifierPath.node.local.name
              if (!pragmaBindings.has(localName)) continue
              const binding = path.scope.getBinding(localName)
              if (!binding || binding.referenced) continue
              specifierPath.remove()
            }
          }
        },
      },
    },
  }
}

function commonJsMarkerPlugin(): PluginObj {
  return {
    name: 'fict-inherited-commonjs-marker',
    visitor: {},
    pre() {
      getFileDataStore(this.file).set('@babel/plugin-transform-modules-*', 'commonjs')
    },
  }
}

interface CtsModuleSyntaxState {
  importEquals: { local: string; namespaceLocal: string | null; source: string }[]
  hasExportAssignment: boolean
}

// TypeScript lowering must run before Fict for enums/namespaces/declare fields, but it would also
// erase the static edge and export identity carried by CTS module syntax. Present the callable
// binding as a default import and its member reads through a namespace import during analysis,
// then restore both views to one exact CommonJS binding before Babel's module pass.
function lowerCtsModuleSyntaxForFict(state: CtsModuleSyntaxState): PluginObj {
  return {
    name: 'fict-lower-cts-module-syntax-for-analysis',
    visitor: {
      TSImportEqualsDeclaration(importPath) {
        const { node } = importPath
        if (node.importKind === 'type') {
          importPath.remove()
          return
        }
        if (!t.isTSExternalModuleReference(node.moduleReference)) return

        const source = node.moduleReference.expression.value
        const binding = importPath.scope.getBinding(node.id.name)
        const memberReferences =
          binding?.referencePaths.filter(referencePath => {
            const parent = referencePath.parentPath
            if (!parent) return false
            return (
              (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
              parent.node.object === referencePath.node
            )
          }) ?? []
        const namespaceLocal =
          memberReferences.length > 0
            ? importPath.scope.generateUidIdentifier(`${node.id.name}Namespace`)
            : null
        if (namespaceLocal) {
          for (const referencePath of memberReferences) {
            referencePath.replaceWith(t.cloneNode(namespaceLocal))
          }
        }
        const declaration = t.importDeclaration(
          [
            t.importDefaultSpecifier(t.cloneNode(node.id)),
            ...(namespaceLocal ? [t.importNamespaceSpecifier(t.cloneNode(namespaceLocal))] : []),
          ],
          t.cloneNode(node.moduleReference.expression),
        )
        t.inheritsComments(declaration, node)
        state.importEquals.push({
          local: node.id.name,
          namespaceLocal: namespaceLocal?.name ?? null,
          source,
        })
        if (node.isExport) {
          importPath.replaceWithMultiple([
            declaration,
            t.exportNamedDeclaration(null, [
              t.exportSpecifier(t.cloneNode(node.id), t.cloneNode(node.id)),
            ]),
          ])
        } else {
          importPath.replaceWith(declaration)
        }
      },
      TSExportAssignment(exportPath) {
        state.hasExportAssignment = true
        const declaration = t.exportDefaultDeclaration(exportPath.node.expression)
        t.inheritsComments(declaration, exportPath.node)
        exportPath.replaceWith(declaration)
      },
    },
  }
}

function restoreCtsModuleSyntaxAfterFict(
  state: CtsModuleSyntaxState,
  rewriteImportExtensions: boolean,
  requestMappings: ModuleRequestMappings,
): PluginObj {
  return {
    name: 'fict-restore-cts-commonjs-semantics',
    visitor: {
      Program: {
        exit(programPath) {
          programPath.scope.crawl()
          const pendingImports = new Map(
            state.importEquals.map(entry => [`${entry.source}\0${entry.local}`, entry]),
          )
          let restoredExportAssignment = !state.hasExportAssignment
          for (const statementPath of programPath.get('body')) {
            if (statementPath.isImportDeclaration()) {
              const specifier = statementPath.node.specifiers.find(t.isImportDefaultSpecifier)
              if (!specifier) continue
              const key = `${statementPath.node.source.value}\0${specifier.local.name}`
              const pending = pendingImports.get(key)
              if (!pending) continue
              const namespaceSpecifier = statementPath.node.specifiers.find(
                t.isImportNamespaceSpecifier,
              )
              if (
                statementPath.node.specifiers.length !== (pending.namespaceLocal ? 2 : 1) ||
                namespaceSpecifier?.local.name !== pending.namespaceLocal
              ) {
                continue
              }
              pendingImports.delete(key)
              if (pending.namespaceLocal) {
                const namespaceBinding = statementPath.scope.getBinding(pending.namespaceLocal)
                if (!namespaceBinding?.path.isImportNamespaceSpecifier()) {
                  throw statementPath.buildCodeFrameError(
                    `[fict] CTS import-equals metadata binding "${pending.namespaceLocal}" was lost before CommonJS restoration.`,
                  )
                }
                for (const referencePath of namespaceBinding.referencePaths) {
                  referencePath.replaceWith(t.identifier(pending.local))
                }
              }
              const source = t.cloneNode(statementPath.node.source)
              if (rewriteImportExtensions) {
                rewriteStaticModuleRequest(source, requestMappings)
              }
              const declaration = t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.cloneNode(specifier.local),
                  t.callExpression(t.identifier('require'), [source]),
                ),
              ])
              t.inheritsComments(declaration, statementPath.node)
              statementPath.replaceWith(declaration)
              continue
            }
            if (!restoredExportAssignment && statementPath.isExportDefaultDeclaration()) {
              if (!t.isExpression(statementPath.node.declaration)) {
                throw statementPath.buildCodeFrameError(
                  '[fict] CTS export assignment no longer contains an expression.',
                )
              }
              const expression = statementPath.node.declaration
              const assignment = t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.memberExpression(t.identifier('module'), t.identifier('exports')),
                  expression,
                ),
              )
              t.inheritsComments(assignment, statementPath.node)
              statementPath.replaceWith(assignment)
              restoredExportAssignment = true
            }
          }
          if (!restoredExportAssignment) {
            throw programPath.buildCodeFrameError(
              '[fict] CTS export assignment was lost before CommonJS restoration.',
            )
          }
          programPath.scope.crawl()
        },
      },
    },
  }
}

interface ImplicitGraphPrepassOptions {
  fingerprint: string
  metadataOnly: boolean
  presetOptions: FictPresetOptions
  sessionId?: string
}

function inheritedParserPluginsFromFile(
  file: BabelCore.BabelFile,
): NonNullable<NonNullable<TransformOptions['parserOpts']>['plugins']> {
  const plugins = file.opts.parserOpts?.plugins ?? []
  return plugins.filter(plugin => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin
    // Let the nested preset choose TS/TSX from the dependency filename. All
    // other syntax capabilities came from the caller's Babel pipeline and are
    // required to parse the dependency under the same language contract.
    return name !== 'typescript' && name !== 'jsx'
  })
}

function createIsolatedFictPrepass(
  compilerOptions: FictCompilerOptions,
  typescript: boolean,
  typescriptOptions: TypeScriptOptions,
  graphOptions: ImplicitGraphPrepassOptions,
): PluginObj {
  return {
    name: 'fict-isolated-prepass',
    visitor: {},
    pre(file) {
      const graphEnabled = !compilerOptions.moduleMetadata && !compilerOptions.resolveModuleMetadata
      const validateMetadata = graphEnabled || compilerOptions.validateIntegrationMetadata === true
      const graphSessionId = graphOptions.sessionId ?? createImplicitGraphSessionId()
      const ownsGraphSession = graphEnabled && graphOptions.sessionId === undefined
      let graphSession = implicitGraphSessions.get(graphSessionId)
      if (!graphSession) {
        graphSession = { metadata: new Map(), compilerMetadata: new Map(), compiling: new Set() }
        if (graphEnabled) implicitGraphSessions.set(graphSessionId, graphSession)
      }
      const currentFilename = normalizeGraphFilename(file.opts.filename ?? undefined)
      const currentSourceHash = hashText(file.code)
      const currentGraphKey = currentFilename
        ? graphCacheKey(graphOptions.fingerprint, currentFilename)
        : null
      const ownsGraphCompilation =
        graphEnabled && !!currentGraphKey && !graphSession.compiling.has(currentGraphKey)
      if (ownsGraphCompilation && currentGraphKey) {
        graphSession.compiling.add(currentGraphKey)
      }
      let currentMetadataIncomplete = false
      const integrationDiagnostics = [...(compilerOptions.integrationDiagnostics ?? [])]
      const markCurrentMetadataIncomplete = (): void => {
        if (currentMetadataIncomplete) return
        currentMetadataIncomplete = true
        if (currentFilename) invalidateModuleMetadata(currentFilename, compilerOptions)
      }
      const resolveGraphModule = (
        source: string,
        importer: string | undefined,
      ): GraphModuleResolution => {
        if (!graphEnabled) {
          if (isNodeBuiltinSource(source.split('#', 1)[0]!)) {
            return { metadata: OPAQUE_MODULE_METADATA, resolved: true }
          }
          const metadata = resolveCompilerModuleMetadata(source, importer, compilerOptions)
          return metadata
            ? { metadata, resolved: true }
            : { metadata: OPAQUE_MODULE_METADATA, resolved: false }
        }
        const localResolution = resolveLocalModuleSource(source, importer)
        if (localResolution.kind === 'resource') {
          return { metadata: OPAQUE_MODULE_METADATA, resolved: true }
        }
        if (localResolution.kind === 'external' && isNodeBuiltinSource(source.split('#', 1)[0]!)) {
          return { metadata: OPAQUE_MODULE_METADATA, resolved: true }
        }
        if (localResolution.kind === 'external' || localResolution.kind === 'missing') {
          const metadata = resolveCompilerModuleMetadata(source, importer, compilerOptions)
          return metadata
            ? { metadata, resolved: true }
            : { metadata: OPAQUE_MODULE_METADATA, resolved: false }
        }

        const dependencyFilename = localResolution.filename
        const dependencySource = readFileSync(dependencyFilename, 'utf8')
        const dependencySourceHash = hashText(dependencySource)
        const dependencyGraphKey = graphCacheKey(graphOptions.fingerprint, dependencyFilename)
        const cached = graphSession.metadata.get(dependencyGraphKey)
        if (cached?.sourceHash === dependencySourceHash) {
          // Incomplete graph entries are partial, not empty. Their known
          // reactive exports are safe to consume while `resolved: false`
          // still prevents callers from publishing them as complete metadata.
          return { metadata: cached.metadata, resolved: !cached.incomplete }
        }
        if (graphSession.compiling.has(dependencyGraphKey)) {
          return { metadata: OPAQUE_MODULE_METADATA, resolved: false }
        }

        const inheritedParserPlugins = inheritedParserPluginsFromFile(file)
        const nestedOptions: InternalFictPresetOptions = {
          ...graphOptions.presetOptions,
          emitModuleMetadata: false,
          explain: false,
          sourcemap: false,
          __fictGraphFingerprint: graphOptions.fingerprint,
          __fictMetadataOnly: true,
          __fictGraphSession: graphSessionId,
        }
        transformSync(dependencySource, {
          filename: dependencyFilename,
          cwd: file.opts.cwd,
          envName: file.opts.envName,
          configFile: false,
          babelrc: false,
          sourceType: 'unambiguous',
          ...(inheritedParserPlugins.length > 0
            ? { parserOpts: { plugins: inheritedParserPlugins } }
            : {}),
          presets: [[fictPreset, nestedOptions]],
        })

        const prepared = graphSession.metadata.get(dependencyGraphKey)
        return prepared?.sourceHash === dependencySourceHash
          ? { metadata: prepared.metadata, resolved: !prepared.incomplete }
          : { metadata: OPAQUE_MODULE_METADATA, resolved: false }
      }
      const effectiveCompilerOptions: FictCompilerOptions = validateMetadata
        ? {
            ...compilerOptions,
            integrationDiagnostics,
            ...(graphEnabled
              ? {
                  emitModuleMetadata: false,
                  moduleMetadata: graphSession.compilerMetadata,
                  resolveModuleMetadata: (source: string, importer?: string) =>
                    resolveGraphModule(source, importer).metadata,
                }
              : {}),
          }
        : compilerOptions
      const plugins: NonNullable<TransformOptions['plugins']> = []
      const requestMappings: ModuleRequestMappings = new Map()
      const typeScriptTransformOptions = typescript
        ? resolveTypeScriptTransformOptions(file.opts.filename ?? undefined, typescriptOptions)
        : null
      const compileAsCommonJS =
        !!typeScriptTransformOptions &&
        shouldCompileTypeScriptAsCommonJS(file.opts.filename ?? undefined, typescriptOptions)
      const ctsModuleSyntax: CtsModuleSyntaxState | null = compileAsCommonJS
        ? { importEquals: [], hasExportAssignment: false }
        : null
      const importEqualsRewriteState: TypeScriptImportEqualsRewriteState | null =
        typeScriptTransformOptions &&
        typescriptOptions.rewriteImportExtensions === true &&
        !ctsModuleSyntax
          ? { sources: new WeakSet(), sourceLocations: new Set() }
          : null
      if (ctsModuleSyntax) plugins.push(lowerCtsModuleSyntaxForFict(ctsModuleSyntax))
      if (importEqualsRewriteState) {
        plugins.push(trackTypeScriptImportEqualsSources(importEqualsRewriteState))
      }
      if (typeScriptTransformOptions) {
        if (getFileDataStore(this.file).get('@babel/plugin-transform-modules-*') === 'commonjs') {
          plugins.push(commonJsMarkerPlugin)
        }
        plugins.push([transformTypeScript, typeScriptTransformOptions])
      }
      if (validateMetadata) {
        if (currentFilename) graphSession.compilerMetadata.delete(currentFilename)
        plugins.push(
          createImplicitGraphValidationPlugin({
            fileName: file.opts.filename ?? '<unknown>',
            diagnostics: integrationDiagnostics,
            resolve: source =>
              resolveGraphModule(source, currentFilename ?? file.opts.filename ?? undefined),
            markIncomplete: markCurrentMetadataIncomplete,
          }),
        )
      }
      plugins.push([createFictPlugin, effectiveCompilerOptions])
      if (ctsModuleSyntax) {
        plugins.push(
          restoreCtsModuleSyntaxAfterFict(
            ctsModuleSyntax,
            typescriptOptions.rewriteImportExtensions === true,
            requestMappings,
          ),
        )
      }
      if (typeScriptTransformOptions && typescriptOptions.onlyRemoveTypeImports !== true) {
        plugins.push(removeObsoleteJsxPragmaImportsPlugin(typescriptOptions))
      }
      if (typeScriptTransformOptions && typescriptOptions.rewriteImportExtensions) {
        plugins.push(rewriteTypeScriptImportsPlugin(importEqualsRewriteState, requestMappings))
      }
      if (compileAsCommonJS) {
        plugins.push([transformModulesCommonJS, { allowTopLevelThis: true }])
      }

      let inner: ReturnType<typeof transformFromAstSync>
      try {
        inner = transformFromAstSync(file.ast, file.code, {
          filename: file.opts.filename,
          cwd: file.opts.cwd,
          envName: file.opts.envName,
          sourceType: file.opts.sourceType,
          caller: file.opts.caller,
          assumptions: file.opts.assumptions,
          configFile: false,
          babelrc: false,
          ast: true,
          code: false,
          cloneInputAst: true,
          plugins,
        })
        if (graphEnabled && currentFilename) {
          const moduleMetadata = graphSession.compilerMetadata.get(currentFilename)
          if (moduleMetadata) {
            graphSession.metadata.set(currentGraphKey!, {
              sourceHash: currentSourceHash,
              metadata: moduleMetadata,
              incomplete: currentMetadataIncomplete,
            })
            if (!graphOptions.metadataOnly && !currentMetadataIncomplete) {
              setModuleMetadata(currentFilename, moduleMetadata, compilerOptions)
            }
          }
        }
      } catch (error) {
        const filename = file.opts.filename
        if (error instanceof Error && filename && error.message.startsWith(`${filename}: `)) {
          error.message = error.message.slice(filename.length + 2)
        }
        throw error
      } finally {
        if (ownsGraphCompilation && currentGraphKey) {
          graphSession.compiling.delete(currentGraphKey)
        }
        if (ownsGraphSession) {
          implicitGraphSessions.delete(graphSessionId)
        }
      }
      if (!inner?.ast) {
        throw new Error(
          `[fict] Isolated compiler prepass returned no AST for ${file.opts.filename}.`,
        )
      }

      file.path.replaceWith(inner.ast.program)
      if (inner.ast.comments !== undefined) file.ast.comments = inner.ast.comments
      Object.assign(file.metadata, inner.metadata)
      if (requestMappings.size > 0) {
        Object.assign(file.metadata, {
          fictModuleRequestMappings: [...requestMappings].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        })
      }
      if (validateMetadata) {
        Object.assign(file.metadata, { fictModuleMetadataIncomplete: currentMetadataIncomplete })
      }
      file.path.scope.crawl()
    },
  }
}

/**
 * Babel preset for Fict.
 *
 * Includes:
 * - @babel/plugin-transform-typescript (optional, enabled by default)
 * - @babel/plugin-syntax-jsx
 * - @fictjs/compiler
 *
 * @example
 * ```js
 * // babel.config.js
 * module.exports = {
 *   presets: ['@fictjs/babel-preset']
 * }
 * ```
 *
 * @example
 * ```js
 * // With options
 * module.exports = {
 *   presets: [
 *     ['@fictjs/babel-preset', {
 *       dev: true,
 *       typescript: true,
 *     }]
 *   ]
 * }
 * ```
 */
export default function fictPreset(
  api: ConfigAPI,
  options: FictPresetOptions = {},
): TransformOptions {
  api.assertVersion(7)

  const {
    typescript = true,
    typescriptOptions = {},
    __fictGraphFingerprint,
    __fictMetadataOnly = false,
    __fictGraphSession,
    ...compilerOptions
  } = options as InternalFictPresetOptions
  const graphFingerprint =
    __fictGraphFingerprint ??
    createGraphOptionsFingerprint(compilerOptions, typescript, typescriptOptions)

  const allExtensions = typescriptOptions.allExtensions ?? false
  const isTSX = typescriptOptions.isTSX ?? true

  const plugins: TransformOptions['plugins'] = []
  const overrides: TransformOptions['overrides'] = []
  // The outer pass only enables parsing. Runtime TypeScript and Fict transforms run in
  // an isolated prepass before any sibling plugin can consume macros or JSX.
  if (typescript) {
    if (allExtensions) {
      plugins.push([
        syntaxTypeScript,
        {
          isTSX,
          disallowAmbiguousJSXLike: typescriptOptions.disallowAmbiguousJSXLike ?? false,
        },
      ])
    } else {
      overrides.push(
        {
          test: TSX_FILENAME_RE,
          plugins: [[syntaxTypeScript, { isTSX: true }]],
        },
        {
          test: TS_FILENAME_RE,
          plugins: [[syntaxTypeScript, { isTSX: false }]],
        },
        {
          test: MTS_FILENAME_RE,
          sourceType: 'module',
          plugins: [
            [
              syntaxTypeScript,
              {
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            ],
          ],
        },
        {
          test: CTS_FILENAME_RE,
          sourceType: 'unambiguous',
          plugins: [
            [
              syntaxTypeScript,
              {
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            ],
          ],
        },
      )
    }
  }

  // Add JSX syntax plugin
  plugins.push([syntaxJsx, {}])

  // Compile Fict in `pre`, before sibling visitors in the outer Babel pass.
  plugins.push(
    createIsolatedFictPrepass(compilerOptions, typescript, typescriptOptions, {
      fingerprint: graphFingerprint,
      metadataOnly: __fictMetadataOnly,
      ...(__fictGraphSession ? { sessionId: __fictGraphSession } : {}),
      presetOptions: {
        ...compilerOptions,
        typescript,
        typescriptOptions,
      },
    }),
  )

  return {
    plugins,
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(compilerOptions.sourcemap !== undefined ? { sourceMaps: compilerOptions.sourcemap } : {}),
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
