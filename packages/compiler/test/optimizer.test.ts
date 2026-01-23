import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'

import type { Expression, HIRFunction, HIRProgram, Terminator } from '../src/ir/hir'
import { buildHIR } from '../src/ir/build-hir'
import { optimizeHIR } from '../src/ir/optimize'
import { printHIR } from '../src/ir/printer'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

const findReturnArgument = (program: HIRProgram): Expression | null => {
  for (const fn of program.functions) {
    for (const block of fn.blocks) {
      const term: Terminator = block.terminator
      if (term.kind === 'Return') {
        return term.argument ?? null
      }
    }
  }
  return null
}

const walkExpression = (expr: Expression | null | undefined, visit: (expr: Expression) => void) => {
  if (!expr) return
  visit(expr)
  switch (expr.kind) {
    case 'Identifier':
    case 'Literal':
      return
    case 'CallExpression':
    case 'OptionalCallExpression':
      walkExpression(expr.callee as Expression, visit)
      expr.arguments.forEach(arg => walkExpression(arg as Expression, visit))
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      walkExpression(expr.object as Expression, visit)
      if (expr.computed) walkExpression(expr.property as Expression, visit)
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
      walkExpression(expr.left as Expression, visit)
      walkExpression(expr.right as Expression, visit)
      return
    case 'UnaryExpression':
      walkExpression(expr.argument as Expression, visit)
      return
    case 'ConditionalExpression':
      walkExpression(expr.test as Expression, visit)
      walkExpression(expr.consequent as Expression, visit)
      walkExpression(expr.alternate as Expression, visit)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => walkExpression(el as Expression, visit))
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          walkExpression(prop.argument as Expression, visit)
        } else {
          walkExpression(prop.value as Expression, visit)
        }
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(e => walkExpression(e as Expression, visit))
      return
    case 'SpreadElement':
      walkExpression(expr.argument as Expression, visit)
      return
    case 'SequenceExpression':
      expr.expressions.forEach(e => walkExpression(e as Expression, visit))
      return
    case 'AwaitExpression':
      walkExpression(expr.argument as Expression, visit)
      return
    case 'NewExpression':
      walkExpression(expr.callee as Expression, visit)
      expr.arguments.forEach(arg => walkExpression(arg as Expression, visit))
      return
    case 'ArrowFunction':
      if (expr.isExpression) {
        walkExpression(expr.body as Expression, visit)
        return
      }
      ;(expr.body as any[]).forEach(block => {
        block.instructions.forEach((instr: any) => {
          if (instr.kind === 'Assign' || instr.kind === 'Expression') {
            walkExpression(instr.value as Expression, visit)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach((src: any) => walkExpression(src.id as Expression, visit))
          }
        })
        walkExpression(block.terminator?.argument as Expression, visit)
      })
      return
    case 'FunctionExpression':
      expr.body.forEach((block: any) => {
        block.instructions.forEach((instr: any) => {
          if (instr.kind === 'Assign' || instr.kind === 'Expression') {
            walkExpression(instr.value as Expression, visit)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach((src: any) => walkExpression(src.id as Expression, visit))
          }
        })
        walkExpression(block.terminator?.argument as Expression, visit)
      })
      return
    case 'AssignmentExpression':
      walkExpression(expr.left as Expression, visit)
      walkExpression(expr.right as Expression, visit)
      return
    case 'UpdateExpression':
      walkExpression(expr.argument as Expression, visit)
      return
    case 'JSXElement':
      if (typeof expr.tagName !== 'string') {
        walkExpression(expr.tagName as Expression, visit)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          walkExpression(attr.spreadExpr as Expression, visit)
        } else if (attr.value) {
          walkExpression(attr.value as Expression, visit)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          walkExpression(child.value as Expression, visit)
        } else if (child.kind === 'element') {
          walkExpression(child.value as Expression, visit)
        }
      })
      return
    default:
      return
  }
}

const countExpression = (program: HIRProgram, predicate: (expr: Expression) => boolean): number => {
  let count = 0
  for (const fn of program.functions) {
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign' || instr.kind === 'Expression') {
          walkExpression(instr.value as Expression, expr => {
            if (predicate(expr)) count += 1
          })
        } else if (instr.kind === 'Phi') {
          instr.sources.forEach(src => {
            if (predicate(src.id as Expression)) count += 1
          })
        }
      }
      const term = block.terminator as Terminator
      if (term.kind === 'Return' && term.argument) {
        walkExpression(term.argument as Expression, expr => {
          if (predicate(expr)) count += 1
        })
      } else if (term.kind === 'Throw') {
        walkExpression(term.argument as Expression, expr => {
          if (predicate(expr)) count += 1
        })
      } else if (term.kind === 'Branch') {
        walkExpression(term.test as Expression, expr => {
          if (predicate(expr)) count += 1
        })
      } else if (term.kind === 'Switch') {
        walkExpression(term.discriminant as Expression, expr => {
          if (predicate(expr)) count += 1
        })
        term.cases.forEach(c => {
          if (c.test) {
            walkExpression(c.test as Expression, expr => {
              if (predicate(expr)) count += 1
            })
          }
        })
      } else if (term.kind === 'ForOf') {
        walkExpression(term.iterable as Expression, expr => {
          if (predicate(expr)) count += 1
        })
      } else if (term.kind === 'ForIn') {
        walkExpression(term.object as Expression, expr => {
          if (predicate(expr)) count += 1
        })
      }
    }
  }
  return count
}

const hasAssignTarget = (program: HIRProgram, name: string): boolean => {
  for (const fn of program.functions) {
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign' && instr.target.name === name) return true
      }
    }
  }
  return false
}

describe('optimizeHIR', () => {
  it('removes unused pure assignments (DCE)', () => {
    const ast = parseFile(`
      function Foo(x) {
        const a = x + 1
        const b = x + 2
        return a
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const printed = printHIR(optimized)
    expect(printed).not.toMatch(/Assign b\$\$ssa\d+/)
  })

  it('drops unused derived values from reactive graph DCE', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        const unused = count + 1
        return count
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, 'unused')).toBe(false)
  })

  it('keeps unused derived values with impure expressions', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        const unused = sideEffect(count)
        return count
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, 'unused')).toBe(true)
  })

  it('drops unused explicit memo when annotated pure', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        const memo = /* @__PURE__ */ $memo(() => count + 1)
        return count
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, 'memo')).toBe(false)
  })

  it('keeps unused explicit memo without purity annotation', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        const memo = $memo(() => count + 1)
        return count
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, 'memo')).toBe(true)
  })

  it('drops unused derived values when function is marked "use pure"', () => {
    const ast = parseFile(`
      function Counter() {
        "use pure"
        let count = $state(0)
        const unused = sideEffect(count)
        return count
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, 'unused')).toBe(false)
  })

  it('keeps impure primitives even when annotated pure', () => {
    const ast = parseFile(`
      function App() {
        const __rendered = /* @__PURE__ */ render()
        return 1
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, '__rendered')).toBe(true)
  })

  it('propagates constants across blocks when enabled', () => {
    const previous = process.env.FICT_OPT_CROSS_BLOCK_CONST
    process.env.FICT_OPT_CROSS_BLOCK_CONST = '1'
    try {
      const ast = parseFile(`
        function Foo(flag) {
          const s = $state(0)
          const __a = 1
          if (flag) {
            return __a
          }
          return __a
        }
      `)
      const optimized = optimizeHIR(buildHIR(ast))
      expect(
        countExpression(optimized, expr => expr.kind === 'Identifier' && expr.name === '__a'),
      ).toBe(0)
      expect(hasAssignTarget(optimized, '__a')).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.FICT_OPT_CROSS_BLOCK_CONST
      } else {
        process.env.FICT_OPT_CROSS_BLOCK_CONST = previous
      }
    }
  })

  it('skips cross-block propagation when disabled', () => {
    const previous = process.env.FICT_OPT_CROSS_BLOCK_CONST
    process.env.FICT_OPT_CROSS_BLOCK_CONST = '0'
    try {
      const ast = parseFile(`
        function Foo(flag) {
          const s = $state(0)
          const __a = 1
          if (flag) {
            return __a
          }
          return __a
        }
      `)
      const optimized = optimizeHIR(buildHIR(ast))
      expect(
        countExpression(optimized, expr => expr.kind === 'Identifier' && expr.name === '__a'),
      ).toBeGreaterThan(0)
      expect(hasAssignTarget(optimized, '__a')).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.FICT_OPT_CROSS_BLOCK_CONST
      } else {
        process.env.FICT_OPT_CROSS_BLOCK_CONST = previous
      }
    }
  })

  it('does not replace shadowed names inside nested functions during const propagation', () => {
    const previous = process.env.FICT_OPT_CROSS_BLOCK_CONST
    process.env.FICT_OPT_CROSS_BLOCK_CONST = '1'
    try {
      const ast = parseFile(`
        function Foo() {
          const view = <div />
          const __x = 1
          const obj = {
            fn: () => {
              const __x = 2
              return __x
            },
            value: __x
          }
          return obj
        }
      `)
      const optimized = optimizeHIR(buildHIR(ast))
      let arrowFn: Expression | null = null
      countExpression(optimized, expr => {
        if (!arrowFn && expr.kind === 'ArrowFunction') {
          arrowFn = expr
        }
        return false
      })
      expect(arrowFn?.kind).toBe('ArrowFunction')
      if (arrowFn?.kind === 'ArrowFunction' && !arrowFn.isExpression) {
        const blocks = arrowFn.body as any[]
        const returnArgs = blocks
          .map(block => block.terminator)
          .filter(term => term.kind === 'Return')
          .map(term => term.argument)
        expect(returnArgs.length).toBeGreaterThan(0)
        const ret = returnArgs[0] as Expression
        expect(ret?.kind).toBe('Identifier')
        expect((ret as any).name).toBe('__x')
      }
    } finally {
      if (previous === undefined) {
        delete process.env.FICT_OPT_CROSS_BLOCK_CONST
      } else {
        process.env.FICT_OPT_CROSS_BLOCK_CONST = previous
      }
    }
  })

  it('propagates constants into return value', () => {
    const ast = parseFile(`
      function Foo() {
        const a = 1 + 2
        return a
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const ret = findReturnArgument(optimized)
    expect(ret?.kind).toBe('Literal')
    expect((ret as any)?.value).toBe(3)
  })

  it('eliminates common subexpressions within a block', () => {
    const ast = parseFile(`
      function Foo(x) {
        const a = x + 1
        const b = x + 1
        return a + b
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const printed = printHIR(optimized)
    const matches = printed.match(/\+\s*1/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('eliminates common subexpressions across straight-line blocks', () => {
    const expr = {
      kind: 'BinaryExpression',
      operator: '+',
      left: { kind: 'Identifier', name: 'x' },
      right: { kind: 'Literal', value: 1 },
    } as const

    const fn: HIRFunction = {
      name: 'Foo',
      params: [{ kind: 'Identifier', name: 'x' }],
      blocks: [
        {
          id: 0,
          instructions: [
            {
              kind: 'Assign',
              target: { kind: 'Identifier', name: '__a' },
              value: expr,
              declarationKind: 'const',
            },
          ],
          terminator: { kind: 'Jump', target: 1 },
        },
        {
          id: 1,
          instructions: [
            {
              kind: 'Assign',
              target: { kind: 'Identifier', name: '__b' },
              value: expr,
              declarationKind: 'const',
            },
          ],
          terminator: {
            kind: 'Return',
            argument: { kind: 'Identifier', name: '__b' },
          },
        },
      ],
    }

    const program: HIRProgram = {
      functions: [fn],
      preamble: [],
      postamble: [],
    }

    const optimized = optimizeHIR(program)
    const count = countExpression(optimized, node => {
      return (
        node.kind === 'BinaryExpression' &&
        node.operator === '+' &&
        node.left.kind === 'Identifier' &&
        node.left.name === 'x' &&
        node.right.kind === 'Literal' &&
        node.right.value === 1
      )
    })
    expect(count).toBe(1)
  })

  it('eliminates common subexpressions for pure-annotated calls', () => {
    const ast = parseFile(`
      function Foo(x) {
        const __a = /* @__PURE__ */ pureCall(x)
        const __b = /* @__PURE__ */ pureCall(x)
        return __a + __b
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const printed = printHIR(optimized)
    const matches = printed.match(/pureCall/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('propagates block-local constants in reactive functions', () => {
    const ast = parseFile(`
      function Foo() {
        const s = $state(0)
        const a = 1 + 2
        const b = a + 3
        return b
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const ret = findReturnArgument(optimized)
    expect(ret?.kind).toBe('Literal')
    expect((ret as any)?.value).toBe(6)
  })

  it('propagates const object member reads in reactive functions', () => {
    const ast = parseFile(`
      function Foo() {
        const s = $state(0)
        const obj = { a: 1, b: 2 }
        const __val = obj.a + obj.b
        return __val
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const ret = findReturnArgument(optimized)
    expect(ret?.kind).toBe('Literal')
    expect((ret as any)?.value).toBe(3)
  })

  it('inlines single-use derived memo to avoid useMemo for compiler temps', () => {
    const ast = parseFile(`
      function Foo() {
        let count = $state(0)
        const __total = count + 1
        return __total
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, '__total')).toBe(false)
  })

  it('can inline user-named derived memos when enabled', () => {
    const ast = parseFile(`
      function Foo() {
        let count = $state(0)
        const total = count + 1
        return total
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast), { inlineDerivedMemos: true })
    expect(hasAssignTarget(optimized, 'total')).toBe(false)
  })

  it('skips const object member propagation after mutation', () => {
    const ast = parseFile(`
      function Foo() {
        const s = $state(0)
        const obj = { a: 1, b: 2 }
        obj.a = 3
        return obj.a
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const count = countExpression(optimized, expr => {
      return (
        expr.kind === 'MemberExpression' &&
        expr.object.kind === 'Identifier' &&
        expr.object.name === 'obj' &&
        expr.property.kind === 'Identifier' &&
        expr.property.name === 'a'
      )
    })
    expect(count).toBeGreaterThan(0)
  })

  it('eliminates common subexpressions in reactive functions', () => {
    const ast = parseFile(`
      function Foo(x) {
        const s = $state(0)
        const __a = x + 1
        const __b = x + 1
        return __b
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const count = countExpression(optimized, expr => {
      return (
        expr.kind === 'BinaryExpression' &&
        expr.operator === '+' &&
        expr.left.kind === 'Identifier' &&
        expr.left.name === 'x' &&
        expr.right.kind === 'Literal' &&
        expr.right.value === 1
      )
    })
    expect(count).toBe(1)
  })

  it('treats stable Symbol members as CSE-safe in reactive functions', () => {
    const ast = parseFile(`
      function Foo() {
        const s = $state(0)
        const __a = Symbol.iterator
        const __b = Symbol.iterator
        return __b
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    const count = countExpression(optimized, expr => {
      return (
        (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') &&
        !expr.computed &&
        expr.object.kind === 'Identifier' &&
        expr.object.name === 'Symbol' &&
        expr.property.kind === 'Identifier' &&
        expr.property.name === 'iterator'
      )
    })
    expect(count).toBe(1)
  })

  it('inlines single-use non-reactive const assignments in reactive functions', () => {
    const ast = parseFile(`
      function Foo(x) {
        const s = $state(0)
        const __tmp = x + 1
        const result = __tmp * 2
        return result
      }
    `)
    const optimized = optimizeHIR(buildHIR(ast))
    expect(hasAssignTarget(optimized, '__tmp')).toBe(false)
  })
})
