import { describe, expect, it } from 'vitest'
import * as t from '@babel/types'

import { collectExpressionIdentifiersDeep } from '../src/ir/codegen-reactive-accessors'
import type { BasicBlock, Expression, Identifier } from '../src/ir/hir'

const id = (name: string): Identifier => ({ kind: 'Identifier', name })
const literal = (value: string | number | boolean | null | undefined): Expression => ({
  kind: 'Literal',
  value,
})

function returnBlock(argument: Expression): BasicBlock[] {
  return [
    {
      id: 0,
      instructions: [],
      terminator: { kind: 'Return', argument },
    },
  ]
}

function arrow(body: Expression): Expression {
  return {
    kind: 'ArrowFunction',
    params: [],
    body,
    isExpression: true,
  }
}

function fn(body: Expression): Expression {
  return {
    kind: 'FunctionExpression',
    params: [],
    body: returnBlock(body),
  }
}

function depsOf(expr: Expression): Set<string> {
  const deps = new Set<string>()
  collectExpressionIdentifiersDeep(expr, deps)
  return deps
}

describe('collectExpressionIdentifiersDeep', () => {
  it('treats object and array function entries as lazy initializer boundaries', () => {
    const objectExpr: Expression = {
      kind: 'ObjectExpression',
      properties: [
        {
          kind: 'Property',
          key: id('computedKey'),
          computed: true,
          value: literal(1),
        },
        {
          kind: 'Property',
          key: id('method'),
          propertyKind: 'method',
          value: fn(id('methodDep')),
        },
        {
          kind: 'Property',
          key: id('current'),
          propertyKind: 'get',
          value: fn(id('getterDep')),
        },
        {
          kind: 'Property',
          key: id('current'),
          propertyKind: 'set',
          value: {
            kind: 'FunctionExpression',
            params: [id('value')],
            body: returnBlock(id('setterDep')),
          },
        },
        {
          kind: 'Property',
          key: id('arrow'),
          value: arrow(id('arrowDep')),
        },
        {
          kind: 'Property',
          key: id('fn'),
          value: fn(id('fnDep')),
        },
        {
          kind: 'Property',
          key: id('eager'),
          value: id('eagerDep'),
        },
        {
          kind: 'SpreadElement',
          argument: id('spreadDep'),
        },
        {
          kind: 'Property',
          key: id('called'),
          value: {
            kind: 'CallExpression',
            callee: arrow(id('calledDep')),
            arguments: [],
          },
        },
      ],
    }

    expect(depsOf(objectExpr)).toEqual(
      new Set(['computedKey', 'eagerDep', 'spreadDep', 'calledDep']),
    )

    const arrayExpr: Expression = {
      kind: 'ArrayExpression',
      elements: [
        arrow(id('arrayArrowDep')),
        fn(id('arrayFnDep')),
        id('arrayEagerDep'),
        {
          kind: 'CallExpression',
          callee: arrow(id('arrayCalledDep')),
          arguments: [],
        },
      ],
    }

    expect(depsOf(arrayExpr)).toEqual(new Set(['arrayEagerDep', 'arrayCalledDep']))
  })

  it('tracks class definition-time dependencies without scanning method bodies', () => {
    const classExpr: Expression = {
      kind: 'ClassExpression',
      superClass: id('Base'),
      body: [
        t.classMethod(
          'method',
          t.identifier('methodKey'),
          [],
          t.blockStatement([t.returnStatement(t.identifier('methodBodyDep'))]),
          true,
        ),
        t.classProperty(t.identifier('fieldKey'), t.identifier('instanceFieldDep'), null, [], true),
        t.classProperty(t.identifier('staticValue'), t.identifier('staticDep'), null, []),
        t.staticBlock([
          t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier('staticBlockLocal'), t.identifier('staticBlockDep')),
          ]),
          t.expressionStatement(t.identifier('staticBlockLocal')),
        ]),
      ],
    }
    ;(classExpr.body[2] as { static?: boolean }).static = true

    expect(depsOf(classExpr)).toEqual(
      new Set(['Base', 'methodKey', 'fieldKey', 'staticDep', 'staticBlockDep']),
    )
  })
})
