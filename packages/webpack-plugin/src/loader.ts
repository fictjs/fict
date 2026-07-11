import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { transformAsync, type TransformOptions } from '@babel/core'
import type { FictPresetOptions } from '@fictjs/babel-preset'
import { resolvePackageModuleMetadata } from '@fictjs/compiler'

import { readPackageMetadataAtBoundary } from './package-metadata'
import {
  createLocalResolutionKey,
  getLoaderBinding,
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
  let filename: string
  try {
    filename = registerFictModule(binding.state, this.resourcePath, binding.module)
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
    return
  }
  binding.state.incompleteModuleMetadata.delete(filename)
  if (!binding.state.moduleMetadata.has(filename)) {
    binding.state.moduleMetadata.set(filename, { exports: {} })
  }
  binding.state.metadataDependenciesByFilename.set(filename, new Set())

  const options = this.getOptions()
  const registerMetadataDependency = (dependency: string): void => {
    const normalized = path.resolve(dependency)
    const dependencies = new Set([normalized, resolveThroughExistingAncestor(normalized)])
    for (const watched of dependencies) {
      binding.state.metadataDependenciesByFilename.get(filename)!.add(watched)
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
    moduleMetadata: binding.state.moduleMetadata,
    resolveModuleMetadata: (sourceRequest, importer) => {
      if (!importer) return undefined
      if (sourceRequest.includes('?') || sourceRequest.includes('!')) return { exports: {} }
      const dependency = binding.state.resolvedLocalModules.get(
        createLocalResolutionKey(importer, sourceRequest),
      )
      if (dependency) {
        if (binding.state.incompleteModuleMetadata.has(dependency)) return null
        return binding.state.moduleMetadata.get(dependency) ?? null
      }
      const packageResolutions = binding.state.packageResolutionsByFilename.get(filename)
      if (packageResolutions?.has(sourceRequest)) {
        const packageResolution = packageResolutions.get(sourceRequest)
        if (packageResolution === 'opaque') return { exports: {} }
        if (!packageResolution || packageResolution === 'unresolved') return null
        const result = readPackageMetadataAtBoundary(packageResolution, registerMetadataDependency)
        if (result.kind === 'resolved') return result.metadata
        if (result.kind === 'stale-boundary') throw new Error(result.message)
        return result.kind === 'plain' ? { exports: {} } : null
      }
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
    filename,
    inputSourceMap: normalizeInputSourceMap(inputSourceMap),
    presets: [[fictPresetPath, compilerOptions]],
    sourceFileName: filename,
    sourceMaps: this.sourceMap,
  }).then(
    result => {
      if (!result?.code) {
        callback(new Error(`[fict] Babel returned no output for ${filename}.`))
        return
      }
      if (
        (result.metadata as Record<string, unknown> | undefined)?.fictModuleMetadataIncomplete ===
        true
      ) {
        binding.state.incompleteModuleMetadata.add(filename)
      } else {
        binding.state.incompleteModuleMetadata.delete(filename)
      }
      const metadata = binding.state.moduleMetadata.get(filename)
      if (!metadata) {
        callback(new Error(`[fict] Compiler did not emit module metadata for ${filename}.`))
        return
      }
      try {
        storeFictModuleMetadata(
          binding.state,
          binding.module,
          filename,
          metadata,
          binding.state.pendingDependencyFingerprints.get(filename) ?? null,
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
