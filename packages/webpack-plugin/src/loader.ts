import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { transformAsync, type TransformOptions } from '@babel/core'
import type { FictPresetOptions } from '@fictjs/babel-preset'
import { resolvePackageModuleMetadata, type ModuleReactiveMetadata } from '@fictjs/compiler'

import { isUnresolvedPackageResolution, readPackageMetadataAtBoundary } from './package-metadata'
import {
  createLocalResolutionKey,
  getLoaderBinding,
  normalizeFileName,
  normalizeWebpackResource,
  registerFictModule,
  storeFictModuleMetadata,
} from './shared'

export type FictWebpackLoaderOptions = Omit<
  FictPresetOptions,
  | 'emitModuleMetadata'
  | 'filename'
  | 'integrationDiagnostics'
  | 'moduleMetadata'
  | 'onModuleMetadataDependency'
  | 'publicModuleId'
  | 'resumable'
  | 'resolveModuleMetadata'
  | 'sourcemap'
  | 'validateIntegrationMetadata'
> & {
  /** Webpack resumability is not supported until the integration owns chunks and a manifest. */
  resumable?: false | undefined
  /** Public module identities are integration-owned and unavailable in the Webpack loader. */
  publicModuleId?: never
}

interface FictLoaderContext {
  async(): (
    error?: Error | null,
    content?: string,
    sourceMap?: NonNullable<TransformOptions['inputSourceMap']> | null,
  ) => void
  addDependency(file: string): void
  addMissingDependency(file: string): void
  cacheable(flag?: boolean): void
  getOptions(): FictPresetOptions
  mode?: string
  resource: string
  resourcePath: string
  rootContext: string
  sourceMap: boolean
}

function readModuleRequestMappings(metadata: unknown): Map<string, string> {
  if (!metadata || typeof metadata !== 'object') return new Map()
  const value = (metadata as { fictModuleRequestMappings?: unknown }).fictModuleRequestMappings
  if (value === undefined) return new Map()
  if (
    !Array.isArray(value) ||
    value.some(
      mapping =>
        !Array.isArray(mapping) ||
        mapping.length !== 2 ||
        mapping.some(request => typeof request !== 'string'),
    )
  ) {
    throw new Error('[fict] Babel returned malformed module request mappings.')
  }
  const mappings = new Map<string, string>()
  for (const [source, emitted] of value as [string, string][]) {
    const previous = mappings.get(source)
    if (previous !== undefined && previous !== emitted) {
      throw new Error(`[fict] Babel emitted conflicting request mappings for "${source}".`)
    }
    mappings.set(source, emitted)
  }
  return mappings
}

const require = createRequire(import.meta.url)
const fictPresetPath = require.resolve('@fictjs/babel-preset')
const fictPresetDirectory = path.dirname(fictPresetPath)

function normalizeInputSourceMap(
  sourceMap: string | object | undefined,
): TransformOptions['inputSourceMap'] {
  if (!sourceMap) return undefined
  if (typeof sourceMap !== 'string') {
    return sourceMap as NonNullable<TransformOptions['inputSourceMap']>
  }
  try {
    return JSON.parse(sourceMap) as NonNullable<TransformOptions['inputSourceMap']>
  } catch {
    return undefined
  }
}

function resolveThroughExistingAncestor(filename: string): string {
  let current = filename
  const missingSegments: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(current), ...missingSegments)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return filename
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

function unsupportedResumabilityError(options: FictPresetOptions): Error | null {
  if (options.resumable === true) {
    return new Error(
      '[fict] @fictjs/webpack-plugin does not support `resumable: true`: the Webpack ' +
        'integration does not emit split handler chunks, assign public resumable module ' +
        'identities, or generate a resumability manifest. Remove `resumable: true` or use ' +
        '@fictjs/vite-plugin for resumable builds.',
    )
  }
  if (options.publicModuleId !== undefined) {
    return new Error(
      '[fict] `publicModuleId` is integration-owned and cannot enable Webpack resumability: ' +
        '@fictjs/webpack-plugin does not emit split handler chunks, assign public resumable ' +
        'module identities, or generate a resumability manifest. Remove `publicModuleId` or ' +
        'use @fictjs/vite-plugin for resumable builds.',
    )
  }
  return null
}

export default function fictWebpackLoader(
  this: FictLoaderContext,
  source: string,
  inputSourceMap?: string | object,
): void {
  const callback = this.async()
  const options = this.getOptions()
  const resumabilityError = unsupportedResumabilityError(options)
  if (resumabilityError) {
    callback(resumabilityError)
    return
  }

  const binding = getLoaderBinding(this)
  if (!binding) {
    callback(
      new Error(
        '[fict] @fictjs/webpack-plugin/loader requires FictWebpackPlugin in webpack plugins.',
      ),
    )
    return
  }

  this.cacheable(true)
  let moduleIdentifier: string
  try {
    moduleIdentifier = registerFictModule(binding.state, binding.module)
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
    return
  }
  binding.state.incompleteModuleMetadata.delete(moduleIdentifier)
  if (!binding.state.moduleMetadata.has(moduleIdentifier)) {
    binding.state.moduleMetadata.set(moduleIdentifier, { exports: {} })
  }
  binding.state.metadataDependenciesByIdentifier.set(moduleIdentifier, new Set())
  binding.state.metadataSourcesByIdentifier.set(moduleIdentifier, new Set())
  binding.state.metadataRequestMappingsByIdentifier.set(moduleIdentifier, new Map())

  const webpackResource = normalizeWebpackResource(this.resource)
  const compilerFilename = normalizeFileName(this.resourcePath)
  // The compiler deliberately strips URL-like suffixes from filenames. Give each loader
  // invocation a private store, then hand its result back under Webpack's module identifier.
  // This prevents resource-query and loader-chain variants from sharing one physical-path entry.
  const compilerModuleMetadata = new Map<string, ModuleReactiveMetadata>()
  const registerMetadataDependency = (dependency: string): void => {
    const normalized = path.resolve(dependency)
    const dependencies = new Set([normalized, resolveThroughExistingAncestor(normalized)])
    for (const watched of dependencies) {
      binding.state.metadataDependenciesByIdentifier.get(moduleIdentifier)!.add(watched)
      if (existsSync(watched)) this.addDependency(watched)
      else this.addMissingDependency(watched)
    }
  }
  const compilerOptions: FictPresetOptions = {
    ...options,
    dev: options.dev ?? this.mode !== 'production',
    emitModuleMetadata: false,
    ...(binding.state.metadataGraphPrepared
      ? { integrationDiagnostics: [], validateIntegrationMetadata: true }
      : {}),
    moduleMetadata: compilerModuleMetadata,
    resolveModuleMetadata: (sourceRequest, importer) => {
      if (!importer) return undefined
      binding.state.metadataSourcesByIdentifier.get(moduleIdentifier)!.add(sourceRequest)
      const packageResolutions = binding.state.packageResolutionsByIdentifier.get(moduleIdentifier)
      if (packageResolutions?.has(sourceRequest)) {
        const packageResolution = packageResolutions.get(sourceRequest)
        if (packageResolution === 'opaque') return { exports: {} }
        if (
          !packageResolution ||
          packageResolution === 'unresolved' ||
          isUnresolvedPackageResolution(packageResolution)
        ) {
          return null
        }
        const result = readPackageMetadataAtBoundary(packageResolution, registerMetadataDependency)
        if (result.kind === 'resolved') return result.metadata
        if (result.kind === 'stale-boundary') throw new Error(result.message)
        return result.kind === 'plain' ? { exports: {} } : null
      }
      if (sourceRequest.includes('!')) return { exports: {} }
      const dependency = binding.state.resolvedLocalModules.get(
        createLocalResolutionKey(moduleIdentifier, sourceRequest),
      )
      if (dependency) {
        if (binding.state.incompleteModuleMetadata.has(dependency)) return null
        return binding.state.moduleMetadata.get(dependency) ?? null
      }
      if (sourceRequest.includes('?')) return { exports: {} }
      return resolvePackageModuleMetadata(sourceRequest, importer, {
        emitModuleMetadata: false,
        moduleMetadata: binding.state.moduleMetadata,
        onModuleMetadataDependency: registerMetadataDependency,
      })
    },
    sourcemap: this.sourceMap,
  }

  void transformAsync(source, {
    babelrc: false,
    caller: {
      name: '@fictjs/webpack-plugin',
      supportsDynamicImport: true,
      supportsStaticESM: true,
      supportsTopLevelAwait: true,
    },
    configFile: false,
    cwd: fictPresetDirectory,
    filename: webpackResource,
    inputSourceMap: normalizeInputSourceMap(inputSourceMap),
    presets: [[fictPresetPath, compilerOptions]],
    sourceFileName: webpackResource,
    sourceMaps: this.sourceMap,
  }).then(
    result => {
      if (!result?.code) {
        callback(new Error(`[fict] Babel returned no output for ${moduleIdentifier}.`))
        return
      }
      if (
        (result.metadata as Record<string, unknown> | undefined)?.fictModuleMetadataIncomplete ===
        true
      ) {
        binding.state.incompleteModuleMetadata.add(moduleIdentifier)
      } else {
        binding.state.incompleteModuleMetadata.delete(moduleIdentifier)
      }
      const metadata = compilerModuleMetadata.get(compilerFilename)
      if (!metadata) {
        callback(new Error(`[fict] Compiler did not emit module metadata for ${moduleIdentifier}.`))
        return
      }
      binding.state.moduleMetadata.set(moduleIdentifier, metadata)
      try {
        const emittedMappings = readModuleRequestMappings(result.metadata)
        const requestMappings =
          binding.state.metadataRequestMappingsByIdentifier.get(moduleIdentifier)!
        for (const source of binding.state.metadataSourcesByIdentifier.get(moduleIdentifier) ??
          []) {
          requestMappings.set(source, emittedMappings.get(source) ?? source)
        }
        storeFictModuleMetadata(
          binding.state,
          binding.module,
          metadata,
          binding.state.pendingDependencyFingerprints.get(moduleIdentifier) ?? null,
        )
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
        return
      }
      callback(
        null,
        result.code,
        (result.map as NonNullable<TransformOptions['inputSourceMap']> | null) ?? null,
      )
    },
    error => callback(error instanceof Error ? error : new Error(String(error))),
  )
}
