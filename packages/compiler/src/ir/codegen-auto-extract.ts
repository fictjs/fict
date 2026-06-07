import type { CodegenContext } from './codegen'
import { getSSABaseName, type BasicBlock, type Expression, type Instruction } from './hir'

/**
 * Count AST nodes in an expression for complexity estimation.
 * Used by shouldAutoExtract to determine if a handler is complex enough to extract.
 */
function countExpressionNodes(expr: Expression | undefined): number {
  if (!expr) return 0

  let count = 1 // Count the current node

  switch (expr.kind) {
    case 'Literal':
      return 1

    case 'Identifier':
      return 1

    case 'BinaryExpression':
    case 'LogicalExpression':
      count += countExpressionNodes(expr.left)
      count += countExpressionNodes(expr.right)
      return count

    case 'UnaryExpression':
      count += countExpressionNodes(expr.argument)
      return count

    case 'ConditionalExpression':
      count += countExpressionNodes(expr.test)
      count += countExpressionNodes(expr.consequent)
      count += countExpressionNodes(expr.alternate)
      return count

    case 'CallExpression':
    case 'OptionalCallExpression':
      count += countExpressionNodes(expr.callee)
      for (const arg of expr.arguments) {
        count += countExpressionNodes(arg)
      }
      return count

    case 'MemberExpression':
    case 'OptionalMemberExpression':
      count += countExpressionNodes(expr.object)
      if (expr.computed && expr.property) {
        count += countExpressionNodes(expr.property)
      }
      return count

    case 'ArrayExpression':
      for (const elem of expr.elements) {
        if (elem) count += countExpressionNodes(elem)
      }
      return count

    case 'ObjectExpression':
      for (const prop of expr.properties) {
        if (prop.kind === 'Property') {
          if (prop.computed) count += countExpressionNodes(prop.key)
          count += countExpressionNodes(prop.value)
        } else if (prop.kind === 'SpreadElement') {
          count += countExpressionNodes(prop.argument)
        }
      }
      return count

    case 'ArrowFunction':
      // For arrow functions, count the body
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        // Expression body
        count += countExpressionNodes(expr.body as Expression)
      } else if (Array.isArray(expr.body)) {
        // Block body (BasicBlock[])
        for (const block of expr.body) {
          count += countBlockNodes(block)
        }
      }
      return count

    case 'FunctionExpression':
      // For function expressions, count the body blocks
      if (expr.body) {
        for (const block of expr.body) {
          count += countBlockNodes(block)
        }
      }
      return count

    case 'AssignmentExpression':
      count += countExpressionNodes(expr.left)
      count += countExpressionNodes(expr.right)
      return count

    case 'UpdateExpression':
      count += countExpressionNodes(expr.argument)
      return count

    case 'SequenceExpression':
      for (const e of expr.expressions) {
        count += countExpressionNodes(e)
      }
      return count

    case 'AwaitExpression':
      count += countExpressionNodes(expr.argument)
      return count + 2 // Async adds complexity

    case 'ImportExpression':
      count += countExpressionNodes(expr.source)
      if (expr.options) count += countExpressionNodes(expr.options)
      return count

    case 'NewExpression':
      count += countExpressionNodes(expr.callee)
      for (const arg of expr.arguments) {
        count += countExpressionNodes(arg)
      }
      return count

    case 'TemplateLiteral':
      for (const e of expr.expressions) {
        count += countExpressionNodes(e)
      }
      return count

    case 'TaggedTemplateExpression':
      count += countExpressionNodes(expr.tag)
      count += countExpressionNodes(expr.quasi)
      return count

    default:
      return count
  }
}

/**
 * Count nodes in a basic block for complexity estimation.
 */
function countBlockNodes(block: BasicBlock): number {
  let count = 1 // Count the block itself
  for (const instr of block.instructions) {
    count += countInstructionNodes(instr)
  }
  return count
}

/**
 * Count nodes in an instruction for complexity estimation.
 */
function countInstructionNodes(instr: Instruction): number {
  switch (instr.kind) {
    case 'Expression':
      return 1 + countExpressionNodes(instr.value)

    case 'Assign':
      return 1 + countExpressionNodes(instr.value)

    case 'Phi':
      return 1

    default:
      return 1
  }
}

/**
 * Check if an expression contains external function calls.
 * External calls indicate the handler has side effects beyond simple state updates.
 */
function hasExternalCalls(expr: Expression | undefined): boolean {
  if (!expr) return false

  switch (expr.kind) {
    case 'CallExpression':
    case 'OptionalCallExpression': {
      // Check if callee is a simple identifier (potential external function)
      if (expr.callee.kind === 'Identifier') {
        const name = expr.callee.name
        // Built-in array methods and simple operations are not "external"
        // But named function calls suggest external dependencies
        if (!['console', 'Math', 'JSON', 'Object', 'Array'].includes(name)) {
          return true
        }
      }
      // Check if callee is a member expression (method call)
      if (expr.callee.kind === 'MemberExpression') {
        // foo.bar() - could be external
        return true
      }
      if (expr.callee.kind === 'OptionalMemberExpression') {
        return true
      }
      // Also check arguments for external calls
      for (const arg of expr.arguments) {
        if (hasExternalCalls(arg)) return true
      }
      return false
    }

    case 'ArrowFunction':
      // Check the function body for external calls
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        return hasExternalCalls(expr.body as Expression)
      } else if (Array.isArray(expr.body)) {
        for (const block of expr.body) {
          if (blockHasExternalCalls(block)) return true
        }
      }
      return false

    case 'FunctionExpression':
      // Check the function body for external calls
      if (expr.body) {
        for (const block of expr.body) {
          if (blockHasExternalCalls(block)) return true
        }
      }
      return false

    case 'BinaryExpression':
    case 'LogicalExpression':
      return hasExternalCalls(expr.left) || hasExternalCalls(expr.right)

    case 'UnaryExpression':
      return hasExternalCalls(expr.argument)

    case 'ConditionalExpression':
      return (
        hasExternalCalls(expr.test) ||
        hasExternalCalls(expr.consequent) ||
        hasExternalCalls(expr.alternate)
      )

    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        hasExternalCalls(expr.object) || (expr.computed ? hasExternalCalls(expr.property) : false)
      )

    case 'AssignmentExpression':
      return hasExternalCalls(expr.right)

    case 'SequenceExpression':
      return expr.expressions.some(e => hasExternalCalls(e))

    case 'AwaitExpression':
      return true // Await implies async external operation

    case 'ImportExpression':
      return true // Dynamic import starts external async module loading

    case 'NewExpression':
      return true // Constructor calls are external

    case 'TemplateLiteral':
      return expr.expressions.some(e => hasExternalCalls(e))

    case 'TaggedTemplateExpression':
      if (expr.tag.kind === 'Identifier') {
        const name = expr.tag.name
        if (!['console', 'Math', 'JSON', 'Object', 'Array'].includes(name)) {
          return true
        }
      }
      if (expr.tag.kind === 'MemberExpression' || expr.tag.kind === 'OptionalMemberExpression') {
        return true
      }
      return hasExternalCalls(expr.tag) || hasExternalCalls(expr.quasi)

    default:
      return false
  }
}

/**
 * Check if a basic block contains external function calls.
 */
function blockHasExternalCalls(block: BasicBlock): boolean {
  for (const instr of block.instructions) {
    if (instructionHasExternalCalls(instr)) return true
  }
  return false
}

/**
 * Check if an instruction contains external function calls.
 */
function instructionHasExternalCalls(instr: Instruction): boolean {
  switch (instr.kind) {
    case 'Expression':
      return hasExternalCalls(instr.value)

    case 'Assign':
      return hasExternalCalls(instr.value)

    default:
      return false
  }
}

/**
 * Check if an expression contains async/await.
 */
function hasAsyncAwait(expr: Expression | undefined): boolean {
  if (!expr) return false

  switch (expr.kind) {
    case 'AwaitExpression':
      return true

    case 'ImportExpression':
      return true

    case 'ArrowFunction':
      if (expr.isAsync) return true
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        return hasAsyncAwait(expr.body as Expression)
      } else if (Array.isArray(expr.body)) {
        for (const block of expr.body) {
          if (blockHasAsyncAwait(block)) return true
        }
      }
      return false

    case 'FunctionExpression':
      if (expr.isAsync) return true
      if (expr.body) {
        for (const block of expr.body) {
          if (blockHasAsyncAwait(block)) return true
        }
      }
      return false

    case 'CallExpression':
    case 'OptionalCallExpression':
      if (hasAsyncAwait(expr.callee)) return true
      return expr.arguments.some(arg => hasAsyncAwait(arg))

    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return hasAsyncAwait(expr.object) || (expr.computed ? hasAsyncAwait(expr.property) : false)

    case 'BinaryExpression':
    case 'LogicalExpression':
      return hasAsyncAwait(expr.left) || hasAsyncAwait(expr.right)

    case 'ConditionalExpression':
      return (
        hasAsyncAwait(expr.test) || hasAsyncAwait(expr.consequent) || hasAsyncAwait(expr.alternate)
      )

    case 'SequenceExpression':
      return expr.expressions.some(e => hasAsyncAwait(e))

    case 'TemplateLiteral':
      return expr.expressions.some(e => hasAsyncAwait(e))

    case 'TaggedTemplateExpression':
      return hasAsyncAwait(expr.tag) || hasAsyncAwait(expr.quasi)

    default:
      return false
  }
}

/**
 * Check if a basic block contains async/await.
 */
function blockHasAsyncAwait(block: BasicBlock): boolean {
  for (const instr of block.instructions) {
    if (instructionHasAsyncAwait(instr)) return true
  }
  return false
}

function isStableBareHandlerIdentifier(name: string, ctx: CodegenContext): boolean {
  const baseName = getSSABaseName(name)
  const isFunctionLocal = ctx.currentFunctionDeclaredNames?.has(baseName) ?? false
  if (isFunctionLocal) {
    if (ctx.mutatedVars?.has(baseName)) return false
    const kind = ctx.functionBindingKinds?.get(baseName)
    return kind === 'const' || kind === 'function'
  }

  if (!(ctx.moduleDeclaredNames?.has(baseName) ?? false)) {
    return false
  }

  const kind = ctx.moduleBindingKinds?.get(baseName) ?? 'unknown'
  return kind === 'const' || kind === 'function' || kind === 'class'
}

/**
 * Check if an instruction contains async/await.
 */
function instructionHasAsyncAwait(instr: Instruction): boolean {
  switch (instr.kind) {
    case 'Expression':
      return hasAsyncAwait(instr.value)

    case 'Assign':
      return hasAsyncAwait(instr.value)

    default:
      return false
  }
}

/**
 * Determine if an event handler expression should be automatically extracted
 * for lazy loading based on heuristic rules.
 *
 * Handlers are extracted if they meet ANY of these criteria:
 * 1. Node count exceeds the threshold (complex handler)
 * 2. Contains external function calls (side effects)
 * 3. Contains async/await (async operations)
 * 4. References an external function identifier (not inline)
 */
export function shouldAutoExtract(expr: Expression | undefined, ctx: CodegenContext): boolean {
  if (!expr) return false
  if (!ctx.autoExtractEnabled) return false

  const threshold = ctx.autoExtractThreshold ?? 3

  // Bare handler identifiers are safe to extract only when the binding is stable.
  if (expr.kind === 'Identifier') {
    return isStableBareHandlerIdentifier(expr.name, ctx)
  }

  // For inline functions, analyze complexity
  if (expr.kind === 'ArrowFunction' || expr.kind === 'FunctionExpression') {
    // Check for async functions
    if (
      (expr.kind === 'ArrowFunction' && expr.isAsync) ||
      (expr.kind === 'FunctionExpression' && expr.isAsync) ||
      hasAsyncAwait(expr)
    ) {
      return true
    }

    // Check for external calls
    if (hasExternalCalls(expr)) {
      return true
    }

    // Check node count
    const nodeCount = countExpressionNodes(expr)
    if (nodeCount >= threshold) {
      return true
    }

    return false
  }

  // For other expressions (shouldn't be common for event handlers)
  const nodeCount = countExpressionNodes(expr)
  return nodeCount >= threshold
}
