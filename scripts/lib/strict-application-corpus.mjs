import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import ts from 'typescript'

export const CORPUS_APPLICATIONS = [
  { id: 'counter-basic', category: 'application', tier: 'Core', files: ['main.tsx'] },
  {
    id: 'counter-webpack',
    category: 'application',
    tier: 'Core',
    bundler: 'webpack',
    files: ['main.tsx'],
  },
  { id: 'todos', category: 'application', tier: 'Core', files: ['main.tsx'] },
  { id: 'forms', category: 'application', tier: 'Core', files: ['main.tsx'] },
  { id: 'async-data', category: 'application', tier: 'Core', files: ['main.tsx'] },
  { id: 'real-apps', category: 'application', tier: 'Core', files: ['main.tsx'] },
  {
    id: 'ssr-basic',
    category: 'application',
    tier: 'Preview resumability',
    files: ['App.tsx', 'entry-client.tsx', 'entry-server.tsx'],
    ssr: true,
  },
  {
    id: 'ssr-streaming',
    category: 'application',
    tier: 'Core',
    files: ['App.tsx', 'entry-client.ts', 'entry-server.tsx'],
    ssr: true,
  },
  {
    id: 'fict-library',
    category: 'library publisher',
    tier: 'Core',
    files: ['index.ts', 'toggle.ts'],
  },
]

export const sha256 = value => createHash('sha256').update(value).digest('hex')

const publicApis = new Map([
  [
    'fict',
    [
      '$state',
      '$store',
      '$memo',
      '$effect',
      '$async',
      'useTransition',
      'untrack',
      'batch',
      'createMemo',
      'createEffect',
      'createSelector',
    ],
  ],
  ['fict/plus', ['resource', '$store', '$memo']],
  [
    'fict/advanced',
    ['reactive', 'createSignal', 'createSelector', 'createAsyncMemo', 'createAsyncEffect'],
  ],
  ['@fictjs/runtime', ['untrack', 'batch', 'createMemo', 'createEffect', 'useTransition']],
  [
    '@fictjs/runtime/advanced',
    ['reactive', 'createSignal', 'createSelector', 'createAsyncMemo', 'createAsyncEffect'],
  ],
])
const unwrap = node => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression
  }
  return node
}

// This is source incidence, not a semantic proof or an estimate of allocated nodes.
// Resolve lexical symbols so shadowed names, strings and unrelated packages do not count.
export function sourceMetrics(code, filename = 'input.tsx') {
  const file = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true)
  assert.equal(file.parseDiagnostics.length, 0, `Cannot measure invalid source: ${filename}`)
  const host = {
    getSourceFile: name => (name === filename ? file : undefined),
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: name => name === filename,
    readFile: name => (name === filename ? code : undefined),
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram([filename], { noLib: true, noResolve: true }, host)
  const checker = program.getTypeChecker()
  function identity(expression, seen = new Set()) {
    const node = unwrap(expression)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = identity(node.expression, seen)
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined
      return base?.namespace && name ? { module: base.module, name } : undefined
    }
    if (!ts.isIdentifier(node)) return undefined
    const symbol = checker.getSymbolAtLocation(node)
    if (!symbol || seen.has(symbol)) return undefined
    const nextSeen = new Set(seen).add(symbol)
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    if (declaration && ts.isImportSpecifier(declaration)) {
      const clause = declaration.parent.parent
      if (declaration.isTypeOnly || clause.isTypeOnly) return undefined
      return {
        module: clause.parent.moduleSpecifier.text,
        name: (declaration.propertyName ?? declaration.name).text,
      }
    }
    if (declaration && ts.isNamespaceImport(declaration)) {
      if (declaration.parent.isTypeOnly) return undefined
      return { module: declaration.parent.parent.moduleSpecifier.text, namespace: true }
    }
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      return identity(declaration.initializer, nextSeen)
    }
    return undefined
  }

  const tokenLines = new Set()
  const functionBodyLines = new Set()
  const callSites = []
  let totalCalls = 0
  function visit(node, inFunction = false) {
    if (ts.isJSDoc(node)) return
    if (ts.isCallExpression(node)) {
      totalCalls += 1
      const api = identity(node.expression)
      if (api && publicApis.get(api.module)?.includes(api.name)) {
        const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
        callSites.push({
          api: api.name,
          module: api.module,
          line: line + 1,
          column: character + 1,
          inFunction,
        })
      }
    }
    const children = node.getChildren(file)
    if (children.length === 0 && node.kind !== ts.SyntaxKind.EndOfFileToken) {
      const start = node.getStart(file)
      const end = node.end
      if (end > start && code.slice(start, end).trim()) {
        const firstLine = file.getLineAndCharacterOfPosition(start).line
        const lastLine = file.getLineAndCharacterOfPosition(end - 1).line
        for (let line = firstLine; line <= lastLine; line += 1) {
          tokenLines.add(line)
          if (inFunction) functionBodyLines.add(line)
        }
      }
    }
    for (const child of children) {
      visit(child, inFunction || (ts.isFunctionLike(node) && node.body === child))
    }
  }
  visit(file)
  const counts = {}
  for (const { api } of callSites) counts[api] = (counts[api] ?? 0) + 1
  return {
    lexicalCodeLines: tokenLines.size,
    functionBodyCodeLines: functionBodyLines.size,
    totalCalls,
    identifiedApiCalls: callSites.length,
    counts,
    explicitSnapshots: counts.untrack ?? 0,
    snapshotsInsideFunctions: callSites.filter(site => site.api === 'untrack' && site.inFunction)
      .length,
    callSites,
  }
}

export function summarizeMetrics(sources) {
  const result = {
    sourceFiles: sources.length,
    lexicalCodeLines: 0,
    functionBodyCodeLines: 0,
    explicitSnapshots: 0,
    snapshotsInsideFunctions: 0,
    counts: {},
  }
  for (const { metrics } of sources) {
    for (const key of [
      'lexicalCodeLines',
      'functionBodyCodeLines',
      'explicitSnapshots',
      'snapshotsInsideFunctions',
    ]) {
      result[key] += metrics[key]
    }
    for (const [api, count] of Object.entries(metrics.counts)) {
      result.counts[api] = (result.counts[api] ?? 0) + count
    }
  }
  result.snapshotsPerThousandCodeLines = result.lexicalCodeLines
    ? (result.explicitSnapshots * 1000) / result.lexicalCodeLines
    : null
  result.snapshotsPerThousandFunctionBodyCodeLines = result.functionBodyCodeLines
    ? (result.snapshotsInsideFunctions * 1000) / result.functionBodyCodeLines
    : null
  return result
}

export function summarizeBuild(records, { expectedSources, compilerBuildId, root }) {
  const transforms = records.filter(record => record.method.startsWith('transform'))
  assert.ok(transforms.length, 'No observed native transforms: stale cache or capture bypass')
  const complete = []
  for (const record of records) {
    assert.equal(record.error, undefined, 'Native invocation threw')
    if (/^(transform|analyze)/.test(record.method)) {
      const options = record.method.startsWith('analyze')
        ? record.request.options?.compilerOptions
        : record.request.options
      assert.equal(options?.strictGuarantee, true, 'Strict policy was bypassed')
      assert.equal(options?.dev, false, 'A development compile entered the corpus')
      assert.ok(
        record.result?.diagnostics.every(
          diagnostic => diagnostic.severity !== 'error' && diagnostic.guaranteeClass === 'advisory',
        ),
        `Invalid guarantee diagnostics: ${JSON.stringify(record.result?.diagnostics)}`,
      )
    }
    if (!record.method.startsWith('transform')) continue
    assert.equal(record.result?.compilerBuildId, compilerBuildId, 'Compiler identity changed')
    assert.equal(record.result.internalError ?? null, null, 'Compiler internal error')
    assert.equal(
      record.result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
      0,
      JSON.stringify(record.result.diagnostics),
    )
    assert.ok(
      record.result.diagnostics.every(diagnostic => diagnostic.guaranteeClass === 'advisory'),
      'A non-advisory guarantee diagnostic entered the corpus',
    )
    if (!record.result.metadataIncomplete) complete.push(record)
  }
  for (const [filename, code] of Object.entries(expectedSources)) {
    const matches = complete.filter(record => path.resolve(record.request.filename) === filename)
    assert.ok(matches.length, `No final native output for ${filename}`)
    assert.ok(
      matches.every(record => record.request.code === code),
      `Source drift: ${filename}`,
    )
    assert.ok(
      matches.every(record => record.result.code?.length),
      `Missing code: ${filename}`,
    )
  }
  const diagnostics = new Map()
  for (const record of transforms) {
    for (const diagnostic of record.result.diagnostics) {
      const item = { file: path.relative(root, record.request.filename), ...diagnostic }
      diagnostics.set(JSON.stringify(item), item)
    }
  }
  return {
    requests: Object.fromEntries(
      ['scan', 'analyze', 'transform'].map(method => [
        method,
        records.filter(record => record.method.startsWith(method)).length,
      ]),
    ),
    diagnostics: [...diagnostics.values()],
    compilations: transforms.map(record => ({
      file: path.relative(root, record.request.filename),
      sourceSha256: sha256(record.request.code),
      outputSha256: sha256(record.result.code ?? ''),
      options: record.request.options,
      metadataIncomplete: Boolean(record.result.metadataIncomplete),
      unresolvedMetadataRequests: record.result.unresolvedMetadataRequests,
      metadata: record.request.metadata,
      moduleMetadata: record.result.moduleMetadata,
      compilerBuildId: record.result.compilerBuildId,
    })),
  }
}
