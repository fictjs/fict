import { transformAsync } from '@babel/core'
import { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
  dispose: () => void
}

const CACHE_VERSION = 1

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
    },

    config(userConfig) {
      const userOptimize = userConfig.optimizeDeps
      const hasUserOptimize = !!userOptimize
      const hasDisabledOptimize =
        hasUserOptimize && (userOptimize as { disabled?: boolean }).disabled === true

      const include = new Set(userOptimize?.include ?? [])
      const exclude = new Set(userOptimize?.exclude ?? [])
      const dedupe = new Set((userConfig.resolve?.dedupe ?? []) as string[])

      // Avoid duplicate runtime instances between pre-bundled deps and /@fs modules.
      const runtimeDeps = ['fict', '@fictjs/runtime', '@fictjs/runtime/internal']
      for (const dep of runtimeDeps) {
        include.delete(dep)
        exclude.add(dep)
        dedupe.add(dep)
      }

      return {
        esbuild: {
          // Disable esbuild JSX handling for .tsx/.jsx files
          // Our plugin will handle the full transformation
          include: /\.(ts|js|mts|mjs|cjs)$/,
        },
        resolve: {
          ...(userConfig.resolve ?? {}),
          dedupe: Array.from(dedupe),
        },
        ...(hasDisabledOptimize
          ? { optimizeDeps: userOptimize }
          : {
              optimizeDeps: hasUserOptimize
                ? { ...userOptimize, include: Array.from(include), exclude: Array.from(exclude) }
                : { exclude: runtimeDeps },
            }),
      }
    },

    async transform(code: string, id: string): Promise<TransformResult | null> {
      const filename = stripQuery(id)

      // Skip non-matching files
      if (!shouldTransform(filename, include, exclude)) {
        return null
      }

      const fictOptions: FictCompilerOptions = {
        ...compilerOptions,
        dev: compilerOptions.dev ?? isDev,
        sourcemap: compilerOptions.sourcemap ?? true,
        moduleMetadata,
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

        const transformed: TransformResult = {
          code: result.code,
          map: result.map as TransformResult['map'],
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
  const clean = stripQuery(id)
  if (path.isAbsolute(clean)) return path.normalize(clean)
  if (root) return path.normalize(path.resolve(root, clean))
  return path.normalize(path.resolve(clean))
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
    dispose: () => service.dispose?.(),
  }
}
