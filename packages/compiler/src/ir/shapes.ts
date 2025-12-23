/**
 * Object Shape Lattice Analysis
 *
 * This module provides a lightweight shape lattice for tracking:
 * - Known keys: properties that are statically known
 * - Mutable keys: properties that may be modified
 * - Escaping: whether the object escapes to external contexts
 *
 * This information guides property subscription and spread wrapping decisions,
 * helping avoid whole-object subscriptions when only specific properties are needed.
 */

import type { HIRFunction, BasicBlock, Instruction, Expression, Identifier } from './hir'

/**
 * Shape state for a single object
 */
export interface ObjectShape {
  /** Known static property names */
  knownKeys: Set<string>
  /** Properties that may be mutated */
  mutableKeys: Set<string>
  /** Properties accessed dynamically (computed with non-literal) */
  dynamicAccess: boolean
  /** Whether the object escapes (passed to functions, returned, stored) */
  escapes: boolean
  /** Whether the object is spread into another object */
  isSpread: boolean
  /** Source of the object (param, local, imported, unknown) */
  source: ObjectSource
}

export type ObjectSource =
  | { kind: 'param'; name: string }
  | { kind: 'local'; name: string }
  | { kind: 'imported'; module: string; name: string }
  | { kind: 'props' }
  | { kind: 'unknown' }

/**
 * Result of shape analysis for a function
 */
export interface ShapeAnalysisResult {
  /** Shape information for each variable */
  shapes: Map<string, ObjectShape>
  /** Variables that should use whole-object subscription */
  wholeObjectSubscription: Set<string>
  /** Variables where we can use property-level subscription */
  propertySubscription: Map<string, Set<string>>
  /** Spread operations that need wrapping */
  spreadWrapping: Set<string>
}

/**
 * Create an empty/unknown shape
 */
function createUnknownShape(source: ObjectSource = { kind: 'unknown' }): ObjectShape {
  return {
    knownKeys: new Set(),
    mutableKeys: new Set(),
    dynamicAccess: false,
    escapes: false,
    isSpread: false,
    source,
  }
}

/**
 * Create a shape for a props parameter
 */
function createPropsShape(): ObjectShape {
  return {
    knownKeys: new Set(),
    mutableKeys: new Set(),
    dynamicAccess: false,
    escapes: false,
    isSpread: false,
    source: { kind: 'props' },
  }
}

/**
 * Merge two shapes (join in the lattice)
 */
function mergeShapes(a: ObjectShape, b: ObjectShape): ObjectShape {
  return {
    knownKeys: new Set([...a.knownKeys, ...b.knownKeys]),
    mutableKeys: new Set([...a.mutableKeys, ...b.mutableKeys]),
    dynamicAccess: a.dynamicAccess || b.dynamicAccess,
    escapes: a.escapes || b.escapes,
    isSpread: a.isSpread || b.isSpread,
    source: a.source.kind === b.source.kind ? a.source : { kind: 'unknown' },
  }
}

/**
 * Analyze object shapes in a HIR function
 */
export function analyzeObjectShapes(fn: HIRFunction): ShapeAnalysisResult {
  const shapes = new Map<string, ObjectShape>()
  const propertyReads = new Map<string, Set<string>>()

  // Initialize shapes for parameters
  for (const param of fn.params) {
    if (param.name === 'props' || param.name.endsWith('Props')) {
      shapes.set(param.name, createPropsShape())
    } else {
      shapes.set(param.name, createUnknownShape({ kind: 'param', name: param.name }))
    }
  }

  // First pass: collect all property accesses and assignments
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      analyzeInstruction(instr, shapes, propertyReads)
    }

    // Check terminator for property reads and escaping
    if (block.terminator.kind === 'Return' && block.terminator.argument) {
      // First analyze for property reads (including JSX attributes)
      analyzeExpression(block.terminator.argument, shapes, propertyReads)
      // Then mark as escaping
      markEscaping(block.terminator.argument, shapes)
    }
  }

  // Second pass: determine subscription strategy
  const wholeObjectSubscription = new Set<string>()
  const propertySubscription = new Map<string, Set<string>>()
  const spreadWrapping = new Set<string>()

  for (const [name, shape] of shapes) {
    // Determine subscription strategy
    if (shape.dynamicAccess || shape.source.kind === 'unknown') {
      // Dynamic access or unknown source: whole-object subscription
      wholeObjectSubscription.add(name)
    } else if (shape.isSpread && !shape.escapes) {
      // Spread but doesn't escape: may need wrapping
      spreadWrapping.add(name)
      // Still use property subscription for read properties
      const reads = propertyReads.get(name)
      if (reads && reads.size > 0) {
        propertySubscription.set(name, reads)
      } else {
        wholeObjectSubscription.add(name)
      }
    } else if (shape.escapes && shape.mutableKeys.size > 0) {
      // Escapes with mutations: whole-object subscription
      wholeObjectSubscription.add(name)
    } else {
      // Can use property-level subscription
      const reads = propertyReads.get(name)
      if (reads && reads.size > 0) {
        propertySubscription.set(name, reads)
      }
    }
  }

  return {
    shapes,
    wholeObjectSubscription,
    propertySubscription,
    spreadWrapping,
  }
}

/**
 * Analyze a single instruction for shape information
 */
function analyzeInstruction(
  instr: Instruction,
  shapes: Map<string, ObjectShape>,
  propertyReads: Map<string, Set<string>>,
): void {
  if (instr.kind === 'Assign') {
    // Analyze the assigned value
    const valueShape = analyzeExpression(instr.value, shapes, propertyReads)
    if (valueShape) {
      const existing = shapes.get(instr.target.name)
      if (existing) {
        shapes.set(instr.target.name, mergeShapes(existing, valueShape))
      } else {
        shapes.set(instr.target.name, valueShape)
      }
    }
  } else if (instr.kind === 'Expression') {
    analyzeExpression(instr.value, shapes, propertyReads)
  }
}

/**
 * Analyze an expression and return its shape (if it's an object)
 */
function analyzeExpression(
  expr: Expression,
  shapes: Map<string, ObjectShape>,
  propertyReads: Map<string, Set<string>>,
): ObjectShape | null {
  if (!expr || typeof expr !== 'object') return null

  switch (expr.kind) {
    case 'Identifier': {
      return shapes.get(expr.name) ?? null
    }

    case 'ObjectExpression': {
      // Object literal: we know all the keys
      const shape = createUnknownShape({ kind: 'local', name: '' })
      for (const prop of expr.properties) {
        if (prop.kind === 'SpreadElement') {
          // Handle spread element in object literal
          if (prop.argument.kind === 'Identifier') {
            const argShape = shapes.get(prop.argument.name)
            if (argShape) {
              argShape.isSpread = true
            }
          }
          analyzeExpression(prop.argument, shapes, propertyReads)
        } else if (prop.kind === 'Property') {
          if (prop.key.kind === 'Identifier') {
            shape.knownKeys.add(prop.key.name)
          } else if (prop.key.kind === 'Literal' && typeof prop.key.value === 'string') {
            shape.knownKeys.add(prop.key.value)
          }
          // Analyze property value for nested shapes
          analyzeExpression(prop.value, shapes, propertyReads)
        }
      }
      return shape
    }

    case 'MemberExpression': {
      // Track property access - need to find the DIRECT property on the base
      // For props.user.name, we want to track 'user' on 'props', not 'name'

      // Find the direct member access on the base identifier
      let current: Expression = expr
      let directMember: { property: Expression; computed: boolean } | null = null

      while (current.kind === 'MemberExpression') {
        if (current.object.kind === 'Identifier') {
          // Found the direct property access on an identifier
          directMember = { property: current.property, computed: current.computed }
          break
        }
        current = current.object
      }

      const base = getBaseIdentifier(expr.object)
      if (base && directMember) {
        // Track this property read
        const reads = propertyReads.get(base) ?? new Set()
        const baseShape = shapes.get(base)

        if (directMember.computed) {
          // Check if it's a static computed property (literal key)
          if (
            directMember.property.kind === 'Literal' &&
            typeof directMember.property.value === 'string'
          ) {
            reads.add(directMember.property.value)
          } else {
            // Dynamic property access - mark shape
            if (baseShape) {
              baseShape.dynamicAccess = true
            }
          }
        } else if (directMember.property.kind === 'Identifier') {
          reads.add(directMember.property.name)
          if (baseShape) {
            baseShape.knownKeys.add(directMember.property.name)
          }
        }
        propertyReads.set(base, reads)
      } else if (base) {
        // Fallback - shouldn't normally reach here
        const reads = propertyReads.get(base) ?? new Set()
        if (expr.property.kind === 'Identifier' && !expr.computed) {
          reads.add(expr.property.name)
        }
        propertyReads.set(base, reads)
      }
      return null
    }

    case 'CallExpression': {
      // Function calls: arguments escape
      for (const arg of expr.arguments) {
        markEscaping(arg, shapes)
      }

      // Special-case $state initializer to propagate object shape
      let returnedShape: ObjectShape | null = null
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$state' && expr.arguments[0]) {
        returnedShape = analyzeExpression(expr.arguments[0] as Expression, shapes, propertyReads)
      }

      // Analyze callee unless it's a macro we purposefully skip
      if (!(expr.callee.kind === 'Identifier' && expr.callee.name === '$state')) {
        analyzeExpression(expr.callee, shapes, propertyReads)
      }

      // Analyze remaining arguments (first arg already handled for shape if present)
      expr.arguments
        .slice(returnedShape ? 1 : 0)
        .forEach(arg => analyzeExpression(arg, shapes, propertyReads))

      return returnedShape
    }

    case 'SpreadElement': {
      // Mark the spread source
      if (expr.argument.kind === 'Identifier') {
        const shape = shapes.get(expr.argument.name)
        if (shape) {
          shape.isSpread = true
        }
      }
      analyzeExpression(expr.argument, shapes, propertyReads)
      return null
    }

    case 'ArrayExpression': {
      for (const el of expr.elements) {
        analyzeExpression(el, shapes, propertyReads)
      }
      return createUnknownShape({ kind: 'local', name: '' })
    }

    case 'BinaryExpression':
    case 'LogicalExpression': {
      analyzeExpression(expr.left, shapes, propertyReads)
      analyzeExpression(expr.right, shapes, propertyReads)
      return null
    }

    case 'ConditionalExpression': {
      analyzeExpression(expr.test, shapes, propertyReads)
      const consequent = analyzeExpression(expr.consequent, shapes, propertyReads)
      const alternate = analyzeExpression(expr.alternate, shapes, propertyReads)
      if (consequent && alternate) {
        return mergeShapes(consequent, alternate)
      }
      return consequent ?? alternate
    }

    case 'AssignmentExpression': {
      // Track mutation
      if (expr.left.kind === 'MemberExpression') {
        const base = getBaseIdentifier(expr.left.object)
        if (base) {
          const shape = shapes.get(base)
          if (shape) {
            if (expr.left.property.kind === 'Identifier' && !expr.left.computed) {
              shape.mutableKeys.add(expr.left.property.name)
            } else if (
              expr.left.property.kind === 'Literal' &&
              typeof expr.left.property.value === 'string'
            ) {
              shape.mutableKeys.add(expr.left.property.value)
            } else {
              shape.dynamicAccess = true
            }
          }
        }
      }
      analyzeExpression(expr.right, shapes, propertyReads)
      return null
    }

    case 'ArrowFunction':
    case 'FunctionExpression': {
      // Functions capture and may escape their free variables
      // This is a conservative approximation
      return null
    }

    case 'JSXElement': {
      // Analyze JSX attributes for property access
      for (const attr of expr.attributes) {
        if (attr.value) {
          analyzeExpression(attr.value, shapes, propertyReads)
        }
        if (attr.isSpread && attr.spreadExpr) {
          // Spread in JSX
          if (attr.spreadExpr.kind === 'Identifier') {
            const shape = shapes.get(attr.spreadExpr.name)
            if (shape) {
              shape.isSpread = true
            }
          }
          analyzeExpression(attr.spreadExpr, shapes, propertyReads)
        }
      }
      // Analyze children
      for (const child of expr.children) {
        if (child.kind === 'expression') {
          analyzeExpression(child.value, shapes, propertyReads)
        } else if (child.kind === 'element') {
          analyzeExpression(child.value as any, shapes, propertyReads)
        }
      }
      return null
    }

    default:
      return null
  }
}

/**
 * Get the base identifier from a potentially nested member expression
 */
function getBaseIdentifier(expr: Expression): string | null {
  if (expr.kind === 'Identifier') {
    return expr.name
  }
  if (expr.kind === 'MemberExpression') {
    return getBaseIdentifier(expr.object)
  }
  return null
}

/**
 * Mark an expression as escaping
 */
function markEscaping(expr: Expression, shapes: Map<string, ObjectShape>): void {
  if (!expr || typeof expr !== 'object') return

  switch (expr.kind) {
    case 'Identifier': {
      const shape = shapes.get(expr.name)
      if (shape) {
        shape.escapes = true
      }
      break
    }
    case 'ObjectExpression': {
      for (const prop of expr.properties) {
        if (prop.kind === 'SpreadElement') {
          markEscaping(prop.argument, shapes)
        } else if (prop.kind === 'Property') {
          markEscaping(prop.value, shapes)
        }
      }
      break
    }
    case 'ArrayExpression': {
      for (const el of expr.elements) {
        markEscaping(el, shapes)
      }
      break
    }
    case 'CallExpression': {
      for (const arg of expr.arguments) {
        markEscaping(arg, shapes)
      }
      break
    }
    case 'SpreadElement': {
      markEscaping(expr.argument, shapes)
      break
    }
    case 'MemberExpression': {
      // Member access on escaping object
      const base = getBaseIdentifier(expr.object)
      if (base) {
        const shape = shapes.get(base)
        if (shape) {
          shape.escapes = true
        }
      }
      break
    }
    case 'ConditionalExpression': {
      markEscaping(expr.consequent, shapes)
      markEscaping(expr.alternate, shapes)
      break
    }
  }
}

/**
 * Determine if a variable should use whole-object subscription
 */
export function shouldUseWholeObjectSubscription(
  varName: string,
  result: ShapeAnalysisResult,
): boolean {
  return result.wholeObjectSubscription.has(varName)
}

/**
 * Get the set of properties to subscribe to for a variable
 * Returns null if whole-object subscription should be used
 */
export function getPropertySubscription(
  varName: string,
  result: ShapeAnalysisResult,
): Set<string> | null {
  if (result.wholeObjectSubscription.has(varName)) {
    return null
  }
  return result.propertySubscription.get(varName) ?? null
}

/**
 * Check if a spread operation needs wrapping
 */
export function needsSpreadWrapping(varName: string, result: ShapeAnalysisResult): boolean {
  return result.spreadWrapping.has(varName)
}

/**
 * Get shape information for a variable
 */
export function getShape(varName: string, result: ShapeAnalysisResult): ObjectShape | undefined {
  return result.shapes.get(varName)
}

/**
 * Print shape analysis results for debugging
 */
export function printShapeAnalysis(result: ShapeAnalysisResult): string {
  const lines: string[] = ['=== Object Shape Analysis ===', '']

  lines.push('Shapes:')
  for (const [name, shape] of result.shapes) {
    lines.push(`  ${name}:`)
    lines.push(`    source: ${formatSource(shape.source)}`)
    lines.push(`    knownKeys: {${Array.from(shape.knownKeys).join(', ')}}`)
    lines.push(`    mutableKeys: {${Array.from(shape.mutableKeys).join(', ')}}`)
    lines.push(`    dynamicAccess: ${shape.dynamicAccess}`)
    lines.push(`    escapes: ${shape.escapes}`)
    lines.push(`    isSpread: ${shape.isSpread}`)
  }

  lines.push('')
  lines.push('Subscription Strategy:')

  if (result.wholeObjectSubscription.size > 0) {
    lines.push(`  Whole-object: {${Array.from(result.wholeObjectSubscription).join(', ')}}`)
  }

  if (result.propertySubscription.size > 0) {
    lines.push('  Property-level:')
    for (const [name, props] of result.propertySubscription) {
      lines.push(`    ${name}: {${Array.from(props).join(', ')}}`)
    }
  }

  if (result.spreadWrapping.size > 0) {
    lines.push(`  Spread wrapping needed: {${Array.from(result.spreadWrapping).join(', ')}}`)
  }

  return lines.join('\n')
}

function formatSource(source: ObjectSource): string {
  switch (source.kind) {
    case 'param':
      return `param(${source.name})`
    case 'local':
      return 'local'
    case 'imported':
      return `imported(${source.module}:${source.name})`
    case 'props':
      return 'props'
    case 'unknown':
      return 'unknown'
  }
}
