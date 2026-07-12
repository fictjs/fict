import ts from 'typescript'

const legacyLoaderSpecifiers = [
  ['fict', 'loader'].join('/'),
  ['@fictjs', 'runtime', 'loader'].join('/'),
]

export function hasLegacyLoaderReference(source) {
  const normalized = source
    .replace(/\\+\//g, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u\{0*2f\}/gi, '/')

  return legacyLoaderSpecifiers.some(specifier => normalized.includes(specifier))
}

function exportedNames(statement, sourceFile) {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    if (!clause) return ['*']
    if (ts.isNamespaceExport(clause)) return [clause.name.text]
    return clause.elements.map(element => element.name.text)
  }

  if (ts.isExportAssignment(statement)) return ['default']
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map(declaration =>
      declaration.name.getText(sourceFile),
    )
  }

  const name = statement.name
  return name ? [name.getText(sourceFile)] : ['default']
}

function isExported(statement) {
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return true
  return (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

export function findUndocumentedExperimentalExports(source, filename = 'preview.ts') {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const missing = []

  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue
    const experimental = ts.getJSDocTags(statement).some(tag => tag.tagName.text === 'experimental')
    if (!experimental) missing.push(...exportedNames(statement, sourceFile))
  }

  return missing
}
