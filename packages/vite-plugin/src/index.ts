import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { transformAsync, type PluginItem } from '@babel/core'
import _generate from '@babel/generator'
import { parse } from '@babel/parser'
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
import { createFilter, type Plugin, type ResolvedConfig, type TransformResult } from 'vite'

import { createVitePluginCacheFingerprint } from './cache-fingerprint'

// Handle ESM/CJS interop for Babel packages
const traverse = (
  typeof _traverse === 'function' ? _traverse : (_traverse as { default: typeof _traverse }).default
) as typeof _traverse
const generate = (
  typeof _generate === 'function' ? _generate : (_generate as { default: typeof _generate }).default
) as typeof _generate

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

interface MetadataGraphNode {
  filename: string
  code: string
  dependencies: Set<string>
}

interface MetadataResolveContext {
  resolve?: (
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ) => Promise<{ id: string; external?: boolean | 'absolute' | 'relative' } | null>
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

const CACHE_VERSION = 3
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
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_APP_INCLUDE = MODULE_EXTENSIONS.map(extension => `**/*${extension}`)
const DEFAULT_LIBRARY_INCLUDE = DEFAULT_APP_INCLUDE
const LIBRARY_METADATA_VERSION = 1 satisfies ModuleReactiveMetadata['version']

// Virtual module prefix for extracted handlers
const VIRTUAL_HANDLER_PREFIX = '\0fict-handler:'
const VIRTUAL_HANDLER_RESOLVE_PREFIX = 'virtual:fict-handler:'

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
    ...compilerOptions
  } = options
  const libraryOptions = normalizeLibraryOptions(libraryOption)
  const includePatterns =
    include ?? (libraryOptions.enabled ? DEFAULT_LIBRARY_INCLUDE : DEFAULT_APP_INCLUDE)
  const transformFilter = createFilter(includePatterns, exclude)

  let config: ResolvedConfig | undefined
  let isDev = false
  let cache: TransformCache | null = null
  let tsProject: TypeScriptProject | null = null
  let tsProjectInit: Promise<TypeScriptProject | null> | null = null
  const moduleMetadata: FictCompilerOptions['moduleMetadata'] = new Map()
  const resolvedLocalModules = new Map<string, string>()
  const preparedCompilerTransforms = new Map<string, PreparedCompilerTransform>()
  let metadataPreparationQueue: Promise<void> = Promise.resolve()
  const extractedHandlers = new Map<string, ExtractedHandler>()
  const libraryMetadataAssets = new Map<string, LibraryMetadataAsset>()
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

  const ensureTypeScriptProject = async () => {
    if (!useTypeScriptProject) return null
    if (tsProject) return tsProject
    if (!tsProjectInit) {
      tsProjectInit = (async () => {
        const ts = await loadTypeScript()
        if (!ts) return null
        const rootDir = config?.root ?? process.cwd()
        const resolvedConfigPath = resolveTsconfigPath(ts, rootDir, tsconfigPath)
        if (!resolvedConfigPath) return null
        return createTypeScriptProject(ts, rootDir, resolvedConfigPath)
      })()
    }
    tsProject = await tsProjectInit
    return tsProject
  }

  const resetTypeScriptProject = () => {
    if (tsProject) {
      tsProject.dispose()
    }
    tsProject = null
    tsProjectInit = null
  }

  const resetTransformState = () => {
    moduleMetadata.clear()
    resolvedLocalModules.clear()
    preparedCompilerTransforms.clear()
    metadataPreparationQueue = Promise.resolve()
    extractedHandlers.clear()
    libraryMetadataAssets.clear()
  }

  const lookupStoredMetadata = (resolved: string): ModuleReactiveMetadata | undefined => {
    const normalized = normalizeFileName(resolved, config?.root)
    const direct = moduleMetadata.get(normalized)
    if (direct) return direct
    const ext = path.extname(normalized)
    if (!ext) {
      for (const suffix of MODULE_EXTENSIONS) {
        const byExt = moduleMetadata.get(`${normalized}${suffix}`)
        if (byExt) return byExt
      }
      for (const suffix of MODULE_EXTENSIONS) {
        const byIndex = moduleMetadata.get(path.join(normalized, `index${suffix}`))
        if (byIndex) return byIndex
      }
    }
    return undefined
  }

  const resolveCompilerModuleMetadata = (
    source: string,
    importer?: string,
  ): ModuleReactiveMetadata | undefined => {
    const userResolved = compilerOptions.resolveModuleMetadata?.(source, importer)
    if (userResolved) return userResolved
    if (!importer) return undefined

    const importerFile = normalizeFileName(importer, config?.root)
    const exactResolution = resolvedLocalModules.get(createLocalResolutionKey(importerFile, source))
    const aliasEntries = normalizeAliases(config?.resolve?.alias)
    let resolvedSource = exactResolution ?? null

    if (!resolvedSource) {
      if (path.isAbsolute(source)) {
        resolvedSource = normalizeFileName(source, config?.root)
      } else if (source.startsWith('.')) {
        resolvedSource = resolveExistingModuleFile(path.resolve(path.dirname(importerFile), source))
      } else {
        const aliased = applyAlias(source, aliasEntries)
        if (aliased) {
          if (path.isAbsolute(aliased)) {
            resolvedSource = resolveExistingModuleFile(aliased)
          } else if (aliased.startsWith('.')) {
            resolvedSource = resolveExistingModuleFile(
              path.resolve(path.dirname(importerFile), aliased),
            )
          } else if (config?.root) {
            resolvedSource = resolveExistingModuleFile(path.resolve(config.root, aliased))
          }
        }
        // Do not classify an unresolved bare request as local solely because a monorepo
        // tsconfig maps it to workspace source. Exact graph resolutions and explicit Vite
        // aliases above still fail closed when their metadata is missing.
      }
    }

    if (resolvedSource) {
      const resolvedMetadata = lookupStoredMetadata(resolvedSource)
      if (resolvedMetadata) return resolvedMetadata
      if (shouldTransform(resolvedSource, transformFilter)) {
        throw new Error(
          `[fict] Local module metadata for "${source}" imported by "${importerFile}" ` +
            `was not prepared (${resolvedSource}).`,
        )
      }
    }

    return resolvePackageModuleMetadata(source, importerFile, {
      ...compilerOptions,
      moduleMetadata,
    })
  }

  const createCompilerOptions = async (
    code: string,
    normalizedFilename: string,
  ): Promise<{ fictOptions: FictCompilerOptions; project: TypeScriptProject | null }> => {
    const fictOptions: FictCompilerOptions = {
      ...compilerOptions,
      dev: compilerOptions.dev ?? isDev,
      sourcemap: compilerOptions.sourcemap ?? true,
      filename: normalizedFilename,
      moduleMetadata,
      resolveModuleMetadata: resolveCompilerModuleMetadata,
    }

    const project = await ensureTypeScriptProject()
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
    return { fictOptions, project }
  }

  const resolveGraphDependency = async (
    context: MetadataResolveContext,
    source: string,
    importer: string,
  ): Promise<string | null> => {
    if (hasModuleRequestSuffix(source)) return null
    if (context.resolve) {
      const resolved = await context.resolve(source, importer, { skipSelf: true })
      if (resolved && !resolved.external && !isInternalModuleId(resolved.id)) {
        const resolvedFile = resolveExistingModuleFile(stripQuery(resolved.id))
        if (resolvedFile) return normalizeFileName(resolvedFile, config?.root)
      }
    }
    return resolveLocalModuleSource(
      source,
      importer,
      config?.root,
      normalizeAliases(config?.resolve?.alias),
    )
  }

  const discoverMetadataGraph = async (
    context: MetadataResolveContext,
    rootCode: string,
    rootFilename: string,
  ): Promise<Map<string, MetadataGraphNode>> => {
    const nodes = new Map<string, MetadataGraphNode>()
    const discovered = new Set<string>()

    const visit = async (filename: string, suppliedCode?: string): Promise<void> => {
      const normalizedFilename = normalizeFileName(filename, config?.root)
      if (discovered.has(normalizedFilename)) return
      discovered.add(normalizedFilename)

      const code = suppliedCode ?? (await fs.readFile(normalizedFilename, 'utf8'))
      const node: MetadataGraphNode = {
        filename: normalizedFilename,
        code,
        dependencies: new Set(),
      }
      nodes.set(normalizedFilename, node)

      for (const source of collectStaticModuleSources(code)) {
        const resolved = await resolveGraphDependency(context, source, normalizedFilename)
        if (!resolved || !shouldTransform(resolved, transformFilter)) continue
        resolvedLocalModules.set(createLocalResolutionKey(normalizedFilename, source), resolved)
        node.dependencies.add(resolved)
        await visit(resolved)
      }
    }

    await visit(rootFilename, rootCode)
    return nodes
  }

  const getPreparationKey = async (
    node: MetadataGraphNode,
  ): Promise<{
    key: string
    fictOptions: FictCompilerOptions
  }> => {
    const { fictOptions, project } = await createCompilerOptions(node.code, node.filename)
    const dependencyFingerprint = computePackageMetadataCacheFingerprint(
      node.code,
      node.filename,
      compilerOptions,
      moduleMetadata,
      config?.root,
      normalizeAliases(config?.resolve?.alias),
      new Set(),
      resolvedLocalModules,
    )
    return {
      key: buildMetadataPreparationKey(
        node.filename,
        node.code,
        fictOptions,
        project,
        dependencyFingerprint,
      ),
      fictOptions,
    }
  }

  const compileMetadataNode = async (
    node: MetadataGraphNode,
    fictOptions: FictCompilerOptions,
  ): Promise<Omit<PreparedCompilerTransform, 'preparationKey'>> => {
    const compiled = await compileFictCompilerStage(node.code, node.filename, fictOptions)
    const generatedMetadata = moduleMetadata.get(node.filename)
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
    graph: Map<string, MetadataGraphNode>,
    rootFilename: string,
  ): Promise<void> => {
    for (const component of getStronglyConnectedMetadataComponents(graph)) {
      const sortedComponent = [...component].sort()
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
      }[] = []
      // TypeScriptProject is a shared mutable language-service snapshot. Prepare
      // candidate keys deterministically so updateFile/getProgram never race.
      for (const filename of sortedComponent) {
        const node = graph.get(filename)!
        const preparation = await getPreparationKey(node)
        preparedCandidates.push({
          filename,
          prepared: preparedCompilerTransforms.get(filename),
          ...preparation,
        })
      }
      if (
        preparedCandidates.every(candidate => candidate.prepared?.preparationKey === candidate.key)
      ) {
        for (const candidate of preparedCandidates) {
          moduleMetadata.set(candidate.filename, candidate.prepared!.moduleMetadata)
        }
        continue
      }

      if (!hasCycle) {
        const filename = sortedComponent[0]!
        const node = graph.get(filename)!
        const { fictOptions } = await getPreparationKey(node)
        const compiled = await compileMetadataNode(node, fictOptions)
        const { key } = await getPreparationKey(node)
        preparedCompilerTransforms.set(filename, { ...compiled, preparationKey: key })
        continue
      }

      for (const filename of sortedComponent) {
        if (!moduleMetadata.has(filename)) {
          moduleMetadata.set(filename, createEmptyModuleMetadata())
        }
      }

      let latestResults = new Map<string, Omit<PreparedCompilerTransform, 'preparationKey'>>()
      let converged = false
      const maxPasses = Math.max(8, sortedComponent.length * 4)
      for (let pass = 0; pass < maxPasses; pass++) {
        const before = stableStringify(
          sortedComponent.map(filename => [filename, moduleMetadata.get(filename)]),
        )
        const passResults = new Map<string, Omit<PreparedCompilerTransform, 'preparationKey'>>()
        for (const filename of sortedComponent) {
          const node = graph.get(filename)!
          const { fictOptions } = await getPreparationKey(node)
          passResults.set(filename, await compileMetadataNode(node, fictOptions))
        }
        latestResults = passResults
        const after = stableStringify(
          sortedComponent.map(filename => [filename, moduleMetadata.get(filename)]),
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
        const { key } = await getPreparationKey(node)
        preparedCompilerTransforms.set(filename, { ...result, preparationKey: key })
      }
    }
  }

  const prepareReachableMetadata = async (
    context: MetadataResolveContext,
    code: string,
    filename: string,
  ): Promise<void> => {
    const prepare = metadataPreparationQueue.then(async () => {
      const graph = await discoverMetadataGraph(context, code, filename)
      await prepareMetadataGraph(graph, filename)
    })
    metadataPreparationQueue = prepare.then(
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
      isDev = config.command === 'serve' || config.mode === 'development'
      // Rebuild cache with resolved config so cacheDir is available
      resetCache()
      // Reset transform-only state from previous builds.
      resetTransformState()
    },

    buildStart() {
      // Vite can reuse plugin instances across watch rebuilds.
      // Reset per-build metadata to avoid unbounded growth.
      resetTransformState()
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

      const handlerId = id.slice(VIRTUAL_HANDLER_PREFIX.length)
      debugLog(`Loading virtual module: ${handlerId}`, {
        registrySize: extractedHandlers.size,
        handlers: Array.from(extractedHandlers.keys()),
      })
      const handler = extractedHandlers.get(handlerId) ?? manuallyRegisteredHandlers.get(handlerId)
      if (!handler) {
        debugLog(`Virtual module not found: ${handlerId}`, {
          registrySize: extractedHandlers.size,
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

      const include = new Set(userOptimize?.include ?? [])
      const exclude = new Set(userOptimize?.exclude ?? [])
      const dedupe = new Set((userConfig.resolve?.dedupe ?? []) as string[])

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
      for (const dep of workspaceDeps) {
        include.delete(dep)
        exclude.add(dep)
      }
      // Only dedupe core runtime packages to avoid duplicate instances
      const dedupePackages = [
        'fict',
        'fict/internal',
        '@fictjs/runtime',
        '@fictjs/runtime/internal',
      ]
      for (const dep of dedupePackages) {
        dedupe.add(dep)
      }

      // Determine if we're in dev mode based on command or mode
      const devMode = env.command === 'serve' || env.mode === 'development'

      return {
        // Define __DEV__ for runtime devtools support
        // In dev mode, enable devtools; in production, disable them for smaller bundles
        define: {
          __DEV__: String(devMode),
          ...(userConfig.define ?? {}),
        },
        esbuild: {
          // Disable esbuild JSX handling for .tsx/.jsx files
          // Our plugin will handle the full transformation
          include: /\.(ts|js|mts|mjs|cjs)$/,
        },
        build: {
          rollupOptions: {
            // Preserve exports in entry chunks to prevent tree-shaking of handler exports
            preserveEntrySignatures: 'exports-only',
          },
        },
        resolve: {
          ...(userConfig.resolve ?? {}),
          dedupe: Array.from(dedupe),
        },
        // Watch workspace packages dist directories for changes in dev mode
        // This ensures HMR picks up rebuilt packages without needing to restart
        server: {
          watch: {
            ignored: ['!**/node_modules/@fictjs/**', '!**/node_modules/fict/**'],
          },
        },
        ...(hasDisabledOptimize
          ? { optimizeDeps: userOptimize }
          : {
              optimizeDeps: hasUserOptimize
                ? { ...userOptimize, include: Array.from(include), exclude: Array.from(exclude) }
                : { exclude: workspaceDeps },
            }),
      }
    },

    async transform(code: string, id: string): Promise<TransformResult | null> {
      const filename = stripQuery(id)

      // Skip non-matching files
      if (!shouldTransform(filename, transformFilter)) {
        return null
      }

      const normalizedFilename = normalizeFileName(filename, config?.root)
      try {
        const precompiledInput = isPrecompiledFictModule(code)
        if (!precompiledInput) {
          await prepareReachableMetadata(this as MetadataResolveContext, code, normalizedFilename)
        }
        const { fictOptions, project: tsProject } = await createCompilerOptions(
          code,
          normalizedFilename,
        )
        const aliasEntries = normalizeAliases(config?.resolve?.alias)
        const dependencyFingerprint = computePackageMetadataCacheFingerprint(
          code,
          normalizedFilename,
          compilerOptions,
          moduleMetadata,
          config?.root,
          aliasEntries,
          new Set(),
          resolvedLocalModules,
        )
        const cacheStore = ensureCache()
        const shouldSplit =
          options.functionSplitting ??
          (config?.command === 'build' && (compilerOptions.resumable || !config?.build?.ssr))
        const cacheKey = cacheStore.enabled
          ? buildCacheKey(
              filename,
              code,
              fictOptions,
              tsProject,
              shouldSplit,
              dependencyFingerprint,
            )
          : null

        if (cacheKey) {
          const cached = await cacheStore.get(cacheKey)
          if (cached) {
            if (shouldSplit && cached.extractedHandlers?.length) {
              for (const handler of cached.extractedHandlers) {
                const handlerId = createHandlerId(handler.sourceModule, handler.exportName)
                extractedHandlers.set(handlerId, handler)
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
              moduleMetadata.set(normalizedFilename, cached.moduleMetadata)
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
            dependencyFingerprint,
          )
          const prepared = preparedCompilerTransforms.get(normalizedFilename)
          let result: { code: string; map: TransformResult['map'] }
          if (prepared?.preparationKey === preparationKey) {
            result = prepared
          } else {
            result = await compileFictCompilerStage(code, normalizedFilename, fictOptions)
            const generatedMetadata = moduleMetadata.get(normalizedFilename)
            if (generatedMetadata) {
              preparedCompilerTransforms.set(normalizedFilename, {
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
              extractedHandlers,
              finalMap,
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
                const handlerId = createHandlerId(filename, handlerName)
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
          const generatedModuleMetadata = moduleMetadata.get(normalizedFilename)
          if (generatedModuleMetadata) {
            cachedTransform.moduleMetadata = generatedModuleMetadata
          }

          if (shouldSplit && splitResult?.handlers.length) {
            cachedTransform.extractedHandlers = splitResult.handlers
              .map(handlerName => extractedHandlers.get(createHandlerId(filename, handlerName)))
              .filter((handler): handler is ExtractedHandler => !!handler)
          }

          await cacheStore.set(cacheKey, cachedTransform)
        }

        return transformed
      } catch (error) {
        // Better error handling
        const message =
          error instanceof Error ? error.message : 'Unknown error during Fict transformation'

        this.error({
          message: `[fict] Transform failed for ${id}: ${message}`,
          id,
        })

        return null
      }
    },

    handleHotUpdate({ file, server }) {
      if (tsProject && file === tsProject.configPath) {
        resetTypeScriptProject()
        resetCache()
      }

      // Force full reload for transformed source files so the reactive graph is rebuilt.
      if (shouldTransform(file, transformFilter)) {
        server.ws.send({
          type: 'full-reload',
          path: '*',
        })
        return []
      }

      return undefined
    },

    generateBundle(_options, bundle) {
      if (!config || config.command !== 'build') return
      if (libraryOptions.enabled) {
        const emittedMetadataAssets = emitLibraryMetadataAssets(
          this.emitFile.bind(this),
          bundle,
          moduleMetadata,
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
      if (config.build.ssr) return

      const base = config.base ?? '/'
      const manifest: Record<string, string> = {}

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
            if (!manifest[virtualKey]) {
              manifest[virtualKey] = url
            }
            continue
          }

          // Skip other virtual modules
          if (moduleId.startsWith('\0')) continue

          const normalized = normalizeFileName(moduleId, config.root)
          if (!path.isAbsolute(normalized)) continue
          const key = pathToFileURL(normalized).href
          if (!manifest[key]) {
            manifest[key] = url
          }
        }
      }

      this.emitFile({
        type: 'asset',
        fileName: 'fict.manifest.json',
        source: JSON.stringify(manifest),
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
function shouldTransform(id: string, filter: ReturnType<typeof createFilter>): boolean {
  // Normalize path separators
  const withoutQuery = stripQuery(id)
  if (isInternalModuleId(withoutQuery) || isTypeScriptDeclarationFile(withoutQuery)) {
    return false
  }

  const normalizedId = withoutQuery.replace(/\\/g, '/')

  return filter(normalizedId)
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

/**
 * Remove Vite query parameters (e.g. ?import, ?v=123) from an id
 */
function stripQuery(id: string): string {
  const queryStart = id.indexOf('?')
  return queryStart === -1 ? id : id.slice(0, queryStart)
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
  let clean = stripQuery(id)
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
  return joinAssetPath(metadataDir || defaultDir, `${baseName}.fict.meta.json`)
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

function mergeMetadata(
  target: ModuleReactiveMetadata,
  source: ModuleReactiveMetadata | undefined,
  allowedExports: Set<string> | null,
): void {
  if (!source) return
  for (const [name, kind] of Object.entries(source.exports)) {
    if (allowedExports && !allowedExports.has(name)) continue
    target.exports[name] = kind
  }
  if (source.hooks) {
    for (const [name, info] of Object.entries(source.hooks)) {
      if (allowedExports && !allowedExports.has(name)) continue
      target.hooks ??= {}
      target.hooks[name] = info
    }
  }
}

function hasMetadata(metadata: ModuleReactiveMetadata): boolean {
  return Object.keys(metadata.exports).length > 0 || Object.keys(metadata.hooks ?? {}).length > 0
}

function buildEntryChunkMetadata(
  chunk: BundleChunkLike,
  store: Map<string, ModuleReactiveMetadata>,
  root: string,
): ModuleReactiveMetadata | null {
  const allowedExports = chunk.exports && chunk.exports.length > 0 ? new Set(chunk.exports) : null
  const metadata: ModuleReactiveMetadata = {
    version: LIBRARY_METADATA_VERSION,
    exports: {},
  }

  mergeMetadata(
    metadata,
    getStoredModuleMetadata(store, chunk.facadeModuleId, root),
    allowedExports,
  )
  for (const moduleId of Object.keys(chunk.modules ?? {})) {
    mergeMetadata(metadata, getStoredModuleMetadata(store, moduleId, root), allowedExports)
  }

  return hasMetadata(metadata) ? metadata : null
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

function normalizePackageJsonTarget(value: string): string | null {
  if (!value.startsWith('./')) return null
  return `./${value.slice(2).replace(/\\/g, '/')}`
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
      targets.push({ subpath: '.', target: pkg[field] })
    }
  }
  return targets
}

function buildFictPackageMappingResult(
  assets: Iterable<LibraryMetadataAsset>,
  pkg: Record<string, unknown>,
  packageDir: string,
  outDir: string,
): FictPackageMappingResult {
  const packageTargets = collectPackageTargets(pkg)
  const targetToSubpath = new Map<string, string>()
  for (const { subpath, target } of packageTargets) {
    const normalizedTarget = normalizePackageJsonTarget(target)
    if (normalizedTarget && !targetToSubpath.has(normalizedTarget)) {
      targetToSubpath.set(normalizedTarget, subpath)
    }
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
    const subpath = targetToSubpath.get(chunkPackagePath)
    if (subpath) {
      mappings.set(subpath, metadataPackagePath)
    } else {
      unmappedAssets.push(asset)
    }
  }

  if (packageTargets.length === 0 && mappings.size === 0 && assetList.length === 1) {
    const asset = assetList[0]
    if (asset) {
      mappings.set(
        '.',
        toPackageJsonRelativePath(packageDir, path.resolve(outDir, asset.metadataFileName)),
      )
      return { mappings, unmappedAssets: [] }
    }
  }

  const mappedMetadataPaths = new Set(mappings.values())
  return {
    mappings,
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

  if (mappings.size === 1 && mappings.has('.')) {
    existingFict.metadata = mappings.get('.')
    delete existingFict.exports
  } else {
    existingFict.exports = Object.fromEntries(
      Array.from(mappings.entries()).sort(([a], [b]) => a.localeCompare(b)),
    )
    delete existingFict.metadata
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
  const { mappings, unmappedAssets } = buildFictPackageMappingResult(
    assets.values(),
    pkg,
    path.dirname(packageJsonPath),
    options.outDir,
  )
  if (mappings.size === 0) {
    const message =
      '[fict] Library metadata was emitted, but no package.json exports/module/main target matched the generated entry chunks. ' +
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

function hasModuleRequestSuffix(source: string): boolean {
  return source.includes('?') || source.includes('#')
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

async function compileFictCompilerStage(
  code: string,
  filename: string,
  fictOptions: FictCompilerOptions,
): Promise<{ code: string; map: TransformResult['map'] }> {
  const isTypeScript = TYPESCRIPT_EXTENSIONS.some(extension => filename.endsWith(extension))
  const isTSX = filename.endsWith('.tsx')
  const isExplicitModuleTypeScript = filename.endsWith('.mts') || filename.endsWith('.cts')
  const plugins: PluginItem[] = []
  if (isTypeScript) {
    plugins.push([
      transformTypeScript,
      {
        isTSX,
        allExtensions: true,
        allowDeclareFields: true,
        allowNamespaces: true,
        disallowAmbiguousJSXLike: isExplicitModuleTypeScript,
      },
    ])
  }
  plugins.push(['@babel/plugin-syntax-jsx', {}], [createFictPlugin, fictOptions])
  const result = await transformAsync(code, {
    filename,
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
      plugins: ['jsx', 'typescript'],
    })
  } catch {
    return []
  }

  const sources = new Set<string>()
  for (const node of ast.program.body) {
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
  if (path.isAbsolute(source)) return resolveExistingModuleFile(source)
  if (source.startsWith('.')) {
    return resolveExistingModuleFile(path.resolve(path.dirname(importerFile), source))
  }

  const aliased = applyAlias(source, aliases)
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
): string {
  const normalizedFilename = normalizeFileName(filename, root)
  if (visited.has(normalizedFilename)) return '[]'
  visited.add(normalizedFilename)

  const entries: [string, string | null, string?][] = []
  for (const source of collectStaticModuleSources(code)) {
    const userMetadata = compilerOptions.resolveModuleMetadata?.(source, normalizedFilename)
    if (userMetadata) {
      entries.push([source, stableStringify(userMetadata), 'custom-resolver'])
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
    if (isBarePackageSource(source)) {
      const metadata = resolvePackageModuleMetadata(source, normalizedFilename, {
        ...compilerOptions,
        moduleMetadata,
      })
      entries.push([source, metadata ? stableStringify(metadata) : null])
    }
  }
  return stableStringify(entries)
}

export const __fictVitePluginInternals = {
  computePackageMetadataCacheFingerprint,
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
    return path.resolve(rootDir, explicitPath)
  }
  return ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json') ?? null
}

async function createTypeScriptProject(
  ts: TypeScriptApi,
  rootDir: string,
  configPath: string,
): Promise<TypeScriptProject | null> {
  const configText = ts.sys.readFile(configPath)
  if (!configText) return null
  const configHash = hashString(configText)

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) return null

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))

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
    configPath,
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
 * Uses $$ as separator to avoid conflicts with URL # fragments.
 */
function createHandlerId(sourceModule: string, exportName: string): string {
  return `${sourceModule}$$${exportName}`
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
    return `export { ${handler.exportName} as default } from '${handler.sourceModule}';\n`
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
    imports.push(`import { ${depImports.join(', ')} } from '${handler.sourceModule}';`)
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
): string {
  const hash = hashString(`${sourceModule}:${localName}`).slice(0, 8)
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
): { code: string; handlers: string[]; map: TransformResult['map'] } | null {
  let ast: ReturnType<typeof parse>

  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
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
              )
              dependencyExportNames.set(localName, exportName)
            }
            return { localName, exportName }
          })

          // Register the handler with its full code
          const handlerId = createHandlerId(sourceModule, name)
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
            exportName = createHandlerDependencyExportName(sourceModule, localName, usedExportNames)
            dependencyExportNames.set(localName, exportName)
          }
          return { localName, exportName }
        })

        // Register the handler with its full code
        const handlerId = createHandlerId(sourceModule, name)
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
      }
    },

    CallExpression(path) {
      // Rewrite __fictQrl(import.meta.url, "__fict_e0") -> "virtual:..."
      if (!t.isIdentifier(path.node.callee, { name: '__fictQrl' })) return
      if (path.node.arguments.length !== 2) return

      const secondArg = path.node.arguments[1]
      if (!t.isStringLiteral(secondArg)) return

      const handlerName = secondArg.value
      if (!handlerNames.includes(handlerName)) return

      // Replace with the virtual module URL
      const handlerId = createHandlerId(sourceModule, handlerName)
      const virtualUrl = `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}#default`
      path.replaceWith(t.stringLiteral(virtualUrl))
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
