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
  | 'resolveModuleMetadata'
  | 'sourcemap'
  | 'validateIntegrationMetadata'
>

interface FictLoaderContext {
  async(): (
    error?: Error | null,
    content?: string,
    sourceMap?: NonNullable<TransformOptions['inputSourceMap']> | null,
  ) => void
  addDependency(file: string): void
  addMissingDependency(file: string): void
  cacheable(flag?: boolean): void
  getOptions(): FictWebpackLoaderOptions
  mode?: string
  resource: string
  resourcePath: string
  rootContext: string
  sourceMap: boolean
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

export default function fictWebpackLoader(
  this: FictLoaderContext,
  source: string,
  inputSourceMap?: string | object,
): void {
  const callback = this.async()
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
  let resourceIdentity: string
  try {
    resourceIdentity = registerFictModule(
      binding.state,
      normalizeWebpackResource(this.resource),
      binding.module,
    )
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
    return
  }
  binding.state.incompleteModuleMetadata.delete(resourceIdentity)
  if (!binding.state.moduleMetadata.has(resourceIdentity)) {
    binding.state.moduleMetadata.set(resourceIdentity, { exports: {} })
  }
  binding.state.metadataDependenciesByFilename.set(resourceIdentity, new Set())

  const options = this.getOptions()
  const compilerFilename = normalizeFileName(this.resourcePath)
  // The compiler deliberately strips URL-like suffixes from filenames. Give each loader
  // invocation a private store, then hand its result back under Webpack's full resource identity.
  // This prevents concurrent query variants from overwriting one physical-path entry.
  const compilerModuleMetadata = new Map<string, ModuleReactiveMetadata>()
  const registerMetadataDependency = (dependency: string): void => {
    const normalized = path.resolve(dependency)
    const dependencies = new Set([normalized, resolveThroughExistingAncestor(normalized)])
    for (const watched of dependencies) {
      binding.state.metadataDependenciesByFilename.get(resourceIdentity)!.add(watched)
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
      const packageResolutions = binding.state.packageResolutionsByFilename.get(resourceIdentity)
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
        createLocalResolutionKey(resourceIdentity, sourceRequest),
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
    filename: resourceIdentity,
    inputSourceMap: normalizeInputSourceMap(inputSourceMap),
    presets: [[fictPresetPath, compilerOptions]],
    sourceFileName: resourceIdentity,
    sourceMaps: this.sourceMap,
  }).then(
    result => {
      if (!result?.code) {
        callback(new Error(`[fict] Babel returned no output for ${resourceIdentity}.`))
        return
      }
      if (
        (result.metadata as Record<string, unknown> | undefined)?.fictModuleMetadataIncomplete ===
        true
      ) {
        binding.state.incompleteModuleMetadata.add(resourceIdentity)
      } else {
        binding.state.incompleteModuleMetadata.delete(resourceIdentity)
      }
      const metadata = compilerModuleMetadata.get(compilerFilename)
      if (!metadata) {
        callback(new Error(`[fict] Compiler did not emit module metadata for ${resourceIdentity}.`))
        return
      }
      binding.state.moduleMetadata.set(resourceIdentity, metadata)
      try {
        storeFictModuleMetadata(
          binding.state,
          binding.module,
          resourceIdentity,
          metadata,
          binding.state.pendingDependencyFingerprints.get(resourceIdentity) ?? null,
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
