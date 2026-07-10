import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule } from 'webpack'

export const FICT_WEBPACK_LOADER_CONTEXT = Symbol.for('@fictjs/webpack-plugin/loader-context/v1')

export interface FictWebpackCompilationState {
  moduleMetadata: Map<string, ModuleReactiveMetadata>
  modulesByFilename: Map<string, NormalModule>
  filenamesByModule: Map<NormalModule, string>
  resolvedLocalModules: Map<string, string>
}

export interface FictWebpackLoaderBinding {
  module: NormalModule
  state: FictWebpackCompilationState
}

export function createCompilationState(): FictWebpackCompilationState {
  return {
    moduleMetadata: new Map(),
    modulesByFilename: new Map(),
    filenamesByModule: new Map(),
    resolvedLocalModules: new Map(),
  }
}

export function normalizeFileName(filename: string): string {
  return path.resolve(filename)
}

export function createLocalResolutionKey(importer: string, source: string): string {
  return `${normalizeFileName(importer)}\0${source}`
}

export function attachLoaderBinding(
  loaderContext: object,
  binding: FictWebpackLoaderBinding,
): void {
  Object.defineProperty(loaderContext, FICT_WEBPACK_LOADER_CONTEXT, {
    configurable: true,
    value: binding,
  })
}

export function getLoaderBinding(loaderContext: object): FictWebpackLoaderBinding | undefined {
  return (
    loaderContext as {
      [FICT_WEBPACK_LOADER_CONTEXT]?: FictWebpackLoaderBinding
    }
  )[FICT_WEBPACK_LOADER_CONTEXT]
}
