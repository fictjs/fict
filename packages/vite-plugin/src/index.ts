import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformAsync, type PluginItem } from '@babel/core'
import _generate from '@babel/generator'
import { parse, parseExpression } from '@babel/parser'
import transformTypeScript from '@babel/plugin-transform-typescript'
import _traverse from '@babel/traverse'
import type { NodePath, Scope } from '@babel/traverse'
import * as t from '@babel/types'
import {
  createFictPlugin,
  getCompilerCacheFingerprint,
  resolvePackageModuleMetadata,
  type FictCompilerOptions,
  type ModuleReactiveMetadata,
} from '@fictjs/compiler'
import {
  createFilter,
  transformWithEsbuild,
  type Plugin,
  type ResolvedConfig,
  type TransformResult,
} from 'vite'

import { createVitePluginCacheFingerprint } from './cache-fingerprint'

// Handle ESM/CJS interop for Babel packages
const traverse = (
  typeof _traverse === 'function' ? _traverse : (_traverse as { default: typeof _traverse }).default
) as typeof _traverse
const generate = (
  typeof _generate === 'function' ? _generate : (_generate as { default: typeof _generate }).default
) as typeof _generate
const TYPESCRIPT_PARSER_PLUGINS = ['decorators-legacy', 'jsx', 'typescript'] as const

const PACKAGE_METADATA_WATCH_GLOBS = [
  '!**/node_modules/**/package.json',
  '!**/node_modules/**/*.json',
] as const

type BabelGeneratorOptions = NonNullable<Parameters<typeof generate>[1]>

interface BabelGeneratorOptionsWithInputSourceMap extends BabelGeneratorOptions {
  retainLines?: boolean
  compact?: boolean
  sourceMaps?: boolean
  sourceFileName?: string
  inputSourceMap?: TransformResult['map'] | null | undefined
}

export interface FictPluginOptions extends FictCompilerOptions {
  /**
   * File patterns to include for transformation.
   * @default all supported JavaScript and TypeScript module extensions
   */
  include?: string[]
  /**
   * File patterns to exclude from transformation.
   * @default ['**\/node_modules\/**']
   */
  exclude?: string[]
  /**
   * Transform cache settings (memory + optional persistent disk cache).
   * Set to false to disable caching entirely.
   */
  cache?:
    | boolean
    | {
        enabled?: boolean
        persistent?: boolean
        dir?: string
      }
  /**
   * Explicit tsconfig path for TypeScript project integration.
   * If omitted, the plugin will search from Vite root.
   */
  tsconfigPath?: string
  /**
   * Enable TypeScript project integration when TypeScript is available.
   * @default true
   */
  useTypeScriptProject?: boolean
  /**
   * Enable function-level code splitting for resumable handlers.
   * When enabled, event handlers and resume functions are extracted
   * to separate chunks for optimal lazy loading.
   * @default false for dev, true for production build
   */
  functionSplitting?: boolean
  /**
   * Stable application namespace for public resumable identities.
   * By default the plugin uses the owning package name, version, and Vite-root
   * subpath. Set this when the Vite root has no named package.json boundary.
   */
  publicIdentityNamespace?: string
  /**
   * Enable verbose debug logs from the plugin.
   * Can also be enabled via `FICT_VITE_PLUGIN_DEBUG=1`.
   * @default false
   */
  debug?: boolean
  /**
   * Enable library publishing helpers.
   * Library mode emits package-consumable Fict metadata assets for public entry chunks.
   */
  library?: boolean | FictLibraryOptions
}

export interface FictLibraryOptions {
  /**
   * Directory inside the build output where generated metadata files are emitted.
   * Defaults to the same directory as each emitted entry chunk.
   */
  metadataDir?: string
  /**
   * package.json file to update with `fict.metadata` / `fict.exports`.
   * Pass `false` to emit metadata files without modifying package.json.
   * @default 'package.json'
   */
  packageJson?: string | false
}

interface NormalizedCacheOptions {
  enabled: boolean
  persistent: boolean
  dir?: string | undefined
}

interface CachedTransform {
  code: string
  map: TransformResult['map']
  extractedHandlers?: ExtractedHandler[]
  moduleMetadata?: ModuleReactiveMetadata
}

interface PreparedCompilerTransform {
  code: string
  map: TransformResult['map']
  moduleMetadata: ModuleReactiveMetadata
  preparationKey: string
}

type TypeScriptImportElision = 'remove' | 'preserve-side-effect' | 'verbatim'

interface MetadataGraphNode {
  filename: string
  code: string
  dependencies: Set<string>
  loadOptions?: MetadataLoadOptions
}

interface MetadataLoadOptions {
  id: string
  attributes?: Record<string, string> | null
  meta?: Record<string, unknown> | null
  moduleSideEffects?: boolean | 'no-treeshake' | null
  syntheticNamedExports?: boolean | string | null
}

interface MetadataTransformState {
  blockUnscopedTransforms: boolean
  environment: object | null
  moduleMetadata: Map<string, ModuleReactiveMetadata>
  resolvedLocalModules: Map<string, string>
  preparedCompilerTransforms: Map<string, PreparedCompilerTransform>
  pipelineCompilerInputs: Map<string, string>
  pipelineTransformsInProgress: Map<string, number>
  pipelineTransformedModules: Set<string>
  metadataPreparationQueue: Promise<void>
  extractedHandlers: Map<string, ExtractedHandler>
  packageMetadataDependencies: Set<string>
  tsConfigDependencies: Set<string>
  tsConfigWatchFiles: Set<string>
  tsConfigDependencyClosures: Map<string, string[]>
  tsDeclaredConfigDependencies: Map<string, DeclaredTypeScriptConfigDependencies | null>
  tsImportElisions: Map<string, Promise<TypeScriptImportElision>>
  tsImportElisionConfig: ResolvedConfig | null
  tsProject: TypeScriptProject | null
  tsProjectInit: Promise<TypeScriptProject | null> | null
  activeRequests: number
  idleResolvers: Set<() => void>
  retired: boolean
  retryableAfterRetire: boolean
}

interface MetadataRequestStore {
  activeScopes: number
  environment: object
  state: MetadataTransformState
  trusted: boolean
}

class StaleMetadataRequestError extends Error {
  constructor() {
    super('[fict] A pre-HMR dev request cannot start nested pipeline work after invalidation.')
    this.name = 'StaleMetadataRequestError'
  }
}

interface MetadataResolveContext {
  resolve?: (
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ) => Promise<(MetadataLoadOptions & { external?: boolean | 'absolute' | 'relative' }) | null>
  load?: (options: MetadataLoadOptions) => Promise<unknown>
  environment?: {
    transformRequest?: (url: string) => Promise<unknown>
    moduleGraph?: {
      getModuleById: (id: string) => { url: string } | undefined
    }
  }
}

interface NormalizedLibraryOptions {
  enabled: boolean
  metadataDir: string
  packageJson: string | false
}

interface LibraryMetadataAsset {
  chunkFileName: string
  metadataFileName: string
}

interface FictPackageMappingResult {
  mappings: Map<string, string>
  unmappedAssets: LibraryMetadataAsset[]
  rootFallbackOutsidePackage: boolean
}

interface PackageBoundary {
  root: string
  name: string
  version?: string | undefined
}

interface TypeScriptProject {
  configPath: string
  configHash: string
  readonly projectVersion: number
  updateFile: (fileName: string, code: string) => void
  getProgram: () => TypeScriptProgram | null
  resolveModuleName: (specifier: string, containingFile: string) => string | null
  dispose: () => void
}

interface TypeScriptProgram {
  getTypeChecker?: () => unknown
}

interface TypeScriptSystem {
  fileExists: (path: string) => boolean
  readFile: (path: string) => string | undefined
  readDirectory: (...args: unknown[]) => string[]
  directoryExists?: (path: string) => boolean
  getDirectories?: (path: string) => string[]
  useCaseSensitiveFileNames: boolean
  newLine: string
}

interface TypeScriptParsedConfig {
  fileNames: string[]
  options: unknown
}

interface TypeScriptLanguageService {
  getProgram?: () => TypeScriptProgram | null
  dispose?: () => void
}

interface TypeScriptLanguageServiceHost {
  getScriptFileNames: () => string[]
  getScriptVersion: (fileName: string) => string
  getScriptSnapshot: (fileName: string) => unknown
  getCurrentDirectory: () => string
  getCompilationSettings: () => unknown
  getDefaultLibFileName: (options: unknown) => string
  fileExists: TypeScriptSystem['fileExists']
  readFile: TypeScriptSystem['readFile']
  readDirectory: TypeScriptSystem['readDirectory']
  directoryExists?: TypeScriptSystem['directoryExists']
  getDirectories?: TypeScriptSystem['getDirectories']
  useCaseSensitiveFileNames: () => boolean
  getNewLine: () => string
  getProjectVersion: () => string
}

interface TypeScriptApi {
  sys: TypeScriptSystem
  findConfigFile: (
    searchPath: string,
    fileExists: TypeScriptSystem['fileExists'],
    configName: string,
  ) => string | undefined
  readConfigFile: (
    configPath: string,
    readFile: TypeScriptSystem['readFile'],
  ) => { config: unknown; error?: unknown }
  parseConfigFileTextToJson?: (
    configPath: string,
    text: string,
  ) => { config?: unknown; error?: unknown }
  parseJsonConfigFileContent: (
    config: unknown,
    host: TypeScriptSystem,
    basePath: string,
  ) => TypeScriptParsedConfig
  ScriptSnapshot: {
    fromString: (text: string) => unknown
  }
  getDefaultLibFilePath: (options: unknown) => string
  createLanguageService: (
    host: TypeScriptLanguageServiceHost,
    registry: unknown,
  ) => TypeScriptLanguageService
  createDocumentRegistry: () => unknown
  resolveModuleName: (
    specifier: string,
    containingFile: string,
    options: unknown,
    host: TypeScriptSystem,
  ) => { resolvedModule?: { resolvedFileName?: string } } | undefined
}

const CACHE_VERSION = 4
const MAX_STALE_DEV_REQUEST_RETRIES = 3
let transformCacheFingerprint: string | undefined

// Lazy: both fingerprints read package artifacts from disk, so the cost is
// deferred from module load to the first cache-key computation.
function getTransformCacheFingerprint(): string {
  return (transformCacheFingerprint ??= hashString(
    [
      hashString(getCompilerCacheFingerprint()),
      createVitePluginCacheFingerprint([String(extractAndRewriteHandlers)]),
    ].join('|'),
  ))
}
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const TYPESCRIPT_IMPORT_PROBE_SOURCE = '__fict_ts_import_probe__'
const TYPESCRIPT_IMPORT_PROBE = `
  import { __FictTypeProbe } from '${TYPESCRIPT_IMPORT_PROBE_SOURCE}'
  type __FictTypeProbeUsage = __FictTypeProbe
  export {}
`
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_APP_INCLUDE = MODULE_EXTENSIONS.map(extension => `**/*${extension}`)
const DEFAULT_LIBRARY_INCLUDE = DEFAULT_APP_INCLUDE
const LIBRARY_METADATA_VERSION = 1 satisfies ModuleReactiveMetadata['version']
const FICT_FRAMEWORK_PACKAGES = new Set([
  'fict',
  '@fictjs/runtime',
  '@fictjs/compiler',
  '@fictjs/babel-preset',
  '@fictjs/vite-plugin',
  '@fictjs/devtools',
  '@fictjs/router',
  '@fictjs/ssr',
  '@fictjs/testing-library',
  '@fictjs/eslint-plugin',
  '@fictjs/playground',
])

// Virtual module prefix for extracted handlers
const VIRTUAL_HANDLER_PREFIX = '\0fict-handler:'
const VIRTUAL_HANDLER_RESOLVE_PREFIX = 'virtual:fict-handler:'
const PUBLIC_MODULE_PREFIX = 'fict:module:m'

/**
 * Information about an extracted resumable handler
 */
interface ExtractedHandler {
  /** The module this handler was extracted from */
  sourceModule: string
  /** The export name in the source module */
  exportName: string
  /** Runtime helpers used by this handler */
  helpersUsed: RuntimeHelperUsage[]
  /** Local dependencies from source module that need to be re-exported */
  localDeps: HandlerLocalDependency[]
  /** The handler function code (without export) */
  code: string
  /** Which runtime package family this module uses for helper imports */
  runtimeImportFamily: 'fict' | 'runtime'
}

type RuntimeHelperUsage = string | { helperName: string; localName: string }

interface HandlerLocalDependency {
  localName: string
  exportName: string
}

/**
 * Registry used only by the standalone registerExtractedHandler helper.
 * The plugin itself keeps per-instance registries to avoid cross-instance races.
 */
const manuallyRegisteredHandlers = new Map<string, ExtractedHandler>()

/**
 * Vite plugin for Fict reactive UI library.
 *
 * Transforms $state and $effect calls into reactive signals using the Fict compiler.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite'
 * import fict from '@fictjs/vite-plugin'
 *
 * export default defineConfig({
 *   plugins: [fict()],
 * })
 * ```
 */
export default function fict(options: FictPluginOptions = {}): Plugin {
  const {
    include,
    exclude = ['**/node_modules/**'],
    cache: cacheOption,
    tsconfigPath,
    useTypeScriptProject = true,
    debug: debugOption,
    library: libraryOption,
    publicIdentityNamespace: publicIdentityNamespaceOption,
    publicModuleId: _integrationOwnedPublicModuleId,
    ...compilerOptions
  } = options
  const publicIdentityNamespace = publicIdentityNamespaceOption?.trim()
  if (publicIdentityNamespaceOption !== undefined && !publicIdentityNamespace) {
    throw new Error('[fict] publicIdentityNamespace must be a non-empty string.')
  }
  const libraryOptions = normalizeLibraryOptions(libraryOption)
  const includePatterns =
    include ?? (libraryOptions.enabled ? DEFAULT_LIBRARY_INCLUDE : DEFAULT_APP_INCLUDE)
  const transformFilter = createFilter(includePatterns, exclude)

  let config: ResolvedConfig | undefined
  let isDev = false
  let cache: TransformCache | null = null
  let addTypeScriptConfigWatchFiles: ((files: string[]) => void) | null = null
  const transformStates = new Set<MetadataTransformState>()
  const createTransformState = (environment: object | null = null): MetadataTransformState => {
    const state: MetadataTransformState = {
      blockUnscopedTransforms: false,
      environment,
      moduleMetadata: new Map(),
      resolvedLocalModules: new Map(),
      preparedCompilerTransforms: new Map(),
      pipelineCompilerInputs: new Map(),
      pipelineTransformsInProgress: new Map(),
      pipelineTransformedModules: new Set(),
      metadataPreparationQueue: Promise.resolve(),
      extractedHandlers: new Map(),
      packageMetadataDependencies: new Set(),
      tsConfigDependencies: new Set(),
      tsConfigWatchFiles: new Set(),
      tsConfigDependencyClosures: new Map(),
      tsDeclaredConfigDependencies: new Map(),
      tsImportElisions: new Map(),
      tsImportElisionConfig: null,
      tsProject: null,
      tsProjectInit: null,
      activeRequests: 0,
      idleResolvers: new Set(),
      retired: false,
      retryableAfterRetire: false,
    }
    transformStates.add(state)
    return state
  }
  let buildTransformState = createTransformState()
  const environmentTransformStates = new WeakMap<object, MetadataTransformState>()
  const detachedPendingRequests = new WeakMap<object, Set<Promise<unknown>>>()
  const metadataRequestStorage = new AsyncLocalStorage<MetadataRequestStore>()
  const wrappedDevEnvironments = new WeakSet<object>()
  const libraryMetadataAssets = new Map<string, LibraryMetadataAsset>()
  const packageBoundaryCache = new Map<string, PackageBoundary | null>()
  const publicModuleIds = new Map<string, string>()
  const publicModuleSourcesById = new Map<string, string>()
  const publicModulePortability = new Map<string, boolean>()
  let projectPackageRoot: string | undefined
  const debugEnabled =
    debugOption === true ||
    process.env.FICT_VITE_PLUGIN_DEBUG === '1' ||
    process.env.FICT_VITE_PLUGIN_DEBUG === 'true'

  const debugLog = (message: string, details?: unknown) => {
    if (!debugEnabled) return
    const payload = details === undefined ? '' : ` ${safeDebugString(details)}`
    config?.logger?.info(`[fict-plugin] ${message}${payload}`)
  }

  const ensureCache = () => {
    if (cache) return cache
    const normalized = normalizeCacheOptions(cacheOption, config)
    cache = new TransformCache(normalized)
    return cache
  }

  const resetCache = () => {
    cache?.clear()
    cache = null
  }

  const disposeTransformState = (state: MetadataTransformState) => {
    if (!transformStates.has(state)) return
    state.tsProject?.dispose()
    state.tsProject = null
    state.tsProjectInit = null
    state.moduleMetadata.clear()
    state.resolvedLocalModules.clear()
    state.preparedCompilerTransforms.clear()
    state.pipelineCompilerInputs.clear()
    state.pipelineTransformsInProgress.clear()
    state.pipelineTransformedModules.clear()
    state.extractedHandlers.clear()
    state.packageMetadataDependencies.clear()
    state.tsConfigDependencies.clear()
    state.tsConfigWatchFiles.clear()
    state.tsConfigDependencyClosures.clear()
    state.tsDeclaredConfigDependencies.clear()
    state.tsImportElisions.clear()
    state.tsImportElisionConfig = null
    state.metadataPreparationQueue = Promise.resolve()
    state.environment = null
    transformStates.delete(state)
  }

  const retireTransformState = (state: MetadataTransformState) => {
    if (!transformStates.has(state)) return
    state.retired = true
    if (state.activeRequests === 0) disposeTransformState(state)
  }

  const replaceBuildTransformState = () => {
    retireTransformState(buildTransformState)
    buildTransformState = createTransformState()
    libraryMetadataAssets.clear()
  }

  const getEnvironmentTransformState = (environment: object): MetadataTransformState => {
    let state = environmentTransformStates.get(environment)
    if (!state || state.retired) {
      state = createTransformState(environment)
      environmentTransformStates.set(environment, state)
    }
    return state
  }

  const replaceEnvironmentTransformState = (
    environment: object,
    blockUnscopedTransforms = false,
  ) => {
    const previous = environmentTransformStates.get(environment)
    if (previous) {
      previous.retryableAfterRetire = true
      retireTransformState(previous)
    }
    const next = createTransformState(environment)
    next.blockUnscopedTransforms = blockUnscopedTransforms
    environmentTransformStates.set(environment, next)
    return next
  }

  const getTransformState = (context?: MetadataResolveContext): MetadataTransformState => {
    const environment = context?.environment
    if (
      config?.command !== 'serve' ||
      !environment ||
      typeof environment.transformRequest !== 'function'
    ) {
      return buildTransformState
    }
    const request = metadataRequestStorage.getStore()
    if (request && request.activeScopes > 0 && request.environment === environment) {
      return request.state
    }
    return getEnvironmentTransformState(environment)
  }

  const getTransformInvocationState = (
    context: MetadataResolveContext,
  ): MetadataTransformState | null => {
    const state = getTransformState(context)
    const environment = context.environment
    if (config?.command !== 'serve' || !environment) return state
    const request = metadataRequestStorage.getStore()
    if (request && request.activeScopes > 0 && request.environment === environment) {
      return request.trusted ? request.state : null
    }
    return state.blockUnscopedTransforms ? null : state
  }

  const assertTransformStateActive = (state: MetadataTransformState) => {
    if (state.retired) throw new StaleMetadataRequestError()
  }

  const retainTransformState = (state: MetadataTransformState) => {
    state.activeRequests++
    return () => {
      state.activeRequests--
      if (state.activeRequests !== 0) return
      for (const resolve of state.idleResolvers) resolve()
      state.idleResolvers.clear()
      if (state.retired) disposeTransformState(state)
    }
  }

  const waitForTransformStateIdle = (state: MetadataTransformState): Promise<void> => {
    if (state.activeRequests === 0) return Promise.resolve()
    return new Promise(resolve => state.idleResolvers.add(resolve))
  }

  const replaceInvalidatedEnvironmentState = (environment: object) => {
    // invalidateAll cannot detach a request that is still blocked in resolve/load before
    // its ModuleNode exists. Abort Vite's pending-map entry so the post-HMR request starts
    // independently; the old promise still settles against its retired request state.
    const pendingRequests = (
      environment as {
        _pendingRequests?: Map<unknown, { abort: () => void; request?: Promise<unknown> }>
      }
    )._pendingRequests
    const staleRequests = pendingRequests ? [...pendingRequests.values()] : []
    for (const pending of staleRequests) {
      // Vite's abort only detaches the pending-map entry; it does not cancel doTransform.
      // If that old transform creates its ModuleNode after the first invalidation, it can
      // still cache stale code. Invalidate once more after each detached promise settles.
      if (pending.request) {
        let detached = detachedPendingRequests.get(environment)
        if (!detached) {
          detached = new Set()
          detachedPendingRequests.set(environment, detached)
        }
        detached.add(pending.request)
        const invalidateSettledRequest = () => {
          detached!.delete(pending.request!)
          if (detached!.size === 0) detachedPendingRequests.delete(environment)
          const moduleGraph = (environment as { moduleGraph: { invalidateAll: () => void } })
            .moduleGraph
          moduleGraph.invalidateAll()
        }
        void pending.request.then(invalidateSettledRequest, invalidateSettledRequest)
      }
      pending.abort()
    }

    // Calls made through a previously captured transformRequest or an unwrapped plugin
    // container cannot be attributed after this point. Keep unscoped transforms
    // fail-closed for the lifetime of this generation; normal public entry points carry
    // their state through the AsyncLocalStorage wrappers below.
    replaceEnvironmentTransformState(environment, true)
    const moduleGraph = (environment as { moduleGraph: { invalidateAll: () => void } }).moduleGraph
    moduleGraph.invalidateAll()
  }

  const wrapDevEnvironmentRequests = (environment: object) => {
    if (wrappedDevEnvironments.has(environment)) return
    wrappedDevEnvironments.add(environment)
    // Capture the generation before resolve/load and arbitrary earlier transforms run.
    // Transform-entry epochs are too late: an old request can be suspended in any of them
    // while HMR installs a new generation.
    const wrapRequestMethod = (
      methods: Record<string, unknown>,
      method: string,
      receiver: object,
      kind: 'environment' | 'container',
      idIndex: number,
    ) => {
      const original = methods[method]
      if (typeof original !== 'function') return
      methods[method] = async (...args: unknown[]) => {
        const currentRequest = metadataRequestStorage.getStore()
        const currentRequestActive = !!currentRequest && currentRequest.activeScopes > 0
        const isWarmupRequest = kind === 'environment' && method === 'warmupRequest'
        const activeRequest =
          currentRequestActive && currentRequest.environment === environment
            ? currentRequest
            : undefined
        if (currentRequestActive && currentRequest.state.retired) {
          // Vite deliberately fire-and-forgets dependency warmups. The enclosing request
          // owns the generation retry, so a stale nested warmup must settle quietly.
          if (isWarmupRequest && activeRequest) return undefined
          throw new StaleMetadataRequestError()
        }
        const inheritsUntrustedProvenance = currentRequest?.trusted === false
        if (kind === 'environment' && inheritsUntrustedProvenance) {
          throw new Error(
            '[fict] An unscoped dev pipeline cannot start nested environment work after ' +
              'its request provenance has ended.',
          )
        }
        const hasDetachedRequests = (detachedPendingRequests.get(environment)?.size ?? 0) > 0
        const trusted =
          activeRequest?.trusted ??
          (!inheritsUntrustedProvenance && !(kind === 'container' && hasDetachedRequests))
        const requestedId = args[idIndex]
        const targetsFict =
          typeof requestedId === 'string' &&
          (requestedId.startsWith(VIRTUAL_HANDLER_PREFIX) ||
            requestedId.startsWith(VIRTUAL_HANDLER_RESOLVE_PREFIX) ||
            shouldCompileModule(stripQuery(requestedId, { root: config?.root })))
        if (kind === 'container' && !trusted && targetsFict) {
          throw new Error(
            '[fict] A direct dev transform cannot start while a pre-HMR request is ' +
              'still settling; retry after that request completes.',
          )
        }
        const canRetry = kind === 'environment' && !activeRequest
        let retryCount = 0
        while (true) {
          const state = activeRequest?.state ?? getEnvironmentTransformState(environment)
          const releaseState = retainTransformState(state)
          const request: MetadataRequestStore = activeRequest ?? {
            activeScopes: 0,
            environment,
            state,
            trusted,
          }
          request.activeScopes++
          let result: unknown
          let failure: unknown
          let failed = false
          try {
            const invoke = () => Reflect.apply(original, receiver, args) as unknown
            result = activeRequest
              ? await invoke()
              : await metadataRequestStorage.run(request, invoke)
          } catch (error) {
            failed = true
            failure = error
          } finally {
            request.activeScopes--
            releaseState()
          }

          const stale = state.retired || failure instanceof StaleMetadataRequestError
          if (
            canRetry &&
            stale &&
            state.retryableAfterRetire &&
            retryCount < MAX_STALE_DEV_REQUEST_RETRIES
          ) {
            const moduleGraph = (environment as { moduleGraph: { invalidateAll: () => void } })
              .moduleGraph
            moduleGraph.invalidateAll()
            retryCount++
            continue
          }
          if (
            isWarmupRequest &&
            activeRequest &&
            stale &&
            (!failed || failure instanceof StaleMetadataRequestError)
          ) {
            return undefined
          }
          if (failed) throw failure
          if (state.retired) throw new StaleMetadataRequestError()
          return result
        }
      }
    }

    const requestMethods = ['transformRequest', 'warmupRequest', 'fetchModule'] as const
    const methods = environment as Record<string, unknown>
    for (const method of requestMethods) {
      wrapRequestMethod(methods, method, environment, 'environment', 0)
    }

    // Container methods are also public pipeline entry points. Resolve/load scopes carry
    // provenance through earlier hooks; otherwise an old captured request could start a
    // nested transform after HMR and launder stale code into the current generation.
    const pluginContainer = methods.pluginContainer
    if (pluginContainer && typeof pluginContainer === 'object') {
      const containerMethods = pluginContainer as unknown as Record<string, unknown>
      wrapRequestMethod(containerMethods, 'resolveId', pluginContainer, 'container', 0)
      wrapRequestMethod(containerMethods, 'load', pluginContainer, 'container', 0)
      wrapRequestMethod(containerMethods, 'transform', pluginContainer, 'container', 1)
    }

    const originalClose = methods.close
    if (typeof originalClose === 'function') {
      methods.close = async (...args: unknown[]) => {
        const retireEnvironmentStates = () => {
          const states = [...transformStates].filter(state => state.environment === environment)
          for (const state of states) retireTransformState(state)
          return states
        }
        retireEnvironmentStates()
        try {
          return await Reflect.apply(originalClose, environment, args)
        } finally {
          const states = retireEnvironmentStates()
          // HMR detaches stale promises from Vite's pending map. Preserve Vite's close
          // contract by waiting for every generation's request/container wrappers.
          await Promise.all(states.map(waitForTransformStateIdle))
          await Promise.allSettled([...(detachedPendingRequests.get(environment) ?? [])])
          detachedPendingRequests.delete(environment)
          environmentTransformStates.delete(environment)
        }
      }
    }
  }

  const ensureTypeScriptProject = async (state: MetadataTransformState) => {
    if (!useTypeScriptProject) return null
    if (state.tsProject) return state.tsProject
    if (!state.tsProjectInit) {
      const rootDir = config?.root ?? process.cwd()
      const explicitConfigPath = tsconfigPath
        ? path.normalize(path.resolve(rootDir, tsconfigPath))
        : undefined
      trackTypeScriptConfigFiles(
        state,
        collectSynchronousTypeScriptConfigDependencies(
          state,
          path.join(rootDir, '__fict_project_entry__.ts'),
          explicitConfigPath,
        ),
        config,
        addTypeScriptConfigWatchFiles,
      )
      state.tsProjectInit = (async () => {
        const ts = await loadTypeScript()
        if (!ts) return null
        const resolvedConfigPath = resolveTsconfigPath(ts, rootDir, tsconfigPath)
        for (const candidate of collectTsconfigSearchCandidates(
          rootDir,
          tsconfigPath,
          resolvedConfigPath,
        )) {
          state.tsConfigDependencies.add(candidate)
        }
        if (!resolvedConfigPath) return null
        const project = await createTypeScriptProject(
          ts,
          rootDir,
          resolvedConfigPath,
          state.tsConfigDependencies,
          state.tsConfigWatchFiles,
        )
        if (!state.retired) {
          addTypeScriptConfigWatchFiles?.(
            [...state.tsConfigWatchFiles].filter(candidate => {
              const rootDirectory = path.parse(candidate).root
              return existsSync(candidate) || path.dirname(candidate) !== rootDirectory
            }),
          )
        }
        return project
      })()
    }
    state.tsProject = await state.tsProjectInit
    return state.tsProject
  }

  const isFrameworkBuildArtifact = (filename: string): boolean => {
    const boundary = findOwningPackageBoundary(filename, packageBoundaryCache)
    if (
      !boundary ||
      boundary.root === projectPackageRoot ||
      !FICT_FRAMEWORK_PACKAGES.has(boundary.name)
    ) {
      return false
    }
    const relativePath = path.relative(boundary.root, stripQuery(filename, { root: config?.root }))
    const [outputDir] = relativePath.split(path.sep)
    return outputDir === 'dist' || outputDir === 'build'
  }

  const shouldCompileModule = (id: string): boolean =>
    shouldTransform(id, transformFilter, config?.root) && !isFrameworkBuildArtifact(id)

  const isTypeScriptConfigDependency = (state: MetadataTransformState, file: string): boolean =>
    state.tsConfigDependencies.has(normalizeFileName(file, config?.root)) ||
    state.tsConfigDependencies.has(normalizeTypeScriptConfigDependency(file, config?.root))

  const registerPackageMetadataDependency = (state: MetadataTransformState, file: string) => {
    const normalized = normalizeFileName(file, config?.root)
    const real = normalizeTypeScriptConfigDependency(file, config?.root)
    const watchedFiles = normalized === real ? [normalized] : [normalized, real]
    state.packageMetadataDependencies.add(normalized)
    state.packageMetadataDependencies.add(real)
    addTypeScriptConfigWatchFiles?.(watchedFiles)
    compilerOptions.onModuleMetadataDependency?.(file)
  }

  const isPackageMetadataDependency = (state: MetadataTransformState, file: string): boolean =>
    state.packageMetadataDependencies.has(normalizeFileName(file, config?.root)) ||
    state.packageMetadataDependencies.has(normalizeTypeScriptConfigDependency(file, config?.root))

  const affectsFictTransform = (
    file: string,
    modules: {
      id?: string | null
      importers?: Iterable<unknown>
    }[],
  ): boolean => {
    if (shouldTransform(file, transformFilter, config?.root)) return true
    const queue: unknown[] = [...modules]
    const seen = new Set<object>()
    while (queue.length > 0) {
      const candidate = queue.shift()
      if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue
      seen.add(candidate)
      const module = candidate as {
        id?: string | null
        importers?: Iterable<unknown>
      }
      if (module.id && shouldCompileModule(stripQuery(module.id, { root: config?.root }))) {
        return true
      }
      if (module.importers) queue.push(...module.importers)
    }
    return false
  }

  const hasMetadataPipelineLoader = (context: MetadataResolveContext): boolean =>
    (config?.command === 'build' && typeof context.load === 'function') ||
    (config?.command === 'serve' && typeof context.environment?.transformRequest === 'function')

  const lookupStoredMetadata = (
    state: MetadataTransformState,
    resolved: string,
  ): ModuleReactiveMetadata | undefined => {
    const normalized = normalizeFileName(resolved, config?.root)
    const direct = state.moduleMetadata.get(normalized)
    if (direct) return direct
    const ext = path.extname(normalized)
    if (!ext) {
      for (const suffix of MODULE_EXTENSIONS) {
        const byExt = state.moduleMetadata.get(`${normalized}${suffix}`)
        if (byExt) return byExt
      }
      for (const suffix of MODULE_EXTENSIONS) {
        const byIndex = state.moduleMetadata.get(path.join(normalized, `index${suffix}`))
        if (byIndex) return byIndex
      }
    }
    return undefined
  }

  const resolveCompilerModuleMetadata = (
    state: MetadataTransformState,
    source: string,
    importer?: string,
  ): ModuleReactiveMetadata | null | undefined => {
    const userResolved = compilerOptions.resolveModuleMetadata?.(source, importer)
    if (userResolved !== undefined) return userResolved
    if (
      shouldSkipMetadataForModuleQuery(source, {
        root: config?.root,
        importer,
      })
    ) {
      return undefined
    }
    if (!importer) return undefined

    const importerFile = normalizeFileName(importer, config?.root)
    const exactResolution = state.resolvedLocalModules.get(
      createLocalResolutionKey(importerFile, source),
    )
    const aliasEntries = normalizeAliases(config?.resolve?.alias)
    let resolvedSource = exactResolution ?? null
    let packageSource: string | null = isBarePackageSource(source) ? source : null

    if (!resolvedSource) {
      if (path.isAbsolute(source)) {
        resolvedSource = normalizeFileName(source, config?.root)
      } else if (source.startsWith('.')) {
        resolvedSource = resolveExistingModuleFile(path.resolve(path.dirname(importerFile), source))
      } else {
        const aliased = applyAlias(source, aliasEntries)
        if (aliased) {
          packageSource = isBarePackageSource(aliased) ? aliased : null
          if (path.isAbsolute(aliased)) {
            resolvedSource = resolveExistingModuleFile(aliased)
          } else if (aliased.startsWith('.')) {
            resolvedSource = resolveExistingModuleFile(
              path.resolve(path.dirname(importerFile), aliased),
            )
          } else if (!packageSource && config?.root) {
            resolvedSource = resolveExistingModuleFile(path.resolve(config.root, aliased))
          }
        }
        // Do not classify an unresolved bare request as local solely because a monorepo
        // tsconfig maps it to workspace source. Exact graph resolutions and explicit Vite
        // aliases above still fail closed when their metadata is missing.
      }
    }

    if (resolvedSource) {
      const resolvedMetadata = lookupStoredMetadata(state, resolvedSource)
      if (resolvedMetadata) return resolvedMetadata
      if (shouldCompileModule(resolvedSource)) {
        throw new Error(
          `[fict] Local module metadata for "${source}" imported by "${importerFile}" ` +
            `was not prepared (${resolvedSource}).`,
        )
      }
    }

    if (!packageSource) return undefined
    return resolvePackageModuleMetadata(packageSource, importerFile, {
      ...compilerOptions,
      moduleMetadata: state.moduleMetadata,
      onModuleMetadataDependency: file => registerPackageMetadataDependency(state, file),
    })
  }

  const createCompilerOptions = async (
    state: MetadataTransformState,
    code: string,
    normalizedFilename: string,
    tsImportElisionOverride?: TypeScriptImportElision,
    transformOptions?: {
      moduleMetadata?: Map<string, ModuleReactiveMetadata>
      publicIdentityId?: string
      useTypeScriptProject?: boolean
    },
  ): Promise<{
    fictOptions: FictCompilerOptions
    project: TypeScriptProject | null
    tsImportElision: TypeScriptImportElision
  }> => {
    assertTransformStateActive(state)
    let publicModuleId: string | undefined
    if (config?.command === 'build' && config.root) {
      const identityId = transformOptions?.publicIdentityId ?? normalizedFilename
      const lookupKey = createPublicModuleLookupKey(identityId, config.root)
      const publicIdentity = createPublicModuleIdentity(
        identityId,
        config.root,
        packageBoundaryCache,
        publicIdentityNamespace,
      )
      publicModuleId = publicIdentity.id
      const previous = publicModuleIds.get(lookupKey)
      if (previous && previous !== publicModuleId) {
        throw new Error(
          `[fict] Vite assigned conflicting public resumable identities to ${JSON.stringify(identityId)}.`,
        )
      }
      const previousSource = publicModuleSourcesById.get(publicModuleId)
      if (previousSource && previousSource !== lookupKey) {
        throw new Error(
          `[fict] Vite assigned the public resumable identity "${publicModuleId}" to multiple modules. ` +
            'Give linked source packages distinct package names or versions.',
        )
      }
      publicModuleIds.set(lookupKey, publicModuleId)
      publicModuleSourcesById.set(publicModuleId, lookupKey)
      publicModulePortability.set(lookupKey, publicIdentity.portable)
    }
    const fictOptions: FictCompilerOptions = {
      ...compilerOptions,
      dev: compilerOptions.dev ?? isDev,
      sourcemap: compilerOptions.sourcemap ?? true,
      filename: normalizedFilename,
      // Production artifacts must never serialize the physical build-machine path.
      // Dev keeps file:// identities so Vite can serve modules directly without a manifest.
      ...(publicModuleId ? { publicModuleId } : {}),
      moduleMetadata: transformOptions?.moduleMetadata ?? state.moduleMetadata,
      resolveModuleMetadata: (source, importer) =>
        resolveCompilerModuleMetadata(state, source, importer),
    }

    const [project, tsImportElision] = await Promise.all([
      transformOptions?.useTypeScriptProject === false
        ? Promise.resolve(null)
        : ensureTypeScriptProject(state),
      tsImportElisionOverride ??
        resolveTypeScriptImportElision(
          state,
          normalizedFilename,
          config,
          addTypeScriptConfigWatchFiles,
        ),
    ])
    assertTransformStateActive(state)
    if (project) {
      project.updateFile(normalizedFilename, code)
      const program = project.getProgram()
      const checker =
        program && typeof program.getTypeChecker === 'function'
          ? program.getTypeChecker()
          : undefined
      fictOptions.typescript = {
        program: program ?? undefined,
        checker,
        projectVersion: project.projectVersion,
        configPath: project.configPath,
      }
    }
    return { fictOptions, project, tsImportElision }
  }

  const resolveGraphDependency = async (
    context: MetadataResolveContext,
    source: string,
    importer: string,
  ): Promise<{ filename: string; loadOptions: MetadataLoadOptions } | null> => {
    if (
      shouldSkipMetadataForModuleQuery(source, {
        root: config?.root,
        importer,
      })
    ) {
      return null
    }
    if (context.resolve) {
      const resolved = await context.resolve(source, importer, { skipSelf: true })
      if (resolved && !resolved.external && !isInternalModuleId(resolved.id)) {
        const resolvedParts = splitModuleId(resolved.id, { root: config?.root })
        if (shouldSkipMetadataForModuleSuffix(resolvedParts.suffix)) return null
        const resolvedFile = resolveExistingModuleFile(resolvedParts.filename)
        if (resolvedFile) {
          const canonicalId = resolvedParts.filename
          return {
            filename: normalizeFileName(resolvedFile, config?.root),
            loadOptions: canonicalId === resolved.id ? resolved : { ...resolved, id: canonicalId },
          }
        }
      }
    }
    const resolved = resolveLocalModuleSource(
      source,
      importer,
      config?.root,
      normalizeAliases(config?.resolve?.alias),
    )
    return resolved ? { filename: resolved, loadOptions: { id: resolved } } : null
  }

  const discoverMetadataGraph = async (
    state: MetadataTransformState,
    context: MetadataResolveContext,
    rootCode: string,
    rootFilename: string,
  ): Promise<Map<string, MetadataGraphNode>> => {
    assertTransformStateActive(state)
    const nodes = new Map<string, MetadataGraphNode>()
    const discovered = new Set<string>()

    const visit = async (
      filename: string,
      suppliedCode?: string,
      loadOptions?: MetadataLoadOptions,
    ): Promise<void> => {
      const normalizedFilename = normalizeFileName(filename, config?.root)
      if (discovered.has(normalizedFilename)) return
      discovered.add(normalizedFilename)

      const pipelineCode = suppliedCode ?? state.pipelineCompilerInputs.get(normalizedFilename)
      const code = pipelineCode ?? (await fs.readFile(normalizedFilename, 'utf8'))
      const node: MetadataGraphNode = {
        filename: normalizedFilename,
        code,
        dependencies: new Set(),
        ...(loadOptions ? { loadOptions } : {}),
      }
      nodes.set(normalizedFilename, node)

      // An uncaptured dependency is a pipeline frontier. Loading it runs earlier transforms;
      // only their resulting imports are authoritative. Manual plugin contexts without a
      // pipeline loader retain the recursive on-disk preparation fallback.
      if (pipelineCode === undefined && hasMetadataPipelineLoader(context)) return

      for (const source of collectStaticModuleSources(code)) {
        const resolved = await resolveGraphDependency(context, source, normalizedFilename)
        if (!resolved || !shouldCompileModule(resolved.filename)) continue
        state.resolvedLocalModules.set(
          createLocalResolutionKey(normalizedFilename, source),
          resolved.filename,
        )
        node.dependencies.add(resolved.filename)
        await visit(resolved.filename, undefined, resolved.loadOptions)
      }
    }

    await visit(rootFilename, rootCode)
    return nodes
  }

  const getPreparationKey = async (
    state: MetadataTransformState,
    node: MetadataGraphNode,
    tsImportElision: TypeScriptImportElision,
  ): Promise<{
    key: string
    fictOptions: FictCompilerOptions
    tsImportElision: TypeScriptImportElision
  }> => {
    assertTransformStateActive(state)
    const { fictOptions, project } = await createCompilerOptions(
      state,
      node.code,
      node.filename,
      tsImportElision,
    )
    const dependencyFingerprint = computePackageMetadataCacheFingerprint(
      node.code,
      node.filename,
      compilerOptions,
      state.moduleMetadata,
      config?.root,
      normalizeAliases(config?.resolve?.alias),
      new Set(),
      state.resolvedLocalModules,
      file => registerPackageMetadataDependency(state, file),
    )
    return {
      key: buildMetadataPreparationKey(
        node.filename,
        node.code,
        fictOptions,
        project,
        tsImportElision,
        dependencyFingerprint,
      ),
      fictOptions,
      tsImportElision,
    }
  }

  const compileMetadataNode = async (
    state: MetadataTransformState,
    node: MetadataGraphNode,
    fictOptions: FictCompilerOptions,
    tsImportElision: TypeScriptImportElision,
  ): Promise<Omit<PreparedCompilerTransform, 'preparationKey'>> => {
    assertTransformStateActive(state)
    const compiled = await compileFictCompilerStage(
      node.code,
      node.filename,
      fictOptions,
      tsImportElision,
    )
    assertTransformStateActive(state)
    const generatedMetadata = state.moduleMetadata.get(node.filename)
    if (!generatedMetadata) {
      throw new Error(`[fict] Compiler did not emit module metadata for ${node.filename}.`)
    }
    return {
      code: compiled.code,
      map: compiled.map,
      moduleMetadata: generatedMetadata,
    }
  }

  const prepareMetadataGraph = async (
    state: MetadataTransformState,
    graph: Map<string, MetadataGraphNode>,
    rootFilename: string,
    pipelinePrepared = new Set<string>(),
  ): Promise<void> => {
    assertTransformStateActive(state)
    const fixedTsImportElisions = new Map<string, TypeScriptImportElision>()
    const getFixedTsImportElision = async (filename: string) => {
      const existing = fixedTsImportElisions.get(filename)
      if (existing) return existing
      const resolved = await resolveTypeScriptImportElision(
        state,
        filename,
        config,
        addTypeScriptConfigWatchFiles,
      )
      fixedTsImportElisions.set(filename, resolved)
      return resolved
    }
    for (const component of getStronglyConnectedMetadataComponents(graph)) {
      const sortedComponent = [...component].sort()
      const normalizedRoot = normalizeFileName(rootFilename, config?.root)
      if (
        sortedComponent.every(
          filename =>
            filename !== normalizedRoot &&
            pipelinePrepared.has(filename) &&
            state.moduleMetadata.has(filename),
        )
      ) {
        continue
      }
      const hasCycle =
        sortedComponent.length > 1 ||
        graph.get(sortedComponent[0]!)?.dependencies.has(sortedComponent[0]!) === true
      // The transform hook compiles the requested root immediately after preparation.
      // Precompile it only when it participates in a cycle; acyclic roots need their
      // dependencies ready, but compiling the root here would defeat the transform cache.
      if (
        !hasCycle &&
        sortedComponent.length === 1 &&
        sortedComponent[0] === normalizeFileName(rootFilename, config?.root)
      ) {
        continue
      }

      const preparedCandidates: {
        filename: string
        prepared: PreparedCompilerTransform | undefined
        key: string
        fictOptions: FictCompilerOptions
        tsImportElision: TypeScriptImportElision
      }[] = []
      // TypeScriptProject is a shared mutable language-service snapshot. Prepare
      // candidate keys deterministically so updateFile/getProgram never race.
      for (const filename of sortedComponent) {
        const node = graph.get(filename)!
        const tsImportElision = await getFixedTsImportElision(filename)
        const preparation = await getPreparationKey(state, node, tsImportElision)
        preparedCandidates.push({
          filename,
          prepared: state.preparedCompilerTransforms.get(filename),
          ...preparation,
        })
      }
      if (
        preparedCandidates.every(candidate => candidate.prepared?.preparationKey === candidate.key)
      ) {
        for (const candidate of preparedCandidates) {
          state.moduleMetadata.set(candidate.filename, candidate.prepared!.moduleMetadata)
        }
        continue
      }

      if (!hasCycle) {
        const filename = sortedComponent[0]!
        const node = graph.get(filename)!
        const tsImportElision = await getFixedTsImportElision(filename)
        const { fictOptions } = await getPreparationKey(state, node, tsImportElision)
        const compiled = await compileMetadataNode(state, node, fictOptions, tsImportElision)
        const { key } = await getPreparationKey(state, node, tsImportElision)
        state.preparedCompilerTransforms.set(filename, { ...compiled, preparationKey: key })
        continue
      }

      for (const filename of sortedComponent) {
        if (!state.moduleMetadata.has(filename)) {
          state.moduleMetadata.set(filename, createEmptyModuleMetadata())
        }
      }

      let latestResults = new Map<string, Omit<PreparedCompilerTransform, 'preparationKey'>>()
      let converged = false
      const maxPasses = Math.max(8, sortedComponent.length * 4)
      for (let pass = 0; pass < maxPasses; pass++) {
        const before = stableStringify(
          sortedComponent.map(filename => [filename, state.moduleMetadata.get(filename)]),
        )
        const passResults = new Map<string, Omit<PreparedCompilerTransform, 'preparationKey'>>()
        for (const filename of sortedComponent) {
          const node = graph.get(filename)!
          const tsImportElision = await getFixedTsImportElision(filename)
          const { fictOptions } = await getPreparationKey(state, node, tsImportElision)
          passResults.set(
            filename,
            await compileMetadataNode(state, node, fictOptions, tsImportElision),
          )
        }
        latestResults = passResults
        const after = stableStringify(
          sortedComponent.map(filename => [filename, state.moduleMetadata.get(filename)]),
        )
        if (after === before) {
          converged = true
          break
        }
      }
      if (!converged) {
        throw new Error(
          `[fict] Local module metadata did not converge for circular dependency: ${sortedComponent.join(', ')}`,
        )
      }
      for (const filename of sortedComponent) {
        const node = graph.get(filename)!
        const result = latestResults.get(filename)!
        const tsImportElision = await getFixedTsImportElision(filename)
        const { key } = await getPreparationKey(state, node, tsImportElision)
        state.preparedCompilerTransforms.set(filename, { ...result, preparationKey: key })
      }
    }
  }

  const preloadPipelineMetadata = async (
    state: MetadataTransformState,
    context: MetadataResolveContext,
    graph: Map<string, MetadataGraphNode>,
    rootFilename: string,
    attemptedLoads: Set<string>,
  ): Promise<boolean> => {
    assertTransformStateActive(state)
    if (!hasMetadataPipelineLoader(context)) return false

    const normalizedRoot = normalizeFileName(rootFilename, config?.root)

    for (const filename of graph.keys()) {
      // A back-edge into an active transform would deadlock the bundler's module loader.
      // Its input has already been captured, so metadata convergence can use that
      // pipeline source directly instead of recursively loading it again.
      if (
        filename === normalizedRoot ||
        state.pipelineTransformsInProgress.has(filename) ||
        attemptedLoads.has(filename)
      ) {
        continue
      }
      if (!state.pipelineTransformedModules.has(filename)) {
        assertTransformStateActive(state)
        attemptedLoads.add(filename)
        const loadOptions = graph.get(filename)?.loadOptions ?? { id: filename }
        if (config?.command === 'build') {
          await context.load!(loadOptions)
        } else {
          const environment = context.environment!
          const requestUrl =
            environment.moduleGraph?.getModuleById(loadOptions.id)?.url ?? loadOptions.id
          await environment.transformRequest!(requestUrl)
        }
        assertTransformStateActive(state)
        if (!state.pipelineCompilerInputs.has(filename)) {
          throw new Error(
            `[fict] Transform pipeline did not provide compiler input for local dependency ${filename}.`,
          )
        }
        return true
      }
    }
    return false
  }

  const prepareReachableMetadata = async (
    state: MetadataTransformState,
    context: MetadataResolveContext,
    code: string,
    filename: string,
  ): Promise<void> => {
    assertTransformStateActive(state)
    let graph = await discoverMetadataGraph(state, context, code, filename)
    assertTransformStateActive(state)
    const attemptedLoads = new Set<string>()
    // Refresh after each load: an earlier transform may add or remove imports, so the
    // raw on-disk dependency graph must not decide which subsequent modules are loaded.
    while (await preloadPipelineMetadata(state, context, graph, filename, attemptedLoads)) {
      assertTransformStateActive(state)
      graph = await discoverMetadataGraph(state, context, code, filename)
    }
    const normalizedRoot = normalizeFileName(filename, config?.root)
    const pipelinePrepared = new Set(
      [...graph.keys()].filter(
        dependency =>
          dependency !== normalizedRoot &&
          state.pipelineTransformedModules.has(dependency) &&
          !state.pipelineTransformsInProgress.has(dependency) &&
          state.moduleMetadata.has(dependency),
      ),
    )
    const prepare = state.metadataPreparationQueue.then(async () => {
      assertTransformStateActive(state)
      await prepareMetadataGraph(state, graph, filename, pipelinePrepared)
    })
    state.metadataPreparationQueue = prepare.then(
      () => undefined,
      () => undefined,
    )
    await prepare
  }

  return {
    name: 'vite-plugin-fict',

    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig
      if (resolvedConfig.build.watch) {
        const chokidar = (resolvedConfig.build.watch.chokidar ??= {})
        const ignored = Array.isArray(chokidar.ignored)
          ? chokidar.ignored
          : chokidar.ignored == null
            ? []
            : [chokidar.ignored]
        chokidar.ignored = [
          ...ignored,
          ...PACKAGE_METADATA_WATCH_GLOBS.filter(pattern => !ignored.includes(pattern)),
        ]
      }
      packageBoundaryCache.clear()
      publicModuleIds.clear()
      publicModuleSourcesById.clear()
      publicModulePortability.clear()
      projectPackageRoot =
        findOwningPackageBoundary(
          path.join(config.root, '__fict_project_entry__.js'),
          packageBoundaryCache,
        )?.root ?? normalizeFileName(config.root)
      isDev = config.command === 'serve' || config.mode === 'development'
      addTypeScriptConfigWatchFiles = null
      // Rebuild cache with resolved config so cacheDir is available
      resetCache()
      // A plugin instance can be reused by Vite restarts. Retire request-scoped dev
      // generations instead of clearing maps that old transforms may still reference.
      for (const state of [...transformStates]) {
        if (state !== buildTransformState) retireTransformState(state)
      }
      replaceBuildTransformState()
    },

    buildStart() {
      const context = this as { addWatchFile?: (file: string) => void } | undefined
      const addWatchFile = context?.addWatchFile
      addTypeScriptConfigWatchFiles =
        typeof addWatchFile === 'function'
          ? files => {
              for (const file of files) addWatchFile.call(context, file)
            }
          : null
      // Vite can reuse plugin instances across watch rebuilds.
      // Reset per-build identity and metadata so package name/version changes are
      // reflected instead of colliding with a prior watch build.
      packageBoundaryCache.clear()
      publicModuleIds.clear()
      publicModuleSourcesById.clear()
      publicModulePortability.clear()
      if (config) {
        projectPackageRoot =
          findOwningPackageBoundary(
            path.join(config.root, '__fict_project_entry__.js'),
            packageBoundaryCache,
          )?.root ?? normalizeFileName(config.root)
      }
      replaceBuildTransformState()
    },

    configureServer: {
      order: 'pre',
      handler(server) {
        addTypeScriptConfigWatchFiles = files => {
          if (files.length > 0) server.watcher.add(files)
        }
        if (useTypeScriptProject && tsconfigPath && config) {
          addTypeScriptConfigWatchFiles([
            normalizeFileName(path.resolve(config.root, tsconfigPath), config.root),
          ])
        }
        for (const environment of Object.values(server.environments)) {
          wrapDevEnvironmentRequests(environment)
        }
      },
    },

    shouldTransformCachedModule({ id }) {
      // Importer output depends on metadata from its local dependency graph. Rollup's
      // watch cache only keys the importer by its own source, so a changed hook can
      // otherwise leave an unchanged importer compiled against stale accessor metadata.
      // Return null for unrelated modules so later plugins can still opt into this hook.
      return shouldCompileModule(id) ? true : null
    },

    resolveId(id: string) {
      // Handle virtual handler modules
      if (id.startsWith(VIRTUAL_HANDLER_RESOLVE_PREFIX)) {
        return VIRTUAL_HANDLER_PREFIX + id.slice(VIRTUAL_HANDLER_RESOLVE_PREFIX.length)
      }
      return null
    },

    load(id: string) {
      // Load virtual handler modules
      if (!id.startsWith(VIRTUAL_HANDLER_PREFIX)) {
        return null
      }

      const state = getTransformState(this as MetadataResolveContext)
      const handlerId = id.slice(VIRTUAL_HANDLER_PREFIX.length)
      debugLog(`Loading virtual module: ${handlerId}`, {
        registrySize: state.extractedHandlers.size,
        handlers: Array.from(state.extractedHandlers.keys()),
      })
      const handler =
        state.extractedHandlers.get(handlerId) ?? manuallyRegisteredHandlers.get(handlerId)
      if (!handler) {
        debugLog(`Virtual module not found: ${handlerId}`, {
          registrySize: state.extractedHandlers.size,
        })
        return null
      }

      // Generate the virtual module with the handler code
      const generatedCode = generateHandlerModule(handler)
      debugLog(`Generated virtual module (${generatedCode.length} chars)`, {
        preview: generatedCode.slice(0, 200),
      })
      return generatedCode
    },

    config(userConfig, env) {
      const userOptimize = userConfig.optimizeDeps
      const hasUserOptimize = !!userOptimize
      const hasDisabledOptimize =
        hasUserOptimize && (userOptimize as { disabled?: boolean }).disabled === true

      // Avoid duplicate runtime instances between pre-bundled deps and /@fs modules.
      // Exclude all workspace packages from prebundling to ensure changes take effect
      // immediately without requiring node_modules reinstall.
      const workspaceDeps = [
        'fict',
        'fict/plus',
        'fict/advanced',
        'fict/internal',
        'fict/internal/list',
        'fict/loader',
        'fict/slim',
        'fict/jsx-runtime',
        'fict/jsx-dev-runtime',
        '@fictjs/runtime',
        '@fictjs/runtime/internal',
        '@fictjs/runtime/advanced',
        '@fictjs/runtime/jsx-runtime',
        '@fictjs/runtime/jsx-dev-runtime',
        '@fictjs/compiler',
        '@fictjs/devtools',
        '@fictjs/devtools/core',
        '@fictjs/devtools/vite',
        '@fictjs/router',
        '@fictjs/ssr',
        '@fictjs/testing-library',
      ]
      // Only dedupe core runtime packages to avoid duplicate instances
      const dedupePackages = [
        'fict',
        'fict/internal',
        '@fictjs/runtime',
        '@fictjs/runtime/internal',
      ]
      const userDedupe = new Set((userConfig.resolve?.dedupe ?? []) as string[])
      const dedupeAdditions = dedupePackages.filter(dep => !userDedupe.has(dep))
      const userExclude = new Set(userOptimize?.exclude ?? [])
      const excludeAdditions = workspaceDeps.filter(dep => !userExclude.has(dep))
      if (!hasDisabledOptimize && userOptimize?.include) {
        const workspaceDepSet = new Set(workspaceDeps)
        userOptimize.include = Array.from(
          new Set(userOptimize.include.filter(dep => !workspaceDepSet.has(dep))),
        )
      }

      // Determine if we're in dev mode based on command or mode
      const devMode = env.command === 'serve' || env.mode === 'development'
      const watchConfig =
        userConfig.server?.watch === null
          ? {}
          : {
              server: {
                watch: {
                  ignored: [
                    '!**/node_modules/@fictjs/**',
                    '!**/node_modules/fict/**',
                    ...PACKAGE_METADATA_WATCH_GLOBS,
                  ],
                },
              },
            }

      return {
        // Define __DEV__ for runtime devtools support
        // In dev mode, enable devtools; in production, disable them for smaller bundles
        define: {
          __DEV__: userConfig.define?.__DEV__ ?? String(devMode),
        },
        build: {
          rollupOptions: {
            // Preserve exports in entry chunks to prevent tree-shaking of handler exports
            preserveEntrySignatures: 'exports-only',
          },
        },
        resolve: {
          dedupe: dedupeAdditions,
        },
        // Watch workspace package builds unless the user explicitly disabled watching.
        // Returning an object for `watch: null` would re-enable Vite's filesystem watcher.
        ...watchConfig,
        ...(!hasDisabledOptimize
          ? { optimizeDeps: { exclude: hasUserOptimize ? excludeAdditions : workspaceDeps } }
          : {}),
      }
    },

    async transform(code: string, id: string): Promise<TransformResult | null> {
      const moduleId = splitModuleId(id, { root: config?.root })
      if (shouldSkipMetadataForModuleSuffix(moduleId.suffix)) return null
      const filename = moduleId.filename

      // Skip non-matching files
      if (!shouldCompileModule(filename)) {
        return null
      }

      const normalizedFilename = normalizeFileName(filename, config?.root)
      const isPassThroughVariant = moduleId.suffix !== ''
      const cacheIdentity = isPassThroughVariant
        ? `${normalizedFilename}${moduleId.suffix}`
        : filename
      const metadataContext = this as MetadataResolveContext
      const state = getTransformInvocationState(metadataContext)
      if (!state) {
        this.error({
          message:
            '[fict] Cannot safely run an unscoped dev transform after HMR; use the current ' +
            'environment.transformRequest() or environment.pluginContainer.transform() entry point.',
          id,
        })
        return null
      }
      if (state.retired) throw new StaleMetadataRequestError()
      const releaseState = retainTransformState(state)
      const pipelineMetadataEnabled =
        !isPassThroughVariant && hasMetadataPipelineLoader(metadataContext)
      const transformMetadata = isPassThroughVariant
        ? new Map<string, ModuleReactiveMetadata>()
        : state.moduleMetadata
      // Pass-through URL variants still need compiled code, but they must not
      // publish metadata or TypeScript program inputs under the physical file's
      // canonical identity. Importers prepare that canonical module separately.
      if (pipelineMetadataEnabled) {
        state.pipelineCompilerInputs.set(normalizedFilename, code)
        state.pipelineTransformsInProgress.set(
          normalizedFilename,
          (state.pipelineTransformsInProgress.get(normalizedFilename) ?? 0) + 1,
        )
      }
      try {
        const precompiledInput = isPrecompiledFictModule(code)
        if (!precompiledInput) {
          let metadataGraphCode = code
          if (isPassThroughVariant) {
            try {
              metadataGraphCode = await fs.readFile(normalizedFilename, 'utf8')
            } catch {
              // A virtual pass-through variant has no canonical disk source.
            }
          }
          await prepareReachableMetadata(
            state,
            metadataContext,
            metadataGraphCode,
            normalizedFilename,
          )
          assertTransformStateActive(state)
        }
        const {
          fictOptions,
          project: tsProject,
          tsImportElision,
        } = await createCompilerOptions(state, code, normalizedFilename, undefined, {
          moduleMetadata: transformMetadata,
          publicIdentityId: id,
          useTypeScriptProject: !isPassThroughVariant,
        })
        const aliasEntries = normalizeAliases(config?.resolve?.alias)
        const dependencyFingerprint = computePackageMetadataCacheFingerprint(
          code,
          normalizedFilename,
          compilerOptions,
          state.moduleMetadata,
          config?.root,
          aliasEntries,
          new Set(),
          state.resolvedLocalModules,
          file => registerPackageMetadataDependency(state, file),
        )
        const cacheStore = ensureCache()
        const shouldSplit =
          options.functionSplitting ??
          (config?.command === 'build' && (compilerOptions.resumable || !config?.build?.ssr))
        // Function callbacks are observable compiler output. Replaying only code/maps from
        // either cache would silently drop warnings and explain artifacts, so compile the
        // requested root again while still allowing dependency metadata preparation to dedupe.
        const hasObservableCompilerCallbacks =
          typeof fictOptions.onWarn === 'function' || typeof fictOptions.explain === 'function'
        const cacheKey =
          cacheStore.enabled && !hasObservableCompilerCallbacks
            ? buildCacheKey(
                cacheIdentity,
                code,
                fictOptions,
                tsProject,
                tsImportElision,
                shouldSplit,
                dependencyFingerprint,
              )
            : null

        if (cacheKey) {
          const cached = await cacheStore.get(cacheKey)
          assertTransformStateActive(state)
          if (cached) {
            if (shouldSplit && cached.extractedHandlers?.length) {
              for (const handler of cached.extractedHandlers) {
                const handlerId = createHandlerId(
                  handler.sourceModule,
                  handler.exportName,
                  config?.root,
                  packageBoundaryCache,
                  publicIdentityNamespace,
                )
                state.extractedHandlers.set(handlerId, handler)
                if (config?.command === 'build' && !config?.build?.ssr) {
                  this.emitFile({
                    type: 'chunk',
                    id: `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`,
                    name: `handler-${handler.exportName}`,
                  })
                }
              }
            }
            if (cached.moduleMetadata) {
              transformMetadata.set(normalizedFilename, cached.moduleMetadata)
            }
            if (pipelineMetadataEnabled) {
              state.pipelineTransformedModules.add(normalizedFilename)
            }
            return {
              code: cached.code,
              map: cached.map,
            }
          }
        }

        let finalCode: string
        let finalMap: TransformResult['map']
        let splitResult: { code: string; handlers: string[]; map: TransformResult['map'] } | null =
          null

        if (precompiledInput) {
          finalCode = code
          finalMap = null
        } else {
          const preparationKey = buildMetadataPreparationKey(
            normalizedFilename,
            code,
            fictOptions,
            tsProject,
            tsImportElision,
            dependencyFingerprint,
          )
          const prepared = isPassThroughVariant
            ? undefined
            : state.preparedCompilerTransforms.get(normalizedFilename)
          let result: { code: string; map: TransformResult['map'] }
          if (!hasObservableCompilerCallbacks && prepared?.preparationKey === preparationKey) {
            result = prepared
          } else {
            result = await compileFictCompilerStage(
              code,
              normalizedFilename,
              fictOptions,
              tsImportElision,
            )
            assertTransformStateActive(state)
            const generatedMetadata = transformMetadata.get(normalizedFilename)
            if (generatedMetadata && !isPassThroughVariant) {
              state.preparedCompilerTransforms.set(normalizedFilename, {
                ...result,
                moduleMetadata: generatedMetadata,
                preparationKey,
              })
            }
          }
          finalCode = result.code
          finalMap = result.map
        }

        // Apply function-level code splitting in production builds
        // For SSR builds with resumable enabled, we also need to rewrite QRLs to virtual URLs
        // so they match the manifest generated by the client build
        debugLog('Function split decision', {
          shouldSplit,
          ssr: config?.build?.ssr,
          resumable: compilerOptions.resumable,
          file: filename,
        })
        if (shouldSplit) {
          try {
            splitResult = extractAndRewriteHandlers(
              finalCode,
              filename,
              state.extractedHandlers,
              finalMap,
              config?.root,
              packageBoundaryCache,
              publicIdentityNamespace,
            )
          } catch (error) {
            this.warn(buildPluginMessage('extractAndRewriteHandlers failed', filename, error))
          }
          debugLog('Split result', {
            file: filename,
            handlers: splitResult?.handlers.length ?? 0,
          })
          if (splitResult) {
            debugLog(`Function splitting extracted ${splitResult.handlers.length} handlers`, {
              file: filename,
            })
            finalCode = splitResult.code
            finalMap = splitResult.map

            // Emit each extracted handler as a separate chunk for lazy loading
            // This ensures the virtual modules are included in the build
            if (config?.command === 'build' && !config?.build?.ssr) {
              for (const handlerName of splitResult.handlers) {
                const handlerId = createHandlerId(
                  filename,
                  handlerName,
                  config?.root,
                  packageBoundaryCache,
                  publicIdentityNamespace,
                )
                const virtualModuleId = `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`
                this.emitFile({
                  type: 'chunk',
                  id: virtualModuleId,
                  name: `handler-${handlerName}`,
                })
              }
            }
          }
        }

        const transformed: TransformResult = {
          code: finalCode,
          map: finalMap,
        }

        if (cacheKey) {
          const cachedTransform: CachedTransform = {
            code: finalCode,
            map: finalMap,
          }
          const generatedModuleMetadata = transformMetadata.get(normalizedFilename)
          if (generatedModuleMetadata) {
            cachedTransform.moduleMetadata = generatedModuleMetadata
          }

          if (shouldSplit && splitResult?.handlers.length) {
            cachedTransform.extractedHandlers = splitResult.handlers
              .map(handlerName =>
                state.extractedHandlers.get(
                  createHandlerId(
                    filename,
                    handlerName,
                    config?.root,
                    packageBoundaryCache,
                    publicIdentityNamespace,
                  ),
                ),
              )
              .filter((handler): handler is ExtractedHandler => !!handler)
          }

          await cacheStore.set(cacheKey, cachedTransform)
          assertTransformStateActive(state)
        }

        if (pipelineMetadataEnabled) {
          state.pipelineTransformedModules.add(normalizedFilename)
        }

        return transformed
      } catch (error) {
        if (error instanceof StaleMetadataRequestError) throw error
        // Better error handling
        const message =
          error instanceof Error ? error.message : 'Unknown error during Fict transformation'

        this.error({
          message: `[fict] Transform failed for ${id}: ${message}`,
          id,
        })

        return null
      } finally {
        if (pipelineMetadataEnabled) {
          const remaining = (state.pipelineTransformsInProgress.get(normalizedFilename) ?? 1) - 1
          if (remaining > 0) {
            state.pipelineTransformsInProgress.set(normalizedFilename, remaining)
          } else {
            state.pipelineTransformsInProgress.delete(normalizedFilename)
          }
        }
        releaseState()
      }
    },

    hotUpdate({ file, modules }) {
      const environment = this.environment
      const state = getEnvironmentTransformState(environment)
      const tsConfigChanged = isTypeScriptConfigDependency(state, file)
      const packageMetadataChanged = isPackageMetadataDependency(state, file)
      const affectsTransform = affectsFictTransform(file, modules)
      if (!tsConfigChanged && !packageMetadataChanged && !affectsTransform) return undefined

      if (tsConfigChanged || packageMetadataChanged) resetCache()
      replaceInvalidatedEnvironmentState(environment)
      environment.hot.send({ type: 'full-reload', path: '*' })
      return []
    },

    // Keep the compatibility hook callable for existing direct plugin integrations.
    // Vite 7 uses hotUpdate above for update/create/delete events.
    handleHotUpdate({ file, server }) {
      const environments = Object.values(server.environments ?? {})
      const tsConfigChanged =
        environments.length === 0
          ? isTypeScriptConfigDependency(buildTransformState, file)
          : environments.some(environment =>
              isTypeScriptConfigDependency(getEnvironmentTransformState(environment), file),
            )
      const packageMetadataChanged =
        environments.length === 0
          ? isPackageMetadataDependency(buildTransformState, file)
          : environments.some(environment =>
              isPackageMetadataDependency(getEnvironmentTransformState(environment), file),
            )
      if (
        !tsConfigChanged &&
        !packageMetadataChanged &&
        !shouldTransform(file, transformFilter, config?.root)
      ) {
        return undefined
      }

      if (tsConfigChanged || packageMetadataChanged) resetCache()
      if (environments.length === 0) {
        replaceBuildTransformState()
      } else {
        for (const environment of environments) replaceInvalidatedEnvironmentState(environment)
      }
      server.ws.send({ type: 'full-reload', path: '*' })
      return []
    },

    generateBundle(_options, bundle) {
      if (!config || config.command !== 'build') return
      if (libraryOptions.enabled) {
        const emittedMetadataAssets = emitLibraryMetadataAssets(
          this.emitFile.bind(this),
          bundle,
          buildTransformState.moduleMetadata,
          {
            root: config.root,
            metadataDir: libraryOptions.metadataDir,
            onMissingMetadata: message => this.warn(message),
          },
        )
        for (const asset of emittedMetadataAssets) {
          libraryMetadataAssets.set(asset.chunkFileName, asset)
        }
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const moduleId of Object.keys(output.modules)) {
          if (moduleId.startsWith(VIRTUAL_HANDLER_PREFIX)) {
            const handlerId = moduleId.slice(VIRTUAL_HANDLER_PREFIX.length)
            const handler = buildTransformState.extractedHandlers.get(handlerId)
            if (!handler && manuallyRegisteredHandlers.has(handlerId)) {
              this.error(
                '[fict] Standalone manually registered handlers cannot be emitted in a ' +
                  'production resumability manifest; let the Vite transform own extraction.',
              )
            }
            if (
              handler &&
              !createPublicModuleSourceIdentity(
                handler.sourceModule,
                config.root,
                packageBoundaryCache,
                publicIdentityNamespace,
              ).portable
            ) {
              this.error(
                '[fict] Resumable production output requires a stable project identity. ' +
                  'Add a named package.json boundary or set publicIdentityNamespace.',
              )
            }
            continue
          }
          if (moduleId.startsWith('\0')) continue
          const lookupKey = createPublicModuleLookupKey(moduleId, config.root)
          const publicId = publicModuleIds.get(lookupKey)
          if (
            publicId &&
            typeof output.code === 'string' &&
            output.code.includes(publicId) &&
            publicModulePortability.get(lookupKey) === false
          ) {
            this.error(
              '[fict] Resumable production output requires a stable project identity. ' +
                'Add a named package.json boundary or set publicIdentityNamespace.',
            )
          }
        }
      }
      if (config.build.ssr) return

      const base = config.base ?? '/'
      const manifest: Record<string, string> = {}
      const addManifestEntry = (key: string, url: string): void => {
        const previous = manifest[key]
        if (previous && previous !== url) {
          this.error(
            `[fict] Public resumable module identity collision for "${key}" (${previous} and ${url}).`,
          )
        }
        manifest[key] = url
      }

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const fileName = output.fileName
        const url = joinBasePath(base, fileName)
        for (const moduleId of Object.keys(output.modules)) {
          if (!moduleId) continue

          // Handle virtual handler modules
          if (moduleId.startsWith(VIRTUAL_HANDLER_PREFIX)) {
            const handlerId = moduleId.slice(VIRTUAL_HANDLER_PREFIX.length)
            // Map the virtual module resolve prefix to the chunk URL
            const virtualKey = `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`
            addManifestEntry(virtualKey, url)
            continue
          }

          // Skip other virtual modules
          if (moduleId.startsWith('\0')) continue

          // Only modules whose generated chunk actually embeds their public QRL
          // identity need a manifest entry. Ordinary Rollup modules are private
          // implementation details and must not expose build-machine paths.
          const key = publicModuleIds.get(createPublicModuleLookupKey(moduleId, config.root))
          if (!key) continue
          if (typeof output.code === 'string' && output.code.includes(key)) {
            addManifestEntry(key, url)
          }
        }
      }

      if (Object.keys(manifest).length === 0) return

      this.emitFile({
        type: 'asset',
        fileName: 'fict.manifest.json',
        source: JSON.stringify(
          Object.fromEntries(
            Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)),
          ),
        ),
      })
    },

    async writeBundle() {
      if (!config || !libraryOptions.enabled || libraryOptions.packageJson === false) return
      await writeLibraryPackageJson(libraryMetadataAssets, {
        root: config.root,
        outDir: resolveBuildOutDir(config),
        packageJson: libraryOptions.packageJson,
        onWarning: message => this.warn(message),
        onError: message => this.error(message),
      })
    },
  }
}

/**
 * Check if a file should be transformed based on include/exclude patterns
 */
function shouldTransform(
  id: string,
  filter: ReturnType<typeof createFilter>,
  root?: string,
): boolean {
  // Normalize path separators
  const withoutQuery = stripQuery(id, { root })
  if (isInternalModuleId(withoutQuery) || isTypeScriptDeclarationFile(withoutQuery)) {
    return false
  }

  const normalizedId = withoutQuery.replace(/\\/g, '/')

  return filter(normalizedId)
}

function findOwningPackageBoundary(
  filename: string,
  cache: Map<string, PackageBoundary | null>,
): PackageBoundary | null {
  let directory = path.dirname(stripQuery(filename))
  const visited: string[] = []

  while (true) {
    const cached = cache.get(directory)
    if (cached !== undefined || cache.has(directory)) {
      for (const item of visited) cache.set(item, cached ?? null)
      return cached ?? null
    }

    visited.push(directory)
    const packageJsonPath = path.join(directory, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        const packageName =
          typeof packageJson.name === 'string' ? packageJson.name.trim() : undefined
        if (packageName) {
          const packageVersion =
            typeof packageJson.version === 'string' ? packageJson.version.trim() : undefined
          const boundary: PackageBoundary = {
            root: directory,
            name: packageName,
            ...(packageVersion ? { version: packageVersion } : {}),
          }
          for (const item of visited) cache.set(item, boundary)
          return boundary
        }
      } catch {
        // Invalid/unreadable package manifests are not safe exclusion signals.
      }
    }

    const parent = path.dirname(directory)
    if (parent === directory) {
      for (const item of visited) cache.set(item, null)
      return null
    }
    directory = parent
  }
}

function isTypeScriptDeclarationFile(id: string): boolean {
  return /\.d\.(?:ts|mts|cts)(?:$|#)/i.test(id)
}

function isInternalModuleId(id: string): boolean {
  return (
    id.includes('\0') ||
    id.startsWith('virtual:') ||
    id.startsWith('/@id/') ||
    id.startsWith('/@vite/') ||
    id.startsWith('@vite/')
  )
}

interface SplitModuleIdOptions {
  root?: string | undefined
  importer?: string | undefined
}

interface SplitModuleIdResult {
  filename: string
  suffix: string
}

function resolvePhysicalModuleCandidate(
  candidate: string,
  options: SplitModuleIdOptions,
): string | null {
  const candidates: string[] = []

  if (candidate.startsWith('/@fs/')) {
    candidates.push(candidate.slice('/@fs/'.length))
  } else if (candidate.startsWith('file://')) {
    // URL search/hash delimiters are unambiguously suffixes. Physical `?` / `#`
    // characters in a file URL are percent-encoded and therefore need no probing.
    return null
  } else if (path.isAbsolute(candidate)) {
    candidates.push(candidate)
    if (options.root && candidate.startsWith('/')) {
      candidates.push(path.resolve(options.root, `.${candidate}`))
    }
  } else if (candidate.startsWith('.')) {
    if (options.importer) {
      const importer = normalizeFileName(options.importer, options.root)
      candidates.push(path.resolve(path.dirname(importer), candidate))
    } else if (options.root) {
      candidates.push(path.resolve(options.root, candidate))
    }
  }

  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return null
}

function findSyntacticModuleSuffixStart(id: string): number {
  const queryStart = id.indexOf('?')
  const fragmentStart = id.indexOf('#', id.startsWith('#') ? 1 : 0)
  if (queryStart === -1) return fragmentStart === -1 ? id.length : fragmentStart
  if (fragmentStart === -1) return queryStart
  return Math.min(queryStart, fragmentStart)
}

/**
 * Split a module request without mistaking legal `?` / `#` filename characters for
 * Vite URL suffixes. The longest existing filesystem prefix wins, so
 * `/file?name.ts?raw` resolves to the physical `/file?name.ts` plus `?raw`.
 */
function splitModuleId(id: string, options: SplitModuleIdOptions = {}): SplitModuleIdResult {
  const syntacticSuffixStart = findSyntacticModuleSuffixStart(id)
  if (syntacticSuffixStart === id.length) return { filename: id, suffix: '' }

  const candidateEnds = [id.length]
  for (let index = id.length - 1; index >= 0; index--) {
    const character = id[index]
    if ((character === '?' || character === '#') && !(character === '#' && index === 0)) {
      candidateEnds.push(index)
    }
  }

  for (const end of candidateEnds) {
    const filename = id.slice(0, end)
    if (!filename || !resolvePhysicalModuleCandidate(filename, options)) continue
    return { filename, suffix: id.slice(end) }
  }

  return {
    filename: id.slice(0, syntacticSuffixStart),
    suffix: id.slice(syntacticSuffixStart),
  }
}

/** Remove a Vite URL query/fragment while preserving physical filename characters. */
function stripQuery(id: string, options?: SplitModuleIdOptions): string {
  return splitModuleId(id, options).filename
}

function normalizeCacheOptions(
  cacheOption: FictPluginOptions['cache'],
  config?: ResolvedConfig,
): NormalizedCacheOptions {
  const defaultPersistent = config?.command === 'build'
  const defaultDir = config?.cacheDir ? path.join(config.cacheDir, 'fict') : undefined

  if (cacheOption === false) {
    return { enabled: false, persistent: false, dir: undefined }
  }

  if (cacheOption === true || cacheOption === undefined) {
    return { enabled: true, persistent: defaultPersistent, dir: defaultDir }
  }

  return {
    enabled: cacheOption.enabled ?? true,
    persistent: cacheOption.persistent ?? defaultPersistent,
    dir: cacheOption.dir ?? defaultDir,
  }
}

function normalizeLibraryOptions(library: FictPluginOptions['library']): NormalizedLibraryOptions {
  if (!library) return { enabled: false, metadataDir: '', packageJson: false }
  if (library === true) return { enabled: true, metadataDir: '', packageJson: 'package.json' }
  return {
    enabled: true,
    metadataDir: normalizeAssetDir(library.metadataDir),
    packageJson: library.packageJson ?? 'package.json',
  }
}

function normalizeFileName(id: string, root?: string): string {
  let clean = stripQuery(id, { root })
  if (clean.startsWith('/@fs/')) {
    clean = clean.slice('/@fs/'.length)
  }
  if (clean.startsWith('file://')) {
    try {
      clean = fileURLToPath(clean)
    } catch {
      // fall through
    }
  }
  if (path.isAbsolute(clean)) return path.normalize(clean)
  if (root) return path.normalize(path.resolve(root, clean))
  return path.normalize(path.resolve(clean))
}

function normalizeIdentityPath(filename: string): string {
  const normalized = path.normalize(path.resolve(filename))
  let existing = normalized
  const missingSegments: string[] = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return normalized
    missingSegments.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.normalize(path.join(realpathSync(existing), ...missingSegments))
  } catch {
    return normalized
  }
}

function isPathAtOrInsideDirectory(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

function portableRelativePath(directory: string, filename: string): string {
  return (path.relative(directory, filename) || '.').split(path.sep).join('/')
}

function getPublicModuleIdentityParts(
  id: string,
  rootDir: string,
): { filename: string; lookupKey: string; suffix: string } {
  const { filename, suffix } = splitModuleId(id, { root: rootDir })
  const normalizedFilename = normalizeIdentityPath(normalizeFileName(filename, rootDir))
  return {
    filename: normalizedFilename,
    lookupKey: JSON.stringify([normalizedFilename, suffix]),
    suffix,
  }
}

function createPublicModuleLookupKey(id: string, rootDir: string): string {
  return getPublicModuleIdentityParts(id, rootDir).lookupKey
}

interface PublicModuleIdentity {
  id: string
  portable: boolean
  source: string
}

/**
 * Derive a checkout-independent identity source without publishing a filesystem path.
 * Files under the Vite root use their logical root-relative request. Linked files use
 * a named, versioned package boundary. An unnamed external source has no portable
 * identity, so production compilation fails closed instead of embedding a checkout path.
 */
function createPublicModuleSourceIdentity(
  filename: string,
  rootDir: string,
  packageBoundaryCache: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): Omit<PublicModuleIdentity, 'id'> {
  const root = normalizeIdentityPath(rootDir)
  const { filename: source, suffix } = getPublicModuleIdentityParts(filename, rootDir)
  if (isPathAtOrInsideDirectory(root, source)) {
    if (explicitNamespace) {
      return {
        portable: true,
        source: JSON.stringify([
          'project-namespace',
          explicitNamespace,
          portableRelativePath(root, source),
          suffix,
        ]),
      }
    }
    const projectBoundary = findOwningPackageBoundary(
      path.join(root, '__fict_project_entry__.js'),
      packageBoundaryCache,
    )
    if (projectBoundary) {
      const packageRoot = normalizeIdentityPath(projectBoundary.root)
      return {
        portable: true,
        source: JSON.stringify([
          'project-package',
          projectBoundary.name,
          projectBoundary.version ?? '',
          portableRelativePath(packageRoot, root),
          portableRelativePath(root, source),
          suffix,
        ]),
      }
    }
    return {
      portable: false,
      source: JSON.stringify(['unowned-root', portableRelativePath(root, source), suffix]),
    }
  }

  const boundary = findOwningPackageBoundary(source, packageBoundaryCache)
  if (boundary) {
    const packageRoot = normalizeIdentityPath(boundary.root)
    if (isPathAtOrInsideDirectory(packageRoot, source)) {
      return {
        portable: true,
        source: JSON.stringify([
          'package',
          boundary.name,
          boundary.version ?? '',
          portableRelativePath(packageRoot, source),
          suffix,
        ]),
      }
    }
  }

  throw new Error(
    `[fict] Cannot derive a checkout-independent resumable identity for ${JSON.stringify(filename)}. ` +
      'The source is outside the Vite root and has no named package.json boundary.',
  )
}

function createPublicModuleId(
  filename: string,
  rootDir: string,
  packageBoundaryCache: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): string {
  return createPublicModuleIdentity(filename, rootDir, packageBoundaryCache, explicitNamespace).id
}

function createPublicModuleIdentity(
  filename: string,
  rootDir: string,
  packageBoundaryCache: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): PublicModuleIdentity {
  const sourceIdentity = createPublicModuleSourceIdentity(
    filename,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
  )
  return {
    ...sourceIdentity,
    id: `${PUBLIC_MODULE_PREFIX}${hashString(sourceIdentity.source).slice(0, 32)}`,
  }
}

function normalizeTypeScriptConfigDependency(id: string, root?: string): string {
  const normalized = normalizeFileName(id, root)
  try {
    return path.normalize(realpathSync(normalized))
  } catch {
    return normalized
  }
}

type EmitAsset = (asset: { type: 'asset'; fileName: string; source: string }) => string

interface BundleChunkLike {
  type: string
  fileName: string
  isEntry?: boolean
  facadeModuleId?: string | null
  modules?: Record<string, unknown>
  exports?: string[]
}

type BundleLike = Record<string, BundleChunkLike | { type: string }>

function normalizeAssetDir(dir: string | undefined): string {
  if (!dir) return ''
  const normalized = dir
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  if (!normalized || normalized === '.') return ''
  if (normalized.startsWith('/') || normalized.includes('\0')) return ''
  if (normalized.split('/').includes('..')) return ''
  return normalized
}

function joinAssetPath(...parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => !!part)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
}

function metadataFileNameForChunk(chunkFileName: string, metadataDir: string): string {
  const normalized = chunkFileName.replace(/\\/g, '/')
  const chunkDir = path.posix.dirname(normalized)
  const baseName = path.posix.basename(normalized).replace(/\.(?:mjs|cjs|js)$/, '')
  const defaultDir = chunkDir === '.' ? '' : chunkDir
  return joinAssetPath(metadataDir, defaultDir, `${baseName}.fict.meta.json`)
}

function getStoredModuleMetadata(
  store: Map<string, ModuleReactiveMetadata>,
  moduleId: string | undefined | null,
  root: string,
): ModuleReactiveMetadata | undefined {
  if (!moduleId || moduleId.startsWith('\0')) return undefined
  const normalized = normalizeFileName(moduleId, root)
  return store.get(normalized) ?? store.get(moduleId)
}

function setMetadataRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function mergeMetadata(
  target: ModuleReactiveMetadata,
  source: ModuleReactiveMetadata | undefined,
  allowedExports: Set<string> | null,
): void {
  if (!source) return
  for (const [name, kind] of Object.entries(source.exports)) {
    if (allowedExports && !allowedExports.has(name)) continue
    setMetadataRecordValue(target.exports, name, kind)
  }
  if (source.hooks) {
    for (const [name, info] of Object.entries(source.hooks)) {
      if (allowedExports && !allowedExports.has(name)) continue
      target.hooks ??= {}
      setMetadataRecordValue(target.hooks, name, info)
    }
  }
  if (source.namespaces) {
    for (const [name, info] of Object.entries(source.namespaces)) {
      if (allowedExports && !allowedExports.has(name)) continue
      target.namespaces ??= {}
      setMetadataRecordValue(target.namespaces, name, info)
    }
  }
}

function buildEntryChunkMetadata(
  chunk: BundleChunkLike,
  store: Map<string, ModuleReactiveMetadata>,
  root: string,
): ModuleReactiveMetadata | null {
  const stored = getStoredModuleMetadata(store, chunk.facadeModuleId, root)
  // A transformed module's empty metadata is authoritative: emitting it
  // overwrites stale sidecars when a public hook becomes a plain export.
  if (stored === undefined) return null

  const allowedExports = chunk.exports ? new Set(chunk.exports) : null
  const metadata: ModuleReactiveMetadata = {
    version: LIBRARY_METADATA_VERSION,
    exports: {},
  }

  mergeMetadata(metadata, stored, allowedExports)

  return metadata
}

function emitLibraryMetadataAssets(
  emitFile: EmitAsset,
  bundle: BundleLike,
  store: Map<string, ModuleReactiveMetadata>,
  options: { root: string; metadataDir: string; onMissingMetadata?: (message: string) => void },
): LibraryMetadataAsset[] {
  const emitted = new Set<string>()
  const assets: LibraryMetadataAsset[] = []
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue
    const chunk = output as BundleChunkLike
    if (!chunk.isEntry) continue
    const metadata = buildEntryChunkMetadata(chunk, store, options.root)
    if (!metadata) {
      options.onMissingMetadata?.(
        `[fict] Library entry "${chunk.fileName}" did not produce Fict metadata. ` +
          'If this entry exports Fict hooks, ensure it is transformed by the Fict Vite plugin or annotate complex returns with @fictReturn.',
      )
      continue
    }

    const fileName = metadataFileNameForChunk(chunk.fileName, options.metadataDir)
    if (emitted.has(fileName)) continue
    emitted.add(fileName)
    assets.push({
      chunkFileName: chunk.fileName,
      metadataFileName: fileName,
    })
    emitFile({
      type: 'asset',
      fileName,
      source: JSON.stringify(metadata),
    })
  }
  return assets
}

function resolveBuildOutDir(config: ResolvedConfig): string {
  const configuredOutDir = config.build?.outDir ?? 'dist'
  return path.isAbsolute(configuredOutDir)
    ? configuredOutDir
    : path.resolve(config.root, configuredOutDir)
}

function resolvePackageJsonPath(root: string, packageJson: string): string {
  return path.isAbsolute(packageJson) ? packageJson : path.resolve(root, packageJson)
}

function toPackageJsonRelativePath(packageDir: string, absoluteFilePath: string): string {
  const relative = path.relative(packageDir, absoluteFilePath).replace(/\\/g, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function isPathInsideDirectory(directory: string, absoluteFilePath: string): boolean {
  const relative = path.relative(directory, absoluteFilePath)
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  )
}

function normalizePackageJsonTarget(
  value: string,
  allowRelativeWithoutPrefix = false,
): string | null {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('./')) return `./${normalized.slice(2)}`
  if (
    !allowRelativeWithoutPrefix ||
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('\0')
  ) {
    return null
  }
  return `./${normalized}`
}

function collectExportTargets(
  value: unknown,
  subpath = '.',
): { subpath: string; target: string }[] {
  if (typeof value === 'string') {
    return [{ subpath, target: value }]
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectExportTargets(item, subpath))
  }
  if (!value || typeof value !== 'object') {
    return []
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const hasSubpathKeys = entries.some(([key]) => key === '.' || key.startsWith('./'))
  if (hasSubpathKeys) {
    return entries.flatMap(([key, nested]) => collectExportTargets(nested, key))
  }
  return entries.flatMap(([, nested]) => collectExportTargets(nested, subpath))
}

function collectPackageTargets(
  pkg: Record<string, unknown>,
): { subpath: string; target: string }[] {
  const targets = collectExportTargets(pkg.exports)
  for (const field of ['module', 'main'] as const) {
    if (typeof pkg[field] === 'string') {
      const target = normalizePackageJsonTarget(pkg[field], true)
      if (target) targets.push({ subpath: '.', target })
    }
  }
  return targets
}

function collectPackageExportEntries(value: unknown): [string, unknown][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [['.', value]]
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.some(([key]) => key === '.' || key.startsWith('./'))) return [['.', value]]
  return entries.filter(([key]) => key === '.' || key.startsWith('./'))
}

function collectConditionalTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectConditionalTargets)
  if (!value || typeof value !== 'object') return []
  return Object.values(value as Record<string, unknown>).flatMap(collectConditionalTargets)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchRepeatedWildcardPattern(pattern: string, value: string): string | null {
  if (!pattern.includes('*')) return null
  const parts = pattern.split('*')
  let source = `^${escapeRegExp(parts[0] ?? '')}(.*?)`
  for (let index = 1; index < parts.length; index++) {
    source += escapeRegExp(parts[index] ?? '')
    if (index < parts.length - 1) source += '(?:\\1)'
  }
  const match = new RegExp(`${source}$`).exec(value)
  return match?.[1] ?? null
}

function replaceWildcardPattern(pattern: string, matched: string): string {
  return pattern.split('*').join(matched)
}

function comparePackageExportPatterns(left: string, right: string): number {
  const leftPrefixLength = left.indexOf('*') + 1
  const rightPrefixLength = right.indexOf('*') + 1
  return rightPrefixLength - leftPrefixLength || right.length - left.length
}

function resolvePackageExportEntry(
  exportsValue: unknown,
  subpath: string,
): { value: unknown; wildcard: string | null } | null {
  const entries = collectPackageExportEntries(exportsValue)
  const exact = entries.find(([key]) => key === subpath)
  if (exact) return { value: exact[1], wildcard: null }

  const patterns = entries
    .filter(([key]) => key.includes('*'))
    .map(([key, value]) => ({
      key,
      value,
      wildcard: matchRepeatedWildcardPattern(key, subpath),
    }))
    .filter(
      (entry): entry is { key: string; value: unknown; wildcard: string } =>
        entry.wildcard !== null,
    )
    .sort((left, right) => comparePackageExportPatterns(left.key, right.key))
  const selected = patterns[0]
  return selected ? { value: selected.value, wildcard: selected.wildcard } : null
}

function collectPatternExportSubpaths(
  exportsValue: unknown,
  chunkPackagePath: string,
): Set<string> {
  const subpaths = new Set<string>()
  for (const [subpathPattern, value] of collectPackageExportEntries(exportsValue)) {
    if (!subpathPattern.includes('*')) continue
    for (const target of collectConditionalTargets(value)) {
      const targetPattern = normalizePackageJsonTarget(target)
      if (!targetPattern?.includes('*')) continue
      const wildcard = matchRepeatedWildcardPattern(targetPattern, chunkPackagePath)
      if (wildcard === null) continue

      const candidate = replaceWildcardPattern(subpathPattern, wildcard)
      const selected = resolvePackageExportEntry(exportsValue, candidate)
      if (!selected) continue
      const selectedTargets = collectConditionalTargets(selected.value)
      const selectsChunk = selectedTargets.some(selectedTarget => {
        const normalizedTarget = normalizePackageJsonTarget(selectedTarget)
        if (!normalizedTarget) return false
        const concreteTarget =
          selected.wildcard === null
            ? normalizedTarget
            : replaceWildcardPattern(normalizedTarget, selected.wildcard)
        return concreteTarget === chunkPackagePath
      })
      if (selectsChunk) subpaths.add(candidate)
    }
  }
  return subpaths
}

function buildFictPackageMappingResult(
  assets: Iterable<LibraryMetadataAsset>,
  pkg: Record<string, unknown>,
  packageDir: string,
  outDir: string,
): FictPackageMappingResult {
  const packageTargets = collectPackageTargets(pkg)
  const targetToSubpaths = new Map<string, Set<string>>()
  for (const { subpath, target } of packageTargets) {
    const normalizedTarget = normalizePackageJsonTarget(target)
    if (!normalizedTarget) continue
    const subpaths = targetToSubpaths.get(normalizedTarget) ?? new Set<string>()
    subpaths.add(subpath)
    targetToSubpaths.set(normalizedTarget, subpaths)
  }

  const mappings = new Map<string, string>()
  const unmappedAssets: LibraryMetadataAsset[] = []
  const assetList = Array.from(assets)
  for (const asset of assetList) {
    const chunkPackagePath = toPackageJsonRelativePath(
      packageDir,
      path.resolve(outDir, asset.chunkFileName),
    )
    const metadataPackagePath = toPackageJsonRelativePath(
      packageDir,
      path.resolve(outDir, asset.metadataFileName),
    )
    const subpaths = new Set(targetToSubpaths.get(chunkPackagePath) ?? [])
    for (const subpath of collectPatternExportSubpaths(pkg.exports, chunkPackagePath)) {
      subpaths.add(subpath)
    }
    if (subpaths.size) {
      for (const subpath of subpaths) mappings.set(subpath, metadataPackagePath)
    } else {
      unmappedAssets.push(asset)
    }
  }

  if (packageTargets.length === 0 && mappings.size === 0 && assetList.length === 1) {
    const asset = assetList[0]
    if (asset) {
      const chunkPath = path.resolve(outDir, asset.chunkFileName)
      const metadataPath = path.resolve(outDir, asset.metadataFileName)
      if (
        isPathInsideDirectory(packageDir, chunkPath) &&
        isPathInsideDirectory(packageDir, metadataPath)
      ) {
        mappings.set('.', toPackageJsonRelativePath(packageDir, metadataPath))
        return { mappings, unmappedAssets: [], rootFallbackOutsidePackage: false }
      }

      return { mappings, unmappedAssets, rootFallbackOutsidePackage: true }
    }
  }

  const mappedMetadataPaths = new Set(mappings.values())
  return {
    mappings,
    rootFallbackOutsidePackage: false,
    unmappedAssets: unmappedAssets.filter(asset => {
      const metadataPackagePath = toPackageJsonRelativePath(
        packageDir,
        path.resolve(outDir, asset.metadataFileName),
      )
      return !mappedMetadataPaths.has(metadataPackagePath)
    }),
  }
}

function applyFictPackageMappings(
  pkg: Record<string, unknown>,
  mappings: Map<string, string>,
): boolean {
  if (mappings.size === 0) return false

  const existingFict =
    pkg.fict && typeof pkg.fict === 'object' && !Array.isArray(pkg.fict)
      ? { ...(pkg.fict as Record<string, unknown>) }
      : {}
  if (typeof existingFict.metadata !== 'string' && typeof pkg.fictMetadata === 'string') {
    existingFict.metadata = pkg.fictMetadata
  }
  const existingExports =
    existingFict.exports &&
    typeof existingFict.exports === 'object' &&
    !Array.isArray(existingFict.exports)
      ? { ...(existingFict.exports as Record<string, unknown>) }
      : {}
  const sortedExports = (exports: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(exports).sort(([a], [b]) => a.localeCompare(b)))

  if (mappings.size === 1 && mappings.has('.')) {
    existingFict.metadata = mappings.get('.')
    // `fict.exports['.']` takes precedence over `fict.metadata` in consumers.
    // Remove only that stale root mapping while preserving independently built subpaths.
    delete existingExports['.']
    if (Object.keys(existingExports).length > 0) {
      existingFict.exports = sortedExports(existingExports)
    } else {
      delete existingFict.exports
    }
  } else {
    for (const [subpath, metadataPath] of mappings) {
      existingExports[subpath] = metadataPath
    }
    existingFict.exports = sortedExports(existingExports)
  }

  pkg.fict = existingFict
  delete pkg.fictMetadata
  return true
}

async function writeLibraryPackageJson(
  assets: Map<string, LibraryMetadataAsset>,
  options: {
    root: string
    outDir: string
    packageJson: string
    onWarning?: (message: string) => void
    onError?: (message: string) => never
  },
): Promise<void> {
  if (assets.size === 0) {
    options.onWarning?.(
      '[fict] Library mode did not emit any Fict metadata assets. If this package exports Fict hooks, consumers will not receive package metadata.',
    )
    return
  }

  const packageJsonPath = resolvePackageJsonPath(options.root, options.packageJson)
  const raw = await fs.readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw) as Record<string, unknown>
  const { mappings, unmappedAssets, rootFallbackOutsidePackage } = buildFictPackageMappingResult(
    assets.values(),
    pkg,
    path.dirname(packageJsonPath),
    options.outDir,
  )
  if (mappings.size === 0) {
    const message = rootFallbackOutsidePackage
      ? '[fict] Library metadata cannot use the automatic root fallback because the generated entry or metadata file is outside the package.json directory. Move build.outDir inside the package, add a publishable package entry, or set library.packageJson to false and declare metadata yourself.'
      : '[fict] Library metadata was emitted, but no package.json exports/module/main target matched the generated entry chunks. ' +
        'Add package.json#exports, module, or main entries that point at the built library entry files, or set library.packageJson to false and declare metadata yourself.'
    if (options.onError) options.onError(message)
    throw new Error(message)
  }
  if (unmappedAssets.length > 0) {
    const files = unmappedAssets
      .map(asset => asset.chunkFileName)
      .sort()
      .join(', ')
    const message =
      `[fict] Library metadata for ${files} could not be declared in package.json. ` +
      'Every metadata-producing public entry must be listed in package.json#exports, module, or main.'
    if (options.onError) options.onError(message)
    throw new Error(message)
  }
  if (!applyFictPackageMappings(pkg, mappings)) return

  await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

/**
 * Detect modules that already contain compiler output.
 * Re-running the compiler on these inputs can produce false diagnostics.
 */
function isPrecompiledFictModule(code: string): boolean {
  const hasCompilerMarker =
    code.includes('__fict_hir_codegen__') ||
    code.includes('__fictQrl(') ||
    code.includes('__fictUseLexicalScope')

  if (!hasCompilerMarker) {
    return false
  }

  return /export\s+(?:const|function)\s+__fict_[er]\d+/.test(code)
}

function joinBasePath(base: string, fileName: string): string {
  if (!base) return fileName
  if (base === '/') return `/${fileName}`
  const normalized = base.endsWith('/') ? base : `${base}/`
  return `${normalized}${fileName}`
}

function collectClosestTsconfigCandidates(
  filename: string,
  resolvedConfigPath: string | null,
): string[] {
  const candidates: string[] = []
  const stopDirectory = resolvedConfigPath
    ? path.dirname(resolvedConfigPath)
    : path.parse(filename).root
  let directory = path.dirname(filename)
  while (true) {
    candidates.push(path.normalize(path.join(directory, 'tsconfig.json')))
    if (directory === stopDirectory) break
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return candidates
}

interface DeclaredTypeScriptConfigDependencies {
  extended: string[]
  referenced: string[]
}

function getStaticObjectProperty(object: t.ObjectExpression, name: string): t.Expression | null {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index]
    if (!t.isObjectProperty(property) || property.computed) continue
    const key = property.key
    const keyName = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null
    if (keyName !== name || !t.isExpression(property.value)) continue
    return property.value
  }
  return null
}

function readDeclaredTypeScriptConfigDependencies(
  configPath: string,
): DeclaredTypeScriptConfigDependencies | null {
  let expression: t.Expression
  try {
    expression = parseExpression(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''), {
      sourceType: 'script',
    })
  } catch {
    return null
  }
  if (!t.isObjectExpression(expression)) return null

  const extendedValue = getStaticObjectProperty(expression, 'extends')
  const extended = t.isStringLiteral(extendedValue)
    ? [extendedValue.value]
    : t.isArrayExpression(extendedValue)
      ? extendedValue.elements.filter(t.isStringLiteral).map(element => element.value)
      : []
  const referencedValue = getStaticObjectProperty(expression, 'references')
  const referenced = t.isArrayExpression(referencedValue)
    ? referencedValue.elements.flatMap(element => {
        if (!t.isObjectExpression(element)) return []
        const referencePath = getStaticObjectProperty(element, 'path')
        return t.isStringLiteral(referencePath) ? [referencePath.value] : []
      })
    : []
  return { extended, referenced }
}

function resolveDeclaredExtendedConfigCandidates(specifier: string, configPath: string): string[] {
  let normalizedSpecifier = specifier
  if (normalizedSpecifier === '.' || normalizedSpecifier === '..') {
    normalizedSpecifier = path.join(normalizedSpecifier, 'tsconfig.json')
  }
  if (path.isAbsolute(normalizedSpecifier) || normalizedSpecifier.startsWith('.')) {
    const candidate = path.normalize(path.resolve(path.dirname(configPath), normalizedSpecifier))
    return [candidate, `${candidate}.json`]
  }

  const require = createRequire(configPath)
  for (const candidate of [normalizedSpecifier, `${normalizedSpecifier}/tsconfig.json`]) {
    try {
      return [path.normalize(require.resolve(candidate))]
    } catch {
      // Try the package tsconfig convention after its direct entry point.
    }
  }
  return []
}

function resolveDeclaredReferencedConfigCandidate(specifier: string, configPath: string): string {
  const candidate = path.resolve(path.dirname(configPath), specifier)
  return path.normalize(
    specifier.endsWith('.json') ? candidate : path.join(candidate, 'tsconfig.json'),
  )
}

function collectSynchronousTypeScriptConfigDependencies(
  state: MetadataTransformState,
  filename: string,
  explicitConfigPath?: string,
): string[] {
  const closureKey = explicitConfigPath
    ? `closure:config:${path.normalize(explicitConfigPath)}`
    : `closure:directory:${path.normalize(path.dirname(filename))}`
  const cachedClosure = state.tsConfigDependencyClosures.get(closureKey)
  if (cachedClosure) return cachedClosure

  const dependencies = new Set<string>()
  const searchCandidates = explicitConfigPath
    ? [path.normalize(explicitConfigPath)]
    : collectClosestTsconfigCandidates(filename, null)
  for (const candidate of searchCandidates) dependencies.add(candidate)

  const readConfig = (configPath: string) => {
    const normalized = path.normalize(configPath)
    if (!state.tsDeclaredConfigDependencies.has(normalized)) {
      state.tsDeclaredConfigDependencies.set(
        normalized,
        readDeclaredTypeScriptConfigDependencies(normalized),
      )
    }
    return state.tsDeclaredConfigDependencies.get(normalized) ?? null
  }
  const rootConfig = explicitConfigPath
    ? path.normalize(explicitConfigPath)
    : searchCandidates.find(candidate => existsSync(candidate))
  if (!rootConfig) {
    const closure = [...dependencies]
    state.tsConfigDependencyClosures.set(closureKey, closure)
    return closure
  }

  const graphKey = `graph:${path.normalize(rootConfig)}`
  const cachedGraph = state.tsConfigDependencyClosures.get(graphKey)
  if (cachedGraph) {
    for (const dependency of cachedGraph) dependencies.add(dependency)
    const closure = [...dependencies]
    state.tsConfigDependencyClosures.set(closureKey, closure)
    return closure
  }

  const graphDependencies = new Set<string>([rootConfig])
  const queue = [rootConfig]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const configPath = path.normalize(queue.shift()!)
    if (visited.has(configPath)) continue
    visited.add(configPath)
    const declared = readConfig(configPath)
    if (!declared) continue

    for (const specifier of declared.extended) {
      const candidates = resolveDeclaredExtendedConfigCandidates(specifier, configPath)
      for (const candidate of candidates) graphDependencies.add(candidate)
      const resolved = candidates.find(candidate => readConfig(candidate) !== null)
      if (resolved) queue.push(resolved)
    }
    for (const specifier of declared.referenced) {
      const candidate = resolveDeclaredReferencedConfigCandidate(specifier, configPath)
      graphDependencies.add(candidate)
      if (readConfig(candidate)) queue.push(candidate)
    }
  }
  const graph = [...graphDependencies]
  state.tsConfigDependencyClosures.set(graphKey, graph)
  for (const dependency of graph) dependencies.add(dependency)
  const closure = [...dependencies]
  state.tsConfigDependencyClosures.set(closureKey, closure)
  return closure
}

function trackTypeScriptConfigFiles(
  state: MetadataTransformState,
  configFiles: Iterable<string>,
  config: ResolvedConfig | undefined,
  addWatchFiles: ((files: string[]) => void) | null,
): void {
  if (state.retired) return
  const watchFiles: string[] = []
  for (const configFile of configFiles) {
    const direct = normalizeFileName(configFile, config?.root)
    const canonical = normalizeTypeScriptConfigDependency(configFile, config?.root)
    state.tsConfigDependencies.add(direct)
    state.tsConfigDependencies.add(canonical)
    if (state.tsConfigWatchFiles.has(canonical)) continue
    state.tsConfigWatchFiles.add(canonical)
    const rootDirectory = path.parse(canonical).root
    if (existsSync(canonical) || path.dirname(canonical) !== rootDirectory) {
      watchFiles.push(canonical)
    }
  }
  if (watchFiles.length > 0 && !state.retired) addWatchFiles?.(watchFiles)
}

function resolveTypeScriptImportElision(
  state: MetadataTransformState,
  filename: string,
  config: ResolvedConfig | undefined,
  addWatchFiles: ((files: string[]) => void) | null,
): Promise<TypeScriptImportElision> {
  if (!TYPESCRIPT_EXTENSIONS.some(extension => filename.endsWith(extension))) {
    return Promise.resolve('remove')
  }
  const cached = state.tsImportElisions.get(filename)
  if (cached) return cached

  const pending = resolveTypeScriptImportElisionUncached(state, filename, config, addWatchFiles)
  state.tsImportElisions.set(filename, pending)
  return pending
}

async function resolveTypeScriptImportElisionUncached(
  state: MetadataTransformState,
  filename: string,
  config: ResolvedConfig | undefined,
  addWatchFiles: ((files: string[]) => void) | null,
): Promise<TypeScriptImportElision> {
  const configuredEsbuild = config?.esbuild === false ? undefined : config?.esbuild
  const configuredRaw = configuredEsbuild?.tsconfigRaw
  if (typeof configuredRaw !== 'string') {
    trackTypeScriptConfigFiles(
      state,
      collectSynchronousTypeScriptConfigDependencies(state, filename),
      config,
      addWatchFiles,
    )
  }

  // Vite caches parsed tsconfig files by ResolvedConfig identity. Give every Fict
  // generation its own identity so build-watch/HMR replacements cannot reuse a
  // previous generation's tsconfig result while still sharing parses across files.
  const probeConfig = (state.tsImportElisionConfig ??= config
    ? (Object.create(config) as ResolvedConfig)
    : ({ root: process.cwd() } as ResolvedConfig))

  let result: Awaited<ReturnType<typeof transformWithEsbuild>>
  try {
    result = await transformWithEsbuild(
      TYPESCRIPT_IMPORT_PROBE,
      filename,
      {
        loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
        format: 'esm',
        target: 'esnext',
        treeShaking: false,
        sourcemap: false,
        ...(configuredRaw === undefined ? {} : { tsconfigRaw: configuredRaw }),
      },
      undefined,
      probeConfig,
    )
  } catch {
    // Vite's normal TypeScript stage will report malformed tsconfig files. Preserve
    // the historical lowering mode here so the Fict pre-transform does not replace
    // that diagnostic or make standalone plugin integrations fail earlier.
    return 'remove'
  }
  const ast = parse(result.code, { sourceType: 'module' })
  const probeImport = ast.program.body.find(
    (statement): statement is t.ImportDeclaration =>
      t.isImportDeclaration(statement) && statement.source.value === TYPESCRIPT_IMPORT_PROBE_SOURCE,
  )
  if (!probeImport) return 'remove'
  return probeImport.specifiers.length === 0 ? 'preserve-side-effect' : 'verbatim'
}

interface AliasEntry {
  find: string | RegExp
  replacement: string
}

function normalizeAliases(aliases: ResolvedConfig['resolve']['alias'] | undefined): AliasEntry[] {
  if (!aliases) return []
  if (Array.isArray(aliases)) {
    return aliases
      .map(alias => {
        if (!alias || !('find' in alias)) return null
        const replacement =
          typeof alias.replacement === 'string' ? alias.replacement : String(alias.replacement)
        return { find: alias.find, replacement } as AliasEntry
      })
      .filter((alias): alias is AliasEntry => !!alias)
  }
  return Object.entries(aliases).map(([find, replacement]) => ({
    find,
    replacement: typeof replacement === 'string' ? replacement : String(replacement),
  }))
}

function applyAlias(source: string, aliases: AliasEntry[]): string | null {
  for (const alias of aliases) {
    if (typeof alias.find === 'string') {
      if (source === alias.find || source.startsWith(`${alias.find}/`)) {
        return alias.replacement + source.slice(alias.find.length)
      }
      continue
    }
    if (alias.find instanceof RegExp && alias.find.test(source)) {
      return source.replace(alias.find, alias.replacement)
    }
  }
  return null
}

function isBarePackageSource(source: string): boolean {
  return !path.isAbsolute(source) && !source.startsWith('.') && !source.startsWith('/@fs/')
}

function resolveAliasedPackageSource(source: string, aliases: AliasEntry[]): string | null {
  const aliased = applyAlias(source, aliases)
  if (aliased) return isBarePackageSource(aliased) ? aliased : null
  return isBarePackageSource(source) ? source : null
}

function shouldSkipMetadataForModuleQuery(source: string, options?: SplitModuleIdOptions): boolean {
  return shouldSkipMetadataForModuleSuffix(splitModuleId(source, options).suffix)
}

function shouldSkipMetadataForModuleSuffix(suffix: string): boolean {
  if (!suffix.startsWith('?')) return false
  const fragmentStart = suffix.indexOf('#', 1)
  const query = suffix.slice(1, fragmentStart === -1 ? undefined : fragmentStart)
  if (!query) return false

  // Vite's import/cache-busting queries preserve the JavaScript module's exports.
  // Other built-in and third-party queries may turn the file into a URL, string,
  // worker constructor, or another virtual shape, so they cannot reuse source metadata.
  const passThroughQueries = new Set(['import', 't', 'v'])
  return query.split('&').some(part => {
    const rawKey = part.split('=', 1)[0] ?? ''
    let key = rawKey
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      // An invalid query escape is not safe to classify as the source module.
    }
    return !!key && !passThroughQueries.has(key)
  })
}

function createLocalResolutionKey(importer: string, source: string): string {
  return `${normalizeFileName(importer)}\0${source}`
}

function createEmptyModuleMetadata(): ModuleReactiveMetadata {
  return { version: LIBRARY_METADATA_VERSION, exports: {} }
}

function getStronglyConnectedMetadataComponents(graph: Map<string, MetadataGraphNode>): string[][] {
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

    const dependencies = [...(graph.get(filename)?.dependencies ?? [])].sort()
    for (const dependency of dependencies) {
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

function getImportSpecifierSemanticKey(
  source: string,
  specifier: t.ImportDeclaration['specifiers'][number],
): string {
  if (t.isImportDefaultSpecifier(specifier)) {
    return JSON.stringify([source, 'default', specifier.local.name])
  }
  if (t.isImportNamespaceSpecifier(specifier)) {
    return JSON.stringify([source, 'namespace', specifier.local.name])
  }
  const imported = t.isIdentifier(specifier.imported)
    ? specifier.imported.name
    : specifier.imported.value
  return JSON.stringify([source, 'named', imported, specifier.local.name])
}

function preserveTypeScriptImportSideEffects(): PluginItem {
  const sourceSpecifiers = new Set<string>()
  return {
    name: 'fict-preserve-typescript-import-side-effects',
    visitor: {
      Program: {
        enter(programPath: NodePath<t.Program>) {
          for (const statement of programPath.node.body) {
            if (!t.isImportDeclaration(statement)) continue
            for (const specifier of statement.specifiers) {
              sourceSpecifiers.add(getImportSpecifierSemanticKey(statement.source.value, specifier))
            }
          }
        },
        exit(programPath: NodePath<t.Program>) {
          programPath.scope.crawl()
          for (const statement of programPath.get('body')) {
            if (!statement.isImportDeclaration() || statement.node.specifiers.length === 0) {
              continue
            }
            for (const specifier of statement.get('specifiers')) {
              const key = getImportSpecifierSemanticKey(statement.node.source.value, specifier.node)
              if (!sourceSpecifiers.has(key)) continue
              const binding = programPath.scope.getBinding(specifier.node.local.name)
              if (binding && !binding.referenced && binding.constantViolations.length === 0) {
                specifier.remove()
              }
            }
          }
        },
      },
    },
  }
}

function lowerCtsModuleSyntax(): PluginItem {
  return {
    name: 'fict-lower-cts-module-syntax',
    visitor: {
      TSImportEqualsDeclaration(importPath: NodePath<t.TSImportEqualsDeclaration>) {
        const { node } = importPath
        if (node.importKind === 'type') {
          importPath.remove()
          return
        }
        if (!t.isTSExternalModuleReference(node.moduleReference)) return

        const declaration = t.importDeclaration(
          [t.importDefaultSpecifier(t.cloneNode(node.id))],
          t.cloneNode(node.moduleReference.expression),
        )
        t.inheritsComments(declaration, node)
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
      TSExportAssignment(exportPath: NodePath<t.TSExportAssignment>) {
        const declaration = t.exportDefaultDeclaration(exportPath.node.expression)
        t.inheritsComments(declaration, exportPath.node)
        exportPath.replaceWith(declaration)
      },
    },
  }
}

async function compileFictCompilerStage(
  code: string,
  filename: string,
  fictOptions: FictCompilerOptions,
  tsImportElision: TypeScriptImportElision,
): Promise<{ code: string; map: TransformResult['map'] }> {
  const isTypeScript = TYPESCRIPT_EXTENSIONS.some(extension => filename.endsWith(extension))
  const isTSX = filename.endsWith('.tsx')
  const isExplicitModuleTypeScript = filename.endsWith('.mts') || filename.endsWith('.cts')
  const plugins: PluginItem[] = []
  if (filename.endsWith('.cts')) plugins.push(lowerCtsModuleSyntax())
  if (isTypeScript) {
    plugins.push([
      transformTypeScript,
      {
        isTSX,
        allExtensions: true,
        allowDeclareFields: true,
        allowNamespaces: true,
        disallowAmbiguousJSXLike: isExplicitModuleTypeScript,
        onlyRemoveTypeImports: tsImportElision !== 'remove',
      },
    ])
  }
  plugins.push(['@babel/plugin-syntax-jsx', {}], [createFictPlugin, fictOptions])
  if (isTypeScript && tsImportElision === 'preserve-side-effect') {
    plugins.push(preserveTypeScriptImportSideEffects())
  }
  const result = await transformAsync(code, {
    filename,
    configFile: false,
    babelrc: false,
    ...(isTypeScript
      ? {
          parserOpts: { plugins: ['decorators-legacy'] },
          generatorOpts: { decoratorsBeforeExport: true },
        }
      : {}),
    sourceMaps: fictOptions.sourcemap,
    sourceFileName: filename,
    plugins,
  })
  if (!result?.code) {
    throw new Error(`[fict] Compiler returned no output for ${filename}.`)
  }
  return {
    code: result.code,
    map: result.map as TransformResult['map'],
  }
}

function collectStaticModuleSources(code: string): string[] {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: [...TYPESCRIPT_PARSER_PLUGINS],
    })
  } catch {
    return []
  }

  const sources = new Set<string>()
  for (const node of ast.program.body) {
    if (
      t.isTSImportEqualsDeclaration(node) &&
      node.importKind !== 'type' &&
      t.isTSExternalModuleReference(node.moduleReference)
    ) {
      sources.add(node.moduleReference.expression.value)
      continue
    }
    if (t.isImportDeclaration(node)) {
      sources.add(node.source.value)
      continue
    }
    if (t.isExportNamedDeclaration(node) && node.source) {
      sources.add(node.source.value)
      continue
    }
    if (t.isExportAllDeclaration(node)) {
      sources.add(node.source.value)
    }
  }
  return Array.from(sources).sort()
}

function resolveExistingModuleFile(base: string): string | null {
  const normalized = normalizeFileName(base)
  if (existsSync(normalized)) return normalized

  const ext = path.extname(normalized)
  if (!ext) {
    for (const suffix of MODULE_EXTENSIONS) {
      const withExt = `${normalized}${suffix}`
      if (existsSync(withExt)) return withExt
    }
    for (const suffix of MODULE_EXTENSIONS) {
      const indexFile = path.join(normalized, `index${suffix}`)
      if (existsSync(indexFile)) return indexFile
    }
  }

  return null
}

function resolveLocalModuleSource(
  source: string,
  importer: string,
  root: string | undefined,
  aliases: AliasEntry[],
): string | null {
  const importerFile = normalizeFileName(importer, root)
  const sourceParts = splitModuleId(source, { root, importer: importerFile })
  if (shouldSkipMetadataForModuleSuffix(sourceParts.suffix)) return null
  const sourceFile = sourceParts.filename
  if (path.isAbsolute(sourceFile)) return resolveExistingModuleFile(sourceFile)
  if (sourceFile.startsWith('.')) {
    return resolveExistingModuleFile(path.resolve(path.dirname(importerFile), sourceFile))
  }

  const aliased = applyAlias(sourceFile, aliases)
  if (!aliased) return null
  if (path.isAbsolute(aliased)) return resolveExistingModuleFile(aliased)
  if (aliased.startsWith('.')) {
    return resolveExistingModuleFile(path.resolve(path.dirname(importerFile), aliased))
  }
  if (root) return resolveExistingModuleFile(path.resolve(root, aliased))
  return null
}

function computePackageMetadataCacheFingerprint(
  code: string,
  filename: string,
  compilerOptions: FictCompilerOptions,
  moduleMetadata: Map<string, ModuleReactiveMetadata>,
  root?: string,
  aliases: AliasEntry[] = [],
  visited = new Set<string>(),
  resolvedLocalModules?: ReadonlyMap<string, string>,
  onPackageMetadataDependency?: (filename: string) => void,
): string {
  const normalizedFilename = normalizeFileName(filename, root)
  if (visited.has(normalizedFilename)) return '[]'
  visited.add(normalizedFilename)

  const entries: [string, string | null, string?][] = []
  for (const source of collectStaticModuleSources(code)) {
    const userMetadata = compilerOptions.resolveModuleMetadata?.(source, normalizedFilename)
    if (userMetadata !== undefined) {
      entries.push([
        source,
        userMetadata === null ? null : stableStringify(userMetadata),
        'custom-resolver',
      ])
      continue
    }
    const localFile =
      resolvedLocalModules?.get(createLocalResolutionKey(normalizedFilename, source)) ??
      resolveLocalModuleSource(source, normalizedFilename, root, aliases)
    if (localFile) {
      try {
        const localCode = readFileSync(localFile, 'utf8')
        const storedMetadata = moduleMetadata.get(localFile)
        const nestedFingerprint = computePackageMetadataCacheFingerprint(
          localCode,
          localFile,
          compilerOptions,
          moduleMetadata,
          root,
          aliases,
          visited,
          resolvedLocalModules,
          onPackageMetadataDependency,
        )
        entries.push([
          source,
          storedMetadata ? stableStringify(storedMetadata) : null,
          `${hashString(localCode)}:${nestedFingerprint}`,
        ])
      } catch {
        entries.push([source, null, 'unreadable'])
      }
      continue
    }
    const packageSource = resolveAliasedPackageSource(source, aliases)
    if (packageSource) {
      const metadata = resolvePackageModuleMetadata(packageSource, normalizedFilename, {
        ...compilerOptions,
        moduleMetadata,
        ...(onPackageMetadataDependency
          ? { onModuleMetadataDependency: onPackageMetadataDependency }
          : {}),
      })
      const serializedMetadata = metadata ? stableStringify(metadata) : null
      entries.push(
        packageSource === source
          ? [source, serializedMetadata]
          : [source, serializedMetadata, `alias:${packageSource}`],
      )
    }
  }
  return stableStringify(entries)
}

export const __fictVitePluginInternals = {
  computePackageMetadataCacheFingerprint,
  buildFictPackageMappingResult,
  applyFictPackageMappings,
  createPublicModuleId: (filename: string, root: string, namespace?: string): string =>
    createPublicModuleId(filename, root, new Map(), namespace),
  createHandlerId: (
    filename: string,
    exportName: string,
    root: string,
    namespace?: string,
  ): string => createHandlerId(filename, exportName, root, new Map(), namespace),
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => a.localeCompare(b))

  const body = entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(',')

  return `{${body}}`
}

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return undefined
}

function compilerEnvironmentCacheInputs(options: FictCompilerOptions): Record<string, unknown> {
  const strictGuaranteeFromEnv = readBooleanEnv('FICT_STRICT_GUARANTEE') === true
  const nodeEnv = process.env.NODE_ENV
  return {
    nodeEnv,
    strictGuaranteeEnv: process.env.FICT_STRICT_GUARANTEE,
    effectiveStrictGuarantee:
      strictGuaranteeFromEnv || nodeEnv === 'production' || options.strictGuarantee !== false,
  }
}

function normalizeOptionsForCache(options: FictCompilerOptions): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || typeof value === 'function') continue
    if (key === 'typescript') {
      const tsInfo = value as {
        projectVersion?: number
        configPath?: string
      }
      normalized.typescript = {
        projectVersion: tsInfo?.projectVersion,
        configPath: tsInfo?.configPath,
      }
      continue
    }
    normalized[key] = value
  }
  normalized.__fictCompilerEnv = compilerEnvironmentCacheInputs(options)
  return normalized
}

function buildCacheKey(
  filename: string,
  code: string,
  options: FictCompilerOptions,
  tsProject: TypeScriptProject | null,
  tsImportElision: TypeScriptImportElision,
  shouldSplit: boolean,
  packageMetadataFingerprint: string,
): string {
  const codeHash = hashString(code)
  const optionsHash = hashString(stableStringify(normalizeOptionsForCache(options)))
  const tsKey = tsProject ? `${tsProject.configHash}:${tsProject.projectVersion}` : ''
  return hashString(
    [
      CACHE_VERSION,
      getTransformCacheFingerprint(),
      filename,
      codeHash,
      optionsHash,
      tsKey,
      tsImportElision,
      shouldSplit ? 'split' : 'inline',
      packageMetadataFingerprint,
    ].join('|'),
  )
}

function buildMetadataPreparationKey(
  filename: string,
  code: string,
  options: FictCompilerOptions,
  tsProject: TypeScriptProject | null,
  tsImportElision: TypeScriptImportElision,
  dependencyMetadataFingerprint: string,
): string {
  const normalizedOptions = normalizeOptionsForCache(options)
  const typescript = normalizedOptions.typescript
  if (typescript && typeof typescript === 'object') {
    // The compiler does not currently consume the Program. A global project version
    // would make the same module miss this per-module cache whenever an unrelated file
    // is discovered, so the source/dependency graph and tsconfig hash are the stable key.
    delete (typescript as Record<string, unknown>).projectVersion
  }
  return hashString(
    [
      CACHE_VERSION,
      getTransformCacheFingerprint(),
      'metadata-preparation',
      filename,
      hashString(code),
      hashString(stableStringify(normalizedOptions)),
      tsProject?.configHash ?? '',
      tsImportElision,
      dependencyMetadataFingerprint,
    ].join('|'),
  )
}

class TransformCache {
  private memory = new Map<string, CachedTransform>()

  constructor(private options: NormalizedCacheOptions) {}

  get enabled(): boolean {
    return this.options.enabled
  }

  async get(key: string): Promise<CachedTransform | null> {
    if (!this.options.enabled) return null
    const cached = this.memory.get(key)
    if (cached) return cached

    if (!this.options.persistent || !this.options.dir) return null

    const filePath = path.join(this.options.dir, `${key}.json`)
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as CachedTransform
      if (!parsed || typeof parsed.code !== 'string') return null
      this.memory.set(key, parsed)
      return parsed
    } catch {
      return null
    }
  }

  async set(key: string, value: CachedTransform): Promise<void> {
    if (!this.options.enabled) return
    this.memory.set(key, value)
    if (!this.options.persistent || !this.options.dir) return

    const filePath = path.join(this.options.dir, `${key}.json`)
    try {
      await fs.mkdir(this.options.dir, { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(value))
    } catch {
      // Ignore cache write failures
    }
  }

  clear(): void {
    this.memory.clear()
  }
}

function isTypeScriptApi(value: unknown): value is TypeScriptApi {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TypeScriptApi>
  return (
    typeof candidate.findConfigFile === 'function' &&
    typeof candidate.readConfigFile === 'function' &&
    typeof candidate.parseJsonConfigFileContent === 'function' &&
    typeof candidate.createLanguageService === 'function' &&
    typeof candidate.createDocumentRegistry === 'function' &&
    typeof candidate.resolveModuleName === 'function' &&
    !!candidate.sys &&
    typeof candidate.sys === 'object' &&
    typeof candidate.sys.fileExists === 'function' &&
    typeof candidate.sys.readFile === 'function'
  )
}

function safeDebugString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function buildPluginMessage(context: string, file: string, error: unknown): string {
  return `[fict-plugin] ${context} (${file}): ${formatError(error)}`
}

async function loadTypeScript(): Promise<TypeScriptApi | null> {
  try {
    const mod = await import('typescript')
    const candidate = (mod as { default?: unknown }).default ?? mod
    return isTypeScriptApi(candidate) ? candidate : null
  } catch {
    return null
  }
}

function resolveTsconfigPath(
  ts: TypeScriptApi,
  rootDir: string,
  explicitPath?: string,
): string | null {
  if (explicitPath) {
    return path.normalize(path.resolve(rootDir, explicitPath))
  }
  const resolved = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json')
  return resolved ? path.normalize(resolved) : null
}

function collectTsconfigSearchCandidates(
  rootDir: string,
  explicitPath: string | undefined,
  resolvedPath: string | null,
): string[] {
  if (explicitPath) return [path.normalize(path.resolve(rootDir, explicitPath))]

  const candidates: string[] = []
  const stopDirectory = resolvedPath
    ? path.dirname(resolvedPath)
    : path.parse(path.resolve(rootDir)).root
  let directory = path.resolve(rootDir)
  while (true) {
    candidates.push(path.normalize(path.join(directory, 'tsconfig.json')))
    if (directory === stopDirectory) break
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return candidates
}

function collectDeclaredExtendedConfigCandidates(config: unknown, configPath: string): string[] {
  if (!config || typeof config !== 'object' || !('extends' in config)) return []
  const extended = (config as { extends?: unknown }).extends
  const specifiers = Array.isArray(extended) ? extended : [extended]
  const candidates = new Set<string>()
  for (const specifier of specifiers) {
    if (typeof specifier !== 'string') continue
    for (const candidate of resolveDeclaredExtendedConfigCandidates(specifier, configPath)) {
      candidates.add(candidate)
    }
  }
  return [...candidates]
}

async function createTypeScriptProject(
  ts: TypeScriptApi,
  rootDir: string,
  configPath: string,
  configDependencies: Set<string>,
  configWatchFiles: Set<string>,
): Promise<TypeScriptProject | null> {
  const normalizedConfigPath = path.normalize(configPath)
  configDependencies.add(normalizedConfigPath)
  configWatchFiles.add(normalizedConfigPath)
  const configInputSnapshots = new Map<string, string | null>()
  const trackConfigCandidate = (candidate: string, watch: boolean) => {
    const normalized = path.normalize(candidate)
    configDependencies.add(normalized)
    if (watch) configWatchFiles.add(normalized)
  }
  const trackedSystem: TypeScriptSystem = {
    ...ts.sys,
    fileExists: candidate => {
      trackConfigCandidate(candidate, false)
      return ts.sys.fileExists(candidate)
    },
    readFile: candidate => {
      trackConfigCandidate(candidate, true)
      const contents = ts.sys.readFile(candidate)
      configInputSnapshots.set(path.normalize(candidate), contents ?? null)
      return contents
    },
  }

  const configText = trackedSystem.readFile(normalizedConfigPath)
  if (!configText) return null

  const configFile = ts.readConfigFile(normalizedConfigPath, trackedSystem.readFile)
  if (configFile.error) return null
  for (const candidate of collectDeclaredExtendedConfigCandidates(
    configFile.config,
    normalizedConfigPath,
  )) {
    configDependencies.add(candidate)
    configWatchFiles.add(candidate)
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    trackedSystem,
    path.dirname(normalizedConfigPath),
  )
  if (ts.parseConfigFileTextToJson) {
    for (const [dependency, contents] of configInputSnapshots) {
      if (contents === null || path.basename(dependency).toLowerCase() === 'package.json') continue
      const dependencyConfig = ts.parseConfigFileTextToJson(dependency, contents)
      if (dependencyConfig.error) continue
      for (const candidate of collectDeclaredExtendedConfigCandidates(
        dependencyConfig.config,
        dependency,
      )) {
        configDependencies.add(candidate)
        configWatchFiles.add(candidate)
      }
    }
  }
  const configHash = hashString(
    stableStringify([...configInputSnapshots.entries()].sort(([a], [b]) => a.localeCompare(b))),
  )

  const fileSet = new Set<string>(parsed.fileNames.map((name: string) => path.normalize(name)))
  const fileVersions = new Map<string, number>()
  const fileHashes = new Map<string, string>()
  const fileCache = new Map<string, string>()
  let projectVersion = 0

  const normalizeName = (fileName: string) => normalizeFileName(fileName, rootDir)

  const serviceHost: TypeScriptLanguageServiceHost = {
    getScriptFileNames: () => Array.from(fileSet),
    getScriptVersion: (fileName: string) => {
      const normalized = normalizeName(fileName)
      return String(fileVersions.get(normalized) ?? 0)
    },
    getScriptSnapshot: (fileName: string) => {
      const normalized = normalizeName(fileName)
      const text = fileCache.get(normalized) ?? ts.sys.readFile(normalized)
      if (text === undefined) return undefined
      return ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => rootDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options: unknown) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectVersion: () => String(projectVersion),
  }

  const service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry())

  const updateFile = (fileName: string, code: string) => {
    const normalized = normalizeName(fileName)
    const nextHash = hashString(code)
    if (fileHashes.get(normalized) === nextHash) return
    fileHashes.set(normalized, nextHash)
    fileCache.set(normalized, code)
    fileVersions.set(normalized, (fileVersions.get(normalized) ?? 0) + 1)
    fileSet.add(normalized)
    projectVersion += 1
  }

  return {
    configPath: normalizedConfigPath,
    configHash,
    get projectVersion() {
      return projectVersion
    },
    updateFile,
    getProgram: () => service.getProgram?.() ?? null,
    resolveModuleName: (specifier: string, containingFile: string) => {
      try {
        const resolved = ts.resolveModuleName(specifier, containingFile, parsed.options, ts.sys)
        return resolved?.resolvedModule?.resolvedFileName ?? null
      } catch {
        return null
      }
    },
    dispose: () => service.dispose?.(),
  }
}

// ============================================================================
// Function-level Code Splitting Helpers
// ============================================================================

/**
 * Generate handler ID from source module and export name.
 * Public handler identities must be reproducible across checkout locations and
 * safe to embed in QRL URLs. Keep the absolute source path only in the private
 * handler record, where Rollup needs it to resolve dependency imports.
 */
function createHandlerSourceIdentity(
  sourceModule: string,
  rootDir?: string,
  packageBoundaryCache = new Map<string, PackageBoundary | null>(),
  explicitNamespace?: string,
): string {
  if (!rootDir) {
    return `external:${hashString(sourceModule.split(path.sep).join('/'))}`
  }
  const root = normalizeIdentityPath(rootDir)
  const { filename, suffix } = getPublicModuleIdentityParts(sourceModule, rootDir)
  const publicIdentity = createPublicModuleSourceIdentity(
    sourceModule,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
  )
  if (!publicIdentity.portable && isPathAtOrInsideDirectory(root, filename)) {
    // Preserve the established root-local handler ABI while extending the same
    // checkout-independent contract to namespaced projects and linked packages.
    return `${portableRelativePath(root, filename)}${suffix}`
  }
  return publicIdentity.source
}

function createHandlerId(
  sourceModule: string,
  exportName: string,
  rootDir?: string,
  packageBoundaryCache?: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): string {
  const sourceIdentity = createHandlerSourceIdentity(
    sourceModule,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
  )
  return `h${hashString(sourceIdentity).slice(0, 32)}$$${exportName}`
}

function detectRuntimeImportFamilyFromCode(body: readonly unknown[]): 'fict' | 'runtime' {
  let sawFictFamily = false
  let sawStandaloneRuntimeFamily = false

  for (const stmt of body) {
    const source =
      stmt && typeof stmt === 'object' && 'source' in stmt
        ? (stmt as { source?: { value?: string } | null }).source?.value
        : undefined
    if (typeof source !== 'string') continue

    if (
      source === 'fict' ||
      source === 'fict/advanced' ||
      source === 'fict/internal' ||
      source === 'fict/internal/list' ||
      source === 'fict/jsx-runtime' ||
      source === 'fict/jsx-dev-runtime' ||
      source === 'fict/loader' ||
      source === 'fict/plus' ||
      source === 'fict/slim'
    ) {
      sawFictFamily = true
      continue
    }

    if (
      source === '@fictjs/runtime' ||
      source === '@fictjs/runtime/advanced' ||
      source === '@fictjs/runtime/internal' ||
      source === '@fictjs/runtime/internal/list' ||
      source === '@fictjs/runtime/jsx-runtime' ||
      source === '@fictjs/runtime/jsx-dev-runtime' ||
      source === '@fictjs/runtime/loader'
    ) {
      sawStandaloneRuntimeFamily = true
    }
  }

  if (sawFictFamily) return 'fict'
  if (sawStandaloneRuntimeFamily) return 'runtime'
  return 'fict'
}

function getRuntimeHelperModule(helperName: string, family: 'fict' | 'runtime'): string {
  if (helperName === 'keyedList') {
    return family === 'runtime' ? '@fictjs/runtime/internal/list' : 'fict/internal/list'
  }

  return family === 'runtime' ? '@fictjs/runtime/internal' : 'fict/internal'
}

function normalizeRuntimeHelperUsage(usage: RuntimeHelperUsage): {
  helperName: string
  localName: string
} {
  if (typeof usage === 'string') {
    return { helperName: usage, localName: usage }
  }
  return usage
}

/**
 * Generate a virtual module for an extracted handler.
 * Runtime helper imports stay self-contained. Module-local dependencies are
 * imported from re-exports on the source module, so handlers that close over
 * local helpers trade split granularity for a stable dependency contract.
 */
function generateHandlerModule(handler: ExtractedHandler): string {
  // If no code was extracted (fallback case), use re-export
  if (!handler.code) {
    return `export { ${handler.exportName} as default } from ${JSON.stringify(handler.sourceModule)};\n`
  }

  // Group imports by source module
  const importsByModule = new Map<string, string[]>()

  for (const usage of handler.helpersUsed) {
    const { helperName, localName } = normalizeRuntimeHelperUsage(usage)
    const helper = RUNTIME_HELPERS[helperName]
    if (!helper) continue

    const moduleSource = getRuntimeHelperModule(helperName, handler.runtimeImportFamily)
    const existing = importsByModule.get(moduleSource) ?? []
    const specifier =
      localName === helper.import ? helper.import : `${helper.import} as ${localName}`
    if (!existing.includes(specifier)) {
      existing.push(specifier)
    }
    importsByModule.set(moduleSource, existing)
  }

  // Generate import statements for runtime helpers
  const imports: string[] = []
  for (const [module, names] of importsByModule) {
    imports.push(`import { ${names.join(', ')} } from '${module}';`)
  }

  // Import local dependencies from the source module
  // These are re-exported by the source module with generated __fict_dep_ names
  if (handler.localDeps.length > 0) {
    const depImports = handler.localDeps.map(dep => `${dep.exportName} as ${dep.localName}`)
    imports.push(
      `import { ${depImports.join(', ')} } from ${JSON.stringify(handler.sourceModule)};`,
    )
  }

  // Generate the complete standalone module
  return `${imports.join('\n')}${imports.length > 0 ? '\n\n' : ''}export default ${handler.code};\n`
}

/** Prefix for re-exported handler dependencies */
const HANDLER_DEP_PREFIX = '__fict_dep_'

/**
 * Register an extracted handler for function-level splitting.
 */
export function registerExtractedHandler(
  sourceModule: string,
  exportName: string,
  helpersUsed: string[],
  code: string,
  localDeps: string[] = [],
): string {
  const handlerId = createHandlerId(sourceModule, exportName)
  manuallyRegisteredHandlers.set(handlerId, {
    sourceModule,
    exportName,
    helpersUsed,
    localDeps: localDeps.map(dep => ({
      localName: dep,
      exportName: `${HANDLER_DEP_PREFIX}${dep}`,
    })),
    code,
    runtimeImportFamily: 'fict',
  })
  return `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`
}

/**
 * Runtime helper name mappings for generating imports in virtual modules
 */
const RUNTIME_HELPERS: Record<string, { import: string; from: string }> = {
  __fictUseLexicalScope: { import: '__fictUseLexicalScope', from: 'fict/internal' },
  __fictGetScopeProps: { import: '__fictGetScopeProps', from: 'fict/internal' },
  __fictGetSSRScope: { import: '__fictGetSSRScope', from: 'fict/internal' },
  __fictEnsureScope: { import: '__fictEnsureScope', from: 'fict/internal' },
  __fictPrepareContext: { import: '__fictPrepareContext', from: 'fict/internal' },
  __fictPushContext: { import: '__fictPushContext', from: 'fict/internal' },
  __fictPopContext: { import: '__fictPopContext', from: 'fict/internal' },
  hydrateComponent: { import: 'hydrateComponent', from: 'fict/internal' },
  __fictQrl: { import: '__fictQrl', from: 'fict/internal' },
}

const RUNTIME_HELPER_IMPORT_SOURCES = new Set([
  'fict/internal',
  '@fictjs/runtime/internal',
  'fict/internal/list',
  '@fictjs/runtime/internal/list',
])

/** Known global identifiers that don't need to be imported */
const GLOBAL_IDENTIFIERS = new Set([
  // JavaScript globals
  'undefined',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
  'globalThis',
  'window',
  'document',
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
  'URL',
  'URLSearchParams',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'AbortController',
  'AbortSignal',
  // Built-in constructors
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Proxy',
  'Reflect',
  'JSON',
  'Math',
  'Intl',
  // Event and DOM
  'Event',
  'CustomEvent',
  'Element',
  'Node',
  'HTMLElement',
])

function collectRuntimeHelperImports(body: t.Statement[]): Map<string, string> {
  const helperImports = new Map<string, string>()

  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt)) continue
    if (!RUNTIME_HELPER_IMPORT_SOURCES.has(stmt.source.value)) continue

    for (const specifier of stmt.specifiers) {
      if (!t.isImportSpecifier(specifier)) continue
      const imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value
      if (!RUNTIME_HELPERS[imported]) continue
      helperImports.set(specifier.local.name, imported)
    }
  }

  return helperImports
}

function collectRuntimeHelperUsages(
  handlerPath: NodePath<t.Node>,
  runtimeHelperImports: Map<string, string>,
): RuntimeHelperUsage[] {
  const used = new Map<string, string>()

  handlerPath.traverse({
    Identifier(identifierPath) {
      if (!identifierPath.isReferencedIdentifier()) return
      if (isTypeOnlyIdentifierPath(identifierPath)) return

      const localName = identifierPath.node.name
      const importedHelperName = runtimeHelperImports.get(localName)
      const binding = identifierPath.scope.getBinding(localName)

      if (importedHelperName) {
        if (!isRuntimeHelperImportBinding(binding, importedHelperName)) return
        used.set(localName, importedHelperName)
        return
      }

      if (!RUNTIME_HELPERS[localName]) return
      if (binding) return
      used.set(localName, localName)
    },
  })

  return Array.from(used, ([localName, helperName]) =>
    localName === helperName ? helperName : { helperName, localName },
  )
}

function isRuntimeHelperImportBinding(
  binding: ReturnType<Scope['getBinding']>,
  helperName: string,
): boolean {
  if (!binding?.path.isImportSpecifier()) return false

  const parent = binding.path.parent
  if (!t.isImportDeclaration(parent)) return false
  if (!RUNTIME_HELPER_IMPORT_SOURCES.has(parent.source.value)) return false

  const imported = binding.path.node.imported
  const importedName = t.isIdentifier(imported) ? imported.name : imported.value
  return importedName === helperName
}

function isTypeOnlyIdentifierPath(path: NodePath<t.Identifier>): boolean {
  return Boolean(
    path.findParent(
      parent =>
        parent.isTSTypeReference() ||
        parent.isTSTypeAnnotation() ||
        parent.isTSTypeAliasDeclaration() ||
        parent.isTSInterfaceDeclaration() ||
        parent.isTSTypeParameterDeclaration() ||
        parent.isTSTypeParameterInstantiation() ||
        parent.isTSExpressionWithTypeArguments() ||
        parent.isTSImportType() ||
        parent.isTSTypeQuery(),
    ),
  )
}

function isTypeOnlyImportSpecifier(specifier: t.ImportDeclaration['specifiers'][number]): boolean {
  return t.isImportSpecifier(specifier) && specifier.importKind === 'type'
}

function collectHandlerTopLevelReferences(
  handlerPath: NodePath<t.Node>,
  programScope: Scope,
  topLevelDeclarations: Set<string>,
  runtimeHelperImports: Map<string, string>,
): Set<string> {
  const referenced = new Set<string>()

  handlerPath.traverse({
    Identifier(identifierPath) {
      if (!identifierPath.isReferencedIdentifier()) return
      if (isTypeOnlyIdentifierPath(identifierPath)) return

      const name = identifierPath.node.name
      if (GLOBAL_IDENTIFIERS.has(name)) return
      if (RUNTIME_HELPERS[name] || runtimeHelperImports.has(name)) return

      const binding = identifierPath.scope.getBinding(name)
      if (!binding || binding.scope !== programScope) return
      if (!topLevelDeclarations.has(name)) return
      if (name.match(/^__fict_[er]\d+$/)) return

      referenced.add(name)
    },
  })

  return referenced
}

function collectHandlerMutableTopLevelWrites(
  handlerPath: NodePath<t.Node>,
  programScope: Scope,
  mutableTopLevelDeclarations: Set<string>,
): Set<string> {
  const written = new Set<string>()

  const addIdentifier = (identifierPath: NodePath<t.Identifier>) => {
    const name = identifierPath.node.name
    if (!mutableTopLevelDeclarations.has(name)) return

    const binding = identifierPath.scope.getBinding(name)
    if (!binding || binding.scope !== programScope) return

    written.add(name)
  }

  const collectAssignedPattern = (patternPath: NodePath<t.Node>) => {
    if (patternPath.isIdentifier()) {
      addIdentifier(patternPath)
      return
    }

    if (patternPath.isObjectPattern()) {
      for (const propertyPath of patternPath.get('properties')) {
        if (propertyPath.isObjectProperty()) {
          collectAssignedPattern(propertyPath.get('value') as NodePath<t.Node>)
        } else if (propertyPath.isRestElement()) {
          collectAssignedPattern(propertyPath.get('argument') as NodePath<t.Node>)
        }
      }
      return
    }

    if (patternPath.isArrayPattern()) {
      for (const elementPath of patternPath.get('elements')) {
        if (elementPath.node) {
          collectAssignedPattern(elementPath as NodePath<t.Node>)
        }
      }
      return
    }

    if (patternPath.isRestElement()) {
      collectAssignedPattern(patternPath.get('argument') as NodePath<t.Node>)
      return
    }

    if (patternPath.isAssignmentPattern()) {
      collectAssignedPattern(patternPath.get('left') as NodePath<t.Node>)
    }
  }

  handlerPath.traverse({
    AssignmentExpression(path) {
      collectAssignedPattern(path.get('left') as NodePath<t.Node>)
    },

    UpdateExpression(path) {
      const argumentPath = path.get('argument')
      if (argumentPath.isIdentifier()) {
        addIdentifier(argumentPath)
      }
    },

    ForInStatement(path) {
      const leftPath = path.get('left')
      if (!leftPath.isVariableDeclaration()) {
        collectAssignedPattern(leftPath as NodePath<t.Node>)
      }
    },

    ForOfStatement(path) {
      const leftPath = path.get('left')
      if (!leftPath.isVariableDeclaration()) {
        collectAssignedPattern(leftPath as NodePath<t.Node>)
      }
    },
  })

  return written
}

function hasModuleContextSensitiveHandlerSyntax(handlerPath: NodePath<t.Node>): boolean {
  let found = false

  handlerPath.traverse({
    MetaProperty(path) {
      if (
        t.isIdentifier(path.node.meta, { name: 'import' }) &&
        t.isIdentifier(path.node.property, { name: 'meta' })
      ) {
        found = true
        path.stop()
      }
    },

    CallExpression(path) {
      if (!t.isImport(path.node.callee)) return

      const [specifier] = path.node.arguments
      if (!t.isStringLiteral(specifier)) {
        found = true
        path.stop()
        return
      }

      const value = specifier.value
      if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) {
        found = true
        path.stop()
      }
    },
  })

  return found
}

/**
 * Collect identifier names from a pattern (for destructuring).
 */
function collectPatternIdentifiers(pattern: t.LVal | t.PatternLike): string[] {
  const names: string[] = []

  if (t.isIdentifier(pattern)) {
    names.push(pattern.name)
  } else if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop) && t.isLVal(prop.value)) {
        names.push(...collectPatternIdentifiers(prop.value))
      } else if (t.isRestElement(prop)) {
        names.push(...collectPatternIdentifiers(prop.argument))
      }
    }
  } else if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element) {
        names.push(...collectPatternIdentifiers(element))
      }
    }
  } else if (t.isRestElement(pattern)) {
    names.push(...collectPatternIdentifiers(pattern.argument))
  } else if (t.isAssignmentPattern(pattern)) {
    names.push(...collectPatternIdentifiers(pattern.left))
  }

  return names
}

function getExportedName(exported: t.ExportSpecifier['exported']): string {
  return t.isIdentifier(exported) ? exported.name : exported.value
}

function collectExportedNames(body: t.Statement[]): Set<string> {
  const names = new Set<string>()

  for (const node of body) {
    if (t.isExportDefaultDeclaration(node)) {
      names.add('default')
      continue
    }

    if (!t.isExportNamedDeclaration(node)) continue

    for (const specifier of node.specifiers) {
      if (t.isExportSpecifier(specifier)) {
        names.add(getExportedName(specifier.exported))
      }
    }

    const declaration = node.declaration
    if (!declaration) continue

    if (t.isFunctionDeclaration(declaration) && declaration.id) {
      names.add(declaration.id.name)
    } else if (t.isVariableDeclaration(declaration)) {
      for (const declarator of declaration.declarations) {
        for (const name of collectPatternIdentifiers(declarator.id)) {
          names.add(name)
        }
      }
    } else if (t.isClassDeclaration(declaration) && declaration.id) {
      names.add(declaration.id.name)
    } else if (t.isTSEnumDeclaration(declaration) && !declaration.declare) {
      names.add(declaration.id.name)
    } else if (
      t.isTSModuleDeclaration(declaration) &&
      !declaration.declare &&
      t.isIdentifier(declaration.id)
    ) {
      names.add(declaration.id.name)
    }
  }

  return names
}

function createHandlerDependencyExportName(
  sourceModule: string,
  localName: string,
  usedExportNames: Set<string>,
  rootDir?: string,
  packageBoundaryCache?: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): string {
  const sourceIdentity = createHandlerSourceIdentity(
    sourceModule,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
  )
  const hash = hashString(`${sourceIdentity}:${localName}`).slice(0, 8)
  const base = `${HANDLER_DEP_PREFIX}${hash}_${localName}`
  let candidate = base
  let suffix = 1

  while (usedExportNames.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix++
  }

  usedExportNames.add(candidate)
  return candidate
}

/**
 * Extract handlers using Babel AST and rewrite QRLs to use virtual modules.
 * Local dependencies are detected and re-exported for handlers to import from
 * the source module.
 */
function extractAndRewriteHandlers(
  code: string,
  sourceModule: string,
  handlerRegistry: Map<string, ExtractedHandler>,
  inputSourceMap: TransformResult['map'] = null,
  rootDir?: string,
  packageBoundaryCache?: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
): { code: string; handlers: string[]; map: TransformResult['map'] } | null {
  let ast: ReturnType<typeof parse>

  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: [...TYPESCRIPT_PARSER_PLUGINS],
    })
  } catch (error) {
    throw Object.assign(
      new Error(
        buildPluginMessage(
          'Failed to parse transformed code for handler extraction',
          sourceModule,
          error,
        ),
      ),
      { cause: error },
    )
  }

  // Collect all top-level declarations that could be referenced by handlers
  const topLevelDeclarations = new Set<string>()
  const mutableTopLevelDeclarations = new Set<string>()
  const importedNames = new Set<string>()
  const usedExportNames = collectExportedNames(ast.program.body)
  const runtimeHelperImports = collectRuntimeHelperImports(ast.program.body)

  for (const node of ast.program.body) {
    // Collect imports
    if (t.isImportDeclaration(node)) {
      if (node.importKind === 'type') continue
      for (const specifier of node.specifiers) {
        if (isTypeOnlyImportSpecifier(specifier)) continue
        if (t.isImportSpecifier(specifier) || t.isImportDefaultSpecifier(specifier)) {
          importedNames.add(specifier.local.name)
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          importedNames.add(specifier.local.name)
        }
      }
      continue
    }

    // Collect function declarations
    if (t.isFunctionDeclaration(node) && node.id) {
      topLevelDeclarations.add(node.id.name)
      mutableTopLevelDeclarations.add(node.id.name)
      continue
    }

    // Collect variable declarations
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        for (const name of collectPatternIdentifiers(declarator.id)) {
          topLevelDeclarations.add(name)
          if (node.kind === 'let' || node.kind === 'var') {
            mutableTopLevelDeclarations.add(name)
          }
        }
      }
      continue
    }

    // Collect class declarations
    if (t.isClassDeclaration(node) && node.id) {
      topLevelDeclarations.add(node.id.name)
      continue
    }

    if (t.isTSEnumDeclaration(node) && !node.declare) {
      topLevelDeclarations.add(node.id.name)
      continue
    }

    if (t.isTSModuleDeclaration(node) && !node.declare && t.isIdentifier(node.id)) {
      topLevelDeclarations.add(node.id.name)
      continue
    }

    // Collect exported declarations
    if (t.isExportNamedDeclaration(node) && node.declaration) {
      if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
        topLevelDeclarations.add(node.declaration.id.name)
        mutableTopLevelDeclarations.add(node.declaration.id.name)
      } else if (t.isVariableDeclaration(node.declaration)) {
        for (const declarator of node.declaration.declarations) {
          for (const name of collectPatternIdentifiers(declarator.id)) {
            topLevelDeclarations.add(name)
            if (node.declaration.kind === 'let' || node.declaration.kind === 'var') {
              mutableTopLevelDeclarations.add(name)
            }
          }
        }
      } else if (t.isClassDeclaration(node.declaration) && node.declaration.id) {
        topLevelDeclarations.add(node.declaration.id.name)
      } else if (t.isTSEnumDeclaration(node.declaration) && !node.declaration.declare) {
        topLevelDeclarations.add(node.declaration.id.name)
      } else if (
        t.isTSModuleDeclaration(node.declaration) &&
        !node.declaration.declare &&
        t.isIdentifier(node.declaration.id)
      ) {
        topLevelDeclarations.add(node.declaration.id.name)
      }
    }
  }

  // Merge imports into top-level declarations (they're also available at top level)
  for (const name of importedNames) {
    topLevelDeclarations.add(name)
  }

  const handlerNames: string[] = []
  const nodesToRemove = new Set<t.Node>()
  const handlerDeclaratorsToRemove = new Set<t.VariableDeclarator>()
  const dependencyExportNames = new Map<string, string>()
  const runtimeImportFamily = detectRuntimeImportFamilyFromCode(ast.program.body)

  // First pass: find all handler exports and extract their code
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const declarationPath = path.get('declaration')
      const programScope = path.scope.getProgramParent()

      // Handle: export const __fict_e0 = (scopeId, event, el) => { ... }
      if (declarationPath.isVariableDeclaration()) {
        const declaratorPaths = declarationPath.get('declarations')
        for (const declaratorPath of declaratorPaths) {
          const declarator = declaratorPath.node
          if (!t.isIdentifier(declarator.id)) continue

          const name = declarator.id.name
          // Only extract event handlers (__fict_e*), not resume handlers (__fict_r*)
          // Resume handlers have complex component dependencies that can't be easily extracted
          if (!name.match(/^__fict_e\d+$/)) continue

          const initPath = declaratorPath.get('init')
          if (!initPath.node || !initPath.isExpression()) continue
          if (hasModuleContextSensitiveHandlerSyntax(initPath)) continue

          // Generate the handler function code
          const handlerCode = generate(initPath.node).code

          // Detect which runtime helpers are used
          const helpersUsed = collectRuntimeHelperUsages(initPath, runtimeHelperImports)

          // Detect local dependencies
          const referencedIds = collectHandlerTopLevelReferences(
            initPath,
            programScope,
            topLevelDeclarations,
            runtimeHelperImports,
          )
          const localDepNames: string[] = []
          for (const ref of referencedIds) {
            localDepNames.push(ref)
          }

          const mutableWrites = collectHandlerMutableTopLevelWrites(
            initPath,
            programScope,
            mutableTopLevelDeclarations,
          )
          if (mutableWrites.size > 0) continue

          handlerNames.push(name)
          const localDeps = localDepNames.map(localName => {
            let exportName = dependencyExportNames.get(localName)
            if (!exportName) {
              exportName = createHandlerDependencyExportName(
                sourceModule,
                localName,
                usedExportNames,
                rootDir,
                packageBoundaryCache,
                explicitNamespace,
              )
              dependencyExportNames.set(localName, exportName)
            }
            return { localName, exportName }
          })

          // Register the handler with its full code
          const handlerId = createHandlerId(
            sourceModule,
            name,
            rootDir,
            packageBoundaryCache,
            explicitNamespace,
          )
          handlerRegistry.set(handlerId, {
            sourceModule,
            exportName: name,
            helpersUsed,
            localDeps,
            code: handlerCode,
            runtimeImportFamily,
          })

          // Remove only this handler declarator. Compiler output can share an
          // exported variable declaration with ordinary exports, which must
          // remain in the source module.
          handlerDeclaratorsToRemove.add(declarator)
        }
        return
      }

      // Handle: export function __fict_e0(scopeId, event, el) { ... }
      if (declarationPath.isFunctionDeclaration()) {
        const declaration = declarationPath.node
        const functionId = declaration.id
        if (!functionId) return
        const name = functionId.name
        // Only extract event handlers (__fict_e*), not resume handlers (__fict_r*)
        // Resume handlers have complex component dependencies that can't be easily extracted
        if (!name.match(/^__fict_e\d+$/)) return
        if (hasModuleContextSensitiveHandlerSyntax(declarationPath)) return

        // Convert to arrow function expression for the virtual module
        const params = declaration.params
        const body = declaration.body
        const arrowFn = t.arrowFunctionExpression(params, body, declaration.async)

        // Generate the handler function code
        const handlerCode = generate(arrowFn).code

        // Detect which runtime helpers are used
        const helpersUsed = collectRuntimeHelperUsages(declarationPath, runtimeHelperImports)

        // Detect local dependencies
        const referencedIds = collectHandlerTopLevelReferences(
          declarationPath,
          programScope,
          topLevelDeclarations,
          runtimeHelperImports,
        )
        const localDepNames: string[] = []
        for (const ref of referencedIds) {
          localDepNames.push(ref)
        }

        const mutableWrites = collectHandlerMutableTopLevelWrites(
          declarationPath,
          programScope,
          mutableTopLevelDeclarations,
        )
        if (mutableWrites.size > 0) return

        handlerNames.push(name)
        const localDeps = localDepNames.map(localName => {
          let exportName = dependencyExportNames.get(localName)
          if (!exportName) {
            exportName = createHandlerDependencyExportName(
              sourceModule,
              localName,
              usedExportNames,
              rootDir,
              packageBoundaryCache,
              explicitNamespace,
            )
            dependencyExportNames.set(localName, exportName)
          }
          return { localName, exportName }
        })

        // Register the handler with its full code
        const handlerId = createHandlerId(
          sourceModule,
          name,
          rootDir,
          packageBoundaryCache,
          explicitNamespace,
        )
        handlerRegistry.set(handlerId, {
          sourceModule,
          exportName: name,
          helpersUsed,
          localDeps,
          code: handlerCode,
          runtimeImportFamily,
        })

        // Mark this export for removal
        nodesToRemove.add(path.node)
      }
    },
  })

  if (handlerNames.length === 0) {
    return null
  }

  // Second pass: remove handler exports, rewrite QRL calls, and add re-exports for dependencies
  traverse(ast, {
    ExportNamedDeclaration(path) {
      if (nodesToRemove.has(path.node)) {
        path.remove()
        return
      }

      const declaration = path.node.declaration
      if (!t.isVariableDeclaration(declaration)) return

      const remainingDeclarations = declaration.declarations.filter(
        declarator => !handlerDeclaratorsToRemove.has(declarator),
      )
      if (remainingDeclarations.length === declaration.declarations.length) return

      if (remainingDeclarations.length === 0) {
        path.remove()
        return
      }

      declaration.declarations = remainingDeclarations
    },

    CallExpression(path) {
      // Rewrite __fictQrl(import.meta.url, "__fict_e0") -> "virtual:...#default".
      // Flagged QRLs retain the helper call so its metadata suffix is preserved:
      // __fictQrl(import.meta.url, "__fict_e0", "pd")
      //   -> __fictQrl("virtual:...", "default", "pd")
      if (!t.isIdentifier(path.node.callee, { name: '__fictQrl' })) return
      if (path.node.arguments.length < 2) return

      const secondArg = path.node.arguments[1]
      if (!t.isStringLiteral(secondArg)) return

      const handlerName = secondArg.value
      if (!handlerNames.includes(handlerName)) return

      // Replace with the virtual module URL
      const handlerId = createHandlerId(
        sourceModule,
        handlerName,
        rootDir,
        packageBoundaryCache,
        explicitNamespace,
      )
      const virtualModuleId = `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`
      if (path.node.arguments.length === 2) {
        path.replaceWith(t.stringLiteral(`${virtualModuleId}#default`))
        return
      }

      path.node.arguments = [
        t.stringLiteral(virtualModuleId),
        t.stringLiteral('default'),
        ...path.node.arguments.slice(2),
      ]
    },
  })

  // Add private re-exports for local dependencies used by handlers.
  // Generated names include a stable hash and collision suffix when needed.
  if (dependencyExportNames.size > 0) {
    const reExports: t.ExportSpecifier[] = []
    for (const [localName, exportName] of dependencyExportNames) {
      reExports.push(t.exportSpecifier(t.identifier(localName), t.identifier(exportName)))
    }
    ast.program.body.push(t.exportNamedDeclaration(null, reExports))
  }

  // Generate the modified code
  const generatorOptions: BabelGeneratorOptionsWithInputSourceMap = {
    retainLines: true,
    compact: false,
    sourceMaps: inputSourceMap !== null,
    inputSourceMap,
    sourceFileName: sourceModule,
  }
  const result = generate(ast, generatorOptions)

  return { code: result.code, handlers: handlerNames, map: result.map as TransformResult['map'] }
}
