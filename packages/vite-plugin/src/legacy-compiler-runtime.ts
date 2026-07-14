import { createRequire } from 'node:module'

import type { transformAsync as babelTransformAsyncType } from '@babel/core'
import type babelGeneratorType from '@babel/generator'
import type { parse as babelParseType } from '@babel/parser'
import type transformTypeScriptType from '@babel/plugin-transform-typescript'
import type babelTraverseType from '@babel/traverse'
import type * as BabelTypes from '@babel/types'
import type {
  createFictPlugin as createFictPluginType,
  getCompilerCacheFingerprint as getCompilerCacheFingerprintType,
} from '@fictjs/compiler/legacy'

interface BabelCoreModule {
  transformAsync: typeof babelTransformAsyncType
}
export type BabelGenerator = typeof babelGeneratorType
export type BabelParse = typeof babelParseType
export type BabelTraverse = typeof babelTraverseType
type BabelTransformTypeScript = typeof transformTypeScriptType
interface LegacyCompilerModule {
  createFictPlugin: typeof createFictPluginType
  getCompilerCacheFingerprint: typeof getCompilerCacheFingerprintType
}

export interface BabelLegacyRuntime {
  createFictPlugin: LegacyCompilerModule['createFictPlugin']
  generate: BabelGenerator
  getCompilerCacheFingerprint: LegacyCompilerModule['getCompilerCacheFingerprint']
  parse: BabelParse
  transformAsync: BabelCoreModule['transformAsync']
  transformTypeScript: BabelTransformTypeScript
  traverse: BabelTraverse
  types: typeof BabelTypes
}

const requireFromVitePlugin = createRequire(import.meta.url)
let babelLegacyRuntime: BabelLegacyRuntime | undefined

function moduleDefault<T>(value: unknown): T {
  if (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'default' in value
  ) {
    return (value as { default: T }).default
  }
  return value as T
}

export function getBabelLegacyRuntime(): BabelLegacyRuntime {
  if (babelLegacyRuntime) return babelLegacyRuntime
  const core = requireFromVitePlugin('@babel/core') as BabelCoreModule
  const parser = requireFromVitePlugin('@babel/parser') as { parse: BabelParse }
  const legacyCompiler = requireFromVitePlugin('@fictjs/compiler/legacy') as LegacyCompilerModule
  babelLegacyRuntime = {
    createFictPlugin: legacyCompiler.createFictPlugin,
    generate: moduleDefault<BabelGenerator>(requireFromVitePlugin('@babel/generator')),
    getCompilerCacheFingerprint: legacyCompiler.getCompilerCacheFingerprint,
    parse: parser.parse,
    transformAsync: core.transformAsync,
    transformTypeScript: moduleDefault<BabelTransformTypeScript>(
      requireFromVitePlugin('@babel/plugin-transform-typescript'),
    ),
    traverse: moduleDefault<BabelTraverse>(requireFromVitePlugin('@babel/traverse')),
    types: requireFromVitePlugin('@babel/types') as typeof BabelTypes,
  }
  return babelLegacyRuntime
}

export const babelGenerate = ((...args: unknown[]) =>
  Reflect.apply(getBabelLegacyRuntime().generate, undefined, args)) as BabelGenerator
export const babelParse = ((...args: unknown[]) =>
  Reflect.apply(getBabelLegacyRuntime().parse, undefined, args)) as BabelParse
export const babelTraverse = ((...args: unknown[]) =>
  Reflect.apply(getBabelLegacyRuntime().traverse, undefined, args)) as BabelTraverse
export const babelTypes = new Proxy({} as typeof BabelTypes, {
  get(_target, property) {
    return Reflect.get(getBabelLegacyRuntime().types, property)
  },
})
