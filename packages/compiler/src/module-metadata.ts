import path from 'node:path'
import { existsSync, statSync } from 'node:fs'

import type { FictCompilerOptions, ModuleReactiveMetadata } from './types'

const globalMetadata = new Map<string, ModuleReactiveMetadata>()

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

function normalizeFileName(fileName: string): string {
  return path.resolve(fileName)
}

function getMetadataStore(options?: FictCompilerOptions): Map<string, ModuleReactiveMetadata> {
  return options?.moduleMetadata ?? globalMetadata
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
  const resolvedKey = resolveImportSource(source, importer, store)
  if (resolvedKey) {
    return store.get(resolvedKey)
  }
  if (store.has(source)) return store.get(source)
  return undefined
}

export function setModuleMetadata(
  fileName: string | undefined,
  metadata: ModuleReactiveMetadata,
  options?: FictCompilerOptions,
): void {
  if (!fileName) return
  const store = getMetadataStore(options)
  store.set(normalizeFileName(fileName), metadata)
}

export function clearModuleMetadata(options?: FictCompilerOptions): void {
  const store = getMetadataStore(options)
  store.clear()
}
