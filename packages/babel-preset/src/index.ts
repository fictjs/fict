import type { ConfigAPI, TransformOptions } from '@babel/core'
import transformTypeScript from '@babel/plugin-transform-typescript'
import { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'

export interface FictPresetOptions extends Omit<FictCompilerOptions, 'typescript'> {
  /**
   * Enable TypeScript support.
   * @default true
   */
  typescript?: boolean

  /**
   * TypeScript transform options.
   * Only used when typescript is true.
   */
  typescriptOptions?: {
    /**
     * Enable TSX parsing.
     * @default true
     */
    isTSX?: boolean

    /**
     * Parse all files as TSX.
     * @default true
     */
    allExtensions?: boolean

    /**
     * Allow namespaces.
     * @default true
     */
    allowNamespaces?: boolean

    /**
     * Remove legal `declare` class fields before Fict compilation.
     * @default true
     */
    allowDeclareFields?: boolean
  }
}

/**
 * Babel preset for Fict.
 *
 * Includes:
 * - @babel/plugin-transform-typescript (optional, enabled by default)
 * - @babel/plugin-syntax-jsx
 * - @fictjs/compiler
 *
 * @example
 * ```js
 * // babel.config.js
 * module.exports = {
 *   presets: ['@fictjs/babel-preset']
 * }
 * ```
 *
 * @example
 * ```js
 * // With options
 * module.exports = {
 *   presets: [
 *     ['@fictjs/babel-preset', {
 *       dev: true,
 *       typescript: true,
 *     }]
 *   ]
 * }
 * ```
 */
export default function fictPreset(
  api: ConfigAPI,
  options: FictPresetOptions = {},
): TransformOptions {
  api.assertVersion(7)

  const { typescript = true, typescriptOptions = {}, ...compilerOptions } = options

  const {
    isTSX = true,
    allExtensions = true,
    allowNamespaces = true,
    allowDeclareFields = true,
  } = typescriptOptions

  const plugins: TransformOptions['plugins'] = []

  // TypeScript must lower runtime declarations before Fict's Program.exit transform.
  if (typescript) {
    plugins.push([
      transformTypeScript,
      {
        isTSX,
        allExtensions,
        allowNamespaces,
        allowDeclareFields,
      },
    ])
  }

  // Add JSX syntax plugin
  plugins.push(['@babel/plugin-syntax-jsx', {}])

  // Add Fict compiler plugin
  plugins.push([createFictPlugin, compilerOptions])

  return {
    plugins,
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
