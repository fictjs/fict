// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- upstream has no declarations
/// <reference path="./babel-plugin-syntax-typescript.d.ts" />

import {
  transformFromAstSync,
  types as t,
  type ConfigAPI,
  type PluginObj,
  type TransformOptions,
} from '@babel/core'
import type * as BabelCore from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import syntaxTypeScript from '@babel/plugin-syntax-typescript'
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

    /** Preserve ordinary imports even when they are referenced only in type positions. */
    onlyRemoveTypeImports?: boolean

    /** Inline exported and local const enums instead of emitting enum objects. */
    optimizeConstEnums?: boolean

    /** JSX factory identifier used to retain its value import during TypeScript lowering. */
    jsxPragma?: string

    /** JSX fragment identifier used to retain its value import during TypeScript lowering. */
    jsxPragmaFrag?: string

    /** Reject syntax that is ambiguous with JSX in all-extensions mode. */
    disallowAmbiguousJSXLike?: boolean

    /** Rewrite relative TypeScript import extensions to their JavaScript equivalents. */
    rewriteImportExtensions?: boolean
  }
}

type TypeScriptOptions = NonNullable<FictPresetOptions['typescriptOptions']>
interface BabelFileDataStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

const TS_FILENAME_RE = /\.ts(?:[?#].*)?$/i
const TSX_FILENAME_RE = /\.tsx(?:[?#].*)?$/i
const MTS_FILENAME_RE = /\.mts(?:[?#].*)?$/i
const CTS_FILENAME_RE = /\.cts(?:[?#].*)?$/i

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
    onlyRemoveTypeImports: options.onlyRemoveTypeImports,
    optimizeConstEnums: options.optimizeConstEnums,
    jsxPragma: options.jsxPragma,
    jsxPragmaFrag: options.jsxPragmaFrag,
  }
  if (options.allExtensions) {
    return {
      ...baseOptions,
      isTSX: options.isTSX ?? true,
      allExtensions: true,
      disallowAmbiguousJSXLike: options.disallowAmbiguousJSXLike ?? false,
    }
  }
  if (!filename) return null
  if (TSX_FILENAME_RE.test(filename)) {
    return { ...baseOptions, isTSX: true, allExtensions: true }
  }
  if (TS_FILENAME_RE.test(filename)) {
    return { ...baseOptions, isTSX: false, allExtensions: true }
  }
  if (MTS_FILENAME_RE.test(filename) || CTS_FILENAME_RE.test(filename)) {
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
  return !options.allExtensions && !!filename && CTS_FILENAME_RE.test(filename)
}

function rewriteTypeScriptExtension(source: string): string {
  if (!/^\.\.?\//.test(source)) return source
  return source.replace(
    /\.(tsx)$|((?:\.d)?)((?:\.[^./]+)?)\.([cm]?)ts$/i,
    (match, tsx: string | undefined, declaration: string, extension: string, cm: string) => {
      if (tsx) return '.js'
      if (declaration && (!extension || !cm)) return match
      return `${declaration}${extension}.${cm.toLowerCase()}js`
    },
  )
}

function createDynamicImportExtensionRewrite(
  expression: BabelCore.types.Expression,
): BabelCore.types.Expression {
  return t.callExpression(
    t.memberExpression(
      t.binaryExpression('+', expression, t.stringLiteral('')),
      t.identifier('replace'),
    ),
    [t.regExpLiteral('([\\\\/].*\\.[mc]?)tsx?$'), t.stringLiteral('$1js')],
  )
}

function rewriteTypeScriptImportsPlugin(): PluginObj {
  return {
    name: 'fict-rewrite-typescript-imports',
    visitor: {
      Program: {
        exit(path) {
          path.traverse({
            ImportDeclaration(importPath) {
              importPath.node.source.value = rewriteTypeScriptExtension(
                importPath.node.source.value,
              )
            },
            ExportAllDeclaration(exportPath) {
              exportPath.node.source.value = rewriteTypeScriptExtension(
                exportPath.node.source.value,
              )
            },
            ExportNamedDeclaration(exportPath) {
              if (exportPath.node.source) {
                exportPath.node.source.value = rewriteTypeScriptExtension(
                  exportPath.node.source.value,
                )
              }
            },
            CallExpression(callPath) {
              if (!t.isImport(callPath.node.callee)) return
              const source = callPath.node.arguments[0]
              if (t.isStringLiteral(source)) {
                source.value = rewriteTypeScriptExtension(source.value)
              } else if (source && t.isExpression(source)) {
                callPath.node.arguments[0] = createDynamicImportExtensionRewrite(source)
              }
            },
            ImportExpression(importPath) {
              const source = importPath.node.source
              if (t.isStringLiteral(source)) {
                source.value = rewriteTypeScriptExtension(source.value)
              } else {
                importPath.node.source = createDynamicImportExtensionRewrite(source)
              }
            },
          })
        },
      },
    },
  }
}

function removeObsoleteJsxPragmaImportsPlugin(options: TypeScriptOptions): PluginObj {
  return {
    name: 'fict-remove-obsolete-jsx-pragma-imports',
    visitor: {
      Program: {
        exit(path, state) {
          let hasJsx = false
          path.traverse({
            'JSXElement|JSXFragment'(jsxPath) {
              hasJsx = true
              jsxPath.stop()
            },
          })
          if (hasJsx) return

          let jsxPragma = options.jsxPragma ?? 'React.createElement'
          let jsxPragmaFrag = options.jsxPragmaFrag ?? 'React.Fragment'
          const pragmaPattern = /\*?\s*@jsx((?:Frag)?)\s+(\S+)/
          for (const comment of state.file.ast.comments ?? []) {
            const match = pragmaPattern.exec(comment.value)
            if (!match) continue
            if (match[1]) jsxPragmaFrag = match[2] ?? jsxPragmaFrag
            else jsxPragma = match[2] ?? jsxPragma
          }
          const pragmaBindings = new Set(
            [jsxPragma, jsxPragmaFrag]
              .map(pragma => pragma.split('.')[0])
              .filter((name): name is string => !!name),
          )
          if (pragmaBindings.size === 0) return

          path.scope.crawl()
          for (const statementPath of path.get('body')) {
            if (!statementPath.isImportDeclaration()) continue
            let removed = false
            for (const specifierPath of statementPath.get('specifiers')) {
              const localName = specifierPath.node.local.name
              if (!pragmaBindings.has(localName)) continue
              const binding = path.scope.getBinding(localName)
              if (!binding || binding.referenced) continue
              specifierPath.remove()
              removed = true
            }
            if (removed && statementPath.node.specifiers.length === 0) statementPath.remove()
          }
        },
      },
    },
  }
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
      if (typeScriptTransformOptions && typescriptOptions.onlyRemoveTypeImports !== true) {
        plugins.push(removeObsoleteJsxPragmaImportsPlugin(typescriptOptions))
      }
      if (typeScriptTransformOptions && typescriptOptions.rewriteImportExtensions) {
        plugins.push(rewriteTypeScriptImportsPlugin)
      }
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
        syntaxTypeScript,
        {
          isTSX,
          disallowAmbiguousJSXLike: typescriptOptions.disallowAmbiguousJSXLike ?? false,
        },
      ])
    } else {
      overrides.push(
        {
          test: TSX_FILENAME_RE,
          plugins: [[syntaxTypeScript, { isTSX: true }]],
        },
        {
          test: TS_FILENAME_RE,
          plugins: [[syntaxTypeScript, { isTSX: false }]],
        },
        {
          test: MTS_FILENAME_RE,
          sourceType: 'module',
          plugins: [
            [
              syntaxTypeScript,
              {
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            ],
          ],
        },
        {
          test: CTS_FILENAME_RE,
          sourceType: 'unambiguous',
          plugins: [
            [
              syntaxTypeScript,
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
  plugins.push([syntaxJsx, {}])

  // Compile Fict in `pre`, before sibling visitors in the outer Babel pass.
  plugins.push(createIsolatedFictPrepass(compilerOptions, typescript, typescriptOptions))

  return {
    plugins,
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(compilerOptions.sourcemap !== undefined ? { sourceMaps: compilerOptions.sourcemap } : {}),
  }
}

export { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
