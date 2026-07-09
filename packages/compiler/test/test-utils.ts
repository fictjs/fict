import { transformSync, type PluginItem } from '@babel/core'
import pluginTransformCjs from '@babel/plugin-transform-modules-commonjs'
import pluginTransformTypescript from '@babel/plugin-transform-typescript'

import createFictPlugin, { type FictCompilerOptions } from '../src/index'

function runTransform(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
  extraPlugins: PluginItem[] = [],
  useCompilerDefaults = false,
  lowerTypeScript = true,
): string {
  const mergedOptions: FictCompilerOptions = { ...options }
  if (mergedOptions.dev === undefined) {
    mergedOptions.dev = true
  }
  if (mergedOptions.emitModuleMetadata === undefined) {
    mergedOptions.emitModuleMetadata = false
  }
  if (!useCompilerDefaults && mergedOptions.strictGuarantee === undefined) {
    // Most transform snapshot/spec tests validate legacy non-strict behavior.
    // Keep strict default assertions explicit in dedicated tests.
    mergedOptions.strictGuarantee = false
  }

  const plugins: PluginItem[] = []
  if (lowerTypeScript) {
    plugins.push([
      pluginTransformTypescript,
      {
        isTSX: true,
        allExtensions: true,
        allowDeclareFields: true,
        allowNamespaces: true,
      },
    ])
  }
  plugins.push([createFictPlugin, mergedOptions], ...extraPlugins)

  const result = transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
    plugins,
    generatorOpts: {
      compact: false,
    },
  })

  return result?.code ?? ''
}

export function transformFineGrained(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename)
}

export const transform = transformFineGrained

/**
 * Runs the compiler directly on a TypeScript AST without a lowering plugin.
 * Used to verify that the standalone Babel plugin still fails closed for
 * runtime TypeScript constructs that would otherwise emit invalid JavaScript.
 */
export function transformRawTypeScript(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename, [], false, false)
}

/**
 * Uses compiler defaults as-is (including strictGuarantee defaults).
 */
export function transformWithCompilerDefaults(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename, [], true)
}

/**
 * HIR transform function - uses HIR codegen path (for function-based code only)
 */
export function transformHIR(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename)
}

/**
 * Transform with CommonJS output - for runtime integration tests that use require()
 */
export function transformCommonJS(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename, [pluginTransformCjs])
}
