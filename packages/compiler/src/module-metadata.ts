import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FictCompilerOptions, ModuleReactiveMetadata } from './types'

const globalMetadata = new Map<string, ModuleReactiveMetadata>()

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const DEFAULT_META_EXTENSION = '.fict.meta.json'

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

function getMetadataStore(options?: FictCompilerOptions): Map<string, ModuleReactiveMetadata> {
  return options?.moduleMetadata ?? globalMetadata
}

function getMetadataExtension(options?: FictCompilerOptions): string {
  return options?.moduleMetadataExtension ?? DEFAULT_META_EXTENSION
}

function getMetadataFilePath(fileName: string, options?: FictCompilerOptions): string {
  return `${normalizeFileName(fileName)}${getMetadataExtension(options)}`
}

function shouldEmitModuleMetadata(options?: FictCompilerOptions): boolean {
  const opt = options?.emitModuleMetadata
  if (opt === true) return true
  if (opt === false) return false
  // auto: emit only when no external store/resolver is supplied
  if (options?.moduleMetadata || options?.resolveModuleMetadata) return false
  return true
}

function readMetadataFromDisk(
  fileName: string,
  store: Map<string, ModuleReactiveMetadata>,
  options?: FictCompilerOptions,
): ModuleReactiveMetadata | undefined {
  const metaPath = getMetadataFilePath(fileName, options)
  if (!existsSync(metaPath)) return undefined
  try {
    const raw = readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as ModuleReactiveMetadata
    store.set(normalizeFileName(fileName), parsed)
    return parsed
  } catch {
    return undefined
  }
}

function isFile(pathName: string): boolean {
  try {
    return statSync(pathName).isFile()
  } catch {
    return false
  }
}

function resolveImportSource(
  source: string,
  importer: string | undefined,
  store: Map<string, ModuleReactiveMetadata>,
): string | undefined {
  if (!importer) return undefined
  const isAbsolute = path.isAbsolute(source)
  if (!isAbsolute && !source.startsWith('.')) return undefined

  const base = isAbsolute ? source : path.resolve(path.dirname(importer), source)
  const normalized = normalizeFileName(base)

  if (store.has(normalized)) return normalized
  if (existsSync(normalized) && isFile(normalized)) return normalized

  const ext = path.extname(normalized)
  if (!ext) {
    for (const suffix of MODULE_EXTENSIONS) {
      const candidate = `${normalized}${suffix}`
      if (store.has(candidate)) return candidate
      if (existsSync(candidate) && isFile(candidate)) return candidate
    }
  }

  for (const suffix of MODULE_EXTENSIONS) {
    const candidate = path.join(normalized, `index${suffix}`)
    if (store.has(candidate)) return candidate
    if (existsSync(candidate) && isFile(candidate)) return candidate
  }

  return undefined
}

function resolveImportSourceByMetadata(
  source: string,
  importer: string | undefined,
  options?: FictCompilerOptions,
): string | undefined {
  if (!importer) return undefined
  const isAbsolute = path.isAbsolute(source)
  if (!isAbsolute && !source.startsWith('.')) return undefined

  const base = isAbsolute ? source : path.resolve(path.dirname(importer), source)
  const normalized = normalizeFileName(base)
  const metaExt = getMetadataExtension(options)

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
    if (existsSync(`${candidate}${metaExt}`)) {
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
  if (options?.resolveModuleMetadata) {
    const resolved = options.resolveModuleMetadata(source, importer)
    if (resolved) return resolved
  }
  const store = getMetadataStore(options)
  let resolvedKey = resolveImportSource(source, importer, store)
  if (!resolvedKey) {
    resolvedKey = resolveImportSourceByMetadata(source, importer, options)
  }
  if (resolvedKey) {
    const existing = store.get(resolvedKey)
    if (existing) return existing
    const loaded = readMetadataFromDisk(resolvedKey, store, options)
    if (loaded) return loaded
  }
  if (store.has(source)) return store.get(source)
  const loaded = readMetadataFromDisk(source, store, options)
  if (loaded) return loaded
  return undefined
}

export function setModuleMetadata(
  fileName: string | undefined,
  metadata: ModuleReactiveMetadata,
  options?: FictCompilerOptions,
): void {
  if (!fileName) return
  const store = getMetadataStore(options)
  const normalized = normalizeFileName(fileName)
  store.set(normalized, metadata)
  if (!shouldEmitModuleMetadata(options)) return
  try {
    const metaPath = getMetadataFilePath(normalized, options)
    writeFileSync(metaPath, JSON.stringify(metadata), 'utf8')
  } catch {
    // Ignore filesystem errors for metadata emission.
  }
}

export function clearModuleMetadata(options?: FictCompilerOptions): void {
  const store = getMetadataStore(options)
  store.clear()
}
