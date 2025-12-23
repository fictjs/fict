import { describe, expect, it } from 'vitest'
import {
  DiagnosticCode,
  DiagnosticSeverity,
  DiagnosticMessages,
  DiagnosticSeverities,
  getAllDiagnosticCodes,
  getDiagnosticInfo,
  createDiagnostic,
} from '../src/validation'
import * as t from '@babel/types'

describe('DiagnosticCode', () => {
  it('should have unique codes', () => {
    const codes = getAllDiagnosticCodes()
    const uniqueCodes = new Set(codes)
    expect(uniqueCodes.size).toBe(codes.length)
  })

  it('should have message for every code', () => {
    const codes = getAllDiagnosticCodes()
    for (const code of codes) {
      expect(DiagnosticMessages[code]).toBeDefined()
      expect(DiagnosticMessages[code].length).toBeGreaterThan(0)
    }
  })

  it('should have severity for every code', () => {
    const codes = getAllDiagnosticCodes()
    for (const code of codes) {
      expect(DiagnosticSeverities[code]).toBeDefined()
      expect(Object.values(DiagnosticSeverity)).toContain(DiagnosticSeverities[code])
    }
  })
})

describe('createDiagnostic', () => {
  it('should create diagnostic with correct fields', () => {
    const node = t.identifier('test')
    node.loc = {
      start: { line: 10, column: 5, index: 0 },
      end: { line: 10, column: 9, index: 4 },
      filename: 'test.tsx',
      identifierName: 'test',
    }

    const diagnostic = createDiagnostic(DiagnosticCode.FICT_S001, node, 'test.tsx')

    expect(diagnostic.code).toBe(DiagnosticCode.FICT_S001)
    expect(diagnostic.severity).toBe(DiagnosticSeverity.Error)
    expect(diagnostic.message).toBe(DiagnosticMessages[DiagnosticCode.FICT_S001])
    expect(diagnostic.fileName).toBe('test.tsx')
    expect(diagnostic.line).toBe(10)
    expect(diagnostic.column).toBe(5)
  })

  it('should include context when provided', () => {
    const node = t.identifier('x')
    const diagnostic = createDiagnostic(DiagnosticCode.FICT_P001, node, 'test.tsx', {
      propName: 'x',
    })

    expect(diagnostic.context).toEqual({ propName: 'x' })
  })
})

describe('getDiagnosticInfo', () => {
  it('should return info for valid code', () => {
    const info = getDiagnosticInfo(DiagnosticCode.FICT_C001)

    expect(info.code).toBe(DiagnosticCode.FICT_C001)
    expect(info.severity).toBe(DiagnosticSeverity.Error)
    expect(info.message).toContain('conditionally')
  })
})

describe('getAllDiagnosticCodes', () => {
  it('should return all diagnostic codes', () => {
    const codes = getAllDiagnosticCodes()

    // Should have all codes defined in the enum
    expect(codes.length).toBeGreaterThan(20)
    expect(codes).toContain(DiagnosticCode.FICT_P001)
    expect(codes).toContain(DiagnosticCode.FICT_X003)
  })
})
