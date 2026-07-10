import {
  transformFromAstSync,
  type ConfigAPI,
  type PluginObj,
  type TransformOptions,
} from '@babel/core'
import transformModulesCommonJS from '@babel/plugin-transform-modules-commonjs'
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

type TypeScriptOptions = NonNullable<FictPresetOptions['typescriptOptions']>
interface BabelFileDataStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

function getFileDataStore(file: unknown): BabelFileDataStore {
  return file as BabelFileDataStore
}

function resolveTypeScriptTransformOptions(
  filename: string | undefined,
  options: TypeScriptOptions,
): Record<string, unknown> | null {
  const baseOptions = {
    allowNamespaces: options.allowNamespaces ?? true,
    allowDeclareFields: options.allowDeclareFields ?? true,
  }
  if (options.allExtensions) {
    return {
      ...baseOptions,
      isTSX: options.isTSX ?? true,
      allExtensions: true,
    }
  }
  if (!filename) return null
  if (/\.tsx$/i.test(filename)) {
    return { ...baseOptions, isTSX: true, allExtensions: true }
  }
  if (/\.ts$/i.test(filename)) {
    return { ...baseOptions, isTSX: false, allExtensions: true }
  }
  if (/\.[cm]ts$/i.test(filename)) {
    return {
      ...baseOptions,
      isTSX: false,
      allExtensions: true,
      disallowAmbiguousJSXLike: true,
    }
  }
  return null
}

function shouldCompileTypeScriptAsCommonJS(
  filename: string | undefined,
  options: TypeScriptOptions,
): boolean {
  return !options.allExtensions && !!filename && /\.cts$/i.test(filename)
}

function commonJsMarkerPlugin(): PluginObj {
  return {
    name: 'fict-inherited-commonjs-marker',
    visitor: {},
    pre() {
      getFileDataStore(this.file).set('@babel/plugin-transform-modules-*', 'commonjs')
    },
  }
}

function createIsolatedFictPrepass(
  compilerOptions: FictCompilerOptions,
  typescript: boolean,
  typescriptOptions: TypeScriptOptions,
): PluginObj {
  return {
    name: 'fict-isolated-prepass',
    visitor: {},
    pre(file) {
      const plugins: NonNullable<TransformOptions['plugins']> = []
      const typeScriptTransformOptions = typescript
        ? resolveTypeScriptTransformOptions(file.opts.filename ?? undefined, typescriptOptions)
        : null
      const compileAsCommonJS =
        !!typeScriptTransformOptions &&
        shouldCompileTypeScriptAsCommonJS(file.opts.filename ?? undefined, typescriptOptions)
      if (typeScriptTransformOptions) {
        if (getFileDataStore(this.file).get('@babel/plugin-transform-modules-*') === 'commonjs') {
          plugins.push(commonJsMarkerPlugin)
        }
        plugins.push([transformTypeScript, typeScriptTransformOptions])
      }
      plugins.push([createFictPlugin, compilerOptions])
      if (compileAsCommonJS) {
        plugins.push([transformModulesCommonJS, { allowTopLevelThis: true }])
      }

      let inner: ReturnType<typeof transformFromAstSync>
      try {
        inner = transformFromAstSync(file.ast, file.code, {
          filename: file.opts.filename,
          cwd: file.opts.cwd,
          envName: file.opts.envName,
          sourceType: file.opts.sourceType,
          caller: file.opts.caller,
          assumptions: file.opts.assumptions,
          configFile: false,
          babelrc: false,
          ast: true,
          code: false,
          cloneInputAst: true,
          plugins,
        })
      } catch (error) {
        const filename = file.opts.filename
        if (error instanceof Error && filename && error.message.startsWith(`${filename}: `)) {
          error.message = error.message.slice(filename.length + 2)
        }
        throw error
      }
      if (!inner?.ast) {
        throw new Error(
          `[fict] Isolated compiler prepass returned no AST for ${file.opts.filename}.`,
        )
      }

      file.path.replaceWith(inner.ast.program)
      if (inner.ast.comments !== undefined) file.ast.comments = inner.ast.comments
      Object.assign(file.metadata, inner.metadata)
      file.path.scope.crawl()
    },
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

  const allExtensions = typescriptOptions.allExtensions ?? false
  const isTSX = typescriptOptions.isTSX ?? true

  const plugins: TransformOptions['plugins'] = []
  const overrides: TransformOptions['overrides'] = []
  // The outer pass only enables parsing. Runtime TypeScript and Fict transforms run in
  // an isolated prepass before any sibling plugin can consume macros or JSX.
  if (typescript) {
    if (allExtensions) {
      plugins.push([
        '@babel/plugin-syntax-typescript',
        {
          isTSX,
        },
      ])
    } else {
      overrides.push(
        {
          test: /\.tsx$/i,
          plugins: [['@babel/plugin-syntax-typescript', { isTSX: true }]],
        },
        {
          test: /\.ts$/i,
          plugins: [['@babel/plugin-syntax-typescript', { isTSX: false }]],
        },
        {
          test: /\.mts$/i,
          sourceType: 'module',
          plugins: [
            [
              '@babel/plugin-syntax-typescript',
              {
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            ],
          ],
        },
        {
          test: /\.cts$/i,
          sourceType: 'unambiguous',
          plugins: [
            [
              '@babel/plugin-syntax-typescript',
              {
                isTSX: false,
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

  // Compile Fict in `pre`, before sibling visitors in the outer Babel pass.
  plugins.push(createIsolatedFictPrepass(compilerOptions, typescript, typescriptOptions))

  return {
    plugins,
    ...(overrides.length > 0 ? { overrides } : {}),
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
