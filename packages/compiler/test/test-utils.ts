import { transformSync, type PluginItem } from '@babel/core'
// @ts-expect-error - CommonJS module without proper types
import pluginTransformCjs from '@babel/plugin-transform-modules-commonjs'
// @ts-expect-error - CommonJS module without proper types
import pluginTransformReactJsx from '@babel/plugin-transform-react-jsx'
// @ts-expect-error - CommonJS module without proper types
import presetTypescript from '@babel/preset-typescript'

import createFictPlugin, { type FictCompilerOptions } from '../src/index'

function runTransform(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
  extraPlugins: PluginItem[] = [],
): string {
  // Always use @babel/plugin-transform-react-jsx to handle:
  // 1. Non-fine-grained mode: all JSX
  // 2. Fine-grained mode: component JSX (<App />) and fragments (<></>)
  //    since the Fict compiler only handles intrinsic elements
  const jsxPlugins: PluginItem[] = [
    [pluginTransformReactJsx, { runtime: 'automatic', importSource: '@fictjs/runtime' }],
  ]

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
    plugins: [[createFictPlugin, options], ...jsxPlugins, ...extraPlugins],
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

export function transformLegacyDom(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, { fineGrainedDom: false, ...options }, filename)
}

export function transformCommonJS(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'module.tsx',
): string {
  return runTransform(source, options, filename, [pluginTransformCjs])
}
