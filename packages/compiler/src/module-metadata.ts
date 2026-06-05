import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODULE_REACTIVE_METADATA_VERSION } from './types'
import type { FictCompilerOptions, ModuleReactiveMetadata } from './types'

const globalMetadata = new Map<string, ModuleReactiveMetadata>()
const lastWrittenMetadataPayload = new Map<string, string>()
const diskLoadedMetadataKeys = new Set<string>()
const defaultResolutionCache = new Map<string, ModuleReactiveMetadata>()
let resolutionCacheByOptions = new WeakMap<
  FictCompilerOptions,
  Map<string, ModuleReactiveMetadata>
>()

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_META_EXTENSION = '.fict.meta.json'
const DEFAULT_META_CACHE_DIR = path.join('.fict-cache', 'metadata')
const FS_PROBE_CACHE_TTL_MS = 250
const FS_PROBE_CACHE_MAX_SIZE = 50_000
const UNKNOWN_FILENAME_TOKENS = new Set(['<unknown>', 'unknown', 'stdin', '[stdin]'])
const VIRTUAL_FILENAME_PREFIXES = [
  'virtual:',
  'vite:',
  'rollup:',
  'webpack:',
  'rspack:',
  'esbuild:',
  'astro:',
  'data:',
  'http://',
  'https://',
]

type MetadataWriteMode = 'none' | 'adjacent' | 'cache'

interface FsProbeCacheEntry {
  exists: boolean
  expiresAt: number
}

type FsProbeCache = Map<string, FsProbeCacheEntry>

interface FictPackageConfig {
  metadata?: string
  exports?: Record<string, string>
}

const sharedFsProbeCache: FsProbeCache = new Map()

function shouldUseResolutionCache(options?: FictCompilerOptions): boolean {
  return !options?.resolveModuleMetadata && !options?.moduleMetadata
}

function getResolutionCache(options?: FictCompilerOptions): Map<string, ModuleReactiveMetadata> {
  if (!options) return defaultResolutionCache
  let cache = resolutionCacheByOptions.get(options)
  if (!cache) {
    cache = new Map<string, ModuleReactiveMetadata>()
    resolutionCacheByOptions.set(options, cache)
  }
  return cache
}

function clearResolutionCaches(): void {
  defaultResolutionCache.clear()
  resolutionCacheByOptions = new WeakMap<FictCompilerOptions, Map<string, ModuleReactiveMetadata>>()
}

function clearFsProbeCache(): void {
  sharedFsProbeCache.clear()
}

function canReuseStoredMetadata(key: string): boolean {
  return !diskLoadedMetadataKeys.has(key)
}

function cacheFsProbeResult(cache: FsProbeCache, pathName: string, exists: boolean): void {
  if (cache.size >= FS_PROBE_CACHE_MAX_SIZE) {
    cache.clear()
  }
  cache.set(pathName, {
    exists,
    expiresAt: Date.now() + FS_PROBE_CACHE_TTL_MS,
  })
}

function isWindowsDrivePath(fileName: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(fileName) || fileName.startsWith('\\\\')
}

function isVirtualFileName(fileName: string): boolean {
  const trimmed = fileName.trim()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  if (UNKNOWN_FILENAME_TOKENS.has(lower)) return true
  if (trimmed.startsWith('\0')) return true
  if (VIRTUAL_FILENAME_PREFIXES.some(prefix => lower.startsWith(prefix))) return true
  if (trimmed.includes('://') && !lower.startsWith('file://') && !isWindowsDrivePath(trimmed)) {
    return true
  }
  return false
}

function normalizeFileName(fileName: string): string {
  let normalized = fileName
  const queryStart = normalized.indexOf('?')
  if (queryStart !== -1) {
    normalized = normalized.slice(0, queryStart)
  }
  if (normalized.startsWith('/@fs/')) {
    normalized = normalized.slice('/@fs/'.length)
  }
  if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      // If URL parsing fails, fall back to the raw string.
    }
  }
  return path.resolve(normalized)
}

function resolveMetadataWriteMode(options?: FictCompilerOptions): MetadataWriteMode {
  const opt = options?.emitModuleMetadata
  if (opt === true) return 'adjacent'
  if (opt === false) return 'none'
  // auto: emit only when no external store/resolver is supplied
  if (options?.moduleMetadata || options?.resolveModuleMetadata) return 'none'
  return 'cache'
}

function normalizeConcreteFileName(fileName: string | undefined): string | null {
  if (!fileName || isVirtualFileName(fileName)) return null
  return normalizeFileName(fileName)
}

function getMetadataStore(options?: FictCompilerOptions): Map<string, ModuleReactiveMetadata> {
  return options?.moduleMetadata ?? globalMetadata
}

function getMetadataExtension(options?: FictCompilerOptions): string {
  return options?.moduleMetadataExtension ?? DEFAULT_META_EXTENSION
}

function getMetadataCacheDir(options?: FictCompilerOptions): string {
  if (options?.moduleMetadataCacheDir && options.moduleMetadataCacheDir.trim().length > 0) {
    return path.resolve(options.moduleMetadataCacheDir)
  }
  return path.resolve(DEFAULT_META_CACHE_DIR)
}

function getAdjacentMetadataFilePath(
  normalizedFileName: string,
  options?: FictCompilerOptions,
): string {
  return `${normalizedFileName}${getMetadataExtension(options)}`
}

function getCachedMetadataFilePath(
  normalizedFileName: string,
  options?: FictCompilerOptions,
): string {
  const cacheDir = getMetadataCacheDir(options)
  const hash = createHash('sha256').update(normalizedFileName).digest('hex')
  return path.join(cacheDir, `${hash}${getMetadataExtension(options)}`)
}

function getMetadataReadPaths(normalizedFileName: string, options?: FictCompilerOptions): string[] {
  return [
    getAdjacentMetadataFilePath(normalizedFileName, options),
    getCachedMetadataFilePath(normalizedFileName, options),
  ]
}

function getMetadataWritePath(
  normalizedFileName: string,
  writeMode: MetadataWriteMode,
  options?: FictCompilerOptions,
): string | null {
  if (writeMode === 'adjacent') {
    return getAdjacentMetadataFilePath(normalizedFileName, options)
  }
  if (writeMode === 'cache') {
    return getCachedMetadataFilePath(normalizedFileName, options)
  }
  return null
}

function warnMetadata(
  options: FictCompilerOptions | undefined,
  normalizedFileName: string | null,
  message: string,
): void {
  if (options?.dev === false) return
  const label = normalizedFileName ?? '<unknown>'
  console.warn(`[fict:metadata] ${message} (${label})`)
}

function writeMetadataAtomically(metaPath: string, payload: string): void {
  const dir = path.dirname(metaPath)
  mkdirSync(dir, { recursive: true })
  const tempPath = `${metaPath}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tempPath, payload, 'utf8')
    renameSync(tempPath, metaPath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best-effort cleanup.
    }
    throw error
  }
}

function pathIsFile(pathName: string, cache?: FsProbeCache): boolean {
  const now = Date.now()
  if (cache) {
    const cached = cache.get(pathName)
    if (cached && cached.expiresAt > now) return cached.exists
  }
  let exists: boolean
  try {
    exists = statSync(pathName).isFile()
  } catch {
    exists = false
  }
  if (cache) cacheFsProbeResult(cache, pathName, exists)
  return exists
}

function readMetadataFromDisk(
  fileName: string,
  store: Map<string, ModuleReactiveMetadata>,
  options?: FictCompilerOptions,
  fsCache?: FsProbeCache,
): ModuleReactiveMetadata | undefined {
  const normalized = normalizeConcreteFileName(fileName)
  if (!normalized) return undefined
  const paths = getMetadataReadPaths(normalized, options)
  for (const metaPath of paths) {
    if (!pathIsFile(metaPath, fsCache)) continue
    try {
      const raw = readFileSync(metaPath, 'utf8')
      const parsed = parseModuleReactiveMetadata(raw)
      if (!parsed) continue
      store.set(normalized, parsed)
      diskLoadedMetadataKeys.add(normalized)
      return parsed
    } catch {
      // Ignore malformed/partial metadata files and try the next path.
    }
  }
  if (diskLoadedMetadataKeys.has(normalized)) {
    store.delete(normalized)
    diskLoadedMetadataKeys.delete(normalized)
  }
  return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReactiveExportKind(value: unknown): value is ModuleReactiveMetadata['exports'][string] {
  return value === 'signal' || value === 'memo' || value === 'store'
}

function isHookAccessorKind(value: unknown): value is 'signal' | 'memo' {
  return value === 'signal' || value === 'memo'
}

function isHookReturnInfo(value: unknown): boolean {
  if (!isPlainObject(value)) return false

  if ('directAccessor' in value && !isHookAccessorKind(value.directAccessor)) {
    return false
  }

  if ('objectProps' in value) {
    if (!isPlainObject(value.objectProps)) return false
    if (!Object.values(value.objectProps).every(isHookAccessorKind)) return false
  }

  if ('arrayProps' in value) {
    if (!isPlainObject(value.arrayProps)) return false
    if (!Object.keys(value.arrayProps).every(key => /^\d+$/.test(key))) return false
    if (!Object.values(value.arrayProps).every(isHookAccessorKind)) return false
  }

  return true
}

function isModuleReactiveMetadata(value: unknown): value is ModuleReactiveMetadata {
  if (!isPlainObject(value)) return false
  if ('version' in value && value.version !== MODULE_REACTIVE_METADATA_VERSION) return false
  if (!isPlainObject(value.exports)) return false
  if (!Object.values(value.exports).every(isReactiveExportKind)) return false

  if ('hooks' in value) {
    if (!isPlainObject(value.hooks)) return false
    if (!Object.values(value.hooks).every(isHookReturnInfo)) return false
  }

  if ('namespaces' in value) {
    if (!isPlainObject(value.namespaces)) return false
    if (!Object.values(value.namespaces).every(isModuleReactiveMetadata)) return false
  }

  return true
}

function parseModuleReactiveMetadata(raw: string): ModuleReactiveMetadata | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isModuleReactiveMetadata(parsed)) return null
    return parsed as unknown as ModuleReactiveMetadata
  } catch {
    return null
  }
}

function isBarePackageSource(source: string): boolean {
  return !path.isAbsolute(source) && !source.startsWith('.') && !source.startsWith('/@fs/')
}

function splitPackageSource(source: string): { packageName: string; subpath: string } | null {
  if (!isBarePackageSource(source)) return null
  const parts = source.split('/')
  if (source.startsWith('@')) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null
    const packageName = `${parts[0]}/${parts[1]}`
    const rest = parts.slice(2).join('/')
    return { packageName, subpath: rest ? `./${rest}` : '.' }
  }
  if (!parts[0]) return null
  const rest = parts.slice(1).join('/')
  return { packageName: parts[0], subpath: rest ? `./${rest}` : '.' }
}

function findPackageJsonPath(packageName: string, importer: string | undefined): string | null {
  const normalizedImporter = normalizeConcreteFileName(importer)
  if (!normalizedImporter) return null

  let current = path.dirname(normalizedImporter)
  while (true) {
    const candidate = path.join(current, 'node_modules', packageName, 'package.json')
    if (pathIsFile(candidate, sharedFsProbeCache)) return candidate

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function readPackageConfig(packageJsonPath: string): FictPackageConfig | null {
  try {
    const raw = readFileSync(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as {
      fict?: unknown
      fictMetadata?: unknown
    }
    const config: FictPackageConfig = {}
    if (pkg.fict && typeof pkg.fict === 'object') {
      const fict = pkg.fict as { metadata?: unknown; exports?: unknown }
      if (typeof fict.metadata === 'string') {
        config.metadata = fict.metadata
      }
      if (fict.exports && typeof fict.exports === 'object') {
        const exportsConfig: Record<string, string> = {}
        for (const [key, value] of Object.entries(fict.exports as Record<string, unknown>)) {
          if (typeof value === 'string') exportsConfig[key] = value
        }
        if (Object.keys(exportsConfig).length > 0) {
          config.exports = exportsConfig
        }
      }
    }
    if (!config.metadata && typeof pkg.fictMetadata === 'string') {
      config.metadata = pkg.fictMetadata
    }
    if (config.metadata || config.exports) return config
  } catch {
    // Malformed package metadata is ignored so package resolution stays best-effort.
  }
  return null
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizePackageMetadataPath(packageDir: string, metadataPath: string): string | null {
  if (!metadataPath || metadataPath.includes('\0')) return null
  if (path.isAbsolute(metadataPath) || metadataPath.startsWith('file://')) return null
  if (metadataPath.startsWith('/@fs/')) return null

  const normalizedPackageDir = normalizeFileName(packageDir)
  const resolved = normalizeFileName(path.resolve(normalizedPackageDir, metadataPath))
  if (!isPathInside(normalizedPackageDir, resolved)) return null
  return resolved
}

function readPackageMetadataFile(
  metaPath: string,
  packageDir: string,
  store: Map<string, ModuleReactiveMetadata>,
  fsCache?: FsProbeCache,
): ModuleReactiveMetadata | undefined {
  if (!pathIsFile(metaPath, fsCache)) return undefined
  try {
    const packageRoot = realpathSync(packageDir)
    const realMetaPath = realpathSync(metaPath)
    if (!isPathInside(packageRoot, realMetaPath)) return undefined

    const parsed = parseModuleReactiveMetadata(readFileSync(realMetaPath, 'utf8'))
    if (!parsed) return undefined
    store.set(metaPath, parsed)
    diskLoadedMetadataKeys.add(metaPath)
    return parsed
  } catch {
    return undefined
  }
}

export function resolvePackageModuleMetadata(
  source: string,
  importer: string | undefined,
  options?: FictCompilerOptions,
): ModuleReactiveMetadata | undefined {
  const parsedSource = splitPackageSource(source)
  if (!parsedSource) return undefined

  const packageJsonPath = findPackageJsonPath(parsedSource.packageName, importer)
  if (!packageJsonPath) return undefined

  const packageConfig = readPackageConfig(packageJsonPath)
  if (!packageConfig) return undefined

  const packageDir = path.dirname(packageJsonPath)
  const metadataPath =
    packageConfig.exports?.[parsedSource.subpath] ??
    (parsedSource.subpath === '.' ? packageConfig.metadata : undefined)
  if (!metadataPath) return undefined

  const normalizedMetaPath = normalizePackageMetadataPath(packageDir, metadataPath)
  if (!normalizedMetaPath) return undefined

  const store = getMetadataStore(options)
  const existing = store.get(normalizedMetaPath)
  if (existing && canReuseStoredMetadata(normalizedMetaPath)) return existing

  return readPackageMetadataFile(normalizedMetaPath, packageDir, store, sharedFsProbeCache)
}

function resolveImportSource(
  source: string,
  importer: string | undefined,
  store: Map<string, ModuleReactiveMetadata>,
  options?: { probeFs?: boolean | undefined; fsCache?: FsProbeCache | undefined },
): string | undefined {
  if (!importer) return undefined
  const probeFs = options?.probeFs ?? true
  const isAbsolute = path.isAbsolute(source)
  if (!isAbsolute && !source.startsWith('.')) return undefined

  const base = isAbsolute ? source : path.resolve(path.dirname(importer), source)
  const normalized = normalizeFileName(base)

  if (store.has(normalized)) return normalized
  if (probeFs && pathIsFile(normalized, options?.fsCache)) return normalized

  const ext = path.extname(normalized)
  if (!ext) {
    for (const suffix of MODULE_EXTENSIONS) {
      const candidate = `${normalized}${suffix}`
      if (store.has(candidate)) return candidate
      if (probeFs && pathIsFile(candidate, options?.fsCache)) return candidate
    }
  }

  for (const suffix of MODULE_EXTENSIONS) {
    const candidate = path.join(normalized, `index${suffix}`)
    if (store.has(candidate)) return candidate
    if (probeFs && pathIsFile(candidate, options?.fsCache)) return candidate
  }

  return undefined
}

function resolveImportSourceByMetadata(
  source: string,
  importer: string | undefined,
  options?: FictCompilerOptions,
  fsCache?: FsProbeCache,
): string | undefined {
  if (!importer) return undefined
  const isAbsolute = path.isAbsolute(source)
  if (!isAbsolute && !source.startsWith('.')) return undefined

  const base = isAbsolute ? source : path.resolve(path.dirname(importer), source)
  const normalized = normalizeFileName(base)
  const candidates: string[] = []
  const ext = path.extname(normalized)
  if (ext) {
    candidates.push(normalized)
  } else {
    for (const suffix of MODULE_EXTENSIONS) {
      candidates.push(`${normalized}${suffix}`)
    }
  }
  for (const suffix of MODULE_EXTENSIONS) {
    candidates.push(path.join(normalized, `index${suffix}`))
  }

  for (const candidate of candidates) {
    const metaPaths = getMetadataReadPaths(candidate, options)
    if (metaPaths.some(metaPath => pathIsFile(metaPath, fsCache))) {
      return candidate
    }
  }

  return undefined
}

export function resolveModuleMetadata(
  source: string,
  importer: string | undefined,
  options?: FictCompilerOptions,
): ModuleReactiveMetadata | undefined {
  const useResolutionCache = shouldUseResolutionCache(options)
  const cacheKey = `${importer ?? ''}\0${source}`
  if (useResolutionCache) {
    const cache = getResolutionCache(options)
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }
  }

  if (options?.resolveModuleMetadata) {
    const resolved = options.resolveModuleMetadata(source, importer)
    if (resolved) return resolved
  }
  const store = getMetadataStore(options)
  const hasExternalMetadataStore = !!options?.moduleMetadata
  // When a caller provides an explicit metadata store, treat it as the source
  // of truth and avoid disk probing unless adjacent emission is explicitly enabled.
  const shouldProbeFs = options?.emitModuleMetadata === true || !hasExternalMetadataStore
  const fsCache = shouldProbeFs ? sharedFsProbeCache : undefined
  const canReadSourceDirectly =
    path.isAbsolute(source) || source.startsWith('/@fs/') || source.startsWith('file://')

  let resolvedKey = resolveImportSource(source, importer, store, {
    probeFs: false,
    fsCache,
  })
  if (!resolvedKey && shouldProbeFs) {
    resolvedKey = resolveImportSourceByMetadata(source, importer, options, fsCache)
  }
  let resolvedMetadata: ModuleReactiveMetadata | undefined
  let resolvedFromDisk = false
  if (resolvedKey) {
    const existing = store.get(resolvedKey)
    if (existing && canReuseStoredMetadata(resolvedKey)) {
      resolvedMetadata = existing
    } else if (shouldProbeFs) {
      const loaded = shouldProbeFs
        ? readMetadataFromDisk(resolvedKey, store, options, fsCache)
        : undefined
      if (loaded) {
        resolvedMetadata = loaded
        resolvedFromDisk = true
      }
    }
  }
  if (!resolvedMetadata && store.has(source) && canReuseStoredMetadata(source)) {
    resolvedMetadata = store.get(source)
  }
  if (!resolvedMetadata && canReadSourceDirectly) {
    if ((store.has(source) && !canReuseStoredMetadata(source)) || !store.has(source)) {
      const loaded = shouldProbeFs
        ? readMetadataFromDisk(source, store, options, fsCache)
        : undefined
      if (loaded) {
        resolvedMetadata = loaded
        resolvedFromDisk = true
      }
    }
    if (!resolvedMetadata && store.has(source) && canReuseStoredMetadata(source)) {
      resolvedMetadata = store.get(source)
    }
  }

  if (!resolvedMetadata && shouldProbeFs && isBarePackageSource(source)) {
    resolvedMetadata = resolvePackageModuleMetadata(source, importer, options)
    if (resolvedMetadata) resolvedFromDisk = true
  }

  if (useResolutionCache) {
    const cache = getResolutionCache(options)
    if (resolvedMetadata && !resolvedFromDisk) {
      cache.set(cacheKey, resolvedMetadata)
    }
  }
  return resolvedMetadata
}

export function setModuleMetadata(
  fileName: string | undefined,
  metadata: ModuleReactiveMetadata,
  options?: FictCompilerOptions,
): void {
  const writeMode = resolveMetadataWriteMode(options)
  const normalized = normalizeConcreteFileName(fileName)
  if (!normalized) {
    if (writeMode === 'adjacent') {
      warnMetadata(
        options,
        null,
        'Skipping module metadata emission because filename is missing or virtual',
      )
    }
    return
  }
  const store = getMetadataStore(options)
  store.set(normalized, metadata)
  diskLoadedMetadataKeys.delete(normalized)
  clearResolutionCaches()
  const metaPath = getMetadataWritePath(normalized, writeMode, options)
  if (!metaPath) return
  const payload = JSON.stringify(metadata)
  const hasMetaFile = pathIsFile(metaPath)
  cacheFsProbeResult(sharedFsProbeCache, metaPath, hasMetaFile)
  if (lastWrittenMetadataPayload.get(metaPath) === payload && hasMetaFile) return
  try {
    writeMetadataAtomically(metaPath, payload)
    lastWrittenMetadataPayload.set(metaPath, payload)
    cacheFsProbeResult(sharedFsProbeCache, metaPath, true)
  } catch {
    lastWrittenMetadataPayload.delete(metaPath)
    cacheFsProbeResult(sharedFsProbeCache, metaPath, pathIsFile(metaPath))
    if (writeMode === 'adjacent') {
      warnMetadata(options, normalized, 'Failed to write module metadata sidecar')
    }
  }
}

export function clearModuleMetadata(options?: FictCompilerOptions): void {
  const store = getMetadataStore(options)
  store.clear()
  diskLoadedMetadataKeys.clear()
  lastWrittenMetadataPayload.clear()
  clearResolutionCaches()
  clearFsProbeCache()
}
