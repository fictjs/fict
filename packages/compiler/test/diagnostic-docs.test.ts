import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { getAllDiagnosticCodes } from '../src/validation'

const diagnosticCodePattern = /\bFICT-(?:[A-Z][0-9]{3}|[MH]|[A-Z]{2,}(?:-[A-Z0-9]+)*)\b/g
const projectRoot = new URL('../../../', import.meta.url)

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, projectRoot), 'utf8')
}

function compilerSourceFiles(relativeDir = 'packages/compiler/src'): string[] {
  return readdirSync(new URL(`${relativeDir}/`, projectRoot), { withFileTypes: true }).flatMap(
    entry => {
      const childPath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) return compilerSourceFiles(childPath)
      return entry.isFile() && entry.name.endsWith('.ts') ? [childPath] : []
    },
  )
}

function documentedDiagnosticCodes(): Set<string> {
  const docs = readProjectFile('docs/diagnostic-codes.md')
  const codes = new Set<string>()
  for (const match of docs.matchAll(/^### (FICT-[A-Z0-9-]+):/gm)) {
    if (match[1]) codes.add(match[1])
  }
  return codes
}

function sourceDiagnosticCodes(): Set<string> {
  const codes = new Set<string>(getAllDiagnosticCodes())
  for (const relativePath of compilerSourceFiles()) {
    const source = readProjectFile(relativePath)
    for (const match of source.matchAll(diagnosticCodePattern)) {
      if (match[0]) codes.add(match[0])
    }
  }
  return codes
}

describe('diagnostic code documentation', () => {
  it('documents every emitted compiler diagnostic code', () => {
    const documented = documentedDiagnosticCodes()
    const missing = [...sourceDiagnosticCodes()]
      .filter(code => !documented.has(code))
      .sort((left, right) => left.localeCompare(right))

    expect(missing).toEqual([])
  })
})
