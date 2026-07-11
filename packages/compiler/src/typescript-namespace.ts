import type * as BabelCore from '@babel/core'

import { isRuntimeImportModule } from './constants'
import { getRuntimeReactiveCreatorKind } from './ir/codegen-reactive-kind'
import { isComponentName, isHookName } from './ir/hook-utils'
import { resolveModuleMetadata } from './module-metadata'
import { MODULE_REACTIVE_METADATA_VERSION } from './types'
import type {
  FictCompilerOptions,
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ReactiveExportKind,
} from './types'

export interface TypeScriptNamespaceAnalysis {
  localNamespaces: Map<string, ModuleReactiveMetadata>
  namespaceNames: Set<string>
}

type NamespacePath = BabelCore.NodePath<BabelCore.types.TSModuleDeclaration>
type CallPath = BabelCore.NodePath<
  BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
>

interface NamespaceAnalysisContext {
  filename: string | undefined
  options: FictCompilerOptions
  t: typeof BabelCore.types
}

function createMetadata(): ModuleReactiveMetadata {
  return {
    version: MODULE_REACTIVE_METADATA_VERSION,
    exports: {},
  }
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function getOwnRecordValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined
  return record[key]
}

function mergeMetadata(target: ModuleReactiveMetadata, source: ModuleReactiveMetadata): void {
  for (const [key, value] of Object.entries(source.exports)) {
    setRecordValue(target.exports, key, value)
  }
  if (source.hooks) {
    target.hooks = target.hooks ?? {}
    for (const [key, value] of Object.entries(source.hooks)) {
      setRecordValue(target.hooks, key, value)
    }
  }
  if (source.namespaces) {
    target.namespaces = target.namespaces ?? {}
    for (const [key, value] of Object.entries(source.namespaces)) {
      const existing = getOwnRecordValue(target.namespaces, key)
      if (existing) mergeMetadata(existing, value)
      else setRecordValue(target.namespaces, key, value)
    }
  }
}

function metadataHasContent(metadata: ModuleReactiveMetadata): boolean {
  return (
    Object.keys(metadata.exports).length > 0 ||
    Object.keys(metadata.hooks ?? {}).length > 0 ||
    Object.keys(metadata.namespaces ?? {}).length > 0
  )
}

function compactHookInfo(info: HookReturnInfoSerializable): HookReturnInfoSerializable {
  return {
    ...(info.directAccessor ? { directAccessor: info.directAccessor } : null),
    ...(info.objectProps && Object.keys(info.objectProps).length > 0
      ? { objectProps: info.objectProps }
      : null),
    ...(info.arrayProps && Object.keys(info.arrayProps).length > 0
      ? { arrayProps: info.arrayProps }
      : null),
  }
}

function importDeclarationForBinding(
  binding: NonNullable<ReturnType<BabelCore.NodePath['scope']['getBinding']>>,
): BabelCore.NodePath<BabelCore.types.ImportDeclaration> | null {
  const declaration = binding.path.findParent(parent => parent.isImportDeclaration())
  return declaration?.isImportDeclaration() ? declaration : null
}

function importedSpecifierName(
  path: BabelCore.NodePath<BabelCore.types.ImportSpecifier>,
  t: typeof BabelCore.types,
): string {
  return t.isIdentifier(path.node.imported)
    ? path.node.imported.name
    : String(path.node.imported.value)
}

function unwrapCallee(
  callee:
    | BabelCore.types.CallExpression['callee']
    | BabelCore.types.OptionalCallExpression['callee'],
  t: typeof BabelCore.types,
): BabelCore.types.CallExpression['callee'] | BabelCore.types.OptionalCallExpression['callee'] {
  if (t.isSequenceExpression(callee) && callee.expressions.length > 0) {
    return unwrapCallee(callee.expressions[callee.expressions.length - 1]!, t)
  }
  if (t.isParenthesizedExpression(callee)) return unwrapCallee(callee.expression, t)
  if (
    t.isTSAsExpression(callee) ||
    t.isTSTypeAssertion(callee) ||
    t.isTSNonNullExpression(callee)
  ) {
    return unwrapCallee(callee.expression, t)
  }
  return callee
}

function classifyReactiveCall(
  callPath: CallPath,
  t: typeof BabelCore.types,
): ReactiveExportKind | null {
  const callee = unwrapCallee(callPath.node.callee, t)
  if (t.isIdentifier(callee)) {
    const binding = callPath.scope.getBinding(callee.name)
    if (!binding || !binding.path.isImportSpecifier()) return null
    const declaration = importDeclarationForBinding(binding)
    const source = declaration?.node.source.value
    if (!source || !isRuntimeImportModule(source)) return null
    const importedName = importedSpecifierName(binding.path, t)
    if (importedName === '$state') return 'signal'
    return getRuntimeReactiveCreatorKind(importedName, source)
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null
  if (!t.isIdentifier(callee.object)) return null
  const binding = callPath.scope.getBinding(callee.object.name)
  if (!binding || !binding.path.isImportNamespaceSpecifier()) return null
  const declaration = importDeclarationForBinding(binding)
  const source = declaration?.node.source.value
  if (!source || !isRuntimeImportModule(source)) return null
  const property = callee.property
  const name = !callee.computed
    ? t.isIdentifier(property)
      ? property.name
      : null
    : t.isStringLiteral(property)
      ? property.value
      : null
  if (!name) return null
  if (name === '$state') return 'signal'
  return getRuntimeReactiveCreatorKind(name, source)
}

function directCallPath(path: BabelCore.NodePath): CallPath | null {
  let current = path
  while (
    current.isParenthesizedExpression() ||
    current.isTSAsExpression() ||
    current.isTSTypeAssertion() ||
    current.isTSNonNullExpression() ||
    current.isTSSatisfiesExpression()
  ) {
    current = current.get('expression') as BabelCore.NodePath
  }
  return current.isCallExpression() || current.isOptionalCallExpression()
    ? (current as CallPath)
    : null
}

function collectReactiveCalls(
  path: BabelCore.NodePath,
  t: typeof BabelCore.types,
): { path: CallPath; kind: ReactiveExportKind }[] {
  const calls: { path: CallPath; kind: ReactiveExportKind }[] = []
  path.traverse({
    Function(innerPath) {
      innerPath.skip()
    },
    'CallExpression|OptionalCallExpression'(candidatePath) {
      const callPath = candidatePath as CallPath
      const kind = classifyReactiveCall(callPath, t)
      if (kind) calls.push({ path: callPath, kind })
    },
  })
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    const callPath = path as CallPath
    const kind = classifyReactiveCall(callPath, t)
    if (kind) calls.unshift({ path: callPath, kind })
  }
  return calls
}

function staticObjectKey(
  property: BabelCore.types.ObjectProperty,
  t: typeof BabelCore.types,
): string | null {
  if (!property.computed && t.isIdentifier(property.key)) return property.key.name
  if (t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)) {
    return String(property.key.value)
  }
  return null
}

function analyzeHookReturn(
  functionPath: BabelCore.NodePath<BabelCore.types.Function>,
  context: NamespaceAnalysisContext,
): HookReturnInfoSerializable | null {
  const { t } = context
  const reactiveLocals = new Map<string, ReactiveExportKind>()
  const reactiveCalls: CallPath[] = []
  functionPath.traverse({
    Function(innerPath) {
      if (innerPath !== functionPath) innerPath.skip()
    },
    VariableDeclarator(declarationPath) {
      if (!t.isIdentifier(declarationPath.node.id) || !declarationPath.node.init) return
      const initPath = declarationPath.get('init') as BabelCore.NodePath
      const callPath = directCallPath(initPath)
      if (!callPath) return
      const kind = classifyReactiveCall(callPath, t)
      if (!kind) return
      reactiveLocals.set(declarationPath.node.id.name, kind)
      reactiveCalls.push(callPath)
    },
    'CallExpression|OptionalCallExpression'(candidatePath) {
      const callPath = candidatePath as CallPath
      if (!classifyReactiveCall(callPath, t)) return
      if (!reactiveCalls.some(existing => existing.node === callPath.node)) {
        reactiveCalls.push(callPath)
      }
    },
  })
  const returns: BabelCore.NodePath<BabelCore.types.ReturnStatement>[] = []
  functionPath.traverse({
    Function(innerPath) {
      if (innerPath !== functionPath) innerPath.skip()
    },
    ReturnStatement(returnPath) {
      returns.push(returnPath)
    },
  })
  const returnContainsReactiveReference = returns.some(returnPath => {
    const argumentPath = returnPath.get('argument') as BabelCore.NodePath | null
    if (!argumentPath?.node) return false
    if (reactiveBindingKind(argumentPath, context)) return true
    let found = false
    argumentPath.traverse({
      Function(innerPath) {
        innerPath.skip()
      },
      ReferencedIdentifier(identifierPath) {
        if (!reactiveBindingKind(identifierPath, context)) return
        found = true
        identifierPath.stop()
      },
    })
    return found
  })
  if (returns.length !== 1 && (reactiveCalls.length > 0 || returnContainsReactiveReference)) {
    throw functionPath.buildCodeFrameError(
      'Reactive hooks inside TypeScript namespaces must have one statically analyzable return. ' +
        'Move the hook to module scope or return one stable accessor shape.',
    )
  }
  if (returns.length !== 1) return null

  const argumentPath = returns[0]!.get('argument') as BabelCore.NodePath | null
  const argument = argumentPath?.node
  const info: HookReturnInfoSerializable = {}
  const valueKind = (path: BabelCore.NodePath): ReactiveExportKind | undefined => {
    if (path.isIdentifier()) {
      return reactiveLocals.get(path.node.name) ?? reactiveBindingKind(path, context) ?? undefined
    }
    return reactiveBindingKind(path, context) ?? undefined
  }
  if (
    argumentPath?.isIdentifier() ||
    argumentPath?.isMemberExpression() ||
    argumentPath?.isOptionalMemberExpression()
  ) {
    const kind = valueKind(argumentPath)
    if (kind) info.directAccessor = kind
  } else if (argumentPath?.isObjectExpression() && t.isObjectExpression(argument)) {
    const propertyPaths = argumentPath.get('properties')
    for (let index = 0; index < argument.properties.length; index++) {
      const property = argument.properties[index]
      const propertyPath = propertyPaths[index]
      if (!propertyPath?.isObjectProperty() || !t.isObjectProperty(property)) {
        continue
      }
      const valuePath = propertyPath.get('value') as BabelCore.NodePath
      const key = staticObjectKey(property, t)
      const kind = valueKind(valuePath)
      if (!key || !kind) continue
      info.objectProps = info.objectProps ?? {}
      setRecordValue(info.objectProps, key, kind)
    }
  } else if (argumentPath?.isArrayExpression() && t.isArrayExpression(argument)) {
    const elementPaths = argumentPath.get('elements')
    argument.elements.forEach((element, index) => {
      const elementPath = elementPaths[index]
      if (!element || !t.isExpression(element) || !elementPath?.isExpression()) return
      const kind = valueKind(elementPath)
      if (!kind) return
      info.arrayProps = info.arrayProps ?? {}
      setRecordValue(info.arrayProps, String(index), kind)
    })
  }

  if (
    !info.directAccessor &&
    Object.keys(info.objectProps ?? {}).length === 0 &&
    Object.keys(info.arrayProps ?? {}).length === 0
  ) {
    if (reactiveCalls.length === 0) return null
    throw functionPath.buildCodeFrameError(
      'Reactive hooks inside TypeScript namespaces must return their accessors directly or in a ' +
        'static object/array shape. Move the hook to module scope when its return shape is dynamic.',
    )
  }
  return info
}

function staticMemberPath(
  expressionPath: BabelCore.NodePath,
  t: typeof BabelCore.types,
): { rootPath: BabelCore.NodePath<BabelCore.types.Identifier>; members: string[] } | null {
  if (expressionPath.isIdentifier()) {
    return { rootPath: expressionPath, members: [] }
  }
  if (!expressionPath.isMemberExpression() && !expressionPath.isOptionalMemberExpression()) {
    return null
  }
  const objectPath = staticMemberPath(expressionPath.get('object') as BabelCore.NodePath, t)
  if (!objectPath) return null
  const property = expressionPath.node.property
  const name = !expressionPath.node.computed
    ? t.isIdentifier(property)
      ? property.name
      : null
    : t.isStringLiteral(property) || t.isNumericLiteral(property) || t.isBigIntLiteral(property)
      ? String(property.value)
      : null
  return name === null
    ? null
    : { rootPath: objectPath.rootPath, members: [...objectPath.members, name] }
}

function importedMemberMetadata(
  expressionPath: BabelCore.NodePath,
  context: NamespaceAnalysisContext,
): { metadata: ModuleReactiveMetadata; key: string } | null {
  const memberPath = staticMemberPath(expressionPath, context.t)
  if (!memberPath || memberPath.members.length === 0) return null
  const binding = memberPath.rootPath.scope.getBinding(memberPath.rootPath.node.name)
  if (!binding) return null
  const declaration = importDeclarationForBinding(binding)
  if (!declaration) return null
  const moduleMetadata = resolveModuleMetadata(
    declaration.node.source.value,
    context.filename,
    context.options,
  )
  if (!moduleMetadata) return null
  let metadata: ModuleReactiveMetadata | undefined
  if (binding.path.isImportNamespaceSpecifier()) {
    metadata = moduleMetadata
  } else if (binding.path.isImportSpecifier()) {
    metadata = getOwnRecordValue(
      moduleMetadata.namespaces,
      importedSpecifierName(binding.path, context.t),
    )
  } else if (binding.path.isImportDefaultSpecifier()) {
    metadata = getOwnRecordValue(moduleMetadata.namespaces, 'default')
  }
  if (!metadata) return null
  for (let index = 0; index < memberPath.members.length - 1; index++) {
    metadata = getOwnRecordValue(metadata.namespaces, memberPath.members[index]!)
    if (!metadata) return null
  }
  return { metadata, key: memberPath.members[memberPath.members.length - 1]! }
}

function reactiveBindingKind(
  expressionPath: BabelCore.NodePath,
  context: NamespaceAnalysisContext,
): ReactiveExportKind | null {
  const { t } = context
  if (!expressionPath.isIdentifier()) {
    const importedMember = importedMemberMetadata(expressionPath, context)
    return importedMember
      ? (getOwnRecordValue(importedMember.metadata.exports, importedMember.key) ?? null)
      : null
  }
  const binding = expressionPath.scope.getBinding(expressionPath.node.name)
  if (!binding) return null
  if (binding.path.isVariableDeclarator()) {
    const initPath = binding.path.get('init') as BabelCore.NodePath | null
    if (!initPath?.node) return null
    const callPath = directCallPath(initPath)
    return callPath ? classifyReactiveCall(callPath, t) : null
  }
  const declaration = importDeclarationForBinding(binding)
  if (!declaration) return null
  const metadata = resolveModuleMetadata(
    declaration.node.source.value,
    context.filename,
    context.options,
  )
  if (!metadata) return null
  if (binding.path.isImportSpecifier()) {
    return getOwnRecordValue(metadata.exports, importedSpecifierName(binding.path, t)) ?? null
  }
  if (binding.path.isImportDefaultSpecifier()) {
    return getOwnRecordValue(metadata.exports, 'default') ?? null
  }
  return null
}

function referencedHookInfo(
  expressionPath: BabelCore.NodePath,
  context: NamespaceAnalysisContext,
): HookReturnInfoSerializable | null {
  const { t } = context
  if (!expressionPath.isIdentifier()) {
    const importedMember = importedMemberMetadata(expressionPath, context)
    return importedMember
      ? (getOwnRecordValue(importedMember.metadata.hooks, importedMember.key) ?? null)
      : null
  }
  const binding = expressionPath.scope.getBinding(expressionPath.node.name)
  if (!binding) return null
  if (binding.path.isFunctionDeclaration()) {
    return analyzeHookReturn(binding.path, context)
  }
  if (binding.path.isVariableDeclarator()) {
    const initPath = binding.path.get('init') as BabelCore.NodePath | null
    return initPath?.isFunction() ? analyzeHookReturn(initPath, context) : null
  }
  const declaration = importDeclarationForBinding(binding)
  if (!declaration) return null
  const metadata = resolveModuleMetadata(
    declaration.node.source.value,
    context.filename,
    context.options,
  )
  if (binding.path.isImportSpecifier()) {
    return getOwnRecordValue(metadata?.hooks, importedSpecifierName(binding.path, t)) ?? null
  }
  if (binding.path.isImportDefaultSpecifier()) {
    return getOwnRecordValue(metadata?.hooks, 'default') ?? null
  }
  return null
}

function functionContainsReactiveCall(
  functionPath: BabelCore.NodePath<BabelCore.types.Function>,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  functionPath.traverse({
    Function(innerPath) {
      if (innerPath !== functionPath) innerPath.skip()
    },
    'CallExpression|OptionalCallExpression'(candidatePath) {
      if (!classifyReactiveCall(candidatePath as CallPath, t)) return
      found = true
      candidatePath.stop()
    },
  })
  return found
}

function isExportedStatement(path: BabelCore.NodePath): boolean {
  return path.parentPath?.isExportNamedDeclaration() === true
}

function namespaceName(
  declaration: BabelCore.types.TSModuleDeclaration,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(declaration.id)) return declaration.id.name
  if (t.isStringLiteral(declaration.id)) return declaration.id.value
  return null
}

function analyzeNamespace(
  namespacePath: NamespacePath,
  analysis: TypeScriptNamespaceAnalysis,
  context: NamespaceAnalysisContext,
): ModuleReactiveMetadata {
  const { t } = context
  const metadata = createMetadata()
  const bodyPath = namespacePath.get('body')
  if (!bodyPath.isTSModuleBlock()) {
    const nestedPath = bodyPath as NamespacePath
    const nestedName = namespaceName(nestedPath.node, t)
    if (nestedName) {
      analysis.namespaceNames.add(nestedName)
      metadata.namespaces = metadata.namespaces ?? {}
      setRecordValue(
        metadata.namespaces,
        nestedName,
        analyzeNamespace(nestedPath, analysis, context),
      )
    }
    return metadata
  }

  for (const rawStatementPath of bodyPath.get('body')) {
    const statementPath = rawStatementPath.isExportNamedDeclaration()
      ? (rawStatementPath.get('declaration') as BabelCore.NodePath | null)
      : rawStatementPath
    if (!statementPath?.node) continue
    const exported =
      rawStatementPath.isExportNamedDeclaration() || isExportedStatement(statementPath)

    if (statementPath.isTSModuleDeclaration()) {
      const name = namespaceName(statementPath.node, t)
      if (!name) continue
      analysis.namespaceNames.add(name)
      const nested = analyzeNamespace(statementPath, analysis, context)
      if (exported && metadataHasContent(nested)) {
        metadata.namespaces = metadata.namespaces ?? {}
        const existing = getOwnRecordValue(metadata.namespaces, name)
        if (existing) mergeMetadata(existing, nested)
        else setRecordValue(metadata.namespaces, name, nested)
      }
      continue
    }

    if (statementPath.isFunctionDeclaration()) {
      const name = statementPath.node.id?.name
      if (!name) continue
      if (!exported || !isHookName(name)) continue
      const hookInfo = analyzeHookReturn(statementPath, context)
      if (hookInfo) {
        metadata.hooks = metadata.hooks ?? {}
        setRecordValue(metadata.hooks, name, compactHookInfo(hookInfo))
      }
      continue
    }

    if (!statementPath.isVariableDeclaration()) continue
    for (const declarationPath of statementPath.get('declarations')) {
      if (!t.isIdentifier(declarationPath.node.id) || !declarationPath.node.init) continue
      const initPath = declarationPath.get('init') as BabelCore.NodePath
      const directCall = directCallPath(initPath)
      const directKind = directCall ? classifyReactiveCall(directCall, t) : null
      const nestedReactiveCalls = collectReactiveCalls(initPath, t)
      const name = declarationPath.node.id.name

      if (isHookName(name) && initPath.isFunction()) {
        const hookInfo = analyzeHookReturn(initPath, context)
        if (hookInfo || functionContainsReactiveCall(initPath, t)) {
          throw declarationPath.buildCodeFrameError(
            `Reactive TypeScript namespace hook "${name}" must use an exported function ` +
              'declaration. Function-valued namespace members cannot preserve hook identity safely.',
          )
        }
      }
      if (
        isComponentName(name) &&
        initPath.isFunction() &&
        functionContainsReactiveCall(initPath, t)
      ) {
        throw declarationPath.buildCodeFrameError(
          `Reactive TypeScript namespace component "${name}" must use an exported function ` +
            'declaration. Function-valued namespace members cannot preserve component state safely.',
        )
      }

      if (nestedReactiveCalls.length > 0 && !directKind) {
        throw declarationPath.buildCodeFrameError(
          `Reactive TypeScript namespace member "${name}" must be initialized by a direct ` +
            'Fict reactive creator call. Move derived/aliased state to module scope.',
        )
      }
      if (!exported) continue
      if (directKind) {
        setRecordValue(metadata.exports, name, directKind)
        continue
      }
      const aliasKind = reactiveBindingKind(initPath, context)
      if (aliasKind) {
        throw declarationPath.buildCodeFrameError(
          `Reactive TypeScript namespace member "${name}" cannot alias an accessor. ` +
            'Initialize it with a direct Fict reactive creator call or move it to module scope.',
        )
      }
      if (isHookName(name)) {
        const hookInfo = referencedHookInfo(initPath, context)
        if (hookInfo) {
          metadata.hooks = metadata.hooks ?? {}
          setRecordValue(metadata.hooks, name, compactHookInfo(hookInfo))
        }
      }
    }
  }

  return metadata
}

export function analyzeTypeScriptNamespaces(
  programPath: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
  options: FictCompilerOptions,
  filename: string | undefined,
): TypeScriptNamespaceAnalysis {
  const context: NamespaceAnalysisContext = { filename, options, t }
  const analysis: TypeScriptNamespaceAnalysis = {
    localNamespaces: new Map(),
    namespaceNames: new Set(),
  }

  for (const statementPath of programPath.get('body')) {
    const declarationPath = statementPath.isExportNamedDeclaration()
      ? (statementPath.get('declaration') as BabelCore.NodePath | null)
      : statementPath
    if (!declarationPath?.isTSModuleDeclaration() || declarationPath.node.declare) continue
    const name = namespaceName(declarationPath.node, t)
    if (!name) continue
    analysis.namespaceNames.add(name)
    const metadata = analyzeNamespace(declarationPath, analysis, context)
    if (!metadataHasContent(metadata)) continue
    const existing = analysis.localNamespaces.get(name)
    if (existing) mergeMetadata(existing, metadata)
    else analysis.localNamespaces.set(name, metadata)
  }
  return analysis
}

function namespaceInitializerName(
  argument:
    | BabelCore.types.Expression
    | BabelCore.types.SpreadElement
    | BabelCore.types.JSXNamespacedName,
  t: typeof BabelCore.types,
): string | null {
  if (!t.isLogicalExpression(argument) || argument.operator !== '||') return null
  if (!t.isIdentifier(argument.left)) return null
  const name = argument.left.name
  return t.isAssignmentExpression(argument.right, { operator: '=' }) &&
    t.isIdentifier(argument.right.left, { name })
    ? name
    : null
}

function isSyntheticNode(node: BabelCore.types.Node): boolean {
  return node.loc == null && node.start == null && node.end == null
}

export function collectTypeScriptNamespaceWrapperFunctions(
  programPath: BabelCore.NodePath<BabelCore.types.Program>,
  analysis: TypeScriptNamespaceAnalysis | undefined,
  t: typeof BabelCore.types,
): WeakSet<BabelCore.types.Function> {
  const wrappers = new WeakSet<BabelCore.types.Function>()
  if (!analysis || analysis.namespaceNames.size === 0) return wrappers
  programPath.traverse({
    FunctionExpression(functionPath) {
      const callPath = functionPath.parentPath
      if (!callPath.isCallExpression() || callPath.node.callee !== functionPath.node) return
      if (
        functionPath.node.id ||
        functionPath.node.async ||
        functionPath.node.generator ||
        callPath.node.arguments.length !== 1
      ) {
        return
      }
      if (functionPath.node.params.length !== 1 || !t.isIdentifier(functionPath.node.params[0])) {
        return
      }
      // Babel's TypeScript transform synthesizes the wrapper shell without
      // source locations. Source-authored IIFEs must retain their real nested
      // function depth even when they deliberately mimic the emitted syntax.
      if (
        !isSyntheticNode(functionPath.node) ||
        !isSyntheticNode(callPath.node) ||
        !isSyntheticNode(functionPath.node.params[0])
      ) {
        return
      }
      const argument = callPath.node.arguments[0]
      if (!argument || !t.isExpression(argument)) return
      const name = namespaceInitializerName(argument, t)
      if (!name || !analysis.namespaceNames.has(name)) return
      wrappers.add(functionPath.node)
    },
  })
  return wrappers
}
