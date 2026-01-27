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

import * as t from '@babel/types'

import type { HIRFunction, Instruction, Expression } from './hir'
import { structurizeCFG, type StructuredNode } from './structurize'

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

type KeyNarrowingValue = Set<string | number>
interface KeyNarrowingContext {
  values: Map<string, KeyNarrowingValue>
  keySets: Map<string, KeyNarrowingValue>
}

interface EqualityNarrowing {
  name: string
  values: KeyNarrowingValue
  kind: 'eq' | 'neq'
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

function cloneKeyContext(ctx: KeyNarrowingContext): KeyNarrowingContext {
  const cloneMap = (map: Map<string, KeyNarrowingValue>) => {
    const next = new Map<string, KeyNarrowingValue>()
    for (const [key, value] of map.entries()) {
      next.set(key, new Set(value))
    }
    return next
  }
  return {
    values: cloneMap(ctx.values),
    keySets: cloneMap(ctx.keySets),
  }
}

type BabelPattern = t.PatternLike | t.LVal | null | undefined

function clearPatternBindings(pattern: BabelPattern, ctx: KeyNarrowingContext): void {
  if (!pattern || typeof pattern !== 'object') return

  if (t.isIdentifier(pattern)) {
    ctx.values.delete(pattern.name)
    ctx.keySets.delete(pattern.name)
    return
  }
  if (t.isRestElement(pattern)) {
    clearPatternBindings(pattern.argument, ctx)
    return
  }
  if (t.isAssignmentPattern(pattern)) {
    clearPatternBindings(pattern.left, ctx)
    return
  }
  if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element) clearPatternBindings(element, ctx)
    }
    return
  }
  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        clearPatternBindings(prop.argument, ctx)
      } else if (t.isObjectProperty(prop)) {
        clearPatternBindings(prop.value as t.PatternLike, ctx)
      }
    }
  }
}

function resolveNarrowedKeys(expr: Expression, ctx: KeyNarrowingContext): KeyNarrowingValue | null {
  if (expr.kind === 'Literal') {
    if (typeof expr.value === 'string' || typeof expr.value === 'number') {
      return new Set([expr.value])
    }
    return null
  }
  if (expr.kind === 'Identifier') {
    const value = ctx.values.get(expr.name)
    return value ? new Set(value) : null
  }
  if (expr.kind === 'ConditionalExpression') {
    const consequent = resolveNarrowedKeys(expr.consequent as Expression, ctx)
    const alternate = resolveNarrowedKeys(expr.alternate as Expression, ctx)
    if (consequent && alternate) {
      return new Set([...consequent, ...alternate])
    }
    return null
  }
  if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
    const last = expr.expressions[expr.expressions.length - 1] as Expression
    return resolveNarrowedKeys(last, ctx)
  }
  if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
    if (expr.computed && expr.object.kind === 'Identifier') {
      const keySet = ctx.keySets.get(expr.object.name)
      if (keySet && keySet.size > 0) {
        return new Set(keySet)
      }
    }
  }
  return null
}

function resolveKeySet(expr: Expression, ctx: KeyNarrowingContext): KeyNarrowingValue | null {
  if (expr.kind === 'Identifier') {
    const set = ctx.keySets.get(expr.name)
    return set ? new Set(set) : null
  }
  if (expr.kind === 'ArrayExpression') {
    const values: (string | number)[] = []
    for (const el of expr.elements) {
      if (!el) return null
      if (el.kind !== 'Literal') return null
      if (typeof el.value !== 'string' && typeof el.value !== 'number') return null
      values.push(el.value)
    }
    return values.length > 0 ? new Set(values) : null
  }
  if (expr.kind === 'CallExpression') {
    if (expr.callee.kind === 'MemberExpression') {
      const object = expr.callee.object
      const property = expr.callee.property
      if (
        object.kind === 'Identifier' &&
        object.name === 'Object' &&
        !expr.callee.computed &&
        property.kind === 'Identifier' &&
        property.name === 'keys' &&
        expr.arguments.length === 1
      ) {
        const arg = expr.arguments[0] as Expression
        if (arg.kind === 'ObjectExpression') {
          const values: (string | number)[] = []
          for (const prop of arg.properties) {
            if (prop.kind !== 'Property') return null
            if (prop.key.kind === 'Identifier') {
              values.push(prop.key.name)
            } else if (prop.key.kind === 'Literal') {
              if (typeof prop.key.value !== 'string' && typeof prop.key.value !== 'number') {
                return null
              }
              values.push(prop.key.value)
            } else {
              return null
            }
          }
          return values.length > 0 ? new Set(values) : null
        }
      }
    }
  }
  if (expr.kind === 'ConditionalExpression') {
    const consequent = resolveKeySet(expr.consequent as Expression, ctx)
    const alternate = resolveKeySet(expr.alternate as Expression, ctx)
    if (consequent && alternate) {
      return new Set([...consequent, ...alternate])
    }
    return null
  }
  if (expr.kind === 'SequenceExpression' && expr.expressions.length > 0) {
    const last = expr.expressions[expr.expressions.length - 1] as Expression
    return resolveKeySet(last, ctx)
  }
  return null
}

function extractEqualityNarrowing(expr: Expression): EqualityNarrowing | null {
  if (expr.kind === 'LogicalExpression' && expr.operator === '||') {
    const left = extractEqualityNarrowing(expr.left as Expression)
    const right = extractEqualityNarrowing(expr.right as Expression)
    if (left && right && left.kind === 'eq' && right.kind === 'eq' && left.name === right.name) {
      return {
        name: left.name,
        values: new Set([...left.values, ...right.values]),
        kind: 'eq',
      }
    }
  }

  if (expr.kind !== 'BinaryExpression') return null
  const isEq = expr.operator === '==='
  const isNeq = expr.operator === '!=='
  if (!isEq && !isNeq) return null

  const literalValue = (node: Expression): string | number | null => {
    if (node.kind !== 'Literal') return null
    if (typeof node.value === 'string' || typeof node.value === 'number') {
      return node.value
    }
    return null
  }

  if (expr.left.kind === 'Identifier') {
    const value = literalValue(expr.right as Expression)
    if (value !== null) {
      return { name: expr.left.name, values: new Set([value]), kind: isEq ? 'eq' : 'neq' }
    }
  }
  if (expr.right.kind === 'Identifier') {
    const value = literalValue(expr.left as Expression)
    if (value !== null) {
      return { name: expr.right.name, values: new Set([value]), kind: isEq ? 'eq' : 'neq' }
    }
  }

  return null
}

function applyNarrowing(ctx: KeyNarrowingContext, name: string, values: KeyNarrowingValue): void {
  const existing = ctx.values.get(name)
  if (!existing) {
    ctx.values.set(name, new Set(values))
    return
  }
  const intersection = new Set<string | number>()
  for (const value of existing) {
    if (values.has(value)) intersection.add(value)
  }
  if (intersection.size > 0) {
    ctx.values.set(name, intersection)
  } else {
    ctx.values.delete(name)
  }
}

function applyKeyAssignment(ctx: KeyNarrowingContext, name: string, expr: Expression): void {
  ctx.values.delete(name)
  ctx.keySets.delete(name)

  let assignedKeys: KeyNarrowingValue | null = null
  let keySet: KeyNarrowingValue | null = null

  if (expr.kind === 'Identifier') {
    assignedKeys = resolveNarrowedKeys(expr, ctx)
    keySet = resolveKeySet(expr, ctx)
    if (ctx.keySets.has(expr.name)) {
      // Treat aliasing as escape to avoid unsound key set reuse.
      ctx.keySets.delete(expr.name)
    }
  } else {
    assignedKeys = resolveNarrowedKeys(expr, ctx)
    keySet = resolveKeySet(expr, ctx)
  }

  if (assignedKeys && assignedKeys.size > 0) {
    ctx.values.set(name, new Set(assignedKeys))
  }
  if (keySet && keySet.size > 0) {
    ctx.keySets.set(name, new Set(keySet))
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
  const devMode = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'

  // Initialize shapes for parameters
  for (const param of fn.params) {
    if (param.name === 'props' || param.name.endsWith('Props')) {
      shapes.set(param.name, createPropsShape())
    } else {
      shapes.set(param.name, createUnknownShape({ kind: 'param', name: param.name }))
    }
  }

  // First pass: collect all property accesses and assignments
  const baseCtx: KeyNarrowingContext = { values: new Map(), keySets: new Map() }
  let structured: StructuredNode | null = null
  try {
    structured = structurizeCFG(fn, {
      warnOnIssues: devMode,
      throwOnIssues: false,
      useFallback: true,
    })
  } catch (error) {
    if (devMode) {
      console.warn(
        '[analyzeObjectShapes] Failed to structurize CFG; falling back to linear scan.',
        error,
      )
    }
    structured = null
  }

  if (structured && structured.kind !== 'stateMachine') {
    analyzeStructuredNode(structured, shapes, propertyReads, baseCtx)
  } else {
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        analyzeInstruction(instr, shapes, propertyReads, baseCtx)
      }

      // Check terminator for property reads and escaping
      if (block.terminator.kind === 'Return' && block.terminator.argument) {
        // First analyze for property reads (including JSX attributes)
        analyzeExpression(block.terminator.argument, shapes, propertyReads, baseCtx)
        // Then mark as escaping
        markEscaping(block.terminator.argument, shapes)
      }
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

function analyzeStructuredNode(
  node: StructuredNode,
  shapes: Map<string, ObjectShape>,
  propertyReads: Map<string, Set<string>>,
  ctx: KeyNarrowingContext,
): void {
  switch (node.kind) {
    case 'sequence':
      node.nodes.forEach(child => analyzeStructuredNode(child, shapes, propertyReads, ctx))
      return
    case 'block':
      node.statements.forEach(child => analyzeStructuredNode(child, shapes, propertyReads, ctx))
      return
    case 'instruction':
      analyzeInstruction(node.instruction, shapes, propertyReads, ctx)
      return
    case 'return':
      if (node.argument) {
        analyzeExpression(node.argument, shapes, propertyReads, ctx)
        markEscaping(node.argument, shapes)
      }
      return
    case 'throw':
      analyzeExpression(node.argument, shapes, propertyReads, ctx)
      return
    case 'if': {
      analyzeExpression(node.test, shapes, propertyReads, ctx)
      const narrowing = extractEqualityNarrowing(node.test)
      const consequentCtx = cloneKeyContext(ctx)
      const alternateCtx = cloneKeyContext(ctx)
      if (narrowing) {
        if (narrowing.kind === 'eq') {
          applyNarrowing(consequentCtx, narrowing.name, narrowing.values)
        } else {
          applyNarrowing(alternateCtx, narrowing.name, narrowing.values)
        }
      }
      analyzeStructuredNode(node.consequent, shapes, propertyReads, consequentCtx)
      if (node.alternate) {
        analyzeStructuredNode(node.alternate, shapes, propertyReads, alternateCtx)
      }
      return
    }
    case 'switch': {
      analyzeExpression(node.discriminant, shapes, propertyReads, ctx)
      const discriminant = node.discriminant.kind === 'Identifier' ? node.discriminant.name : null
      for (const caseNode of node.cases) {
        const caseCtx = cloneKeyContext(ctx)
        if (
          discriminant &&
          caseNode.test?.kind === 'Literal' &&
          (typeof caseNode.test.value === 'string' || typeof caseNode.test.value === 'number')
        ) {
          applyNarrowing(caseCtx, discriminant, new Set([caseNode.test.value]))
        }
        analyzeStructuredNode(caseNode.body, shapes, propertyReads, caseCtx)
      }
      return
    }
    case 'while':
      analyzeExpression(node.test, shapes, propertyReads, ctx)
      analyzeStructuredNode(node.body, shapes, propertyReads, cloneKeyContext(ctx))
      return
    case 'doWhile':
      analyzeStructuredNode(node.body, shapes, propertyReads, cloneKeyContext(ctx))
      analyzeExpression(node.test, shapes, propertyReads, ctx)
      return
    case 'for': {
      if (node.init) {
        node.init.forEach(instr => analyzeInstruction(instr, shapes, propertyReads, ctx))
      }
      if (node.test) {
        analyzeExpression(node.test, shapes, propertyReads, ctx)
      }
      analyzeStructuredNode(node.body, shapes, propertyReads, cloneKeyContext(ctx))
      if (node.update) {
        node.update.forEach(instr => analyzeInstruction(instr, shapes, propertyReads, ctx))
      }
      return
    }
    case 'forOf':
      analyzeExpression(node.iterable, shapes, propertyReads, ctx)
      {
        const bodyCtx = cloneKeyContext(ctx)
        bodyCtx.values.delete(node.variable)
        bodyCtx.keySets.delete(node.variable)
        if (node.pattern) {
          clearPatternBindings(node.pattern, bodyCtx)
        }
        analyzeStructuredNode(node.body, shapes, propertyReads, bodyCtx)
      }
      return
    case 'forIn':
      analyzeExpression(node.object, shapes, propertyReads, ctx)
      {
        const bodyCtx = cloneKeyContext(ctx)
        bodyCtx.values.delete(node.variable)
        bodyCtx.keySets.delete(node.variable)
        if (node.pattern) {
          clearPatternBindings(node.pattern, bodyCtx)
        }
        analyzeStructuredNode(node.body, shapes, propertyReads, bodyCtx)
      }
      return
    case 'try':
      analyzeStructuredNode(node.block, shapes, propertyReads, cloneKeyContext(ctx))
      if (node.handler) {
        const handlerCtx = cloneKeyContext(ctx)
        if (node.handler.param) {
          handlerCtx.values.delete(node.handler.param)
          handlerCtx.keySets.delete(node.handler.param)
        }
        analyzeStructuredNode(node.handler.body, shapes, propertyReads, handlerCtx)
      }
      if (node.finalizer) {
        analyzeStructuredNode(node.finalizer, shapes, propertyReads, cloneKeyContext(ctx))
      }
      return
    case 'break':
    case 'continue':
      return
    case 'stateMachine':
      for (const block of node.blocks) {
        for (const instr of block.instructions) {
          analyzeInstruction(instr, shapes, propertyReads, ctx)
        }
        if (block.terminator.kind === 'Return' && block.terminator.argument) {
          analyzeExpression(block.terminator.argument, shapes, propertyReads, ctx)
          markEscaping(block.terminator.argument, shapes)
        }
      }
      return
  }
}

/**
 * Analyze a single instruction for shape information
 */
function analyzeInstruction(
  instr: Instruction,
  shapes: Map<string, ObjectShape>,
  propertyReads: Map<string, Set<string>>,
  ctx: KeyNarrowingContext,
): void {
  if (instr.kind === 'Assign') {
    applyKeyAssignment(ctx, instr.target.name, instr.value)
    // Analyze the assigned value
    const valueShape = analyzeExpression(instr.value, shapes, propertyReads, ctx)
    if (valueShape) {
      const existing = shapes.get(instr.target.name)
      if (existing) {
        shapes.set(instr.target.name, mergeShapes(existing, valueShape))
      } else {
        shapes.set(instr.target.name, valueShape)
      }
    }
  } else if (instr.kind === 'Expression') {
    analyzeExpression(instr.value, shapes, propertyReads, ctx)
  }
}

/**
 * Analyze an expression and return its shape (if it's an object)
 */
function analyzeExpression(
  expr: Expression,
  shapes: Map<string, ObjectShape>,
  propertyReads: Map<string, Set<string>>,
  ctx: KeyNarrowingContext,
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
          analyzeExpression(prop.argument, shapes, propertyReads, ctx)
        } else if (prop.kind === 'Property') {
          if (prop.key.kind === 'Identifier') {
            shape.knownKeys.add(prop.key.name)
          } else if (prop.key.kind === 'Literal' && typeof prop.key.value === 'string') {
            shape.knownKeys.add(prop.key.value)
          }
          // Analyze property value for nested shapes
          analyzeExpression(prop.value, shapes, propertyReads, ctx)
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
          const resolved = resolveNarrowedKeys(directMember.property, ctx)
          if (resolved && resolved.size > 0) {
            for (const value of resolved) {
              const key = String(value)
              reads.add(key)
              if (baseShape) {
                baseShape.knownKeys.add(key)
              }
            }
          } else if (baseShape) {
            // Dynamic property access - mark shape
            baseShape.dynamicAccess = true
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
      // Invalidate key-set arrays when they escape or are mutated
      if (expr.callee.kind === 'MemberExpression') {
        if (expr.callee.object.kind === 'Identifier') {
          const baseName = expr.callee.object.name
          const propName =
            !expr.callee.computed && expr.callee.property.kind === 'Identifier'
              ? expr.callee.property.name
              : expr.callee.property.kind === 'Literal' &&
                  typeof expr.callee.property.value === 'string'
                ? expr.callee.property.value
                : null
          if (
            propName &&
            ctx.keySets.has(baseName) &&
            [
              'push',
              'pop',
              'shift',
              'unshift',
              'splice',
              'sort',
              'reverse',
              'copyWithin',
              'fill',
            ].includes(propName)
          ) {
            ctx.keySets.delete(baseName)
          }
        }
      }
      for (const arg of expr.arguments) {
        if (arg.kind === 'Identifier' && ctx.keySets.has(arg.name)) {
          ctx.keySets.delete(arg.name)
        } else if (arg.kind === 'SpreadElement' && arg.argument.kind === 'Identifier') {
          if (ctx.keySets.has(arg.argument.name)) {
            ctx.keySets.delete(arg.argument.name)
          }
        }
      }

      // Function calls: arguments escape
      for (const arg of expr.arguments) {
        markEscaping(arg, shapes)
      }

      // Special-case $state initializer to propagate object shape
      let returnedShape: ObjectShape | null = null
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$state' && expr.arguments[0]) {
        returnedShape = analyzeExpression(
          expr.arguments[0] as Expression,
          shapes,
          propertyReads,
          ctx,
        )
      }

      // Analyze callee unless it's a macro we purposefully skip
      if (!(expr.callee.kind === 'Identifier' && expr.callee.name === '$state')) {
        analyzeExpression(expr.callee, shapes, propertyReads, ctx)
      }

      // Analyze remaining arguments (first arg already handled for shape if present)
      expr.arguments
        .slice(returnedShape ? 1 : 0)
        .forEach(arg => analyzeExpression(arg, shapes, propertyReads, ctx))

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
      analyzeExpression(expr.argument, shapes, propertyReads, ctx)
      return null
    }

    case 'ArrayExpression': {
      for (const el of expr.elements) {
        analyzeExpression(el, shapes, propertyReads, ctx)
      }
      return createUnknownShape({ kind: 'local', name: '' })
    }

    case 'BinaryExpression':
    case 'LogicalExpression': {
      analyzeExpression(expr.left, shapes, propertyReads, ctx)
      analyzeExpression(expr.right, shapes, propertyReads, ctx)
      return null
    }

    case 'ConditionalExpression': {
      analyzeExpression(expr.test, shapes, propertyReads, ctx)
      const consequent = analyzeExpression(expr.consequent, shapes, propertyReads, ctx)
      const alternate = analyzeExpression(expr.alternate, shapes, propertyReads, ctx)
      if (consequent && alternate) {
        return mergeShapes(consequent, alternate)
      }
      return consequent ?? alternate
    }

    case 'AssignmentExpression': {
      // Track mutation
      if (expr.left.kind === 'Identifier') {
        applyKeyAssignment(ctx, expr.left.name, expr.right)
      }
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
              const resolved = resolveNarrowedKeys(expr.left.property as Expression, ctx)
              if (resolved && resolved.size > 0) {
                for (const value of resolved) {
                  shape.mutableKeys.add(String(value))
                }
              } else {
                shape.dynamicAccess = true
              }
            }
          }
          if (ctx.keySets.has(base)) {
            // Array key sets are invalidated by mutation
            ctx.keySets.delete(base)
          }
        }
      }
      analyzeExpression(expr.right, shapes, propertyReads, ctx)
      return null
    }

    case 'UpdateExpression': {
      if (expr.argument.kind === 'Identifier') {
        ctx.values.delete(expr.argument.name)
        ctx.keySets.delete(expr.argument.name)
      }
      if (expr.argument.kind === 'MemberExpression') {
        const base = getBaseIdentifier(expr.argument.object)
        if (base) {
          ctx.keySets.delete(base)
        }
      }
      analyzeExpression(expr.argument, shapes, propertyReads, ctx)
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
          analyzeExpression(attr.value, shapes, propertyReads, ctx)
        }
        if (attr.isSpread && attr.spreadExpr) {
          // Spread in JSX
          if (attr.spreadExpr.kind === 'Identifier') {
            const shape = shapes.get(attr.spreadExpr.name)
            if (shape) {
              shape.isSpread = true
            }
          }
          analyzeExpression(attr.spreadExpr, shapes, propertyReads, ctx)
        }
      }
      // Analyze children
      for (const child of expr.children) {
        if (child.kind === 'expression') {
          analyzeExpression(child.value, shapes, propertyReads, ctx)
        } else if (child.kind === 'element') {
          analyzeExpression(child.value as any, shapes, propertyReads, ctx)
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
