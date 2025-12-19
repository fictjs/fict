import type * as BabelCore from '@babel/core'

import type { TransformContext } from './types'

const NO_MEMO_DIRECTIVE_TEXT = 'use no memo'

export function detectNoMemoDirective(
  path: BabelCore.NodePath<BabelCore.types.Program | BabelCore.types.BlockStatement>,
  t: typeof BabelCore.types,
): boolean {
  let found = false

  if (Array.isArray(path.node.directives)) {
    const filtered = path.node.directives.filter(d => {
      if (d.value.value === NO_MEMO_DIRECTIVE_TEXT) {
        found = true
        return false
      }
      return true
    })
    if (filtered.length !== path.node.directives.length) {
      path.node.directives = filtered
    }
  }

  const body = (path.node as BabelCore.types.Program | BabelCore.types.BlockStatement).body
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0]
    if (
      t.isExpressionStatement(first) &&
      t.isStringLiteral(first.expression) &&
      first.expression.value === NO_MEMO_DIRECTIVE_TEXT
    ) {
      found = true
      body.shift()
    }
  }

  if (Array.isArray(body) && body.length > 0) {
    const firstStmt = body[0]
    const comments = (firstStmt?.leadingComments ?? []).map(c => c.value.trim())
    if (comments.some(c => c.includes(NO_MEMO_DIRECTIVE_TEXT))) {
      found = true
    }
  }

  return found
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a node is a $state() call
 */
export function isStateCall(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): node is BabelCore.types.CallExpression {
  return t.isCallExpression(node) && t.isIdentifier(node.callee) && node.callee.name === '$state'
}

/**
 * Check if a node is an $effect() call
 */
export function isEffectCall(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): node is BabelCore.types.CallExpression {
  return t.isCallExpression(node) && t.isIdentifier(node.callee) && node.callee.name === '$effect'
}

/**
 * Check if a variable name is tracked (either state or memo)
 */
export function isTracked(
  name: string,
  stateVars: Set<string>,
  memoVars: Set<string>,
  additionalTracked?: Set<string>,
): boolean {
  return stateVars.has(name) || memoVars.has(name) || (additionalTracked?.has(name) ?? false)
}

/**
 * Check if a variable is tracked and not currently shadowed
 */
export function isTrackedAndNotShadowed(
  name: string,
  stateVars: Set<string>,
  memoVars: Set<string>,
  shadowedVars: Set<string>,
): boolean {
  return isTracked(name, stateVars, memoVars) && !shadowedVars.has(name)
}

/**
 * Create a getter call: name()
 */
export function createGetterCall(
  t: typeof BabelCore.types,
  name: string,
): BabelCore.types.CallExpression {
  return t.callExpression(t.identifier(name), [])
}

/**
 * Check if a token is an assignment operator
 */
export function isAssignmentOperator(operator: string): boolean {
  return [
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '<<=',
    '>>=',
    '>>>=',
    '|=',
    '^=',
    '&=',
    '||=',
    '&&=',
    '??=',
  ].includes(operator)
}

/**
 * Check if an operator is ++ or --
 */
export function isIncrementOrDecrement(operator: string): boolean {
  return operator === '++' || operator === '--'
}

/**
 * Convert compound assignment operator to binary operator
 */
export function toBinaryOperator(
  operator: string,
): BabelCore.types.BinaryExpression['operator'] | undefined {
  const map: Record<string, BabelCore.types.BinaryExpression['operator']> = {
    '+=': '+',
    '-=': '-',
    '*=': '*',
    '/=': '/',
    '%=': '%',
    '**=': '**',
    '<<=': '<<',
    '>>=': '>>',
    '>>>=': '>>>',
    '|=': '|',
    '^=': '^',
    '&=': '&',
  }
  return map[operator]
}

/**
 * Format an error with line/column info
 */
export function formatError(
  file: BabelCore.BabelFile,
  node: BabelCore.types.Node,
  message: string,
): string {
  const loc = node.loc
  if (loc) {
    return `${file.opts.filename || '<unknown>'}:${loc.start.line}:${loc.start.column + 1}: ${message}`
  }
  return `${file.opts.filename || '<unknown>'}: ${message}`
}

/**
 * Check if an expression depends on any tracked (state or memo) variables
 */
export function dependsOnTracked(
  expr: BabelCore.types.Node,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  additionalTracked?: Set<string>,
): boolean {
  const { stateVars, memoVars, shadowedVars } = ctx
  const propsInScope = ctx.propsStack[ctx.propsStack.length - 1]
  let depends = false

  const visit = (node: BabelCore.types.Node, locals: Set<string>): void => {
    if (depends) return

    if (t.isIdentifier(node)) {
      const name = node.name
      if (!locals.has(name) && !shadowedVars.has(name)) {
        if (isTracked(name, stateVars, memoVars, additionalTracked)) {
          depends = true
        }
      }
      return
    }

    // Handle variable declarations (extend locals)
    if (t.isVariableDeclaration(node)) {
      const newLocals = new Set(locals)
      for (const decl of node.declarations) {
        collectBindingNames(decl.id, newLocals, t)
      }
      for (const decl of node.declarations) {
        if (decl.init) {
          visit(decl.init, newLocals)
        }
      }
      return
    }

    // Handle function declarations/expressions (skip body, extend locals with params)
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      const newLocals = new Set(locals)
      for (const param of node.params) {
        collectBindingNames(param, newLocals, t)
      }
      // Don't visit function body - dependencies inside functions don't count
      return
    }

    // Handle member expressions - skip property names (unless computed)
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      if (t.isIdentifier(node.object)) {
        const name = node.object.name
        if (!locals.has(name) && !shadowedVars.has(name) && propsInScope?.has(name)) {
          depends = true
          return
        }
      }
      visit(node.object, locals)
      // Only visit property if it's computed (e.g., obj[key] vs obj.key)
      if (node.computed && node.property) {
        visit(node.property, locals)
      }
      return
    }

    // Recurse into children
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as unknown as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, locals)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string' &&
        !(child as { type: string }).type.startsWith('Comment')
      ) {
        visit(child as unknown as BabelCore.types.Node, locals)
      }
    }
  }

  visit(expr, new Set())
  return depends
}

/**
 * Collect all binding names from a pattern
 */
export function collectBindingNames(
  pattern: BabelCore.types.LVal | BabelCore.types.Pattern | BabelCore.types.Identifier,
  names: Set<string>,
  t: typeof BabelCore.types,
): void {
  if (t.isIdentifier(pattern)) {
    names.add(pattern.name)
  } else if (t.isArrayPattern(pattern)) {
    for (const elem of pattern.elements) {
      if (elem) {
        collectBindingNames(elem, names, t)
      }
    }
  } else if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        collectBindingNames(prop.argument, names, t)
      } else if (t.isObjectProperty(prop) && t.isLVal(prop.value)) {
        collectBindingNames(prop.value, names, t)
      }
    }
  } else if (t.isAssignmentPattern(pattern)) {
    collectBindingNames(pattern.left, names, t)
  } else if (t.isRestElement(pattern)) {
    collectBindingNames(pattern.argument, names, t)
  }
}

/**
 * Check if an attribute name is an event handler (onClick, onSubmit, etc.)
 */
export function isEventHandler(name: string): boolean {
  return /^on[A-Z]/.test(name)
}

/**
 * Emit a warning through the compiler options
 */
export function emitWarning(
  ctx: TransformContext,
  node: BabelCore.types.Node,
  code: string,
  message: string,
): void {
  if (!ctx.options.onWarn) return

  const loc = node.loc
  ctx.options.onWarn({
    code,
    message,
    fileName: ctx.file.opts.filename || '<unknown>',
    line: loc?.start.line ?? 0,
    column: loc?.start.column ?? 0,
  })
}

/**
 * Get the root identifier from a member expression chain
 */
export function getRootIdentifier(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Identifier | null {
  if (t.isIdentifier(expr)) {
    return expr
  }
  if (
    t.isMemberExpression(expr) &&
    t.isExpression(expr.object) &&
    !t.isOptionalMemberExpression(expr)
  ) {
    return getRootIdentifier(expr.object, t)
  }
  if (t.isOptionalMemberExpression(expr) && t.isExpression(expr.object)) {
    return getRootIdentifier(expr.object, t)
  }
  if (t.isCallExpression(expr) && t.isExpression(expr.callee)) {
    return getRootIdentifier(expr.callee, t)
  }
  if (t.isOptionalCallExpression(expr) && t.isExpression(expr.callee)) {
    return getRootIdentifier(expr.callee, t)
  }
  if (t.isTSAsExpression(expr) && t.isExpression(expr.expression)) {
    return getRootIdentifier(expr.expression, t)
  }
  if (t.isTSNonNullExpression(expr) && t.isExpression(expr.expression)) {
    return getRootIdentifier(expr.expression, t)
  }
  return null
}

/**
 * Check if expression has a tracked root
 */
export function isTrackedRoot(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean {
  const root = getRootIdentifier(expr, t)
  if (!root) return false
  return isTrackedAndNotShadowed(root.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)
}

/**
 * Check if a member expression uses dynamic (non-literal) property access
 * e.g., obj[key] where key is not a string/number literal
 */
export function isDynamicElementAccess(
  node: BabelCore.types.MemberExpression,
  t: typeof BabelCore.types,
): boolean {
  if (!node.computed) return false
  const property = node.property
  if (t.isTemplateLiteral(property)) {
    // Treat template literals with expressions as dynamic; bare template literals act like strings
    return property.expressions.length > 0
  }
  return !(t.isStringLiteral(property) || t.isNumericLiteral(property))
}

export function isInNoMemoScope(path: BabelCore.NodePath, ctx: TransformContext): boolean {
  if (ctx.noMemo) return true
  let fn = path.getFunctionParent()
  while (fn) {
    if (ctx.noMemoFunctions.has(fn.node as BabelCore.types.Function)) return true
    fn = fn.getFunctionParent()
  }
  return false
}
