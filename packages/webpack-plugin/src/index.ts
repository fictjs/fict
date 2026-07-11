import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

interface MetadataGraphNode {
  filename: string
  module: NormalModule
  dependencies: Set<string>
}

interface WebpackResourceResolveData {
  path?: unknown
  query?: unknown
  descriptionFilePath?: unknown
  descriptionFileData?: unknown
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
  if (request.includes('?') || request.includes('!')) return 'opaque'
  const resolveData = (dependencyModule as { resourceResolveData?: unknown })
    .resourceResolveData as WebpackResourceResolveData | undefined
  if (!resolveData || typeof resolveData.path !== 'string') return 'unresolved'
  if (typeof resolveData.query === 'string' && resolveData.query.length > 0) {
    return 'opaque'
  }
  if (
    typeof resolveData.descriptionFilePath !== 'string' ||
    !resolveData.descriptionFileData ||
    typeof resolveData.descriptionFileData !== 'object' ||
    Array.isArray(resolveData.descriptionFileData)
  ) {
    return 'unresolved'
  }
  if (path.basename(resolveData.descriptionFilePath) !== 'package.json') return 'unresolved'

  const packageData = resolveData.descriptionFileData as Record<string, unknown>
  const metadataSubpaths = getPackageMetadataSubpaths(packageData)
  const packageName = packageData.name
  if (typeof packageName !== 'string' || !isCanonicalPackageName(packageName)) return 'unresolved'

  const actualPackageJsonPath = path.resolve(resolveData.descriptionFilePath)
  const actualResourcePath = path.resolve(resolveData.path)
  if (!isPackageResourcePathContained(actualPackageJsonPath, actualResourcePath)) {
    return 'unresolved'
  }
  if (metadataSubpaths.length === 0) {
    return {
      packageJsonPath: actualPackageJsonPath,
      publicSubpath: null,
      resourcePaths: [actualResourcePath],
      metadataKeyFingerprint: getPackageMetadataKeyFingerprint(packageData),
      runtimeMappingFingerprint: getPackageRuntimeMappingFingerprint(packageData),
    }
  }
  const staticResolveOptions = getStaticResolveOptions(compiler, node, dependencyType)
  if (
    !hasDefaultExportsFields(staticResolveOptions.exportsFields) ||
    hasActiveAliasField(packageData, staticResolveOptions.aliasFields) ||
    hasActiveExtensionAlias(staticResolveOptions.extensionAlias)
  ) {
    return 'unresolved'
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
  const exportResolveOptions = { ...staticResolveOptions, fullySpecified: false }
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
      `[fict] Webpack package metadata for "${request}" imported by "${node.filename}" ` +
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
      `[fict] Webpack package metadata for "${request}" imported by "${node.filename}" ` +
        `could not be matched to one public entry (${matches.join(', ') || 'none'}).`,
    )
  }

  return {
    packageJsonPath: actualPackageJsonPath,
    publicSubpath: matches[0] ?? null,
    resourcePaths: [actualResourcePath],
    metadataKeyFingerprint: getPackageMetadataKeyFingerprint(packageData),
    runtimeMappingFingerprint: getPackageRuntimeMappingFingerprint(packageData),
  }
}

function recordPackageResolution(
  state: FictWebpackCompilationState,
  node: MetadataGraphNode,
  request: string,
  resolution: FictWebpackPackageResolutionState,
): void {
  let resolutions = state.packageResolutionsByFilename.get(node.filename)
  if (!resolutions) {
    resolutions = new Map()
    state.packageResolutionsByFilename.set(node.filename, resolutions)
  }
  const previous = resolutions.get(request)
  if (!resolutions.has(request)) {
    resolutions.set(request, resolution)
    return
  }
  if (previous === resolution && typeof previous === 'string') return
  if (
    !previous ||
    typeof previous === 'string' ||
    typeof resolution === 'string' ||
    previous.packageJsonPath !== resolution.packageJsonPath ||
    previous.publicSubpath !== resolution.publicSubpath ||
    previous.metadataKeyFingerprint !== resolution.metadataKeyFingerprint ||
    previous.runtimeMappingFingerprint !== resolution.runtimeMappingFingerprint
  ) {
    throw new Error(
      `[fict] Webpack resolved "${request}" from "${node.filename}" to multiple package entries.`,
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
  state.packageResolutionsByFilename.clear()
  const packageResolutionTasks: Promise<void>[] = []
  const nonLocalResolutionKeys = new Set<string>()

  for (const [filename, module] of state.modulesByFilename) {
    graph.set(filename, { filename, module, dependencies: new Set() })
  }

  for (const node of graph.values()) {
    for (const connection of compilation.moduleGraph.getOutgoingConnections(node.module)) {
      const dependencyModule = connection.module
      const request = (connection.dependency as { request?: unknown } | null)?.request
      if (!dependencyModule) {
        if (typeof request !== 'string') continue
        const key = createLocalResolutionKey(node.filename, request)
        if (state.resolvedLocalModules.has(key)) {
          throw new Error(
            `[fict] Webpack resolved "${request}" from "${node.filename}" across both local and non-local metadata boundaries.`,
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
      const dependencyFilename = state.filenamesByModule.get(dependencyModule as NormalModule)
      if (dependencyFilename && graph.has(dependencyFilename)) {
        if (typeof request === 'string') {
          const key = createLocalResolutionKey(node.filename, request)
          if (nonLocalResolutionKeys.has(key)) {
            throw new Error(
              `[fict] Webpack resolved "${request}" from "${node.filename}" across both local and non-local metadata boundaries.`,
            )
          }
          const previous = state.resolvedLocalModules.get(key)
          if (previous && previous !== dependencyFilename) {
            throw new Error(
              `[fict] Webpack resolved "${request}" from "${node.filename}" to multiple Fict modules.`,
            )
          }
          state.resolvedLocalModules.set(key, dependencyFilename)
        }
        node.dependencies.add(dependencyFilename)
        continue
      }
      if (typeof request === 'string') {
        const key = createLocalResolutionKey(node.filename, request)
        if (state.resolvedLocalModules.has(key)) {
          throw new Error(
            `[fict] Webpack resolved "${request}" from "${node.filename}" across both local and non-local metadata boundaries.`,
          )
        }
        nonLocalResolutionKeys.add(key)
        const dependencyType =
          (connection.dependency as { category?: unknown } | null)?.category ?? ''
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

  const visit = (filename: string): void => {
    const index = nextIndex++
    indices.set(filename, index)
    lowLinks.set(filename, index)
    stack.push(filename)
    onStack.add(filename)

    for (const dependency of [...(graph.get(filename)?.dependencies ?? [])].sort()) {
      if (!graph.has(dependency)) continue
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(filename, Math.min(lowLinks.get(filename)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(filename, Math.min(lowLinks.get(filename)!, indices.get(dependency)!))
      }
    }

    if (lowLinks.get(filename) !== indices.get(filename)) return
    const component: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      onStack.delete(member)
      component.push(member)
      if (member === filename) break
    }
    components.push(component)
  }

  for (const filename of [...graph.keys()].sort()) {
    if (!indices.has(filename)) visit(filename)
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
    const filename = registerFictModule(state, restored.filename, module as NormalModule)
    state.moduleMetadata.set(filename, restored.metadata)
    if (restored.incomplete) state.incompleteModuleMetadata.add(filename)
    else state.incompleteModuleMetadata.delete(filename)
    state.compiledDependencyFingerprints.set(filename, restored.dependencyFingerprint)
    state.metadataDependenciesByFilename.set(filename, new Set(restored.metadataDependencies))
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
  const localDependencies = [...node.dependencies].sort().map(filename => {
    const metadata = state.moduleMetadata.get(filename)
    if (!metadata) {
      throw new Error(`[fict] Missing Webpack module metadata for ${filename}.`)
    }
    return [filename, metadata, state.incompleteModuleMetadata.has(filename)]
  })
  const packageMetadataDependencies = [
    ...(state.metadataDependenciesByFilename.get(node.filename) ?? []),
  ]
    .sort()
    .map(filename => [filename, fileFingerprint(filename)])
  const packageResolutions = [
    ...(state.packageResolutionsByFilename.get(node.filename)?.entries() ?? []),
  ].sort(([left], [right]) => left.localeCompare(right))
  return stableStringify({ localDependencies, packageMetadataDependencies, packageResolutions })
}

async function rebuildModuleWithFingerprint(
  compilation: Compilation,
  state: FictWebpackCompilationState,
  node: MetadataGraphNode,
): Promise<void> {
  const fingerprint = dependencyFingerprint(node, state)
  state.pendingDependencyFingerprints.set(node.filename, fingerprint)
  try {
    await rebuildModule(compilation, node.module)
  } finally {
    state.pendingDependencyFingerprints.delete(node.filename)
  }
  const rebuildError = node.module.getErrors()?.[Symbol.iterator]().next().value
  if (rebuildError) throw rebuildError
  const persistedFingerprint = state.compiledDependencyFingerprints.get(node.filename)
  const currentFingerprint = dependencyFingerprint(node, state)
  if (persistedFingerprint !== fingerprint && persistedFingerprint !== currentFingerprint) {
    throw new Error(
      `[fict] Webpack did not persist the metadata fingerprint for ${node.filename} ` +
        `(expected ${fingerprint}, received ${String(persistedFingerprint)}).`,
    )
  }
  if (persistedFingerprint !== currentFingerprint) {
    const metadata = state.moduleMetadata.get(node.filename)
    if (!metadata) {
      throw new Error(`[fict] Missing Webpack module metadata for ${node.filename}.`)
    }
    storeFictModuleMetadata(state, node.module, node.filename, metadata, currentFingerprint)
  }
}

function componentMetadataSnapshot(
  component: readonly string[],
  state: FictWebpackCompilationState,
): string {
  return stableStringify(
    component.map(filename => [
      filename,
      state.moduleMetadata.get(filename),
      state.incompleteModuleMetadata.has(filename),
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
      const filename = sortedComponent[0]!
      const node = graph.get(filename)!
      const fingerprint = dependencyFingerprint(node, state)
      if (state.compiledDependencyFingerprints.get(filename) !== fingerprint) {
        const hasPackageResolutions =
          (state.packageResolutionsByFilename.get(filename)?.size ?? 0) > 0
        if (
          node.dependencies.size === 0 &&
          !hasPackageResolutions &&
          compilation.builtModules.has(node.module)
        ) {
          const metadata = state.moduleMetadata.get(filename)
          if (!metadata) {
            throw new Error(`[fict] Missing Webpack module metadata for ${filename}.`)
          }
          storeFictModuleMetadata(state, node.module, filename, metadata, fingerprint)
        } else {
          await rebuildModuleWithFingerprint(compilation, state, node)
        }
      }
      continue
    }

    const passLimit = maxMetadataPasses ?? Math.max(8, sortedComponent.length * 4)
    const fingerprintsAreCurrent = (): boolean =>
      sortedComponent.every(filename => {
        const node = graph.get(filename)!
        return (
          state.compiledDependencyFingerprints.get(filename) === dependencyFingerprint(node, state)
        )
      })
    if (fingerprintsAreCurrent()) continue

    let converged = false
    for (let pass = 0; pass < passLimit; pass++) {
      const before = componentMetadataSnapshot(sortedComponent, state)
      for (const filename of sortedComponent) {
        await rebuildModuleWithFingerprint(compilation, state, graph.get(filename)!)
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
        if (state.modulesByFilename.size === 0) return
        await convergeMetadataGraph(compiler, compilation, state, this.#options.maxMetadataPasses)
      },
    )
  }
}

export default FictWebpackPlugin
