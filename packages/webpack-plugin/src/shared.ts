import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule } from 'webpack'

import type { FictWebpackPackageResolutionState } from './package-metadata'

export const FICT_WEBPACK_LOADER_CONTEXT = Symbol.for('@fictjs/webpack-plugin/loader-context/v3')
const FICT_WEBPACK_BUILD_INFO_KEY = 'fictWebpackMetadataV7'

interface StoredFictWebpackMetadata {
  version: 7
  identifier: string
  resource: string
  metadataJson: string
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
  metadataSources: string[]
  metadataRequestMappings: [string, string][]
}

export interface RestoredFictWebpackMetadata {
  identifier: string
  resource: string
  metadata: ModuleReactiveMetadata
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
  metadataSources: string[]
  metadataRequestMappings: [string, string][]
}

export interface FictWebpackCompilationState {
  moduleMetadata: Map<string, ModuleReactiveMetadata>
  incompleteModuleMetadata: Set<string>
  modulesByIdentifier: Map<string, NormalModule>
  identifiersByModule: Map<NormalModule, string>
  resolvedLocalModules: Map<string, string>
  compiledDependencyFingerprints: Map<string, string | null>
  pendingDependencyFingerprints: Map<string, string>
  metadataDependenciesByIdentifier: Map<string, Set<string>>
  metadataSourcesByIdentifier: Map<string, Set<string>>
  metadataRequestMappingsByIdentifier: Map<string, Map<string, string>>
  metadataGraphPrepared: boolean
  packageResolutionsByIdentifier: Map<string, Map<string, FictWebpackPackageResolutionState>>
}

export interface FictWebpackLoaderBinding {
  module: NormalModule
  state: FictWebpackCompilationState
}

export function createCompilationState(): FictWebpackCompilationState {
  return {
    moduleMetadata: new Map(),
    incompleteModuleMetadata: new Set(),
    modulesByIdentifier: new Map(),
    identifiersByModule: new Map(),
    resolvedLocalModules: new Map(),
    compiledDependencyFingerprints: new Map(),
    pendingDependencyFingerprints: new Map(),
    metadataDependenciesByIdentifier: new Map(),
    metadataSourcesByIdentifier: new Map(),
    metadataRequestMappingsByIdentifier: new Map(),
    metadataGraphPrepared: false,
    packageResolutionsByIdentifier: new Map(),
  }
}

export function normalizeFileName(filename: string): string {
  return path.resolve(filename)
}

export function normalizeWebpackResource(resource: string): string {
  return path.resolve(resource)
}

export function getWebpackModuleIdentifier(module: NormalModule): string {
  // Keep Webpack's identifier verbatim: it already includes the loader request, resource,
  // module type, and layer. Treating it as a filesystem path would corrupt loader separators
  // and platform-specific absolute paths.
  const identifier = module.identifier()
  if (typeof identifier !== 'string' || !identifier) {
    throw new Error('[fict] Webpack returned an empty module identifier.')
  }
  return identifier
}

function getWebpackModuleResource(module: NormalModule): string {
  if (typeof module.resource !== 'string' || !module.resource) {
    throw new Error(
      `[fict] Webpack exposed no resource for module "${getWebpackModuleIdentifier(module)}".`,
    )
  }
  return normalizeWebpackResource(module.resource)
}

export function createLocalResolutionKey(importerIdentifier: string, source: string): string {
  return JSON.stringify([importerIdentifier, source])
}

export function registerFictModule(
  state: FictWebpackCompilationState,
  module: NormalModule,
): string {
  const identifier = getWebpackModuleIdentifier(module)
  const registeredIdentifier = state.identifiersByModule.get(module)
  if (registeredIdentifier && registeredIdentifier !== identifier) {
    throw new Error(
      `[fict] Webpack module identifier changed during compilation from "${registeredIdentifier}" to "${identifier}".`,
    )
  }
  const existingModule = state.modulesByIdentifier.get(identifier)
  if (existingModule && existingModule !== module) {
    throw new Error(
      `[fict] Multiple Webpack modules returned the same identifier "${identifier}" and cannot share one reactive metadata record.`,
    )
  }
  state.modulesByIdentifier.set(identifier, module)
  state.identifiersByModule.set(module, identifier)
  return identifier
}

function getBuildInfoRecord(module: NormalModule): Record<string, unknown> | undefined {
  if (!module.buildInfo || typeof module.buildInfo !== 'object') return undefined
  return module.buildInfo as unknown as Record<string, unknown>
}

export function storeFictModuleMetadata(
  state: FictWebpackCompilationState,
  module: NormalModule,
  metadata: ModuleReactiveMetadata,
  dependencyFingerprint: string | null,
): void {
  const identifier = getWebpackModuleIdentifier(module)
  if (
    state.modulesByIdentifier.get(identifier) !== module ||
    state.identifiersByModule.get(module) !== identifier
  ) {
    throw new Error(
      `[fict] Webpack module "${identifier}" attempted to store reactive metadata without a matching registration.`,
    )
  }
  const buildInfo = getBuildInfoRecord(module)
  if (!buildInfo) {
    throw new Error(`[fict] Webpack did not expose buildInfo for ${identifier}.`)
  }
  const stored: StoredFictWebpackMetadata = {
    version: 7,
    identifier,
    resource: getWebpackModuleResource(module),
    metadataJson: JSON.stringify(metadata),
    incomplete: state.incompleteModuleMetadata.has(identifier),
    dependencyFingerprint,
    metadataDependencies: [
      ...(state.metadataDependenciesByIdentifier.get(identifier) ?? []),
    ].sort(),
    metadataSources: [...(state.metadataSourcesByIdentifier.get(identifier) ?? [])].sort(),
    metadataRequestMappings: [
      ...(state.metadataRequestMappingsByIdentifier.get(identifier) ?? new Map()),
    ].sort(([left], [right]) => left.localeCompare(right)),
  }
  buildInfo[FICT_WEBPACK_BUILD_INFO_KEY] = stored
  state.compiledDependencyFingerprints.set(identifier, dependencyFingerprint)
}

export function restoreFictModuleMetadata(
  module: NormalModule,
): RestoredFictWebpackMetadata | undefined {
  const stored = getBuildInfoRecord(module)?.[FICT_WEBPACK_BUILD_INFO_KEY]
  if (stored === undefined) return undefined
  if (!stored || typeof stored !== 'object') {
    throw new Error('[fict] Cached Webpack module metadata is malformed.')
  }

  const candidate = stored as {
    version?: unknown
    identifier?: unknown
    resource?: unknown
    metadataJson?: unknown
    incomplete?: unknown
    dependencyFingerprint?: unknown
    metadataDependencies?: unknown
    metadataSources?: unknown
    metadataRequestMappings?: unknown
  }
  if (
    candidate.version !== 7 ||
    typeof candidate.identifier !== 'string' ||
    !candidate.identifier ||
    typeof candidate.resource !== 'string' ||
    !candidate.resource ||
    typeof candidate.metadataJson !== 'string' ||
    typeof candidate.incomplete !== 'boolean' ||
    (candidate.dependencyFingerprint !== null &&
      typeof candidate.dependencyFingerprint !== 'string') ||
    !Array.isArray(candidate.metadataDependencies) ||
    candidate.metadataDependencies.some(dependency => typeof dependency !== 'string') ||
    !Array.isArray(candidate.metadataSources) ||
    candidate.metadataSources.some(source => typeof source !== 'string') ||
    !Array.isArray(candidate.metadataRequestMappings) ||
    candidate.metadataRequestMappings.some(
      mapping =>
        !Array.isArray(mapping) ||
        mapping.length !== 2 ||
        mapping.some(request => typeof request !== 'string'),
    )
  ) {
    throw new Error('[fict] Cached Webpack module metadata is malformed.')
  }

  let metadata: unknown
  try {
    metadata = JSON.parse(candidate.metadataJson)
  } catch {
    throw new Error(`[fict] Cached Webpack module metadata for ${candidate.identifier} is invalid.`)
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !(metadata as { exports?: unknown }).exports ||
    typeof (metadata as { exports?: unknown }).exports !== 'object' ||
    Array.isArray((metadata as { exports?: unknown }).exports)
  ) {
    throw new Error(`[fict] Cached Webpack module metadata for ${candidate.identifier} is invalid.`)
  }

  const identifier = getWebpackModuleIdentifier(module)
  const resource = getWebpackModuleResource(module)
  const storedResource = normalizeWebpackResource(candidate.resource)
  const identityChanged = identifier !== candidate.identifier || resource !== storedResource
  const metadataRequestMappings = new Map<string, string>()
  for (const [source, emitted] of candidate.metadataRequestMappings as [string, string][]) {
    const previous = metadataRequestMappings.get(source)
    if (previous !== undefined && previous !== emitted) {
      throw new Error('[fict] Cached Webpack module metadata is malformed.')
    }
    metadataRequestMappings.set(source, emitted)
  }
  for (const source of candidate.metadataSources as string[]) {
    if (!metadataRequestMappings.has(source)) {
      throw new Error('[fict] Cached Webpack module metadata is malformed.')
    }
  }

  return {
    identifier,
    resource,
    metadata: metadata as ModuleReactiveMetadata,
    incomplete: identityChanged || candidate.incomplete,
    dependencyFingerprint: identityChanged ? null : candidate.dependencyFingerprint,
    metadataDependencies: [
      ...new Set((candidate.metadataDependencies as string[]).map(normalizeFileName)),
    ].sort(),
    metadataSources: [...new Set(candidate.metadataSources as string[])].sort(),
    metadataRequestMappings: [...metadataRequestMappings].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  }
}

export function attachLoaderBinding(
  loaderContext: object,
  binding: FictWebpackLoaderBinding,
): void {
  Object.defineProperty(loaderContext, FICT_WEBPACK_LOADER_CONTEXT, {
    configurable: true,
    value: binding,
  })
}

export function getLoaderBinding(loaderContext: object): FictWebpackLoaderBinding | undefined {
  return (
    loaderContext as {
      [FICT_WEBPACK_LOADER_CONTEXT]?: FictWebpackLoaderBinding
    }
  )[FICT_WEBPACK_LOADER_CONTEXT]
}
