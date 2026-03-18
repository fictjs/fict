import { transformSync, type PluginItem } from '@babel/core'
import pluginTransformCjs from '@babel/plugin-transform-modules-commonjs'
import presetTypescript from '@babel/preset-typescript'

import createFictPlugin, { type FictCompilerOptions } from '../src/index'

function runTransform(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
  extraPlugins: PluginItem[] = [],
  useCompilerDefaults = false,
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
    // JSX plugin runs AFTER Fict plugin (Babel runs plugins left to right, but visitors run bottom-up)
    // However, for conditional bindings, we need the JSX inside arrow functions to be transformed
    // The Fict plugin should handle transforming JSX inside these generated constructs
    plugins: [[createFictPlugin, mergedOptions], ...extraPlugins],
    presets: [[presetTypescript, { isTSX: true, allExtensions: true, allowDeclareFields: true }]],
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
