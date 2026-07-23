import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveStrictGuarantee,
  type CompileRequest,
  type CompileResult,
  type CompilerArtifact,
  type CompilerExplainEventKind,
  type FictDiagnostic,
  type ModuleReactiveMetadata,
  type NativeCompilerExplainArtifact,
  type NativeCompilerOptions,
  type NativeTypeScriptOptions,
  type RawSourceMap,
  type ResolvedMetadataInput,
  type ScanResult,
} from '@fictjs/compiler'
import { resolvePackageModuleMetadata } from '@fictjs/compiler/graph-host'
import {
  loadNativeCompilerBinding,
  type NativeCompilerBinding,
  type NativeCompilerInfo,
} from '@fictjs/compiler/native'
import remapping, { type SourceMapInput as RemappingSourceMapInput } from '@jridgewell/remapping'
import MagicString from 'magic-string'
import {
  createFilter,
  transformWithEsbuild,
  type Plugin,
  type ResolvedConfig,
  type TransformResult,
} from 'vite'

import { createVitePluginCacheFingerprint } from './cache-fingerprint'

const requireFromVitePlugin = createRequire(import.meta.url)

const PACKAGE_METADATA_WATCH_GLOBS = [
  '!**/node_modules/**/package.json',
  '!**/node_modules/**/*.json',
] as const

export interface FictPluginWarning {
  code: string
  message: string
  fileName: string
  line: number
  column: number
}

export interface FictPluginExplainEvent {
  kind: CompilerExplainEventKind
  message: string
  name?: string
  code?: string
  line?: number
  column?: number
}

export interface FictPluginExplainArtifact {
  version: 1
  fileName: string
  helpers: string[]
  diagnostics: FictPluginWarning[]
  events: FictPluginExplainEvent[]
}

export type FictPluginTypeScriptOptions = NativeTypeScriptOptions

interface FictPluginCompilerOptions extends Omit<
  NativeCompilerOptions,
  'explain' | 'preview' | 'typescript'
> {
  onWarn?: (warning: FictPluginWarning) => void
  /** Diagnostics prepared by the integration before native compilation. @internal */
  integrationDiagnostics?: FictPluginWarning[]
  explain?: boolean | ((artifact: FictPluginExplainArtifact) => void)
  /** Physical source filename used by the integration. @internal */
  filename?: string
  /** Stable graph identity embedded in Preview QRLs. @internal */
  publicModuleId?: string
  /** @experimental Enables Preview resumable output. */
  resumable?: boolean
  /** @experimental Enables automatic Preview handler extraction. */
  autoExtractHandlers?: boolean
  /** @experimental Minimum node count for automatic Preview handler extraction. */
  autoExtractThreshold?: number
  /** Integration-owned metadata graph for the current build. @internal */
  resolveModuleMetadata?: (
    source: string,
    importer?: string,
  ) => ModuleReactiveMetadata | null | undefined
  onModuleMetadataDependency?: (filename: string) => void
  /** TypeScript project state used only by Vite's import-elision integration. @internal */
  typescript?: {
    program?: unknown
    checker?: unknown
    projectVersion?: number
    configPath?: string
  }
  /** Serializable OXC TypeScript lowering controls passed to the native compiler. */
  typescriptOptions?: FictPluginTypeScriptOptions
}

export interface FictPluginOptions extends FictPluginCompilerOptions {
  /**
   * Explicit native addon path for local development and release verification.
   * Production installations normally resolve the platform optional package.
   * @internal
   */
  nativeCompilerPath?: string
  /**
   * File patterns to include for transformation.
   * Relative patterns are resolved from the Vite project root.
   * @default all supported JavaScript and TypeScript module extensions
   */
  include?: string[]
  /**
   * File patterns to exclude from transformation.
   * Relative patterns are resolved from the Vite project root.
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
   * @experimental Part of the Preview resumability pipeline when `resumable` is enabled.
   */
  functionSplitting?: boolean
  /**
   * Stable application namespace for public resumable identities.
   * By default the plugin uses the owning package name, version, and Vite-root
   * subpath. Set this when the Vite root has no named package.json boundary.
   * @experimental Part of the Preview resumability identity contract.
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
  metadataIncomplete?: boolean
  unresolvedMetadataRequests?: string[]
}

interface CompilerStageResult {
  code: string
  map: TransformResult['map']
  artifacts: CompilerArtifact[]
  moduleMetadata: ModuleReactiveMetadata
  metadataIncomplete: boolean
  unresolvedMetadataRequests: string[]
}

interface PreparedCompilerTransform extends CompilerStageResult {
  preparationKey: string
}

type TypeScriptImportElision = 'remove' | 'preserve-side-effect' | 'verbatim'

interface MetadataGraphNode {
  key: string
  id: string
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

interface ResolvedMetadataModule {
  key: string
  filename: string
}

interface ResolvedCompilerModuleMetadata {
  metadata: ModuleReactiveMetadata | null | undefined
  stateKey: string | null
}

interface DevHandlerGeneration {
  id: string
  registries: Map<string, Map<string, ExtractedHandler>>
}

interface MetadataTransformState {
  blockUnscopedTransforms: boolean
  devEnvironmentId: string | null
  devHandlerGeneration: DevHandlerGeneration | null
  environment: object | null
  moduleMetadata: Map<string, ModuleReactiveMetadata>
  incompleteModuleMetadata: Set<string>
  unresolvedModuleMetadataRequests: Map<string, string[]>
  resolvedLocalModules: Map<string, ResolvedMetadataModule>
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

const CACHE_VERSION = 5
const MAX_STALE_DEV_REQUEST_RETRIES = 3
let vitePluginCacheFingerprint: string | undefined

// Defer reading built artifacts until the first cache-key computation.
function getVitePluginCacheFingerprint(): string {
  return (vitePluginCacheFingerprint ??= createVitePluginCacheFingerprint([
    String(consumeStructuredHandlerArtifacts),
  ]))
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
const DEV_VIRTUAL_HANDLER_PREFIX = '\0fict-handler-dev:'
const VITE_DEV_HANDLER_PREFIX = '/@id/__x00__fict-handler-dev:'
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
  /** Complete compiler-owned module; present for Rust structured artifacts. */
  moduleCode?: string
  /** Source map for a complete compiler-owned module. */
  moduleMap?: RawSourceMap | null
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
    nativeCompilerPath,
    cache: cacheOption,
    tsconfigPath,
    useTypeScriptProject = true,
    debug: debugOption,
    library: libraryOption,
    publicIdentityNamespace: publicIdentityNamespaceOption,
    publicModuleId: _integrationOwnedPublicModuleId,
    ...compilerOptions
  } = options
  let nativeCompilerBinding: NativeCompilerBinding | undefined
  let nativeCompilerInfo: NativeCompilerInfo | undefined
  const getNativeCompiler = (): NativeCompilerBinding => {
    if (!nativeCompilerBinding) {
      const nativePath = nativeCompilerPath ?? process.env.FICT_COMPILER_NATIVE_PATH
      nativeCompilerBinding = loadNativeCompilerBinding(nativePath ? { nativePath } : {})
      nativeCompilerInfo = nativeCompilerBinding.nativeCompilerInfo()
    }
    return nativeCompilerBinding
  }
  const getCompilerStageFingerprint = (): string => {
    getNativeCompiler()
    const native = `${nativeCompilerInfo!.compilerBuildId}:oxc${nativeCompilerInfo!.oxcVersion}`
    return `rust:${native}:${getVitePluginCacheFingerprint()}`
  }
  const collectCompilerStaticModuleSources = async (
    code: string,
    filename: string,
    moduleId = filename,
  ): Promise<string[]> => {
    const result = await getNativeCompiler().scan({ code, filename, moduleId })
    return consumeNativeScanResult(result, code, filename)
  }
  const collectCompilerStaticModuleSourcesSync = (
    code: string,
    filename: string,
    moduleId = filename,
  ): string[] => {
    const result = getNativeCompiler().scanSync({ code, filename, moduleId })
    return consumeNativeScanResult(result, code, filename)
  }
  const publicIdentityNamespace = publicIdentityNamespaceOption?.trim()
  if (publicIdentityNamespaceOption !== undefined && !publicIdentityNamespace) {
    throw new Error('[fict] publicIdentityNamespace must be a non-empty string.')
  }
  const libraryOptions = normalizeLibraryOptions(libraryOption)
  const includePatterns =
    include ?? (libraryOptions.enabled ? DEFAULT_LIBRARY_INCLUDE : DEFAULT_APP_INCLUDE)
  const createTransformFilter = (root?: string) =>
    createFilter(includePatterns, exclude, root ? { resolve: root } : undefined)
  let transformFilter = createTransformFilter()

  let config: ResolvedConfig | undefined
  let cache: TransformCache | null = null
  let addTypeScriptConfigWatchFiles: ((files: string[]) => void) | null = null
  const transformStates = new Set<MetadataTransformState>()
  const activeDevHandlerGenerations = new Map<string, DevHandlerGeneration>()
  const devEnvironmentIds = new WeakMap<object, string>()
  let nextDevEnvironmentId = 0
  let nextDevHandlerGenerationId = 0
  const getDevEnvironmentId = (environment: object): string => {
    let id = devEnvironmentIds.get(environment)
    if (!id) {
      nextDevEnvironmentId += 1
      id = `e${nextDevEnvironmentId.toString(36)}`
      devEnvironmentIds.set(environment, id)
    }
    return id
  }
  const createDevHandlerGeneration = (): DevHandlerGeneration => {
    nextDevHandlerGenerationId += 1
    const generation: DevHandlerGeneration = {
      id: `g${nextDevHandlerGenerationId.toString(36)}`,
      registries: new Map(),
    }
    activeDevHandlerGenerations.set(generation.id, generation)
    return generation
  }
  let currentDevHandlerGeneration = createDevHandlerGeneration()
  let lastDevHandlerHotUpdateTimestamp: number | undefined
  const devEnvironments = new Set<object>()
  const createTransformState = (environment: object | null = null): MetadataTransformState => {
    const devEnvironmentId = environment ? getDevEnvironmentId(environment) : null
    const devHandlerGeneration =
      environment && config?.command === 'serve' && compilerOptions.resumable === true
        ? currentDevHandlerGeneration
        : null
    const extractedHandlers = new Map<string, ExtractedHandler>()
    if (devHandlerGeneration && devEnvironmentId) {
      devHandlerGeneration.registries.set(devEnvironmentId, extractedHandlers)
    }
    const state: MetadataTransformState = {
      blockUnscopedTransforms: false,
      devEnvironmentId,
      devHandlerGeneration,
      environment,
      moduleMetadata: new Map(),
      incompleteModuleMetadata: new Set(),
      unresolvedModuleMetadataRequests: new Map(),
      resolvedLocalModules: new Map(),
      preparedCompilerTransforms: new Map(),
      pipelineCompilerInputs: new Map(),
      pipelineTransformsInProgress: new Map(),
      pipelineTransformedModules: new Set(),
      metadataPreparationQueue: Promise.resolve(),
      extractedHandlers,
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
    state.incompleteModuleMetadata.clear()
    state.unresolvedModuleMetadataRequests.clear()
    state.resolvedLocalModules.clear()
    state.preparedCompilerTransforms.clear()
    state.pipelineCompilerInputs.clear()
    state.pipelineTransformsInProgress.clear()
    state.pipelineTransformedModules.clear()
    if (
      state.devHandlerGeneration &&
      state.devEnvironmentId &&
      state.devHandlerGeneration.registries.get(state.devEnvironmentId) === state.extractedHandlers
    ) {
      state.devHandlerGeneration.registries.delete(state.devEnvironmentId)
    }
    state.devHandlerGeneration = null
    state.devEnvironmentId = null
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

  const replaceInvalidatedDevHandlerGeneration = (
    environments: Iterable<object>,
    timestamp?: number,
  ) => {
    const affectedEnvironments = new Set([...devEnvironments, ...environments])
    if (timestamp !== undefined && lastDevHandlerHotUpdateTimestamp === timestamp) {
      // Vite invokes hotUpdate once per environment for the same timestamp. The first
      // invocation normally replaces every configured environment; also repair an
      // explicitly supplied late environment without rotating the generation again.
      for (const environment of affectedEnvironments) {
        const state = environmentTransformStates.get(environment)
        if (state && state.devHandlerGeneration !== currentDevHandlerGeneration) {
          replaceInvalidatedEnvironmentState(environment)
        }
      }
      return
    }

    lastDevHandlerHotUpdateTimestamp = timestamp
    activeDevHandlerGenerations.delete(currentDevHandlerGeneration.id)
    currentDevHandlerGeneration = createDevHandlerGeneration()
    for (const environment of affectedEnvironments) {
      replaceInvalidatedEnvironmentState(environment)
    }
  }

  const wrapDevEnvironmentRequests = (environment: object) => {
    devEnvironments.add(environment)
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
            requestedId.startsWith(DEV_VIRTUAL_HANDLER_PREFIX) ||
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
          devEnvironments.delete(environment)
          if (devEnvironments.size === 0) {
            activeDevHandlerGenerations.clear()
            currentDevHandlerGeneration = createDevHandlerGeneration()
            lastDevHandlerHotUpdateTimestamp = undefined
          }
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
  ): { key: string; metadata: ModuleReactiveMetadata } | undefined => {
    const normalized = normalizeFileName(resolved, config?.root)
    const direct = state.moduleMetadata.get(normalized)
    if (direct) return { key: normalized, metadata: direct }
    const ext = path.extname(normalized)
    if (!ext) {
      for (const suffix of MODULE_EXTENSIONS) {
        const key = `${normalized}${suffix}`
        const byExt = state.moduleMetadata.get(key)
        if (byExt) return { key, metadata: byExt }
      }
      for (const suffix of MODULE_EXTENSIONS) {
        const key = path.join(normalized, `index${suffix}`)
        const byIndex = state.moduleMetadata.get(key)
        if (byIndex) return { key, metadata: byIndex }
      }
    }
    return undefined
  }

  const resolveCompilerModuleMetadataState = (
    state: MetadataTransformState,
    source: string,
    importer?: string,
    importerKey?: string,
  ): ResolvedCompilerModuleMetadata => {
    const userResolved = compilerOptions.resolveModuleMetadata?.(source, importer)
    if (userResolved !== undefined) return { metadata: userResolved, stateKey: null }
    if (
      shouldSkipMetadataForModuleQuery(source, {
        root: config?.root,
        importer,
      })
    ) {
      return { metadata: undefined, stateKey: null }
    }
    if (!importer) return { metadata: undefined, stateKey: null }

    const importerFile = normalizeFileName(importer, config?.root)
    const exactResolution = state.resolvedLocalModules.get(
      createLocalResolutionKey(importerKey ?? importerFile, source),
    )
    const aliasEntries = normalizeAliases(config?.resolve?.alias)
    let resolvedSource = exactResolution?.filename ?? null
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
      const resolvedMetadata = exactResolution
        ? state.moduleMetadata.get(exactResolution.key)
          ? { key: exactResolution.key, metadata: state.moduleMetadata.get(exactResolution.key)! }
          : undefined
        : lookupStoredMetadata(state, resolvedSource)
      if (resolvedMetadata) {
        return { metadata: resolvedMetadata.metadata, stateKey: resolvedMetadata.key }
      }
      if (shouldCompileModule(resolvedSource)) {
        throw new Error(
          `[fict] Local module metadata for "${source}" imported by "${importerFile}" ` +
            `was not prepared (${resolvedSource}).`,
        )
      }
    }

    if (!packageSource) return { metadata: undefined, stateKey: null }
    return {
      metadata: resolvePackageModuleMetadata(packageSource, importerFile, {
        onDependency: file => registerPackageMetadataDependency(state, file),
      }),
      stateKey: null,
    }
  }

  const resolveCompilerModuleMetadata = (
    state: MetadataTransformState,
    source: string,
    importer?: string,
    importerKey?: string,
  ): ModuleReactiveMetadata | null | undefined =>
    resolveCompilerModuleMetadataState(state, source, importer, importerKey).metadata

  const createNativeMetadataSnapshot = (
    state: MetadataTransformState,
    sources: readonly string[],
    normalizedFilename: string,
    importerKey: string,
  ): ResolvedMetadataInput[] => {
    const aliasEntries = normalizeAliases(config?.resolve?.alias)
    return sources.map(source => {
      const resolution = resolveCompilerModuleMetadataState(
        state,
        source,
        normalizedFilename,
        importerKey,
      )
      const metadata = resolution.metadata
      const exactResolution = state.resolvedLocalModules.get(
        createLocalResolutionKey(importerKey, source),
      )
      const localFile =
        exactResolution?.filename ??
        resolveLocalModuleSource(source, normalizedFilename, config?.root, aliasEntries)
      const packageSource = resolveAliasedPackageSource(source, aliasEntries)
      let resolvedId = exactResolution?.key ?? localFile ?? packageSource
      let status: ResolvedMetadataInput['status']
      let resolvedMetadata: ModuleReactiveMetadata | null = null

      if (metadata === null) {
        status = 'missing'
        resolvedId = null
      } else if (metadata !== undefined) {
        status =
          resolution.stateKey && state.incompleteModuleMetadata.has(resolution.stateKey)
            ? 'incompleteCycle'
            : 'resolved'
        resolvedMetadata = metadata
        resolvedId ??= `resolver:${source}`
      } else if (
        shouldSkipMetadataForModuleQuery(source, {
          root: config?.root,
          importer: normalizedFilename,
        })
      ) {
        status = 'opaque'
        resolvedId ??= source
      } else if (resolvedId) {
        status = 'opaque'
      } else {
        status = 'missing'
        resolvedId = null
      }

      return {
        request: source,
        resolvedId,
        status,
        metadata: resolvedMetadata,
        fingerprint: `sha256:${hashString(
          stableStringify([source, resolvedId, status, resolvedMetadata]),
        )}`,
      }
    })
  }

  const createCompilerOptions = async (
    state: MetadataTransformState,
    code: string,
    normalizedFilename: string,
    tsImportElisionOverride?: TypeScriptImportElision,
    transformOptions?: {
      metadataKey?: string
      publicIdentityId?: string
      useTypeScriptProject?: boolean
    },
  ): Promise<{
    fictOptions: FictPluginCompilerOptions
    project: TypeScriptProject | null
    tsImportElision: TypeScriptImportElision
    nativeMetadata: ResolvedMetadataInput[]
  }> => {
    assertTransformStateActive(state)
    let publicModuleId: string | undefined
    if (config?.command === 'build' && config.root) {
      const identityId = transformOptions?.publicIdentityId ?? normalizedFilename
      const preserveSymlinks = config.resolve.preserveSymlinks === true
      const lookupKey = createPublicModuleLookupKey(identityId, config.root, preserveSymlinks)
      const publicIdentity = createPublicModuleIdentity(
        identityId,
        config.root,
        packageBoundaryCache,
        publicIdentityNamespace,
        preserveSymlinks,
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
    } else if (config?.command === 'serve' && config.root && compilerOptions.resumable === true) {
      publicModuleId = createDevPublicModuleId(
        transformOptions?.publicIdentityId ?? normalizedFilename,
        config.root,
        {
          base: config.base,
          origin: config.server.origin,
          preserveSymlinks: config.resolve.preserveSymlinks === true,
        },
      )
    }
    const fictOptions: FictPluginCompilerOptions = {
      ...compilerOptions,
      dev: compilerOptions.dev ?? (config?.command === 'serve' || config?.mode === 'development'),
      sourcemap: compilerOptions.sourcemap ?? true,
      filename: normalizedFilename,
      // Build identities resolve through the manifest. Dev identities are directly serviceable
      // Vite URLs, so SSR output never needs to expose a source-machine file:// URL.
      ...(publicModuleId ? { publicModuleId } : {}),
      resolveModuleMetadata: (source, importer) =>
        resolveCompilerModuleMetadata(state, source, importer, transformOptions?.metadataKey),
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
    const nativeModuleSources = await collectCompilerStaticModuleSources(
      code,
      normalizedFilename,
      transformOptions?.publicIdentityId ?? normalizedFilename,
    )
    const nativeMetadata = createNativeMetadataSnapshot(
      state,
      nativeModuleSources,
      normalizedFilename,
      transformOptions?.metadataKey ?? normalizedFilename,
    )
    return { fictOptions, project, tsImportElision, nativeMetadata }
  }

  const resolveGraphDependency = async (
    context: MetadataResolveContext,
    source: string,
    importer: string,
  ): Promise<(ResolvedMetadataModule & { loadOptions: MetadataLoadOptions }) | null> => {
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
          const identity = createMetadataModuleIdentity(resolved.id, config?.root)
          return {
            filename: normalizeFileName(resolvedFile, config?.root),
            key: identity.key,
            loadOptions: resolved,
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
    if (!resolved) return null
    const { suffix } = splitModuleId(source, {
      root: config?.root,
      importer: normalizeFileName(importer, config?.root),
    })
    return {
      key: suffix ? `${resolved}\0${suffix}` : resolved,
      filename: resolved,
      loadOptions: { id: `${resolved}${suffix}` },
    }
  }

  const discoverMetadataGraph = async (
    state: MetadataTransformState,
    context: MetadataResolveContext,
    rootCode: string,
    rootId: string,
  ): Promise<Map<string, MetadataGraphNode>> => {
    assertTransformStateActive(state)
    const nodes = new Map<string, MetadataGraphNode>()
    const discovered = new Set<string>()

    const visit = async (
      id: string,
      suppliedCode?: string,
      loadOptions?: MetadataLoadOptions,
    ): Promise<void> => {
      const identity = createMetadataModuleIdentity(id, config?.root)
      if (discovered.has(identity.key)) return
      discovered.add(identity.key)

      const pipelineCode = suppliedCode ?? state.pipelineCompilerInputs.get(identity.key)
      const code = pipelineCode ?? (await fs.readFile(identity.filename, 'utf8'))
      const node: MetadataGraphNode = {
        key: identity.key,
        id: loadOptions?.id ?? id,
        filename: identity.filename,
        code,
        dependencies: new Set(),
        ...(loadOptions ? { loadOptions } : {}),
      }
      nodes.set(identity.key, node)

      // An uncaptured dependency is a pipeline frontier. Loading it runs earlier transforms;
      // only their resulting imports are authoritative. Manual plugin contexts without a
      // pipeline loader retain the recursive on-disk preparation fallback.
      if (pipelineCode === undefined && hasMetadataPipelineLoader(context)) return

      for (const source of await collectCompilerStaticModuleSources(code, node.filename, node.id)) {
        const resolved = await resolveGraphDependency(context, source, node.id)
        if (!resolved || !shouldCompileModule(resolved.filename)) continue
        state.resolvedLocalModules.set(createLocalResolutionKey(identity.key, source), {
          key: resolved.key,
          filename: resolved.filename,
        })
        node.dependencies.add(resolved.key)
        await visit(resolved.loadOptions.id, undefined, resolved.loadOptions)
      }
    }

    await visit(rootId, rootCode)
    return nodes
  }

  const getPreparationKey = async (
    state: MetadataTransformState,
    node: MetadataGraphNode,
    tsImportElision: TypeScriptImportElision,
  ): Promise<{
    key: string
    fictOptions: FictPluginCompilerOptions
    tsImportElision: TypeScriptImportElision
    nativeMetadata: ResolvedMetadataInput[]
  }> => {
    assertTransformStateActive(state)
    const isVariant = node.key !== node.filename
    const { fictOptions, project, nativeMetadata } = await createCompilerOptions(
      state,
      node.code,
      node.filename,
      tsImportElision,
      {
        metadataKey: node.key,
        publicIdentityId: node.id,
        useTypeScriptProject: !isVariant,
      },
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
      node.key,
      collectCompilerStaticModuleSourcesSync,
      state.incompleteModuleMetadata,
    )
    return {
      key: buildMetadataPreparationKey(
        node.key,
        node.code,
        fictOptions,
        project,
        tsImportElision,
        dependencyFingerprint,
        getCompilerStageFingerprint(),
      ),
      fictOptions,
      tsImportElision,
      nativeMetadata,
    }
  }

  const storeModuleMetadataState = (
    state: MetadataTransformState,
    key: string,
    metadata: ModuleReactiveMetadata,
    incomplete: boolean,
    unresolvedRequests: readonly string[],
  ): void => {
    state.moduleMetadata.set(key, metadata)
    if (incomplete) {
      state.incompleteModuleMetadata.add(key)
    } else {
      state.incompleteModuleMetadata.delete(key)
    }
    const normalizedRequests = [...new Set(unresolvedRequests)].sort()
    if (normalizedRequests.length > 0) {
      state.unresolvedModuleMetadataRequests.set(key, normalizedRequests)
    } else {
      state.unresolvedModuleMetadataRequests.delete(key)
    }
  }

  const compileMetadataNode = async (
    state: MetadataTransformState,
    node: MetadataGraphNode,
    fictOptions: FictPluginCompilerOptions,
    tsImportElision: TypeScriptImportElision,
    nativeMetadata: ResolvedMetadataInput[],
  ): Promise<Omit<PreparedCompilerTransform, 'preparationKey'>> => {
    assertTransformStateActive(state)
    const compiled = await compileFictCompilerStage(
      node.code,
      node.filename,
      fictOptions,
      tsImportElision,
      {
        moduleId: node.id,
        metadata: nativeMetadata,
        nativeCompiler: getNativeCompiler(),
      },
    )
    assertTransformStateActive(state)
    storeModuleMetadataState(
      state,
      node.key,
      compiled.moduleMetadata,
      compiled.metadataIncomplete,
      compiled.unresolvedMetadataRequests,
    )
    return compiled
  }

  const prepareMetadataGraph = async (
    state: MetadataTransformState,
    graph: Map<string, MetadataGraphNode>,
    rootId: string,
    pipelinePrepared = new Set<string>(),
  ): Promise<void> => {
    assertTransformStateActive(state)
    const fixedTsImportElisions = new Map<string, TypeScriptImportElision>()
    const getFixedTsImportElision = async (node: MetadataGraphNode) => {
      const existing = fixedTsImportElisions.get(node.filename)
      if (existing) return existing
      const resolved = await resolveTypeScriptImportElision(
        state,
        node.filename,
        config,
        addTypeScriptConfigWatchFiles,
      )
      fixedTsImportElisions.set(node.filename, resolved)
      return resolved
    }
    const rootKey = createMetadataModuleIdentity(rootId, config?.root).key
    for (const component of getStronglyConnectedMetadataComponents(graph)) {
      const sortedComponent = [...component].sort()
      if (
        sortedComponent.every(
          key => key !== rootKey && pipelinePrepared.has(key) && state.moduleMetadata.has(key),
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
      if (!hasCycle && sortedComponent.length === 1 && sortedComponent[0] === rootKey) {
        continue
      }

      // Native compilation consumes an eager, serializable metadata snapshot while candidate
      // keys are prepared. Seed every missing SCC member before that snapshot is built; otherwise
      // the first Rust pass mistakes a legitimate back-edge for an unprepared local module and
      // aborts before fixed-point convergence can start. Reuse a prepared result when available
      // so watch/cache rebuilds compare against the last converged state instead of an empty seed.
      if (hasCycle) {
        for (const moduleKey of sortedComponent) {
          if (!state.moduleMetadata.has(moduleKey)) {
            state.moduleMetadata.set(
              moduleKey,
              state.preparedCompilerTransforms.get(moduleKey)?.moduleMetadata ??
                createEmptyModuleMetadata(),
            )
          }
          state.incompleteModuleMetadata.add(moduleKey)
        }
      }

      const preparedCandidates: {
        moduleKey: string
        prepared: PreparedCompilerTransform | undefined
        key: string
        fictOptions: FictPluginCompilerOptions
        tsImportElision: TypeScriptImportElision
        nativeMetadata: ResolvedMetadataInput[]
      }[] = []
      // TypeScriptProject is a shared mutable language-service snapshot. Prepare
      // candidate keys deterministically so updateFile/getProgram never race.
      for (const moduleKey of sortedComponent) {
        const node = graph.get(moduleKey)!
        const tsImportElision = await getFixedTsImportElision(node)
        const preparation = await getPreparationKey(state, node, tsImportElision)
        preparedCandidates.push({
          moduleKey,
          prepared: state.preparedCompilerTransforms.get(moduleKey),
          ...preparation,
        })
      }
      if (
        preparedCandidates.every(candidate => candidate.prepared?.preparationKey === candidate.key)
      ) {
        for (const candidate of preparedCandidates) {
          storeModuleMetadataState(
            state,
            candidate.moduleKey,
            candidate.prepared!.moduleMetadata,
            candidate.prepared!.metadataIncomplete,
            candidate.prepared!.unresolvedMetadataRequests,
          )
        }
        continue
      }

      if (!hasCycle) {
        const moduleKey = sortedComponent[0]!
        const node = graph.get(moduleKey)!
        const tsImportElision = await getFixedTsImportElision(node)
        const { fictOptions, nativeMetadata } = await getPreparationKey(
          state,
          node,
          tsImportElision,
        )
        const compiled = await compileMetadataNode(
          state,
          node,
          fictOptions,
          tsImportElision,
          nativeMetadata,
        )
        const { key } = await getPreparationKey(state, node, tsImportElision)
        state.preparedCompilerTransforms.set(moduleKey, { ...compiled, preparationKey: key })
        continue
      }

      let converged = false
      const maxPasses = Math.max(8, sortedComponent.length * 4)
      for (let pass = 0; pass < maxPasses; pass++) {
        const before = stableStringify(
          sortedComponent.map(filename => [filename, state.moduleMetadata.get(filename)]),
        )
        for (const moduleKey of sortedComponent) {
          const node = graph.get(moduleKey)!
          const tsImportElision = await getFixedTsImportElision(node)
          const { fictOptions, nativeMetadata } = await getPreparationKey(
            state,
            node,
            tsImportElision,
          )
          await compileMetadataNode(state, node, fictOptions, tsImportElision, nativeMetadata)
        }
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
      // The iterative passes deliberately advertise every SCC member as incompleteCycle so the
      // native compiler can consume monotonic partial facts. Once those facts converge, certify
      // the fixed point with resolved intra-SCC snapshots; genuine external incompleteness is
      // rediscovered and propagated by this final pass.
      for (const moduleKey of sortedComponent) {
        state.incompleteModuleMetadata.delete(moduleKey)
        state.unresolvedModuleMetadataRequests.delete(moduleKey)
      }
      const certifiedResults = new Map<string, Omit<PreparedCompilerTransform, 'preparationKey'>>()
      for (const moduleKey of sortedComponent) {
        const node = graph.get(moduleKey)!
        const tsImportElision = await getFixedTsImportElision(node)
        const { fictOptions, nativeMetadata } = await getPreparationKey(
          state,
          node,
          tsImportElision,
        )
        certifiedResults.set(
          moduleKey,
          await compileMetadataNode(state, node, fictOptions, tsImportElision, nativeMetadata),
        )
      }
      for (const moduleKey of sortedComponent) {
        const node = graph.get(moduleKey)!
        const result = certifiedResults.get(moduleKey)!
        const tsImportElision = await getFixedTsImportElision(node)
        const { key } = await getPreparationKey(state, node, tsImportElision)
        state.preparedCompilerTransforms.set(moduleKey, { ...result, preparationKey: key })
      }
    }
  }

  const preloadPipelineMetadata = async (
    state: MetadataTransformState,
    context: MetadataResolveContext,
    graph: Map<string, MetadataGraphNode>,
    rootId: string,
    attemptedLoads: Set<string>,
  ): Promise<boolean> => {
    assertTransformStateActive(state)
    if (!hasMetadataPipelineLoader(context)) return false

    const rootKey = createMetadataModuleIdentity(rootId, config?.root).key

    for (const moduleKey of graph.keys()) {
      // A back-edge into an active transform would deadlock the bundler's module loader.
      // Its input has already been captured, so metadata convergence can use that
      // pipeline source directly instead of recursively loading it again.
      if (
        moduleKey === rootKey ||
        state.pipelineTransformsInProgress.has(moduleKey) ||
        attemptedLoads.has(moduleKey)
      ) {
        continue
      }
      if (!state.pipelineTransformedModules.has(moduleKey)) {
        assertTransformStateActive(state)
        attemptedLoads.add(moduleKey)
        const node = graph.get(moduleKey)!
        const loadOptions = node.loadOptions ?? { id: node.id }
        if (config?.command === 'build') {
          await context.load!(loadOptions)
        } else {
          const environment = context.environment!
          const requestUrl =
            environment.moduleGraph?.getModuleById(loadOptions.id)?.url ??
            (config?.root
              ? createDevTransformRequestUrl(
                  loadOptions.id,
                  config.root,
                  config.resolve.preserveSymlinks === true,
                )
              : loadOptions.id)
          await environment.transformRequest!(requestUrl)
        }
        assertTransformStateActive(state)
        if (!state.pipelineCompilerInputs.has(moduleKey)) {
          throw new Error(
            `[fict] Transform pipeline did not provide compiler input for local dependency ${node.id}.`,
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
    id: string,
  ): Promise<void> => {
    assertTransformStateActive(state)
    let graph = await discoverMetadataGraph(state, context, code, id)
    assertTransformStateActive(state)
    const attemptedLoads = new Set<string>()
    // Refresh after each load: an earlier transform may add or remove imports, so the
    // raw on-disk dependency graph must not decide which subsequent modules are loaded.
    while (await preloadPipelineMetadata(state, context, graph, id, attemptedLoads)) {
      assertTransformStateActive(state)
      graph = await discoverMetadataGraph(state, context, code, id)
    }
    const rootKey = createMetadataModuleIdentity(id, config?.root).key
    const pipelinePrepared = new Set(
      [...graph.keys()].filter(
        dependency =>
          dependency !== rootKey &&
          state.pipelineTransformedModules.has(dependency) &&
          !state.pipelineTransformsInProgress.has(dependency) &&
          state.moduleMetadata.has(dependency),
      ),
    )
    const prepare = state.metadataPreparationQueue.then(async () => {
      assertTransformStateActive(state)
      await prepareMetadataGraph(state, graph, id, pipelinePrepared)
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
      if (resolvedConfig.command === 'serve') {
        const effectiveRoot =
          resolvedConfig.resolve.preserveSymlinks === true
            ? resolvedConfig.root
            : normalizeIdentityPath(resolvedConfig.root)
        if (effectiveRoot.includes('?') || effectiveRoot.includes('#')) {
          throw new Error(
            `[fict] Vite cannot serve project roots containing a literal "?" or "#" ` +
              `in dev mode: ${JSON.stringify(effectiveRoot)}. Rename the project directory ` +
              'or expose it through a delimiter-free symlink with preserveSymlinks enabled.',
          )
        }
        if (
          effectiveRoot !== resolvedConfig.root &&
          !resolvedConfig.server.fs.allow.includes(effectiveRoot)
        ) {
          // Vite resolves module ids through real paths by default, but its dev filesystem
          // allowlist can retain the logical root spelling (/var versus /private/var on macOS).
          // Metadata preloads use /@fs requests before ModuleGraph can mark those ids safe.
          resolvedConfig.server.fs.allow.push(effectiveRoot)
        }
      }
      config = resolvedConfig
      transformFilter = createTransformFilter(config.root)
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
      addTypeScriptConfigWatchFiles = null
      // Rebuild cache with resolved config so cacheDir is available
      resetCache()
      // A plugin instance can be reused by Vite restarts. Retire request-scoped dev
      // generations instead of clearing maps that old transforms may still reference.
      activeDevHandlerGenerations.clear()
      currentDevHandlerGeneration = createDevHandlerGeneration()
      lastDevHandlerHotUpdateTimestamp = undefined
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
      if (id.startsWith(DEV_VIRTUAL_HANDLER_PREFIX)) {
        const identity = parseDevHandlerVirtualId(id)
        if (!identity) {
          throw new Error(`[fict] Invalid dev handler module id: ${JSON.stringify(id)}.`)
        }
        const generation = activeDevHandlerGenerations.get(identity.generationId)
        const handler = generation?.registries.get(identity.environmentId)?.get(identity.handlerId)
        if (!handler) {
          throw new Error(
            `[fict] Dev handler ${JSON.stringify(identity.handlerId)} belongs to an expired ` +
              `or unavailable generation (${identity.generationId}/${identity.environmentId}).`,
          )
        }
        return handler.moduleCode !== undefined
          ? {
              code: handler.moduleCode,
              map: handler.moduleMap ? JSON.stringify(handler.moduleMap) : null,
            }
          : generateHandlerModule(handler)
      }

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
      return handler.moduleCode !== undefined
        ? {
            code: generatedCode,
            map: handler.moduleMap ? JSON.stringify(handler.moduleMap) : null,
          }
        : generatedCode
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
        'fict/experimental/loader',
        'fict/slim',
        'fict/jsx-runtime',
        'fict/jsx-dev-runtime',
        '@fictjs/runtime',
        '@fictjs/runtime/internal',
        '@fictjs/runtime/advanced',
        '@fictjs/runtime/experimental/loader',
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
      const metadataKey = createMetadataModuleIdentity(id, config?.root).key
      const isPassThroughVariant = moduleId.suffix !== ''
      const cacheIdentity = isPassThroughVariant ? metadataKey : filename
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
      const pipelineMetadataEnabled = hasMetadataPipelineLoader(metadataContext)
      const tracksModuleInput = pipelineMetadataEnabled || isPassThroughVariant
      // Pass-through URL variants keep their compiler output isolated from the
      // physical module while still publishing it under their full Vite identity.
      if (tracksModuleInput) {
        state.pipelineCompilerInputs.set(metadataKey, code)
        state.pipelineTransformsInProgress.set(
          metadataKey,
          (state.pipelineTransformsInProgress.get(metadataKey) ?? 0) + 1,
        )
      }
      try {
        const precompiledInput = isPrecompiledFictModule(code)
        if (!precompiledInput) {
          await prepareReachableMetadata(state, metadataContext, code, id)
          assertTransformStateActive(state)
        }
        const {
          fictOptions,
          project: tsProject,
          tsImportElision,
          nativeMetadata,
        } = await createCompilerOptions(state, code, normalizedFilename, undefined, {
          metadataKey,
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
          metadataKey,
          collectCompilerStaticModuleSourcesSync,
          state.incompleteModuleMetadata,
        )
        const cacheStore = ensureCache()
        const shouldSplit =
          compilerOptions.resumable === true ||
          (options.functionSplitting ??
            (config?.command === 'build' && (compilerOptions.resumable || !config?.build?.ssr)))
        // Function callbacks are observable compiler output. Replaying only code/maps from
        // either cache would silently drop warnings and explain artifacts.
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
                getCompilerStageFingerprint(),
                state.devHandlerGeneration && state.devEnvironmentId
                  ? `${state.devHandlerGeneration.id}:${state.devEnvironmentId}`
                  : '',
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
                  config?.resolve?.preserveSymlinks === true,
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
              storeModuleMetadataState(
                state,
                metadataKey,
                cached.moduleMetadata,
                cached.metadataIncomplete ?? false,
                cached.unresolvedMetadataRequests ?? [],
              )
            }
            if (tracksModuleInput) {
              state.pipelineTransformedModules.add(metadataKey)
            }
            return {
              code: cached.code,
              map: cached.map,
            }
          }
        }

        let finalCode: string
        let finalMap: TransformResult['map']
        let compilerArtifacts: CompilerArtifact[] = []
        let compilerStageResult: CompilerStageResult | null = null
        let splitResult: { code: string; handlers: string[]; map: TransformResult['map'] } | null =
          null

        if (precompiledInput) {
          finalCode = code
          finalMap = null
        } else {
          const preparationKey = buildMetadataPreparationKey(
            metadataKey,
            code,
            fictOptions,
            tsProject,
            tsImportElision,
            dependencyFingerprint,
            getCompilerStageFingerprint(),
          )
          const prepared = isPassThroughVariant
            ? undefined
            : state.preparedCompilerTransforms.get(metadataKey)
          let result: CompilerStageResult
          if (!hasObservableCompilerCallbacks && prepared?.preparationKey === preparationKey) {
            result = prepared
          } else {
            result = await compileFictCompilerStage(
              code,
              normalizedFilename,
              fictOptions,
              tsImportElision,
              {
                moduleId: id,
                metadata: nativeMetadata,
                nativeCompiler: getNativeCompiler(),
              },
            )
            assertTransformStateActive(state)
            if (!isPassThroughVariant) {
              state.preparedCompilerTransforms.set(metadataKey, {
                ...result,
                preparationKey,
              })
            }
          }
          storeModuleMetadataState(
            state,
            metadataKey,
            result.moduleMetadata,
            result.metadataIncomplete,
            result.unresolvedMetadataRequests,
          )
          compilerStageResult = result
          finalCode = result.code
          finalMap = result.map
          compilerArtifacts = result.artifacts
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
          const devHandlerModuleOptions =
            state.devHandlerGeneration && state.devEnvironmentId
              ? {
                  base: config?.base,
                  environmentId: state.devEnvironmentId,
                  generationId: state.devHandlerGeneration.id,
                  origin: config?.server.origin,
                }
              : undefined
          const resolveHandlerModuleId = devHandlerModuleOptions
            ? (handlerId: string) =>
                createDevHandlerModuleId(
                  handlerId,
                  devHandlerModuleOptions.generationId,
                  devHandlerModuleOptions.environmentId,
                  devHandlerModuleOptions,
                )
            : undefined
          splitResult = consumeStructuredHandlerArtifacts(
            finalCode,
            id,
            compilerArtifacts,
            state.extractedHandlers,
            finalMap,
            config?.root,
            packageBoundaryCache,
            publicIdentityNamespace,
            config?.resolve?.preserveSymlinks === true,
            resolveHandlerModuleId,
          )
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
                  id,
                  handlerName,
                  config?.root,
                  packageBoundaryCache,
                  publicIdentityNamespace,
                  config?.resolve?.preserveSymlinks === true,
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
          if (compilerStageResult) {
            cachedTransform.moduleMetadata = compilerStageResult.moduleMetadata
            cachedTransform.metadataIncomplete = compilerStageResult.metadataIncomplete
            cachedTransform.unresolvedMetadataRequests =
              compilerStageResult.unresolvedMetadataRequests
          }

          if (shouldSplit && splitResult?.handlers.length) {
            cachedTransform.extractedHandlers = splitResult.handlers
              .map(handlerName =>
                state.extractedHandlers.get(
                  createHandlerId(
                    id,
                    handlerName,
                    config?.root,
                    packageBoundaryCache,
                    publicIdentityNamespace,
                    config?.resolve?.preserveSymlinks === true,
                  ),
                ),
              )
              .filter((handler): handler is ExtractedHandler => !!handler)
          }

          await cacheStore.set(cacheKey, cachedTransform)
          assertTransformStateActive(state)
        }

        if (tracksModuleInput) {
          state.pipelineTransformedModules.add(metadataKey)
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
          cause: error,
        })

        return null
      } finally {
        if (tracksModuleInput) {
          const remaining = (state.pipelineTransformsInProgress.get(metadataKey) ?? 1) - 1
          if (remaining > 0) {
            state.pipelineTransformsInProgress.set(metadataKey, remaining)
          } else {
            state.pipelineTransformsInProgress.delete(metadataKey)
          }
        }
        releaseState()
      }
    },

    hotUpdate({ file, modules, timestamp }) {
      const environment = this.environment
      const state = getEnvironmentTransformState(environment)
      const tsConfigChanged = isTypeScriptConfigDependency(state, file)
      const packageMetadataChanged = isPackageMetadataDependency(state, file)
      const affectsTransform = affectsFictTransform(file, modules)
      if (!tsConfigChanged && !packageMetadataChanged && !affectsTransform) return undefined

      if (tsConfigChanged || packageMetadataChanged) resetCache()
      replaceInvalidatedDevHandlerGeneration([environment], timestamp)
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
        replaceInvalidatedDevHandlerGeneration(environments)
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
                config.resolve.preserveSymlinks === true,
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
          const lookupKey = createPublicModuleLookupKey(
            moduleId,
            config.root,
            config.resolve.preserveSymlinks === true,
          )
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
          const key = publicModuleIds.get(
            createPublicModuleLookupKey(
              moduleId,
              config.root,
              config.resolve.preserveSymlinks === true,
            ),
          )
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

  const normalizedId = normalizeFileName(withoutQuery, root).replace(/\\/g, '/')

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

function createMetadataModuleIdentity(id: string, root?: string): ResolvedMetadataModule {
  const { filename, suffix } = splitModuleId(id, { root })
  const normalizedFilename = normalizeFileName(filename, root)
  return {
    filename: normalizedFilename,
    key: suffix ? `${normalizedFilename}\0${suffix}` : normalizedFilename,
  }
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

function normalizeModuleIdentityPath(filename: string, preserveSymlinks: boolean): string {
  const normalized = path.normalize(path.resolve(filename))
  // Vite intentionally treats symlink requests as separate modules when this option is on.
  // Preserve that logical identity; otherwise follow Vite's default physical-module semantics.
  return preserveSymlinks ? normalized : normalizeIdentityPath(normalized)
}

function encodeViteModulePath(filename: string): string {
  return encodeURI(filename.split(path.sep).join('/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/**
 * Produce the browser URL that Vite serves for a transformed module in dev.
 * Root-relative logical requests stay logical when preserveSymlinks is enabled;
 * default resolution follows the physical module identity used by Vite.
 */
interface DevPublicModuleIdOptions {
  base?: string | undefined
  origin?: string | undefined
  preserveSymlinks?: boolean | undefined
}

function createDevPublicModuleId(
  id: string,
  rootDir: string,
  options: DevPublicModuleIdOptions = {},
): string {
  const { filename, suffix } = splitModuleId(id, { root: rootDir })
  const logicalRoot = path.normalize(path.resolve(rootDir))
  const logicalFilename = normalizeFileName(filename, rootDir)

  let identityRoot = logicalRoot
  let identityFilename = logicalFilename
  if (options.preserveSymlinks !== true) {
    identityRoot = normalizeIdentityPath(logicalRoot)
    identityFilename = normalizeIdentityPath(logicalFilename)
  } else if (!isPathAtOrInsideDirectory(logicalRoot, logicalFilename)) {
    // Vite can expose a physical id for a logically symlinked project root (for example,
    // /private/var versus /var on macOS). Normalize that root spelling without resolving a
    // logical module symlink that Vite intentionally preserved.
    const physicalRoot = normalizeIdentityPath(logicalRoot)
    if (physicalRoot !== logicalRoot && isPathAtOrInsideDirectory(physicalRoot, logicalFilename)) {
      identityRoot = physicalRoot
    }
  }
  if (isPathAtOrInsideDirectory(identityRoot, identityFilename)) {
    const relative = portableRelativePath(identityRoot, identityFilename)
    assertServableViteDevPath(relative, identityFilename)
    const modulePath = `/${encodeViteModulePath(relative === '.' ? '' : relative)}${suffix}`
    return prependViteDevUrl(modulePath, options)
  }

  assertServableViteDevPath(identityFilename, identityFilename)
  const absolute = encodeViteModulePath(identityFilename)
  const fsPath = absolute.startsWith('/') ? absolute : `/${absolute}`
  return prependViteDevUrl(`/@fs${fsPath}${suffix}`, options)
}

/**
 * Produce an internal Vite request URL for a resolved dependency that has not entered the
 * module graph yet. Always use /@fs so Vite treats an absolute file id as a filesystem request
 * instead of a project-root URL. configResolved exposes an equivalent physical root spelling
 * (notably /private/var for /var on macOS) to the dev filesystem allowlist.
 */
function createDevTransformRequestUrl(
  id: string,
  rootDir: string,
  preserveSymlinks = false,
): string {
  const { filename, suffix } = splitModuleId(id, { root: rootDir })
  let requestFilename = normalizeFileName(filename, rootDir)
  if (!preserveSymlinks) requestFilename = normalizeIdentityPath(requestFilename)

  assertServableViteDevPath(requestFilename, requestFilename)
  const absolute = encodeViteModulePath(requestFilename)
  const fsPath = absolute.startsWith('/') ? absolute : `/${absolute}`
  return `/@fs${fsPath}${suffix}`
}

function createDevHandlerModuleId(
  handlerId: string,
  generationId: string,
  environmentId: string,
  options: DevPublicModuleIdOptions = {},
): string {
  return prependViteDevUrl(
    `${VITE_DEV_HANDLER_PREFIX}${generationId}:${environmentId}:${handlerId}`,
    options,
  )
}

function parseDevHandlerVirtualId(id: string): {
  generationId: string
  environmentId: string
  handlerId: string
} | null {
  if (!id.startsWith(DEV_VIRTUAL_HANDLER_PREFIX)) return null
  const [generationId, environmentId, ...handlerSegments] = id
    .slice(DEV_VIRTUAL_HANDLER_PREFIX.length)
    .split(':')
  const handlerId = handlerSegments.join(':')
  if (!generationId?.match(/^g[0-9a-z]+$/) || !environmentId?.match(/^e[0-9a-z]+$/) || !handlerId) {
    return null
  }
  return { generationId, environmentId, handlerId }
}

function prependViteDevUrl(modulePath: string, options: DevPublicModuleIdOptions): string {
  const encodedBase = options.base || '/'
  const basePrefix = encodedBase === '/' ? '' : `/${encodedBase.replace(/^\/+|\/+$/g, '')}`
  const basedPath = `${basePrefix}${modulePath}`
  const origin = options.origin?.replace(/\/+$/, '')
  return origin ? `${origin}${basedPath}` : basedPath
}

function assertServableViteDevPath(publicPath: string, filename: string): void {
  if (!publicPath.includes('?') && !publicPath.includes('#')) return
  throw new Error(
    `[fict] Cannot create a resumable Vite dev URL for ${JSON.stringify(filename)}: ` +
      'Vite cannot serve source paths containing a literal "?" or "#". Rename the path or ' +
      'expose it through a delimiter-free symlink with preserveSymlinks enabled.',
  )
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
  preserveSymlinks = false,
): { filename: string; lookupKey: string; suffix: string } {
  const { filename, suffix } = splitModuleId(id, { root: rootDir })
  const normalizedFilename = normalizeModuleIdentityPath(
    normalizeFileName(filename, rootDir),
    preserveSymlinks,
  )
  return {
    filename: normalizedFilename,
    lookupKey: JSON.stringify([normalizedFilename, suffix]),
    suffix,
  }
}

function createPublicModuleLookupKey(
  id: string,
  rootDir: string,
  preserveSymlinks = false,
): string {
  return getPublicModuleIdentityParts(id, rootDir, preserveSymlinks).lookupKey
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
  preserveSymlinks = false,
): Omit<PublicModuleIdentity, 'id'> {
  const root = normalizeModuleIdentityPath(rootDir, preserveSymlinks)
  const { filename: source, suffix } = getPublicModuleIdentityParts(
    filename,
    rootDir,
    preserveSymlinks,
  )
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
      const packageRoot = normalizeModuleIdentityPath(projectBoundary.root, preserveSymlinks)
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
    const packageRoot = normalizeModuleIdentityPath(boundary.root, preserveSymlinks)
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
  preserveSymlinks = false,
): string {
  return createPublicModuleIdentity(
    filename,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
    preserveSymlinks,
  ).id
}

function createPublicModuleIdentity(
  filename: string,
  rootDir: string,
  packageBoundaryCache: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
  preserveSymlinks = false,
): PublicModuleIdentity {
  const sourceIdentity = createPublicModuleSourceIdentity(
    filename,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
    preserveSymlinks,
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

function stripJsonComments(source: string): string {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        output += '  '
        index++
      } else {
        output += char === '\n' || char === '\r' ? char : ' '
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      output += '  '
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      output += '  '
      index++
      continue
    }
    output += char
  }
  return output
}

function stripJsonTrailingCommas(source: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let nextIndex = index + 1
      while (/\s/.test(source[nextIndex] ?? '')) nextIndex++
      if (source[nextIndex] === '}' || source[nextIndex] === ']') continue
    }
    output += char
  }
  return output
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTypeScriptConfigObject(
  configPath: string,
  source: string,
): Record<string, unknown> | null {
  const loaders = [createRequire(configPath), requireFromVitePlugin]
  for (const load of loaders) {
    try {
      const ts = load('typescript') as Partial<TypeScriptApi>
      const result = ts.parseConfigFileTextToJson?.(configPath, source)
      if (result && !result.error && isObjectRecord(result.config)) return result.config
    } catch {
      // TypeScript is an optional host dependency; use the JSONC fallback below.
    }
  }
  try {
    const parsed = JSON.parse(stripJsonTrailingCommas(stripJsonComments(source))) as unknown
    return isObjectRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readDeclaredTypeScriptConfigDependencies(
  configPath: string,
): DeclaredTypeScriptConfigDependencies | null {
  let source: string
  try {
    source = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
  const config = parseTypeScriptConfigObject(configPath, source)
  if (!config) return null

  const extendedValue = config.extends
  const extended =
    typeof extendedValue === 'string'
      ? [extendedValue]
      : Array.isArray(extendedValue)
        ? extendedValue.filter((value): value is string => typeof value === 'string')
        : []
  const referencedValue = config.references
  const referenced = Array.isArray(referencedValue)
    ? referencedValue.flatMap(reference => {
        if (!isObjectRecord(reference)) return []
        return typeof reference.path === 'string' ? [reference.path] : []
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

function classifyTypeScriptImportProbeOutput(code: string): TypeScriptImportElision {
  const probeImport = new RegExp(
    `(?:^|[;\\n])\\s*import\\s*([^;\\n]*?)["']${escapeRegExp(TYPESCRIPT_IMPORT_PROBE_SOURCE)}["']`,
    'm',
  ).exec(code)
  if (!probeImport) return 'remove'
  return probeImport[1]?.trim() ? 'verbatim' : 'preserve-side-effect'
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
  return classifyTypeScriptImportProbeOutput(result.code)
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
  return JSON.stringify([importer, source])
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

interface CompilerStageOptions {
  moduleId: string
  metadata: ResolvedMetadataInput[]
  nativeCompiler: NativeCompilerBinding
}

function sourcePositionForByteOffset(
  source: string,
  byteOffset: number,
): { line: number; column: number } {
  const bytes = Buffer.from(source)
  const prefix = bytes.subarray(0, Math.min(Math.max(0, byteOffset), bytes.length)).toString('utf8')
  const lines = prefix.split('\n')
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.replace(/\r$/, '').length ?? 0) + 1,
  }
}

function sourceByteOffsetForPosition(source: string, line: number, column: number): number | null {
  if (line <= 0 || column <= 0) return null
  let index = 0
  let currentLine = 1
  while (currentLine < line) {
    const newline = source.indexOf('\n', index)
    if (newline === -1) return null
    index = newline + 1
    currentLine += 1
  }
  const lineEnd = source.indexOf('\n', index)
  const end = lineEnd === -1 ? source.length : lineEnd
  const sourceIndex = Math.min(index + column - 1, end)
  return Buffer.byteLength(source.slice(0, sourceIndex))
}

function nativeDiagnosticToWarning(
  diagnostic: FictDiagnostic,
  source: string,
  filename: string,
): FictPluginWarning {
  const position = diagnostic.primarySpan
    ? sourcePositionForByteOffset(source, diagnostic.primarySpan.start)
    : { line: 0, column: 0 }
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    fileName: filename,
    line: position.line,
    column: position.column,
  }
}

function formatNativeDiagnostic(
  diagnostic: FictDiagnostic,
  source: string,
  filename: string,
): string {
  const warning = nativeDiagnosticToWarning(diagnostic, source, filename)
  const location = warning.line > 0 ? `\n  at ${filename}:${warning.line}:${warning.column}` : ''
  const help = diagnostic.help ? `\n  help: ${diagnostic.help}` : ''
  return `[${diagnostic.code}] ${diagnostic.message}${location}${help}`
}

function nativeExplainForPlugin(
  artifact: NativeCompilerExplainArtifact,
  source: string,
  filename: string,
): FictPluginExplainArtifact {
  return {
    version: 1,
    fileName: artifact.fileName,
    helpers: artifact.helpers,
    diagnostics: artifact.diagnostics.map(diagnostic =>
      nativeDiagnosticToWarning(diagnostic, source, filename),
    ),
    events: artifact.events.map(event => {
      const position = event.span
        ? sourcePositionForByteOffset(source, event.span.start)
        : undefined
      return {
        kind: event.kind,
        message: event.message,
        ...(event.name ? { name: event.name } : {}),
        ...(event.code ? { code: event.code } : {}),
        ...(position ? { line: position.line, column: position.column } : {}),
      }
    }),
  }
}

function nativeCompilerOptions(
  options: FictPluginCompilerOptions,
  tsImportElision: TypeScriptImportElision,
): NativeCompilerOptions {
  const typescript = options.typescriptOptions
  return {
    dev: options.dev ?? false,
    sourcemap: options.sourcemap ?? true,
    explain: options.explain === true || typeof options.explain === 'function',
    lazyConditional: options.lazyConditional ?? true,
    getterCache: options.getterCache ?? true,
    fineGrainedDom: options.fineGrainedDom ?? true,
    optimize: options.optimize ?? true,
    optimizeLevel: options.optimizeLevel ?? 'safe',
    inlineDerivedMemos: options.inlineDerivedMemos ?? true,
    strictReactivity: options.strictReactivity ?? false,
    strictGuarantee: resolveStrictGuarantee(options.strictGuarantee),
    warningsAsErrors: options.warningsAsErrors ?? false,
    warningLevels: options.warningLevels ?? {},
    reactiveScopes: options.reactiveScopes ?? [],
    typescript: {
      allowNamespaces: typescript?.allowNamespaces ?? true,
      onlyRemoveTypeImports: typescript?.onlyRemoveTypeImports ?? tsImportElision !== 'remove',
      optimizeConstEnums: typescript?.optimizeConstEnums ?? false,
      optimizeEnums: typescript?.optimizeEnums ?? false,
      rewriteImportExtensions: typescript?.rewriteImportExtensions ?? false,
      removeClassFieldsWithoutInitializer: typescript?.removeClassFieldsWithoutInitializer ?? false,
    },
    ...(options.resumable === true
      ? {
          preview: {
            resumable: true,
            autoExtractHandlers: options.autoExtractHandlers ?? true,
            autoExtractThreshold: options.autoExtractThreshold ?? 3,
          },
        }
      : {}),
  }
}

function nativeIntegrationDiagnostics(
  source: string,
  warnings: readonly FictPluginWarning[] | undefined,
): FictDiagnostic[] {
  return (warnings ?? []).map(warning => {
    const offset = sourceByteOffsetForPosition(source, warning.line, warning.column)
    return {
      code: warning.code,
      severity: 'warning',
      message: warning.message,
      primarySpan: offset === null ? null : { start: offset, end: offset },
      secondaryLabels: [],
      help: null,
      notes: [],
      guaranteeClass: 'advisory',
    }
  })
}

function consumeNativeScanResult(result: ScanResult, source: string, filename: string): string[] {
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) {
    const error = new SyntaxError(
      errors.map(diagnostic => formatNativeDiagnostic(diagnostic, source, filename)).join('\n'),
    ) as SyntaxError & { code?: string; loc?: { line: number; column: number } }
    const first = errors[0]!
    error.code = first.code
    if (first.primarySpan) {
      error.loc = sourcePositionForByteOffset(source, first.primarySpan.start)
    }
    throw error
  }

  return Array.from(
    new Set(
      result.moduleRequests
        .filter(request => request.kind !== 'importEquals' || !request.typeOnly)
        .map(request => request.source),
    ),
  ).sort()
}

function consumeNativeCompileResult(
  result: CompileResult,
  source: string,
  filename: string,
  options: FictPluginCompilerOptions,
): CompilerStageResult {
  for (const dependency of result.metadataDependencies) {
    options.onModuleMetadataDependency?.(dependency)
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === 'warning') {
      options.onWarn?.(nativeDiagnosticToWarning(diagnostic, source, filename))
    }
  }
  if (result.explain && typeof options.explain === 'function') {
    options.explain(nativeExplainForPlugin(result.explain, source, filename))
  }

  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) {
    const error = new SyntaxError(
      errors.map(diagnostic => formatNativeDiagnostic(diagnostic, source, filename)).join('\n'),
    ) as SyntaxError & { code?: string; loc?: { line: number; column: number } }
    const first = errors[0]!
    error.code = first.code
    if (first.primarySpan) {
      error.loc = sourcePositionForByteOffset(source, first.primarySpan.start)
    }
    throw error
  }

  return {
    code: result.code,
    map: result.map as TransformResult['map'],
    artifacts: result.artifacts,
    moduleMetadata: result.moduleMetadata,
    metadataIncomplete: result.metadataIncomplete,
    unresolvedMetadataRequests: [...result.unresolvedMetadataRequests],
  }
}

async function compileFictCompilerStage(
  code: string,
  filename: string,
  fictOptions: FictPluginCompilerOptions,
  tsImportElision: TypeScriptImportElision,
  stage: CompilerStageOptions,
): Promise<CompilerStageResult> {
  const request: CompileRequest = {
    code,
    filename,
    moduleId: stage.moduleId,
    ...(fictOptions.publicModuleId ? { publicModuleId: fictOptions.publicModuleId } : {}),
    options: nativeCompilerOptions(fictOptions, tsImportElision),
    metadata: stage.metadata,
    integrationDiagnostics: nativeIntegrationDiagnostics(code, fictOptions.integrationDiagnostics),
  }
  const result = await stage.nativeCompiler.transform(request)
  return consumeNativeCompileResult(result, code, filename, fictOptions)
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
  compilerOptions: FictPluginCompilerOptions,
  moduleMetadata: Map<string, ModuleReactiveMetadata>,
  root?: string,
  aliases: AliasEntry[] = [],
  visited = new Set<string>(),
  resolvedLocalModules?: ReadonlyMap<string, ResolvedMetadataModule>,
  onPackageMetadataDependency?: (filename: string) => void,
  metadataKey?: string,
  collectModuleSources: (code: string, filename: string) => string[] = () => [],
  incompleteModuleMetadata: ReadonlySet<string> = new Set(),
): string {
  const normalizedFilename = normalizeFileName(filename, root)
  const currentMetadataKey = metadataKey ?? normalizedFilename
  if (visited.has(currentMetadataKey)) return '[]'
  visited.add(currentMetadataKey)

  const entries: [string, string | null, string?][] = []
  const sources = collectModuleSources(code, normalizedFilename)
  for (const source of sources) {
    const userMetadata = compilerOptions.resolveModuleMetadata?.(source, normalizedFilename)
    if (userMetadata !== undefined) {
      entries.push([
        source,
        userMetadata === null ? null : stableStringify(userMetadata),
        'custom-resolver',
      ])
      continue
    }
    const exactResolution = resolvedLocalModules?.get(
      createLocalResolutionKey(currentMetadataKey, source),
    )
    const localFile =
      exactResolution?.filename ??
      resolveLocalModuleSource(source, normalizedFilename, root, aliases)
    if (localFile) {
      try {
        const localCode = readFileSync(localFile, 'utf8')
        const storedKey = exactResolution?.key ?? localFile
        const storedMetadata = moduleMetadata.get(storedKey)
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
          exactResolution?.key ?? localFile,
          collectModuleSources,
          incompleteModuleMetadata,
        )
        entries.push([
          source,
          storedMetadata ? stableStringify(storedMetadata) : null,
          `${incompleteModuleMetadata.has(storedKey) ? 'incomplete' : 'resolved'}:${hashString(localCode)}:${nestedFingerprint}`,
        ])
      } catch {
        entries.push([source, null, 'unreadable'])
      }
      continue
    }
    const packageSource = resolveAliasedPackageSource(source, aliases)
    if (packageSource) {
      const metadata = resolvePackageModuleMetadata(packageSource, normalizedFilename, {
        ...(onPackageMetadataDependency ? { onDependency: onPackageMetadataDependency } : {}),
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
  createDevPublicModuleId,
  createPublicModuleId: (
    filename: string,
    root: string,
    namespace?: string,
    preserveSymlinks = false,
  ): string => createPublicModuleId(filename, root, new Map(), namespace, preserveSymlinks),
  createHandlerId: (
    filename: string,
    exportName: string,
    root: string,
    namespace?: string,
    preserveSymlinks = false,
  ): string => createHandlerId(filename, exportName, root, new Map(), namespace, preserveSymlinks),
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

function compilerEnvironmentCacheInputs(
  options: FictPluginCompilerOptions,
): Record<string, unknown> {
  const nodeEnv = process.env.NODE_ENV
  return {
    nodeEnv,
    strictGuaranteeEnv: process.env.FICT_STRICT_GUARANTEE,
    effectiveStrictGuarantee: resolveStrictGuarantee(options.strictGuarantee),
  }
}

function normalizeOptionsForCache(options: FictPluginCompilerOptions): Record<string, unknown> {
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
  options: FictPluginCompilerOptions,
  tsProject: TypeScriptProject | null,
  tsImportElision: TypeScriptImportElision,
  shouldSplit: boolean,
  packageMetadataFingerprint: string,
  compilerStageFingerprint: string,
  devHandlerNamespace = '',
): string {
  const codeHash = hashString(code)
  const optionsHash = hashString(stableStringify(normalizeOptionsForCache(options)))
  const tsKey = tsProject ? `${tsProject.configHash}:${tsProject.projectVersion}` : ''
  return hashString(
    [
      CACHE_VERSION,
      compilerStageFingerprint,
      filename,
      codeHash,
      optionsHash,
      tsKey,
      tsImportElision,
      shouldSplit ? 'split' : 'inline',
      packageMetadataFingerprint,
      devHandlerNamespace,
    ].join('|'),
  )
}

function buildMetadataPreparationKey(
  filename: string,
  code: string,
  options: FictPluginCompilerOptions,
  tsProject: TypeScriptProject | null,
  tsImportElision: TypeScriptImportElision,
  dependencyMetadataFingerprint: string,
  compilerStageFingerprint: string,
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
      compilerStageFingerprint,
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
  preserveSymlinks = false,
): string {
  if (!rootDir) {
    return `external:${hashString(sourceModule.split(path.sep).join('/'))}`
  }
  const root = normalizeModuleIdentityPath(rootDir, preserveSymlinks)
  const { filename, suffix } = getPublicModuleIdentityParts(sourceModule, rootDir, preserveSymlinks)
  const publicIdentity = createPublicModuleSourceIdentity(
    sourceModule,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
    preserveSymlinks,
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
  preserveSymlinks = false,
): string {
  const sourceIdentity = createHandlerSourceIdentity(
    sourceModule,
    rootDir,
    packageBoundaryCache,
    explicitNamespace,
    preserveSymlinks,
  )
  return `h${hashString(sourceIdentity).slice(0, 32)}$$${exportName}`
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
  if (handler.moduleCode !== undefined) {
    return handler.moduleCode
  }
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

/**
 * Consume Rust compiler-owned handler modules without reparsing generated JavaScript.
 * MagicString records exact placeholder edits and its map is composed through OXC's map.
 */
function consumeStructuredHandlerArtifacts(
  code: string,
  sourceModule: string,
  artifacts: readonly CompilerArtifact[],
  handlerRegistry: Map<string, ExtractedHandler>,
  inputSourceMap: TransformResult['map'] = null,
  rootDir?: string,
  packageBoundaryCache?: Map<string, PackageBoundary | null>,
  explicitNamespace?: string,
  preserveSymlinks = false,
  resolveHandlerModuleId?: (handlerId: string) => string,
): { code: string; handlers: string[]; map: TransformResult['map'] } | null {
  const handlers = artifacts.filter(artifact => artifact.kind === 'handlerModule')
  if (handlers.length === 0) {
    if (code.includes('fict:compiler-artifact:')) {
      throw new Error('[fict] Rust output contains artifact placeholders but no handler artifacts.')
    }
    return null
  }

  const seenIds = new Set<string>()
  const seenSpecifiers = new Set<string>()
  const pending: {
    artifact: CompilerArtifact
    sourceExportName: string
    handlerId: string
    moduleId: string
    ranges: { start: number; end: number }[]
  }[] = []
  for (const artifact of handlers) {
    const metadata = artifact.handler
    if (!metadata) {
      throw new Error(
        `[fict] Rust handler artifact ${JSON.stringify(artifact.id)} has no routing metadata.`,
      )
    }
    if (!seenIds.add(artifact.id)) {
      throw new Error(`[fict] Rust compiler emitted duplicate artifact id ${artifact.id}.`)
    }
    if (!seenSpecifiers.add(metadata.moduleSpecifier)) {
      throw new Error(
        `[fict] Rust compiler emitted duplicate artifact specifier ${metadata.moduleSpecifier}.`,
      )
    }
    const encodedSpecifier = JSON.stringify(metadata.moduleSpecifier)
    const ranges: { start: number; end: number }[] = []
    let start = code.indexOf(encodedSpecifier)
    while (start >= 0) {
      ranges.push({ start, end: start + encodedSpecifier.length })
      start = code.indexOf(encodedSpecifier, start + encodedSpecifier.length)
    }
    if (ranges.length === 0) {
      throw new Error(
        `[fict] Rust artifact ${JSON.stringify(artifact.id)} has no ` +
          `main-output placeholder ${encodedSpecifier}.`,
      )
    }
    const handlerId = createHandlerId(
      sourceModule,
      metadata.sourceExportName,
      rootDir,
      packageBoundaryCache,
      explicitNamespace,
      preserveSymlinks,
    )
    pending.push({
      artifact,
      sourceExportName: metadata.sourceExportName,
      handlerId,
      moduleId:
        resolveHandlerModuleId?.(handlerId) ?? `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`,
      ranges,
    })
  }

  const edited = new MagicString(code)
  for (const item of pending) {
    for (const range of item.ranges) {
      edited.overwrite(range.start, range.end, JSON.stringify(item.moduleId))
    }
  }
  if (edited.toString().includes('fict:compiler-artifact:')) {
    throw new Error('[fict] Rust output contains an unclaimed compiler artifact placeholder.')
  }

  const editMap = JSON.parse(
    edited
      .generateMap({
        hires: true,
        includeContent: true,
        source: sourceModule,
      })
      .toString(),
  ) as RawSourceMap
  const map = inputSourceMap
    ? (JSON.parse(
        remapping(
          [
            editMap as unknown as RemappingSourceMapInput,
            inputSourceMap as unknown as RemappingSourceMapInput,
          ],
          () => null,
          { excludeContent: false },
        ).toString(),
      ) as RawSourceMap)
    : editMap
  for (const item of pending) {
    handlerRegistry.set(item.handlerId, {
      sourceModule,
      exportName: item.sourceExportName,
      helpersUsed: [],
      localDeps: [],
      code: '',
      runtimeImportFamily: 'fict',
      moduleCode: item.artifact.code,
      moduleMap: item.artifact.map,
    })
  }
  return {
    code: edited.toString(),
    handlers: pending.map(item => item.sourceExportName),
    map: map as TransformResult['map'],
  }
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
