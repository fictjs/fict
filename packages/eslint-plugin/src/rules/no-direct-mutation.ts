import type { Rule, Scope } from 'eslint'
import type { Identifier, MemberExpression, Node } from 'estree'

import { resolveVariable } from '../scope-utils'

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
    const stateVariables = new WeakSet<Scope.Variable>()

    const isStateMutation = (member: MemberExpression): boolean => {
      const root = getRootIdentifier(member)
      if (!root) return false
      const variable = resolveVariable(context, root)
      return !!variable && stateVariables.has(variable)
    }

    const reportMemberMutation = (node: Node, member: MemberExpression) => {
      if (isStateMutation(member)) {
        context.report({ node, messageId: 'noDirectMutation' })
      }
    }

    return {
      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === '$state' &&
          node.id.type === 'Identifier'
        ) {
          const variable = resolveVariable(context, node.id)
          if (variable) stateVariables.add(variable)
        }
      },

      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression') {
          reportMemberMutation(node, node.left)
        }
      },

      UpdateExpression(node) {
        if (node.argument.type === 'MemberExpression') {
          reportMemberMutation(node, node.argument)
        }
      },

      UnaryExpression(node) {
        if (node.operator !== 'delete') return
        const argument =
          node.argument.type === 'ChainExpression' ? node.argument.expression : node.argument
        if (argument.type === 'MemberExpression') {
          reportMemberMutation(node, argument)
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

export default rule
