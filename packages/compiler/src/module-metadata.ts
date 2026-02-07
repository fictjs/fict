import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FictCompilerOptions, ModuleReactiveMetadata } from './types'

const globalMetadata = new Map<string, ModuleReactiveMetadata>()
const lastWrittenMetadataPayload = new Map<string, string>()
const defaultResolutionCache = new Map<string, ModuleReactiveMetadata | null>()
let resolutionCacheByOptions = new WeakMap<
  FictCompilerOptions,
  Map<string, ModuleReactiveMetadata | null>
>()

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_META_EXTENSION = '.fict.meta.json'
const DEFAULT_META_CACHE_DIR = path.join('.fict-cache', 'metadata')
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

type FsProbeCache = Map<string, boolean>

function shouldUseResolutionCache(options?: FictCompilerOptions): boolean {
  return !options?.resolveModuleMetadata && !options?.moduleMetadata
}

function getResolutionCache(
  options?: FictCompilerOptions,
): Map<string, ModuleReactiveMetadata | null> {
  if (!options) return defaultResolutionCache
  let cache = resolutionCacheByOptions.get(options)
  if (!cache) {
    cache = new Map<string, ModuleReactiveMetadata | null>()
    resolutionCacheByOptions.set(options, cache)
  }
  return cache
}

function clearResolutionCaches(): void {
  defaultResolutionCache.clear()
  resolutionCacheByOptions = new WeakMap<
    FictCompilerOptions,
    Map<string, ModuleReactiveMetadata | null>
  >()
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
  if (cache) {
    const cached = cache.get(pathName)
    if (cached !== undefined) return cached
  }
  let exists = false
  try {
    exists = statSync(pathName).isFile()
  } catch {
    exists = false
  }
  if (cache) cache.set(pathName, exists)
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
      const parsed = JSON.parse(raw) as ModuleReactiveMetadata
      store.set(normalized, parsed)
      return parsed
    } catch {
      // Ignore malformed/partial metadata files and try the next path.
    }
  }
  return undefined
}

function resolveImportSource(
  source: string,
  importer: string | undefined,
  store: Map<string, ModuleReactiveMetadata>,
  options?: { probeFs?: boolean; fsCache?: FsProbeCache },
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
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      return cached ?? undefined
    }
  }

  if (options?.resolveModuleMetadata) {
    const resolved = options.resolveModuleMetadata(source, importer)
    if (resolved) return resolved
  }
  const store = getMetadataStore(options)
  const hasExternalMetadataIntegration = !!(
    options?.moduleMetadata && options?.resolveModuleMetadata
  )
  const shouldProbeFs = options?.emitModuleMetadata === true || !hasExternalMetadataIntegration
  const fsCache = shouldProbeFs ? new Map<string, boolean>() : undefined
  const isFileLikeSource = path.isAbsolute(source) || source.startsWith('.')

  let resolvedKey = resolveImportSource(source, importer, store, {
    probeFs: false,
    fsCache,
  })
  if (!resolvedKey && shouldProbeFs) {
    resolvedKey = resolveImportSourceByMetadata(source, importer, options, fsCache)
  }
  let resolvedMetadata: ModuleReactiveMetadata | undefined
  if (resolvedKey) {
    const existing = store.get(resolvedKey)
    if (existing) {
      resolvedMetadata = existing
    } else {
      const loaded = shouldProbeFs
        ? readMetadataFromDisk(resolvedKey, store, options, fsCache)
        : undefined
      if (loaded) {
        resolvedMetadata = loaded
      }
    }
  }
  if (!resolvedMetadata && store.has(source)) {
    resolvedMetadata = store.get(source)
  }
  if (!resolvedMetadata && isFileLikeSource) {
    const loaded = shouldProbeFs ? readMetadataFromDisk(source, store, options, fsCache) : undefined
    if (loaded) {
      resolvedMetadata = loaded
    }
  }

  if (useResolutionCache) {
    const cache = getResolutionCache(options)
    cache.set(cacheKey, resolvedMetadata ?? null)
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
  clearResolutionCaches()
  const metaPath = getMetadataWritePath(normalized, writeMode, options)
  if (!metaPath) return
  const payload = JSON.stringify(metadata)
  if (lastWrittenMetadataPayload.get(metaPath) === payload && pathIsFile(metaPath)) return
  try {
    writeMetadataAtomically(metaPath, payload)
    lastWrittenMetadataPayload.set(metaPath, payload)
  } catch {
    lastWrittenMetadataPayload.delete(metaPath)
    if (writeMode === 'adjacent') {
      warnMetadata(options, normalized, 'Failed to write module metadata sidecar')
    }
  }
}

export function clearModuleMetadata(options?: FictCompilerOptions): void {
  const store = getMetadataStore(options)
  store.clear()
  lastWrittenMetadataPayload.clear()
  clearResolutionCaches()
}
