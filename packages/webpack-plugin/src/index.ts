import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'

import type { Compilation, Compiler, NormalModule } from 'webpack'

import {
  getPackageMetadataKeyFingerprint,
  getPackageMetadataSubpaths,
  getPackageNonInvertibleRuntimeTargets,
  getPackageRuntimeMappingFingerprint,
  getPackageRuntimeSubpaths,
  getPackageRuntimeTargets,
  isPackageResourcePathContained,
  isCanonicalPackageName,
  isCanonicalPublicSubpath,
  isUnresolvedPackageResolution,
  packageResourcePathsMatch,
  resolvePackageRuntimeTargetPath,
  type FictWebpackPackageResolutionState,
  type PackagePublicSubpath,
} from './package-metadata'
import {
  attachLoaderBinding,
  createCompilationState,
  createLocalResolutionKey,
  registerFictModule,
  restoreFictModuleMetadata,
  storeFictModuleMetadata,
  type FictWebpackCompilationState,
} from './shared'

const PLUGIN_NAME = 'FictWebpackPlugin'
const COMMONJS_EXTERNAL_TYPES = new Set([
  'commonjs',
  'commonjs2',
  'commonjs-module',
  'commonjs-static',
  'node-commonjs',
])
const NODE_BUILTIN_MODULES = new Set(builtinModules.map(request => request.replace(/^node:/, '')))
const OUTPUT_TEMPLATE_PATTERN = /\[[^\]]+\]/

const NODE_COMMONJS_RESOLVE_OPTIONS = {
  alias: [],
  aliasFields: [],
  conditionNames: ['node', 'require', 'node-addons'],
  dependencyType: 'commonjs' as const,
  descriptionFiles: ['package.json'],
  enforceExtension: false,
  exportsFields: ['exports'],
  extensionAlias: {},
  extensions: ['.js', '.json', '.node'],
  fallback: [],
  fullySpecified: false,
  importsFields: ['imports'],
  mainFields: ['main'],
  mainFiles: ['index'],
  modules: ['node_modules'],
  plugins: [],
  pnpApi: null,
  preferAbsolute: false,
  preferRelative: false,
  restrictions: [],
  roots: [],
  symlinks: true,
  tsconfig: false,
}

interface MetadataGraphNode {
  identifier: string
  module: NormalModule
  dependencies: Set<string>
}

interface WebpackResourceResolveData {
  path?: unknown
  query?: unknown
  fragment?: unknown
  descriptionFilePath?: unknown
  descriptionFileData?: unknown
}

interface ExternalPackageDescriptor {
  fingerprint: string
  packageName?: string
  runtimeRequest?: string
}

interface WebpackExternalModuleData {
  externalType?: unknown
  request?: unknown
  userRequest?: unknown
}

interface ExternalPackageResolution {
  resolveData: WebpackResourceResolveData
  staticResolveOptions: ReturnType<typeof getStaticResolveOptions>
}

export interface FictWebpackPluginOptions {
  /** Maximum fixed-point passes for a circular local metadata component. */
  maxMetadataPasses?: number
}

function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  return `{${Object.keys(value)
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

function getCanonicalPackageName(request: string): string | undefined {
  const segments = request.split('/')
  const scoped = request.startsWith('@')
  if ((scoped && segments.length < 2) || (!scoped && segments.length < 1)) return undefined
  const packageName = scoped ? `${segments[0]}/${segments[1]}` : segments[0]!
  if (!isCanonicalPackageName(packageName) || NODE_BUILTIN_MODULES.has(packageName))
    return undefined
  const subpath = segments.slice(scoped ? 2 : 1)
  return subpath.length === 0 || isCanonicalPublicSubpath(`./${subpath.join('/')}`)
    ? packageName
    : undefined
}

function isStaticFlatCommonJsOutputFilename(filename: unknown): filename is string {
  return (
    typeof filename === 'string' &&
    filename.endsWith('.cjs') &&
    !filename.includes('\0') &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !filename.includes('?') &&
    !filename.includes('#') &&
    !OUTPUT_TEMPLATE_PATTERN.test(filename)
  )
}

function resolveThroughExistingAncestor(filename: string): string | undefined {
  let current = filename
  const missingSegments: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(current), ...missingSegments)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

function getExternalRuntimeDirectory(
  compilation: Compilation,
  compiler: Compiler,
): string | undefined {
  const platform = compiler.platform
  if (
    platform.node !== true ||
    platform.web !== false ||
    platform.browser !== false ||
    platform.webworker !== false ||
    platform.electron !== false ||
    platform.nwjs !== false
  ) {
    return undefined
  }
  if (compilation.outputOptions.clean) return undefined
  if (
    compilation.outputOptions.module !== false ||
    compilation.outputOptions.chunkFormat !== 'commonjs'
  ) {
    return undefined
  }
  const outputPath = compilation.outputOptions.path
  if (!path.isAbsolute(outputPath)) return undefined
  const runtimeDirectory = path.resolve(outputPath)
  if (resolveThroughExistingAncestor(runtimeDirectory) !== runtimeDirectory) return undefined
  if (!isStaticFlatCommonJsOutputFilename(compilation.outputOptions.filename)) {
    return undefined
  }
  // Webpack confines ExternalModule instances to chunks that contain entry modules, so the
  // non-entry chunk filename cannot change the directory of the generated require call.
  for (const entry of compilation.entries.values()) {
    if (
      entry.options.filename !== undefined &&
      !isStaticFlatCommonJsOutputFilename(entry.options.filename)
    ) {
      return undefined
    }
  }
  return runtimeDirectory
}

function getExternalPackageDescriptor(
  compiler: Compiler,
  dependencyModule: object,
): ExternalPackageDescriptor | undefined {
  if (!(dependencyModule instanceof compiler.webpack.ExternalModule)) return undefined
  const external = dependencyModule as WebpackExternalModuleData
  const fingerprint = createHash('sha256')
    .update(
      stableStringify({
        externalType: external.externalType,
        request: external.request,
        userRequest: external.userRequest,
        version: 1,
      }),
    )
    .digest('hex')
  if (typeof external.externalType !== 'string' || typeof external.request !== 'string') {
    return { fingerprint }
  }
  if (!COMMONJS_EXTERNAL_TYPES.has(external.externalType)) return { fingerprint }
  const packageName = getCanonicalPackageName(external.request)
  return packageName
    ? { fingerprint, packageName, runtimeRequest: external.request }
    : { fingerprint }
}

function resolveNodePackageJsonPath(
  nodeRequire: NodeJS.Require,
  packageName: string,
  runtimeResource: string,
): string | undefined {
  for (const searchPath of nodeRequire.resolve.paths(packageName) ?? []) {
    try {
      const packageJsonPath = realpathSync(path.join(searchPath, packageName, 'package.json'))
      if (
        statSync(packageJsonPath).isFile() &&
        isPackageResourcePathContained(packageJsonPath, runtimeResource)
      ) {
        return packageJsonPath
      }
    } catch {
      // Keep looking through Node's remaining package search paths.
    }
  }
  return undefined
}

function resolveExternalPackageResource(
  compilation: Compilation,
  compiler: Compiler,
  runtimeRequest: string,
): Promise<ExternalPackageResolution | undefined> {
  const runtimeDirectory = getExternalRuntimeDirectory(compilation, compiler)
  if (!runtimeDirectory) return Promise.resolve(undefined)
  let runtimeResource: string | undefined
  let runtimePackageJsonPath: string | undefined
  const runtimeProbe = path.join(runtimeDirectory, '__fict_external__.cjs')
  try {
    const nodeRequire = createRequire(runtimeProbe)
    runtimeResource = realpathSync(nodeRequire.resolve(runtimeRequest))
    const packageName = getCanonicalPackageName(runtimeRequest)
    if (packageName) {
      runtimePackageJsonPath = resolveNodePackageJsonPath(nodeRequire, packageName, runtimeResource)
    }
  } catch {
    // The clean resolver below still records the package lookup paths for watch mode.
  }
  const resolver = compiler.resolverFactory.get('normal', NODE_COMMONJS_RESOLVE_OPTIONS)
  const fileDependencies = new Set<string>()
  const contextDependencies = new Set<string>()
  const missingDependencies = new Set<string>()
  return new Promise(resolve => {
    const finish = (result?: ExternalPackageResolution): void => {
      for (const dependency of fileDependencies) compilation.fileDependencies.add(dependency)
      for (const dependency of contextDependencies) {
        compilation.contextDependencies.add(dependency)
      }
      for (const dependency of missingDependencies) {
        compilation.missingDependencies.add(dependency)
      }
      resolve(result)
    }
    try {
      resolver.resolve(
        {},
        runtimeDirectory,
        runtimeRequest,
        { contextDependencies, fileDependencies, missingDependencies },
        (error, result, resolveData) => {
          if (
            error ||
            !runtimeResource ||
            !runtimePackageJsonPath ||
            typeof result !== 'string' ||
            !resolveData ||
            (() => {
              try {
                const resolvedPath = (resolveData as WebpackResourceResolveData).path
                const descriptionFilePath = (resolveData as WebpackResourceResolveData)
                  .descriptionFilePath
                return (
                  typeof resolvedPath !== 'string' ||
                  typeof descriptionFilePath !== 'string' ||
                  realpathSync(result) !== runtimeResource ||
                  realpathSync(resolvedPath) !== runtimeResource ||
                  realpathSync(descriptionFilePath) !== runtimePackageJsonPath
                )
              } catch {
                return true
              }
            })()
          ) {
            finish()
            return
          }
          finish({
            resolveData: resolveData as WebpackResourceResolveData,
            staticResolveOptions: resolver.options as ReturnType<typeof getStaticResolveOptions>,
          })
        },
      )
    } catch {
      finish()
    }
  })
}

interface StaticFileProof {
  blocked?: boolean
  dependencies: string[]
  resource?: string
}

function getConfiguredExtensions(resolveOptions: { extensions?: unknown }): string[] {
  const extensions =
    resolveOptions.extensions instanceof Set
      ? [...resolveOptions.extensions]
      : Array.isArray(resolveOptions.extensions)
        ? resolveOptions.extensions
        : []
  return extensions.filter((extension): extension is string => typeof extension === 'string')
}

function getStaticFileProof(
  packageJsonPath: string,
  target: string,
  resolveOptions: {
    enforceExtension?: unknown
    extensions?: unknown
    fullySpecified?: unknown
  },
): StaticFileProof {
  const candidates =
    resolveOptions.fullySpecified === true
      ? [target]
      : [
          ...(resolveOptions.enforceExtension === true ? [] : [target]),
          ...getConfiguredExtensions(resolveOptions).map(extension => `${target}${extension}`),
        ]
  const dependencies: string[] = []
  for (const candidate of candidates) {
    const resolved = resolvePackageRuntimeTargetPath(packageJsonPath, candidate)
    if (!resolved) return { blocked: true, dependencies }
    dependencies.push(resolved)
    if (!existsSync(resolved)) continue
    try {
      return statSync(resolved).isFile()
        ? { dependencies, resource: resolved }
        : { blocked: true, dependencies }
    } catch {
      return { blocked: true, dependencies }
    }
  }
  return { dependencies }
}

function getStaticResolveOptions(
  compiler: Compiler,
  node: MetadataGraphNode,
  dependencyType: string,
): {
  aliasFields?: unknown
  enforceExtension?: unknown
  extensions?: unknown
  extensionAlias?: unknown
  exportsFields?: unknown
  fullySpecified?: unknown
  mainFields?: unknown
  mainFiles?: unknown
} {
  return compiler.resolverFactory.get('normal', {
    ...(node.module.resolveOptions ?? {}),
    alias: [],
    ...(dependencyType ? { dependencyType } : {}),
  }).options as {
    aliasFields?: unknown
    enforceExtension?: unknown
    extensions?: unknown
    extensionAlias?: unknown
    exportsFields?: unknown
    fullySpecified?: unknown
    mainFields?: unknown
    mainFiles?: unknown
  }
}

function hasDefaultExportsFields(exportsFields: unknown): boolean {
  const fields =
    exportsFields instanceof Set
      ? [...exportsFields]
      : Array.isArray(exportsFields)
        ? exportsFields
        : []
  return fields.length === 1 && fields[0] === 'exports'
}

function hasActiveExtensionAlias(extensionAlias: unknown): boolean {
  if (Array.isArray(extensionAlias)) return extensionAlias.length > 0
  if (extensionAlias instanceof Map || extensionAlias instanceof Set) return extensionAlias.size > 0
  return (
    !!extensionAlias && typeof extensionAlias === 'object' && Object.keys(extensionAlias).length > 0
  )
}

function hasActiveAliasField(packageData: Record<string, unknown>, aliasFields: unknown): boolean {
  const fields =
    aliasFields instanceof Set ? [...aliasFields] : Array.isArray(aliasFields) ? aliasFields : []
  return fields.some(field => {
    const pathParts = Array.isArray(field) ? field : [field]
    let value: unknown = packageData
    for (const part of pathParts) {
      if (typeof part !== 'string' || !value || typeof value !== 'object') return false
      value = (value as Record<string, unknown>)[part]
    }
    return (
      !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
    )
  })
}

function readNormalizedDescriptionField(
  packageData: Record<string, unknown>,
  field: unknown,
): unknown {
  const fieldName =
    field && typeof field === 'object' && !Array.isArray(field)
      ? (field as { name?: unknown }).name
      : field
  const pathParts = Array.isArray(fieldName) ? fieldName : [fieldName]
  let value: unknown = packageData
  for (const part of pathParts) {
    if (typeof part !== 'string' || !value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function getLegacyRootTargetProof(
  resolveOptions: {
    extensions?: unknown
    enforceExtension?: unknown
    fullySpecified?: unknown
    mainFields?: unknown
    mainFiles?: unknown
  },
  packageData: Record<string, unknown>,
  packageJsonPath: string,
): StaticFileProof {
  const mainFields = Array.isArray(resolveOptions.mainFields) ? resolveOptions.mainFields : []
  const rootResolveOptions = { ...resolveOptions, fullySpecified: false }
  const dependencies: string[] = []
  for (const field of mainFields) {
    const value = readNormalizedDescriptionField(packageData, field)
    if (typeof value !== 'string' || !value || value === '.' || value === './') continue
    const isRelative = /^\.\.?\//.test(value)
    const forceRelative =
      !field || typeof field !== 'object' || Array.isArray(field)
        ? true
        : (field as { forceRelative?: unknown }).forceRelative === true
    if (!isRelative && !forceRelative) return { blocked: true, dependencies }
    const proof = getStaticFileProof(
      packageJsonPath,
      isRelative ? value : `./${value}`,
      rootResolveOptions,
    )
    dependencies.push(...proof.dependencies)
    if (proof.resource) return { dependencies, resource: proof.resource }
    if (proof.blocked) return { blocked: true, dependencies }
  }
  const mainFiles =
    resolveOptions.mainFiles instanceof Set
      ? [...resolveOptions.mainFiles]
      : Array.isArray(resolveOptions.mainFiles)
        ? resolveOptions.mainFiles
        : []
  for (const mainFile of mainFiles) {
    if (typeof mainFile !== 'string') continue
    const proof = getStaticFileProof(
      packageJsonPath,
      mainFile.startsWith('./') ? mainFile : `./${mainFile}`,
      rootResolveOptions,
    )
    dependencies.push(...proof.dependencies)
    if (proof.resource) return { dependencies, resource: proof.resource }
    if (proof.blocked) return { blocked: true, dependencies }
  }
  return { dependencies }
}

function registerProofTargetDependency(compilation: Compilation, target: string): void {
  try {
    if (!existsSync(target)) {
      compilation.missingDependencies.add(target)
    } else if (statSync(target).isDirectory()) {
      compilation.contextDependencies.add(target)
    } else {
      compilation.fileDependencies.add(target)
    }
  } catch {
    compilation.missingDependencies.add(target)
  }
}

async function resolveWebpackPackageMetadata(
  compilation: Compilation,
  compiler: Compiler,
  node: MetadataGraphNode,
  request: string,
  dependencyType: string,
  dependencyModule: object,
): Promise<FictWebpackPackageResolutionState> {
  const external = getExternalPackageDescriptor(compiler, dependencyModule)
  if (!external && (request.includes('?') || request.includes('!'))) return 'opaque'
  const unresolved = (): FictWebpackPackageResolutionState =>
    external
      ? { kind: 'unresolved', externalMappingFingerprint: external.fingerprint }
      : 'unresolved'
  let externalResolution: ExternalPackageResolution | undefined
  let resolveData: WebpackResourceResolveData | undefined
  if (external) {
    if (!external.runtimeRequest || !external.packageName) return unresolved()
    externalResolution = await resolveExternalPackageResource(
      compilation,
      compiler,
      external.runtimeRequest,
    )
    resolveData = externalResolution?.resolveData
  } else {
    resolveData = (dependencyModule as { resourceResolveData?: unknown }).resourceResolveData as
      | WebpackResourceResolveData
      | undefined
  }
  if (!resolveData || typeof resolveData.path !== 'string') return unresolved()
  if (typeof resolveData.query === 'string' && resolveData.query.length > 0) {
    return external ? unresolved() : 'opaque'
  }
  if (external && typeof resolveData.fragment === 'string' && resolveData.fragment.length > 0) {
    return unresolved()
  }
  if (
    typeof resolveData.descriptionFilePath !== 'string' ||
    !resolveData.descriptionFileData ||
    typeof resolveData.descriptionFileData !== 'object' ||
    Array.isArray(resolveData.descriptionFileData)
  ) {
    return unresolved()
  }
  if (path.basename(resolveData.descriptionFilePath) !== 'package.json') return unresolved()

  const packageData = resolveData.descriptionFileData as Record<string, unknown>
  const metadataSubpaths = getPackageMetadataSubpaths(packageData)
  const packageName = packageData.name
  if (typeof packageName !== 'string' || !isCanonicalPackageName(packageName)) return unresolved()

  const actualPackageJsonPath = path.resolve(resolveData.descriptionFilePath)
  const actualResourcePath = path.resolve(resolveData.path)
  if (!isPackageResourcePathContained(actualPackageJsonPath, actualResourcePath)) {
    return unresolved()
  }
  if (metadataSubpaths.length === 0) {
    return {
      packageJsonPath: actualPackageJsonPath,
      publicSubpath: null,
      resourcePaths: [actualResourcePath],
      metadataKeyFingerprint: getPackageMetadataKeyFingerprint(packageData),
      runtimeMappingFingerprint: getPackageRuntimeMappingFingerprint(packageData),
      ...(external ? { externalMappingFingerprint: external.fingerprint } : {}),
    }
  }
  const staticResolveOptions =
    externalResolution?.staticResolveOptions ??
    getStaticResolveOptions(compiler, node, dependencyType)
  if (
    !hasDefaultExportsFields(staticResolveOptions.exportsFields) ||
    hasActiveAliasField(packageData, staticResolveOptions.aliasFields) ||
    hasActiveExtensionAlias(staticResolveOptions.extensionAlias)
  ) {
    return unresolved()
  }
  const hasRuntimeExports = Object.prototype.hasOwnProperty.call(packageData, 'exports')
  const legacyRootProof: StaticFileProof = hasRuntimeExports
    ? { dependencies: [] }
    : getLegacyRootTargetProof(staticResolveOptions, packageData, actualPackageJsonPath)
  const legacyMetadataProofs = new Map<PackagePublicSubpath, StaticFileProof>()
  if (!hasRuntimeExports) {
    for (const subpath of metadataSubpaths) {
      if (subpath === '.') continue
      legacyMetadataProofs.set(
        subpath,
        getStaticFileProof(actualPackageJsonPath, subpath, staticResolveOptions),
      )
    }
  }
  for (const target of [
    ...legacyRootProof.dependencies,
    ...[...legacyMetadataProofs.values()].flatMap(proof => proof.dependencies),
  ]) {
    registerProofTargetDependency(compilation, target)
  }
  const candidates = new Set<PackagePublicSubpath>([
    ...getPackageRuntimeSubpaths(packageData, actualPackageJsonPath, actualResourcePath),
    ...metadataSubpaths,
  ])
  const exportResolveOptions = {
    ...staticResolveOptions,
    fullySpecified: external ? true : false,
  }
  const nonInvertibleTargetProofs = (
    metadataSubpaths.length > 0 ? getPackageNonInvertibleRuntimeTargets(packageData) : []
  ).map(target => getStaticFileProof(actualPackageJsonPath, target, exportResolveOptions))
  for (const proof of nonInvertibleTargetProofs) {
    for (const target of proof.dependencies) registerProofTargetDependency(compilation, target)
  }
  if (
    nonInvertibleTargetProofs.some(proof =>
      proof.resource
        ? packageResourcePathsMatch(actualPackageJsonPath, proof.resource, actualResourcePath)
        : false,
    )
  ) {
    throw new Error(
      `[fict] Webpack package metadata for "${request}" imported by "${node.identifier}" ` +
        'could not be matched to one public entry (non-invertible export pattern).',
    )
  }
  const matches: PackagePublicSubpath[] = []
  for (const candidate of [...candidates].sort()) {
    let matchesContainedTarget =
      candidate === '.' &&
      !!legacyRootProof.resource &&
      packageResourcePathsMatch(actualPackageJsonPath, legacyRootProof.resource, actualResourcePath)
    const legacyMetadataProof = legacyMetadataProofs.get(candidate)
    if (
      legacyMetadataProof?.resource &&
      packageResourcePathsMatch(
        actualPackageJsonPath,
        legacyMetadataProof.resource,
        actualResourcePath,
      )
    ) {
      matchesContainedTarget = true
    }
    for (const target of getPackageRuntimeTargets(packageData, candidate)) {
      const proof = getStaticFileProof(actualPackageJsonPath, target, exportResolveOptions)
      for (const targetPath of proof.dependencies) {
        registerProofTargetDependency(compilation, targetPath)
      }
      if (
        proof.resource &&
        packageResourcePathsMatch(actualPackageJsonPath, proof.resource, actualResourcePath)
      ) {
        matchesContainedTarget = true
      }
    }
    if (matchesContainedTarget) matches.push(candidate)
  }
  if (matches.length > 1 || (matches.length === 0 && metadataSubpaths.length > 0)) {
    throw new Error(
      `[fict] Webpack package metadata for "${request}" imported by "${node.identifier}" ` +
        `could not be matched to one public entry (${matches.join(', ') || 'none'}).`,
    )
  }

  return {
    packageJsonPath: actualPackageJsonPath,
    publicSubpath: matches[0] ?? null,
    resourcePaths: [actualResourcePath],
    metadataKeyFingerprint: getPackageMetadataKeyFingerprint(packageData),
    runtimeMappingFingerprint: getPackageRuntimeMappingFingerprint(packageData),
    ...(external ? { externalMappingFingerprint: external.fingerprint } : {}),
  }
}

function recordPackageResolution(
  state: FictWebpackCompilationState,
  node: MetadataGraphNode,
  request: string,
  resolution: FictWebpackPackageResolutionState,
): void {
  let resolutions = state.packageResolutionsByIdentifier.get(node.identifier)
  if (!resolutions) {
    resolutions = new Map()
    state.packageResolutionsByIdentifier.set(node.identifier, resolutions)
  }
  const previous = resolutions.get(request)
  if (!resolutions.has(request)) {
    resolutions.set(request, resolution)
    return
  }
  if (previous === resolution && typeof previous === 'string') return
  if (
    previous &&
    isUnresolvedPackageResolution(previous) &&
    isUnresolvedPackageResolution(resolution) &&
    previous.externalMappingFingerprint === resolution.externalMappingFingerprint
  ) {
    return
  }
  if (
    !previous ||
    typeof previous === 'string' ||
    typeof resolution === 'string' ||
    isUnresolvedPackageResolution(previous) ||
    isUnresolvedPackageResolution(resolution) ||
    previous.packageJsonPath !== resolution.packageJsonPath ||
    previous.publicSubpath !== resolution.publicSubpath ||
    previous.metadataKeyFingerprint !== resolution.metadataKeyFingerprint ||
    previous.runtimeMappingFingerprint !== resolution.runtimeMappingFingerprint ||
    previous.externalMappingFingerprint !== resolution.externalMappingFingerprint
  ) {
    throw new Error(
      `[fict] Webpack resolved "${request}" from "${node.identifier}" to multiple package entries.`,
    )
  }
  previous.resourcePaths = [
    ...new Set([...previous.resourcePaths, ...resolution.resourcePaths]),
  ].sort()
}

async function buildMetadataGraph(
  compiler: Compiler,
  compilation: Compilation,
  state: FictWebpackCompilationState,
): Promise<Map<string, MetadataGraphNode>> {
  const graph = new Map<string, MetadataGraphNode>()
  state.resolvedLocalModules.clear()
  state.packageResolutionsByIdentifier.clear()
  const packageResolutionTasks: Promise<void>[] = []
  const nonLocalResolutionKeys = new Set<string>()

  for (const [identifier, module] of state.modulesByIdentifier) {
    graph.set(identifier, { identifier, module, dependencies: new Set() })
  }

  for (const node of graph.values()) {
    for (const connection of compilation.moduleGraph.getOutgoingConnections(node.module)) {
      const dependency = connection.dependency as {
        category?: unknown
        request?: unknown
        type?: unknown
      } | null
      // The compiler consumes metadata only for static ESM import/export sources. Webpack also
      // exposes CommonJS and import() connections here; including those can conflate two legal
      // `resolve.byDependency` targets that share the same literal request. Every static harmony
      // source has exactly one side-effect-evaluation dependency, so use that canonical edge and
      // ignore its duplicate specifier connections as well as non-static dependency categories.
      if (dependency?.type !== 'harmony side effect evaluation') continue

      const dependencyModule = connection.module
      const request = dependency.request
      if (!dependencyModule) {
        if (typeof request !== 'string') continue
        const key = createLocalResolutionKey(node.identifier, request)
        if (state.resolvedLocalModules.has(key)) {
          throw new Error(
            `[fict] Webpack resolved "${request}" from "${node.identifier}" across both local and non-local metadata boundaries.`,
          )
        }
        nonLocalResolutionKeys.add(key)
        recordPackageResolution(
          state,
          node,
          request,
          request.includes('?') || request.includes('!') ? 'opaque' : 'unresolved',
        )
        continue
      }
      const dependencyIdentifier = state.identifiersByModule.get(dependencyModule as NormalModule)
      if (dependencyIdentifier && graph.has(dependencyIdentifier)) {
        if (typeof request === 'string') {
          const key = createLocalResolutionKey(node.identifier, request)
          if (nonLocalResolutionKeys.has(key)) {
            throw new Error(
              `[fict] Webpack resolved "${request}" from "${node.identifier}" across both local and non-local metadata boundaries.`,
            )
          }
          const previous = state.resolvedLocalModules.get(key)
          if (previous && previous !== dependencyIdentifier) {
            throw new Error(
              `[fict] Webpack resolved "${request}" from "${node.identifier}" to multiple Fict modules.`,
            )
          }
          state.resolvedLocalModules.set(key, dependencyIdentifier)
        }
        node.dependencies.add(dependencyIdentifier)
        continue
      }
      if (typeof request === 'string') {
        const key = createLocalResolutionKey(node.identifier, request)
        if (state.resolvedLocalModules.has(key)) {
          throw new Error(
            `[fict] Webpack resolved "${request}" from "${node.identifier}" across both local and non-local metadata boundaries.`,
          )
        }
        nonLocalResolutionKeys.add(key)
        const dependencyType = dependency.category ?? ''
        packageResolutionTasks.push(
          resolveWebpackPackageMetadata(
            compilation,
            compiler,
            node,
            request,
            typeof dependencyType === 'string' ? dependencyType : '',
            dependencyModule,
          ).then(resolution => {
            recordPackageResolution(state, node, request, resolution)
          }),
        )
      }
    }
  }

  await Promise.all(packageResolutionTasks)
  state.metadataGraphPrepared = true
  return graph
}

function getStronglyConnectedComponents(graph: Map<string, MetadataGraphNode>): string[][] {
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []

  const visit = (identifier: string): void => {
    const index = nextIndex++
    indices.set(identifier, index)
    lowLinks.set(identifier, index)
    stack.push(identifier)
    onStack.add(identifier)

    for (const dependency of [...(graph.get(identifier)?.dependencies ?? [])].sort()) {
      if (!graph.has(dependency)) continue
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(identifier, Math.min(lowLinks.get(identifier)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(identifier, Math.min(lowLinks.get(identifier)!, indices.get(dependency)!))
      }
    }

    if (lowLinks.get(identifier) !== indices.get(identifier)) return
    const component: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      onStack.delete(member)
      component.push(member)
      if (member === identifier) break
    }
    components.push(component)
  }

  for (const identifier of [...graph.keys()].sort()) {
    if (!indices.has(identifier)) visit(identifier)
  }
  return components
}

function rebuildModule(compilation: Compilation, module: NormalModule): Promise<void> {
  if (compilation.rebuildQueue.isDone(module)) {
    compilation.rebuildQueue.invalidate(module)
  }
  return new Promise((resolve, reject) => {
    compilation.rebuildModule(module, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function hydrateCachedModuleMetadata(
  compilation: Compilation,
  state: FictWebpackCompilationState,
): void {
  for (const module of compilation.modules) {
    const restored = restoreFictModuleMetadata(module as NormalModule)
    if (!restored) continue
    const identifier = registerFictModule(state, module as NormalModule)
    if (identifier !== restored.identifier) {
      throw new Error(
        `[fict] Restored Webpack module identifier mismatch: expected "${identifier}", received "${restored.identifier}".`,
      )
    }
    state.moduleMetadata.set(identifier, restored.metadata)
    if (restored.incomplete) state.incompleteModuleMetadata.add(identifier)
    else state.incompleteModuleMetadata.delete(identifier)
    state.compiledDependencyFingerprints.set(identifier, restored.dependencyFingerprint)
    state.metadataDependenciesByIdentifier.set(identifier, new Set(restored.metadataDependencies))
  }
}

function fileFingerprint(filename: string): string {
  try {
    return createHash('sha256').update(readFileSync(filename)).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return `unreadable:${typeof code === 'string' ? code : 'UNKNOWN'}`
  }
}

function dependencyFingerprint(
  node: MetadataGraphNode,
  state: FictWebpackCompilationState,
): string {
  const localDependencies = [...node.dependencies].sort().map(identifier => {
    const metadata = state.moduleMetadata.get(identifier)
    if (!metadata) {
      throw new Error(`[fict] Missing Webpack module metadata for ${identifier}.`)
    }
    return [identifier, metadata, state.incompleteModuleMetadata.has(identifier)]
  })
  const packageMetadataDependencies = [
    ...(state.metadataDependenciesByIdentifier.get(node.identifier) ?? []),
  ]
    .sort()
    .map(filename => [filename, fileFingerprint(filename)])
  const packageResolutions = [
    ...(state.packageResolutionsByIdentifier.get(node.identifier)?.entries() ?? []),
  ].sort(([left], [right]) => left.localeCompare(right))
  return stableStringify({ localDependencies, packageMetadataDependencies, packageResolutions })
}

async function rebuildModuleWithFingerprint(
  compilation: Compilation,
  state: FictWebpackCompilationState,
  node: MetadataGraphNode,
): Promise<void> {
  const fingerprint = dependencyFingerprint(node, state)
  state.pendingDependencyFingerprints.set(node.identifier, fingerprint)
  try {
    await rebuildModule(compilation, node.module)
  } finally {
    state.pendingDependencyFingerprints.delete(node.identifier)
  }
  const rebuildError = node.module.getErrors()?.[Symbol.iterator]().next().value
  if (rebuildError) throw rebuildError
  const persistedFingerprint = state.compiledDependencyFingerprints.get(node.identifier)
  const currentFingerprint = dependencyFingerprint(node, state)
  if (persistedFingerprint !== fingerprint && persistedFingerprint !== currentFingerprint) {
    throw new Error(
      `[fict] Webpack did not persist the metadata fingerprint for ${node.identifier} ` +
        `(expected ${fingerprint}, received ${String(persistedFingerprint)}).`,
    )
  }
  if (persistedFingerprint !== currentFingerprint) {
    const metadata = state.moduleMetadata.get(node.identifier)
    if (!metadata) {
      throw new Error(`[fict] Missing Webpack module metadata for ${node.identifier}.`)
    }
    storeFictModuleMetadata(state, node.module, metadata, currentFingerprint)
  }
}

function componentMetadataSnapshot(
  component: readonly string[],
  state: FictWebpackCompilationState,
): string {
  return stableStringify(
    component.map(identifier => [
      identifier,
      state.moduleMetadata.get(identifier),
      state.incompleteModuleMetadata.has(identifier),
    ]),
  )
}

async function convergeMetadataGraph(
  compiler: Compiler,
  compilation: Compilation,
  state: FictWebpackCompilationState,
  maxMetadataPasses: number | undefined,
): Promise<void> {
  const graph = await buildMetadataGraph(compiler, compilation, state)

  for (const component of getStronglyConnectedComponents(graph)) {
    const sortedComponent = [...component].sort()
    const hasCycle =
      sortedComponent.length > 1 ||
      graph.get(sortedComponent[0]!)?.dependencies.has(sortedComponent[0]!) === true

    if (!hasCycle) {
      const identifier = sortedComponent[0]!
      const node = graph.get(identifier)!
      const fingerprint = dependencyFingerprint(node, state)
      if (state.compiledDependencyFingerprints.get(identifier) !== fingerprint) {
        const hasPackageResolutions =
          (state.packageResolutionsByIdentifier.get(identifier)?.size ?? 0) > 0
        if (
          node.dependencies.size === 0 &&
          !hasPackageResolutions &&
          compilation.builtModules.has(node.module)
        ) {
          const metadata = state.moduleMetadata.get(identifier)
          if (!metadata) {
            throw new Error(`[fict] Missing Webpack module metadata for ${identifier}.`)
          }
          storeFictModuleMetadata(state, node.module, metadata, fingerprint)
        } else {
          await rebuildModuleWithFingerprint(compilation, state, node)
        }
      }
      continue
    }

    const passLimit = maxMetadataPasses ?? Math.max(8, sortedComponent.length * 4)
    const fingerprintsAreCurrent = (): boolean =>
      sortedComponent.every(identifier => {
        const node = graph.get(identifier)!
        return (
          state.compiledDependencyFingerprints.get(identifier) ===
          dependencyFingerprint(node, state)
        )
      })
    if (fingerprintsAreCurrent()) continue

    let converged = false
    for (let pass = 0; pass < passLimit; pass++) {
      const before = componentMetadataSnapshot(sortedComponent, state)
      for (const identifier of sortedComponent) {
        await rebuildModuleWithFingerprint(compilation, state, graph.get(identifier)!)
      }
      const after = componentMetadataSnapshot(sortedComponent, state)
      if (after === before && fingerprintsAreCurrent()) {
        converged = true
        break
      }
    }
    if (!converged) {
      throw new Error(
        `[fict] Webpack module metadata did not converge for circular dependency: ${sortedComponent.join(', ')}`,
      )
    }
  }
}

export class FictWebpackPlugin {
  readonly #options: FictWebpackPluginOptions
  readonly #states = new WeakMap<Compilation, FictWebpackCompilationState>()

  constructor(options: FictWebpackPluginOptions = {}) {
    if (
      options.maxMetadataPasses !== undefined &&
      (!Number.isInteger(options.maxMetadataPasses) || options.maxMetadataPasses <= 0)
    ) {
      throw new Error('[fict] maxMetadataPasses must be a positive integer.')
    }
    this.#options = options
  }

  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
      const state = createCompilationState()
      this.#states.set(compilation, state)
      compiler.webpack.NormalModule.getCompilationHooks(compilation).loader.tap(
        PLUGIN_NAME,
        (loaderContext, module) => {
          attachLoaderBinding(loaderContext, { module, state })
        },
      )
    })

    compiler.hooks.finishMake.tapPromise(
      { name: PLUGIN_NAME, stage: Number.MAX_SAFE_INTEGER },
      async compilation => {
        const state = this.#states.get(compilation)
        if (!state) return
        hydrateCachedModuleMetadata(compilation, state)
        if (state.modulesByIdentifier.size === 0) return
        await convergeMetadataGraph(compiler, compilation, state, this.#options.maxMetadataPasses)
      },
    )
  }
}

export default FictWebpackPlugin
