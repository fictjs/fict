import { describe, expect, it } from 'vitest'
import {
  DiagnosticCode,
  DiagnosticSeverity,
  DiagnosticMessages,
  DiagnosticSeverities,
  getAllDiagnosticCodes,
  getDiagnosticInfo,
  createDiagnostic,
  validateFunction,
  validateListKeys,
  validateNoConditionalHooks,
} from '../src/validation'
import type { TransformContext } from '../src/types'
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

describe('rule validations', () => {
  const ctx = {
    file: { opts: { filename: 'test.tsx' } },
  } as unknown as TransformContext

  it('reports conditional hook calls (FICT_C001)', () => {
    const call = t.callExpression(t.identifier('useMemo'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const ifNode = t.ifStatement(t.identifier('flag'), t.blockStatement([]))
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [ifNode])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_C001)
  })

  it('reports loop hook calls (FICT_C002)', () => {
    const call = t.callExpression(t.identifier('useEffect'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const loop = t.whileStatement(t.identifier('flag'), t.blockStatement([]))
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [loop])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_C002)
  })

  it('reports hook calls in logical right branches (FICT_C001)', () => {
    const call = t.callExpression(t.identifier('useEffect'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const logical = t.logicalExpression('&&', t.identifier('flag'), call)
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [logical])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_C001)
  })

  it('reports hook calls in logical OR right branches (FICT_C001)', () => {
    const call = t.callExpression(t.identifier('useEffect'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const logical = t.logicalExpression('||', t.identifier('flag'), call)
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [logical])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_C001)
  })

  it('reports hook calls in nullish-coalescing right branches (FICT_C001)', () => {
    const call = t.callExpression(t.identifier('useEffect'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const logical = t.logicalExpression('??', t.identifier('flag'), call)
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [logical])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_C001)
  })

  it('does not report hook calls in logical left branches', () => {
    const call = t.callExpression(t.identifier('useEffect'), [
      t.arrowFunctionExpression([], t.nullLiteral()),
    ])
    const logical = t.logicalExpression('&&', call, t.identifier('flag'))
    const diagnostic = validateNoConditionalHooks(call, ctx, t, [logical])
    expect(diagnostic).toBeNull()
  })

  it('reports missing list keys inside map callbacks (FICT_J002)', () => {
    const jsx = t.jsxElement(
      t.jsxOpeningElement(t.jsxIdentifier('li'), [], false),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.identifier('item'))],
      false,
    )
    const callback = t.arrowFunctionExpression([t.identifier('item')], jsx)
    const mapCall = t.callExpression(
      t.memberExpression(t.identifier('items'), t.identifier('map')),
      [callback],
    )
    const diagnostic = validateListKeys(jsx, ctx, t, [mapCall, callback])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_J002)
  })

  it('does not report keyed list items inside map callbacks', () => {
    const keyed = t.jsxElement(
      t.jsxOpeningElement(
        t.jsxIdentifier('li'),
        [t.jsxAttribute(t.jsxIdentifier('key'), t.jsxExpressionContainer(t.identifier('item')))],
        false,
      ),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.identifier('item'))],
      false,
    )
    const callback = t.arrowFunctionExpression([t.identifier('item')], keyed)
    const mapCall = t.callExpression(
      t.memberExpression(t.identifier('items'), t.identifier('map')),
      [callback],
    )
    const diagnostic = validateListKeys(keyed, ctx, t, [mapCall, callback])
    expect(diagnostic).toBeNull()
  })

  it('collects diagnostics across function body validation', () => {
    const listItem = t.jsxElement(
      t.jsxOpeningElement(t.jsxIdentifier('li'), [], false),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.identifier('item'))],
      false,
    )
    const mapCallback = t.arrowFunctionExpression([t.identifier('item')], listItem)
    const rowsDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('rows'),
        t.callExpression(t.memberExpression(t.identifier('items'), t.identifier('map')), [
          mapCallback,
        ]),
      ),
    ])
    const button = t.jsxElement(
      t.jsxOpeningElement(
        t.jsxIdentifier('button'),
        [
          t.jsxAttribute(
            t.jsxIdentifier('onClick'),
            t.jsxExpressionContainer(
              t.arrowFunctionExpression(
                [],
                t.memberExpression(t.identifier('rows'), t.identifier('length')),
              ),
            ),
          ),
        ],
        false,
      ),
      t.jsxClosingElement(t.jsxIdentifier('button')),
      [t.jsxText('Click')],
      false,
    )
    const fn = t.functionDeclaration(
      t.identifier('App'),
      [],
      t.blockStatement([
        t.ifStatement(
          t.identifier('flag'),
          t.blockStatement([
            t.expressionStatement(
              t.callExpression(t.identifier('useEffect'), [
                t.arrowFunctionExpression([], t.blockStatement([])),
              ]),
            ),
          ]),
        ),
        rowsDecl,
        t.returnStatement(button),
      ]),
    )
    const diagnostics = validateFunction(fn, ctx, t)
    const codes = diagnostics.map(d => d.code)
    expect(codes).toContain(DiagnosticCode.FICT_C001)
    expect(codes).toContain(DiagnosticCode.FICT_J002)
    expect(codes).toContain(DiagnosticCode.FICT_X003)
  })

  it('does not report outer conditional context for hooks inside nested functions', () => {
    const nestedFn = t.arrowFunctionExpression(
      [],
      t.callExpression(t.identifier('useEffect'), [
        t.arrowFunctionExpression([], t.blockStatement([])),
      ]),
    )
    const fn = t.functionDeclaration(
      t.identifier('App'),
      [],
      t.blockStatement([
        t.ifStatement(
          t.identifier('flag'),
          t.blockStatement([
            t.variableDeclaration('const', [
              t.variableDeclarator(t.identifier('runner'), nestedFn),
            ]),
          ]),
        ),
      ]),
    )
    const diagnostics = validateFunction(fn, ctx, t)
    expect(diagnostics.some(d => d.code === DiagnosticCode.FICT_C001)).toBe(false)
    expect(diagnostics.some(d => d.code === DiagnosticCode.FICT_C002)).toBe(false)
  })

  it('reports missing list keys for block-bodied map callback returns', () => {
    const listItem = t.jsxElement(
      t.jsxOpeningElement(t.jsxIdentifier('li'), [], false),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.identifier('item'))],
      false,
    )
    const mapCallback = t.arrowFunctionExpression(
      [t.identifier('item')],
      t.blockStatement([t.returnStatement(listItem)]),
    )
    const fn = t.functionDeclaration(
      t.identifier('App'),
      [],
      t.blockStatement([
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('rows'),
            t.callExpression(t.memberExpression(t.identifier('items'), t.identifier('map')), [
              mapCallback,
            ]),
          ),
        ]),
      ]),
    )

    const diagnostics = validateFunction(fn, ctx, t)
    expect(diagnostics.some(d => d.code === DiagnosticCode.FICT_J002)).toBe(true)
  })
})
