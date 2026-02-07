import type { BasicBlock, Expression } from './hir'
import { deSSAVarName } from './regions'

function getMemberDependencyPath(expr: Expression): string | undefined {
  if (expr.kind === 'MemberExpression') {
    const prop = expr.property
    let propName: string | undefined
    if (!expr.computed && prop.kind === 'Identifier') {
      propName = prop.name
    } else if (prop.kind === 'Literal' && typeof prop.value === 'string') {
      propName = prop.value
    }
    if (!propName) return undefined
    const object = expr.object
    if (object.kind === 'Identifier') {
      return `${deSSAVarName(object.name)}.${propName}`
    }
    if (object.kind === 'MemberExpression') {
      const parent = getMemberDependencyPath(object)
      return parent ? `${parent}.${propName}` : undefined
    }
  }
  return undefined
}

function collectBlockDependencies(blocks: BasicBlock[], deps: Set<string>): void {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      switch (instr.kind) {
        case 'Assign':
        case 'Expression':
          collectExpressionDependencies(instr.value, deps)
          break
        case 'Phi':
          for (const source of instr.sources) {
            deps.add(deSSAVarName(source.id.name))
          }
          break
        default:
          // Future-proof: ensure new instruction kinds are considered for dependency collection.
          break
      }
    }
    const term = block.terminator
    switch (term.kind) {
      case 'Return':
        if (term.argument) collectExpressionDependencies(term.argument, deps)
        break
      case 'Throw':
        collectExpressionDependencies(term.argument, deps)
        break
      case 'Branch':
        collectExpressionDependencies(term.test, deps)
        break
      case 'Switch':
        collectExpressionDependencies(term.discriminant, deps)
        for (const c of term.cases) {
          if (c.test) collectExpressionDependencies(c.test, deps)
        }
        break
      case 'ForOf':
        collectExpressionDependencies(term.iterable, deps)
        break
      case 'ForIn':
        collectExpressionDependencies(term.object, deps)
        break
      default:
        break
    }
  }
}

export function collectExpressionDependencies(expr: Expression, deps: Set<string>): void {
  if (expr.kind === 'Identifier') {
    deps.add(deSSAVarName(expr.name))
    return
  }
  if (expr.kind === 'ArrowFunction') {
    if (expr.isExpression && !Array.isArray(expr.body)) {
      collectExpressionDependencies(expr.body as Expression, deps)
    } else if (Array.isArray(expr.body)) {
      collectBlockDependencies(expr.body as BasicBlock[], deps)
    }
    return
  }
  if (expr.kind === 'FunctionExpression') {
    collectBlockDependencies(expr.body as BasicBlock[], deps)
    return
  }
  if (expr.kind === 'MemberExpression') {
    const path = getMemberDependencyPath(expr)
    if (path) deps.add(path)
    collectExpressionDependencies(expr.object, deps)
    if (expr.computed && expr.property.kind !== 'Literal') {
      collectExpressionDependencies(expr.property, deps)
    }
    return
  }
  if (expr.kind === 'CallExpression') {
    collectExpressionDependencies(expr.callee, deps)
    expr.arguments.forEach(a => collectExpressionDependencies(a, deps))
    return
  }
  if (expr.kind === 'BinaryExpression' || expr.kind === 'LogicalExpression') {
    collectExpressionDependencies(expr.left, deps)
    collectExpressionDependencies(expr.right, deps)
    return
  }
  if (expr.kind === 'ConditionalExpression') {
    collectExpressionDependencies(expr.test, deps)
    collectExpressionDependencies(expr.consequent, deps)
    collectExpressionDependencies(expr.alternate, deps)
    return
  }
  if (expr.kind === 'UnaryExpression') {
    collectExpressionDependencies(expr.argument, deps)
    return
  }
  if (expr.kind === 'ArrayExpression') {
    expr.elements.forEach(el => collectExpressionDependencies(el, deps))
    return
  }
  if (expr.kind === 'ObjectExpression') {
    expr.properties.forEach(p => {
      if (p.kind === 'SpreadElement') {
        collectExpressionDependencies(p.argument, deps)
      } else {
        if (p.computed) collectExpressionDependencies(p.key, deps)
        collectExpressionDependencies(p.value, deps)
      }
    })
    return
  }
  if (expr.kind === 'TemplateLiteral') {
    expr.expressions.forEach(e => collectExpressionDependencies(e, deps))
    return
  }
}
