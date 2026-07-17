import {
  getEditorNativeCompiler,
  sourceLanguageForDocument,
  type NativeTransformer,
} from './native'

export interface CompilerDocument {
  fileName: string
  languageId?: string
  uri?: { toString(): string }
  getText(): string
}

/** Compile an editor document through the synchronous Rust/OXC entrypoint. */
export function compileDocumentSource(
  document: CompilerDocument,
  nativeCompiler?: NativeTransformer,
): string {
  const compiler = nativeCompiler ?? getEditorNativeCompiler()
  const result = compiler.transformSync({
    code: document.getText(),
    filename: document.fileName,
    moduleId: document.uri?.toString() || document.fileName,
    language: sourceLanguageForDocument(document),
    options: {
      dev: false,
      sourcemap: false,
      strictGuarantee: true,
    },
  })
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) {
    throw new Error(
      errors.map(diagnostic => `[${diagnostic.code}] ${diagnostic.message}`).join('\n'),
    )
  }

  return result.code || '// No compiler output generated.'
}
