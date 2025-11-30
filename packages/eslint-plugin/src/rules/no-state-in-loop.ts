import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow $state declarations inside loops',
      recommended: true,
    },
    messages: {
      noStateInLoop: '$state should not be declared inside a loop. Move it outside the loop.',
    },
    schema: [],
  },
  create(context) {
    let loopDepth = 0

    return {
      ForStatement() {
        loopDepth++
      },
      'ForStatement:exit'() {
        loopDepth--
      },
      ForInStatement() {
        loopDepth++
      },
      'ForInStatement:exit'() {
        loopDepth--
      },
      ForOfStatement() {
        loopDepth++
      },
      'ForOfStatement:exit'() {
        loopDepth--
      },
      WhileStatement() {
        loopDepth++
      },
      'WhileStatement:exit'() {
        loopDepth--
      },
      DoWhileStatement() {
        loopDepth++
      },
      'DoWhileStatement:exit'() {
        loopDepth--
      },

      CallExpression(node) {
        if (loopDepth > 0 && node.callee.type === 'Identifier' && node.callee.name === '$state') {
          context.report({
            node,
            messageId: 'noStateInLoop',
          })
        }
      },
    }
  },
}

export default rule
