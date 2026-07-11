import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule } from 'webpack'

import type { FictWebpackPackageResolutionState } from './package-metadata'

export const FICT_WEBPACK_LOADER_CONTEXT = Symbol.for('@fictjs/webpack-plugin/loader-context/v1')
const FICT_WEBPACK_BUILD_INFO_KEY = 'fictWebpackMetadata'

interface StoredFictWebpackMetadata {
  version: 3
  filename: string
  metadataJson: string
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
}

export interface RestoredFictWebpackMetadata {
  filename: string
  metadata: ModuleReactiveMetadata
  incomplete: boolean
  dependencyFingerprint: string | null
  metadataDependencies: string[]
}

export interface FictWebpackCompilationState {
  moduleMetadata: Map<string, ModuleReactiveMetadata>
  incompleteModuleMetadata: Set<string>
  modulesByFilename: Map<string, NormalModule>
  filenamesByModule: Map<NormalModule, string>
  resolvedLocalModules: Map<string, string>
  compiledDependencyFingerprints: Map<string, string | null>
  pendingDependencyFingerprints: Map<string, string>
  metadataDependenciesByFilename: Map<string, Set<string>>
  metadataGraphPrepared: boolean
  packageResolutionsByFilename: Map<string, Map<string, FictWebpackPackageResolutionState>>
}

export interface FictWebpackLoaderBinding {
  module: NormalModule
  state: FictWebpackCompilationState
}

export function createCompilationState(): FictWebpackCompilationState {
  return {
    moduleMetadata: new Map(),
    incompleteModuleMetadata: new Set(),
    modulesByFilename: new Map(),
    filenamesByModule: new Map(),
    resolvedLocalModules: new Map(),
    compiledDependencyFingerprints: new Map(),
    pendingDependencyFingerprints: new Map(),
    metadataDependenciesByFilename: new Map(),
    metadataGraphPrepared: false,
    packageResolutionsByFilename: new Map(),
  }
}

export function normalizeFileName(filename: string): string {
  return path.resolve(filename)
}

export function normalizeWebpackResource(resource: string): string {
  return path.resolve(resource)
}

export function createLocalResolutionKey(importer: string, source: string): string {
  return `${normalizeFileName(importer)}\0${source}`
}

export function registerFictModule(
  state: FictWebpackCompilationState,
  filename: string,
  module: NormalModule,
): string {
  const normalized = normalizeFileName(filename)
  const existingModule = state.modulesByFilename.get(normalized)
  if (existingModule && existingModule !== module) {
    throw new Error(
      `[fict] Multiple Webpack modules for "${normalized}" cannot share one reactive metadata record.`,
    )
  }
  state.modulesByFilename.set(normalized, module)
  state.filenamesByModule.set(module, normalized)
  return normalized
}

function getBuildInfoRecord(module: NormalModule): Record<string, unknown> | undefined {
  if (!module.buildInfo || typeof module.buildInfo !== 'object') return undefined
  return module.buildInfo as unknown as Record<string, unknown>
}

export function storeFictModuleMetadata(
  state: FictWebpackCompilationState,
  module: NormalModule,
  filename: string,
  metadata: ModuleReactiveMetadata,
  dependencyFingerprint: string | null,
): void {
  const buildInfo = getBuildInfoRecord(module)
  if (!buildInfo) {
    throw new Error(`[fict] Webpack did not expose buildInfo for ${filename}.`)
  }
  const stored: StoredFictWebpackMetadata = {
    version: 3,
    filename: normalizeFileName(filename),
    metadataJson: JSON.stringify(metadata),
    incomplete: state.incompleteModuleMetadata.has(normalizeFileName(filename)),
    dependencyFingerprint,
    metadataDependencies: [
      ...(state.metadataDependenciesByFilename.get(normalizeFileName(filename)) ?? []),
    ].sort(),
  }
  buildInfo[FICT_WEBPACK_BUILD_INFO_KEY] = stored
  state.compiledDependencyFingerprints.set(stored.filename, dependencyFingerprint)
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
    metadataJson?: unknown
    incomplete?: unknown
    dependencyFingerprint?: unknown
    metadataDependencies?: unknown
  }
  const isLegacy = candidate.version === 1
  const isPrevious = candidate.version === 2
  const isCurrent = candidate.version === 3
  if (
    (!isLegacy && !isPrevious && !isCurrent) ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.metadataJson !== 'string' ||
    (candidate.dependencyFingerprint !== null &&
      typeof candidate.dependencyFingerprint !== 'string') ||
    (isCurrent && typeof candidate.incomplete !== 'boolean') ||
    ((isPrevious || isCurrent) && !Array.isArray(candidate.metadataDependencies)) ||
    (candidate.metadataDependencies !== undefined &&
      (!Array.isArray(candidate.metadataDependencies) ||
        candidate.metadataDependencies.some(dependency => typeof dependency !== 'string')))
  ) {
    throw new Error('[fict] Cached Webpack module metadata is malformed.')
  }

  let metadata: unknown
  try {
    metadata = JSON.parse(candidate.metadataJson)
  } catch {
    throw new Error(`[fict] Cached Webpack module metadata for ${candidate.filename} is invalid.`)
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !(metadata as { exports?: unknown }).exports ||
    typeof (metadata as { exports?: unknown }).exports !== 'object' ||
    Array.isArray((metadata as { exports?: unknown }).exports)
  ) {
    throw new Error(`[fict] Cached Webpack module metadata for ${candidate.filename} is invalid.`)
  }

  const storedFilename = normalizeFileName(candidate.filename)
  const currentResource =
    typeof module.resource === 'string' && module.resource
      ? normalizeWebpackResource(module.resource)
      : storedFilename
  const resourceIdentityChanged = currentResource !== storedFilename

  return {
    // Webpack's resource (unlike resourcePath) includes the query and fragment. Prefer the
    // module's current identity so caches written by older plugin releases cannot collapse
    // distinct query variants back onto one physical filename.
    filename: currentResource,
    metadata: metadata as ModuleReactiveMetadata,
    // Older records did not persist completeness. Preserve their bookkeeping metadata, but treat
    // it as incomplete and force one rebuild rather than trusting an unknown graph state.
    incomplete: resourceIdentityChanged || (isCurrent ? candidate.incomplete === true : true),
    dependencyFingerprint:
      isCurrent && !resourceIdentityChanged ? candidate.dependencyFingerprint : null,
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
