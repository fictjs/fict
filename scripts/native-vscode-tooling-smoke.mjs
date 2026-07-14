#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const nativeCompilerPath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target', 'release', 'fict_compiler_napi.node'),
)
await access(nativeCompilerPath)
process.env.FICT_COMPILER_NATIVE_PATH = nativeCompilerPath

const require = createRequire(import.meta.url)
const { analyzeDocument, compileDocumentSource } = require(
  path.join(repositoryRoot, 'packages', 'vscode-extension', 'dist', 'tooling.cjs'),
)

function document(source, fileName = '/workspace/Counter.tsx') {
  return {
    languageId: fileName.endsWith('.tsx') ? 'typescriptreact' : 'typescript',
    fileName,
    uri: {
      fsPath: fileName,
      toString: () => `file://${fileName}`,
    },
    getText: () => source,
  }
}

const source = `
  import { $state } from 'fict'
  export function Counter() {
    const count = $state(0)
    return <button>{count}</button>
  }
`
const compiled = compileDocumentSource(document(source))
assert.match(compiled, /__fictUseSignal/)
assert.doesNotMatch(compiled, /\$state/)

const settings = {
  mode: 'compiler',
  verbosity: 'verbose',
  includeRegions: true,
  includeDiagnostics: true,
}
const analysis = await analyzeDocument(document(source), settings)
assert.equal(analysis.mode, 'compiler')
assert.deepEqual(analysis.diagnostics, [])
const counter = analysis.components.find(component => component.name === 'Counter')
assert.ok(counter)
assert.ok(counter.regions.length > 0)
assert.ok(counter.trace.some(line => line.markers.some(marker => marker.kind === 'reactive')))

const invalid = await analyzeDocument(
  document(
    `import { $state } from 'fict'
export function Broken() {
  const count = $state(0)
  return <div>{count}</div>
`,
    '/workspace/Broken.tsx',
  ),
  settings,
)
assert.deepEqual(
  invalid.diagnostics.map(({ code, severity, line, column }) => ({
    code,
    severity,
    line,
    hasColumn: column > 0,
  })),
  [{ code: 'FICT-PARSE', severity: 'error', line: 5, hasColumn: true }],
)

process.stdout.write(
  `${JSON.stringify({
    backend: 'rust',
    compiledBytes: compiled.length,
    components: analysis.components.length,
    regions: counter.regions.length,
    parserDiagnostic: invalid.diagnostics[0].code,
  })}\n`,
)
