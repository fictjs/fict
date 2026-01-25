import type { ConfigAPI, TransformOptions } from '@babel/core'
import { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'

export interface FictPresetOptions extends Omit<FictCompilerOptions, 'typescript'> {
  /**
   * Enable TypeScript support.
   * @default true
   */
  typescript?: boolean

  /**
   * TypeScript preset options.
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
  }
}

/**
 * Babel preset for Fict.
 *
 * Includes:
 * - @babel/preset-typescript (optional, enabled by default)
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

  const { isTSX = true, allExtensions = true, allowNamespaces = true } = typescriptOptions

  const presets: TransformOptions['presets'] = []
  const plugins: TransformOptions['plugins'] = []

  // Add TypeScript preset if enabled
  if (typescript) {
    presets.push([
      '@babel/preset-typescript',
      {
        isTSX,
        allExtensions,
        allowNamespaces,
      },
    ])
  }

  // Add JSX syntax plugin
  plugins.push(['@babel/plugin-syntax-jsx', {}])

  // Add Fict compiler plugin
  plugins.push([createFictPlugin, compilerOptions])

  return {
    presets,
    plugins,
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
