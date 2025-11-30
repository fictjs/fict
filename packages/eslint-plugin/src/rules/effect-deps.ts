import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Ensure $effect has tracked dependencies',
      recommended: true,
    },
    messages: {
      emptyEffect: '$effect should reference at least one reactive value.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === '$effect') {
          const firstArg = node.arguments[0]
          if (firstArg && firstArg.type === 'ArrowFunctionExpression') {
            if (
              firstArg.body.type !== 'BlockStatement' &&
              firstArg.body.type !== 'CallExpression'
            ) {
              return
            }
            if (firstArg.body.type === 'BlockStatement' && firstArg.body.body.length === 0) {
              context.report({ node, messageId: 'emptyEffect' })
            }
          }
        }
      },
    }
  },
}

export default rule
