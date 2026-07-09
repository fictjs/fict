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
     * Enable TSX parsing when allExtensions is true.
     * @default true in all-extensions mode
     */
    isTSX?: boolean

    /**
     * Parse all files with one TypeScript mode instead of detecting .ts/.tsx.
     * @default false
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

  const { allowNamespaces = true, allowDeclareFields = true } = typescriptOptions
  const allExtensions = typescriptOptions.allExtensions ?? false
  const isTSX = typescriptOptions.isTSX ?? true

  const plugins: TransformOptions['plugins'] = []
  const overrides: TransformOptions['overrides'] = []
  const typeScriptOptions = {
    allowNamespaces,
    allowDeclareFields,
  }

  // TypeScript must lower runtime declarations before Fict's Program.exit transform.
  if (typescript) {
    if (allExtensions) {
      plugins.push([
        transformTypeScript,
        {
          ...typeScriptOptions,
          isTSX,
          allExtensions: true,
        },
      ])
    } else {
      overrides.push(
        {
          test: /\.tsx$/i,
          plugins: [
            [transformTypeScript, { ...typeScriptOptions, isTSX: true, allExtensions: true }],
          ],
        },
        {
          test: /\.ts$/i,
          plugins: [
            [transformTypeScript, { ...typeScriptOptions, isTSX: false, allExtensions: true }],
          ],
        },
        {
          test: /\.[cm]ts$/i,
          plugins: [
            [
              transformTypeScript,
              {
                ...typeScriptOptions,
                isTSX: false,
                allExtensions: true,
                disallowAmbiguousJSXLike: true,
              },
            ],
          ],
        },
      )
    }
  }

  // Add JSX syntax plugin
  plugins.push(['@babel/plugin-syntax-jsx', {}])

  // Add Fict compiler plugin
  plugins.push([createFictPlugin, compilerOptions])

  return {
    plugins,
    ...(overrides.length > 0 ? { overrides } : {}),
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
