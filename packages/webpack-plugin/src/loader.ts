import { createRequire } from 'node:module'
import path from 'node:path'

import { transformAsync, type TransformOptions } from '@babel/core'
import type { FictPresetOptions } from '@fictjs/babel-preset'

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
  | 'moduleMetadata'
  | 'onModuleMetadataDependency'
  | 'resolveModuleMetadata'
  | 'sourcemap'
>

interface FictLoaderContext {
  async(): (
    error?: Error | null,
    content?: string,
    sourceMap?: NonNullable<TransformOptions['inputSourceMap']> | null,
  ) => void
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
  if (!binding.state.moduleMetadata.has(filename)) {
    binding.state.moduleMetadata.set(filename, { exports: {} })
  }

  const options = this.getOptions()
  const compilerOptions: FictPresetOptions = {
    ...options,
    dev: options.dev ?? this.mode !== 'production',
    emitModuleMetadata: false,
    moduleMetadata: binding.state.moduleMetadata,
    resolveModuleMetadata: (sourceRequest, importer) => {
      if (!importer) return undefined
      const dependency = binding.state.resolvedLocalModules.get(
        createLocalResolutionKey(importer, sourceRequest),
      )
      return dependency ? binding.state.moduleMetadata.get(dependency) : undefined
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
