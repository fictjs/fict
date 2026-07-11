/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const ts = require('typescript')

module.exports = function lowerTypeScriptDecorators(source) {
  const { legacy = false } = this.getOptions()
  const result = ts.transpileModule(String(source), {
    fileName: this.resourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      experimentalDecorators: legacy,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      useDefineForClassFields: true,
    },
  })
  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    throw new Error(
      errors
        .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n'),
    )
  }
  return result.outputText
}
