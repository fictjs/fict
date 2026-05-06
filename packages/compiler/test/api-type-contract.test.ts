import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const dirname = path.dirname(fileURLToPath(import.meta.url))

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
}

describe('compiler API type contract', () => {
  it('typechecks public explain and minimizer APIs', () => {
    const fixture = path.join(dirname, 'fixtures/api-type-contract.ts')
    const compilerTypeDeclarations = [
      'babel-plugin-transform-destructuring.d.ts',
      'babel-plugin-transform-modules-commonjs.d.ts',
      'babel-preset-typescript.d.ts',
    ].map(fileName => path.join(dirname, '../src/types', fileName))
    const program = ts.createProgram({
      rootNames: [fixture, ...compilerTypeDeclarations],
      options: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        types: ['node'],
      },
    })

    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(formatDiagnostics(diagnostics)).toBe('')
  })
})
