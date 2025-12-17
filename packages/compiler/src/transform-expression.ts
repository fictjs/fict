import type * as BabelCore from '@babel/core'
import { RUNTIME_ALIASES } from './constants'
import type { TransformContext } from './types'
import {
  createGetterCall,
  isTrackedAndNotShadowed,
  collectBindingNames,
  toBinaryOperator,
} from './utils'

/**
 * Transform statements inside a block body (for arrow functions with block bodies)
 */
export function transformBlockStatement(
  block: BabelCore.types.BlockStatement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.BlockStatement {
  const newBody = block.body.map(stmt => transformStatement(stmt, ctx, t))
  return t.blockStatement(newBody)
}

/**
 * Transform a single statement, handling ExpressionStatements and other common patterns
 */
export function transformStatement(
  stmt: BabelCore.types.Statement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Statement {
  if (t.isExpressionStatement(stmt)) {
    return t.expressionStatement(transformExpression(stmt.expression, ctx, t))
  }

  if (t.isReturnStatement(stmt) && stmt.argument) {
    return t.returnStatement(transformExpression(stmt.argument, ctx, t))
  }

  if (t.isIfStatement(stmt)) {
    return t.ifStatement(
      transformExpression(stmt.test, ctx, t),
      t.isBlockStatement(stmt.consequent)
        ? transformBlockStatement(stmt.consequent, ctx, t)
        : transformStatement(stmt.consequent, ctx, t),
      stmt.alternate
        ? t.isBlockStatement(stmt.alternate)
          ? transformBlockStatement(stmt.alternate, ctx, t)
          : transformStatement(stmt.alternate, ctx, t)
        : null,
    )
  }

  if (t.isVariableDeclaration(stmt)) {
    return t.variableDeclaration(
      stmt.kind,
      stmt.declarations.map(decl => {
        if (decl.init) {
          return t.variableDeclarator(decl.id, transformExpression(decl.init, ctx, t))
        }
        return decl
      }),
    )
  }

  // For other statements, return as-is (could be extended as needed)
  return stmt
}

export function transformExpression(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  // Simple recursive transformation of identifiers to getter calls
  if (t.isIdentifier(expr)) {
    if (
      isTrackedAndNotShadowed(expr.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
      (ctx.getterOnlyVars.has(expr.name) && !ctx.shadowedVars.has(expr.name))
    ) {
      return createGetterCall(t, expr.name)
    }
    return expr
  }

  if (t.isSequenceExpression(expr)) {
    return t.sequenceExpression(expr.expressions.map(e => transformExpression(e, ctx, t)))
  }

  // Preserve parentheses when parser emits them (prevents traversal gaps for inserted nodes)
  if (t.isParenthesizedExpression(expr)) {
    return t.parenthesizedExpression(transformExpression(expr.expression, ctx, t))
  }

  if (t.isBinaryExpression(expr)) {
    const left = t.isPrivateName(expr.left) ? expr.left : transformExpression(expr.left, ctx, t)
    return t.binaryExpression(
      expr.operator,
      left as BabelCore.types.Expression,
      transformExpression(expr.right, ctx, t),
    )
  }

  if (t.isUnaryExpression(expr)) {
    return t.unaryExpression(expr.operator, transformExpression(expr.argument, ctx, t), expr.prefix)
  }

  if (t.isConditionalExpression(expr)) {
    return t.conditionalExpression(
      transformExpression(expr.test, ctx, t),
      transformExpression(expr.consequent, ctx, t),
      transformExpression(expr.alternate, ctx, t),
    )
  }

  if (t.isLogicalExpression(expr)) {
    return t.logicalExpression(
      expr.operator,
      transformExpression(expr.left, ctx, t),
      transformExpression(expr.right, ctx, t),
    )
  }

  if (t.isMemberExpression(expr)) {
    const transformedObject = transformExpression(expr.object as BabelCore.types.Expression, ctx, t)
    const transformedProperty =
      expr.computed && t.isExpression(expr.property)
        ? transformExpression(expr.property, ctx, t)
        : expr.property
    return t.memberExpression(transformedObject, transformedProperty, expr.computed)
  }

  if (t.isOptionalMemberExpression(expr)) {
    const transformedObject = transformExpression(expr.object as BabelCore.types.Expression, ctx, t)
    const transformedProperty =
      expr.computed && t.isExpression(expr.property)
        ? transformExpression(expr.property, ctx, t)
        : expr.property
    return t.optionalMemberExpression(
      transformedObject,
      transformedProperty,
      expr.computed,
      expr.optional,
    )
  }

  if (t.isCallExpression(expr)) {
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.callExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
    )
  }

  if (t.isOptionalCallExpression(expr)) {
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.optionalCallExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
      expr.optional,
    )
  }

  if (t.isNewExpression(expr)) {
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.newExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments?.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
    )
  }

  if (t.isArrayExpression(expr)) {
    return t.arrayExpression(
      expr.elements.map(el => {
        if (!el) return el
        if (t.isSpreadElement(el)) {
          return t.spreadElement(transformExpression(el.argument, ctx, t))
        }
        return t.isExpression(el) ? transformExpression(el, ctx, t) : el
      }),
    )
  }

  if (t.isObjectExpression(expr)) {
    return t.objectExpression(
      expr.properties.map(prop => {
        if (t.isSpreadElement(prop)) {
          return t.spreadElement(transformExpression(prop.argument, ctx, t))
        }

        if (t.isObjectProperty(prop) && t.isExpression(prop.value)) {
          const transformedKey =
            prop.computed && t.isExpression(prop.key)
              ? transformExpression(prop.key, ctx, t)
              : prop.key
          const transformedValue = transformExpression(prop.value, ctx, t)
          const shorthand =
            prop.shorthand && t.isIdentifier(transformedValue) ? prop.shorthand : false

          return t.objectProperty(transformedKey, transformedValue, prop.computed, shorthand)
        }
        return prop
      }),
    )
  }

  if (t.isTemplateLiteral(expr)) {
    return t.templateLiteral(
      expr.quasis,
      expr.expressions.map(e => (t.isExpression(e) ? transformExpression(e, ctx, t) : e)),
    )
  }

  if (t.isTSAsExpression(expr) && t.isExpression(expr.expression)) {
    return t.tsAsExpression(transformExpression(expr.expression, ctx, t), expr.typeAnnotation)
  }

  if (t.isTSTypeAssertion(expr) && t.isExpression(expr.expression)) {
    return t.tsTypeAssertion(expr.typeAnnotation, transformExpression(expr.expression, ctx, t))
  }

  if (t.isTSNonNullExpression(expr) && t.isExpression(expr.expression)) {
    return t.tsNonNullExpression(transformExpression(expr.expression, ctx, t))
  }

  if (t.isArrowFunctionExpression(expr)) {
    // Handle shadowing inside arrow functions
    const shadowedNames = new Set<string>()
    for (const param of expr.params) {
      collectBindingNames(param, shadowedNames, t)
    }

    const originalShadowed = new Set(ctx.shadowedVars)
    shadowedNames.forEach(n => ctx.shadowedVars.add(n))

    let newBody: BabelCore.types.BlockStatement | BabelCore.types.Expression
    if (t.isExpression(expr.body)) {
      newBody = transformExpression(expr.body, ctx, t)
      if (t.isConditionalExpression(newBody) || t.isLogicalExpression(newBody)) {
        newBody = t.parenthesizedExpression(newBody)
      }
    } else {
      // Block body - transform statements inside the block
      newBody = transformBlockStatement(expr.body, ctx, t)
    }

    ctx.shadowedVars = originalShadowed as Set<string>

    return t.arrowFunctionExpression(expr.params, newBody, expr.async)
  }

  // Handle UpdateExpression (count++, count--)
  if (t.isUpdateExpression(expr)) {
    if (t.isIdentifier(expr.argument)) {
      const name = expr.argument.name
      if (isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
        // Only state vars can be updated
        if (ctx.stateVars.has(name)) {
          // count++ -> count(count() + 1)
          // count-- -> count(count() - 1)
          const delta = expr.operator === '++' ? 1 : -1
          return t.callExpression(t.identifier(name), [
            t.binaryExpression(
              delta > 0 ? '+' : '-',
              createGetterCall(t, name),
              t.numericLiteral(1),
            ),
          ])
        }
      }
      return expr
    }

    // Still transform nested reads like arr[index]++ where index is tracked.
    return t.updateExpression(
      expr.operator,
      (t.isExpression(expr.argument)
        ? (transformExpression(expr.argument, ctx, t) as any)
        : expr.argument) as any,
      expr.prefix,
    )
  }

  // Handle AssignmentExpression (count = value, count += value)
  if (t.isAssignmentExpression(expr)) {
    if (t.isIdentifier(expr.left)) {
      const name = expr.left.name
      if (isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
        // Only state vars can be assigned
        if (ctx.stateVars.has(name)) {
          const operator = expr.operator
          const transformedRight = transformExpression(expr.right, ctx, t)

          if (operator === '=') {
            // count = 5 -> count(5)
            return t.callExpression(t.identifier(name), [transformedRight])
          } else {
            // count += 1 -> count(count() + 1)
            const binaryOp = toBinaryOperator(operator)
            if (binaryOp) {
              return t.callExpression(t.identifier(name), [
                t.binaryExpression(binaryOp, createGetterCall(t, name), transformedRight),
              ])
            }
          }
        }
      }
      // Not a state assignment target; keep LHS as-is.
      return t.assignmentExpression(
        expr.operator,
        expr.left,
        transformExpression(expr.right, ctx, t),
      )
    }

    const transformedRight = transformExpression(expr.right, ctx, t)
    const transformedLeft =
      !t.isIdentifier(expr.left) && t.isExpression(expr.left)
        ? (transformExpression(expr.left, ctx, t) as any)
        : expr.left

    return t.assignmentExpression(expr.operator, transformedLeft as any, transformedRight)
  }

  return expr
}
