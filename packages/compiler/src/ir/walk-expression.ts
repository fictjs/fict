import type { BasicBlock, Expression, Instruction, Terminator } from './hir'

export interface WalkExpressionState {
  parent: Expression | null
  inFunctionBody: boolean
}

export interface WalkExpressionOptions {
  includeFunctionBodies?: boolean
}

export type WalkExpressionVisitor = (expr: Expression, state: WalkExpressionState) => void

function assertNever(value: never): never {
  throw new Error(`Unhandled node in walkExpression: ${JSON.stringify(value)}`)
}

function walkTerminator(
  term: Terminator,
  visitNode: (expr: Expression, parent: Expression | null, inFunctionBody: boolean) => void,
  inFunctionBody: boolean,
): void {
  switch (term.kind) {
    case 'Return':
      if (term.argument) visitNode(term.argument, null, inFunctionBody)
      return
    case 'Throw':
      visitNode(term.argument, null, inFunctionBody)
      return
    case 'Branch':
      visitNode(term.test, null, inFunctionBody)
      return
    case 'Switch':
      visitNode(term.discriminant, null, inFunctionBody)
      term.cases.forEach(c => {
        if (c.test) visitNode(c.test, null, inFunctionBody)
      })
      return
    case 'ForOf':
      visitNode(term.iterable, null, inFunctionBody)
      if (term.assignmentTarget) visitNode(term.assignmentTarget, null, inFunctionBody)
      return
    case 'ForIn':
      visitNode(term.object, null, inFunctionBody)
      if (term.assignmentTarget) visitNode(term.assignmentTarget, null, inFunctionBody)
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

function walkInstruction(
  instr: Instruction,
  visitNode: (expr: Expression, parent: Expression | null, inFunctionBody: boolean) => void,
  inFunctionBody: boolean,
): void {
  switch (instr.kind) {
    case 'Assign':
    case 'Expression':
      visitNode(instr.value, null, inFunctionBody)
      return
    case 'Phi':
      instr.sources.forEach(source => visitNode(source.id, null, inFunctionBody))
      return
    case 'Debugger':
      return
    default:
      assertNever(instr)
  }
}

function walkBlocks(
  blocks: BasicBlock[],
  visitNode: (expr: Expression, parent: Expression | null, inFunctionBody: boolean) => void,
  inFunctionBody: boolean,
): void {
  for (const block of blocks) {
    block.instructions.forEach(instr => walkInstruction(instr, visitNode, inFunctionBody))
    walkTerminator(block.terminator, visitNode, inFunctionBody)
  }
}

export function walkExpression(
  expr: Expression,
  visit: WalkExpressionVisitor,
  options: WalkExpressionOptions = {},
): void {
  const includeFunctionBodies = options.includeFunctionBodies ?? true

  const visitNode = (
    node: Expression,
    parent: Expression | null,
    inFunctionBody: boolean,
  ): void => {
    visit(node, { parent, inFunctionBody })

    switch (node.kind) {
      case 'Identifier':
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
        return
      case 'ImportExpression':
        visitNode(node.source, node, inFunctionBody)
        if (node.options) visitNode(node.options, node, inFunctionBody)
        return
      case 'CallExpression':
      case 'OptionalCallExpression':
        visitNode(node.callee, node, inFunctionBody)
        node.arguments.forEach(arg => visitNode(arg, node, inFunctionBody))
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitNode(node.object, node, inFunctionBody)
        if (node.computed) {
          visitNode(node.property, node, inFunctionBody)
        }
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitNode(node.left, node, inFunctionBody)
        visitNode(node.right, node, inFunctionBody)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
        visitNode(node.argument, node, inFunctionBody)
        return
      case 'ConditionalExpression':
        visitNode(node.test, node, inFunctionBody)
        visitNode(node.consequent, node, inFunctionBody)
        visitNode(node.alternate, node, inFunctionBody)
        return
      case 'ArrayExpression':
        node.elements.forEach(el => visitNode(el, node, inFunctionBody))
        return
      case 'ObjectExpression':
        node.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visitNode(prop.argument, node, inFunctionBody)
          } else {
            if (prop.computed) {
              visitNode(prop.key, node, inFunctionBody)
            }
            visitNode(prop.value, node, inFunctionBody)
          }
        })
        return
      case 'JSXElement':
        if (typeof node.tagName !== 'string') {
          visitNode(node.tagName, node, inFunctionBody)
        }
        node.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visitNode(attr.spreadExpr, node, inFunctionBody)
          } else if (attr.value) {
            visitNode(attr.value, node, inFunctionBody)
          }
        })
        node.children.forEach(child => {
          if (child.kind === 'expression') {
            visitNode(child.value, node, inFunctionBody)
          } else if (child.kind === 'element') {
            visitNode(child.value, node, inFunctionBody)
          }
        })
        return
      case 'ArrowFunction':
        if (!includeFunctionBodies) return
        if (node.isExpression && !Array.isArray(node.body)) {
          visitNode(node.body, node, true)
        } else if (Array.isArray(node.body)) {
          walkBlocks(node.body, visitNode, true)
        }
        return
      case 'FunctionExpression':
        if (!includeFunctionBodies) return
        walkBlocks(node.body, visitNode, true)
        return
      case 'AssignmentExpression':
        visitNode(node.left, node, inFunctionBody)
        visitNode(node.right, node, inFunctionBody)
        return
      case 'UpdateExpression':
        visitNode(node.argument, node, inFunctionBody)
        return
      case 'TemplateLiteral':
        node.expressions.forEach(item => visitNode(item, node, inFunctionBody))
        return
      case 'SpreadElement':
        visitNode(node.argument, node, inFunctionBody)
        return
      case 'NewExpression':
        visitNode(node.callee, node, inFunctionBody)
        node.arguments.forEach(arg => visitNode(arg, node, inFunctionBody))
        return
      case 'SequenceExpression':
        node.expressions.forEach(item => visitNode(item, node, inFunctionBody))
        return
      case 'YieldExpression':
        if (node.argument) {
          visitNode(node.argument, node, inFunctionBody)
        }
        return
      case 'TaggedTemplateExpression':
        visitNode(node.tag, node, inFunctionBody)
        node.quasi.expressions.forEach(item => visitNode(item, node, inFunctionBody))
        return
      case 'ClassExpression':
        if (node.superClass) {
          visitNode(node.superClass, node, inFunctionBody)
        }
        return
      default:
        assertNever(node)
    }
  }

  visitNode(expr, null, false)
}
