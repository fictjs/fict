import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { getAllDiagnosticCodes } from '../src/validation'

const diagnosticCodePattern = /\bFICT-(?:[A-Z][0-9]{3}|[MH]|[A-Z]{2,}(?:-[A-Z0-9]+)*)\b/g

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8')
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
  for (const relativePath of [
    'packages/compiler/src/validation.ts',
    'packages/compiler/src/index.ts',
    'packages/compiler/src/tooling/analyze.ts',
  ]) {
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
