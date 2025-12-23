import type { Rule } from 'eslint'

/**
 * ESLint rule to detect inline functions passed to JSX props.
 *
 * This integrates with the compiler's validation module (FICT-X003).
 * Inline functions can cause unnecessary re-renders in reactive frameworks.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow inline function definitions in JSX props that may cause unnecessary re-renders',
      recommended: true,
    },
    messages: {
      // Message matches DiagnosticCode.FICT_X003
      inlineFunction:
        'Inline function in JSX props may cause unnecessary re-renders. Consider memoizing with $memo or moving outside the render.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowEventHandlers: {
            type: 'boolean',
            description: 'Allow inline functions for event handlers (onClick, onChange, etc.)',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {}
    const allowEventHandlers = options.allowEventHandlers ?? true

    const eventHandlerPattern = /^on[A-Z]/

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSX node type not available in base ESLint types
      JSXAttribute(node: any) {
        // Check if attribute value is an expression container with a function
        if (
          node.value &&
          node.value.type === 'JSXExpressionContainer' &&
          node.value.expression.type !== 'JSXEmptyExpression'
        ) {
          const expr = node.value.expression

          // Check for arrow functions and function expressions
          if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
            // Skip event handlers if allowed
            if (allowEventHandlers && node.name.type === 'JSXIdentifier') {
              const attrName = node.name.name
              if (eventHandlerPattern.test(attrName)) {
                return
              }
            }

            context.report({
              node: expr as any,
              messageId: 'inlineFunction',
            })
          }
        }
      },
    }
  },
}

export default rule
