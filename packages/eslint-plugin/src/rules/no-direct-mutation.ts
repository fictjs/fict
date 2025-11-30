import type { Rule } from 'eslint'
import type { Identifier, MemberExpression } from 'estree'

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Warn against direct mutation of $state objects',
      recommended: true,
    },
    messages: {
      noDirectMutation:
        'Direct mutation of nested $state properties may not trigger updates. Use spread syntax or $store for deep reactivity.',
    },
    schema: [],
  },
  create(context) {
    const stateVariables = new Set<string>()

    return {
      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === '$state' &&
          node.id.type === 'Identifier'
        ) {
          stateVariables.add(node.id.name)
        }
      },

      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression') {
          const root = getRootIdentifier(node.left)
          if (root && stateVariables.has(root.name)) {
            if (isDeepAccess(node.left)) {
              context.report({
                node,
                messageId: 'noDirectMutation',
              })
            }
          }
        }
      },
    }
  },
}

function getRootIdentifier(node: MemberExpression): Identifier | null {
  let current: MemberExpression | Identifier = node
  while (current.type === 'MemberExpression') {
    current = current.object as MemberExpression | Identifier
  }
  return current.type === 'Identifier' ? current : null
}

function isDeepAccess(node: MemberExpression): boolean {
  let depth = 0
  let current: MemberExpression | Identifier = node
  while (current.type === 'MemberExpression') {
    depth++
    current = (current as MemberExpression).object as MemberExpression | Identifier
  }
  return depth > 1
}

export default rule
