import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { transformAsync } from '@babel/core'
import _generate from '@babel/generator'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

// Handle ESM/CJS interop for Babel packages
const traverse = (
  typeof _traverse === 'function' ? _traverse : (_traverse as { default: typeof _traverse }).default
) as typeof _traverse
const generate = (
  typeof _generate === 'function' ? _generate : (_generate as { default: typeof _generate }).default
) as typeof _generate
import { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
import type { Plugin, ResolvedConfig, TransformResult } from 'vite'

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
}

interface NormalizedCacheOptions {
  enabled: boolean
  persistent: boolean
  dir?: string
}

interface CachedTransform {
  code: string
  map: TransformResult['map']
}

interface TypeScriptProject {
  configPath: string
  configHash: string
  readonly projectVersion: number
  updateFile: (fileName: string, code: string) => void
  getProgram: () => unknown | null
  resolveModuleName: (specifier: string, containingFile: string) => string | null
  dispose: () => void
}

const CACHE_VERSION = 1
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

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
  helpersUsed: string[]
  /** The handler function code (without export) */
  code: string
}

/**
 * Registry for extracted handlers during compilation
 */
const extractedHandlers = new Map<string, ExtractedHandler>()

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
    include = ['**/*.tsx', '**/*.jsx'],
    exclude = ['**/node_modules/**'],
    cache: cacheOption,
    tsconfigPath,
    useTypeScriptProject = true,
    ...compilerOptions
  } = options

  let config: ResolvedConfig | undefined
  let isDev = false
  let cache: TransformCache | null = null
  let tsProject: TypeScriptProject | null = null
  let tsProjectInit: Promise<TypeScriptProject | null> | null = null
  const moduleMetadata: FictCompilerOptions['moduleMetadata'] = new Map()

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

  return {
    name: 'vite-plugin-fict',

    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig
      isDev = config.command === 'serve' || config.mode === 'development'
      // Rebuild cache with resolved config so cacheDir is available
      resetCache()
      // Clear extracted handlers from previous builds
      extractedHandlers.clear()
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
      console.log(`[fict-plugin] Loading virtual module: ${handlerId}`)
      console.log(
        `[fict-plugin] Registry has ${extractedHandlers.size} handlers:`,
        Array.from(extractedHandlers.keys()),
      )
      const handler = extractedHandlers.get(handlerId)
      if (handler) {
        const generatedCode = generateHandlerModule(handler)
        console.log(`[fict-plugin] Generated code length: ${generatedCode.length}`)
        console.log(`[fict-plugin] Generated code preview: ${generatedCode.slice(0, 200)}...`)
        return generatedCode
      }

      if (!handler) {
        // In dev mode or when splitting is disabled, the handler is still in the main module
        // Generate a re-export from the source module
        const [sourceModule, exportName] = parseHandlerId(handlerId)
        if (sourceModule && exportName) {
          return `export { ${exportName} as default } from '${sourceModule}'`
        }
        return null
      }

      // Generate the virtual module with the handler code
      return generateHandlerModule(handler)
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
      const dedupePackages = ['fict', '@fictjs/runtime', '@fictjs/runtime/internal']
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
      if (!shouldTransform(filename, include, exclude)) {
        return null
      }

      const aliasEntries = normalizeAliases(config?.resolve?.alias)
      const fictOptions: FictCompilerOptions = {
        ...compilerOptions,
        dev: compilerOptions.dev ?? isDev,
        sourcemap: compilerOptions.sourcemap ?? true,
        filename,
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

          if (!resolvedSource) return undefined
          return lookupMetadata(resolvedSource)
        },
      }

      const tsProject = await ensureTypeScriptProject()
      if (tsProject) {
        const resolvedName = normalizeFileName(filename, config?.root)
        tsProject.updateFile(resolvedName, code)
        const program = tsProject.getProgram()
        const checker =
          program && typeof (program as any).getTypeChecker === 'function'
            ? (program as any).getTypeChecker()
            : undefined
        fictOptions.typescript = {
          program: program ?? undefined,
          checker,
          projectVersion: tsProject.projectVersion,
          configPath: tsProject.configPath,
        }
      }

      const cacheStore = ensureCache()
      const cacheKey = cacheStore.enabled
        ? buildCacheKey(filename, code, fictOptions, tsProject)
        : null

      if (cacheKey) {
        const cached = await cacheStore.get(cacheKey)
        if (cached) {
          return cached
        }
      }

      try {
        const isTypeScript = filename.endsWith('.tsx') || filename.endsWith('.ts')

        const result = await transformAsync(code, {
          filename,
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

        let finalCode = result.code
        let finalMap = result.map as TransformResult['map']

        // Apply function-level code splitting in production builds
        // For SSR builds with resumable enabled, we also need to rewrite QRLs to virtual URLs
        // so they match the manifest generated by the client build
        const shouldSplit =
          options.functionSplitting ??
          (config?.command === 'build' && (compilerOptions.resumable || !config?.build?.ssr))

        console.log(
          `[fict-plugin] shouldSplit=${shouldSplit}, ssr=${config?.build?.ssr}, resumable=${compilerOptions.resumable}, file=${filename}`,
        )
        if (shouldSplit) {
          const splitResult = extractAndRewriteHandlers(finalCode, filename)
          console.log(
            `[fict-plugin] splitResult: ${splitResult ? splitResult.handlers.length + ' handlers' : 'null'}`,
          )
          if (splitResult) {
            console.log(
              `[fict-plugin] Function splitting: ${filename} - ${splitResult.handlers.length} handlers extracted`,
            )
            finalCode = splitResult.code
            // Note: source maps are invalidated by this rewrite
            // For production builds, this is acceptable
            finalMap = null

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
          await cacheStore.set(cacheKey, transformed)
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
      if (shouldTransform(file, include, exclude)) {
        server.ws.send({
          type: 'full-reload',
          path: '*',
        })
      }
    },

    generateBundle(_options, bundle) {
      if (!config || config.command !== 'build') return
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
  }
}

/**
 * Check if a file should be transformed based on include/exclude patterns
 */
function shouldTransform(id: string, include: string[], exclude: string[]): boolean {
  // Normalize path separators
  const normalizedId = stripQuery(id).replace(/\\/g, '/')

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
): string {
  const codeHash = hashString(code)
  const optionsHash = hashString(stableStringify(normalizeOptionsForCache(options)))
  const tsKey = tsProject ? `${tsProject.configHash}:${tsProject.projectVersion}` : ''
  return hashString([CACHE_VERSION, filename, codeHash, optionsHash, tsKey].join('|'))
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

async function loadTypeScript(): Promise<any | null> {
  try {
    const mod = await import('typescript')
    return (mod as any).default ?? mod
  } catch {
    return null
  }
}

function resolveTsconfigPath(ts: any, rootDir: string, explicitPath?: string): string | null {
  if (explicitPath) {
    return path.resolve(rootDir, explicitPath)
  }
  return ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json') ?? null
}

async function createTypeScriptProject(
  ts: any,
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

  const serviceHost = {
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
 * Parse a handler ID into source module and export name.
 * Format: /path/to/module.tsx$$exportName (using $$ as separator to avoid URL fragment conflicts)
 */
function parseHandlerId(handlerId: string): [string | null, string | null] {
  const separatorIndex = handlerId.lastIndexOf('$$')
  if (separatorIndex === -1) {
    return [handlerId, 'default']
  }
  return [handlerId.slice(0, separatorIndex), handlerId.slice(separatorIndex + 2)]
}

/**
 * Generate handler ID from source module and export name.
 * Uses $$ as separator to avoid conflicts with URL # fragments.
 */
function createHandlerId(sourceModule: string, exportName: string): string {
  return `${sourceModule}$$${exportName}`
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

  for (const helperName of handler.helpersUsed) {
    const helper = RUNTIME_HELPERS[helperName]
    if (!helper) continue

    const existing = importsByModule.get(helper.from) ?? []
    if (!existing.includes(helper.import)) {
      existing.push(helper.import)
    }
    importsByModule.set(helper.from, existing)
  }

  // Generate import statements
  const imports: string[] = []
  for (const [module, names] of importsByModule) {
    imports.push(`import { ${names.join(', ')} } from '${module}';`)
  }

  // Generate the complete standalone module
  return `${imports.join('\n')}${imports.length > 0 ? '\n\n' : ''}export default ${handler.code};\n`
}

/**
 * Register an extracted handler for function-level splitting.
 */
export function registerExtractedHandler(
  sourceModule: string,
  exportName: string,
  helpersUsed: string[],
  code: string,
): string {
  const handlerId = createHandlerId(sourceModule, exportName)
  extractedHandlers.set(handlerId, {
    sourceModule,
    exportName,
    helpersUsed,
    code,
  })
  return `${VIRTUAL_HANDLER_RESOLVE_PREFIX}${handlerId}`
}

/**
 * Runtime helper name mappings for generating imports in virtual modules
 */
const RUNTIME_HELPERS: Record<string, { import: string; from: string }> = {
  __fictUseLexicalScope: { import: '__fictUseLexicalScope', from: '@fictjs/runtime/internal' },
  __fictGetScopeProps: { import: '__fictGetScopeProps', from: '@fictjs/runtime/internal' },
  __fictGetSSRScope: { import: '__fictGetSSRScope', from: '@fictjs/runtime/internal' },
  __fictEnsureScope: { import: '__fictEnsureScope', from: '@fictjs/runtime/internal' },
  __fictPrepareContext: { import: '__fictPrepareContext', from: '@fictjs/runtime/internal' },
  __fictPushContext: { import: '__fictPushContext', from: '@fictjs/runtime/internal' },
  __fictPopContext: { import: '__fictPopContext', from: '@fictjs/runtime/internal' },
  hydrateComponent: { import: 'hydrateComponent', from: '@fictjs/runtime/internal' },
  __fictQrl: { import: '__fictQrl', from: '@fictjs/runtime/internal' },
}

/**
 * Extract handlers using Babel AST and rewrite QRLs to use virtual modules.
 * This creates truly independent chunks for each handler.
 */
function extractAndRewriteHandlers(
  code: string,
  sourceModule: string,
): { code: string; handlers: string[] } | null {
  let ast: ReturnType<typeof parse>

  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
  } catch {
    // If parsing fails, fall back to no extraction
    return null
  }

  const handlerNames: string[] = []
  const nodesToRemove = new Set<t.Node>()

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
          const helpersUsed: string[] = []
          for (const helperName of Object.keys(RUNTIME_HELPERS)) {
            if (handlerCode.includes(helperName)) {
              helpersUsed.push(helperName)
            }
          }

          // Register the handler with its full code
          const handlerId = createHandlerId(sourceModule, name)
          extractedHandlers.set(handlerId, {
            sourceModule,
            exportName: name,
            helpersUsed,
            code: handlerCode,
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
        const helpersUsed: string[] = []
        for (const helperName of Object.keys(RUNTIME_HELPERS)) {
          if (handlerCode.includes(helperName)) {
            helpersUsed.push(helperName)
          }
        }

        // Register the handler with its full code
        const handlerId = createHandlerId(sourceModule, name)
        extractedHandlers.set(handlerId, {
          sourceModule,
          exportName: name,
          helpersUsed,
          code: handlerCode,
        })

        // Mark this export for removal
        nodesToRemove.add(path.node)
      }
    },
  })

  if (handlerNames.length === 0) {
    return null
  }

  // Second pass: remove handler exports and rewrite QRL calls
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

  // Generate the modified code
  const result = generate(ast, {
    retainLines: true,
    compact: false,
  })

  return { code: result.code, handlers: handlerNames }
}
