import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { transformAsync } from '@babel/core'
import _generate from '@babel/generator'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'
import {
  COMPILER_CACHE_FINGERPRINT,
  createFictPlugin,
  resolvePackageModuleMetadata,
  type FictCompilerOptions,
  type ModuleReactiveMetadata,
} from '@fictjs/compiler'
import type { Plugin, ResolvedConfig, TransformResult } from 'vite'

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
  inputSourceMap?: TransformResult['map']
}

export interface FictPluginOptions extends FictCompilerOptions {
  /**
   * File patterns to include for transformation.
   * @default ['**\/*.tsx', '**\/*.jsx']
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
   * Library mode expands the default transform include list to non-JSX source files
   * and emits package-consumable Fict metadata assets for public entry chunks.
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
  dir?: string
}

interface CachedTransform {
  code: string
  map: TransformResult['map']
  extractedHandlers?: ExtractedHandler[]
  moduleMetadata?: ModuleReactiveMetadata
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
const VITE_PLUGIN_CACHE_FINGERPRINT = createVitePluginCacheFingerprint([
  String(extractAndRewriteHandlers),
])
const TRANSFORM_CACHE_FINGERPRINT = hashString(
  [getCompilerCacheFingerprint(), VITE_PLUGIN_CACHE_FINGERPRINT].join('|'),
)
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_APP_INCLUDE = ['**/*.tsx', '**/*.jsx']
const DEFAULT_LIBRARY_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']
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
  localDeps: string[]
  /** The handler function code (without export) */
  code: string
  /** Which runtime package family this module uses for helper imports */
  runtimeImportFamily: 'fict' | 'runtime'
}

type RuntimeHelperUsage = string | { helperName: string; localName: string }

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

  let config: ResolvedConfig | undefined
  let isDev = false
  let cache: TransformCache | null = null
  let tsProject: TypeScriptProject | null = null
  let tsProjectInit: Promise<TypeScriptProject | null> | null = null
  const moduleMetadata: FictCompilerOptions['moduleMetadata'] = new Map()
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
    extractedHandlers.clear()
    libraryMetadataAssets.clear()
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
      if (!shouldTransform(filename, includePatterns, exclude)) {
        return null
      }

      const normalizedFilename = normalizeFileName(filename, config?.root)
      const aliasEntries = normalizeAliases(config?.resolve?.alias)
      const fictOptions: FictCompilerOptions = {
        ...compilerOptions,
        dev: compilerOptions.dev ?? isDev,
        sourcemap: compilerOptions.sourcemap ?? true,
        filename: normalizedFilename,
        moduleMetadata,
        resolveModuleMetadata: (source, importer) => {
          const userResolved = compilerOptions.resolveModuleMetadata?.(source, importer)
          if (userResolved) return userResolved
          if (!importer) return undefined

          const importerFile = normalizeFileName(importer, config?.root)
          const lookupMetadata = (resolved: string) => {
            const direct = moduleMetadata.get(resolved)
            if (direct) return direct
            const ext = path.extname(resolved)
            if (!ext) {
              for (const suffix of MODULE_EXTENSIONS) {
                const byExt = moduleMetadata.get(`${resolved}${suffix}`)
                if (byExt) return byExt
              }
              for (const suffix of MODULE_EXTENSIONS) {
                const byIndex = moduleMetadata.get(path.join(resolved, `index${suffix}`))
                if (byIndex) return byIndex
              }
            }
            return undefined
          }
          let resolvedSource: string | null = null

          if (path.isAbsolute(source)) {
            resolvedSource = normalizeFileName(source, config?.root)
          } else if (source.startsWith('.')) {
            resolvedSource = normalizeFileName(
              path.resolve(path.dirname(importerFile), source),
              config?.root,
            )
          } else {
            const aliased = applyAlias(source, aliasEntries)
            if (aliased) {
              if (path.isAbsolute(aliased)) {
                resolvedSource = normalizeFileName(aliased, config?.root)
              } else if (aliased.startsWith('.')) {
                resolvedSource = normalizeFileName(
                  path.resolve(path.dirname(importerFile), aliased),
                  config?.root,
                )
              } else if (config?.root) {
                resolvedSource = normalizeFileName(path.resolve(config.root, aliased), config?.root)
              }
            } else if (tsProject) {
              const tsResolved = tsProject.resolveModuleName(source, importerFile)
              if (tsResolved) {
                resolvedSource = normalizeFileName(tsResolved, config?.root)
              }
            }
          }

          if (resolvedSource) {
            const resolvedMetadata = lookupMetadata(resolvedSource)
            if (resolvedMetadata) return resolvedMetadata
          }

          return resolvePackageModuleMetadata(source, importerFile, {
            ...compilerOptions,
            moduleMetadata,
          })
        },
      }

      const tsProject = await ensureTypeScriptProject()
      if (tsProject) {
        tsProject.updateFile(normalizedFilename, code)
        const program = tsProject.getProgram()
        const checker =
          program && typeof program.getTypeChecker === 'function'
            ? program.getTypeChecker()
            : undefined
        fictOptions.typescript = {
          program: program ?? undefined,
          checker,
          projectVersion: tsProject.projectVersion,
          configPath: tsProject.configPath,
        }
      }

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
            computePackageMetadataCacheFingerprint(
              code,
              normalizedFilename,
              compilerOptions,
              moduleMetadata,
              config?.root,
              aliasEntries,
            ),
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

      try {
        const precompiledInput = isPrecompiledFictModule(code)
        let finalCode: string
        let finalMap: TransformResult['map']
        let splitResult: { code: string; handlers: string[]; map: TransformResult['map'] } | null =
          null

        if (precompiledInput) {
          finalCode = code
          finalMap = null
        } else {
          const isTypeScript = filename.endsWith('.tsx') || filename.endsWith('.ts')

          const result = await transformAsync(code, {
            filename: normalizedFilename,
            sourceMaps: fictOptions.sourcemap,
            sourceFileName: filename,
            presets: isTypeScript
              ? [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]]
              : [],
            plugins: [
              ['@babel/plugin-syntax-jsx', {}],
              [createFictPlugin, fictOptions],
            ],
          })

          if (!result || !result.code) {
            return null
          }

          finalCode = result.code
          finalMap = result.map as TransformResult['map']
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

      // Force full reload for .tsx/.jsx files to ensure reactive graph is rebuilt
      if (shouldTransform(file, includePatterns, exclude)) {
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
function shouldTransform(id: string, include: string[], exclude: string[]): boolean {
  // Normalize path separators
  const withoutQuery = stripQuery(id)
  if (isInternalModuleId(withoutQuery)) {
    return false
  }

  const normalizedId = withoutQuery.replace(/\\/g, '/')

  // Check exclude patterns first
  for (const pattern of exclude) {
    if (matchPattern(normalizedId, pattern)) {
      return false
    }
  }

  // Check include patterns
  for (const pattern of include) {
    if (matchPattern(normalizedId, pattern)) {
      return true
    }
  }

  return false
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
 * Simple glob pattern matching
 * Supports: **\/*.ext, *.ext, exact matches
 */
function matchPattern(id: string, pattern: string): boolean {
  // Exact match
  if (id === pattern) return true

  // Simple check: if pattern ends with extension like *.tsx, just check if file ends with it
  if (pattern.startsWith('**/') || pattern.startsWith('*')) {
    const ext = pattern.replace(/^\*\*?\//, '')
    if (ext.startsWith('*')) {
      // **/*.tsx -> check if ends with .tsx
      const ending = ext.replace(/^\*/, '')
      return id.endsWith(ending)
    }
  }

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*\*/g, '.*') // ** matches any path
    .replace(/\*/g, '[^/]*') // * matches any non-slash

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(id)
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
): string {
  const normalizedFilename = normalizeFileName(filename, root)
  if (visited.has(normalizedFilename)) return '[]'
  visited.add(normalizedFilename)

  const entries: [string, string | null, string?][] = []
  for (const source of collectStaticModuleSources(code)) {
    if (isBarePackageSource(source)) {
      const metadata = resolvePackageModuleMetadata(source, normalizedFilename, {
        ...compilerOptions,
        moduleMetadata,
      })
      entries.push([source, metadata ? stableStringify(metadata) : null])
      continue
    }

    const localFile = resolveLocalModuleSource(source, normalizedFilename, root, aliases)
    if (!localFile) continue
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
      )
      entries.push([
        source,
        storedMetadata ? stableStringify(storedMetadata) : null,
        `${hashString(localCode)}:${nestedFingerprint}`,
      ])
    } catch {
      entries.push([source, null, 'unreadable'])
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

function getCompilerCacheFingerprint(): string {
  return hashString(COMPILER_CACHE_FINGERPRINT)
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
      TRANSFORM_CACHE_FINGERPRINT,
      filename,
      codeHash,
      optionsHash,
      tsKey,
      shouldSplit ? 'split' : 'inline',
      packageMetadataFingerprint,
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
 * Generate a standalone virtual module for an extracted handler.
 * The module contains the complete handler code with its own imports,
 * creating a truly independent chunk that doesn't depend on the source module.
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
  // These are re-exported by the source module with __fict_dep_ prefix
  if (handler.localDeps.length > 0) {
    const depImports = handler.localDeps.map(dep => `${HANDLER_DEP_PREFIX}${dep} as ${dep}`)
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
    localDeps,
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

function isIdentifierReference(
  current: t.Identifier,
  parent: t.Node | null,
  key: string | null,
): boolean {
  if (!parent) return true
  if (t.isMemberExpression(parent) && parent.property === current && !parent.computed) return false
  if (t.isOptionalMemberExpression(parent) && parent.property === current && !parent.computed) {
    return false
  }
  if (t.isObjectProperty(parent) && parent.key === current && !parent.computed) return false
  if (t.isObjectMethod(parent) && parent.key === current && !parent.computed) return false
  if (t.isClassMethod(parent) && parent.key === current && !parent.computed) return false
  if (t.isClassPrivateMethod(parent) && parent.key === current) return false
  if (t.isVariableDeclarator(parent) && parent.id === current) return false
  if (
    (t.isFunctionDeclaration(parent) || t.isFunctionExpression(parent)) &&
    parent.id === current
  ) {
    return false
  }
  if ((t.isClassDeclaration(parent) || t.isClassExpression(parent)) && parent.id === current) {
    return false
  }
  if (key === 'params') return false
  if (t.isCatchClause(parent) && parent.param === current) return false
  if (
    t.isImportSpecifier(parent) ||
    t.isImportDefaultSpecifier(parent) ||
    t.isImportNamespaceSpecifier(parent) ||
    t.isExportSpecifier(parent)
  ) {
    return false
  }
  if (t.isLabeledStatement(parent) && parent.label === current) return false
  if ((t.isBreakStatement(parent) || t.isContinueStatement(parent)) && parent.label === current) {
    return false
  }
  return true
}

function visitChildNodes(
  current: t.Node,
  visitor: (node: t.Node, parent: t.Node, key: string) => void,
): void {
  for (const nodeKey of Object.keys(current)) {
    if (
      nodeKey === 'loc' ||
      nodeKey === 'start' ||
      nodeKey === 'end' ||
      nodeKey === 'extra' ||
      nodeKey === 'comments' ||
      nodeKey === 'leadingComments' ||
      nodeKey === 'trailingComments' ||
      nodeKey === 'innerComments'
    ) {
      continue
    }
    const child = (current as unknown as Record<string, unknown>)[nodeKey]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (
          item &&
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          typeof (item as Record<string, unknown>).type === 'string'
        ) {
          visitor(item as t.Node, current, nodeKey)
        }
      }
    } else if (
      child &&
      typeof child === 'object' &&
      child !== null &&
      'type' in child &&
      typeof (child as Record<string, unknown>).type === 'string'
    ) {
      visitor(child as t.Node, current, nodeKey)
    }
  }
}

function collectRuntimeHelperUsages(
  node: t.Node,
  runtimeHelperImports: Map<string, string>,
): RuntimeHelperUsage[] {
  const used = new Map<string, string>()
  const scopes: Array<Set<string>> = [new Set()]

  const currentScope = () => scopes[scopes.length - 1]!
  const isBound = (name: string) => scopes.some(scope => scope.has(name))
  const addPattern = (pattern: t.LVal | t.PatternLike) => {
    for (const name of collectPatternIdentifiers(pattern)) {
      currentScope().add(name)
    }
  }

  const visitNode = (
    current: t.Node | null | undefined,
    parent: t.Node | null,
    key: string | null,
  ): void => {
    if (!current || t.isImportDeclaration(current)) return

    if (t.isFunctionDeclaration(current)) {
      if (current.id) currentScope().add(current.id.name)
      const fnScope = new Set<string>()
      for (const param of current.params) {
        for (const name of collectPatternIdentifiers(param)) {
          fnScope.add(name)
        }
      }
      scopes.push(fnScope)
      visitNode(current.body, current, 'body')
      scopes.pop()
      return
    }

    if (t.isFunctionExpression(current) || t.isArrowFunctionExpression(current)) {
      const fnScope = new Set<string>()
      if (t.isFunctionExpression(current) && current.id) {
        fnScope.add(current.id.name)
      }
      for (const param of current.params) {
        for (const name of collectPatternIdentifiers(param)) {
          fnScope.add(name)
        }
      }
      scopes.push(fnScope)
      visitNode(current.body, current, 'body')
      scopes.pop()
      return
    }

    if (t.isVariableDeclarator(current)) {
      addPattern(current.id)
      visitNode(current.init, current, 'init')
      return
    }

    if (t.isClassDeclaration(current) && current.id) {
      currentScope().add(current.id.name)
    }

    if (t.isCatchClause(current)) {
      const catchScope = new Set<string>()
      if (current.param) {
        for (const name of collectPatternIdentifiers(current.param)) {
          catchScope.add(name)
        }
      }
      scopes.push(catchScope)
      visitNode(current.body, current, 'body')
      scopes.pop()
      return
    }

    if (t.isIdentifier(current)) {
      if (!isIdentifierReference(current, parent, key)) return
      if (isBound(current.name)) return

      const helperName = runtimeHelperImports.get(current.name) ?? current.name
      if (RUNTIME_HELPERS[helperName]) {
        used.set(current.name, helperName)
      }
      return
    }

    visitChildNodes(current, (child, childParent, childKey) => {
      visitNode(child, childParent, childKey)
    })
  }

  visitNode(node, null, null)

  return Array.from(used, ([localName, helperName]) =>
    localName === helperName ? helperName : { helperName, localName },
  )
}

/**
 * Collect identifiers referenced in an AST node that are not locally defined.
 * Uses simple recursive traversal instead of Babel's traverse to work on sub-nodes.
 */
function collectReferencedIdentifiers(node: t.Node, localBindings: Set<string>): Set<string> {
  const referenced = new Set<string>()

  function visitNode(
    current: t.Node | null | undefined,
    parent: t.Node | null,
    key: string | null,
  ): void {
    if (!current) return

    if (t.isIdentifier(current)) {
      const name = current.name

      // Skip if it's a property access (obj.prop) - only the object is a reference
      if (
        parent &&
        t.isMemberExpression(parent) &&
        parent.property === current &&
        !parent.computed
      ) {
        return
      }

      // Skip if it's a key in object property (non-computed)
      if (parent && t.isObjectProperty(parent) && parent.key === current && !parent.computed) {
        return
      }

      // Skip if it's a function/variable declaration name
      if (parent && t.isVariableDeclarator(parent) && parent.id === current) {
        return
      }
      if (
        parent &&
        (t.isFunctionDeclaration(parent) || t.isFunctionExpression(parent)) &&
        parent.id === current
      ) {
        return
      }

      // Skip if it's a parameter
      if (key === 'params') {
        return
      }

      // Skip if it's a catch clause parameter
      if (parent && t.isCatchClause(parent) && parent.param === current) {
        return
      }

      // Skip local bindings (locally declared variables)
      if (localBindings.has(name)) {
        return
      }

      // Skip globals
      if (GLOBAL_IDENTIFIERS.has(name)) {
        return
      }

      // Skip runtime helpers
      if (RUNTIME_HELPERS[name]) {
        return
      }

      referenced.add(name)
      return
    }

    // Recursively visit child nodes
    for (const nodeKey of Object.keys(current)) {
      // Skip metadata keys that aren't child nodes
      if (
        nodeKey === 'loc' ||
        nodeKey === 'start' ||
        nodeKey === 'end' ||
        nodeKey === 'extra' ||
        nodeKey === 'comments' ||
        nodeKey === 'leadingComments' ||
        nodeKey === 'trailingComments' ||
        nodeKey === 'innerComments'
      ) {
        continue
      }
      const child = (current as unknown as Record<string, unknown>)[nodeKey]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (
            item &&
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            typeof (item as Record<string, unknown>).type === 'string'
          ) {
            visitNode(item as t.Node, current, nodeKey)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        child !== null &&
        'type' in child &&
        typeof (child as Record<string, unknown>).type === 'string'
      ) {
        visitNode(child as t.Node, current, nodeKey)
      }
    }
  }

  visitNode(node, null, null)
  return referenced
}

/**
 * Collect all bindings (variables, functions, params) defined within an AST node.
 * Uses simple recursive traversal instead of Babel's traverse to work on sub-nodes.
 */
function collectLocalBindings(node: t.Node): Set<string> {
  const bindings = new Set<string>()

  function visitNode(current: t.Node | null | undefined): void {
    if (!current) return

    // Handle variable declarations
    if (t.isVariableDeclarator(current)) {
      if (t.isIdentifier(current.id)) {
        bindings.add(current.id.name)
      } else if (t.isObjectPattern(current.id) || t.isArrayPattern(current.id)) {
        const names = collectPatternIdentifiers(current.id)
        for (const name of names) {
          bindings.add(name)
        }
      }
    }

    // Handle function declarations
    if (t.isFunctionDeclaration(current)) {
      if (current.id) {
        bindings.add(current.id.name)
      }
      for (const param of current.params) {
        const names = collectPatternIdentifiers(param)
        for (const name of names) {
          bindings.add(name)
        }
      }
    }

    // Handle function expressions
    if (t.isFunctionExpression(current)) {
      for (const param of current.params) {
        const names = collectPatternIdentifiers(param)
        for (const name of names) {
          bindings.add(name)
        }
      }
    }

    // Handle arrow function expressions
    if (t.isArrowFunctionExpression(current)) {
      for (const param of current.params) {
        const names = collectPatternIdentifiers(param)
        for (const name of names) {
          bindings.add(name)
        }
      }
    }

    // Handle catch clauses
    if (t.isCatchClause(current)) {
      if (current.param && t.isIdentifier(current.param)) {
        bindings.add(current.param.name)
      }
    }

    // Recursively visit child nodes
    for (const nodeKey of Object.keys(current)) {
      // Skip metadata keys that aren't child nodes
      if (
        nodeKey === 'loc' ||
        nodeKey === 'start' ||
        nodeKey === 'end' ||
        nodeKey === 'extra' ||
        nodeKey === 'comments' ||
        nodeKey === 'leadingComments' ||
        nodeKey === 'trailingComments' ||
        nodeKey === 'innerComments'
      ) {
        continue
      }
      const child = (current as unknown as Record<string, unknown>)[nodeKey]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (
            item &&
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            typeof (item as Record<string, unknown>).type === 'string'
          ) {
            visitNode(item as t.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        child !== null &&
        'type' in child &&
        typeof (child as Record<string, unknown>).type === 'string'
      ) {
        visitNode(child as t.Node)
      }
    }
  }

  visitNode(node)

  return bindings
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

/**
 * Extract handlers using Babel AST and rewrite QRLs to use virtual modules.
 * This creates truly independent chunks for each handler.
 * Local dependencies are detected and re-exported for handlers to import.
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
  const importedNames = new Set<string>()
  const runtimeHelperImports = collectRuntimeHelperImports(ast.program.body)

  for (const node of ast.program.body) {
    // Collect imports
    if (t.isImportDeclaration(node)) {
      for (const specifier of node.specifiers) {
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
      continue
    }

    // Collect variable declarations
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (t.isIdentifier(declarator.id)) {
          topLevelDeclarations.add(declarator.id.name)
        }
      }
      continue
    }

    // Collect class declarations
    if (t.isClassDeclaration(node) && node.id) {
      topLevelDeclarations.add(node.id.name)
      continue
    }

    // Collect exported declarations
    if (t.isExportNamedDeclaration(node) && node.declaration) {
      if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
        topLevelDeclarations.add(node.declaration.id.name)
      } else if (t.isVariableDeclaration(node.declaration)) {
        for (const declarator of node.declaration.declarations) {
          if (t.isIdentifier(declarator.id)) {
            topLevelDeclarations.add(declarator.id.name)
          }
        }
      } else if (t.isClassDeclaration(node.declaration) && node.declaration.id) {
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
  const allLocalDeps = new Set<string>()
  const runtimeImportFamily = detectRuntimeImportFamilyFromCode(ast.program.body)

  // First pass: find all handler exports and extract their code
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const declaration = path.node.declaration

      // Handle: export const __fict_e0 = (scopeId, event, el) => { ... }
      if (t.isVariableDeclaration(declaration)) {
        for (const declarator of declaration.declarations) {
          if (!t.isIdentifier(declarator.id)) continue

          const name = declarator.id.name
          // Only extract event handlers (__fict_e*), not resume handlers (__fict_r*)
          // Resume handlers have complex component dependencies that can't be easily extracted
          if (!name.match(/^__fict_e\d+$/)) continue

          if (!declarator.init) continue

          handlerNames.push(name)

          // Generate the handler function code
          const handlerCode = generate(declarator.init).code

          // Detect which runtime helpers are used
          const helpersUsed = collectRuntimeHelperUsages(declarator.init, runtimeHelperImports)

          // Detect local dependencies
          const localBindings = collectLocalBindings(declarator.init)
          const referencedIds = collectReferencedIdentifiers(declarator.init, localBindings)
          const localDeps: string[] = []
          for (const ref of referencedIds) {
            // Only include if it's a top-level declaration (not a handler itself)
            if (
              topLevelDeclarations.has(ref) &&
              !runtimeHelperImports.has(ref) &&
              !ref.match(/^__fict_[er]\d+$/)
            ) {
              localDeps.push(ref)
              allLocalDeps.add(ref)
            }
          }

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
      if (t.isFunctionDeclaration(declaration) && declaration.id) {
        const name = declaration.id.name
        // Only extract event handlers (__fict_e*), not resume handlers (__fict_r*)
        // Resume handlers have complex component dependencies that can't be easily extracted
        if (!name.match(/^__fict_e\d+$/)) return

        handlerNames.push(name)

        // Convert to arrow function expression for the virtual module
        const params = declaration.params
        const body = declaration.body
        const arrowFn = t.arrowFunctionExpression(params, body, declaration.async)

        // Generate the handler function code
        const handlerCode = generate(arrowFn).code

        // Detect which runtime helpers are used
        const helpersUsed = collectRuntimeHelperUsages(arrowFn, runtimeHelperImports)

        // Detect local dependencies
        const localBindings = collectLocalBindings(arrowFn)
        const referencedIds = collectReferencedIdentifiers(arrowFn, localBindings)
        const localDeps: string[] = []
        for (const ref of referencedIds) {
          // Only include if it's a top-level declaration (not a handler itself)
          if (
            topLevelDeclarations.has(ref) &&
            !runtimeHelperImports.has(ref) &&
            !ref.match(/^__fict_[er]\d+$/)
          ) {
            localDeps.push(ref)
            allLocalDeps.add(ref)
          }
        }

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

  // Add re-exports for local dependencies used by handlers
  // This allows handlers to import them from the source module
  if (allLocalDeps.size > 0) {
    const reExports: t.ExportSpecifier[] = []
    for (const dep of allLocalDeps) {
      // Export as __fict_dep_<name> to avoid conflicts
      reExports.push(
        t.exportSpecifier(t.identifier(dep), t.identifier(`${HANDLER_DEP_PREFIX}${dep}`)),
      )
    }
    ast.program.body.push(t.exportNamedDeclaration(null, reExports))
  }

  // Generate the modified code
  const generatorOptions: BabelGeneratorOptionsWithInputSourceMap = {
    retainLines: true,
    compact: false,
    sourceMaps: inputSourceMap !== null,
    inputSourceMap: inputSourceMap ?? undefined,
    sourceFileName: sourceModule,
  }
  const result = generate(ast, generatorOptions)

  return { code: result.code, handlers: handlerNames, map: result.map as TransformResult['map'] }
}
