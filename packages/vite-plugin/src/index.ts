import { createFictTransformer, type FictCompilerOptions } from 'fict-compiler-ts'
import ts from 'typescript'
import type { Plugin, TransformResult } from 'vite'

export interface FictPluginOptions extends FictCompilerOptions {
  include?: string[]
  exclude?: string[]
}

export default function fict(options: FictPluginOptions = {}): Plugin {
  const {
    include = ['**/*.tsx', '**/*.jsx'],
    exclude = ['**/node_modules/**'],
    ...compilerOptions
  } = options

  return {
    name: 'vite-plugin-fict',

    enforce: 'pre',

    config() {
      return {
        esbuild: {
          jsx: 'preserve',
        },
      }
    },

    transform(code: string, id: string): TransformResult | null {
      if (!shouldTransform(id, include, exclude)) {
        return null
      }

      const compilerOpts: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        jsx: ts.JsxEmit.Preserve,
        jsxImportSource: 'fict',
        sourceMap: compilerOptions.sourcemap ?? true,
      }

      const result = ts.transpileModule(code, {
        compilerOptions: compilerOpts,
        fileName: id,
        transformers: {
          before: [createFictTransformer(null, compilerOptions)],
        },
      })

      return {
        code: result.outputText,
        map: result.sourceMapText ? JSON.parse(result.sourceMapText) : null,
      }
    },
  }
}

function shouldTransform(id: string, include: string[], exclude: string[]): boolean {
  if (exclude.some(pattern => id.includes(pattern.replace('**/', '')))) {
    return false
  }
  return include.some(pattern => {
    const ext = pattern.replace('**/*', '')
    return id.endsWith(ext)
  })
}
