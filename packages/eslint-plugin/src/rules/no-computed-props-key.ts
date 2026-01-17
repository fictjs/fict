import type { Rule } from 'eslint'

/**
 * ESLint rule to disallow computed keys in JSX props object spreads.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow computed keys in JSX props object spreads',
      recommended: true,
    },
    messages: {
      computedKey: 'Computed props key may break fine-grained reactivity; use explicit props.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXSpreadAttribute(node: any) {
        const expr = node.argument
        if (!expr || expr.type !== 'ObjectExpression') return
        for (const prop of expr.properties ?? []) {
          if (prop.type === 'Property' && prop.computed) {
            context.report({
              node: prop,
              messageId: 'computedKey',
            })
            return
          }
        }
      },
    }
  },
}

export default rule
