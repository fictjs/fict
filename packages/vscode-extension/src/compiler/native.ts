import { loadNativeCompilerBinding, type NativeCompilerBinding } from '@fictjs/compiler/native'

export type NativeAnalyzer = Pick<NativeCompilerBinding, 'analyzeSync'>
export type NativeTransformer = Pick<NativeCompilerBinding, 'transformSync'>
export type EditorNativeCompiler = NativeAnalyzer & NativeTransformer

let compiler: EditorNativeCompiler | undefined

/** Load and cache one immutable native binding for the extension host process. */
export function getEditorNativeCompiler(): EditorNativeCompiler {
  compiler ??= loadNativeCompilerBinding(
    process.env.FICT_COMPILER_NATIVE_PATH
      ? { nativePath: process.env.FICT_COMPILER_NATIVE_PATH }
      : {},
  )
  return compiler
}

export function sourceLanguageForDocument(document: {
  languageId?: string
  fileName: string
}): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (document.languageId === 'typescriptreact') return 'tsx'
  if (document.languageId === 'javascriptreact') return 'jsx'
  if (document.languageId === 'typescript') return 'ts'
  if (document.languageId === 'javascript') return 'js'

  const cleanFileName = document.fileName.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (cleanFileName.endsWith('.tsx')) return 'tsx'
  if (cleanFileName.endsWith('.jsx')) return 'jsx'
  if (/\.(?:ts|mts|cts)$/.test(cleanFileName)) return 'ts'
  return 'js'
}
