import type { BasicBlock, Expression, HIRFunction, Instruction, Terminator } from './hir'
import { deSSAVarName } from './regions'
import type { StructuredNode } from './structurize'
import { walkExpression } from './walk-expression'

const hasInstructionArray = (value: unknown): value is { instructions: Instruction[] } => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { instructions?: unknown }
  return Array.isArray(candidate.instructions)
}

const expressionContainsJSXCache = new WeakMap<object, boolean>()

function assertNever(value: never): never {
  throw new Error(`Unhandled terminator in codegen analysis: ${JSON.stringify(value)}`)
}

function expressionContainsJSX(expr: unknown): boolean {
  if (!expr || typeof expr !== 'object') return false
  const cached = expressionContainsJSXCache.get(expr)
  if (cached !== undefined) return cached

  let result: boolean
  if (Array.isArray(expr)) {
    result = expr.some(item => expressionContainsJSX(item))
    expressionContainsJSXCache.set(expr, result)
    return result
  }
  const candidate = expr as Expression
  if (candidate.kind === 'JSXElement') {
    expressionContainsJSXCache.set(expr, true)
    return true
  }

  if (hasInstructionArray(expr)) {
    result = expr.instructions.some(i =>
      i.kind === 'Assign' || i.kind === 'Expression' ? expressionContainsJSX(i.value) : false,
    )
    expressionContainsJSXCache.set(expr, result)
    return result
  }

  switch (candidate.kind) {
    case 'CallExpression':
      if (expressionContainsJSX(candidate.callee)) {
        result = true
        break
      }
      result = candidate.arguments.some(arg => expressionContainsJSX(arg))
      break
    case 'ArrayExpression':
      result = candidate.elements.some(el => expressionContainsJSX(el))
      break
    case 'ObjectExpression':
      result =
        candidate.properties.some(p => {
          if (p.kind === 'SpreadElement') return expressionContainsJSX(p.argument)
          return (
            ((p.computed ?? false) && expressionContainsJSX(p.key)) ||
            expressionContainsJSX(p.value)
          )
        }) ?? false
      break
    case 'ConditionalExpression':
      result =
        expressionContainsJSX(candidate.test) ||
        expressionContainsJSX(candidate.consequent) ||
        expressionContainsJSX(candidate.alternate)
      break
    case 'ArrowFunction':
      if (Array.isArray(candidate.body)) {
        result = candidate.body.some(block =>
          block.instructions.some(i =>
            i.kind === 'Assign' || i.kind === 'Expression' ? expressionContainsJSX(i.value) : false,
          ),
        )
        break
      }
      result = expressionContainsJSX(candidate.body)
      break
    case 'FunctionExpression':
      result = candidate.body.some(block =>
        block.instructions.some(i =>
          i.kind === 'Assign' || i.kind === 'Expression' ? expressionContainsJSX(i.value) : false,
        ),
      )
      break
    default:
      result = false
      break
  }

  expressionContainsJSXCache.set(expr, result)
  return result
}

export function functionContainsJSX(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (
        (instr.kind === 'Assign' || instr.kind === 'Expression') &&
        expressionContainsJSX(instr.value)
      ) {
        return true
      }
    }

    const term = block.terminator
    if (term.kind === 'Return' && term.argument && expressionContainsJSX(term.argument)) {
      return true
    }
  }
  return false
}

export function structuredNodeHasComplexControlFlow(node: StructuredNode): boolean {
  switch (node.kind) {
    case 'labeled':
      return structuredNodeHasComplexControlFlow(node.statement)
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
    case 'switch':
    case 'try':
    case 'stateMachine':
      return true
    case 'sequence':
      return node.nodes.some(structuredNodeHasComplexControlFlow)
    case 'block':
      return node.statements.some(structuredNodeHasComplexControlFlow)
    case 'if':
      return (
        structuredNodeHasComplexControlFlow(node.consequent) ||
        (node.alternate !== null && structuredNodeHasComplexControlFlow(node.alternate))
      )
    default:
      return false
  }
}

function terminatorHasAwait(term: BasicBlock['terminator']): boolean {
  switch (term.kind) {
    case 'Branch':
      return expressionHasAwait(term.test)
    case 'Switch':
      if (expressionHasAwait(term.discriminant)) return true
      return term.cases.some(c => (c.test ? expressionHasAwait(c.test) : false))
    case 'ForOf':
      return (
        !!term.await ||
        expressionHasAwait(term.iterable) ||
        (!!term.assignmentTarget && expressionHasAwait(term.assignmentTarget))
      )
    case 'ForIn':
      return (
        expressionHasAwait(term.object) ||
        (!!term.assignmentTarget && expressionHasAwait(term.assignmentTarget))
      )
    case 'Return':
      return term.argument ? expressionHasAwait(term.argument) : false
    case 'Throw':
      return expressionHasAwait(term.argument)
    default:
      return false
  }
}

function expressionHasAwait(expr: Expression): boolean {
  switch (expr.kind) {
    case 'AwaitExpression':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        expressionHasAwait(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasAwait(arg as Expression))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        expressionHasAwait(expr.object as Expression) ||
        expressionHasAwait(expr.property as Expression)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionHasAwait(expr.left as Expression) || expressionHasAwait(expr.right as Expression)
      )
    case 'UnaryExpression':
      return expressionHasAwait(expr.argument as Expression)
    case 'ConditionalExpression':
      return (
        expressionHasAwait(expr.test as Expression) ||
        expressionHasAwait(expr.consequent as Expression) ||
        expressionHasAwait(expr.alternate as Expression)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => el && expressionHasAwait(el as Expression))
    case 'ObjectExpression':
      return expr.properties.some(
        prop =>
          (prop.kind === 'Property' &&
            (((prop.computed ?? false) && expressionHasAwait(prop.key as Expression)) ||
              expressionHasAwait(prop.value as Expression))) ||
          (prop.kind === 'SpreadElement' && expressionHasAwait(prop.argument as Expression)),
      )
    case 'TemplateLiteral':
      return expr.expressions.some(ex => expressionHasAwait(ex as Expression))
    case 'SequenceExpression':
      return expr.expressions.some(ex => expressionHasAwait(ex as Expression))
    case 'SpreadElement':
      return expressionHasAwait(expr.argument as Expression)
    case 'AssignmentExpression':
      return (
        expressionHasAwait(expr.left as Expression) || expressionHasAwait(expr.right as Expression)
      )
    case 'UpdateExpression':
      return expressionHasAwait(expr.argument as Expression)
    case 'NewExpression':
      return (
        expressionHasAwait(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasAwait(arg as Expression))
      )
    case 'ImportExpression':
      return (
        expressionHasAwait(expr.source as Expression) ||
        (!!expr.options && expressionHasAwait(expr.options as Expression))
      )
    case 'YieldExpression':
      return expr.argument ? expressionHasAwait(expr.argument as Expression) : false
    case 'TaggedTemplateExpression':
      return (
        expressionHasAwait(expr.tag as Expression) ||
        expr.quasi.expressions.some(ex => expressionHasAwait(ex as Expression))
      )
    case 'ClassExpression':
      return expr.superClass ? expressionHasAwait(expr.superClass as Expression) : false
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    default:
      return false
  }
}

export function functionHasAsyncAwait(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if ((instr.kind === 'Assign' || instr.kind === 'Expression') && instr.value) {
        if (expressionHasAwait(instr.value)) return true
      }
    }
    if (terminatorHasAwait(block.terminator)) return true
  }
  return false
}

function expressionHasYield(expr: Expression): boolean {
  switch (expr.kind) {
    case 'Identifier':
    case 'Literal':
    case 'ThisExpression':
    case 'SuperExpression':
      return false
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        expressionHasYield(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasYield(arg as Expression))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        expressionHasYield(expr.object as Expression) ||
        (expr.computed ? expressionHasYield(expr.property as Expression) : false)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionHasYield(expr.left as Expression) || expressionHasYield(expr.right as Expression)
      )
    case 'UnaryExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'ConditionalExpression':
      return (
        expressionHasYield(expr.test as Expression) ||
        expressionHasYield(expr.consequent as Expression) ||
        expressionHasYield(expr.alternate as Expression)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => (el ? expressionHasYield(el as Expression) : false))
    case 'ObjectExpression':
      return expr.properties.some(prop =>
        prop.kind === 'SpreadElement'
          ? expressionHasYield(prop.argument as Expression)
          : (prop.computed && expressionHasYield(prop.key as Expression)) ||
            expressionHasYield(prop.value as Expression),
      )
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionHasYield(e as Expression))
    case 'SpreadElement':
      return expressionHasYield(expr.argument as Expression)
    case 'SequenceExpression':
      return expr.expressions.some(e => expressionHasYield(e as Expression))
    case 'AwaitExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'NewExpression':
      return (
        expressionHasYield(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasYield(arg as Expression))
      )
    case 'ImportExpression':
      return (
        expressionHasYield(expr.source as Expression) ||
        (!!expr.options && expressionHasYield(expr.options as Expression))
      )
    case 'YieldExpression':
      return true
    case 'TaggedTemplateExpression':
      return (
        expressionHasYield(expr.tag as Expression) ||
        expr.quasi.expressions.some(ex => expressionHasYield(ex as Expression))
      )
    case 'ClassExpression':
      return expr.superClass ? expressionHasYield(expr.superClass as Expression) : false
    case 'AssignmentExpression':
      return (
        expressionHasYield(expr.left as Expression) || expressionHasYield(expr.right as Expression)
      )
    case 'UpdateExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    default:
      return false
  }
}

function terminatorHasYield(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return term.argument ? expressionHasYield(term.argument as Expression) : false
    case 'Throw':
      return expressionHasYield(term.argument as Expression)
    case 'Branch':
      return expressionHasYield(term.test as Expression)
    case 'Switch':
      return (
        expressionHasYield(term.discriminant as Expression) ||
        term.cases.some(c => (c.test ? expressionHasYield(c.test as Expression) : false))
      )
    case 'ForOf':
      return (
        expressionHasYield(term.iterable as Expression) ||
        (!!term.assignmentTarget && expressionHasYield(term.assignmentTarget as Expression))
      )
    case 'ForIn':
      return (
        expressionHasYield(term.object as Expression) ||
        (!!term.assignmentTarget && expressionHasYield(term.assignmentTarget as Expression))
      )
    case 'Try':
    case 'Jump':
    case 'Break':
    case 'Continue':
    case 'Unreachable':
      return false
    default:
      return false
  }
}

export function functionHasYield(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if ((instr.kind === 'Assign' || instr.kind === 'Expression') && instr.value) {
        if (expressionHasYield(instr.value)) return true
      }
    }
    if (terminatorHasYield(block.terminator)) return true
  }
  return false
}

export function collectCalledIdentifiers(fn: HIRFunction): Set<string> {
  const called = new Set<string>()

  const getStaticMemberName = (
    expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ): string | null => {
    if (!expr.computed && expr.property.kind === 'Identifier') return expr.property.name
    if (expr.property.kind === 'Literal') {
      return typeof expr.property.value === 'string' ? expr.property.value : null
    }
    return null
  }

  const recordCalledIdentifier = (callee: Expression): boolean => {
    if (callee.kind === 'Identifier') {
      called.add(deSSAVarName(callee.name))
      return true
    }
    if (callee.kind === 'MemberExpression' || callee.kind === 'OptionalMemberExpression') {
      const methodName = getStaticMemberName(callee)
      if (
        (methodName === 'call' || methodName === 'apply') &&
        callee.object.kind === 'Identifier'
      ) {
        called.add(deSSAVarName(callee.object.name))
        return true
      }
    }
    return false
  }

  const visitExpr = (expr: Expression | undefined | null) => {
    if (!expr) return
    switch (expr.kind) {
      case 'Identifier':
        return
      case 'CallExpression': {
        if (!recordCalledIdentifier(expr.callee as Expression)) {
          visitExpr(expr.callee as Expression)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression))
        return
      }
      case 'OptionalCallExpression': {
        if (!recordCalledIdentifier(expr.callee as Expression)) {
          visitExpr(expr.callee as Expression)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression))
        return
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitExpr(expr.object as Expression)
        visitExpr(expr.property as Expression)
        return
      case 'UnaryExpression':
        visitExpr(expr.argument as Expression)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitExpr(expr.left as Expression)
        visitExpr(expr.right as Expression)
        return
      case 'ConditionalExpression':
        visitExpr(expr.test as Expression)
        visitExpr(expr.consequent as Expression)
        visitExpr(expr.alternate as Expression)
        return
      case 'ArrayExpression':
        expr.elements.forEach(el => visitExpr(el as Expression))
        return
      case 'ObjectExpression':
        expr.properties.forEach(p => {
          if (p.kind === 'SpreadElement') {
            visitExpr(p.argument as Expression)
          } else {
            if (p.computed) visitExpr(p.key as Expression)
            visitExpr(p.value as Expression)
          }
        })
        return
      case 'ArrowFunction':
      case 'FunctionExpression':
        if (Array.isArray(expr.body)) {
          expr.body.forEach(block => {
            block.instructions.forEach(instr => {
              if (instr.kind === 'Assign' || instr.kind === 'Expression') {
                visitExpr(instr.value)
              }
            })
          })
        } else {
          visitExpr(expr.body as Expression)
        }
        return
      case 'JSXElement':
        expr.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visitExpr(attr.spreadExpr)
          } else if (attr.value) {
            visitExpr(attr.value)
          }
        })
        expr.children.forEach(child => {
          if (child.kind === 'expression') {
            visitExpr(child.value)
          } else if (child.kind === 'element') {
            visitExpr(child.value)
          }
        })
        return
      default:
        return
    }
  }

  const visitTerminator = (term: BasicBlock['terminator']) => {
    switch (term.kind) {
      case 'Branch':
        visitExpr(term.test)
        return
      case 'Switch':
        visitExpr(term.discriminant)
        term.cases.forEach(c => visitExpr(c.test))
        return
      case 'ForOf':
        visitExpr(term.iterable)
        visitExpr(term.assignmentTarget ?? null)
        return
      case 'ForIn':
        visitExpr(term.object)
        visitExpr(term.assignmentTarget ?? null)
        return
      case 'Return':
        visitExpr(term.argument ?? null)
        return
      case 'Throw':
        visitExpr(term.argument)
        return
      default:
        return
    }
  }

  for (const block of fn.blocks) {
    block.instructions.forEach(instr => {
      if (instr.kind === 'Assign') {
        visitExpr(instr.value)
      } else if (instr.kind === 'Expression') {
        visitExpr(instr.value)
      }
    })
    visitTerminator(block.terminator)
  }

  return called
}

function collectMutatedIdentifiersFromExpression(
  expr: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!expr) return
  walkExpression(
    expr,
    node => {
      if (node.kind === 'AssignmentExpression' && node.left.kind === 'Identifier') {
        into.add(deSSAVarName(node.left.name))
      } else if (node.kind === 'UpdateExpression' && node.argument.kind === 'Identifier') {
        into.add(deSSAVarName(node.argument.name))
      }
    },
    { includeFunctionBodies: false },
  )
}

function collectMutatedIdentifiersFromAssignmentTarget(
  target: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!target) return
  if (target.kind === 'Identifier') {
    into.add(deSSAVarName(target.name))
    return
  }
  if (target.kind === 'MemberExpression' || target.kind === 'OptionalMemberExpression') {
    collectMutatedIdentifiersFromAssignmentTarget(target.object, into)
    if (target.computed) collectMutatedIdentifiersFromExpression(target.property, into)
  }
}

function collectMutatedIdentifiersFromTerminator(term: Terminator, into: Set<string>): void {
  switch (term.kind) {
    case 'Return':
      collectMutatedIdentifiersFromExpression(term.argument ?? null, into)
      return
    case 'Throw':
      collectMutatedIdentifiersFromExpression(term.argument, into)
      return
    case 'Branch':
      collectMutatedIdentifiersFromExpression(term.test, into)
      return
    case 'Switch':
      collectMutatedIdentifiersFromExpression(term.discriminant, into)
      term.cases.forEach(c => collectMutatedIdentifiersFromExpression(c.test ?? null, into))
      return
    case 'ForOf':
      collectMutatedIdentifiersFromExpression(term.iterable, into)
      collectMutatedIdentifiersFromExpression(term.assignmentTarget ?? null, into)
      collectMutatedIdentifiersFromAssignmentTarget(term.assignmentTarget ?? null, into)
      return
    case 'ForIn':
      collectMutatedIdentifiersFromExpression(term.object, into)
      collectMutatedIdentifiersFromExpression(term.assignmentTarget ?? null, into)
      collectMutatedIdentifiersFromAssignmentTarget(term.assignmentTarget ?? null, into)
      return
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
    case 'Try':
      return
    default:
      assertNever(term)
  }
}

export function collectMutatedIdentifiers(fn: HIRFunction): Set<string> {
  const mutated = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        collectMutatedIdentifiersFromExpression(instr.value, mutated)
      }
    }
    collectMutatedIdentifiersFromTerminator(block.terminator, mutated)
  }

  return mutated
}
