import { transformSync, type PluginItem } from '@babel/core'
// @ts-expect-error - CommonJS module without proper types
import pluginTransformCjs from '@babel/plugin-transform-modules-commonjs'
// @ts-expect-error - CommonJS module without proper types
import presetTypescript from '@babel/preset-typescript'

import createFictPlugin, { type FictCompilerOptions } from '../src/index'

function runTransform(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
  extraPlugins: PluginItem[] = [],
): string {
  const mergedOptions: FictCompilerOptions = { ...options }

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
