import { describe, expect, it } from 'vitest'
import { collectExpressionDependencies } from '../src/ir/codegen-expression-deps'
import type { BasicBlock, Expression, Identifier } from '../src/ir/hir'

const id = (name: string): Identifier => ({ kind: 'Identifier', name })
const literal = (value: string | number | boolean | null | undefined): Expression => ({
  kind: 'Literal',
  value,
})

function depsOf(expr: Expression): Set<string> {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)
  return deps
}

describe('collectExpressionDependencies', () => {
  it('collects optional member chains with normalized dependency paths', () => {
    const expr: Expression = {
      kind: 'OptionalMemberExpression',
      object: {
        kind: 'OptionalMemberExpression',
        object: id('user'),
        property: id('profile'),
        computed: false,
        optional: true,
      },
      property: id('name'),
      computed: false,
      optional: true,
    }

    const deps = depsOf(expr)

    expect(deps.has('user')).toBe(true)
    expect(deps.has('user.profile')).toBe(true)
    expect(deps.has('user.profile.name')).toBe(true)
    expect(Array.from(deps).some(dep => dep.includes('?.'))).toBe(false)
  })

  it('covers optional call / sequence / await / new / spread / assignment / update / tagged / yield', () => {
    const expr: Expression = {
      kind: 'SequenceExpression',
      expressions: [
        {
          kind: 'OptionalCallExpression',
          callee: id('maybeCall'),
          arguments: [id('callArg')],
          optional: true,
        },
        {
          kind: 'AwaitExpression',
          argument: id('awaited'),
        },
        {
          kind: 'NewExpression',
          callee: id('Ctor'),
          arguments: [id('ctorArg')],
        },
        {
          kind: 'SpreadElement',
          argument: id('spreadArg'),
        },
        {
          kind: 'AssignmentExpression',
          operator: '=',
          left: id('lhs'),
          right: id('rhs'),
        },
        {
          kind: 'UpdateExpression',
          operator: '++',
          argument: id('counter'),
          prefix: true,
        },
        {
          kind: 'TaggedTemplateExpression',
          tag: id('tag'),
          quasi: {
            kind: 'TemplateLiteral',
            quasis: ['', ''],
            expressions: [id('tplArg')],
          },
        },
        {
          kind: 'YieldExpression',
          argument: id('yieldArg'),
          delegate: false,
        },
        {
          kind: 'ImportExpression',
          source: literal('module'),
        },
        {
          kind: 'ClassExpression',
          name: 'Child',
          superClass: id('Base'),
          body: [],
        },
      ],
    }

    const deps = depsOf(expr)

    expect(deps).toEqual(
      new Set([
        'maybeCall',
        'callArg',
        'awaited',
        'Ctor',
        'ctorArg',
        'spreadArg',
        'lhs',
        'rhs',
        'counter',
        'tag',
        'tplArg',
        'yieldArg',
        'Base',
      ]),
    )
  })

  it('tracks computed member access at base-object granularity', () => {
    const expr: Expression = {
      kind: 'MemberExpression',
      object: id('obj'),
      property: id('key'),
      computed: true,
      optional: false,
    }

    const deps = depsOf(expr)

    expect(deps.has('obj')).toBe(true)
    expect(deps.has('key')).toBe(true)
    expect(deps.has('obj.key')).toBe(false)
  })

  it('walks block-bodied function expressions including phi sources and terminators', () => {
    const block: BasicBlock = {
      id: 0,
      instructions: [
        {
          kind: 'Assign',
          target: id('local'),
          value: id('inner'),
          declarationKind: 'const',
        },
        {
          kind: 'Phi',
          variable: 'local',
          target: id('merged'),
          sources: [{ block: 0, id: id('phiDep') }],
        },
      ],
      terminator: {
        kind: 'Return',
        argument: id('ret'),
      },
    }

    const expr: Expression = {
      kind: 'ArrowFunction',
      params: [id('param')],
      body: [block],
      isExpression: false,
    }

    const deps = depsOf(expr)

    expect(deps.has('inner')).toBe(true)
    expect(deps.has('phiDep')).toBe(true)
    expect(deps.has('ret')).toBe(true)
  })
})
