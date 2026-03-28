import { describe, expect, it } from 'vitest'
import {
  DiagnosticCode,
  DiagnosticSeverity,
  DiagnosticMessages,
  DiagnosticSeverities,
  getAllDiagnosticCodes,
  getDiagnosticInfo,
  createDiagnostic,
  reportDiagnostic,
  validateFunction,
  validateListKeys,
  validateNoInlineFunctions,
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

  it('exposes strict-by-default severities for guarantee diagnostics', () => {
    expect(DiagnosticSeverities[DiagnosticCode.FICT_P001]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_S002]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_J003]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_R006]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_M]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_H]).toBe(DiagnosticSeverity.Error)
  })

  it('keeps non-guarantee defaults unchanged in exported severities', () => {
    expect(DiagnosticSeverities[DiagnosticCode.FICT_C001]).toBe(DiagnosticSeverity.Error)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_M001]).toBe(DiagnosticSeverity.Info)
    expect(DiagnosticSeverities[DiagnosticCode.FICT_X003]).toBe(DiagnosticSeverity.Hint)
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
    expect(diagnostic.column).toBe(6)
    expect(diagnostic.endColumn).toBe(10)
  })

  it('should include context when provided', () => {
    const node = t.identifier('x')
    const diagnostic = createDiagnostic(DiagnosticCode.FICT_P001, node, 'test.tsx', {
      propName: 'x',
    })

    expect(diagnostic.context).toEqual({ propName: 'x' })
  })

  it('uses effective compiler defaults for guarantee diagnostic severity', () => {
    const node = t.identifier('value')
    const diagnostic = createDiagnostic(DiagnosticCode.FICT_P001, node, 'test.tsx')

    expect(diagnostic.severity).toBe(DiagnosticSeverity.Error)
  })

  it('respects strictGuarantee opt-out in created diagnostics', () => {
    const node = t.identifier('value')
    const diagnostic = createDiagnostic(DiagnosticCode.FICT_P001, node, 'test.tsx', undefined, {
      strictGuarantee: false,
    })

    expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning)
  })

  it('reports diagnostics with 1-based warning columns', () => {
    const node = t.identifier('warn')
    node.loc = {
      start: { line: 3, column: 2, index: 0 },
      end: { line: 3, column: 6, index: 4 },
      filename: 'test.tsx',
      identifierName: 'warn',
    }

    const warnings: Array<{ line: number; column: number }> = []
    reportDiagnostic(
      {
        file: { opts: { filename: 'test.tsx' } },
        options: {
          filename: 'test.tsx',
          onWarn: warning => warnings.push({ line: warning.line, column: warning.column }),
        },
      },
      DiagnosticCode.FICT_S001,
      node,
    )

    expect(warnings).toEqual([{ line: 3, column: 3 }])
  })

  it('reports effective severity through diagnostic context options', () => {
    const node = t.identifier('warn')
    node.loc = {
      start: { line: 4, column: 1, index: 0 },
      end: { line: 4, column: 5, index: 4 },
      filename: 'test.tsx',
      identifierName: 'warn',
    }

    const warnings: Array<{ code: string; line: number; column: number }> = []
    reportDiagnostic(
      {
        file: { opts: { filename: 'test.tsx' } },
        options: {
          filename: 'test.tsx',
          strictGuarantee: true,
          onWarn: warning => warnings.push(warning),
        },
      },
      DiagnosticCode.FICT_P001,
      node,
    )

    expect(warnings).toEqual([
      {
        code: 'FICT-P001',
        message: 'Props destructuring falls back to non-reactive binding.',
        fileName: 'test.tsx',
        line: 4,
        column: 2,
      },
    ])
  })
})

describe('getDiagnosticInfo', () => {
  it('should return info for valid code', () => {
    const info = getDiagnosticInfo(DiagnosticCode.FICT_C001)

    expect(info.code).toBe(DiagnosticCode.FICT_C001)
    expect(info.severity).toBe(DiagnosticSeverity.Error)
    expect(info.message).toContain('conditionally')
  })

  it('returns info for reactive control-flow re-execution warnings', () => {
    const info = getDiagnosticInfo(DiagnosticCode.FICT_R006)

    expect(info.code).toBe(DiagnosticCode.FICT_R006)
    expect(info.severity).toBe(DiagnosticSeverity.Error)
    expect(info.message).toContain('control-flow')
    expect(info.message).toContain('region re-execution')
  })

  it('returns info for legacy compiler diagnostics', () => {
    const mutationInfo = getDiagnosticInfo(DiagnosticCode.FICT_M)
    const dynamicAccessInfo = getDiagnosticInfo(DiagnosticCode.FICT_H)
    const hirUnsupportedInfo = getDiagnosticInfo(DiagnosticCode.FICT_HIR_UNSUPPORTED)

    expect(mutationInfo.severity).toBe(DiagnosticSeverity.Error)
    expect(mutationInfo.message).toContain('nested $state')

    expect(dynamicAccessInfo.severity).toBe(DiagnosticSeverity.Error)
    expect(dynamicAccessInfo.message).toContain('dependency tracking')

    expect(hirUnsupportedInfo.severity).toBe(DiagnosticSeverity.Error)
    expect(hirUnsupportedInfo.message).toContain('HIR conversion')
  })

  it('returns warning severity when strictGuarantee is disabled', () => {
    const info = getDiagnosticInfo(DiagnosticCode.FICT_P002, { strictGuarantee: false })

    expect(info.severity).toBe(DiagnosticSeverity.Warning)
    expect(info.message).toContain('non-reactive binding')
  })

  it('returns error severity when strictReactivity is enabled', () => {
    const info = getDiagnosticInfo(DiagnosticCode.FICT_R003, {
      strictGuarantee: false,
      strictReactivity: true,
    })

    expect(info.severity).toBe(DiagnosticSeverity.Error)
    expect(info.message).toContain('memoized')
  })
})

describe('getAllDiagnosticCodes', () => {
  it('should return all diagnostic codes', () => {
    const codes = getAllDiagnosticCodes()

    // Should have all codes defined in the enum
    expect(codes.length).toBeGreaterThan(20)
    expect(codes).toContain(DiagnosticCode.FICT_H)
    expect(codes).toContain(DiagnosticCode.FICT_M)
    expect(codes).toContain(DiagnosticCode.FICT_HIR_UNSUPPORTED)
    expect(codes).toContain(DiagnosticCode.FICT_P001)
    expect(codes).toContain(DiagnosticCode.FICT_R006)
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

  it('reports spread-only list items inside map callbacks', () => {
    const spreadOnly = t.jsxElement(
      t.jsxOpeningElement(
        t.jsxIdentifier('li'),
        [t.jsxSpreadAttribute(t.identifier('item'))],
        false,
      ),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.memberExpression(t.identifier('item'), t.identifier('name')))],
      false,
    )
    const callback = t.arrowFunctionExpression([t.identifier('item')], spreadOnly)
    const mapCall = t.callExpression(
      t.memberExpression(t.identifier('items'), t.identifier('map')),
      [callback],
    )
    const diagnostic = validateListKeys(spreadOnly, ctx, t, [mapCall, callback])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_J002)
  })

  it('reports index-based list keys inside map callbacks (FICT-J001)', () => {
    const keyed = t.jsxElement(
      t.jsxOpeningElement(
        t.jsxIdentifier('li'),
        [t.jsxAttribute(t.jsxIdentifier('key'), t.jsxExpressionContainer(t.identifier('index')))],
        false,
      ),
      t.jsxClosingElement(t.jsxIdentifier('li')),
      [t.jsxExpressionContainer(t.identifier('item'))],
      false,
    )
    const callback = t.arrowFunctionExpression([t.identifier('item'), t.identifier('index')], keyed)
    const mapCall = t.callExpression(
      t.memberExpression(t.identifier('items'), t.identifier('map')),
      [callback],
    )
    const diagnostic = validateListKeys(keyed, ctx, t, [mapCall, callback])
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_J001)
  })

  it('reports native element spread diagnostics during function validation', () => {
    const fn = t.functionDeclaration(
      t.identifier('App'),
      [],
      t.blockStatement([
        t.returnStatement(
          t.jsxElement(
            t.jsxOpeningElement(
              t.jsxIdentifier('div'),
              [t.jsxSpreadAttribute(t.identifier('props'))],
              false,
            ),
            t.jsxClosingElement(t.jsxIdentifier('div')),
            [],
            false,
          ),
        ),
      ]),
    )

    const diagnostics = validateFunction(fn, ctx, t)
    expect(diagnostics.some(d => d.code === DiagnosticCode.FICT_J003)).toBe(true)
  })

  it('does not report native element spread diagnostics for component spreads', () => {
    const fn = t.functionDeclaration(
      t.identifier('App'),
      [],
      t.blockStatement([
        t.returnStatement(
          t.jsxElement(
            t.jsxOpeningElement(
              t.jsxIdentifier('Widget'),
              [t.jsxSpreadAttribute(t.identifier('props'))],
              true,
            ),
            null,
            [],
            true,
          ),
        ),
      ]),
    )

    const diagnostics = validateFunction(fn, ctx, t)
    expect(diagnostics.some(d => d.code === DiagnosticCode.FICT_J003)).toBe(false)
  })

  it('reports non-event inline JSX function props', () => {
    const attr = t.jsxAttribute(
      t.jsxIdentifier('renderLabel'),
      t.jsxExpressionContainer(t.arrowFunctionExpression([], t.identifier('label'))),
    )

    const diagnostic = validateNoInlineFunctions(attr, ctx, t)
    expect(diagnostic?.code).toBe(DiagnosticCode.FICT_X003)
  })

  it('does not report inline DOM event handler props', () => {
    const attr = t.jsxAttribute(
      t.jsxIdentifier('onClick'),
      t.jsxExpressionContainer(t.arrowFunctionExpression([], t.identifier('handleClick'))),
    )

    const diagnostic = validateNoInlineFunctions(attr, ctx, t)
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
            t.jsxIdentifier('renderLabel'),
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
