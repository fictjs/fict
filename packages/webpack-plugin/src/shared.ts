import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule } from 'webpack'

import type { FictWebpackPackageResolutionState } from './package-metadata'

export const FICT_WEBPACK_LOADER_CONTEXT = Symbol.for('@fictjs/webpack-plugin/loader-context/v2')
const FICT_WEBPACK_BUILD_INFO_KEY = 'fictWebpackMetadata'

interface StoredFictWebpackMetadata {
  version: 4
  identifier: string
  resource: string
  metadataJson: string
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
}

export interface RestoredFictWebpackMetadata {
  identifier: string
  resource: string
  metadata: ModuleReactiveMetadata
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
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
    version: 4,
    identifier,
    resource: getWebpackModuleResource(module),
    metadataJson: JSON.stringify(metadata),
    incomplete: state.incompleteModuleMetadata.has(identifier),
    dependencyFingerprint,
    metadataDependencies: [
      ...(state.metadataDependenciesByIdentifier.get(identifier) ?? []),
    ].sort(),
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
    filename?: unknown
    identifier?: unknown
    resource?: unknown
    metadataJson?: unknown
    incomplete?: unknown
    dependencyFingerprint?: unknown
    metadataDependencies?: unknown
  }
  const isLegacyV1 = candidate.version === 1
  const isLegacyV2 = candidate.version === 2
  const isLegacyV3 = candidate.version === 3
  const isCurrent = candidate.version === 4
  const isLegacy = isLegacyV1 || isLegacyV2 || isLegacyV3
  if (
    (!isLegacy && !isCurrent) ||
    (isLegacy && typeof candidate.filename !== 'string') ||
    (isCurrent &&
      (typeof candidate.identifier !== 'string' ||
        !candidate.identifier ||
        typeof candidate.resource !== 'string' ||
        !candidate.resource)) ||
    typeof candidate.metadataJson !== 'string' ||
    (candidate.dependencyFingerprint !== null &&
      typeof candidate.dependencyFingerprint !== 'string') ||
    ((isLegacyV3 || isCurrent) && typeof candidate.incomplete !== 'boolean') ||
    ((isLegacyV2 || isLegacyV3 || isCurrent) && !Array.isArray(candidate.metadataDependencies)) ||
    (candidate.metadataDependencies !== undefined &&
      (!Array.isArray(candidate.metadataDependencies) ||
        candidate.metadataDependencies.some(dependency => typeof dependency !== 'string')))
  ) {
    throw new Error('[fict] Cached Webpack module metadata is malformed.')
  }
  const storedDisplayIdentifier = isCurrent ? candidate.identifier : candidate.filename

  let metadata: unknown
  try {
    metadata = JSON.parse(candidate.metadataJson)
  } catch {
    throw new Error(
      `[fict] Cached Webpack module metadata for ${String(storedDisplayIdentifier)} is invalid.`,
    )
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !(metadata as { exports?: unknown }).exports ||
    typeof (metadata as { exports?: unknown }).exports !== 'object' ||
    Array.isArray((metadata as { exports?: unknown }).exports)
  ) {
    throw new Error(
      `[fict] Cached Webpack module metadata for ${String(storedDisplayIdentifier)} is invalid.`,
    )
  }

  const identifier = getWebpackModuleIdentifier(module)
  const resource = getWebpackModuleResource(module)
  const storedIdentifier = isCurrent
    ? candidate.identifier
    : normalizeFileName(candidate.filename as string)
  const storedResource = isCurrent
    ? normalizeWebpackResource(candidate.resource as string)
    : normalizeFileName(candidate.filename as string)
  const identityChanged = identifier !== storedIdentifier || resource !== storedResource

  return {
    identifier,
    resource,
    metadata: metadata as ModuleReactiveMetadata,
    // Versions before v4 were keyed only by a physical/resource filename. They cannot prove
    // which loader chain produced the metadata, so force one rebuild during migration.
    incomplete: !isCurrent || identityChanged || candidate.incomplete === true,
    dependencyFingerprint: isCurrent && !identityChanged ? candidate.dependencyFingerprint : null,
    metadataDependencies: [
      ...new Set((candidate.metadataDependencies ?? []).map(normalizeFileName)),
    ].sort(),
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
