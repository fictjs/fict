import type * as ts from 'typescript'

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
}

export function createFictTransformer(
  program: ts.Program,
  options: FictCompilerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      return transformSourceFile(sourceFile, context, program, options)
    }
  }
}

function transformSourceFile(
  sourceFile: ts.SourceFile,
  _context: ts.TransformationContext,
  _program: ts.Program,
  _options: FictCompilerOptions,
): ts.SourceFile {
  return sourceFile
}

export default createFictTransformer
